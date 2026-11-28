'use strict';
/* LES TESTS ÉCRITS À LA FIN DE LA CHAÎNE DE VALIDATION (`chaine-verif.js`, étape 3).

   L'utilisateur dit quoi tester (le « scénario attendu », facultatif), les agents écrivent les tests là où ils
   vivent, et ce sont les vérificateurs de la chaîne, rejoués, qui donnent le verdict.

   1. La chaîne est verte sur la branche de la session. Chaque dépôt de tests SÉPARÉ (le réglage du
      vérificateur, sinon le réglage commun ; un dépôt de la session n'en est pas un) reçoit un worktree de
      Mergerie, sur une branche au nom de la session partie de sa branche par défaut. Une branche par session :
      deux tickets menés en parallèle écrivent chacun sur la sienne, et le clone de l'utilisateur n'est jamais
      touché.
   2. Deux passes, chacune dans SON dossier — ce qui marche avec tous les agents, aucun n'écrit hors du sien :
      la session qui a écrit le code est reprise pour les tests de ses propres dépôts ; puis une passe par dépôt
      de tests, lancée dans son worktree, avec le scénario attendu, le changement de la session et les skills
      du dépôt. Aucune ne lance de test.
   3. Dépôt de la session : commit et push par la mécanique du suivi (la MR existante se met à jour). Dépôt de
      tests : commit, push de la branche, merge request en BROUILLON — ouverte une fois, mise à jour ensuite.
   4. `chaine-verif.js` rejoue alors TOUS les vérificateurs de la chaîne, côté branche, avec leurs commandes
      inchangées. Leurs exécutions sur un même dépôt passent l'une après l'autre (`repo:<id>` dans la file),
      quel que soit le ticket qui les lance. Rouge : les deux passes corrigent (MAX_CORRECTIONS fois au plus,
      tout compris), puis « À toi ». Vert : les merge requests de tests passent de brouillon à prêtes.

   Un agent peut aussi ne rien écrire et citer des tests existants (bloc COUVERT) : chaque chemin est contrôlé
   sur disque. Ce contrôle prouve que le test cité existe, rien de plus — juger qu'il exerce le changement
   revient à l'utilisateur. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const db = require('../db');
const git = require('../git/git');
const skillscan = require('../agent/skillscan');
const protocol = require('../agent/protocol');
const protocolesecret = require('../core/protocolesecret');
const { nonFiable } = require('../core/nonfiable');
const { DATA_DIR } = require('../core/paths');
const { getConfig } = require('../data/config');
const forge = require('../forge');
const { TASKS_DIR } = require('../core/paths');
const testsTouches = require('../review/tests-touches');
const { t } = require('../core/i18n');
const { startTaskJob, jobEnCoursPour } = require('./ordonnanceur');

const MAX_CORRECTIONS = 2;
const MAX_ATTENDU = 4000;
const MAX_JSON = 2 * 1024 * 1024;
const lire = (j, defaut) => { try { return JSON.parse(j); } catch { return defaut; } };
const nonceScen = (taskId) => protocolesecret.hmac(`chaine-scen-${taskId}`, 12);
const slug = (s) => String(s || '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'depot';

/* ---------- La configuration ---------- */

/* `{ actif: true, attendu, attendu_source }` : le scénario attendu (4 000 caractères au plus, retours à la
   ligne gardés, null quand vide), `saisi` ou `jira`. L'ancien `{ verifier_id, skill }` se lit comme actif
   sans consigne — le vérificateur et le skill sont ignorés. */
function normaliserScenario(valeur) {
  if (valeur == null || valeur === '' || valeur === false) return null;
  let v = typeof valeur === 'string' ? lire(valeur, null) : valeur;
  if (v === true) v = { actif: true };
  if (!v || typeof v !== 'object' || v.actif === false) return null;
  const attendu = String(v.attendu == null ? '' : v.attendu).replace(/\r\n?/g, '\n').trim().slice(0, MAX_ATTENDU) || null;
  return JSON.stringify({ actif: true, attendu, attendu_source: attendu ? (v.attendu_source === 'jira' ? 'jira' : 'saisi') : null });
}
const lireScenario = (task) => lire(normaliserScenario(task && task.verify_chain_scenario), null);

