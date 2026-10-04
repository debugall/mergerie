'use strict';
/* Les plugins : la liste, activer/désactiver à chaud, rescanner, installer, désinstaller, les
   réglages d'un plugin, ce que le navigateur en affiche — et la PORTE de leurs routes
   (`/api/plugins/<nom>/…`) et de leurs fichiers (`/plugins/<nom>/…`), relus à chaque requête :
   un plugin désactivé ne répond plus, sans redémarrage. Du HTTP et rien d'autre. */
const path = require('path');
const fs = require('fs');
const express = require('express');
const { app } = require('../app');
const { wrap } = require('../http');
const plugins = require('../../plugins');
const i18n = require('../../core/i18n');
const { t } = i18n;

const NOM = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const exigerNom = (nom) => { if (!NOM.test(String(nom || ''))) { const e = new Error(t('err.plugins.nom-invalide')); e.status = 400; throw e; } return String(nom); };

app.get('/api/plugins', wrap((req, res) => { res.json({ plugins: plugins.liste() }); }));
app.get('/api/plugins/ui', wrap((req, res) => { res.json(plugins.uiPourNavigateur()); }));
app.post('/api/plugins/rescan', wrap((req, res) => { res.json({ plugins: plugins.decouvrir() }); }));
app.post('/api/plugins/install', wrap(async (req, res) => {
  const b = req.body || {};
  const f = b.url ? await plugins.installerDepuisGit(b.url, b.ref) : plugins.installerDepuisDossier(b.path);
  /* Un plugin dont l'état persisté dit déjà « activé » — un poste monté de version dont l'onglet (Docker, Jenkins, Liens…) est devenu un plugin tiers — s'active
     À L'INSTALLATION : sinon il resterait « en erreur » jusqu'au redémarrage, et les données qu'il retrouve seraient là sans l'écran qui les montre. */
  if (f && f.enabled && f.valide && !f.actif) await plugins.activer(f.nom);
  res.json({ ok: true, name: f && f.nom, plugins: plugins.liste() });
}));

/* Les actions sur UN plugin : des chemins littéraux, déclarés AVANT la porte `/api/plugins/:name/*`. */
app.post('/api/plugins/:name/update', wrap(async (req, res) => {
  const r = await plugins.mettreAJour(exigerNom(req.params.name));
  res.json({ ok: true, name: r.fiche.nom, from: r.from, to: r.to, wasActive: r.wasActive, active: !!r.fiche.actif, error: r.fiche.error || null, plugins: plugins.liste() });
}));
app.post('/api/plugins/:name/enable', wrap(async (req, res) => {
  const nom = exigerNom(req.params.name);
  const f = await plugins.activer(nom);
  res.json({ ok: !!f.actif, state: f.actif ? 'active' : 'error', error: f.error || null, plugins: plugins.liste() });
}));
app.post('/api/plugins/:name/disable', wrap(async (req, res) => {
  await plugins.desactiver(exigerNom(req.params.name));
  res.json({ ok: true, plugins: plugins.liste() });
}));
app.post('/api/plugins/:name/uninstall', wrap(async (req, res) => {
  const r = await plugins.desinstaller(exigerNom(req.params.name), { garderDonnees: !(req.body && req.body.deleteData) });
  res.json({ ...r, plugins: plugins.liste() });
}));
app.get('/api/plugins/:name/settings', wrap((req, res) => { res.json(plugins.reglagesPourEcran(exigerNom(req.params.name))); }));
/* « Copier » un secret du plugin (un bouton de son écran) : la valeur n'est rendue que si son schéma le déclare `x-secret`. Pas de cache. */
app.post('/api/plugins/:name/secret', wrap((req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ value: plugins.lireSecretPourCopie(exigerNom(req.params.name), String((req.body && req.body.key) || '')) });
}));
app.put('/api/plugins/:name/settings', wrap((req, res) => { res.json(plugins.ecrireReglages(exigerNom(req.params.name), req.body || {})); }));

/* ---------- LA PORTE DES ROUTES D'UN PLUGIN ----------
   Un routeur Express par plugin actif, reconstruit quand ses routes changent (activation), et
   choisi À CHAQUE requête : désactivé, le plugin rend 404 « plugin inactif ». Le handler du
   plugin reçoit une requête SIMPLE (méthode, chemin, query, params, corps, en-têtes, langue) et
   un `reply` ; ce qu'il rend part en JSON, ce qu'il lève devient `{ error }` avec son statut. */
