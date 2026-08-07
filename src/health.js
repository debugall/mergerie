'use strict';
/* Health check des URLs de la grille — OPT-IN, et à double tour.
 *
 * Ces requêtes sont les SEULES que la fonctionnalité « Liens » envoie vers l'extérieur, et
 * elles partent vers des adresses saisies par l'utilisateur. Trois garde-fous, chacun pour
 * une raison précise :
 *
 *   — GLOBALEMENT DÉSACTIVÉ par défaut. Une application qui pingue seule des URLs internes
 *     dès l'installation n'est pas ce qu'on attend d'un outil local.
 *   — PAR ENVIRONNEMENT, et la PROD reste hors du lot tant qu'on ne l'a pas demandée
 *     explicitement : cinq minutes de trafic automatique vers la production, ce n'est pas
 *     une décision qu'un outil prend à la place de son utilisateur.
 *   — SEULEMENT QUAND UN CLIENT REGARDE. Onglet fermé, personne pour lire le badge : le
 *     cycle ne part pas. Pas de trafic fantôme la nuit.
 *
 * Le cycle est SÉQUENTIEL. Vingt services × quatre environnements lancés d'un coup, c'est
 * quatre-vingts connexions simultanées sortant d'un poste de travail — de quoi ressembler à
 * autre chose qu'un outil de développement vu du réseau.
 */

const http = require('http');
const https = require('https');
const db = require('./db');
const { makeAgentFactory } = require('./httpreq');

// 5 s : au-delà, le service ne répond pas « lentement », il ne répond pas.
const TIMEOUT_MS = 5000;
const MIN_MINUTES = 1;
// Un client qui n'a pas donné signe de vie depuis ça est considéré parti.
const CLIENT_VIVANT_MS = 2 * 60 * 1000;

/* On réutilise l'agent TLS des forges : dans une entreprise à CA interne, les URLs de la
   grille sont sur les mêmes domaines que GitLab. Poser un second réglage pour le même
   certificat aurait été une source d'incohérence de plus. */
const tlsAgent = makeAgentFactory('GITLAB_CA_CERT', 'GITLAB_INSECURE_TLS');

/* Une case à vérifier = un service × un environnement DONT le health check est activé.
   La jointure fait le filtre : inutile d'aller chercher des URLs pour les écarter ensuite. */
const cibles = () => db.prepare(`SELECT u.service_id, u.environment_id, u.url
  FROM service_url u JOIN environment e ON e.id = u.environment_id
  WHERE e.health_check = 1 ORDER BY u.service_id, e.position`).all();

/* Une requête à nous, et non celle des forges (`httpreq.request`) : celle-ci accumule le
   corps de la réponse, ne suit pas les redirections et attend trente secondes. Ici il faut
   exactement l'inverse — AUCUN corps lu (on coupe dès les en-têtes reçus, sans quoi une page
   d'accueil de cinq mégaoctets transiterait pour rendre un simple « up »), les redirections
   suivies, et cinq secondes de patience.

   `resolu` porte le nombre de sauts déjà faits : une boucle de redirections ne doit pas
   faire tourner le cycle indéfiniment. */
function tete(url, methode, sauts = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const lib = u.protocol === 'http:' ? http : https;
    const opts = {
      method: methode,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'Mergerie/health' },
    };
    if (u.protocol === 'https:' && tlsAgent()) opts.agent = tlsAgent();
    const req = lib.request(opts, (res) => {
      const code = res.statusCode;
      const suivant = res.headers && res.headers.location;
      res.destroy();                       // on ne lit RIEN du corps
      if (code >= 300 && code < 400 && suivant && sauts < 3) {
        let cible;
        try { cible = new URL(suivant, url).toString(); } catch { resolve(code); return; }
        tete(cible, methode, sauts + 1).then(resolve, reject);
        return;
      }
      resolve(code);
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => {
      const err = new Error('timeout');
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.end();
  });
}

/* `HEAD` d'abord : on veut savoir si ça répond, pas ce que ça répond. Beaucoup de serveurs
   refusent HEAD par un 405 : on retombe alors sur GET, une seule fois, pour ne pas conclure
   « down » sur une simple question de méthode. */
async function verifierUne(url) {
  const t0 = Date.now();
  try {
    let code = await tete(url, 'HEAD');
    if (code === 405 || code === 501) code = await tete(url, 'GET');
    return {
      status: code >= 200 && code < 400 ? 'up' : 'down',
      http_code: code,
      latency_ms: Date.now() - t0,
    };
  } catch {
    // Injoignable, TLS refusé, délai dépassé : du point de vue de qui clique, c'est pareil.
    return { status: 'down', http_code: null, latency_ms: Date.now() - t0 };
  }
}

async function cycle() {
  const liste = cibles();
  const ecrire = db.prepare(`INSERT INTO health_status
      (service_id, environment_id, status, http_code, latency_ms, checked_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(service_id, environment_id) DO UPDATE SET
      status = excluded.status, http_code = excluded.http_code,
      latency_ms = excluded.latency_ms, checked_at = excluded.checked_at`);
  let up = 0;
  let down = 0;
  for (const c of liste) {
    const r = await verifierUne(c.url);       // séquentiel : voir l'en-tête
    ecrire.run(c.service_id, c.environment_id, r.status, r.http_code, r.latency_ms, new Date().toISOString());
    if (r.status === 'up') up += 1; else down += 1;
  }
  /* Une case dont l'environnement n'est plus vérifié garderait un vieux verdict à l'écran.
     On efface plutôt que de laisser un « up » d'il y a trois semaines passer pour frais. */
  db.prepare(`DELETE FROM health_status WHERE environment_id NOT IN
    (SELECT id FROM environment WHERE health_check = 1)`).run();
  return { checked: liste.length, up, down };
}

/* Le minuteur. `lireConfig` rend la config à chaque passage — activer ou changer l'intervalle
   ne demande donc pas de redémarrer. `clientVu` dit quand un navigateur s'est manifesté pour
   la dernière fois : sans client, on ne sort pas sur le réseau. */
function demarrer(lireConfig, clientVu, onLog = () => {}) {
  const passe = async () => {
    try {
      const cfg = lireConfig() || {};
      if (String(cfg.health_check) !== '1') return;
      if (Date.now() - clientVu() > CLIENT_VIVANT_MS) return;   // personne ne regarde
      const r = await cycle();
      if (r.checked) onLog(`santé : ${r.up} up, ${r.down} down (${r.checked} vérifiées)`);
    } catch (e) { onLog(`santé : ${e.message}`); }                // jamais bloquant
  };
  /* Le minuteur bat à la MINUTE et décide lui-même s'il est temps : changer l'intervalle
     dans les réglages prend effet au prochain battement, sans redémarrage ni reconstruction. */
  let dernier = 0;
  const t = setInterval(() => {
    const cfg = lireConfig() || {};
    const minutes = Math.max(MIN_MINUTES, Number(cfg.health_minutes) || 5);
    if (Date.now() - dernier < minutes * 60_000) return;
    dernier = Date.now();
    passe();
  }, 60_000);
  if (t.unref) t.unref();
  return t;
}

module.exports = { cycle, verifierUne, demarrer, TIMEOUT_MS, MIN_MINUTES, CLIENT_VIVANT_MS };
