'use strict';
/* Lancer `bin/teams-post.js` : les arguments, le sens des codes de sortie, et LA FILE.
   Rien ici ne sait ce qu'est un ctx : `executer(args, timeoutMs)` est injecté (le vrai est
   `ctx.exec`, le faux d'un test ou de la démo rend un code). Tout se teste sans navigateur. */

const CODES = { OK: 0, ECHEC: 1, SESSION: 2, PREREQUIS: 3 };
const TIMEOUT_MS = 120_000;       // une notification
const TIMEOUT_LOGIN_MS = 330_000; // « Ouvrir Teams pour se connecter » : 5 min de connexion humaine + marge
const FILE_MAX = 20;              // au-delà, on abandonne (journalisé) plutôt que d'empiler

/** Les arguments du script — un TABLEAU, jamais une chaîne de commande. Le message n'est qu'une valeur
    d'argument (`--message=…`) : `; | $( ) \` ' "` et les retours à la ligne arrivent tels quels, rien ne les interprète
    (il n'y a pas de shell), et la forme `--clé=valeur` empêche qu'une valeur ressemble à un drapeau.
    @param {string} script chemin du script
    @param {{ team_link: string, channel_name?: string, session_mode?: string, cdp_url?: string, headless?: boolean }} r réglages
    @param {string} message
    @param {{ profileDir: string, dryRun?: boolean, loginTimeoutMs?: number, headless?: boolean }} o */
function construireArgs(script, r, message, o) {
  const args = [script];
  args.push(`--message=${message}`);
  args.push(`--channel-url=${r.team_link}`);
  if (r.channel_name) args.push(`--channel-name=${r.channel_name}`);
  if (r.session_mode === 'cdp') args.push(`--cdp-url=${r.cdp_url}`);
  else args.push(`--profile-dir=${o.profileDir}`);
  args.push(`--headless=${(o.headless !== undefined ? o.headless : !!r.headless) ? 'true' : 'false'}`);
  if (o.dryRun) args.push('--dry-run');
  if (o.loginTimeoutMs) args.push(`--login-timeout-ms=${Math.round(o.loginTimeoutMs)}`);
  return args;
}

/** Le code de sortie → un statut du journal. */
function statutDeSortie(code) {
  if (code === CODES.OK) return 'ok';
  if (code === CODES.SESSION) return 'session';
  if (code === CODES.PREREQUIS) return 'prerequis';
  return 'echec';
}

/** Le texte d'erreur gardé au journal : la première ligne utile, tronquée. */
function erreurCourte(texte, max = 200) {
  const ligne = String(texte || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  return ligne.length > max ? `${ligne.slice(0, max - 1)}…` : ligne;
}

/** Une tentative : { statut, erreur }. Une exception (délai dépassé, binaire introuvable) est un échec, jamais un crash. */
async function tenter(executer, args, timeoutMs) {
  try {
    const r = await executer(args, timeoutMs);
    const statut = statutDeSortie(r.code);
    return { statut, erreur: statut === 'ok' ? '' : erreurCourte(r.stderr || r.stdout) };
  } catch (e) {
    const delai = /délai dépassé/.test(String((e && e.message) || ''));
    return { statut: delai ? 'delai' : 'echec', erreur: erreurCourte(e && e.message) };
  }
}

/** UNE tentative, puis UNE seconde si l'échec n'est pas une session expirée ni un prérequis manquant :
    ceux-là ne se règlent pas en réessayant, et boucler sur « connexion requise » ouvrirait un navigateur pour rien. */
async function avecReessai(executer, args, timeoutMs) {
  const premiere = await tenter(executer, args, timeoutMs);
  if (premiere.statut === 'ok' || premiere.statut === 'session' || premiere.statut === 'prerequis') return { ...premiere, tentatives: 1 };
  const seconde = await tenter(executer, args, timeoutMs);
  return { ...seconde, tentatives: 2 };
}

/** LA FILE : un seul navigateur à la fois sur le profil. Les tâches s'exécutent l'une après l'autre,
    dans l'ordre d'arrivée ; une tâche qui échoue ne bloque pas la suivante.
    @param {{ executer: (args: string[], timeoutMs: number) => Promise<{ code: number, stdout?: string, stderr?: string }>, max?: number }} o */
function creerFile({ executer, max = FILE_MAX }) {
  const attente = [];
  let enCours = null;
  let boucle = null;

  async function tourner() {
    while (attente.length) {
      const t = attente.shift();
      enCours = t.etiquette || null;
      try { t.resoudre(await avecReessai(executer, t.args, t.timeoutMs || TIMEOUT_MS)); }
      catch (e) { t.resoudre({ statut: 'echec', erreur: erreurCourte(e && e.message), tentatives: 1 }); }
    }
    enCours = null;
    boucle = null;
  }

  return {
    /** Rend une promesse du résultat { statut, erreur, tentatives }. 'abandon' si la file est pleine. */
    pousser(args, { timeoutMs, etiquette } = {}) {
      if (attente.length >= max) return Promise.resolve({ statut: 'abandon', erreur: 'file pleine', tentatives: 0 });
      return new Promise((resoudre) => {
        attente.push({ args, timeoutMs, etiquette, resoudre });
        if (!boucle) boucle = tourner();
      });
    },
    longueur: () => attente.length + (enCours !== null || boucle ? 1 : 0),
    enCours: () => enCours,
    /** Rend la main quand tout ce qui était poussé est fini (tests, arrêt). */
    vider: () => boucle || Promise.resolve(),
  };
}

module.exports = { CODES, TIMEOUT_MS, TIMEOUT_LOGIN_MS, FILE_MAX, construireArgs, statutDeSortie, erreurCourte, tenter, avecReessai, creerFile };