const routeurs = new Map();   // nom → { signature, router, source }
function routeurDe(nom) {
  const r = plugins.routesDe(nom);
  if (!r) return null;
  const signature = r.routes.map((x) => `${x.method} ${x.path}`).concat(r.sse.map((x) => `SSE ${x.path}`)).join('\n');
  const deja = routeurs.get(nom);
  if (deja && deja.signature === signature && deja.source === r.source) return deja.router;
  const router = express.Router();
  for (const { method, path: chemin, handler } of r.routes) {
    router[method.toLowerCase()](chemin, (req, res) => {
      const requete = { method: req.method, path: req.path, url: req.originalUrl, query: req.query, params: req.params, body: req.body, headers: req.headers, lang: i18n.getLang() };
      let statut = 200; let envoye = false;
      const reply = {
        status: (n) => { statut = n; return reply; },
        header: (k, v) => { res.setHeader(k, v); return reply; },
        json: (b, s) => { if (!envoye) { envoye = true; res.status(s || statut).json(b); } return reply; },
        text: (s, st) => { if (!envoye) { envoye = true; res.status(st || statut).type('text/plain').send(String(s)); } return reply; },
      };
      Promise.resolve().then(() => handler(requete, reply)).then((valeur) => {
        if (envoye) return;
        if (valeur === undefined || valeur === reply) { if (!res.headersSent) res.status(statut).json({ ok: true }); return; }
        res.status(statut).json(valeur);
      }).catch((e) => {
        if (res.headersSent) return;
        const st = e && e.code === 'BUSY' ? 409 : (Number.isInteger(e && e.status) && e.status >= 400 && e.status < 600 ? e.status : 400);
        res.status(st).json({ error: (e && e.message) || String(e), ...(e && e.code ? { code: e.code } : {}) });
      });
    });
  }
  for (const { path: chemin, producer } of r.sse) {
    router.get(chemin, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      let ferme = false;
      const send = (event, data) => { if (ferme) return; res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      const close = () => { if (ferme) return; ferme = true; try { res.end(); } catch { /* déjà fermé */ } };
      let nettoyage = () => {};
      try { nettoyage = producer({ query: req.query, params: req.params, headers: req.headers }, send, close) || (() => {}); }
      catch (e) { send('error', { error: e.message }); close(); return; }
      req.on('close', () => { ferme = true; try { nettoyage(); } catch { /* best-effort */ } });
    });
  }
  routeurs.set(nom, { signature, router, source: r.source });
  return router;
}
app.use('/api/plugins/:name', (req, res, next) => {
  if (!NOM.test(String(req.params.name || ''))) return next();
  const router = routeurDe(req.params.name);
  if (!router) return res.status(404).json({ error: t('err.plugins.inactif', { name: req.params.name }), code: 'PLUGIN_INACTIVE' });
  return router(req, res, next);
});

/* ---------- LES FICHIERS D'UN PLUGIN ACTIF : son bundle, ses feuilles, ses dictionnaires ---------- */
app.get('/plugins/:name/bundle.js', (req, res, next) => {
  if (!NOM.test(String(req.params.name || ''))) return next();
  const b = plugins.bundle(req.params.name);
  if (b == null) return res.status(404).type('text/plain').send('plugin inactif');
  res.setHeader('Cache-Control', 'no-cache');
  return res.type('application/javascript').send(b);
});
app.use('/plugins/:name/ui', (req, res, next) => {
  if (!NOM.test(String(req.params.name || ''))) return next();
  const f = plugins.fiche(req.params.name);
  if (!f || !f.actif) return res.status(404).type('text/plain').send('plugin inactif');
  const dir = path.join(f.dir, 'ui');
  if (!fs.existsSync(dir)) return next();
  return express.static(dir, { index: false, setHeaders: (r) => r.setHeader('Cache-Control', 'no-cache') })(req, res, next);
});

/* Pour les tests : le routeur mis en cache d'un plugin. */
module.exports = { routeurDe };
