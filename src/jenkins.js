'use strict';
/* Client Jenkins minimal : VOIR et LANCER des jobs.
 *
 * Auth : Basic `utilisateur:jeton d'API`. Jenkins n'accepte pas le jeton seul — c'est le
 * couple qui l'identifie —, d'où deux champs de configuration et non un.
 *
 * TROIS PARTICULARITÉS de Jenkins, qui expliquent l'essentiel du code ci-dessous.
 *
 * 1. LES JOBS SONT UN ARBRE. Dossiers, pipelines multibranches : un job vit à `a/b/c`, dont
 *    l'URL est `/job/a/job/b/job/c/`. On aplatit l'arbre en chemins lisibles (`a/b/c`) une
 *    fois pour toutes ; le reste du code ne manipule plus que ce chemin.
 *
 * 2. L'ÉTAT TIENT DANS UNE COULEUR. `color` vaut `blue`, `red`, `yellow`, `aborted`,
 *    `notbuilt`, `disabled` — et le suffixe `_anime` signifie « en cours ». On le traduit en
 *    `{statut, enCours}` ici : l'écran n'a pas à connaître la convention de Jenkins, et
 *    « blue = succès » est le genre de détail qui se perd dans une feuille de style.
 *
 * 3. LANCER EST UN POST, donc soumis au CSRF. Jenkins délivre un « crumb » lié à une session :
 *    on le demande, on renvoie le cookie AVEC lui, et on s'en passe s'il n'y a pas d'émetteur
 *    (installation sans protection CSRF). Un lancement sans crumb sur un Jenkins protégé
 *    échoue en 403 avec un message que personne ne relie à ça.
 *
 * L'outil ne surveille rien de lui-même : aucune requête n'est émise sans un geste. */

const { makeAgentFactory, request } = require('./httpreq');

const tlsAgent = makeAgentFactory('MERGERIE_JENKINS_CA', 'MERGERIE_JENKINS_INSECURE');

const isConfigured = (cfg) => !!(cfg && cfg.jenkins_url && cfg.jenkins_user && cfg.jenkins_token);

const base = (cfg) => String(cfg.jenkins_url || '').replace(/\/+$/, '');

function entetes(cfg) {
  const jeton = Buffer.from(`${cfg.jenkins_user}:${cfg.jenkins_token}`).toString('base64');
  return { Authorization: `Basic ${jeton}`, Accept: 'application/json' };
}

/* Un chemin de job (`a/b`) devient le chemin d'URL de Jenkins (`/job/a/job/b`). Chaque
   segment est encodé : un job peut s'appeler « release 2.0 » ou porter un accent, et une
   branche de pipeline multibranche s'appelle souvent `feature%2Fx` une fois encodée. */
function cheminUrl(chemin) {
  const segments = String(chemin || '').split('/').map((s) => s.trim()).filter(Boolean);
  if (!segments.length) throw new Error('chemin de job vide');
  return segments.map((s) => `/job/${encodeURIComponent(s)}`).join('');
}

async function appel(cfg, chemin, { method = 'GET', headers = {}, body } = {}) {
  const res = await request(base(cfg) + chemin, {
    method, body, agent: tlsAgent(), headers: { ...entetes(cfg), ...headers },
  });
  return res;
}

/* Erreur LISIBLE. Jenkins renvoie une page HTML complète sur 403/404 : la recopier dans un
   toast noierait la seule information utile. On nomme le cas, on cite le code. */
function verifier(res, quoi) {
  if (res.status >= 200 && res.status < 400) return res;
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Jenkins a refusé l'accès (${res.status}) — vérifie l'utilisateur et le jeton d'API.`);
  }
  if (res.status === 404) throw new Error(`Jenkins : ${quoi} introuvable (404).`);
  throw new Error(`Jenkins a répondu ${res.status} ${res.statusText || ''}`.trim());
}

function json(res, quoi) {
  verifier(res, quoi);
  try { return JSON.parse(res.body || '{}'); } catch { throw new Error(`Jenkins : réponse illisible pour ${quoi}.`); }
}

