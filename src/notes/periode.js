'use strict';
/* LE RATTRAPAGE D'UNE PÉRIODE — « qu'est-ce qui s'est passé entre le 3 et le 17 ? ».
 *
 * Pendant un congé, le poste est éteint : la découverte n'a pas tourné, et ce qui a été ouvert
 * ET mergé entre-temps n'apparaît jamais (la découverte ne liste que les ouvertes). Une période
 * se reconstruit donc DEPUIS LA FORGE ET LE CLONE, pas depuis ce que Mergerie a vu :
 *   - les merge requests touchées dans la fenêtre viennent de la forge (`listAllMRs` borné), et
 *     le détail de chaque mergée (ses quatre SHA) est demandé une fois — il sert à l'algorithme
 *     des commits directs ET à la review a posteriori ;
 *   - les COMMITS viennent du clone : `--first-parent` sur chaque branche surveillée, parents,
 *     dates et `patch-id` y sont gratuits, et git répond sans pagination ni rate limit. La forge
 *     ne reste que pour ce que git ignore — quelle MR a produit tel commit —, plafonnée ;
 *   - ce que les collègues ont fait dans Mergerie (base partagée), ce que Mergerie a fait seul et
 *     les tickets Jira qui ont bougé viennent de `periode-sources.js`.
 *
 * Au passage, la base est RÉPARÉE : les MR mergées pendant l'absence sont écrites (`closed_seen`,
 * `merged_at`, SHA), la session qui a ouvert la branche est liée, les todos cochées, le journal
 * complété avec la VRAIE date — sinon le brief compterait onze merges « d'aujourd'hui ».
 *
 * Toute erreur de forge ou de git sur un dépôt le marque PARTIEL, avec sa raison, et n'arrête
 * jamais les autres : un écran de rattrapage qui prétend être exhaustif alors qu'il ne l'est pas
 * fait rater précisément ce qu'on est venu chercher. */
const db = require('../db');
const forge = require('../forge');
const git = require('../git/git');
const mrref = require('../git/mrref');
const jira = require('../integrations/jira');
const { etat } = require('../data/localstate');
const { getConfig } = require('../data/config');
const { apresMerge } = require('./discover');
const { classer, regrouperPushs, classerMr } = require('./periode-classement');
const { faitParLEquipe, faitParMergerie, ticketsJira } = require('./periode-sources');
const { estBot } = require('../core/bots');

const isDemo = () => process.env.MERGERIE_DEMO === '1';
const JOUR_MS = 24 * 3600 * 1000;

/* Plafonds, affichés plutôt que cachés quand ils sont atteints (`partiel`). */
const MAX_DETAILS_MR = 200;        // détails de MR mergées demandés à la forge, par dépôt
const MAX_CANDIDATS = 1500;        // commits first-parent lus par branche
const MAX_PATCH_IDS = 400;         // empreintes calculées pour les candidats, par dépôt
const MAX_COMMITS_PAR_MR = 60;     // commits d'une MR dont on calcule l'empreinte
const MAX_FORGE_PAR_DEPOT = 100;   // passe 3 : appels `mergeRequestsOfCommit`
const MAX_BRANCHES = 12;           // branches surveillées par dépôt
const MAX_EVENEMENTS_PUSH = 300;   // pushs lus sur la forge (GitLab) pour un regroupement exact

/* ---------- La fenêtre ---------- */

/* Les bornes, normalisées en ISO. `jusqua` inclut toute la journée demandée. */
function bornes(depuis, jusqua) {
  const d = new Date(depuis);
  const f = new Date(jusqua);
  if (Number.isNaN(d.getTime()) || Number.isNaN(f.getTime())) throw new Error('periode.dates');
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(jusqua))) f.setUTCHours(23, 59, 59, 999);
  if (f < d) throw new Error('periode.ordre');
  return { depuis: d.toISOString(), jusqua: f.toISOString() };
}

/* ---------- Les branches à surveiller ---------- */

