'use strict';
/* Vérification objective — exécution (plan_add_verify.md §4, §5, §7).
 *
 * Ce module fait le git et lance le script. La logique qui DÉCIDE (validation du contrat,
 * composition du verdict) vit dans verify.js, sans dépendance : c'est elle qu'on prouve.
 *
 * Deux règles structurent tout ce fichier :
 *
 *   — Mergerie fait tout le git. Le script de l'utilisateur reçoit des répertoires prêts et
 *     répond « les tests passent-ils ». Il ne fait aucun checkout, ne connaît aucune branche.
 *   — Ce qu'on a trouvé est toujours restauré. Les worktrees créés sont supprimés dans un
 *     `finally`, y compris sur timeout ou sur crash du job.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const git = require('./git');
const forge = require('./forge');
const proc = require('./proc');
const verify = require('./verify');
const demoVerify = require('./demo-verify');
const { DATA_DIR, ensureDir } = require('./paths');
const { stripAnsi } = require('../public/ansi-runtime.js');

const WORKTREES_DIR = path.join(DATA_DIR, 'worktrees');
const GRACE_KILL_MS = 10_000;   // délai entre SIGTERM et SIGKILL

/* ---------------------------------------------------------------- appel du script */

/* Environnement MINIMAL : le script exécute du code du dépôt, on ne lui confie donc aucun
   jeton ni aucune variable de Mergerie. `MERGERIE_VERIFY=1` lui permet de savoir d'où il est
   appelé — c'est la seule chose qu'on lui apprend. */
function envMinimal() {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '',
    LANG: process.env.LANG || 'C.UTF-8',
    MERGERIE_VERIFY: '1',
  };
}

/* Lance le vérificateur pour un rôle ('base' | 'head') et rend { run } ou { erreur }.
 * `repos` : [{ name, dir, sha, branch, mode }] — les dépôts CIBLES uniquement.
 *
 * `spawn` sans shell : la commande vient de la configuration, pas d'une chaîne à interpréter.
 * Un shell ici transformerait un nom de répertoire biscornu en exécution arbitraire.
 */
function appelerScript(verifier, role, repos, onLog = () => {}) {
  return new Promise((resolve) => {
    const entree = JSON.stringify({ version: 1, verifier: verifier.name, role, repos });
    let child;
    try {
      child = spawn(verifier.command, [], {
        cwd: repos[0] ? repos[0].dir : DATA_DIR,
        env: envMinimal(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ erreur: `impossible de lancer ${verifier.command} : ${e.message}` });
    }
    proc.setActive(child);   // le bouton Stop doit pouvoir l'interrompre comme le reste

    let stdout = '';
    let stderr = '';
    let fini = false;
    let tueur = null;

    /* `tueur` n'est PAS désarmé ici : au timeout, `terminer` résout la promesse avant que le
       processus ne soit mort — annuler l'escalade à ce moment laisserait un script qui ignore
       SIGTERM tourner indéfiniment. Il est désarmé à `close`, quand le processus a fini. */
    const terminer = (r) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuteur);
      proc.clearActive(child);
      resolve(r);
    };

    /* Timeout : SIGTERM d'abord — un script de test a souvent des enfants à ramasser et un
       rapport à écrire — puis SIGKILL s'il s'accroche. Sans le second, un script bloqué
       retiendrait la file pour toujours. */
    const minuteur = setTimeout(() => {
      onLog(`délai dépassé (${verifier.timeout_s} s) : arrêt du vérificateur`);
      try { child.kill('SIGTERM'); } catch { /* déjà mort */ }
      tueur = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* déjà mort */ } }, GRACE_KILL_MS);
      terminer({ erreur: `délai dépassé (${verifier.timeout_s} s)`, stderr });
    }, Math.max(1, verifier.timeout_s) * 1000);

    // Au-delà de MAX_REPONSE la réponse est déjà invalide : inutile d'accumuler des Mo en mémoire.
    child.stdout.on('data', (c) => { if (stdout.length <= verify.MAX_REPONSE) stdout += c; });
    child.stderr.on('data', (c) => {
      const t = String(c);
      stderr += t;
      if (stderr.length > verify.MAX_LOG) stderr = stderr.slice(-verify.MAX_LOG);
      for (const l of t.split('\n')) if (l.trim()) onLog(l.trim());
    });
    child.on('error', (e) => terminer({ erreur: `échec du lancement : ${e.message}`, stderr }));
    child.on('close', (code) => {
      if (tueur) clearTimeout(tueur);   // le processus est vraiment mort : l'escalade n'a plus d'objet
      // Le code de sortie est INDICATIF : c'est stdout qui fait foi (§4). Un script qui sort
      // en 1 parce que des tests échouent a parfaitement rendu son verdict.
      const r = verify.validerReponse(stdout);
      if (!r.ok) return terminer({ erreur: `${r.erreur} (code de sortie ${code})`, stderr });
      terminer({ run: r.run, stderr });
    });

    child.stdin.on('error', () => { /* script qui ne lit pas stdin : ce n'est pas une erreur */ });
    child.stdin.end(entree);
  });
}

