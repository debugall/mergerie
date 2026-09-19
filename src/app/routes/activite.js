'use strict';
/* L’activité par projet sur six mois (onglet Statistiques) : commits et contributeurs relevés dans les clones, mémorisés par mois.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const { pMap } = require('../../core/pmap');
const forge = require('../../forge');
const demoDocker = require('../../demo/docker');
const { repoById, wrap } = require('../http');
const { auteurs } = require('../lib/partage');

/* ---------- Activité par projet sur 6 mois (onglet Statistiques) ----------

   Question posée : « quels dépôts sont vivants, lesquels dorment ? ». Le nombre de commits
   n'y répond qu'imparfaitement — un projet qui squash en fait un par merge request, un autre
   quarante pour le même travail —, donc l'écran compare les FORMES dans le temps, projet par
   projet, et non les hauteurs entre projets. Les contributeurs distincts complètent : cinquante
   commits d'une seule personne ne disent pas la même chose que cinquante de six.

   Le coût est réel (pagination de la forge), d'où le cache par mois : un mois clos ne change
   plus, seul le mois courant est rafraîchi. */
const TTL_MOIS_COURANT_MS = 30 * 60 * 1000;
/* Un dépôt tenu par un robot n'est pas un dépôt vivant. Dependabot ou Renovate y poussent
   chaque semaine : sans ce filtre, un projet abandonné garderait quatre jours d'activité par
   mois et ne serait JAMAIS signalé endormi — exactement le faux positif que le graphe existe
   pour éviter. On écarte donc leurs commits du compte, jours comme contributeurs.
   `noreply@github.com` n'est PAS un motif : les commits faits depuis l'interface web de
   GitHub par de vrais humains le portent aussi. */