/* La branche par défaut + les protégées, ou la liste posée sur le dépôt (Réglages → Dépôts). */
async function branchesSurveillees(cfg, repo, cwd) {
  const propres = String(repo.periode_branches || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  let liste = propres;
  if (!liste.length) {
    liste = [await git.defaultBranch(cwd)];
    if (cfg.periode_watch_protected !== '0') {
      try { liste.push(...await forge.clientFor(repo).listProtectedBranches(cfg, repo.project)); }
      catch { /* droits insuffisants : la branche par défaut suffit */ }
    }
  }
  const vues = [];
  for (const b of [...new Set(liste)].slice(0, MAX_BRANCHES)) {
    // Un motif protégé (`release/*`) n'est pas une branche : on ne garde que ce qui existe.
    if (/[*?]/.test(b)) continue;
    if (await git.refExists(cwd, `origin/${b}`)) vues.push(b);
  }
  return vues;
}

/* ---------- Réparer la base en passant ---------- */

const selectMr = () => db.prepare('SELECT * FROM mr WHERE repo_id = ? AND iid = ?');

/* Écrit ce que la forge sait d'une MR vue dans la fenêtre. On ne REMPLACE jamais une décision
   (statut, SHA relu) ; les faits de forge, eux, se complètent. Rend la ligne `mr` (id, créée ou
   non) et dit si elle vient d'être créée. */
function upsertMr(repo, m, detail, now) {
  const existing = selectMr().get(repo.id, m.iid);
  const mergee = !!m.merged_at;
  const fermee = m.state === 'closed' && !mergee;
  const d = detail || {};
  const base = {
    title: m.title || null, source_branch: m.source_branch || null, target_branch: m.target_branch || null,
    web_url: m.web_url || null, author: m.author || null, gitlab_created_at: m.created_at || null,
    merged_at: m.merged_at || null,
    head_sha: d.head_sha || m.sha || null, base_sha: d.base_sha || null,
    merge_commit_sha: d.merge_commit_sha || null, squash_commit_sha: d.squash_commit_sha || null,
    closed_seen: mergee || fermee ? 1 : 0,
  };
  if (existing) {
    db.prepare(`UPDATE mr SET
        title = COALESCE(NULLIF(@title, ''), title), source_branch = COALESCE(NULLIF(@source_branch, ''), source_branch),
        target_branch = COALESCE(NULLIF(@target_branch, ''), target_branch), web_url = COALESCE(NULLIF(@web_url, ''), web_url),
        author = COALESCE(NULLIF(@author, ''), author), gitlab_created_at = COALESCE(gitlab_created_at, @gitlab_created_at),
        merged_at = COALESCE(merged_at, @merged_at),
        head_sha = COALESCE(@head_sha, head_sha), base_sha = COALESCE(@base_sha, base_sha),
        merge_commit_sha = COALESCE(@merge_commit_sha, merge_commit_sha), squash_commit_sha = COALESCE(@squash_commit_sha, squash_commit_sha),
        closed_seen = CASE WHEN @closed_seen = 1 THEN 1 ELSE closed_seen END
      WHERE id = @id`).run({ ...base, id: existing.id });
    return { id: existing.id, cree: false, dejaFermee: !!existing.closed_seen, existing };
  }
  /* Une MR jamais vue : la découverte ne l'aurait pas ramenée (déjà fermée) ou l'aurait
     ramenée au prochain tour (ouverte, et on respecte son motif de branche). */
  const pattern = String(repo.branch_pattern || '').trim();
  if (!mergee && !fermee && pattern && !String(m.source_branch || '').includes(pattern)) return null;
  const info = db.prepare(`INSERT INTO mr
    (repo_id, iid, title, source_branch, target_branch, web_url, current_sha, gitlab_created_at, author, status, updated_at,
     merged_at, head_sha, base_sha, merge_commit_sha, squash_commit_sha, closed_seen)
    VALUES (@repo_id, @iid, @title, @source_branch, @target_branch, @web_url, @current_sha, @gitlab_created_at, @author, 'to_review', @updated_at,
     @merged_at, @head_sha, @base_sha, @merge_commit_sha, @squash_commit_sha, @closed_seen)`)
    .run({ ...base, repo_id: repo.id, iid: m.iid, current_sha: base.head_sha, updated_at: now });
  return { id: Number(info.lastInsertRowid), cree: true, dejaFermee: false, existing: null };
}

/* Le journal (`feed`), DATÉ À L'ÉVÉNEMENT. On ne double pas une ligne déjà là. */
function journal(type, repo, m, at) {
  if (!at) return;
  const deja = db.prepare('SELECT 1 FROM feed WHERE type = ? AND mr_iid = ? AND project = ? LIMIT 1').get(type, m.iid, repo.project);
  if (deja) return;
  db.prepare('INSERT INTO feed (type, mr_iid, project, author, title, at) VALUES (?,?,?,?,?,?)')
    .run(type, m.iid, repo.project, m.author || '', m.title || '', at);
}

/* ---------- Un dépôt ---------- */

async function construireDepot(cfg, repo, { depuis, jusqua, onLog }) {
  const client = forge.clientFor(repo);
  const now = new Date().toISOString();
  const partiel = [];
  const items = [];
  const log = (m) => onLog(`${repo.project} : ${m}`);

  // 1. Les merge requests touchées dans la fenêtre.
  let toutes = [];
  try { toutes = await client.listAllMRs(cfg, repo.project, { updatedAfter: depuis }); }
  catch (e) { partiel.push(`forge : ${String(e.message).split('\n')[0]}`); }
  const classees = toutes.map((m) => ({ m, kind: classerMr(m, depuis, jusqua) })).filter((x) => x.kind);
  const mergees = classees.filter((x) => x.kind === 'mr_merged').map((x) => x.m);
  log(`${classees.length} merge request(s) dans la fenêtre, dont ${mergees.length} mergée(s)`);

  // 2. Le détail des mergées : leurs SHA, écrits dans `mr` — ils serviront à la review.
  const details = new Map();
  for (const m of mergees.slice(0, MAX_DETAILS_MR)) {
    try { details.set(m.iid, await client.getMergeRequest(cfg, repo.project, m.iid)); }
    catch { /* la liste suffit pour classer ; le commit de merge restera « non vérifié » */ }
  }
  if (mergees.length > MAX_DETAILS_MR) partiel.push(`détails de MR plafonnés à ${MAX_DETAILS_MR}`);

  // Réparation de la base et lignes de l'écran, pour chaque MR classée.
  const clesJira = new Set();
  for (const { m, kind } of classees) {
    const cle = jira.ticketKey(m.title, m.source_branch);
    if (cle) clesJira.add(cle);
    const ligne = upsertMr(repo, m, details.get(m.iid), now);
    if (ligne && kind === 'mr_merged') {
      apresMerge(repo, { id: ligne.id, iid: m.iid, source_branch: m.source_branch }, { cfg, now });
      journal('mr_merged', repo, m, m.merged_at);
      if (ligne.cree) journal('mr_opened', repo, m, m.created_at);
    } else if (ligne && kind === 'mr_closed') {
      // Fermée sans merge : la todo qui la suivait n'a plus de raison d'être, la session, elle, n'est pas liée.
      apresMerge(repo, { id: ligne.id, iid: m.iid, source_branch: m.source_branch }, { mergee: false, cfg, now });
    } else if (ligne && kind === 'mr_new' && ligne.cree) {
      journal('mr_opened', repo, m, m.created_at);
    }
    const at = kind === 'mr_merged' ? m.merged_at : (kind === 'mr_closed' ? m.closed_at : (kind === 'mr_new' ? m.created_at : m.updated_at));
    items.push({
      repo_id: repo.id, kind, ref: String(m.iid), author: m.author || '', title: m.title || '', at,
      mr_id: ligne ? ligne.id : null,
      extra: { source_branch: m.source_branch, target_branch: m.target_branch, web_url: m.web_url, bot: estBot(m.author) },
    });
  }

  // 3. Le clone, et les têtes des MR mergées — un seul fetch.
  let cwd = null;
  try { cwd = await git.ensureRepo(cfg, repo, () => {}); }
  catch (e) { partiel.push(`clone : ${String(e.message).split('\n')[0]}`); }
  if (!cwd) return { repo_id: repo.id, project: repo.project, partiel, items, non_calcule: ['push', 'tag', 'branch_gone', 'pipeline'], cles_jira: [...clesJira] };
  try { await mrref.fetchMrRefs(cwd, repo, mergees.map((m) => m.iid), () => {}); }
  catch (e) { partiel.push(`refs de MR : ${String(e.message).split('\n')[0]}`); }

  // 4. Les candidats : l'histoire first-parent de chaque branche surveillée.
  const branches = await branchesSurveillees(cfg, repo, cwd);
  const mrs = mergees.map((m) => {
    const d = details.get(m.iid) || {};
    return { iid: m.iid, head_sha: d.head_sha || m.sha || null, base_sha: d.base_sha || null, merge_commit_sha: d.merge_commit_sha || null, squash_commit_sha: d.squash_commit_sha || null, target_branch: m.target_branch, merged_at: m.merged_at };
  });
  const candidats = [];
  for (const b of branches) {
    try {
      const r = await git.logFirstParent(cwd, `origin/${b}`, { since: depuis, until: jusqua, max: MAX_CANDIDATS });
      if (r.partiel) partiel.push(`${b} : commits coupés à ${MAX_CANDIDATS}`);
      for (const c of r.commits) candidats.push({ ...c, branche: b });
    } catch (e) { partiel.push(`${b} : ${String(e.message).split('\n')[0]}`); }
  }
  log(`${candidats.length} commit(s) sur ${branches.join(', ') || 'aucune branche surveillée'}`);

  // Passe 1 bis — un merge commit dont le second parent descend d'une MR mergée (merge train,
  // branche mise à jour avant le merge) : testé sur les MR de la même cible, mergées à ±2 jours.
  const secondParentMr = new Map();
  const tetesConnues = new Set(mrs.flatMap((m) => [m.head_sha, m.merge_commit_sha, m.squash_commit_sha]).filter(Boolean));
  for (const c of candidats) {
    if ((c.parents || []).length < 2 || tetesConnues.has(c.sha) || tetesConnues.has(c.parents[1])) continue;
    const t = Date.parse(c.date || '') || 0;
    const proches = mrs.filter((m) => m.head_sha && m.target_branch === c.branche && Math.abs((Date.parse(m.merged_at || '') || 0) - t) <= 2 * JOUR_MS);
    for (const m of proches.slice(0, 6)) {
      if (await git.isAncestor(cwd, m.head_sha, c.parents[1])) { secondParentMr.set(c.sha, m.iid); break; }
    }
  }

  // Première passe sans la forge : ce qui reste décide si on calcule des empreintes.
  let resultat = classer({ candidats, mrs, secondParentMr });
  const patchIdsParMr = new Map();
  if (resultat.directs.length) {
    // Passe 2 — l'empreinte des commits des MR mergées, puis celle des candidats restants.
    for (const m of mrs) {
      if (!m.base_sha || !m.head_sha) continue;
      let shas = [];
      try { shas = await git.revList(cwd, `${m.base_sha}..${m.head_sha}`, { max: MAX_COMMITS_PAR_MR }); } catch { continue; }
      for (const sha of shas) {
        const pid = await git.patchId(cwd, sha).catch(() => null);
        if (pid && !patchIdsParMr.has(pid)) patchIdsParMr.set(pid, m.iid);
      }
    }
    let empreintes = 0;
    for (const c of candidats) {
      if ((c.parents || []).length > 1 || !resultat.directs.some((d) => d.sha === c.sha)) continue;
      if (empreintes >= MAX_PATCH_IDS) { partiel.push(`empreintes plafonnées à ${MAX_PATCH_IDS}`); break; }
      empreintes += 1;
      c.patch_id = await git.patchId(cwd, c.sha).catch(() => null);
    }
    resultat = classer({ candidats, mrs, secondParentMr, patchIdsParMr });
  }

  // Passe 3 — la forge, pour ce qui reste, plafonnée : au-delà, « non vérifié ».
  const mrsParCommit = new Map();
  const nonVerifies = new Set();
  const aDemander = resultat.aVerifier.filter((sha) => !resultat.directs.find((d) => d.sha === sha && d.etiquettes.bot));
  let appels = 0;
  for (const sha of aDemander) {
    if (appels >= MAX_FORGE_PAR_DEPOT) { nonVerifies.add(sha); continue; }
    appels += 1;
    try { mrsParCommit.set(sha, (await client.mergeRequestsOfCommit(cfg, repo.project, sha)).map((x) => x.iid)); }
    catch { nonVerifies.add(sha); }
  }
  // Ce qu'on n'a pas demandé du tout (bots) compte comme vérifié : un robot n'est pas un contournement.
  for (const sha of resultat.aVerifier) if (!mrsParCommit.has(sha) && !nonVerifies.has(sha)) mrsParCommit.set(sha, []);
  if (nonVerifies.size) partiel.push(`passe forge plafonnée : ${nonVerifies.size} commit(s) non vérifié(s)`);
  resultat = classer({ candidats, mrs, secondParentMr, patchIdsParMr, mrsParCommit, nonVerifies });

  // 5. Les pushs, avec leur diffstat. GitLab dit quels commits sont partis ensemble
  // (`events?action=pushed`) : le regroupement est alors exact ; sans lui, l'heuristique.
  const evenementDe = new Map();
  if (resultat.directs.length) {
    try {
      const evts = await client.pushEvents(cfg, repo.project, depuis, jusqua);
      if (Array.isArray(evts)) {
        const surveillees = new Set(branches);
        let lus = 0;
        for (const ev of evts) {
          if (!surveillees.has(ev.ref) || !ev.commit_to) continue;
          if (lus >= MAX_EVENEMENTS_PUSH) { partiel.push(`pushs de la forge coupés à ${MAX_EVENEMENTS_PUSH}`); break; }
          lus += 1;
          const plage = ev.commit_from ? `${ev.commit_from}..${ev.commit_to}` : ev.commit_to;
          let shas = [];
          try { shas = await git.revList(cwd, plage, { max: 200 }); } catch { continue; }
          for (const sha of shas) if (!evenementDe.has(sha)) evenementDe.set(sha, `${ev.ref}@${ev.commit_to}`);
        }
      }
    } catch (e) { partiel.push(`pushs de la forge : ${String(e.message).split('\n')[0]}`); }
  }
  const pushs = regrouperPushs(resultat.directs, { evenementDe: evenementDe.size ? evenementDe : null });
  for (const p of pushs) {
    const stat = p.base_sha ? await git.diffStat(cwd, p.base_sha, p.head_sha) : null;
    items.push({
      repo_id: repo.id, kind: 'push', ref: p.head_sha, author: p.author, at: p.at,
      title: p.commits.map((c) => c.title).join(' · ').slice(0, 300),
      mr_id: null,
      extra: {
        branche: p.branche, base_sha: p.base_sha, head_sha: p.head_sha, author_email: p.author_email,
        commits: p.commits.map((c) => ({ sha: c.sha, title: c.title, date: c.date, author: c.author })),
        stat, exact: !!p.exact, ...p.etiquettes,
      },
    });
  }
  log(`${pushs.length} push(s) direct(s), ${resultat.attribues.length} commit(s) attribué(s) à une merge request`);

  // 6. Les tags posés dans la fenêtre (date GitLab, ou lue dans le clone pour GitHub).
  try {
    const tags = await client.listTags(cfg, repo.project);
    const dates = tags.some((x) => !x.committed_date && !x.created_at) ? await git.tagDates(cwd).catch(() => new Map()) : new Map();
    for (const tg of tags) {
      const at = tg.created_at || tg.committed_date || ((dates.get(tg.name) || {}).date) || null;
      if (!at || at < depuis || at > jusqua) continue;
      items.push({ repo_id: repo.id, kind: 'tag', ref: tg.name, author: tg.author || '', title: tg.message || '', at, mr_id: null, extra: { sha: tg.sha } });
    }
  } catch (e) { partiel.push(`tags : ${String(e.message).split('\n')[0]}`); }

  // 7. Les branches supprimées : celles des MR mergées, absentes du clone après `--prune`.
  for (const m of mergees) {
    if (!m.source_branch || await git.refExists(cwd, `origin/${m.source_branch}`)) continue;
    items.push({ repo_id: repo.id, kind: 'branch_gone', ref: m.source_branch, author: m.author || '', title: m.title || '', at: m.merged_at, mr_id: null, extra: { iid: m.iid } });
  }

  // 8. Le pipeline de chaque branche surveillée à la date du retour : rouge, on le dit.
  for (const b of branches) {
    try {
      const pl = await client.refPipeline(cfg, repo.project, b);
      if (!pl || pl.state !== 'failed') continue;
      items.push({ repo_id: repo.id, kind: 'pipeline', ref: b, author: '', title: pl.label || '', at: pl.at || now, mr_id: null, extra: { state: pl.state, url: pl.url, sha: pl.sha, branche: b } });
    } catch (e) { partiel.push(`pipeline ${b} : ${String(e.message).split('\n')[0]}`); }
  }

  return { repo_id: repo.id, project: repo.project, partiel, items, non_calcule: [], cles_jira: [...clesJira] };
}

/* ---------- Construire, enregistrer, lire ---------- */

async function construire({ depuis, jusqua, repoIds = null, onLog = () => {} } = {}) {
  const cfg = getConfig();
  const b = bornes(depuis, jusqua);
  const tous = db.prepare('SELECT * FROM repo WHERE enabled = 1 AND COALESCE(fetch_mrs, 1) = 1 ORDER BY project').all();
  const repos = Array.isArray(repoIds) && repoIds.length ? tous.filter((r) => repoIds.map(Number).includes(r.id)) : tous;
  const out = { depuis: b.depuis, jusqua: b.jusqua, repos: [], team: [], jira: [], mergerie: [] };
  /* En démo, la forge n'existe pas : la période a été semée, on ne la reconstruit pas — et
     l'exécutant n'écrase pas ce qui a été semé. */
  if (isDemo()) return { ...out, demo: true };
  for (const repo of repos) {
    try { out.repos.push(await construireDepot(cfg, repo, { ...b, onLog })); }
    catch (e) { out.repos.push({ repo_id: repo.id, project: repo.project, partiel: [String(e.message).split('\n')[0]], items: [], non_calcule: ['push', 'tag', 'branch_gone', 'pipeline'], cles_jira: [] }); }
  }
  try { out.team = faitParLEquipe(b); } catch (e) { onLog(`équipe : ${e.message}`); }
  try { out.mergerie = faitParMergerie(b); } catch (e) { onLog(`mergerie : ${e.message}`); }
  try { out.jira = await ticketsJira({ ...b, cfg, cles: out.repos.flatMap((r) => r.cles_jira || []) }); }
  catch (e) { onLog(`jira : ${String(e.message).split('\n')[0]}`); out.partiel_jira = String(e.message).split('\n')[0]; }
  return out;
}

/* Écrit le résultat sous la période : les items sont remplacés, `seen_at` conservé pour ceux
   dont la clé `(kind, repo_id, ref)` est retrouvée — recalculer ne fait pas revenir ce qu'on a
   déjà vu. Une MR mergée ET reviewée par un collègue n'apparaît qu'une fois, dans « mergées »,
   avec la mention : la section « équipe » ne reprend pas ce qui a déjà sa carte. */
function enregistrer(periodeId, resultat) {
  const vus = new Map();
  for (const r of db.prepare('SELECT kind, repo_id, ref, seen_at FROM periode_item WHERE periode_id = ? AND seen_at IS NOT NULL').all(periodeId)) {
    vus.set(`${r.kind}|${r.repo_id || ''}|${r.ref}`, r.seen_at);
  }
  const mergeesParMr = new Set();
  for (const r of resultat.repos) for (const it of r.items) if (it.kind === 'mr_merged' && it.mr_id) mergeesParMr.add(it.mr_id);
  const equipe = resultat.team.filter((it) => !(it.extra && it.extra.objet === 'review' && it.mr_id && mergeesParMr.has(it.mr_id)));
  // La review d'un collègue sur une MR mergée se note SUR la ligne de la MR.
  const reviewsParMr = new Map();
  for (const it of resultat.team) if (it.extra && it.extra.objet === 'review' && it.mr_id) reviewsParMr.set(it.mr_id, it);
  const partielDetail = {};
  let partiel = 0;
  for (const r of resultat.repos) if (r.partiel.length || r.non_calcule.length) { partielDetail[r.repo_id] = { raisons: r.partiel, non_calcule: r.non_calcule }; partiel = 1; }
  if (resultat.partiel_jira) { partielDetail.jira = { raisons: [resultat.partiel_jira], non_calcule: ['jira'] }; partiel = 1; }
  const ins = db.prepare(`INSERT INTO periode_item (periode_id, repo_id, kind, ref, author, title, at, extra, mr_id, seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    db.prepare('DELETE FROM periode_item WHERE periode_id = ?').run(periodeId);
    const tous = [...resultat.repos.flatMap((r) => r.items), ...equipe, ...(resultat.jira || []), ...(resultat.mergerie || [])];
    for (const it of tous) {
      const extra = { ...(it.extra || {}) };
      if (it.kind === 'mr_merged' && it.mr_id && reviewsParMr.has(it.mr_id)) {
        const rv = reviewsParMr.get(it.mr_id);
        extra.team_review = { author: rv.author, note: rv.extra.note, at: rv.at };
      }
      ins.run(periodeId, it.repo_id || null, it.kind, String(it.ref), it.author || null, it.title || null, it.at || null,
        JSON.stringify(extra), it.mr_id || null, vus.get(`${it.kind}|${it.repo_id || ''}|${it.ref}`) || null);
    }
    db.prepare('UPDATE periode SET built_at = ?, partiel = ?, partiel_detail = ? WHERE id = ?')
      .run(new Date().toISOString(), partiel, JSON.stringify(partielDetail), periodeId);
  })();
}

function creer({ depuis, jusqua, repoIds = null }) {
  const b = bornes(depuis, jusqua);
  const info = db.prepare('INSERT INTO periode (depuis, jusqua, repo_ids) VALUES (?, ?, ?)')
    .run(b.depuis, b.jusqua, Array.isArray(repoIds) && repoIds.length ? JSON.stringify(repoIds.map(Number)) : null);
  return lire(Number(info.lastInsertRowid));
}

function lire(id) {
  const p = db.prepare('SELECT * FROM periode WHERE id = ?').get(Number(id));
  if (!p) return null;
  const items = db.prepare('SELECT * FROM periode_item WHERE periode_id = ? ORDER BY at DESC, id DESC').all(p.id)
    .map((it) => { let extra = {}; try { extra = JSON.parse(it.extra || '{}'); } catch { /* illisible */ } return { ...it, extra, seen: !!it.seen_at }; });
  const repos = db.prepare('SELECT id, project, forge FROM repo').all();
  let partielDetail = {};
  try { partielDetail = JSON.parse(p.partiel_detail || '{}'); } catch { /* illisible */ }
  let repoIds = null;
  try { repoIds = p.repo_ids ? JSON.parse(p.repo_ids) : null; } catch { /* illisible */ }
  return {
    ...p, repo_ids: repoIds, partiel_detail: partielDetail, items,
    partiel_jira: partielDetail.jira ? partielDetail.jira.raisons[0] : null,
    repos: repos.map((r) => ({ ...r, partiel: partielDetail[r.id] || null })),
    unseen: items.filter((it) => !it.seen_at).length,
    days: Math.max(1, Math.round((Date.parse(p.jusqua) - Date.parse(p.depuis)) / JOUR_MS)),
  };
}

function lister(limite = 10) {
  return db.prepare('SELECT id, depuis, jusqua, built_at, partiel, job_id FROM periode ORDER BY id DESC LIMIT ?').all(limite)
    .map((p) => ({ ...p, unseen: db.prepare('SELECT COUNT(*) n FROM periode_item WHERE periode_id = ? AND seen_at IS NULL').get(p.id).n }));
}

function marquerVu(periodeId, { itemIds = null, tout = false, seen = true } = {}) {
  const valeur = seen ? new Date().toISOString() : null;
  if (tout) return db.prepare('UPDATE periode_item SET seen_at = ? WHERE periode_id = ?').run(valeur, periodeId).changes;
  const ids = (itemIds || []).map(Number).filter(Boolean);
  if (!ids.length) return 0;
  return db.prepare(`UPDATE periode_item SET seen_at = ? WHERE periode_id = ? AND id IN (${ids.map(() => '?').join(',')})`).run(valeur, periodeId, ...ids).changes;
}

function supprimer(id) { return db.prepare('DELETE FROM periode WHERE id = ?').run(Number(id)).changes; }

/* ---------- La présence, et l'absence ---------- */

/* ÉCRIT SUR UN GESTE, PAS SUR UN POLL. Un poste resté allumé avec l'onglet ouvert interroge le
   serveur toutes les cinq secondes pendant tout un congé : la bannière ne s'afficherait jamais,
   précisément là où on en a besoin. Le front n'envoie `presence` qu'après un geste réel. Au
   plus une écriture par minute. De l'état DÉRIVÉ, propre à ce poste (`local_state`) : une
   absence n'est jamais une donnée d'équipe. */
const seuilBanniere = () => {
  const seuil = Number(getConfig().periode_banner_days);
  return Number.isFinite(seuil) && seuil >= 0 ? seuil : 3;
};

function presence(maintenant = new Date()) {
  const dernier = etat.lire('absence', 'poste', 'last_seen');
  if (dernier && maintenant.getTime() - Date.parse(dernier) < 60 * 1000) return dernier;
  /* LE PREMIER GESTE DU RETOUR EFFACERAIT L'ABSENCE : cliquer sur « Notes » pour aller lire le brief
     est un geste, et la bannière n'aurait jamais le temps de s'afficher. On FIGE donc l'absence
     au moment où elle se termine — son début et son retour — jusqu'à ce que la période soit
     ouverte ou la bannière écartée. */
  const seuil = seuilBanniere();
  const depart = etat.lire('absence', 'poste', 'depart');
  if (departExplicite() && depart) {
    /* « JE PARS » : le départ est exact à la minute et ne bouge plus — un passage furtif au bureau
       ne le décale pas. Le retour se fige au premier geste au-delà du seuil. */
    if (!etat.lire('absence', 'poste', 'retour') && seuil > 0 && (maintenant.getTime() - Date.parse(depart)) / JOUR_MS >= seuil) {
      etat.ecrire('absence', 'poste', 'retour', maintenant.toISOString());
    }
  } else if (dernier && seuil > 0 && (maintenant.getTime() - Date.parse(dernier)) / JOUR_MS >= seuil) {
    etat.ecrire('absence', 'poste', 'depart', dernier);
    etat.ecrire('absence', 'poste', 'retour', maintenant.toISOString());
  }
  etat.ecrire('absence', 'poste', 'last_seen', maintenant.toISOString());
  return maintenant.toISOString();
}

const departExplicite = () => etat.lire('absence', 'poste', 'explicite') === '1';

/* « JE PARS » : l'absence commence MAINTENANT, à la minute. Un confort — la présence mesurée sur
   un geste suffit à la bannière —, mais la fenêtre est alors exacte. */
function partir(maintenant = new Date()) {
  etat.ecrire('absence', 'poste', 'depart', maintenant.toISOString());
  etat.ecrire('absence', 'poste', 'retour', null);
  etat.ecrire('absence', 'poste', 'explicite', '1');
  return absence(maintenant);
}

/* Depuis quand ce poste n'a pas vu un geste, et si ça dépasse le seuil (Réglages → Général).
   Une absence FIGÉE (début, retour) prime tant qu'elle n'a pas été écartée ; sinon l'écart depuis
   le dernier geste — le cas de l'atterrissage, avant tout clic. */
function absence(maintenant = new Date()) {
  const jours = seuilBanniere();
  const dernier = etat.lire('absence', 'poste', 'last_seen');
  const depart = etat.lire('absence', 'poste', 'depart');
  const retour = etat.lire('absence', 'poste', 'retour');
  if (departExplicite() && depart) {
    const fin = retour ? Date.parse(retour) : maintenant.getTime();
    const ecart = Math.max(0, (fin - Date.parse(depart)) / JOUR_MS);
    return { last_seen: depart, depart, days: Math.floor(ecart), threshold: jours, banner: jours > 0 && ecart >= jours, frozen: !!retour, explicit: true };
  }
  if (depart && retour && jours > 0 && (maintenant.getTime() - Date.parse(retour)) < 7 * JOUR_MS) {
    const ecart = (Date.parse(retour) - Date.parse(depart)) / JOUR_MS;
    if (ecart >= jours) return { last_seen: depart, days: Math.floor(ecart), threshold: jours, banner: true, frozen: true };
  }
  const ecart = dernier ? (maintenant.getTime() - Date.parse(dernier)) / JOUR_MS : null;
  return {
    last_seen: dernier || null,
    days: ecart == null ? null : Math.floor(ecart),
    threshold: jours,
    banner: !!(dernier && jours > 0 && ecart >= jours),
    frozen: false,
    explicit: false,
  };
}

/* La bannière a servi (période ouverte) ou a été écartée : l'absence figée s'oublie. */
function ecarterAbsence() {
  etat.ecrire('absence', 'poste', 'depart', null);
  etat.ecrire('absence', 'poste', 'retour', null);
  etat.ecrire('absence', 'poste', 'explicite', null);
}

module.exports = { construire, enregistrer, creer, lire, lister, marquerVu, supprimer, presence, absence, partir, ecarterAbsence, bornes, faitParLEquipe, upsertMr };