/* ---------------------------------------------------------------- vérificateur « commandes »

   L'autre famille : une liste de commandes lancées dans le dépôt préparé, et le verdict vient
   de leurs CODES DE SORTIE. Aucun contrat à respecter côté utilisateur — mais aussi aucun nom
   de test garanti, d'où l'effort de `verify.js` pour en retrouver quand la sortie en contient. */

/* Environnement d'un run. Minimal par principe (§4) ; les variables déclarées sur le
   vérificateur s'y ajoutent. Sans cette porte, un `npm` installé par nvm reste introuvable
   dès que Mergerie tourne comme service et non depuis un terminal — et l'échec dirait
   « commande introuvable » sans rien laisser faire. */
function envVerifier(verifier) {
  const base = envMinimal();
  let sup = {};
  try { sup = JSON.parse(verifier.env_json || '{}') || {}; } catch { sup = {}; }
  for (const [k, v] of Object.entries(sup)) if (k) base[String(k)] = String(v == null ? '' : v);
  return base;
}

// Une commande, sans shell, avec un délai RESTANT (le budget est global au vérificateur).
function lancerUne(programme, args, { cwd, env, resteMs, onLog }) {
  return new Promise((resolve) => {
    const debut = Date.now();
    let child;
    try { child = spawn(programme, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ erreurLancement: e.message }); }
    proc.setActive(child);

    let sortie = '';
    let fini = false;
    let tueur = null;
    const ajouter = (c) => {
      sortie += stripAnsi(String(c));
      if (sortie.length > verify.MAX_LOG) sortie = sortie.slice(-verify.MAX_LOG);
    };
    /* Comme dans `appelerScript` : `tueur` survit à `terminer` (qui résout au timeout, avant
       la mort réelle du processus) et n'est désarmé qu'à `close`. */
    const terminer = (r) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuteur);
      proc.clearActive(child);
      resolve({ ...r, output: sortie, duration_ms: Date.now() - debut });
    };
    const minuteur = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* déjà mort */ }
      tueur = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* déjà mort */ } }, GRACE_KILL_MS);
      terminer({ code: null, timedOut: true });
    }, Math.max(1, resteMs));

    child.stdout.on('data', ajouter);
    child.stderr.on('data', (c) => {
      ajouter(c);
      // La sortie défile dans le panneau de log : on suit un `npm test` en direct.
      for (const l of stripAnsi(String(c)).split('\n')) if (l.trim()) onLog(l.trim());
    });
    child.on('error', (e) => terminer({ erreurLancement: e.message }));
    child.on('close', (code) => {
      if (tueur) clearTimeout(tueur);
      terminer({ code: code == null ? 1 : code });
    });
  });
}

/* Retrouver le NOM des tests cassés, sans jamais deviner. Dans l'ordre : le fichier de
   rapport JUnit s'il est déclaré (le plus fiable, insensible à la troncature), puis le TAP
   dans la sortie (gratuit, aucun réglage). Rien des deux → on rend `null` et l'appelant le
   dit au lieu d'inventer.

   `prefixe` : le nom du dépôt, quand plusieurs sont testés. Sans lui, deux dépôts qui ont
   chacun un test `panier › total` produiraient deux entrées indiscernables — et le delta
   base/tête les confondrait. */