/* ---------- Les dépôts ---------- */

const idsChaine = (task) => {
  const ids = lire(task && task.verify_chain, []);
  return Array.isArray(ids) ? [...new Set(ids.map(Number).filter(Boolean))] : [];
};
function depotParRef(ref) {
  const i = ref.indexOf('/');
  return i > 0 ? db.prepare("SELECT * FROM repo WHERE COALESCE(forge, 'gitlab') = ? AND project = ?").get(ref.slice(0, i), ref.slice(i + 1)) : null;
}
/* Les dépôts de tests SÉPARÉS : pour chaque vérificateur de la chaîne, sa surcharge, sinon le réglage commun ;
   dédoublonnés, sans ceux de la session (ils sont en zone Session). Aucun : cas normal, l'étape ne vise que
   les dépôts de la session. Rend `{ depots: [{ repo, verifiers }] }` ou `{ erreur }`. */
function depotsTestsDe(verifierIds, session) {
  const commun = String(getConfig().test_repo || '').trim();
  const parRepo = new Map();
  for (const vid of verifierIds) {
    const v = db.prepare('SELECT test_repo FROM verifier WHERE id = ?').get(vid);
    if (!v) continue;
    const ref = String(v.test_repo || commun || '').trim();
    if (!ref) continue;
    const repo = depotParRef(ref);
    if (!repo) return { erreur: t('task.chaine.scen.test-repo-unknown', { repo: ref }) };
    if (session.includes(repo.id)) continue;
    if (!parRepo.has(repo.id)) parRepo.set(repo.id, { repo, verifiers: [] });
    parRepo.get(repo.id).verifiers.push(vid);
  }
  return { depots: [...parRepo.values()] };
}
const depotsTests = (task) => depotsTestsDe(idsChaine(task), db.prepare('SELECT repo_id FROM task_target WHERE task_id = ?').all(task.id).map((x) => x.repo_id));
function dossierWorktrees(taskId) { return path.join(DATA_DIR, 'scenario-tests', `task-${Number(taskId)}`); }
/* Le worktree d'un dépôt de tests pour une session : dans le clone de Mergerie, gardé jusqu'à la suppression de
   la session — jamais le clone de l'utilisateur. */
const worktreeDe = (taskId, repo) => path.join(dossierWorktrees(taskId), slug(repo.project));
// Ce que la passe d'un dépôt de tests rend au constat (`taskrunner.passeDepotTests`), un fichier par passe.
const sortieDe = (taskId, repoId, at) => path.join(TASKS_DIR, String(Number(taskId)), 'tests-pass', `${String(at).replace(/[^\w-]/g, '')}-${Number(repoId)}.json`);

/* Ce que la fenêtre de session annonce sous la case : les dépôts de tests retenus, et si leur forge est
   configurée — sans elle, ni push ni merge request — avant même que la session existe. */
function apercuDepots(verifierIds, sessionRepoIds) {
  const { depots, erreur } = depotsTestsDe(verifierIds, sessionRepoIds);
  if (erreur) return { erreur, depots: [] };
  const cfg = getConfig();
  return { depots: depots.map((d) => ({ repo_id: d.repo.id, project: d.repo.project, forge: forge.forgeOf(d.repo), forge_ok: forge.isConfigured(cfg, d.repo) })) };
}

const brancheSession = (taskId) => (db.prepare('SELECT branch FROM task_target WHERE task_id = ? AND branch IS NOT NULL ORDER BY id LIMIT 1').get(taskId) || {}).branch;

