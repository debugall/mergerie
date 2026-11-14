'use strict';
/* LES RETOUCHES — ce qu'une merge request mergée AU VERT a vu réécrire dans les N jours suivants.
 *
 * La question : « combien de défauts passent malgré un rapport au vert ». La réponse est un FAIT DE
 * GIT, jamais un verdict de l'outil : « !230 a réécrit 23 lignes introduites par !214, trois jours
 * après son merge ». Trois signaux, du plus certain au moins certain, chacun vérifiable à la main
 * avec `git blame` et la page de la forge, sans aucun appel d'IA, sans aucun appel forge de plus :
 *   1. REVERT — un commit de B dit `This reverts commit <sha>` où <sha> est le merge ou le squash
 *      de A, ou la description de B dit `Reverts !214` (GitLab) / `Reverts #214` (GitHub).
 *   2. LIGNES RÉÉCRITES (le signal principal) — pour chaque hunk de B, les lignes RETIRÉES
 *      existaient dans la base de B ; `git blame -L` sur ces lignes donne le commit qui les a
 *      écrites ; si c'est le merge, le squash ou l'un des commits de A, B réécrit du code de A.
 *      On compte les lignes. Un ajout pur au milieu du code de A n'est PAS compté : on préfère un
 *      chiffre sous-estimé à un chiffre contestable.
 *   3. RÉFÉRENCE — B cite `!214` dans son titre, sa description ou sa branche ; ou le ticket de B
 *      est un Bug et c'est celui de A, ou lié à lui. Seul, ce n'est pas un correctif : il renforce.
 *
 * RETOUCHE N'EST PAS BUG. Les signaux établissent qu'une MR a RÉÉCRIT du code d'une autre, pas que
 * ce code était faux. Deux comptes, toujours côte à côte : la retouche QUALIFIÉE BUG quand un fait
 * le dit (revert, ticket Bug, commit `fix:`, confirmation humaine), la retouche non tranchée sinon.
 * L'arbitrage humain (`confirmed` / `dismissed`) l'emporte sur tout recalcul, et voyage dans le
 * dépôt de données partagé.
 *
 * Le chiffre est par dépôt et par tranche de note, JAMAIS par personne : rien de ce module ne
 * groupe ni ne trie par auteur (un test l'interdit). Zéro IA, zéro forge : le module ne connaît que
 * la base et `git` — un test le garde fermé à `agent/` et `forge/`. */
const db = require('../db');
const git = require('../git/git');
const { t } = require('../core/i18n');

const JOUR_MS = 24 * 3600 * 1000;
const FENETRE_DEFAUT = 30;
const MIN_LIGNES_DEFAUT = 3;
const PLAFOND_DEFAUT = 10;
const MARGE_JOURS = 7;                 // ce qu'on garde au-delà de la fenêtre : un tour de découverte en retard
const LARGE_LIGNES = 300;              // au-delà, sur plus de LARGE_ORIGINES MR : « réécriture large », hors chiffre
const LARGE_ORIGINES = 20;
const MAX_COMMITS_PAR_MR = 200;        // messages lus pour le revert et le `fix:`
const MAX_COMMITS_DIRECTS = 50;        // commits directs analysés par branche et par tour
const MAX_DIFF = 1024 * 1024 * 64;
const KINDS_COMPTES = ['revert', 'rewrites', 'manual'];

const actif = (cfg) => String((cfg && cfg.fix_links_enabled) ?? '1') !== '0';
const entier = (v, defaut, { min = 0, max = 100000 } = {}) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= min ? Math.min(max, n) : defaut; };
const fenetre = (cfg) => entier(cfg && cfg.fix_window_days, FENETRE_DEFAUT, { min: 1, max: 365 });
const minLignes = (cfg) => entier(cfg && cfg.fix_min_lines, MIN_LIGNES_DEFAUT, { min: 0, max: 100000 });
const plafond = (cfg) => entier(cfg && cfg.fix_links_max, PLAFOND_DEFAUT, { min: 0, max: 1000 });
/* Combien de jours les commits (`mr_commits`) d'une MR MERGÉE restent en base : la fenêtre plus une
   marge. 0 quand le suivi est décoché — la purge d'avant reprend. */
const retentionJours = (cfg) => (actif(cfg) ? fenetre(cfg) + MARGE_JOURS : 0);
const typesBug = (cfg) => String((cfg && cfg.jira_stats_bug_types) || 'Bug').split(/[,\n;]/).map((x) => x.trim().toLowerCase()).filter(Boolean);

const shaDeMerge = (mr) => mr.squash_commit_sha || mr.merge_commit_sha || mr.head_sha || null;
const jours = (a, b) => Math.round(((Date.parse(b) - Date.parse(a)) / JOUR_MS) * 10) / 10;
const lireJson = (s, defaut) => { try { const v = JSON.parse(s); return v == null ? defaut : v; } catch { return defaut; } };
const prefixeIid = (forge) => (forge === 'github' ? '#' : '!');

/* ---------- git ---------- */

async function existe(cwd, sha) {
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return false;
  return git.refExists(cwd, sha);
}

