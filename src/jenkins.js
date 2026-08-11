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

/* Même convention que les forges : `<SERVICE>_CA_CERT` pour épingler le CA interne,
   `<SERVICE>_INSECURE_TLS=1` pour dépanner. Un Jenkins d'entreprise est presque toujours
   derrière un certificat que Node ne connaît pas. */
const tlsAgent = makeAgentFactory('JENKINS_CA_CERT', 'JENKINS_INSECURE_TLS');

/* UNE ERREUR TLS DIT QUOI FAIRE. « unable to get local issuer certificate » est exact et
   parfaitement inutile : il ne nomme ni la cause (le CA interne de l'entreprise, inconnu de
   Node) ni le remède. On traduit donc les codes en gestes, en nommant les deux variables —
   le CA épinglé d'abord, la désactivation ensuite, parce que c'est l'ordre des bonnes idées. */
const AIDES = {
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "CA d'entreprise inconnue de Node. Exporte le CA interne et lance avec JENKINS_CA_CERT=/chemin/ca.pem (recommandé), ou JENKINS_INSECURE_TLS=1 en dépannage.",
  UNABLE_TO_GET_ISSUER_CERT: "CA d'entreprise inconnue de Node. Fournis JENKINS_CA_CERT=/chemin/ca.pem, ou JENKINS_INSECURE_TLS=1 en dépannage.",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificat TLS non vérifiable. Fournis JENKINS_CA_CERT=/chemin/ca.pem, ou JENKINS_INSECURE_TLS=1 en dépannage.',
  SELF_SIGNED_CERT_IN_CHAIN: 'certificat auto-signé. Fournis JENKINS_CA_CERT=/chemin/ca.pem, ou JENKINS_INSECURE_TLS=1 en dépannage.',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'certificat auto-signé. Fournis JENKINS_CA_CERT=/chemin/ca.pem, ou JENKINS_INSECURE_TLS=1 en dépannage.',
  CERT_UNTRUSTED: 'certificat non fiable pour Node. Fournis JENKINS_CA_CERT=/chemin/ca.pem, ou JENKINS_INSECURE_TLS=1 en dépannage.',
  CERT_HAS_EXPIRED: 'le certificat du serveur a expiré (côté Jenkins, rien à corriger ici).',
  ENOTFOUND: "hôte introuvable : vérifie l'URL Jenkins (schéma https://, pas de chemin de job).",
  ECONNREFUSED: 'connexion refusée : mauvais port/URL, ou Jenkins injoignable depuis cette machine (VPN ?).',
  ETIMEDOUT: 'délai dépassé : Jenkins injoignable (réseau, proxy, VPN).',
};

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
  try {
    return await request(base(cfg) + chemin, {
      method, body, agent: tlsAgent(), headers: { ...entetes(cfg), ...headers },
    });
  } catch (e) {
    /* Le code de Node est parfois dans `cause` (fetch/TLS l'enveloppe) : on regarde les deux,
       sinon un certificat auto-signé retomberait sur le message brut qu'on cherche à éviter. */
    const code = (e && e.code) || (e && e.cause && e.cause.code) || '';
    const aide = AIDES[code];
    throw new Error(aide
      ? `Jenkins (${base(cfg)}) : ${aide}`
      : `Jenkins (${base(cfg)}) injoignable : ${(e && e.message) || String(e)}`);
  }
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
/* Les paramètres d'un job, tels que Jenkins les déclare. On garde le type : un booléen se
   coche, un choix se choisit, et présenter les trois comme un champ texte ferait retaper des
   valeurs que Jenkins connaît déjà. */
/* LES VALEURS D'UNE LISTE DÉROULANTE, quel que soit le plugin qui la fournit. Le paramètre
   « choix » standard rend un tableau `choices`. Extended Choice, lui, met TOUTES les options
   dans une seule chaîne séparée par des virgules (`value`), et sa valeur par défaut ailleurs.
   Sans ce démêlage, la liste retombe en champ de saisie libre : on retape à la main une
   valeur que Jenkins connaît, et une faute de frappe part en production. */
