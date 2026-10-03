'use strict';
/* Jenkins Teams Notify — publie un message dans un canal Teams quand un job Jenkins démarre ou se termine.
   Tout passe par le ctx (docs/plugins/API.md) : ce plugin n'importe RIEN de Mergerie. Il n'écoute que
   `jenkins.job.started` et `jenkins.job.finished` ; l'unique autre contact avec le plugin Jenkins est
   la PRÉSENCE du service `jenkins.status` (pour dire « Jenkins est éteint » dans les réglages). */
const fs = require('fs');
const path = require('path');

const modeles = require('./src/modeles');
const validation = require('./src/validation');
const lanceur = require('./src/lanceur');

const MIGRATIONS = [
  { version: 1, up: 'CREATE TABLE IF NOT EXISTS plugin_jenkins_teams_notify_log (id INTEGER PRIMARY KEY, at TEXT NOT NULL, job TEXT, event TEXT, status TEXT, error TEXT)' },
  { version: 2, up: 'CREATE INDEX IF NOT EXISTS idx_plugin_jenkins_teams_notify_log_at ON plugin_jenkins_teams_notify_log (at)' },
];

const SCRIPT = path.join(__dirname, 'bin', 'teams-post.js');
const LIGNES_MAX = 200;
// Variables d'environnement du SERVEUR que le script peut avoir besoin de voir (le ctx.exec part d'un environnement minimal).
const ENV_TRANSMISES = { PLAYWRIGHT_BROWSERS_PATH: 'JENKINS_TEAMS_NOTIFY_PLAYWRIGHT_BROWSERS_PATH', DISPLAY: 'JENKINS_TEAMS_NOTIFY_DISPLAY', NODE_PATH: 'JENKINS_TEAMS_NOTIFY_NODE_PATH' };

// Le binaire : le Node du serveur. `ctx.exec` n'accepte que `[A-Za-z0-9_./-]` (ni espace, ni `\`, ni `:` — un chemin Windows ou un
// dossier à espaces est refusé) : on retombe alors sur `node` du PATH.
const NODE = /^[A-Za-z0-9_./-]+$/.test(process.execPath) ? process.execPath : 'node';