/* LA PLAGE À LIRE pour une MR mergée, indépendante de la stratégie de merge : le commit de squash
   ou de merge est sur la cible — `sha^1..sha` dit exactement ce que la MR a posé là, résolution de
   conflit comprise. Sans lui (merge en avance rapide), `base_sha..head_sha` ; en dernier recours,
   le parent de la tête. */
async function plageDe(cwd, mr) {
  const sha = shaDeMerge(mr);
  if (!(await existe(cwd, sha))) return null;
  const { stdout } = await git.run('git', ['rev-list', '--parents', '-n', '1', sha], { cwd });
  const parents = stdout.trim().split(/\s+/).slice(1);
  if (parents.length >= 2) return { from: parents[0], to: sha };
  if (mr.base_sha && mr.head_sha && mr.base_sha !== mr.head_sha && (await existe(cwd, mr.base_sha)) && (await existe(cwd, mr.head_sha))) return { from: mr.base_sha, to: mr.head_sha };
  if (!parents.length) return null;
  return { from: parents[0], to: sha };
}

/* Les hunks de `from..to` : par fichier (chemin AVANT renommage, `-M`), les plages de lignes
   RETIRÉES dans `from`. `-U0` : aucune ligne de contexte, les bornes du hunk sont exactement les
   lignes touchées. Un fichier binaire n'a pas de hunk. */
async function hunksRetires(cwd, from, to) {
  const { stdout } = await git.run('git', ['diff', '--no-color', '--no-ext-diff', '-U0', '-M', from, to], { cwd, maxBuffer: MAX_DIFF });
  const out = [];
  let courant = null;
  for (const l of stdout.split('\n')) {
    if (l.startsWith('--- ')) {
      const p = l.slice(4).replace(/\t.*$/, '');
      courant = p === '/dev/null' ? null : { path: p.replace(/^"?a\//, '').replace(/"$/, ''), ranges: [] };
      if (courant) out.push(courant);
      continue;
    }
    if (!courant || !l.startsWith('@@ ')) continue;
    const m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(l);
    if (!m) continue;
    const count = m[2] == null ? 1 : Number(m[2]);
    if (count > 0) courant.ranges.push([Number(m[1]), count]);
  }
  return out.filter((f) => f.ranges.length);
}

/* `git blame --line-porcelain` sur les plages d'UN fichier dans `sha` : chaque ligne retirée →
   le commit qui l'a écrite. `-l` donne des SHA longs ; `-M` suit les lignes déplacées dans le
   fichier, pas `-C` (un copier-coller depuis ailleurs n'est pas une réécriture). Rend
   `[{ line, sha }]`. */
async function blameLignes(cwd, sha, chemin, ranges) {
  const args = ['blame', '-l', '-M', '--line-porcelain'];
  for (const [debut, n] of ranges) args.push('-L', `${debut},+${n}`);
  args.push(sha, '--', chemin);
  const { stdout } = await git.run('git', args, { cwd, maxBuffer: MAX_DIFF });
  const out = [];
  for (const l of stdout.split('\n')) {
    const m = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(l);
    if (m) out.push({ line: Number(m[3]), sha: m[1] });
  }
  return out;
}

/* Les messages des commits d'une plage, du plus récent au plus ancien, plafonnés. */
async function messagesDe(cwd, from, to) {
  const { stdout } = await git.run('git', ['log', `--max-count=${MAX_COMMITS_PAR_MR}`, '--format=%H%x1f%B%x1e', `${from}..${to}`], { cwd, maxBuffer: MAX_DIFF });
  return stdout.split('\x1e').map((b) => b.trim()).filter(Boolean).map((b) => {
    const [sha, corps] = b.split('\x1f');
    return { sha, message: corps || '' };
  });
}

/* Les commits qu'une MR mergée a apportés : ses `mr_commits` s'ils sont encore là, et, quand le
   merge a gardé l'historique (deux parents), `merge^1..merge` lu dans le clone — c'est ce que
   `blame` rend sur une ligne de A mergée sans squash. */
async function commitsDe(cwd, mr) {
  const shas = new Set(db.prepare('SELECT sha FROM mr_commits WHERE mr_id = ?').all(mr.id).map((r) => r.sha));
  for (const s of [mr.merge_commit_sha, mr.squash_commit_sha, mr.head_sha]) if (s) shas.add(s);
  if (mr.merge_commit_sha && cwd && (await existe(cwd, mr.merge_commit_sha))) {
    try {
      const { stdout } = await git.run('git', ['rev-list', '--parents', '-n', '1', mr.merge_commit_sha], { cwd });
      if (stdout.trim().split(/\s+/).length > 2) for (const s of await git.revList(cwd, `${mr.merge_commit_sha}^1..${mr.merge_commit_sha}`, { max: 500 })) shas.add(s);
    } catch { /* le clone ne porte pas ce merge : les mr_commits suffisent */ }
  }
  return shas;
}

/* ---------- les candidats ---------- */

/* Les merge requests A que B a pu retoucher : même dépôt, même branche cible, mergées dans les N
   jours AVANT B. Avec ou sans rapport — Stats compare justement les deux, et le coût est le même. */