function detailDesTests(verifier, dir, resultats, onLog, prefixe = null) {
  const nommer = (d) => (!d || !prefixe ? d : { ...d, tests: (d.tests || []).map((x) => ({ ...x, test: `${prefixe} › ${x.test}` })) });
  const ou = prefixe ? `${prefixe} : ` : '';

  if (verifier.report_path) {
    const rel = String(verifier.report_path).trim();
    const abs = path.resolve(dir, rel);
    // Le chemin est fourni par l'utilisateur mais résolu DANS le dépôt : pas d'évasion.
    if (!abs.startsWith(path.resolve(dir) + path.sep)) {
      onLog(`${ou}rapport ignoré : ${rel} sort du dépôt testé`);
    } else if (!fs.existsSync(abs)) {
      onLog(`${ou}rapport ${rel} absent — les commandes ne l'ont pas produit`);
    } else {
      const j = verify.parserJUnit(fs.readFileSync(abs, 'utf8'));
      if (j) {
        onLog(`${ou}rapport ${rel} lu : ${j.total} test(s), ${j.tests.length} en échec`);
        return nommer({ ...j, source: 'junit', complet: true });
      }
      onLog(`${ou}rapport ${rel} illisible (JUnit attendu) — on continue sans`);
    }
  }
  if (!verifier.parse_tap) return null;
  const t = verify.parserTap(resultats.map((r) => r.output).join('\n'));
  if (!t) return null;
  if (t.complet === false) onLog(`${ou}TAP partiel : ${t.racines} entrées lues sur ${t.plan} annoncées (sortie tronquée)`);
  else onLog(`${ou}TAP reconnu : ${t.total} test(s), ${t.tests.length} en échec`);
  return nommer({ ...t, source: 'tap' });
}

/* Joue la liste dans CHAQUE dépôt visé.
 *
 * Deux règles d'arrêt, et elles ne disent pas la même chose :
 *   — dans un dépôt, la première commande en échec arrête les suivantes : elles en dépendent
 *     (après un `npm ci` raté, la sortie de `npm test` n'est que du bruit) ;
 *   — d'un dépôt à l'autre, on CONTINUE : ils sont indépendants, et savoir que deux dépôts
 *     cassent plutôt qu'un seul vaut mieux que de s'arrêter au premier.
 * Le verdict est le ET : tout doit passer.
 */
async function lancerCommandes(verifier, commandes, repos, onLog = () => {}) {
  if (!repos.length) return { erreur: 'aucun dépôt préparé' };
  if (!commandes.length) return { erreur: 'aucune commande déclarée' };

  const env = envVerifier(verifier);
  const fin = Date.now() + Math.max(1, verifier.timeout_s) * 1000;   // budget GLOBAL
  const multi = repos.length > 1;
  const tous = [];
  const details = [];

  for (const r of repos) {
    if (multi) onLog(`— ${r.name}`);
    const duRepo = [];
    for (const brut of commandes) {
      const d = verify.decouperCommande(brut);
      if (!d.ok) return { erreur: `commande « ${brut} » : ${d.erreur}` };
      const reste = fin - Date.now();
      if (reste <= 0) return { erreur: `délai dépassé (${verifier.timeout_s} s)` };

      onLog(`$ ${brut}`);
      const res = await lancerUne(d.programme, d.args, { cwd: r.dir, env, resteMs: reste, onLog });
      if (res.erreurLancement) {
        return { erreur: `${d.programme} : ${res.erreurLancement} — vérifie le PATH du serveur, ou déclare les variables d'environnement du vérificateur` };
      }
      duRepo.push({ command: brut, repo: r.name, code: res.code, duration_ms: res.duration_ms, output: res.output });
      if (res.timedOut) return { erreur: `délai dépassé (${verifier.timeout_s} s) pendant « ${brut} »` };
      if (res.code !== 0) {
        onLog(`« ${brut} » sort en ${res.code} — les commandes suivantes ne sont pas lancées`);
        break;
      }
      onLog(`« ${brut} » : ok (${Math.round(res.duration_ms / 1000)} s)`);
    }
    details.push(detailDesTests(verifier, r.dir, duRepo, onLog, multi ? r.name : null));
    tous.push(...duRepo);
  }

  return { run: verify.composerRunCommandes(tous, verify.fusionnerDetails(details)) };
}

/* ---------------------------------------------------------------- worktrees */

/* Le nom est assaini des DEUX côtés : un projet contient des `/`, et une ref aussi
   (`origin/main`). Sans ça, `path.join` crée des sous-répertoires et le nettoyage passe à
   côté — un worktree oublié à chaque run. */
const assainir = (x) => String(x).replace(/[^\w.-]+/g, '_');
const cheminWorktree = (repo, sha) =>
  path.join(WORKTREES_DIR, `${assainir(repo.project)}-${assainir(String(sha).slice(0, 12))}`);

/* Un worktree détaché par SHA : aucune branche locale créée, rien à nettoyer côté refs, et
   deux runs sur des SHAs différents cohabitent sans se gêner. */
