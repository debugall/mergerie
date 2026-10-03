'use strict';
/* Les routes du plugin, montées sous /api/plugins/jenkins/ : voir et lancer des jobs, tester la
   connexion, lier un job à un dépôt. Rien n'est sondé : l'écran demande, on demande à Jenkins.
   Les corps sont ceux des anciennes routes du cœur, au mot près — seule la porte change. */

function monterRoutes(ctx, { client, demo, veille, cfg }) {
  const { router } = ctx.http;
  const t = (k, p) => ctx.i18n.t(k, p);
  const erreur = (message, status = 400) => Object.assign(new Error(message), { status });
  const estDemo = () => ctx.demo.isDemo();

  router.get('/jobs', async () => {
    if (estDemo()) return { configured: true, jobs: demo.lister() };
    const c = cfg();
    if (!client.isConfigured(c)) return { configured: false, jobs: [] };
    return { configured: true, jobs: await client.lister(c) };
  });
  router.get('/job', async (req) => {
    const chemin = String(req.query.path || '').trim();
    if (!chemin) throw erreur(t('jenkins.err.path-required'));
    if (estDemo()) return demo.detail(chemin, req.query.builds);
    // `builds` : profondeur d'historique demandée par l'écran (bornée côté client Jenkins).
    return client.detail(cfg(), chemin, req.query.builds);
  });
  /* Lancer : le seul geste qui ÉCRIT chez Jenkins, donc un POST explicite. Les paramètres
     arrivent tels que l'écran les a lus du job — on ne les invente pas, et un job sans
     paramètre part sans corps. */
  router.post('/build', async (req) => {
    const chemin = String((req.body && req.body.path) || '').trim();
    if (!chemin) throw erreur(t('jenkins.err.path-required'));
    const params = (req.body && req.body.parameters) || {};
    if (estDemo()) return demo.lancer(chemin, params);
    const r = await client.lancer(cfg(), chemin, params);
    /* ET ON NOTE QU'ON L'ATTEND. `since` est le numéro du dernier build connu de l'écran au
       moment du clic ; sans lui (appel direct à l'API), on le demande à Jenkins, parce qu'une
       attente qui part de zéro prendrait le build PRÉCÉDENT pour le nôtre. */
    let since = Number(req.body && req.body.since);
    if (!Number.isFinite(since)) {
      try { since = ((await client.detail(cfg(), chemin, 1)).builds[0] || {}).number || 0; }
      catch { since = 0; }
    }
    veille.attendreJenkins(chemin, since);
    ctx.events.emit('jenkins.job.started', { path: chemin, since, parameters: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v == null ? '' : v)])) }).catch(() => {});
    return r;
  });
  router.get('/console', async (req) => {
    const chemin = String(req.query.path || '').trim();
    if (!chemin) throw erreur(t('jenkins.err.path-required'));
    if (estDemo()) return demo.console();
    return client.console(cfg(), chemin, req.query.build);
  });
  /* Test de connexion — même contrat que « Tester Jira » : le masque signifie « garde le jeton ».
     Le jeton enregistré ne part pas vers une autre adresse : adresse changée (autre origine) ⇒
     le jeton doit être retapé dans la même requête. Le résultat est NOTÉ, avec sa date : un
     souvenir de geste, jamais une surveillance. */
  router.post('/test', async (req) => {
    if (estDemo()) return demo.tester();
    const test = { ...cfg() };
    const b = req.body || {};
    if (b.jenkins_url && ctx.secrets.freshRequired(b.jenkins_url, test.jenkins_url, b.jenkins_token, test.jenkins_token)) throw erreur(t('jenkins.err.fresh-token'));
    if (b.jenkins_url) test.jenkins_url = String(b.jenkins_url).replace(/\/+$/, '');
    if (b.jenkins_user) test.jenkins_user = b.jenkins_user;
    if (b.jenkins_token && b.jenkins_token !== '***') test.jenkins_token = b.jenkins_token;
    if (!client.isConfigured(test)) throw erreur(t('jenkins.err.not-configured'));
    const noter = (ok, detail) => { try { ctx.settings.set({ last_test: JSON.stringify({ ok, detail: String(detail || '').slice(0, 200), tested_at: new Date().toISOString() }) }); } catch { /* trace best-effort */ } };
    try {
      const r = await client.tester(test);
      noter(true, `${r.user || ''} · ${r.jobs || 0}`);
      return r;
    } catch (e) { noter(false, e.message); throw e; }
  });
  /* Ce que l'écran des réglages relit à l'ouverture : la connexion est-elle renseignée, et
     qu'a donné le dernier test. */
  router.get('/status', () => {
    const c = cfg();
    let dernier = null;
    try { dernier = c.last_test ? JSON.parse(c.last_test) : null; } catch { dernier = null; }
    return { configured: estDemo() || client.isConfigured(c), lastTest: dernier, refreshMinutes: Number(c.jenkins_refresh_minutes) || 0 };
  });

  /* ---------- B8 : les jobs liés à un dépôt ----------
     Déclaré une fois dans Réglages → Jenkins, comme service ↔ dépôt dans Liens. Rien n'est
     lancé ici : ces routes ne font que tenir la liste. */
  /* B10 — LES LIENS D'UN BUILD : pour un dépôt lié, les adresses de son service par
     environnement — la même résolution que sur une merge request, demandée au cœur par un
     service nommé (Liens est un onglet du cœur aujourd'hui, un plugin demain : la porte est la même). */
  router.get('/build-links', async (req) => {
    const chemin = String(req.query.path || '').trim();
    if (!chemin) return { envs: [] };
    const lien = ctx.db.prepare('SELECT repo_id FROM plugin_jenkins_link WHERE job_path = ? LIMIT 1').get(chemin);
    if (!lien || !ctx.services.has('links.forRepo')) return { envs: [] };
    const d = await ctx.services.call('links.forRepo', { repo_id: lien.repo_id });
    return { envs: (d && d.envs) || [] };
  });
  router.get('/links', () => {
    const projets = Object.fromEntries(ctx.repos.list().map((r) => [r.id, r.project]));
    return {
      links: ctx.db.prepare('SELECT * FROM plugin_jenkins_link ORDER BY repo_id, job_path').all()
        .filter((l) => projets[l.repo_id])
        .map((l) => ({ ...l, project: projets[l.repo_id] }))
        .sort((a, b) => a.project.localeCompare(b.project) || a.job_path.localeCompare(b.job_path)),
    };
  });
  router.post('/links', (req) => {
    const repoId = Number((req.body && req.body.repo_id) || 0);
    const job = String((req.body && req.body.job_path) || '').trim();
    if (!repoId || !ctx.repos.byId(repoId)) throw erreur(t('jenkins.err.repo-not-found'));
    if (!job) throw erreur(t('jenkins.err.job-required'));
    ctx.db.prepare('INSERT OR REPLACE INTO plugin_jenkins_link (repo_id, job_path, param) VALUES (?,?,?)')
      .run(repoId, job, String((req.body && req.body.param) || '').trim() || null);
    return { ok: true };
  });
  router.delete('/links/:id', (req) => {
    ctx.db.prepare('DELETE FROM plugin_jenkins_link WHERE id = ?').run(Number(req.params.id) || 0);
    return { ok: true };
  });
}

module.exports = { monterRoutes };