/* Git dans le clone de Mergerie, hors de la file : préparer un worktree ne touche que le dossier de la session. */
// Par la porte durcie de `git/git.js` : ni hooks, ni fsmonitor.
function gitL(cwd, args) {
  return String(execFileSync('git', git.argsDurcis(args), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: git.envGit() })).trim();
}
const brancheCourante = (cwd) => gitL(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
const refExiste = (cwd, ref) => { try { gitL(cwd, ['rev-parse', '--verify', '--quiet', ref]); return true; } catch { return false; } };

/* ---------- Préparer ---------- */

/* Avant les passes : pour chaque dépôt de tests, sa forge configurée (le push et la merge request en
   dépendent), son clone de Mergerie à jour et le worktree de la session sur sa branche — créée depuis la
   branche par défaut, ou reprise si c'est cette session qui l'a créée. Une branche du même nom qui n'est pas
   la sienne (sur la forge ou dans le clone) : « À toi », rien n'est écrasé. Rend `{ depots }` ou `{ erreur }`. */
async function preparer(task, scen) {
  const { depots, erreur } = depotsTests(task);
  if (erreur) return { erreur };
  const cfg = getConfig();
  const branche = brancheSession(task.id);
  const connus = new Map((scen.depots || []).filter((d) => d.zone === 'tests').map((d) => [d.repo_id, d]));
  const out = [];
  try {
    for (const { repo } of depots) {
      const avant = connus.get(repo.id) || null;
      if (!forge.isConfigured(cfg, repo)) throw Object.assign(new Error(t('task.chaine.scen.forge-missing', { repo: repo.project, forge: forge.label(repo) })), { cause: 'forge' });
      // Hors de la file : une vérification peut être en train de rapatrier ce clone — un second essai suffit.
      const clone = await git.ensureRepo(cfg, repo, () => {}).catch(() => git.ensureRepo(cfg, repo, () => {}));
      const base = (avant && avant.base) || await git.defaultBranch(clone);
      const chemin = worktreeDe(task.id, repo);
      if (!fs.existsSync(chemin)) {
        const local = refExiste(clone, `refs/heads/${branche}`);
        const distante = refExiste(clone, `refs/remotes/origin/${branche}`);
        if ((local || distante) && !(avant && avant.cree)) throw Object.assign(new Error(t('task.chaine.scen.branch-foreign', { branch: branche, repo: repo.project })), { cause: 'branche' });
        fs.mkdirSync(path.dirname(chemin), { recursive: true });
        try { gitL(clone, ['worktree', 'prune']); } catch { /* rien à élaguer */ }
        if (local) gitL(clone, ['worktree', 'add', chemin, branche]);
        else gitL(clone, ['worktree', 'add', '-b', branche, chemin, distante ? `origin/${branche}` : `origin/${base}`]);
      }
      const depart = avant ? avant.sha_depart : gitL(chemin, ['rev-parse', 'HEAD']);
      out.push({ ...(avant || {}), zone: 'tests', repo_id: repo.id, project: repo.project, chemin, branche, base, sha_depart: depart, cree: true });
    }
  } catch (e) {
    return { erreur: String(e.message).split('\n')[0], cause: e.cause || 'preparer' };
  }
  return { depots: out };
}

/* La session supprimée : ses worktrees de tests (ceux de Mergerie). Les branches poussées et leurs merge
   requests restent sur la forge : elles appartiennent désormais à qui les relit. */
function nettoyerSession(taskId) {
  const racine = dossierWorktrees(taskId);
  if (!fs.existsSync(racine)) return;
  for (const nom of fs.readdirSync(racine)) {
    const dir = path.join(racine, nom);
    try {
      const commun = gitL(dir, ['rev-parse', '--git-common-dir']);
      gitL(path.resolve(dir, commun, '..'), ['worktree', 'remove', '--force', dir]);
    } catch { /* déjà détaché */ }
  }
  fs.rmSync(racine, { recursive: true, force: true });
}

/* Vert : chaque merge request de tests passe de brouillon à prête. Rend les dépôts mis à jour (`mr_pret`, ou
   `mr_erreur` — la forge a refusé, la MR reste en brouillon et la carte le dit). */
async function marquerPretes(scen) {
  const cfg = getConfig();
  const depots = [];
  for (const d of scen.depots || []) {
    if (d.zone !== 'tests' || !d.mr_iid || d.mr_pret) { depots.push(d); continue; }
    const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(d.repo_id);
    try {
      if (!repo) throw new Error(t('err.depot-introuvable'));
      await forge.clientFor(repo).markMergeRequestReady(cfg, repo.project, d.mr_iid);
      depots.push({ ...d, mr_pret: true, mr_erreur: null });
    } catch (e) { depots.push({ ...d, mr_erreur: String(e.message).split('\n')[0] }); }
  }
  return depots;
}

/* ---------- Les consignes ---------- */

/* Les dépôts où l'agent écrit, une ligne chacun — `- <projet> : <chemin> (<zone>)`. */
function lignesDepots(depots) {
  return depots.map((d) => `- ${d.project} : ${d.chemin} (${d.zone === 'tests' ? 'tests' : 'session'})`).join('\n');
}
function blocSkills(depots) {
  const skills = depots.flatMap((d) => skillscan.skillsDuDossier(d.chemin, d.project));
  if (!skills.length) return t('task.chaine.scen.no-skill');
  return `${t('task.chaine.scen.skills')}\n${skills.map((s) => `- ${s.name} (${s.project}) : ${s.description || '—'} — ${s.path}`).join('\n')}`;
}
/* Le scénario attendu : tel quel s'il a été saisi, sous `nonFiable` s'il vient du ticket. */
function blocAttendu(cfg) {
  if (!cfg || !cfg.attendu) return null;
  return cfg.attendu_source === 'jira'
    ? nonFiable(t('task.chaine.scen.expected-title'), cfg.attendu)
    : `## ${t('task.chaine.scen.expected-title')}\n\n${cfg.attendu}`;
}
function blocCouvert(nonce) {
  return [
    t('task.chaine.scen.covered-block'),
    '',
    `<<<COUVERT ${nonce}`,
    `par: ${t('task.chaine.scen.by-ph')}`,
    `raison: ${t('task.chaine.scen.why-ph')}`,
    `COUVERT ${nonce}>>>`,
  ].join('\n');
}
/* Les dépôts de l'étape : ceux de la session (leur copie de travail chez Mergerie) et les worktrees de tests. */
function depotsDeLaPasse(task, scen) {
  const cfg = getConfig();
  const session = db.prepare(`SELECT r.* FROM task_target tt JOIN repo r ON r.id = tt.repo_id
    WHERE tt.task_id = ? AND tt.commit_sha IS NOT NULL ORDER BY tt.id`).all(task.id)
    .map((r) => ({ zone: 'session', repo_id: r.id, project: r.project, chemin: git.cloneDirFor(cfg, r) }));
  return [...session, ...(scen.depots || []).filter((d) => d.zone === 'tests')];
}
/* Pour une correction : pour chaque vérificateur rouge, ses tests en échec et la fin de son journal — sous
   `nonFiable`. */
function blocsEchecs(rouges) {
  return rouges.map((r) => {
    const v = db.prepare('SELECT * FROM verification WHERE id = ?').get(r.verification_id) || {};
    const run = lire(v.head_run_json, {}) || {};
    const tests = (run.failed || []).slice(0, 20).map((f) => `- ${f.test || '?'}${f.message ? `\n  ${f.message}` : ''}`).join('\n');
    return [
      `### ${t('task.chaine.scen.fix-verifier', { name: r.nom })}`,
      tests ? nonFiable(t('task.chaine.diag.data-tests'), tests) : null,
      // Le journal, puis la sortie des commandes en échec (rangée dans le résultat du lancement) : la fin est gardée.
      nonFiable(t('task.chaine.diag.data-log'), [
        String(v.log_excerpt || ''),
        ...(run.commands || []).filter((c) => c.code !== 0 && c.output_tail).map((c) => `$ ${c.command}\n${c.output_tail}`),
      ].join('\n\n').slice(-6000)),
    ].filter(Boolean).join('\n');
  });
}
/* Le début et la fin communs aux deux passes : écrire ou corriger. `raison` : un JSON invalide, un « déjà
   couvert » refusé, à la place des rouges. */
function consigne(task, scen, { quoi, rouges = [], raison = null, intro, depots, regles }) {
  const corriger = quoi === 'corriger';
  const ecrits = (scen.depots || []).flatMap((d) => [...(d.ajoutes || []), ...(d.modifies || [])].map((f) => `- ${d.project}:${f}`));
  return [
    t(corriger ? 'task.chaine.scen.fix-subject' : 'task.chaine.scen.subject'),
    '',
    corriger ? t(raison ? 'task.chaine.scen.fix-intro-reason' : 'task.chaine.scen.fix-intro') : null,
    intro,
    blocAttendu(lireScenario(task)),
    corriger && ecrits.length ? `## ${t('task.chaine.scen.written-title')}\n\n${ecrits.join('\n')}` : null,
    corriger && raison ? nonFiable(t('task.chaine.scen.fix-reason'), raison) : null,
    ...(corriger ? blocsEchecs(rouges) : []),
    `## ${t('task.chaine.scen.repos-title')}\n\n${lignesDepots(depots)}`,
    blocSkills(depots),
    `## ${t('task.chaine.scen.rules-title')}\n\n${regles}${corriger ? `\n${t('task.chaine.scen.fix-rules')}` : ''}`,
    blocCouvert(nonceScen(task.id)),
  ].filter((x) => x != null).join('\n\n');
}
/* La passe de la session : ses dépôts seulement. Les dépôts de tests séparés ont chacun leur passe, après
   elle — elle le sait, pour ne pas y chercher sa place. */
function consigneSession(task, scen, opts = {}) {
  const tests = (scen.depots || []).filter((d) => d.zone === 'tests');
  const intro = [
    t('task.chaine.scen.intro'),
    tests.length ? t('task.chaine.scen.other-pass', { repos: tests.map((d) => d.project).join(', ') }) : null,
  ].filter(Boolean).join('\n\n');
  return consigne(task, scen, { ...opts, intro, depots: depotsDeLaPasse(task, scen).filter((d) => d.zone === 'session'), regles: t('task.chaine.scen.rules') });
}
/* La passe d'un dépôt de tests : son worktree seulement ; le changement de la session lui est ajouté par la
   passe elle-même, une fois celle de la session finie (`taskrunner.passeDepotTests`). */
function consigneTests(task, scen, d, opts = {}) {
  return consigne(task, scen, { ...opts, intro: t('task.chaine.scen.tests-intro', { repo: d.project, branch: d.branche }), depots: [d], regles: t('task.chaine.scen.rules-tests') });
}
const consigneEcrire = (task, scen) => consigneSession(task, scen, { quoi: 'ecrire' });

/* ---------- Les passes ---------- */

/* Un seul job : la passe de la session (suivi, sur ses cibles), puis celle de chaque dépôt de tests dans son
   worktree. On note d'où partent les dépôts de la session et les worktrees : le constat se fera par rapport à
   ces points. */
function lancerAgent(task, scen, { quoi, rouges = [], raison = null }) {
  const cibles = db.prepare('SELECT id, commit_sha FROM task_target WHERE task_id = ? AND commit_sha IS NOT NULL').all(task.id);
  const at = new Date().toISOString();
  const opts = { quoi, rouges, raison };
  const tests = (scen.depots || []).filter((d) => d.zone === 'tests');
  const sorties = Object.fromEntries(tests.map((d) => [d.repo_id, sortieDe(task.id, d.repo_id, at)]));
  // Le titre de la merge request de tests : un titre de rangement, jamais envoyé à l'agent.
  const titreMr = t('task.chaine.scen.mr-title', { id: task.id, quoi: String(task.label || task.prompt || '').split('\n')[0].slice(0, 80) });
  startTaskJob(task.id, 'followup', {
    instruction: consigneSession(task, scen, opts), targetIds: cibles.map((c) => c.id),
    passKind: 'scenario', message: t('task.chaine.scen.commit', { id: task.id }),
    testsPasses: tests.map((d) => ({
      repo_id: d.repo_id, project: d.project, chemin: d.chemin, branche: d.branche, base: d.base,
      mr_iid: d.mr_iid || null, mr_url: d.mr_url || null, mr_titre: titreMr, prompt: consigneTests(task, scen, d, opts), sortie: sorties[d.repo_id],
    })),
  });
  return {
    ...scen,
    corrections: (scen.corrections || 0) + (quoi === 'corriger' ? 1 : 0),
    en_cours: {
      quoi, at, sorties,
      avant: Object.fromEntries(cibles.map((c) => [c.id, c.commit_sha])),
      tests_avant: Object.fromEntries(tests.map((d) => [d.repo_id, (() => { try { return gitL(d.chemin, ['rev-parse', 'HEAD']); } catch { return null; } })()])),
    },
    reprise: null, erreur: null,
  };
}
const enRoute = (taskId) => !!jobEnCoursPour(taskId);

/* ---------- Constater ---------- */

/* `git diff --name-status a..b` : ajoutés, modifiés, supprimés (un renommage compte en supprimé + ajouté). */
function changements(cwd, a, b) {
  const out = { ajoutes: [], modifies: [], supprimes: [] };
  if (!a || !b || a === b) return out;
  for (const l of gitL(cwd, ['diff', '--name-status', '-M', `${a}..${b}`]).split('\n').filter(Boolean)) {
    const [statut, ...chemins] = l.split('\t');
    const s = statut[0];
    if (s === 'A' || s === 'C') out.ajoutes.push(chemins[chemins.length - 1]);
    else if (s === 'D') out.supprimes.push(chemins[0]);
    else if (s === 'R') { out.supprimes.push(chemins[0]); out.ajoutes.push(chemins[1]); } else out.modifies.push(chemins[0]);
  }
  return out;
}
/* Tests ou autres, par les motifs du dépôt (`review/tests-touches.js`). */
function classer(repoId, fichiers) {
  const motifs = testsTouches.motifsPour(getConfig(), repoId);
  const tests = new Set(testsTouches.classer(fichiers, motifs).testPaths);
  return { tests: fichiers.filter((f) => tests.has(f)), autres: fichiers.filter((f) => !tests.has(f)) };
}
/* Un `.json` ajouté ou modifié qui ne se lit pas : pas de rejeu, la session est reprise avec l'erreur. */
function jsonInvalides(cwd, sha, fichiers, project) {
  const out = [];
  for (const f of fichiers.filter((x) => /\.json$/i.test(x))) {
    try {
      const texte = String(execFileSync('git', ['show', `${sha}:${f}`], { cwd, encoding: 'utf8', maxBuffer: MAX_JSON }));
      JSON.parse(texte);
    } catch (e) { out.push(`${project}:${f} — ${String(e.message).split('\n')[0]}`); }
  }
  return out;
}
/* Le bloc COUVERT de l'étape : celui d'une passe de dépôt de tests, sinon de la dernière passe de la session
   qui en porte, depuis le lancement. */
function couvertRendu(taskId, depuis, textesTests = []) {
  const nonce = nonceScen(taskId);
  // Les passes des dépôts de tests d'abord : c'est là que vivent les tests d'un dépôt séparé.
  for (const texte of textesTests) {
    const bloc = protocol.extraire(texte, 'COUVERT', nonce).block;
    if (bloc) return bloc;
  }
  const passes = db.prepare(`SELECT output_path FROM agent_pass WHERE scope = 'task' AND task_id = ? AND created_at >= ?
    ORDER BY created_at DESC, id DESC`).all(taskId, depuis);
  for (const p of passes) {
    let texte = '';
    try { texte = p.output_path ? fs.readFileSync(p.output_path, 'utf8') : ''; } catch { texte = ''; }
    const bloc = protocol.extraire(texte, 'COUVERT', nonce).block;
    if (bloc) return bloc;
  }
  return null;
}
/* Un chemin cité : relatif, dans le dépôt, hors de `.git`. */
function cheminSur(brut) {
  const c = String(brut || '').trim().replace(/^\.\/+/, '');
  if (!c || c.length > 300 || path.isAbsolute(c) || /[\0\n]/.test(c)) return null;
  const n = path.posix.normalize(c);
  if (n.startsWith('..') || n.split('/').some((x) => x === '..' || x === '.git')) return null;
  return n;
}
/* « par: <dépôt>:<chemin> » (une ou plusieurs lignes), « raison: … » ; chaque chemin contrôlé — sûr, et
   présent dans la copie de travail du dépôt nommé. Rend `{ par, raison }` ou `{ refus }`. */
function controlerCouvert(bloc, depots) {
  const par = [...String(bloc).matchAll(/^\s*par\s*:\s*(.+)$/gmi)].map((m) => m[1].trim());
  const raison = ((String(bloc).match(/^\s*raison\s*:\s*(.+)$/mi) || [])[1] || '').trim().slice(0, 1000);
  if (!par.length) return { refus: t('task.chaine.scen.covered-empty') };
  const cites = [];
  for (const p of par.slice(0, 10)) {
    const i = p.indexOf(':');
    const nom = i > 0 ? p.slice(0, i).trim() : '';
    const chemin = cheminSur(i > 0 ? p.slice(i + 1) : p);
    const d = depots.find((x) => x.project === nom || x.project.split('/').pop() === nom);
    if (!chemin) return { refus: t('task.chaine.scen.covered-unsafe', { path: p }) };
    if (!d) return { refus: t('task.chaine.scen.covered-unknown-repo', { repo: nom || p }) };
    if (!fs.existsSync(path.join(d.chemin, chemin))) return { refus: t('task.chaine.scen.covered-missing', { repo: d.project, path: chemin }) };
    cites.push({ project: d.project, chemin });
  }
  return { par: cites, raison };
}

/* Ce que la passe a laissé. `fini` faux (session arrêtée, en erreur) : rien n'est constaté. Rend l'état
   suivant : `a_rejouer` (des fichiers ont changé), `final: 'couvert'`, `reprise` (à reprendre avec une
   raison), ou `erreur`. */
function conclure(task, scen, { fini = true } = {}) {
  const passe = scen.en_cours || { avant: {}, tests_avant: {} };
  const base = { ...scen, en_cours: null };
  if (!fini) return { ...base, erreur: t('task.chaine.scen.interrupted'), cause: 'interrompu' };
  const cfg = getConfig();
  const depots = (scen.depots || []).map((d) => ({ ...d }));
  let changeCettePasse = false;
  const invalides = [];
  const codeModifie = [...(scen.code_modifie || [])];
  // Zone Session : le suivi a commité et poussé ; on relève ses commits.
  // Pas de `r.*` ici : l'`id` du dépôt écraserait celui de la cible.
  const cibles = db.prepare(`SELECT tt.id, tt.repo_id, tt.commit_sha, tt.branch, tt.mr_iid, tt.mr_url, r.project FROM task_target tt JOIN repo r ON r.id = tt.repo_id
    WHERE tt.task_id = ? AND tt.commit_sha IS NOT NULL ORDER BY tt.id`).all(task.id);
  for (const c of cibles) {
    const cwd = git.cloneDirFor(cfg, db.prepare('SELECT * FROM repo WHERE id = ?').get(c.repo_id));
    let d = depots.find((x) => x.zone === 'session' && x.repo_id === c.repo_id);
    const avant = passe.avant[c.id] || (d && d.sha_final) || c.commit_sha;
    if (!d) {
      d = { zone: 'session', repo_id: c.repo_id, project: c.project, chemin: cwd, branche: c.branch, sha_depart: avant, sha_final: avant };
      depots.push(d);
    }
    d.mr_iid = c.mr_iid || null; d.mr_url = c.mr_url || null;
    if (c.commit_sha === avant) continue;
    let passeCh;
    try { passeCh = changements(cwd, avant, c.commit_sha); } catch { passeCh = { ajoutes: [], modifies: [], supprimes: [] }; }
    d.sha_final = c.commit_sha;
    const touches = [...passeCh.ajoutes, ...passeCh.modifies, ...passeCh.supprimes];
    if (!touches.length) continue;
    changeCettePasse = true;
    invalides.push(...jsonInvalides(cwd, c.commit_sha, [...passeCh.ajoutes, ...passeCh.modifies], c.project));
    // Du code (pas un test) touché à cette étape : dit sur la carte, jamais écrasé.
    const autres = classer(c.repo_id, touches).autres;
    if (autres.length) codeModifie.push({ repo_id: c.repo_id, project: c.project, sha: c.commit_sha, fichiers: autres });
    try { Object.assign(d, changements(cwd, d.sha_depart, d.sha_final)); } catch { /* le relevé cumulé est une aide */ }
    Object.assign(d, classer(d.repo_id, [...(d.ajoutes || []), ...(d.modifies || []), ...(d.supprimes || [])]));
  }
  // Zone Tests, après la session (ses commits sont relevés quoi qu'il arrive ici) : ce que la passe a rendu
  // (commit, push, merge request), relu dans son fichier.
  const textes = [];
  for (const d of depots.filter((x) => x.zone === 'tests')) {
    const r = lire((() => { try { return fs.readFileSync((passe.sorties || {})[d.repo_id], 'utf8'); } catch { return 'null'; } })(), null);
    if (!r) return { ...base, depots, code_modifie: codeModifie, erreur: t('task.chaine.scen.interrupted'), cause: 'interrompu' };
    if (r.texte) textes.push(r.texte);
    d.sortie = passe.sorties[d.repo_id];   // le retour de l'agent, relu par la vue de diff
    if (r.mr_iid) Object.assign(d, { mr_iid: r.mr_iid, mr_url: r.mr_url });
    if (r.erreur) return { ...base, depots, code_modifie: codeModifie, erreur: `${d.project} : ${r.erreur}`, cause: 'push' };
    let courante;
    try { courante = brancheCourante(d.chemin); } catch (e) { return { ...base, depots, code_modifie: codeModifie, erreur: String(e.message).split('\n')[0], cause: 'clone' }; }
    if (courante !== d.branche) return { ...base, depots, code_modifie: codeModifie, erreur: t('task.chaine.scen.branch-moved', { path: d.chemin, branch: d.branche, current: courante }), cause: 'branche' };
    const avant = passe.tests_avant[d.repo_id] || d.sha_final || d.sha_depart;
    d.sha_final = r.sha || gitL(d.chemin, ['rev-parse', 'HEAD']);
    const passeCh = changements(d.chemin, avant, d.sha_final);
    /* Un commit qui arrive sur la forge à cette passe compte comme un changement, même écrit avant : c'est
       la reprise d'un push refusé — la branche n'a encore jamais été rejouée sous ce commit. */
    const nouveauSurForge = r.pousse && d.sha_final !== d.sha_pousse;
    if (r.pousse) Object.assign(d, { pousse: true, sha_pousse: d.sha_final });
    if (passeCh.ajoutes.length || passeCh.modifies.length || passeCh.supprimes.length || nouveauSurForge) changeCettePasse = true;
    invalides.push(...jsonInvalides(d.chemin, d.sha_final, [...passeCh.ajoutes, ...passeCh.modifies], d.project));
    Object.assign(d, changements(d.chemin, d.sha_depart, d.sha_final));
    Object.assign(d, classer(d.repo_id, [...d.ajoutes, ...d.modifies, ...d.supprimes]));
  }
  const suite = { ...base, depots, code_modifie: codeModifie };
  if (invalides.length) return { ...suite, ecrit: true, reprise: { raison: t('task.chaine.scen.json-invalid', { files: invalides.join('\n') }) } };
  // Des fichiers ont changé : les changements l'emportent sur un bloc COUVERT, on rejoue.
  if (changeCettePasse) return { ...suite, ecrit: true, couvert: null, a_rejouer: true };
  const bloc = couvertRendu(task.id, passe.at || '', textes);
  if (bloc) {
    const c = controlerCouvert(bloc, depotsDeLaPasse(task, suite));
    if (c.refus) return { ...suite, ecrit: true, reprise: { raison: c.refus, couvert: true } };
    return { ...suite, ecrit: true, couvert: { par: c.par, raison: c.raison }, final: suite.a_rejouer ? null : 'couvert' };
  }
  // Une correction qui ne change rien rejouerait le même rouge : comme rien du tout.
  return { ...suite, ecrit: true, erreur: t('task.chaine.scen.none'), cause: 'rien' };
}

module.exports = {
  MAX_CORRECTIONS, MAX_ATTENDU, normaliserScenario, lireScenario, depotsTests, apercuDepots, preparer, nettoyerSession, marquerPretes,
  lancerAgent, enRoute, conclure, nonceScen, cheminSur, controlerCouvert, consigneEcrire, consigneSession, consigneTests,
};