async function ajouterWorktree(cfg, repo, sha, onLog) {
  const clone = await git.ensureRepo(cfg, repo, onLog);
  /* Le GC au boot supprime les répertoires sans passer par git : le clone garde alors un
     worktree « enregistré mais absent » qui ferait échouer le prochain `worktree add` au
     même chemin. Le prune détache ces fantômes. */
  try { await git.run('git', ['worktree', 'prune'], { cwd: clone }); } catch { /* best effort */ }
  const dir = cheminWorktree(repo, sha);
  ensureDir(WORKTREES_DIR);
  if (fs.existsSync(dir)) await retirerWorktree(clone, dir, onLog);
  await git.run('git', ['worktree', 'add', '--detach', dir, sha], { cwd: clone, onLog });
  return dir;
}

async function retirerWorktree(clone, dir, onLog = () => {}) {
  // `--force` : un run peut laisser des fichiers derrière lui (build, node_modules).
  try { await git.run('git', ['worktree', 'remove', '--force', dir], { cwd: clone, onLog }); }
  catch { /* on insiste ci-dessous */ }
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); }
  catch { /* le ménage n'échoue jamais un run */ }
}

/* Worktrees restés d'un run interrompu (coupure de courant, kill -9 du serveur). On les
   ramasse au démarrage plutôt que de laisser le dataDir grossir en silence. */
function gcWorktrees(onLog = () => {}) {
  if (!fs.existsSync(WORKTREES_DIR)) return 0;
  let n = 0;
  for (const nom of fs.readdirSync(WORKTREES_DIR)) {
    try { fs.rmSync(path.join(WORKTREES_DIR, nom), { recursive: true, force: true }); n += 1; }
    catch { /* un répertoire récalcitrant ne doit pas empêcher le serveur de démarrer */ }
  }
  if (n) onLog(`${n} worktree(s) de vérification orphelin(s) supprimé(s)`);
  return n;
}

/* ---------------------------------------------------------------- mode in place (§6) */

/* `git.run` rend { stdout, stderr }. Attention au piège : une sortie VIDE est falsy, et un
   `|| r` de repli convertirait l'objet en « [object Object] » — `git status --porcelain` sans
   rien à dire deviendrait alors « dépôt modifié », et tout run in place serait refusé. */
const gitTexte = async (cwd, args) => {
  const r = await git.run('git', args, { cwd });
  return String(r && r.stdout != null ? r.stdout : '').trim();
};

/* Le répertoire est celui de l'utilisateur : on y touche seulement après avoir répondu OUI à
   trois questions, dans cet ordre. Chaque refus est explicite — un « non » silencieux ici
   serait pire qu'un run raté, parce qu'on parle de son travail en cours. */
