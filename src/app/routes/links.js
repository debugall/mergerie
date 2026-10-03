'use strict';
/* Les liens : la grille, les environnements, les services et leurs adresses, les liens libres, le lanceur, l’import.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const jira = require('../../integrations/jira');
const links = require('../../notes/links');
const demoMode = require('../../demo/mode');
const plugins = require('../../plugins');
const db = require('../../db');
const verifyLib = require('../../verify/verify');
const { origineDuDossier } = require('../../git/origine-dossier');
const { mrById, wrap } = require('../http');

/* ---------- Liens (plan_add_links.md) --------------------------------------
   Une grille services × environnements, des liens libres tagués et une palette globale.
   Toutes les URLs sont validées `http(s)` par src/links.js : elles sont ouvertes d'un clic
   depuis l'application, et l'outil ne s'y connecte JAMAIS de lui-même — surveiller des
   services n'est pas son travail. */

const msgLinks = () => ({
  nomVide: t('err.links.name-required'),
  nomPris: t('err.links.name-taken'),
  labelVide: t('err.links.label-required'),
  urlInvalide: t('err.links.url-invalid'),
  templateVide: t('err.links.template-invalid'),
  variableInconnue: (nom, valides) => t('err.links.template-variable', { name: nom, list: valides.map((v) => `{${v}}`).join(', ') }),
  tropDeTags: t('err.links.too-many-tags'),
  inconnu: t('err.links.unknown'),
  envInconnu: t('err.links.env-unknown'),
  tropGros: t('err.links.import-too-big'),
});
app.get('/api/links/grid', wrap((req, res) => { res.json(links.grille()); }));
app.get('/api/environments', wrap((req, res) => { res.json({ environments: links.listerEnvironnements() }); }));
app.post('/api/environments', wrap((req, res) => { res.json(links.creerEnvironnement(req.body || {}, msgLinks())); }));
app.put('/api/environments/:id', wrap((req, res) => { res.json(links.majEnvironnement(req.params.id, req.body || {}, msgLinks())); }));
app.delete('/api/environments/:id', wrap((req, res) => { res.json(links.supprimerEnvironnement(req.params.id, msgLinks())); }));
/* Déplacer une colonne d'un cran. Un POST et non un PUT de `position` : le client n'a pas à
   savoir quelles positions portent les voisines, il dit seulement de quel côté aller. */
app.post('/api/environments/:id/move', wrap((req, res) => {
  res.json(links.deplacerEnvironnement(req.params.id, (req.body || {}).dir, msgLinks()));
}));
/* L'ORDRE ENTIER, en un appel : c'est ce que produit un glisser-déposer. Les flèches restent
   pour le clavier, et parlent au même stockage. */
app.post('/api/environments/reorder', wrap((req, res) => {
  res.json(links.reordonnerEnvironnements((req.body || {}).ids));
}));
app.post('/api/services/reorder', wrap((req, res) => {
  res.json(links.reordonnerServices((req.body || {}).ids));
}));
app.post('/api/services', wrap((req, res) => { res.json(links.creerService(req.body || {}, msgLinks())); }));
app.put('/api/services/:id', wrap((req, res) => { res.json(links.majService(req.params.id, req.body || {}, msgLinks())); }));
app.delete('/api/services/:id', wrap((req, res) => { res.json(links.supprimerService(req.params.id, msgLinks())); }));
// Poser (ou vider) la case d'un environnement pour ce service.
app.put('/api/services/:id/urls', wrap((req, res) => { res.json(links.poserUrl(req.params.id, req.body || {}, msgLinks())); }));
app.get('/api/services/:id/context-links', wrap((req, res) => { res.json({ links: links.listerContextLinks(req.params.id) }); }));
app.post('/api/services/:id/context-links', wrap((req, res) => { res.json(links.creerContextLink(req.params.id, req.body || {}, msgLinks())); }));
app.delete('/api/context-links/:id', wrap((req, res) => { res.json(links.supprimerContextLink(req.params.id, msgLinks())); }));
app.get('/api/free-links', wrap((req, res) => { res.json({ links: links.listerFreeLinks(req.query) }); }));
app.post('/api/free-links', wrap((req, res) => { res.json(links.creerFreeLink(req.body || {}, msgLinks())); }));
app.put('/api/free-links/:id', wrap((req, res) => { res.json(links.majFreeLink(req.params.id, req.body || {}, msgLinks())); }));
app.delete('/api/free-links/:id', wrap((req, res) => { res.json(links.supprimerFreeLink(req.params.id, msgLinks())); }));
/* Déclarée APRÈS `/:id` — sans quoi Express ferait correspondre « /api/free-links » à la route
   paramétrée sur certaines formes d'URL, et « tout supprimer » deviendrait un cas particulier
   de « supprimer celui-là ». */
app.delete('/api/free-links', wrap((req, res) => { res.json(links.supprimerTousFreeLinks()); }));
// Des liens libres deviennent un service : le geste d'APRÈS l'import, explicite.
app.post('/api/free-links/to-service', wrap((req, res) => { res.json(links.rangerDansService(req.body || {}, msgLinks())); }));
/* La palette. Les actions de navigation viennent du CLIENT : lui seul sait ce qu'il sait
   faire, et les lister côté serveur aurait fait deux endroits à tenir d'accord. */