function candidats(repoId, cible, mergedAt, n, { saufId = null } = {}) {
  const depuis = new Date(Date.parse(mergedAt) - n * JOUR_MS).toISOString();
  return db.prepare(`SELECT mr.*, rv.note_value FROM mr LEFT JOIN review rv ON rv.mr_id = mr.id
    WHERE mr.repo_id = ? AND mr.target_branch IS ? AND mr.merged_at IS NOT NULL
      AND mr.merged_at >= ? AND mr.merged_at <= ? AND mr.id IS NOT ?
    ORDER BY mr.merged_at DESC`).all(repoId, cible, depuis, mergedAt, saufId);
}

/* ---------- l'analyse d'un changement ---------- */

/* Ce que `from..to` réécrit chez chaque candidat : par A, les lignes, les fichiers et les plages
   (`src/tva.js : 41–52, 88`), de quoi vérifier à la main. Un `blame` par fichier retiré. */
async function lignesReecrites(cwd, from, to, parSha) {
  const parA = new Map();     // id A → { lines, files: Map(path → [[a,b]...]) }
  for (const f of await hunksRetires(cwd, from, to)) {
    let attribs;
    try { attribs = await blameLignes(cwd, from, f.path, f.ranges); } catch { continue; }   // fichier absent dans `from` (renommage exotique) : on passe
    for (const { line, sha } of attribs) {
      const a = parSha.get(sha);
      if (a == null) continue;
      const e = parA.get(a) || { lines: 0, files: new Map() };
      e.lines += 1;
      const plages = e.files.get(f.path) || [];
      const der = plages[plages.length - 1];
      if (der && der[1] === line - 1) der[1] = line; else plages.push([line, line]);
      e.files.set(f.path, plages);
      parA.set(a, e);
    }
  }
  return parA;
}

const plagesEnJson = (files) => Object.fromEntries([...files.entries()].map(([p, r]) => [p, r]));

/* ---------- B : une merge request mergée ---------- */