/* QUAND LE PLUGIN N'A PAS SU CALCULER SES VALEURS. Les paramètres dynamiques (Extended
   Choice, Active Choices) construisent leur liste par un script ou un fichier de propriétés,
   évalués côté serveur au moment d'afficher la page. Vu depuis l'API, l'évaluation peut
   échouer — et le plugin rend alors sa PHRASE D'ERREUR à la place de la liste :
   « Could not get Environment from ENV Param ».

   La prendre pour une valeur est le pire des cas : le champ arrive pré-rempli d'une phrase
   qui a l'air d'une valeur, et un lancement l'enverrait telle quelle à Jenkins. On la
   reconnaît, on vide le champ, et on le DIT — un champ vide inexpliqué se remplit au jugé. */
const ERREUR_PLUGIN = /^(could not|couldn't|unable to|error)\b/i;
const estErreurPlugin = (v) => typeof v === 'string' && ERREUR_PLUGIN.test(v.trim());

function choixDe(p) {
  if (Array.isArray(p.choices)) return p.choices.map(String);
  // Certaines versions rendent `choices` sous forme d'objet { values: [...] }.
  if (p.choices && Array.isArray(p.choices.values)) return p.choices.values.map(String);
  const type = String(p.type || p._class || '');
  if (/ExtendedChoice|MultiSelect|SingleSelect/i.test(type) && typeof p.value === 'string'
      && p.value.includes(',') && !estErreurPlugin(p.value)) {
    return p.value.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return null;
}

/* La valeur proposée. `defaultParameterValue` est la forme standard ; à défaut on accepte
   `defaultValue`, que plusieurs plugins utilisent — un champ vide ferait retaper ce que
   Jenkins allait proposer de lui-même. */
function defautDe(p) {
  if (p.defaultParameterValue && p.defaultParameterValue.value !== undefined) return p.defaultParameterValue.value;
  if (p.defaultValue !== undefined) return p.defaultValue;
  return '';
}

function lireParametres(properties) {
  const prop = (properties || []).find((p) => Array.isArray(p && p.parameterDefinitions));
  return ((prop && prop.parameterDefinitions) || []).map((p) => {
    const defaut = defautDe(p);
    const cassé = estErreurPlugin(defaut) || (choixDe(p) === null && estErreurPlugin(p.value));
    return {
      name: p.name,
      type: String(p.type || p._class || '').replace(/.*\./, ''),
      description: p.description || '',
      choices: choixDe(p),
      // Vidé, jamais pré-rempli d'une phrase d'erreur : elle partirait à Jenkins comme valeur.
      value: cassé ? '' : defaut,
      unresolved: cassé || undefined,
    };
  });
}

/* QUI A LANCÉ. Jenkins ne répond pas à cette question par un champ mais par des « causes » :
   une action humaine porte un `userName`, le reste est déclenché par une horloge, un push ou
   un job amont. On rend donc soit un nom, soit la NATURE du déclencheur — « lancé par le
   planificateur » est une réponse, « (vide) » n'en est pas une. */
const DECLENCHEURS = [
  [/TimerTrigger/i, 'timer'], [/SCMTrigger/i, 'scm'], [/UpstreamCause/i, 'upstream'],
  [/BranchIndexingCause/i, 'scm'], [/RemoteCause/i, 'remote'], [/ReplayCause/i, 'replay'],
];
function auteurDe(build) {
  for (const action of (build && build.actions) || []) {
    for (const c of (action && action.causes) || []) {
      if (c && c.userName) return { user: c.userName };
      const cls = String((c && c._class) || '');
      const trouve = DECLENCHEURS.find(([re]) => re.test(cls));
      if (trouve) return { trigger: trouve[1] };
      if (c && c.shortDescription) return { label: String(c.shortDescription).slice(0, 80) };
    }
  }
  return null;
}

/* LES PARAMÈTRES DU DERNIER LANCEMENT. Ils sont DÉJÀ dans la réponse — ils servent aussi à
   retrouver la branche — donc les afficher ne coûte pas un appel de plus : c'est la même
   requête, le même octet de réseau. Deux exclusions :
   — un paramètre de type MOT DE PASSE, dont Jenkins rend une forme chiffrée (`{AQAAABAA…}`) :
     illisible, sans intérêt, et un secret n'a rien à faire dans une liste ;
   — une valeur vide, qui n'apprend rien et pousse les autres hors de l'écran.
   TOUS les autres sont rendus : un plafond sur le nombre ferait mentir la liste, qui
   prétendrait montrer avec quoi le job est parti en en cachant la moitié. Seule chaque VALEUR
   est bornée — une valeur de trois mille caractères n'est pas une information, c'est un mur. */
const MAX_VALEUR = 60;
function paramsDuBuild(build) {
  const out = [];
  for (const action of (build && build.actions) || []) {
    for (const p of (action && action.parameters) || []) {
      if (!p || !p.name || p.value == null || p.value === '') continue;
      if (/password/i.test(String(p._class || '')) || /password|secret|token/i.test(p.name)) continue;
      out.push({ name: p.name, value: String(p.value).slice(0, MAX_VALEUR) });
    }
  }
  return out;
}

/* SUR QUELLE BRANCHE / QUEL TAG. Trois sources, dans l'ordre de fiabilité : la révision que
   le plugin git a réellement construite ; à défaut un paramètre de build qui la nomme ; à
   défaut le nom du job lui-même pour un pipeline multibranche, où la branche EST le job.
   `refs/remotes/origin/main` est un détail d'implémentation : on rend `main`. */
const PARAMS_REF = /^(branch|branche|git_?branch|ref|tag|version)$/i;
function refDe(build, classeParent, nomJob) {
  for (const action of (build && build.actions) || []) {
    const b = action && action.lastBuiltRevision && action.lastBuiltRevision.branch;
    const nom = Array.isArray(b) && b.length ? b[0].name : null;
    if (nom) return String(nom).replace(/^refs\/(remotes|heads|tags)\//, '').replace(/^origin\//, '');
  }
  for (const action of (build && build.actions) || []) {
    for (const p of (action && action.parameters) || []) {
      if (p && p.name && PARAMS_REF.test(p.name) && p.value) return String(p.value).slice(0, 80);
    }
  }
  // Pipeline multibranche : chaque branche est un job, son nom est donc la branche.
  if (/MultiBranch/i.test(String(classeParent || ''))) return decodeURIComponent(nomJob || '');
  return null;
}

function aplatir(noeuds, prefixe = '', sortie = [], classeParent = '') {
  for (const n of noeuds || []) {
    if (!n || !n.name) continue;
    const chemin = prefixe ? `${prefixe}/${n.name}` : n.name;
    if (Array.isArray(n.jobs) && n.jobs.length) { aplatir(n.jobs, chemin, sortie, n._class || ''); continue; }
    // Un dossier VIDE n'est pas un job non plus : sans couleur, il n'y a rien à lancer.
    if (n.color == null && /folder/i.test(String(n._class || ''))) continue;
    const i = chemin.lastIndexOf('/');
    sortie.push({
      path: chemin, name: n.name, url: n.url || '',
      // Le dossier est calculé ICI : l'écran s'en sert pour filtrer, il ne doit pas
      // redécouper des chemins de son côté et se tromper au premier nom exotique.
      folder: i === -1 ? '' : chemin.slice(0, i),
      ...lireCouleur(n.color),
      buildable: n.buildable !== false,
      // Date du dernier lancement : c'est l'ordre naturel de lecture d'une liste de jobs —
      // ce qui vient de tourner d'abord. Jamais lancé → `null`, et non 0, qui trierait comme
      // une date de 1970 mais se lirait comme une date.
      last: (n.lastBuild && n.lastBuild.timestamp) || null,
      lastNumber: (n.lastBuild && n.lastBuild.number) || null,
      by: auteurDe(n.lastBuild),
      ref: refDe(n.lastBuild, classeParent, n.name),
      /* COMBIEN DE PARAMÈTRES, dès la liste. Sans ça, le bouton « Lancer » promet la même
         chose pour un job qui part au clic et pour un job qui demande d'abord une version et
         un environnement : l'écran peut le DIRE avant qu'on clique, il le dit. */
      params: lireParametres(n.property).length,
      lastParams: paramsDuBuild(n.lastBuild),
    });
  }
  return sortie;
}

/* Ce qu'on demande pour chaque job. `actions[...]` sert les deux questions que la liste doit
   trancher d'un coup d'œil : QUI a lancé, et SUR QUOI. Tout arrive dans la MÊME requête —
   interroger chaque job séparément ferait trois cents appels à l'ouverture de l'onglet. */
const CHAMPS_JOB = 'name,url,color,buildable,_class,'
  + 'property[parameterDefinitions[name]],'
  + 'lastBuild[timestamp,number,actions[causes[shortDescription,userName,_class],'
  + 'parameters[name,value,_class],lastBuiltRevision[branch[name]]]]';
const ARBRE = (n) => (n === 0 ? `jobs[${CHAMPS_JOB}]`
  : `jobs[${CHAMPS_JOB},${ARBRE(n - 1)}]`);

// La liste complète, aplatie et triée. Le filtrage se fait à l'écran : il en faut un, une
// installation d'équipe en compte des centaines.
async function lister(cfg) {
  if (!isConfigured(cfg)) throw new Error('Jenkins non configuré (URL, utilisateur, jeton requis).');
  const res = await appel(cfg, `/api/json?tree=${encodeURIComponent(ARBRE(3))}`);
  const data = json(res, 'la liste des jobs');
  /* PAR DATE DE DERNIER LANCEMENT, le plus récent d'abord : dans une liste de trois cents
     jobs, ce qui vient de tourner est ce qu'on vient chercher. Les jamais lancés ferment la
     marche, par ordre alphabétique — sans date, ils n'ont pas de place naturelle, et les
     éparpiller au hasard rendrait la fin de liste illisible. */
  return aplatir(data.jobs).sort((a, b) => {
    if (a.last && b.last) return b.last - a.last;
    if (a.last || b.last) return a.last ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

/* Chaque build de l'historique porte SES paramètres et SA cause : la fiche montre, à droite,
   avec quoi l'exécution sélectionnée est partie. Tout arrive dans la requête du job — un appel
   par build pour reconstituer ça en ferait dix à chaque ouverture de fiche. */
/* ---------- LE FORMULAIRE DE LANCEMENT, quand l'API ne suffit pas ----------

   Git Parameter, Extended Choice, Active Choices : ces plugins ne DÉCLARENT pas leurs valeurs,
   ils les CALCULENT au moment où Jenkins rend sa page — en interrogeant le dépôt git, un
   script, un fichier de propriétés. L'API ne les porte donc pas, et aucune requête JSON ne les
   fera apparaître : la liste des branches d'un job n'existe nulle part dans `/api/json`.

   Elle existe en revanche dans la page que Jenkins fabrique pour un humain — celle qu'on voit
   en cliquant « Build with Parameters ». On la lit donc, mais SEULEMENT pour les paramètres
   dont l'API n'a rien dit : une requête de plus, à l'ouverture d'une fiche, et jamais pour un
   job dont tout est déjà connu.

   Analyser du HTML est fragile, et c'est assumé : en cas d'échec on retombe exactement sur le
   comportement d'avant (champ libre, prévenu). Jamais pire, souvent mieux. */

// Les blocs de paramètre de la page de lancement : `<div name="parameter"> … </div>`.
function blocsParametres(html) {
  const out = [];
  const re = /name=["']parameter["']/g;
  let m = re.exec(html);
  while (m) {
    const suivant = re.exec(html);
    out.push(html.slice(m.index, suivant ? suivant.index : html.length));
    m = suivant;
  }
  return out;
}

const attr = (bloc, re) => { const m = bloc.match(re); return m ? m[1] : null; };
const decode = (t) => String(t).replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

/* Ce que la page dit d'un paramètre : ses options, celle qui est sélectionnée, et s'il en
   accepte plusieurs. Une `<option>` sans attribut `value` vaut son texte — Jenkins écrit les
   deux formes selon le plugin. */
function lireChoixHtml(html) {
  const par = {};
  for (const bloc of blocsParametres(html)) {
    const nom = attr(bloc, /name=["']name["'][^>]*value=["']([^"']+)["']/)
      || attr(bloc, /value=["']([^"']+)["'][^>]*name=["']name["']/);
    if (!nom) continue;
    const select = bloc.match(/<select\b([^>]*)>([\s\S]*?)<\/select>/i);
    if (!select) continue;
    const options = [...select[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((o) => ({
      valeur: decode(attr(o[1], /value=["']([^"']*)["']/) ?? o[2].replace(/<[^>]*>/g, '')),
      choisie: /\bselected\b/i.test(o[1]),
    })).filter((o) => o.valeur !== '');
    if (!options.length) continue;
    const choisies = options.filter((o) => o.choisie).map((o) => o.valeur);
    par[decode(nom)] = {
      choices: options.map((o) => o.valeur),
      value: choisies.length ? choisies.join(',') : '',
      multiple: /\bmultiple\b/i.test(select[1]),
    };
  }
  return par;
}

/* Complète les paramètres avec ce que la page sait et que l'API ignore. On ne TOUCHE PAS à
   ceux dont l'API a déjà donné les valeurs : elle est la source la plus sûre, le HTML n'est
   qu'un rattrapage. */
async function completerParFormulaire(cfg, chemin, parametres) {
  if (!parametres.some((p) => !p.choices)) return parametres;
  let page = '';
  try {
    const res = await appel(cfg, `${cheminUrl(chemin)}/build?delay=0sec`, { headers: { Accept: 'text/html' } });
    if (res.status < 200 || res.status >= 300) return parametres;
    page = res.body || '';
  } catch { return parametres; }        // la page n'a pas répondu : on garde ce qu'on a
  let vus = {};
  try { vus = lireChoixHtml(page); } catch { return parametres; }
  return parametres.map((p) => {
    const trouve = vus[p.name];
    if (p.choices || !trouve) return p;
    return {
      ...p,
      choices: trouve.choices,
      multiple: trouve.multiple || undefined,
      value: trouve.value || (p.unresolved ? '' : p.value),
      unresolved: undefined,             // la page a répondu : il n'y a plus rien à signaler
    };
  });
}

const CHAMPS_BUILD = 'number,result,building,timestamp,duration,url,displayName,'
  + 'actions[causes[shortDescription,userName,_class],parameters[name,value,_class],lastBuiltRevision[branch[name]]]';

// Le détail d'un job : de quoi décider de le lancer, et voir ce qu'il a donné.
async function detail(cfg, chemin) {
  if (!isConfigured(cfg)) throw new Error('Jenkins non configuré (URL, utilisateur, jeton requis).');
  /* `parameterDefinitions[*]` — l'étoile, et non une liste de champs. Chaque plugin de
     paramètre expose les siens : le choix multiple standard met ses valeurs dans `choices`,
     mais d'autres les mettent ailleurs, et un champ non demandé n'arrive PAS. Le résultat se
     voyait à l'écran : une liste déroulante rendue comme un champ de saisie libre, où l'on
     retapait à la main une valeur que Jenkins connaissait. */
  const tree = `name,url,description,buildable,color,property[parameterDefinitions[*,defaultParameterValue[value]]],builds[${CHAMPS_BUILD}]{0,10}`;
  const res = await appel(cfg, `${cheminUrl(chemin)}/api/json?tree=${encodeURIComponent(tree)}`);
  const d = json(res, `le job « ${chemin} »`);
  return {
    path: chemin,
    name: d.name || chemin,
    url: d.url || '',
    description: d.description || '',
    buildable: d.buildable !== false,
    ...lireCouleur(d.color),
    parameters: await completerParFormulaire(cfg, chemin, lireParametres(d.property)),
    builds: (d.builds || []).map((b) => ({
      number: b.number,
      result: b.result || null,          // null = en cours : Jenkins ne tranche qu'à la fin
      building: !!b.building,
      timestamp: b.timestamp || null,
      duration: b.duration || 0,
      url: b.url || '',
      by: auteurDe(b),
      ref: refDe(b, '', ''),
      params: paramsDuBuild(b),
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
  lireCouleur, aplatir, cheminUrl, lireParametres, auteurDe, refDe, paramsDuBuild, choixDe, lireChoixHtml,
};