/* LES ADRESSES D'UN DÉPÔT, pour les plugins (un job de CI lié à un dépôt veut savoir où le
   service est déployé) : la même résolution que sur une merge request, sans `{branch}`. Un
   service nommé — Liens est un onglet du cœur aujourd'hui, un plugin demain, la porte est la même. */
plugins.services.register('links.forRepo', ({ repo_id }) => ({ envs: (links.liensDeMr({ repo_id: Number(repo_id) }) || {}).envs || [] }));

app.post('/api/launcher', wrap(async (req, res) => {
  const body = req.body || {};
  /* Les entrées des plugins actifs (calculées sans réseau) — sur une REQUÊTE seulement : à vide,
     la palette montre ses trois sections (actions, merge requests, sessions récentes), rien d'autre. */
  const desPlugins = String(body.q || '').trim() ? await plugins.palette(body.q, 30) : [];
  const results = links.launcher(body.q, {
      jiraConfigure: demoMode.isDemo() || jira.isConfigured(getConfig()),
      actions: Array.isArray(body.actions) ? body.actions.slice(0, 60) : [],
      // Les libellés d'agent sont traduits ICI : `links.js` ne charge pas le dictionnaire.
      agentsMsgs: { ask: t('agents.palette.ask', { name: '{name}' }), investigate: t('agents.palette.investigate') },
      msgs: {
        verify: t('palette.act.verify', { name: '{name}' }),
        gitcmd: t('palette.act.gitcmd', { label: '{label}' }),
      },
    });
  /* Les entrées des plugins rejoignent la section « actions » du cœur, à sa suite — pas une
     section de plus en fin de liste : l'écran titre chaque groupe contigu. */
  const dernier = results.map((r) => r.group).lastIndexOf('actions');
  if (dernier === -1) results.push(...desPlugins); else results.splice(dernier + 1, 0, ...desPlugins);
  res.json({ results });
}));
app.post('/api/launcher/used', wrap((req, res) => {
  const b = req.body || {};
  res.json(links.noterUsage(b.kind, b.ref));
}));
/* Import de marque-pages : APERÇU d'abord (on ne crée rien), application ensuite. Même
   esprit que l'aperçu obligatoire des opérations git — on voit avant d'exécuter. */
/* L'aperçu rend AUSSI ce que l'arbre laisse deviner : un dossier dont plusieurs enfants portent
   des noms d'environnement décrit une grille. Rien n'est créé — c'est une proposition, montrée
   avant de l'appliquer et refusable d'un clic. */
app.post('/api/links/import', wrap((req, res) => {
  const l = links.parserBookmarks((req.body || {}).html, msgLinks());
  res.json({ links: l, proposal: links.analyserArbre(l) });
}));
app.post('/api/links/import/apply', wrap((req, res) => {
  res.json(links.appliquerImport(req.body || {}, msgLinks()));
}));
/* COLLER DES ADRESSES : analyse d'abord (on ne crée rien, on propose), application ensuite —
   exactement comme l'import de marque-pages. La proposition est faite pour être corrigée à
   l'écran : c'est le client qui renvoie ce qu'il a confirmé, pas le serveur qui décide. */
app.post('/api/links/paste/analyse', wrap((req, res) => {
  res.json({ items: links.analyserCollage((req.body || {}).text) });
}));
app.post('/api/links/paste', wrap((req, res) => {
  res.json(links.appliquerCollage(req.body || {}, msgLinks()));
}));
// Les boutons contextuels d'une merge request : URLs de grille du service + gabarits résolus.
app.get('/api/mrs/:id/links', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw Object.assign(new Error(t('err.links.unknown')), { status: 404 });
  res.json(links.liensDeMr(mr));
}));

/* B8 — LA CASE « LOCAL » QUE LE COMPOSE CONNAÎT DÉJÀ. On ajoute `webapp-front` à la grille et on tape `localhost:3000` — que le projet compose affiché
   juste à côté (plugin Docker) sait déjà, puisqu'il publie ce port. On relie le dossier à son dépôt par le remote lu dans `.git/config`, le dépôt à son
   service dans la grille, et on rend l'environnement « local » où poser l'adresse. Rien n'est écrit sans clic : on PROPOSE, la grille reste la vérité. */
app.get('/api/links/local-suggestion', wrap((req, res) => {
  const dir = String(req.query.dir || '').trim();
  if (!dir) return res.json({ service: null, ports: [] });
  const remote = origineDuDossier(dir);
  if (!remote) return res.json({ service: null, ports: [] });
  const cible = db.prepare('SELECT id, project, url FROM repo').all().find((r) => verifyLib.memeDepot(r.url, remote));
  if (!cible) return res.json({ service: null, ports: [] });
  const service = db.prepare('SELECT id, name FROM service WHERE repo_id = ? ORDER BY id LIMIT 1').get(cible.id);
  if (!service) return res.json({ service: null, ports: [] });
  /* L'environnement « local » de la grille, s'il existe : c'est celui que le compose renseigne. Sans lui, il n'y a pas de case à remplir — et en créer un
     d'office réarrangerait la grille de quelqu'un sans qu'il l'ait demandé. */
  const env = db.prepare("SELECT id, name FROM environment WHERE LOWER(name) IN ('local','localhost') ORDER BY id LIMIT 1").get();
  const dejaLa = env ? db.prepare('SELECT COUNT(*) c FROM service_url WHERE service_id = ? AND environment_id = ?').get(service.id, env.id).c : 0;
  res.json({ service: { id: service.id, name: service.name, project: cible.project }, environment: env || null, filled: !!dejaLa });
}));