async function analyserMr(cfg, repo, b, { cwd, now = new Date().toISOString() } = {}) {
  const n = fenetre(cfg);
  const sha = shaDeMerge(b);
  const bilan = { id: b.id, candidats: 0, liens: 0, note: null };
  const noter = (note) => { bilan.note = note; poserScan('mr', String(b.id), sha, now, note); return bilan; };
  const cands = candidats(repo.id, b.target_branch, b.merged_at, n, { saufId: b.id });
  bilan.candidats = cands.length;
  if (!cands.length) return noter('no-candidate');
  const plage = await plageDe(cwd, b);
  if (!plage) return noter('sha-absent');

  // Les commits de chaque A, pour relire `blame` : un SHA → un candidat.
  const parSha = new Map();
  const shasDeA = new Map();
  for (const a of cands) {
    const shas = await commitsDe(cwd, a);
    shasDeA.set(a.id, shas);
    for (const s of shas) if (!parSha.has(s)) parSha.set(s, a.id);
  }
  const messages = await messagesDe(cwd, plage.from, plage.to);
  const texteB = `${b.title || ''}\n${b.description || ''}`;
  const commitFix = messages.some((m) => /^\s*(fix|hotfix)(\(|:|!)/i.test(m.message) || /^\s*hotfix\b/i.test(m.message));
  const bugTypes = typesBug(cfg);
  const ticketBug = !!(b.ticket_jira_type && bugTypes.includes(String(b.ticket_jira_type).toLowerCase()));
  const liensB = new Set(lireJson(b.ticket_jira_links, []).map((k) => String(k).toUpperCase()));

  const reecrit = await lignesReecrites(cwd, plage.from, plage.to, parSha);
  const totalLignes = [...reecrit.values()].reduce((s, e) => s + e.lines, 0);
  const large = totalLignes > LARGE_LIGNES && reecrit.size > LARGE_ORIGINES;
  const minimum = minLignes(cfg);
  const liens = [];
  for (const a of cands) {
    const shas = shasDeA.get(a.id);
    const delai = jours(a.merged_at, b.merged_at);
    const qualif = [];
    const signaux = [];
    // 1. Revert
    let revert = null;
    for (const m of messages) {
      for (const r of m.message.matchAll(/This reverts commit ([0-9a-f]{7,40})/gi)) {
        const cible = [...shas].find((s) => s.startsWith(r[1].toLowerCase()));
        if (cible) { revert = { commit: m.sha, reverts: cible }; break; }
      }
      if (revert) break;
    }
    const pre = prefixeIid(repo.forge);
    if (!revert && new RegExp(`Reverts\\s+(?:[\\w./-]+)?${pre === '#' ? '#' : '!'}${a.iid}(?!\\d)`, 'i').test(b.description || '')) revert = { description: true };
    if (revert) { qualif.push({ kind: 'revert', ref: revert.reverts || `${pre}${a.iid}` }); signaux.push({ kind: 'revert', ...revert }); }
    // 3. Référence
    const refTitre = new RegExp(`(?:^|[^\\w])${pre === '#' ? '#' : '!'}${a.iid}(?!\\d)`);
    if (refTitre.test(b.title || '')) signaux.push({ kind: 'reference', where: 'title' });
    if (refTitre.test(b.description || '')) signaux.push({ kind: 'reference', where: 'description' });
    if (new RegExp(`(?:^|[^0-9])(?:${pre === '#' ? '#' : '!'}|(?:mr|pr)-?)${a.iid}(?![0-9])`, 'i').test(b.source_branch || '')) signaux.push({ kind: 'reference', where: 'branch' });
    const cleA = a.ticket_jira_key ? String(a.ticket_jira_key).toUpperCase() : null;
    const cleB = b.ticket_jira_key ? String(b.ticket_jira_key).toUpperCase() : null;
    if (ticketBug && cleA && (cleA === cleB || liensB.has(cleA))) signaux.push({ kind: 'reference', where: 'ticket', ticket: cleB, linked: cleA });
    if (ticketBug) qualif.push({ kind: 'ticket-bug', ref: cleB, type: b.ticket_jira_type });
    if (commitFix) qualif.push({ kind: 'commit-fix' });
    // 2. Lignes réécrites
    const r = reecrit.get(a.id);
    const assez = r && r.lines >= minimum && minimum > 0 ? true : (r && minimum === 0);
    const base = { origin: a.id, days: delai, bug: qualif, signaux };
    if (revert) liens.push({ ...base, kind: 'revert', lines: r ? r.lines : 0, files: r ? r.files.size : 0, detail: { ranges: r ? plagesEnJson(r.files) : {} } });
    if (assez) liens.push({ ...base, kind: 'rewrites', lines: r.lines, files: r.files.size, large, detail: { ranges: plagesEnJson(r.files) } });
    if (!revert && !assez && signaux.some((s) => s.kind === 'reference')) liens.push({ ...base, kind: 'reference', lines: r ? r.lines : 0, files: r ? r.files.size : 0, detail: { ranges: r ? plagesEnJson(r.files) : {} } });
  }
  ecrireLiens({ fixMrId: b.id, fixSha: '' }, liens, { sha, now });
  bilan.liens = liens.length;
  return noter(liens.length ? 'linked' : 'none');
}

/* ---------- un commit direct sur la cible (hotfix sans MR) ---------- */

async function analyserCommit(cfg, repo, cwd, c, { now = new Date().toISOString() } = {}) {
  const n = fenetre(cfg);
  const cands = candidats(repo.id, c.branche, c.date, n);
  if (!cands.length) return 0;
  const parSha = new Map();
  for (const a of cands) for (const s of await commitsDe(cwd, a)) if (!parSha.has(s)) parSha.set(s, a.id);
  const reecrit = await lignesReecrites(cwd, `${c.sha}^`, c.sha, parSha);
  const totalLignes = [...reecrit.values()].reduce((s, e) => s + e.lines, 0);
  const large = totalLignes > LARGE_LIGNES && reecrit.size > LARGE_ORIGINES;
  const minimum = minLignes(cfg);
  const commitFix = /^\s*(fix|hotfix)(\(|:|!)/i.test(c.title || '') || /^\s*hotfix\b/i.test(c.title || '');
  const liens = [];
  for (const a of cands) {
    const r = reecrit.get(a.id);
    const revert = [...(c.message || '').matchAll(/This reverts commit ([0-9a-f]{7,40})/gi)].map((m) => m[1].toLowerCase())
      .map((p) => [a.merge_commit_sha, a.squash_commit_sha, a.head_sha].find((s) => s && s.startsWith(p))).find(Boolean);
    const qualif = [];
    if (revert) qualif.push({ kind: 'revert', ref: revert });
    if (commitFix) qualif.push({ kind: 'commit-fix' });
    const base = { origin: a.id, days: jours(a.merged_at, c.date), bug: qualif, signaux: revert ? [{ kind: 'revert', commit: c.sha, reverts: revert }] : [], detail: { ranges: r ? plagesEnJson(r.files) : {}, title: c.title || '' } };
    if (revert) liens.push({ ...base, kind: 'revert', lines: r ? r.lines : 0, files: r ? r.files.size : 0 });
    else if (r && (minimum === 0 || r.lines >= minimum)) liens.push({ ...base, kind: 'rewrites', lines: r.lines, files: r.files.size, large });
  }
  if (liens.length) ecrireLiens({ fixMrId: 0, fixSha: c.sha }, liens, { sha: c.sha, now });
  return liens.length;
}

/* Les commits arrivés sur une branche cible HORS merge connu depuis la dernière pointe lue. La
   première lecture pose la pointe sans rien analyser : on ne refait pas l'histoire. */
async function tourCommitsDirects(cfg, repo, cwd, branche, { now = new Date().toISOString() } = {}) {
  const ref = `${repo.id}:${branche}`;
  if (!(await git.refExists(cwd, `origin/${branche}`))) return 0;
  const pointe = (await git.run('git', ['rev-parse', `origin/${branche}`], { cwd })).stdout.trim();
  const vu = db.prepare("SELECT sha FROM mr_fix_scan WHERE kind = 'branch' AND ref = ?").get(ref);
  if (!vu || !vu.sha) { poserScan('branch', ref, pointe, now, 'baseline'); return 0; }
  if (vu.sha === pointe) return 0;
  if (!(await existe(cwd, vu.sha))) { poserScan('branch', ref, pointe, now, 'rebased'); return 0; }   // historique réécrit : on repart de la pointe
  const { commits } = await git.logFirstParent(cwd, `${vu.sha}..${pointe}`, { max: MAX_COMMITS_DIRECTS });
  const connus = new Set();
  for (const r of db.prepare('SELECT merge_commit_sha, squash_commit_sha, head_sha FROM mr WHERE repo_id = ?').all(repo.id)) for (const s of [r.merge_commit_sha, r.squash_commit_sha, r.head_sha]) if (s) connus.add(s);
  for (const r of db.prepare('SELECT c.sha FROM mr_commits c JOIN mr ON mr.id = c.mr_id WHERE mr.repo_id = ?').all(repo.id)) connus.add(r.sha);
  let liens = 0;
  for (const c of commits.reverse()) {       // du plus ancien au plus récent
    if (c.parents.length !== 1 || connus.has(c.sha)) continue;
    let message = c.title;
    try { message = (await git.run('git', ['log', '-n', '1', '--format=%B', c.sha], { cwd })).stdout; } catch { /* le titre suffit */ }
    try { liens += await analyserCommit(cfg, repo, cwd, { sha: c.sha, date: c.date || now, title: c.title, message, branche }, { now }); }
    catch { /* un commit illisible n'arrête pas la branche */ }
  }
  poserScan('branch', ref, pointe, now, `${commits.length} commits`);
  return liens;
}

/* ---------- écrire ---------- */

function poserScan(kind, ref, sha, now, note) {
  db.prepare(`INSERT INTO mr_fix_scan (kind, ref, sha, scanned_at, note) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (kind, ref) DO UPDATE SET sha = excluded.sha, scanned_at = excluded.scanned_at, note = excluded.note`).run(kind, ref, sha || null, now, note || null);
}

/* Les liens d'UN B, recalculés : les liens `auto` d'avant tombent, les faits se réécrivent, et
   `status` / `status_by` / `status_at` ne sont jamais touchés — l'arbitrage humain l'emporte. */
const ecrireLiens = db.transaction(({ fixMrId, fixSha }, liens, { sha, now }) => {
  db.prepare("DELETE FROM mr_fix_link WHERE fix_mr_id = ? AND fix_commit_sha = ? AND status = 'auto'").run(fixMrId, fixSha);
  const up = db.prepare(`INSERT INTO mr_fix_link (origin_mr_id, fix_mr_id, fix_commit_sha, kind, lines, files, days, large, detail, bug, computed_at, head_sha_b)
    VALUES (@origin, @fix, @fixSha, @kind, @lines, @files, @days, @large, @detail, @bug, @now, @sha)
    ON CONFLICT (origin_mr_id, fix_mr_id, fix_commit_sha, kind) DO UPDATE SET
      lines = excluded.lines, files = excluded.files, days = excluded.days, large = excluded.large,
      detail = excluded.detail, bug = excluded.bug, computed_at = excluded.computed_at, head_sha_b = excluded.head_sha_b`);
  for (const l of liens) {
    up.run({
      origin: l.origin, fix: fixMrId, fixSha, kind: l.kind, lines: l.lines || 0, files: l.files || 0, days: l.days,
      large: l.large ? 1 : 0, detail: JSON.stringify({ ...(l.detail || {}), signals: l.signaux || [] }),
      bug: JSON.stringify(l.bug || []), now, sha,
    });
  }
});

/* ---------- le tour de découverte ---------- */

/* Les MR mergées pas encore analysées sur leur SHA de merge, les plus récentes d'abord, sous le
   plafond ; un fetch du clone par dépôt concerné ; puis, sur ces clones, les commits directs des
   branches cibles. Best-effort partout : une erreur de git ne retarde jamais la découverte. */
/* Les MR mergées qui attendent leur analyse : dans la rétention, dépôt suivi, pas encore relues sur
   leur SHA de merge. C'est la file du tour, et c'est le chiffre que la carte Stats annonce : tant
   qu'elle n'est pas vide, des retouches peuvent manquer et la part est un plancher de plus. */
function enAttente(cfg, { now = new Date().toISOString(), projet = '' } = {}) {
  const limite = new Date(Date.parse(now) - retentionJours(cfg) * JOUR_MS).toISOString();
  return db.prepare(`SELECT mr.*, repo.project, repo.forge, repo.url FROM mr JOIN repo ON repo.id = mr.repo_id
    LEFT JOIN mr_fix_scan s ON s.kind = 'mr' AND s.ref = CAST(mr.id AS TEXT)
    WHERE mr.merged_at IS NOT NULL AND mr.merged_at >= ? AND repo.enabled = 1 AND COALESCE(repo.fetch_mrs, 1) = 1
      AND (? = '' OR repo.project = ?)
      AND COALESCE(mr.squash_commit_sha, mr.merge_commit_sha, mr.head_sha) IS NOT NULL
      AND (s.ref IS NULL OR s.sha IS NOT COALESCE(mr.squash_commit_sha, mr.merge_commit_sha, mr.head_sha))
    ORDER BY mr.merged_at DESC`).all(limite, projet, projet);
}

async function tour(cfg, { onLog = (m) => console.log(`[retouches] ${m}`), now = new Date().toISOString() } = {}) {
  const bilan = { analysees: 0, liens: 0, restantes: 0, commits: 0, depots: 0, erreurs: 0 };
  if (!actif(cfg)) return bilan;
  const limite = new Date(Date.parse(now) - retentionJours(cfg) * JOUR_MS).toISOString();
  const aFaire = enAttente(cfg, { now });
  const max = plafond(cfg);
  const pris = max > 0 ? aFaire.slice(0, max) : aFaire;
  bilan.restantes = aFaire.length - pris.length;
  const parDepot = new Map();
  for (const b of pris) { if (!parDepot.has(b.repo_id)) parDepot.set(b.repo_id, []); parDepot.get(b.repo_id).push(b); }
  for (const [repoId, bs] of parDepot) {
    const repo = { id: repoId, project: bs[0].project, forge: bs[0].forge, url: bs[0].url };
    let cwd;
    try { cwd = await git.ensureRepo(cfg, repo, () => {}); }
    catch (e) { bilan.erreurs += 1; onLog(t('log.fix.clone-failed', { project: repo.project, message: e.message })); continue; }
    bilan.depots += 1;
    for (const b of bs) {
      try {
        const r = await analyserMr(cfg, repo, b, { cwd, now });
        bilan.analysees += 1;
        bilan.liens += r.liens;
        if (r.liens) onLog(t('log.fix.linked', { project: repo.project, iid: b.iid, n: r.liens, count: r.liens }));
      } catch (e) {
        bilan.erreurs += 1;
        onLog(t('log.fix.failed', { project: repo.project, iid: b.iid, message: e.message }));
        poserScan('mr', String(b.id), shaDeMerge(b), now, `error: ${String(e.message).slice(0, 200)}`);
      }
    }
    const branches = db.prepare('SELECT DISTINCT target_branch FROM mr WHERE repo_id = ? AND merged_at >= ? AND target_branch IS NOT NULL').all(repoId, limite);
    for (const { target_branch: br } of branches) {
      try { bilan.commits += await tourCommitsDirects(cfg, repo, cwd, br, { now }); }
      catch (e) { bilan.erreurs += 1; onLog(t('log.fix.failed', { project: repo.project, iid: br, message: e.message })); }
    }
  }
  if (bilan.restantes) onLog(t('log.fix.remaining', { n: bilan.restantes, count: bilan.restantes }));
  return bilan;
}

/* ---------- lire ---------- */

const ORDRE_KIND = { revert: 0, manual: 1, rewrites: 2, reference: 3 };
const compte = (l) => KINDS_COMPTES.includes(l.kind) && l.status !== 'dismissed' && !l.large;
const qualifieBug = (l) => l.status === 'confirmed' || (Array.isArray(l.bug) && l.bug.length > 0);

/* Une paire (A, B) sous une forme lisible, tous ses signaux regroupés. */
function regrouper(rows) {
  const paires = new Map();
  for (const r of rows) {
    const cle = `${r.origin_mr_id}|${r.fix_mr_id}|${r.fix_commit_sha}`;
    const detail = lireJson(r.detail, {});
    const bug = lireJson(r.bug, []);
    const e = paires.get(cle) || {
      origin: { id: r.origin_mr_id, iid: r.origin_iid, title: r.origin_title || '', project: r.project, note: r.origin_note != null ? Number(r.origin_note) : null, merged_at: r.origin_merged_at, web_url: r.origin_url || null },
      fix: r.fix_mr_id ? { id: r.fix_mr_id, iid: r.fix_iid, title: r.fix_title || '', merged_at: r.fix_merged_at, sha: null, web_url: r.fix_url || null }
        : { id: null, iid: null, title: detail.title || '', merged_at: null, sha: r.fix_commit_sha, web_url: null },
      kinds: [], kind: null, lines: 0, files: 0, days: r.days, large: false, status: r.status, status_by: r.status_by || null, status_at: r.status_at || null,
      bug: [], signals: [], ranges: {}, computed_at: r.computed_at, head_sha: r.head_sha_b, counted: false,
    };
    e.kinds.push(r.kind);
    if (e.kind == null || ORDRE_KIND[r.kind] < ORDRE_KIND[e.kind]) e.kind = r.kind;
    e.lines = Math.max(e.lines, r.lines || 0);
    e.files = Math.max(e.files, r.files || 0);
    e.large = e.large || !!r.large;
    for (const b of bug) if (!e.bug.some((x) => x.kind === b.kind && x.ref === b.ref)) e.bug.push(b);
    for (const s of detail.signals || []) if (!e.signals.some((x) => JSON.stringify(x) === JSON.stringify(s))) e.signals.push(s);
    if (detail.ranges && Object.keys(detail.ranges).length && !Object.keys(e.ranges).length) e.ranges = detail.ranges;
    paires.set(cle, e);
  }
  for (const e of paires.values()) {
    e.counted = e.kinds.some((k) => KINDS_COMPTES.includes(k)) && e.status !== 'dismissed' && !e.large;
    e.bug_qualified = e.counted && (e.status === 'confirmed' || e.bug.length > 0);
    e.reference_only = e.kinds.every((k) => k === 'reference');
  }
  return [...paires.values()];
}

const SELECT_LIENS = `SELECT l.*, a.iid AS origin_iid, a.title AS origin_title, a.merged_at AS origin_merged_at, a.web_url AS origin_url, repo.project, rv.note_value AS origin_note,
    b.iid AS fix_iid, b.title AS fix_title, b.merged_at AS fix_merged_at, b.web_url AS fix_url
  FROM mr_fix_link l JOIN mr a ON a.id = l.origin_mr_id JOIN repo ON repo.id = a.repo_id
  LEFT JOIN review rv ON rv.mr_id = a.id LEFT JOIN mr b ON b.id = l.fix_mr_id`;

/* CE QUE LA CARTE AFFICHE, par merge request : `touched_by` (ce qui a retouché CETTE MR, pour A) et
   `touches` (ce que CETTE MR a retouché, pour B — le miroir), plus la fenêtre. Une entrée n'existe
   que s'il y a un lien. Jamais rien avant le merge de B : le lien n'existe qu'après. */
function pourCartes(cfg, { mrIds = null } = {}) {
  const out = {};
  if (!actif(cfg)) return out;
  const borne = Array.isArray(mrIds) && mrIds.length ? `WHERE l.origin_mr_id IN (${mrIds.map(() => '?').join(',')}) OR l.fix_mr_id IN (${mrIds.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`${SELECT_LIENS} ${borne} ORDER BY l.days, l.origin_mr_id, l.fix_mr_id, l.fix_commit_sha, l.kind`).all(...(borne ? [...mrIds, ...mrIds] : []));
  const garde = (id) => !(Array.isArray(mrIds) && mrIds.length) || mrIds.includes(id);
  const n = fenetre(cfg);
  const entree = (id) => { if (!out[id]) out[id] = { touched_by: [], touches: [], window: n }; return out[id]; };
  for (const p of regrouper(rows)) {
    if (garde(p.origin.id)) entree(p.origin.id).touched_by.push(p);
    if (p.fix.id && garde(p.fix.id)) entree(p.fix.id).touches.push(p);
  }
  return out;
}

/* ---------- l'arbitrage humain ---------- */

/* « Pas un correctif » / « Marquer comme correctif » sur une paire : tous ses signaux prennent le
   statut, avec qui et quand — un fait enregistré, jamais un recalcul. Une paire que rien n'a reliée
   (`manual`) se crée en `confirmed`, avec son délai. Rend la paire relue. */
function requalifier(cfg, { originId, fixMrId = 0, fixSha = '', status, par = '' }, now = new Date().toISOString()) {
  if (!['confirmed', 'dismissed', 'auto'].includes(status)) throw new Error(t('err.fix.statut-inconnu'));
  const a = db.prepare('SELECT id, repo_id, target_branch, merged_at FROM mr WHERE id = ?').get(Number(originId));
  if (!a) throw new Error(t('err.mr-introuvable'));
  const fix = Number(fixMrId) || 0;
  const sha = String(fixSha || '');
  if (!fix && !sha) throw new Error(t('err.fix.lien-introuvable'));
  const b = fix ? db.prepare('SELECT id, repo_id, merged_at FROM mr WHERE id = ?').get(fix) : null;
  if (fix && (!b || b.repo_id !== a.repo_id || !b.merged_at)) throw new Error(t('err.fix.lien-introuvable'));
  if (fix === a.id) throw new Error(t('err.fix.lien-introuvable'));
  const existants = db.prepare('SELECT kind FROM mr_fix_link WHERE origin_mr_id = ? AND fix_mr_id = ? AND fix_commit_sha = ?').all(a.id, fix, sha);
  const tx = db.transaction(() => {
    if (!existants.length) {
      if (status !== 'confirmed') throw new Error(t('err.fix.lien-introuvable'));
      db.prepare(`INSERT INTO mr_fix_link (origin_mr_id, fix_mr_id, fix_commit_sha, kind, lines, files, days, large, detail, bug, computed_at, head_sha_b, status, status_by, status_at)
        VALUES (?, ?, ?, 'manual', 0, 0, ?, 0, '{}', '[]', ?, NULL, 'confirmed', ?, ?)`).run(a.id, fix, sha, b ? jours(a.merged_at, b.merged_at) : null, now, par || null, now);
    } else {
      db.prepare('UPDATE mr_fix_link SET status = ?, status_by = ?, status_at = ? WHERE origin_mr_id = ? AND fix_mr_id = ? AND fix_commit_sha = ?')
        .run(status, status === 'auto' ? null : (par || null), status === 'auto' ? null : now, a.id, fix, sha);
      if (status === 'auto') db.prepare("DELETE FROM mr_fix_link WHERE origin_mr_id = ? AND fix_mr_id = ? AND fix_commit_sha = ? AND kind = 'manual'").run(a.id, fix, sha);
    }
  });
  tx();
  return (pourCartes(cfg, { mrIds: [a.id] })[a.id] || { touched_by: [] }).touched_by.find((p) => (p.fix.id || 0) === fix && (p.fix.sha || '') === sha) || null;
}

/* Les MR mergées d'un dépôt que B pourrait avoir corrigées, pour « Marquer comme correctif » :
   même cible, mergées avant B (la fenêtre élargie à trois fois : le geste humain sait mieux). */
function originesPossibles(cfg, fixMrId) {
  const b = db.prepare('SELECT * FROM mr WHERE id = ?').get(Number(fixMrId));
  if (!b || !b.merged_at) return [];
  return candidats(b.repo_id, b.target_branch, b.merged_at, fenetre(cfg) * 3, { saufId: b.id })
    .map((a) => ({ id: a.id, iid: a.iid, title: a.title || '', merged_at: a.merged_at, note: a.note_value != null ? Number(a.note_value) : null }));
}

/* ---------- Stats ---------- */

const mediane = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(Number(x))).map(Number).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return Math.round((v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) * 10) / 10;
};
const TRANCHES = ['8+', '7-8', '<7', 'none'];
const trancheDe = (note) => (note == null ? 'none' : (note * 10 >= 8 ? '8+' : (note * 10 >= 7 ? '7-8' : '<7')));

/* LA TABLE « NOTE CONTRE RETOUCHE » : par tranche de note, puis par dépôt, TOUTES les MR mergées de
   la période au dénominateur — y compris celles dont la fenêtre court encore —, les retouchées au
   numérateur, le délai et les lignes médians ; la liste des retouches de la période, les plus
   rapides d'abord. Le chiffre est donc un PLANCHER qui ne peut que monter tant que des fenêtres
   courent, et la carte dit combien (`pending`) : n'entrer les jeunes MR que lorsqu'elles sont
   retouchées gonflerait la part (numérateur sans son dénominateur), les exclure toutes ferait
   attendre un mois un chiffre dont la liste montre déjà les faits. Deux autres planchers : les
   corrections par ajout pur et hors MR ne sont pas toutes vues. Aucune clé d'auteur. */
function stats(cfg, { depuis = null, jusqua = null, projet = '' } = {}) {
  const n = fenetre(cfg);
  const vide = { enabled: actif(cfg), window: n, merged: 0, touched: 0, bug: 0, tranches: [], repos: [], links: [], pending: 0, unscanned: 0 };
  if (!actif(cfg)) return vide;
  const fin = jusqua || new Date().toISOString();
  const connuAvant = new Date(Date.now() - n * JOUR_MS).toISOString();
  const mrs = db.prepare(`SELECT mr.id, mr.iid, mr.title, mr.merged_at, repo.project, rv.note_value
    FROM mr JOIN repo ON repo.id = mr.repo_id LEFT JOIN review rv ON rv.mr_id = mr.id
    WHERE mr.merged_at IS NOT NULL AND (? IS NULL OR mr.merged_at >= ?) AND mr.merged_at <= ? AND (? = '' OR repo.project = ?)`)
    .all(depuis, depuis, fin, projet, projet);
  const ids = mrs.map((m) => m.id);
  const liens = ids.length ? regrouper(db.prepare(`${SELECT_LIENS} WHERE l.origin_mr_id IN (${ids.map(() => '?').join(',')}) ORDER BY l.days`).all(...ids)) : [];
  const parOrigine = new Map();
  for (const p of liens) { if (!parOrigine.has(p.origin.id)) parOrigine.set(p.origin.id, []); parOrigine.get(p.origin.id).push(p); }
  const acc = () => ({ merged: 0, touched: 0, bug: 0, days: [], lines: [] });
  const ajouter = (a, m) => {
    a.merged += 1;
    const ps = (parOrigine.get(m.id) || []).filter((p) => p.counted);
    if (!ps.length) return;
    a.touched += 1;
    if (ps.some((p) => p.bug_qualified)) a.bug += 1;
    const premier = ps[0];
    a.days.push(premier.days);
    a.lines.push(ps.reduce((s, p) => s + (p.lines || 0), 0));
  };
  const finir = (a) => ({
    merged: a.merged, touched: a.touched, bug: a.bug,
    share: a.merged ? Math.round((a.touched / a.merged) * 1000) / 10 : null,
    bug_share: a.merged ? Math.round((a.bug / a.merged) * 1000) / 10 : null,
    median_days: mediane(a.days), median_lines: mediane(a.lines),
  });
  const total = acc();
  const parTranche = Object.fromEntries(TRANCHES.map((k) => [k, acc()]));
  const parDepot = new Map();
  let pending = 0;
  for (const m of mrs) {
    if (m.merged_at > connuAvant) pending += 1;   // comptée quand même : fenêtre en cours, dite sur la carte
    ajouter(total, m);
    ajouter(parTranche[trancheDe(m.note_value)], m);
    if (!parDepot.has(m.project)) parDepot.set(m.project, acc());
    ajouter(parDepot.get(m.project), m);
  }
  return {
    ...vide,
    ...finir(total),
    pending,
    /* Le retard du tour (`fix_links_max` par découverte) : des MR mergées dont le diff n'a pas encore
       été relu — donc des retouches qui peuvent manquer au chiffre, dit tel quel sur la carte. */
    unscanned: enAttente(cfg, { now: fin, projet }).length,
    tranches: TRANCHES.map((k) => ({ tranche: k, ...finir(parTranche[k]) })),
    repos: [...parDepot.entries()].map(([project, a]) => ({ project, ...finir(a) })).sort((x, y) => (y.share || 0) - (x.share || 0) || x.project.localeCompare(y.project)),
    links: liens.filter((p) => !p.reference_only).sort((x, y) => (x.days ?? 1e9) - (y.days ?? 1e9)),
  };
}

module.exports = {
  actif, fenetre, minLignes, plafond, retentionJours, shaDeMerge, candidats, enAttente,
  plageDe, hunksRetires, blameLignes, lignesReecrites, analyserMr, analyserCommit, tourCommitsDirects, tour,
  pourCartes, regrouper, requalifier, originesPossibles, stats, trancheDe,
};