/* La couleur de Jenkins, traduite une fois pour toutes. `notbuilt` et `disabled` sont deux
   choses différentes qu'on ne peut pas fondre : l'un n'a jamais tourné, l'autre ne tournera
   pas. Une couleur inconnue devient `inconnu` plutôt que de faire échouer la liste. */
const COULEURS = {
  blue: 'succes', green: 'succes', red: 'echec', yellow: 'instable',
  aborted: 'annule', notbuilt: 'jamais', grey: 'jamais', disabled: 'desactive',
};
function lireCouleur(color) {
  const brut = String(color || '');
  const enCours = brut.endsWith('_anime');
  const cle = enCours ? brut.slice(0, -'_anime'.length) : brut;
  return { statut: COULEURS[cle] || 'inconnu', enCours };
}

/* Aplatit l'arbre des jobs. Les DOSSIERS n'ont pas de couleur et portent des enfants : ils ne
   sont pas des jobs et ne doivent pas apparaître comme tels — on descend dedans. La
   profondeur est bornée : une installation peut imbriquer sans fin, et une requête qui
   ramène tout l'arbre d'un coup peut peser des mégaoctets. */
function aplatir(noeuds, prefixe = '', sortie = []) {
  for (const n of noeuds || []) {
    if (!n || !n.name) continue;
    const chemin = prefixe ? `${prefixe}/${n.name}` : n.name;
    if (Array.isArray(n.jobs) && n.jobs.length) { aplatir(n.jobs, chemin, sortie); continue; }
    // Un dossier VIDE n'est pas un job non plus : sans couleur, il n'y a rien à lancer.
    if (n.color == null && /folder/i.test(String(n._class || ''))) continue;
    sortie.push({
      path: chemin, name: n.name, url: n.url || '',
      ...lireCouleur(n.color),
      buildable: n.buildable !== false,
    });
  }
  return sortie;
}

const ARBRE = (n) => (n === 0 ? 'jobs[name,url,color,buildable,_class]'
  : `jobs[name,url,color,buildable,_class,${ARBRE(n - 1)}]`);

// La liste complète, aplatie et triée. Le filtrage se fait à l'écran : il en faut un, une
// installation d'équipe en compte des centaines.
async function lister(cfg) {
  if (!isConfigured(cfg)) throw new Error('Jenkins non configuré (URL, utilisateur, jeton requis).');
  const res = await appel(cfg, `/api/json?tree=${encodeURIComponent(ARBRE(3))}`);
  const data = json(res, 'la liste des jobs');
  return aplatir(data.jobs).sort((a, b) => a.path.localeCompare(b.path));
}

/* Les paramètres d'un job, tels que Jenkins les déclare. On garde le type : un booléen se
   coche, un choix se choisit, et présenter les trois comme un champ texte ferait retaper des
   valeurs que Jenkins connaît déjà. */
function lireParametres(properties) {
  const prop = (properties || []).find((p) => Array.isArray(p && p.parameterDefinitions));
  return ((prop && prop.parameterDefinitions) || []).map((p) => ({
    name: p.name,
    type: String(p.type || p._class || '').replace(/.*\./, ''),
    description: p.description || '',
    choices: Array.isArray(p.choices) ? p.choices : null,
    value: p.defaultParameterValue ? p.defaultParameterValue.value : '',
  }));
}

const CHAMPS_BUILD = 'number,result,building,timestamp,duration,url,displayName';

// Le détail d'un job : de quoi décider de le lancer, et voir ce qu'il a donné.
async function detail(cfg, chemin) {
  if (!isConfigured(cfg)) throw new Error('Jenkins non configuré (URL, utilisateur, jeton requis).');
  const tree = `name,url,description,buildable,color,property[parameterDefinitions[name,type,description,choices,defaultParameterValue[value]]],builds[${CHAMPS_BUILD}]{0,10}`;
  const res = await appel(cfg, `${cheminUrl(chemin)}/api/json?tree=${encodeURIComponent(tree)}`);
  const d = json(res, `le job « ${chemin} »`);
  return {
    path: chemin,
    name: d.name || chemin,
    url: d.url || '',
    description: d.description || '',
    buildable: d.buildable !== false,
    ...lireCouleur(d.color),
    parameters: lireParametres(d.property),
    builds: (d.builds || []).map((b) => ({
      number: b.number,
      result: b.result || null,          // null = en cours : Jenkins ne tranche qu'à la fin
      building: !!b.building,
      timestamp: b.timestamp || null,
      duration: b.duration || 0,
      url: b.url || '',
    })),
  };
}