async function activate(ctx) {
  let file = null;
  let occupe = null; // 'test' | 'login' | null — ce que l'écran affiche pendant qu'une action longue tourne

  ctx.i18n.register('fr', require('./ui/i18n').fr);
  ctx.i18n.register('en', require('./ui/i18n').en);
  ctx.db.migrate(MIGRATIONS);
  // Un journal LOCAL : il ne quitte jamais cette machine (V1 : aucune table de plugin n'entre dans le dépôt d'équipe).
  ctx.db.classify('plugin_jenkins_teams_notify_log', 'L');

  const t = (k, p) => ctx.i18n.t(k, p);
  const profil = path.join(ctx.dataDir, 'profile');
  const demo = () => ctx.demo.isDemo();

  /* ---------- Le processus : ctx.exec, sans shell — ou, en démo, un faux qui réussit ---------- */
  const env = () => {
    const out = {};
    for (const [cible, source] of Object.entries(ENV_TRANSMISES)) { const v = ctx.env ? ctx.env.get(source) : undefined; if (v) out[cible] = v; }
    return out;
  };
  const executer = async (args, timeoutMs) => {
    if (demo()) return { code: 0, stdout: 'démo', stderr: '' };
    if (!fs.existsSync(SCRIPT)) return { code: lanceur.CODES.PREREQUIS, stdout: '', stderr: `script introuvable : ${SCRIPT}` };
    return ctx.exec(NODE, args, { allowlist: [SCRIPT], timeoutMs, env: env() });
  };
  file = lanceur.creerFile({ executer });

  /* ---------- L'état de la session, gardé dans les réglages (il survit au redémarrage) ---------- */
  const etat = () => ctx.settings.get('session_state') || 'inconnu';
  const poserEtat = (valeur) => { if (etat() !== valeur) ctx.settings.set({ session_state: valeur }); };

  /* ---------- Le journal ---------- */
  function purger() {
    const jours = Number(ctx.settings.get('retention_days')) || 0;
    if (jours <= 0) return;
    const limite = new Date(Date.now() - Math.max(7, jours) * 86_400_000).toISOString();
    ctx.db.prepare('DELETE FROM plugin_jenkins_teams_notify_log WHERE at < ?').run(limite);
  }
  function journaliser(job, evenement, statut, erreur) {
    ctx.db.prepare('INSERT INTO plugin_jenkins_teams_notify_log (at, job, event, status, error) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), String(job || '').slice(0, 300), evenement, statut, lanceur.erreurCourte(erreur));
    purger();
  }

  /* ---------- Envoyer : le cœur du plugin ---------- */
  function messageDe(reglages, type, variables) {
    return modeles.rendre(modeles.modeleDe(reglages, type, (x) => t(`jenkins-teams-notify.template.${x}`)), variables);
  }
  /** `manuel` : un test ou une connexion — ils passent même quand la session est « à reconnecter », c'est ainsi qu'on en sort. */
  async function envoyer({ message, job, evenement, manuel = false, dryRun = false }) {
    const reglages = ctx.settings.get();
    const manque = validation.problemes(reglages);
    if (manque.length) { journaliser(job, evenement, 'echec', `réglages incomplets : ${manque.map((p) => p.champ).join(', ')}`); return { statut: 'echec', erreur: 'config' }; }
    if (!manuel && etat() === 'connexion-requise') { journaliser(job, evenement, 'ignoree', t('jenkins-teams-notify.log.login-required')); return { statut: 'ignoree' }; }
    const args = lanceur.construireArgs(SCRIPT, reglages, message, {
      profileDir: profil, dryRun, headless: dryRun ? false : !!reglages.headless, loginTimeoutMs: dryRun ? 300_000 : 90_000,
    });
    const r = await file.pousser(args, { timeoutMs: dryRun ? lanceur.TIMEOUT_LOGIN_MS : lanceur.TIMEOUT_MS, etiquette: dryRun ? 'login' : 'envoi' });
    if (r.statut === 'ok') poserEtat('ok');
    else if (r.statut === 'session') poserEtat('connexion-requise');
    journaliser(job, evenement, r.statut, r.erreur);
    return r;
  }

  /* ---------- Les événements Jenkins ---------- */
  /* Le bus attend ses abonnés (30 s au plus, l'un après l'autre) : un envoi — un navigateur, jusqu'à 2 minutes, plus la
     file — ne s'attend DONC PAS ici. On le met en file et on rend la main ; son issue va au journal. */
  const traiter = (nomEvenement) => (payload) => {
    const reglages = ctx.settings.get();
    if (!String(reglages.team_link || '').trim()) return;            // pas configuré : le plugin se tait
    const c = modeles.classer(nomEvenement, payload);
    if (!c) return;
    if (!modeles.filtreAccepte(reglages.job_filter, c.variables.job)) return;
    envoyer({ message: messageDe(reglages, c.type, c.variables), job: c.variables.job, evenement: c.type })
      .catch((e) => ctx.log(`envoi : ${e.message}`));
  };
  ctx.events.on('jenkins.job.started', traiter('jenkins.job.started'));
  ctx.events.on('jenkins.job.finished', traiter('jenkins.job.finished'));

  /* ---------- Les écrans ---------- */
  // Un onglet : c'est lui qui porte la pastille « connexion requise » (un sous-onglet de réglages n'en a pas).
  ctx.ui.registerTab({ id: 'jenkins-teams-notify', label: 'Teams', title: 'Teams : les notifications de jobs Jenkins', icon: 'i-users', position: 'end', i18n: { label: 'jenkins-teams-notify.nav', title: 'jenkins-teams-notify.tab.title' } });
  ctx.ui.registerSettingsTab({ id: 'jenkins-teams-notifycfg', label: 'Teams', title: 'Teams : lien du canal, session, modèles, journal', schemaForm: false, i18n: { label: 'jenkins-teams-notify.settings.sub', title: 'jenkins-teams-notify.settings.title' } });
  ctx.ui.registerBriefSection({ id: 'connexion', label: 'Teams : connexion requise', icon: 'alert', i18n: 'jenkins-teams-notify.brief.title' });

  const statut = async () => {
    const reglages = ctx.settings.get();
    const probes = ctx.services.has('jenkins.status');
    const sonde = probes ? await ctx.services.call('jenkins.status').catch(() => null) : null;
    return {
      demo: demo(),
      problems: validation.problemes(reglages),
      state: etat(),
      busy: occupe,
      queue: file.longueur(),
      jenkins: { present: probes, configured: !!(sonde && sonde.configured) },
      mode: reglages.session_mode,
      scriptPresent: fs.existsSync(SCRIPT),
    };
  };
  ctx.http.router.get('/status', () => statut());
  const erreur = (message, status = 400) => Object.assign(new Error(message), { status });
  ctx.http.router.get('/log', (req) => {
    const limite = Math.min(LIGNES_MAX, Math.max(1, Number(req.query && req.query.limit) || 50));
    return { rows: ctx.db.prepare('SELECT id, at, job, event, status, error FROM plugin_jenkins_teams_notify_log ORDER BY id DESC LIMIT ?').all(limite) };
  });

  /* Un test et une connexion sont LONGS (un navigateur, parfois une personne) : la route rend la main tout de suite,
     l'écran suit `/status` (`busy`) et relit le journal. */
  function lancerEnFond(genre, tache) {
    if (occupe) throw erreur(t('jenkins-teams-notify.err.busy'), 409);
    occupe = genre;
    Promise.resolve().then(tache).catch((e) => ctx.log(`${genre} : ${e.message}`)).finally(() => { occupe = null; });
    return { accepted: true, busy: genre };
  }
  ctx.http.router.post('/test', () => lancerEnFond('test', () => envoyer({ message: modeles.rendre(t('jenkins-teams-notify.test.message')), job: '(test)', evenement: 'test', manuel: true })));
  ctx.http.router.post('/login', () => lancerEnFond('login', () => envoyer({ message: '', job: '(connexion)', evenement: 'login', manuel: true, dryRun: true })));
  ctx.http.router.post('/session/reset', () => {
    if (occupe || file.longueur()) throw erreur(t('jenkins-teams-notify.err.busy'), 409);
    fs.rmSync(profil, { recursive: true, force: true });
    poserEtat('inconnu');
    return { ok: true };
  });

  // La démo : deux notifications fictives dans le journal (le faux processus réussit, sans Playwright).
  ctx.demo.seed((c) => {
    const maintenant = Date.now();
    const poser = c.db.prepare('INSERT INTO plugin_jenkins_teams_notify_log (at, job, event, status, error) VALUES (?, ?, ?, ?, ?)');
    poser.run(new Date(maintenant - 14 * 60_000).toISOString(), 'boutique/api-build', 'started', 'ok', '');
    poser.run(new Date(maintenant - 11 * 60_000).toISOString(), 'boutique/api-build', 'success', 'ok', '');
  });

  purger();
  ctx.log('activé');
}

async function deactivate() {
  // Le chargeur retire abonnements et routes. La file finit ce qu'elle a commencé : un navigateur en cours n'est pas tué.
}

module.exports = { activate, deactivate, MIGRATIONS };