async function inspecterWorkdir(repo, workdir) {
  if (!fs.existsSync(path.join(workdir, '.git'))) {
    return { ok: false, raison: `${workdir} n'est pas un dépôt git` };
  }
  let remote = '';
  try { remote = await gitTexte(workdir, ['remote', 'get-url', 'origin']); }
  catch { return { ok: false, raison: `aucun remote « origin » dans ${workdir}` }; }
  // Identité : sans ça, on ferait un checkout du mauvais projet dans le bon répertoire.
  if (!verify.memeDepot(remote, repo.url)) {
    return { ok: false, raison: `${workdir} pointe sur ${remote}, pas sur ${repo.url}`, remote };
  }
  /* Ce qui bloque n'est pas « le répertoire n'est pas propre », c'est « un checkout perdrait
     du travail ». Un fichier NON SUIVI n'est dans aucun commit : le checkout détaché ne le
     touche pas, et la restauration le laisse où il est. Refuser à cause de lui interdisait
     le mode in place à tout répertoire portant un `.env`, un `node_modules` non ignoré ou
     une note de travail — c'est-à-dire à presque tous.
     (Si un non-suivi porte le nom d'un fichier de la ref visée, git refuse le checkout de
     lui-même, avec sa propre explication : on n'écrase rien en douce.) */
  const lignes = (await gitTexte(workdir, ['status', '--porcelain'])).split('\n').filter(Boolean);
  const untracked = lignes.filter((l) => l.startsWith('??')).length;
  const dirty = lignes.length - untracked > 0;
  const branche = await gitTexte(workdir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const sha = await gitTexte(workdir, ['rev-parse', 'HEAD']);
  return { ok: true, remote, dirty, untracked, branche, sha };
}

/* Prépare un dépôt en place et rend de quoi le remettre comme on l'a trouvé.
   Jamais de `stash` automatique : déplacer le travail non commité de quelqu'un sans le lui
   dire est exactement le genre de service qu'on ne rend pas. On refuse, il décide. */
async function preparerInPlace(repo, ligne, sha, noter) {
  if (!ligne.checkout_allowed) throw new Error(`checkout non autorisé sur ${ligne.workdir}`);
  const etat = await inspecterWorkdir(repo, ligne.workdir);
  if (!etat.ok) throw new Error(etat.raison);
  if (etat.dirty) throw new Error(`${ligne.workdir} a des modifications non commitées — vérification refusée`);

  // La ref d'origine : une branche si on est dessus, sinon le SHA détaché.
  const refOrigine = etat.branche && etat.branche !== 'HEAD' ? etat.branche : etat.sha;
  noter(`in place ${ligne.workdir} : ${refOrigine} → ${String(sha).slice(0, 8)}`);
  /* Dit, et pas seulement toléré : ces fichiers restent en place pendant le run et peuvent
     donc peser sur le résultat (un `.env` local, une dépendance installée à la main). Le
     journal doit permettre de s'en souvenir en relisant un verdict surprenant. */
  if (etat.untracked) noter(`  ${etat.untracked} fichier(s) non suivi(s) laissés en place`);
  /* La branche vient d'être poussée depuis le clone du dataDir : le répertoire de
     l'utilisateur ne la connaît pas encore. */
  try { await git.run('git', ['fetch', 'origin', sha], { cwd: ligne.workdir }); }
  catch { await git.run('git', ['fetch', 'origin'], { cwd: ligne.workdir }); }
  // Checkout DÉTACHÉ par SHA : aucune branche locale créée dans le dépôt de l'utilisateur.
  await git.run('git', ['checkout', '--detach', sha], { cwd: ligne.workdir });
  return { workdir: ligne.workdir, refOrigine };
}

/* Branche par défaut TELLE QUE LE DÉPÔT LA DÉCLARE (`origin/HEAD`), pas une liste devinée de
   noms usuels : `main` chez les uns, `develop` chez les autres, `trunk` chez d'autres encore.
   Indéterminable → on ne signale rien plutôt que d'alerter à tort. */
async function brancheParDefaut(workdir) {
  try {
    const ref = await gitTexte(workdir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    return ref.replace(/^origin\//, '') || null;
  } catch { return null; }
}

/* CONTEXTE (§5.2) : les dépôts que ce vérificateur sait tester mais qui ne sont PAS dans le
   lot, et qu'il lira dans un répertoire de travail. On ne les touche pas — on constate.
   Sans ça, un verdict vert pourrait venir d'un dépôt voisin resté sur une vieille branche,
   et rien à l'écran ne le dirait. */
async function lireContexte(verifier, reposCibles) {
  const lignes = db.prepare("SELECT * FROM verifier_repo WHERE verifier_id = ? AND mode = 'in_place'")
    .all(verifier.id).filter((l) => !reposCibles.includes(l.repo_id));
  const contexte = [];
  for (const l of lignes) {
    const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(l.repo_id);
    if (!repo) continue;
    const etat = await inspecterWorkdir(repo, l.workdir || '');
    if (!etat.ok) { contexte.push({ repo_id: repo.id, project: repo.project, workdir: l.workdir, warn: true, raison: etat.raison }); continue; }
    const defaut = await brancheParDefaut(l.workdir);
    contexte.push({
      repo_id: repo.id, project: repo.project, workdir: l.workdir,
      branche: etat.branche, sha: etat.sha, dirty: etat.dirty, untracked: etat.untracked,
      /* Les non-suivis n'alertent pas : ils n'empêchent pas de savoir QUEL code a été lu,
         qui est la question à laquelle le contexte répond. Ils restent affichés. */
      warn: !!etat.dirty || (!!defaut && etat.branche !== defaut),
    });
  }
  return contexte;
}

async function restaurerInPlace(etat, noter) {
  try {
    await git.run('git', ['checkout', etat.refOrigine], { cwd: etat.workdir });
    noter(`in place ${etat.workdir} : remis sur ${etat.refOrigine}`);
    return null;
  } catch (e) {
    // On ne masque JAMAIS un échec de restauration : le répertoire de l'utilisateur est
    // resté sur un commit détaché, et lui seul peut décider quoi en faire.
    return `Restauration manuelle requise sur ${etat.workdir} (attendu : ${etat.refOrigine}) — ${e.message}`;
  }
}

/* ---------------------------------------------------------------- orchestration (§5) */

const nowIso = () => new Date().toISOString();

/* Exécute une vérification déjà enregistrée (statut `queued`). Tout se passe dans un
   `finally` global : quoi qu'il arrive — échec, timeout, annulation — les worktrees créés
   sont retirés. Un run qui laisse des répertoires derrière lui finit par remplir le disque
   sans que personne ne fasse le lien.
 *
 * Renvoie le verdict pour le journal ; les détails sont en base.
 */
async function executerVerification(verificationId, cfg, onLog = () => {}) {
  const v = db.prepare('SELECT * FROM verification WHERE id = ?').get(verificationId);
  if (!v) throw new Error('vérification introuvable');
  const verifier = db.prepare('SELECT * FROM verifier WHERE id = ?').get(v.verifier_id);
  if (!verifier) throw new Error('vérificateur introuvable');
  const cibles = JSON.parse(v.targets_json || '[]');
  const commandes = db.prepare('SELECT command FROM verifier_command WHERE verifier_id = ? ORDER BY position')
    .all(verifier.id).map((c) => c.command);
  db.prepare("UPDATE verification SET status = 'running', started_at = ? WHERE id = ?")
    .run(nowIso(), verificationId);

  const aNettoyer = [];   // [{ clone, dir }]
  const aRestaurer = [];  // [{ workdir, refOrigine }] — mode in place
  let logs = '';
  const noter = (l) => { logs = `${logs}${l}\n`.slice(-verify.MAX_LOG); onLog(l); };

  /* Mode démo : aucun dépôt cloné, aucun script — on rejoue un verdict au lieu de spawner
     quoi que ce soit. Le court-circuit est ICI, avant la moindre commande git, pour qu'aucun
     chemin réel ne puisse être emprunté par accident. */
  if (demoVerify.isDemo()) {
    const sim = demoVerify.verdictSimule(verifier);
    noter('mode démo : verdict simulé, aucun script lancé');
    noter(`verdict : ${sim.verdict}`);
    db.prepare(`UPDATE verification SET status = 'done', verdict = ?, base_run_json = ?,
      head_run_json = ?, imputable_json = ?, log_excerpt = ?, finished_at = ? WHERE id = ?`).run(
      sim.verdict, JSON.stringify(sim.base), JSON.stringify(sim.head),
      JSON.stringify(sim.imputable), logs, nowIso(), verificationId);
    return sim.verdict;
  }

  const finir = (champs) => {
    db.prepare(`UPDATE verification SET status = ?, verdict = ?, base_run_json = ?, head_run_json = ?,
      imputable_json = ?, log_excerpt = ?, finished_at = ? WHERE id = ?`).run(
      champs.status, champs.verdict || null,
      champs.base ? JSON.stringify(champs.base) : null,
      champs.head ? JSON.stringify(champs.head) : null,
      champs.imputable ? JSON.stringify(champs.imputable) : null,
      verify.tronquer(logs, verify.MAX_LOG), nowIso(), verificationId);
    return champs.verdict || 'verify_error';
  };

  try {
    // Un run par rôle : on prépare les répertoires, on appelle, on valide.
    /* Les cibles arrivent avec une base exprimée en REF (`origin/main`) : on la résout en
       SHA au premier usage et on la réécrit dans la vérification. Un verdict porte sur des
       commits, pas sur un nom de branche qui aura bougé demain — et le cache des runs n'a de
       sens que sur des SHAs. */
    const resoudre = async (repo, ref) => {
      if (/^[0-9a-f]{7,40}$/i.test(String(ref))) return String(ref);
      const clone = await git.ensureRepo(cfg, repo, noter);
      const out = await git.run('git', ['rev-parse', String(ref)], { cwd: clone });
      return String(out && out.stdout != null ? out.stdout : '').trim().split('\n')[0];
    };
    let ciblesResolues = null;

    const preparer = async (champ) => {
      const repos = [];
      if (!ciblesResolues) {
        ciblesResolues = [];
        for (const c of cibles) {
          const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(c.repo_id);
          if (!repo) throw new Error(`dépôt ${c.repo_id} introuvable`);
          ciblesResolues.push({ ...c, base_sha: await resoudre(repo, c.base_sha), head_sha: await resoudre(repo, c.head_sha) });
        }
        db.prepare('UPDATE verification SET targets_json = ? WHERE id = ?')
          .run(JSON.stringify(ciblesResolues), verificationId);
        const contexte = await lireContexte(verifier, ciblesResolues.map((c) => c.repo_id));
        if (contexte.length) {
          db.prepare('UPDATE verification SET context_json = ? WHERE id = ?')
            .run(JSON.stringify(contexte), verificationId);
          for (const c of contexte.filter((x) => x.warn)) {
            noter(`⚠ contexte ${c.project} : ${c.raison || `${c.branche}${c.dirty ? ', modifications non commitées' : ''}`}`);
          }
        }
      }
      for (const c of ciblesResolues) {
        const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(c.repo_id);
        if (c.mode === 'in_place') {
          const ligne = db.prepare('SELECT * FROM verifier_repo WHERE verifier_id = ? AND repo_id = ?')
            .get(verifier.id, c.repo_id);
          if (!ligne) throw new Error(`dépôt ${repo.project} non couvert par ce vérificateur`);
          // Une seule fois par répertoire : on retient l'état d'AVANT, pas celui du run précédent.
          if (!aRestaurer.some((r) => r.workdir === ligne.workdir)) {
            aRestaurer.push(await preparerInPlace(repo, ligne, c[champ], noter));
          } else {
            // Même précaution qu'au premier passage : ce SHA peut être inconnu du répertoire
            // (le fetch ciblé du base_sha n'a pas rapporté la tête).
            try { await git.run('git', ['fetch', 'origin', c[champ]], { cwd: ligne.workdir }); }
            catch { await git.run('git', ['fetch', 'origin'], { cwd: ligne.workdir }); }
            await git.run('git', ['checkout', '--detach', c[champ]], { cwd: ligne.workdir });
          }
          repos.push({ name: repo.project, dir: ligne.workdir, sha: c[champ], branch: c.branch, mode: 'in_place', changed: true });
          continue;
        }
        const clone = git.cloneDirFor(cfg, repo);
        const dir = await ajouterWorktree(cfg, repo, c[champ], noter);
        aNettoyer.push({ clone, dir });
        repos.push({ name: repo.project, dir, sha: c[champ], branch: c.branch, mode: 'worktree', changed: true });
      }
      return repos;
    };

    /* Le genre du vérificateur ne change QUE la façon d'obtenir un `run` : tout le reste —
       préparation, cache, composition du verdict, rapport, badges — est commun. */
    const lancer = (role, reposPrets) => (verifier.kind === 'commands'
      ? lancerCommandes(verifier, commandes, reposPrets, noter)
      : appelerScript(verifier, role, reposPrets, noter));

    /* Run BASE : il répond à « était-ce déjà rouge avant ? ». Sans lui, un test cassé par
       quelqu'un d'autre serait imputé à cette branche.

       Il est REFAIT à chaque vérification. Un cache par jeu de SHAs a existé — la base ne
       bouge pas pendant qu'on itère, et la refaire coûte des minutes. Mais il pariait sur
       une chose que Mergerie ne peut pas vérifier : que l'ENVIRONNEMENT n'a pas bougé non
       plus. Or il bouge — un service local qu'on redémarre, une migration qu'on applique,
       une dépendance qu'on réinstalle —, et le pari se paie des deux côtés :
         · un rouge de base gardé alors qu'on vient de le corriger hors git bloque la MR sur
           un « base déjà rouge » qui n'est plus vrai ;
         · un vert de base gardé alors que la base est devenue rouge fait imputer à la
           branche un échec qui ne vient pas d'elle — exactement ce que le run base existe
           pour éviter.
       Un run qui coûte deux fois plus longtemps vaut mieux qu'un verdict faux en silence. */
    let base = null;
    if (verifier.run_base) {
      const reposBase = await preparer('base_sha');
      noter('run base…');
      const r = await lancer('base', reposBase);
      if (r.erreur) { noter(`run base : ${r.erreur}`); return finir({ status: 'error', verdict: 'verify_error' }); }
      base = r.run;
    }

    noter('run head…');
    const rh = await lancer('head', await preparer('head_sha'));
    if (rh.erreur) { noter(`run head : ${rh.erreur}`); return finir({ status: 'error', verdict: 'verify_error', base }); }

    /* Sans nom de test, la comparaison des deux sorties est ce qui reste de plus parlant :
       les lignes présentes à la tête et absentes de la base pointent l'échec introduit. */
    if (base && rh.run && rh.run.detail_source === 'command') {
      const echouee = (rh.run.commands || []).find((c) => c.code !== 0);
      const meme = echouee && (base.commands || []).find((c) => c.command === echouee.command);
      if (echouee && meme) rh.run.new_lines = verify.nouvellesLignes(meme.output_tail, echouee.output_tail);
    }

    const { verdict, imputable, causal } = verify.composerVerdict(base, rh.run);
    noter(`verdict : ${verdict}${causal ? '' : ' (non causal — run base désactivé)'}`);
    return finir({ status: 'done', verdict, base, head: rh.run, imputable });
  } catch (e) {
    noter(`échec de la vérification : ${e.message}`);
    return finir({ status: 'error', verdict: 'verify_error' });
  } finally {
    for (const { clone, dir } of aNettoyer) await retirerWorktree(clone, dir, () => {});
    /* Restauration garantie : c'est la promesse du mode in place. Elle passe AVANT tout le
       reste dans l'ordre des priorités — un échec ici est signalé de façon persistante. */
    const echecs = [];
    for (const etat of aRestaurer) {
      const err = await restaurerInPlace(etat, noter);
      if (err) { echecs.push(err); noter(`⚠ ${err}`); }
    }
    if (echecs.length) {
      db.prepare('UPDATE verification SET restore_error = ? WHERE id = ?')
        .run(echecs.join(' · ').slice(0, 1000), verificationId);
    }
  }
}

/* ---------------------------------------------------------------- commentaire forge (§5.6) */

/* Le verdict publié sur la merge request, si — et seulement si — le vérificateur le demande.
   Décoché par défaut : écrire chez les autres est une décision, pas un réglage par défaut.
   Le corps porte les FAITS (quels tests, quels commits) ; sans eux, un « ✗ » sur une MR est
   une accusation sans dossier. */
async function commenterSurForge(verificationId, cfg, onLog) {
  const v = db.prepare('SELECT * FROM verification WHERE id = ?').get(verificationId);
  if (!v) return null;
  const verifier = db.prepare('SELECT * FROM verifier WHERE id = ?').get(v.verifier_id);
  if (!verifier || !verifier.comment_on_forge) return null;

  const lire = (j) => { try { return j ? JSON.parse(j) : null; } catch { return null; } };
  const cibles = lire(v.targets_json) || [];
  const imputable = lire(v.imputable_json) || [];
  const nom = verifier.name || v.verifier_name;
  const entete = {
    verified_pass: `**${nom}** : ✓ vérifié`,
    verified_fail: `**${nom}** : ✗ ${imputable.length} test(s) cassé(s) par cette branche`,
    broken_base: `**${nom}** : ⚠ la base était déjà rouge — rien n'est imputable à cette branche`,
  }[v.verdict] || `**${nom}** : ⚠ vérification en erreur`;

  const corps = [entete, ''];
  if (imputable.length) {
    corps.push('Tests cassés :');
    for (const f of imputable.slice(0, 20)) corps.push(`- \`${f.test}\`${f.message ? ` — ${f.message}` : ''}`);
    if (imputable.length > 20) corps.push(`- … et ${imputable.length - 20} de plus`);
    corps.push('');
  }
  corps.push('Commits testés :');
  for (const c of cibles) {
    const repo = db.prepare('SELECT project FROM repo WHERE id = ?').get(c.repo_id);
    corps.push(`- ${(repo && repo.project) || c.repo_id} · \`${c.branch || ''}\` @ \`${String(c.head_sha || '').slice(0, 8)}\``);
  }
  const body = corps.join('\n');

  const postees = [];
  for (const c of cibles) {
    if (!c.mr_id) continue;
    const mr = db.prepare(`SELECT mr.*, repo.project AS project, repo.forge AS forge
      FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id = ?`).get(c.mr_id);
    if (!mr) continue;
    await forge.clientFor(mr).postMrNote(cfg, mr.project, mr.iid, body);
    postees.push(`${mr.project}!${mr.iid}`);
  }
  if (postees.length && onLog) onLog(`verdict commenté sur ${postees.join(', ')}`);
  return postees;
}

module.exports = {
  WORKTREES_DIR, cheminWorktree, executerVerification, commenterSurForge,
  appelerScript, lancerCommandes, envVerifier, ajouterWorktree, retirerWorktree, gcWorktrees,
  inspecterWorkdir, preparerInPlace, restaurerInPlace, lireContexte,
  envMinimal,
};