/* Le crumb anti-CSRF, avec SON cookie. Jenkins lie le crumb à la session qui l'a demandé :
   renvoyer le crumb sans le cookie donne un 403 aussi sûrement que ne rien renvoyer.
   Pas d'émetteur (404) = protection désactivée : on lance sans, plutôt que d'échouer. */
async function crumb(cfg) {
  const res = await appel(cfg, '/crumbIssuer/api/json');
  if (res.status === 404) return null;
  const d = json(res, 'le crumb CSRF');
  if (!d.crumbRequestField || !d.crumb) return null;
  const cookies = res.headers['set-cookie'];
  return {
    headers: {
      [d.crumbRequestField]: d.crumb,
      ...(cookies && cookies.length ? { Cookie: cookies.map((c) => String(c).split(';')[0]).join('; ') } : {}),
    },
  };
}

/* Lance un job. Avec paramètres → `buildWithParameters` : `build` ignorerait purement et
   simplement ce qu'on lui passe, et le job repartirait sur ses valeurs par défaut sans que
   rien ne le signale. Jenkins répond 201 avec l'URL de l'élément de FILE (pas du build) :
   le numéro n'existe pas encore, on rend donc ce qu'on a. */
async function lancer(cfg, chemin, parametres) {
  if (!isConfigured(cfg)) throw new Error('Jenkins non configuré (URL, utilisateur, jeton requis).');
  const entrees = Object.entries(parametres || {}).filter(([k]) => k);
  const c = await crumb(cfg);
  const corps = new URLSearchParams(entrees.map(([k, v]) => [k, v == null ? '' : String(v)])).toString();
  const url = entrees.length ? `${cheminUrl(chemin)}/buildWithParameters` : `${cheminUrl(chemin)}/build`;
  const res = await appel(cfg, url, {
    method: 'POST',
    body: corps,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(corps),
      ...((c && c.headers) || {}),
    },
  });
  verifier(res, `le lancement de « ${chemin} »`);
  return { queued: true, location: (res.headers && res.headers.location) || null };
}

/* La console d'un build. Bornée : un build de deux heures peut écrire des dizaines de
   mégaoctets, et c'est la FIN qu'on veut voir — l'erreur est en bas. */
const MAX_LOG = 200_000;
async function console_(cfg, chemin, numero) {
  if (!isConfigured(cfg)) throw new Error('Jenkins non configuré (URL, utilisateur, jeton requis).');
  const n = Number(numero) || 0;
  if (!n) throw new Error('numéro de build manquant');
  const res = await appel(cfg, `${cheminUrl(chemin)}/${n}/consoleText`, { headers: { Accept: 'text/plain' } });
  verifier(res, `la console du build #${n}`);
  const texte = res.body || '';
  return {
    text: texte.length > MAX_LOG ? texte.slice(-MAX_LOG) : texte,
    truncated: texte.length > MAX_LOG,
  };
}

// Test de connexion : qui suis-je, et Jenkins me répond-il ? Le nom rendu prouve que le
// couple utilisateur/jeton est le bon, pas seulement que l'URL existe.
async function tester(cfg) {
  if (!isConfigured(cfg)) throw new Error('Jenkins non configuré (URL, utilisateur, jeton requis).');
  const res = await appel(cfg, '/me/api/json?tree=id,fullName');
  const d = json(res, 'le compte courant');
  const jobs = await lister(cfg);
  return { ok: true, user: d.fullName || d.id || cfg.jenkins_user, jobs: jobs.length };
}

module.exports = {
  isConfigured, lister, detail, lancer, console: console_, tester,
  // exportés pour les tests : ce sont les deux traductions qui portent tout le reste
  lireCouleur, aplatir, cheminUrl, lireParametres,
};