const MOTIFS_BOT = [/\[bot\]/i, /\bdependabot\b/i, /\brenovate\b/i, /\bgithub-actions\b/i, /\bmergify\b/i];
const estBot = (auteur) => MOTIFS_BOT.some((re) => re.test(String(auteur || '')));
// Les 6 derniers mois, du plus ancien au plus récent, en 'YYYY-MM'.
function derniersMois(n = 6, maintenant = new Date()) {
  const out = [];
  const d = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
const debutDuMois = (mois) => `${mois}-01T00:00:00.000Z`;
const finDuMois = (mois) => {
  const [a, m] = mois.split('-').map(Number);
  return new Date(Date.UTC(m === 12 ? a + 1 : a, m === 12 ? 0 : m, 1)).toISOString();
};
/* Remplit le cache d'un dépôt pour les mois manquants ou périmés. Un seul appel forge pour
   toute la plage manquante : demander mois par mois multiplierait les requêtes par six. */
/* Deux vues peuvent demander le même dépôt en même temps — la vue d'ensemble et la fenêtre
   de détail, ou simplement deux onglets. Sans garde, les deux paginent la forge en parallèle
   pour écrire la même chose. La promesse en cours est donc partagée. */
const activiteEnVol = new Map();
function majActiviteDepot(cfg, repo, mois) {
  const cle = `${repo.id}:${mois[0]}:${mois[mois.length - 1]}`;
  const enVol = activiteEnVol.get(cle);
  if (enVol) return enVol;
  const p = majActiviteDepotVrai(cfg, repo, mois).finally(() => activiteEnVol.delete(cle));
  activiteEnVol.set(cle, p);
  return p;
}
async function majActiviteDepotVrai(cfg, repo, mois) {
  const enCache = new Map(db.prepare('SELECT * FROM commit_activity WHERE repo_id = ?').all(repo.id).map((r) => [r.month, r]));
  const courant = mois[mois.length - 1];
  const now = Date.now();
  const aRefaire = mois.filter((m) => {
    const l = enCache.get(m);
    if (!l) return true;
    // Seul le mois en cours peut encore bouger : les autres sont définitifs.
    return m === courant && (now - Date.parse(l.fetched_at || 0)) > TTL_MOIS_COURANT_MS;
  });
  if (!aRefaire.length) return;

  const depuis = debutDuMois(aRefaire[0]);
  const jusqua = finDuMois(aRefaire[aRefaire.length - 1]);
  const { commits, partiel } = await forge.clientFor(repo).commitsBetween(cfg, repo.project, depuis, jusqua);

  const parMois = new Map(aRefaire.map((m) => [m, { n: 0, auteurs: new Set(), jours: new Set() }]));
  for (const c of commits) {
    if (!c.date) continue;
    if (estBot(c.author)) continue;           // cf. MOTIFS_BOT : un robot ne rend pas un dépôt vivant
    /* Les dates de la forge portent un DÉCALAGE local (`…T01:00:00+02:00`), alors que les
       bornes `since`/`until` sont en UTC. Découper la chaîne rangeait donc un commit du 1er
       à 1 h du matin dans le mois suivant celui où l'API l'avait renvoyé : il ne trouvait
       aucun seau et disparaissait sans un mot. On normalise en UTC, à la même échelle que
       les bornes. Conséquence assumée : une « journée » est une journée UTC. */
    const d = new Date(c.date);
    if (Number.isNaN(d.getTime())) continue;
    const iso = d.toISOString();
    const agg = parMois.get(iso.slice(0, 7));
    if (!agg) continue;                       // hors plage demandée : les bornes de l'API sont inclusives
    agg.n += 1;
    agg.jours.add(iso.slice(0, 10));          // une journée de travail, pas un commit de plus
    if (c.author) agg.auteurs.add(String(c.author).toLowerCase());
  }
  const ins = db.prepare(`INSERT INTO commit_activity (repo_id, month, commits, authors, active_days, partiel, fetched_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(repo_id, month) DO UPDATE SET
      commits = excluded.commits, authors = excluded.authors, active_days = excluded.active_days,
      partiel = excluded.partiel, fetched_at = excluded.fetched_at`);
  const at = new Date().toISOString();
  for (const [m, agg] of parMois) ins.run(repo.id, m, agg.n, agg.auteurs.size, agg.jours.size, partiel ? 1 : 0, at);
}
app.get('/api/dashboard/activity', wrap(async (req, res) => {
  const cfg = getConfig();
  const mois = derniersMois(6);
  /* En démo, l'activité est SEMÉE en base : on la lit telle quelle sans appeler de forge —
     il n'y en a pas, et l'écran doit montrer quelque chose de parlant. */
  const demo = demoDocker.isDemo();
  if (!demo && !forge.isConfigured(cfg, 'gitlab') && !forge.isConfigured(cfg, 'github')) {
    return res.json({ configured: false, months: mois, projects: [] });
  }
  // Mêmes dépôts que le classement d'activité récente : actifs ET dont on suit les MR.
  const repos = db.prepare('SELECT * FROM repo WHERE enabled = 1 AND IFNULL(fetch_mrs, 1) = 1 ORDER BY project').all();
  /* Les dépôts sont traités EN PARALLÈLE, quatre à la fois. En série, vingt dépôts de quelques
     pages chacun additionnent leurs allers-retours réseau : l'écran reste sur son squelette
     pendant des dizaines de secondes au premier chargement. Quatre, et pas davantage, parce
     qu'une forge répond aux rafales par un 429. */
  const projets = await pMap(repos, 4, async (repo) => {
    let erreur = null;
    // Best-effort, dépôt par dépôt : une forge injoignable ne doit pas vider tout l'écran.
    if (!demo) {
      try { await majActiviteDepot(cfg, repo, mois); }
      catch (e) { erreur = String(e.message).slice(0, 200); }
    }
    const lignes = new Map(db.prepare('SELECT * FROM commit_activity WHERE repo_id = ?').all(repo.id).map((r) => [r.month, r]));
    const counts = mois.map((m) => (lignes.get(m) || {}).commits || 0);
    const authors = mois.map((m) => (lignes.get(m) || {}).authors || 0);
    const days = mois.map((m) => (lignes.get(m) || {}).active_days || 0);
    return {
      repo_id: repo.id,
      project: repo.project,
      forge: repo.forge,
      counts,
      authors,
      days,
      total: counts.reduce((a, b) => a + b, 0),
      // Ce que la barre mesure : des journées travaillées, pas des commits.
      totalDays: days.reduce((a, b) => a + b, 0),
      // Contributeurs du mois le plus fourni : un maximum est plus parlant qu'une somme,
      // qui compterait la même personne six fois.
      contributeurs: Math.max(0, ...authors),
      partiel: mois.some((m) => (lignes.get(m) || {}).partiel),
      erreur,
    };
  });
  // Le plus actif d'abord : l'écran répond à « qui bouge ? », pas à l'ordre alphabétique.
  projets.sort((a, b) => b.totalDays - a.totalDays || b.total - a.total || a.project.localeCompare(b.project));
  res.json({ configured: true, months: mois, projects: projets });
}));
/* Détail d'UN dépôt sur douze mois. Le graphe d'ensemble en montre six — assez pour dire qui
   bouge —, mais juger d'une tendance demande de voir l'année : un projet calme depuis deux
   mois après dix mois soutenus ne raconte pas la même histoire qu'un projet éteint depuis un an.
   Même cache que la vue d'ensemble : les six premiers mois sont souvent déjà chargés. */
app.get('/api/dashboard/activity/:repoId', wrap(async (req, res) => {
  const repo = repoById(Number(req.params.repoId));
  if (!repo) throw new Error(t('err.projet-inconnu'));
  const cfg = getConfig();
  const mois = derniersMois(12);
  const demo = demoDocker.isDemo();
  let erreur = null;
  if (!demo) {
    try { await majActiviteDepot(cfg, repo, mois); }
    catch (e) { erreur = String(e.message).slice(0, 200); }
  }
  const lignes = new Map(db.prepare('SELECT * FROM commit_activity WHERE repo_id = ?').all(repo.id).map((r) => [r.month, r]));
  const counts = mois.map((m) => (lignes.get(m) || {}).commits || 0);
  const days = mois.map((m) => (lignes.get(m) || {}).active_days || 0);
  const authors = mois.map((m) => (lignes.get(m) || {}).authors || 0);
  res.json({
    project: repo.project,
    forge: repo.forge,
    months: mois,
    counts,
    days,
    authors,
    total: counts.reduce((a, b) => a + b, 0),
    totalDays: days.reduce((a, b) => a + b, 0),
    contributeurs: Math.max(0, ...authors),
    /* Le mois le plus fourni et le dernier mois actif : deux repères qu'on cherche à l'œil
       sur un graphe et qu'il vaut mieux nommer. `null` quand il n'y a RIEN : sans ce test,
       `indexOf(0)` désignait le premier mois, et un dépôt sans une ligne de l'année affichait
       fièrement son « mois le plus actif ». */
    meilleurMois: Math.max(0, ...days) > 0 ? mois[days.indexOf(Math.max(...days))] : null,
    dernierActif: [...mois].reverse().find((m, i) => days[days.length - 1 - i] > 0) || null,
    partiel: mois.some((m) => (lignes.get(m) || {}).partiel),
    erreur,
  });
}));
