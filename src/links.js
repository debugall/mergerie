'use strict';
/* Liens — la grille services × environnements, les liens libres, la palette et l'import.
 *
 * Ce module ne contient QUE de la logique et des requêtes : pas de route, pas de rendu.
 * Quatre décisions y sont figées, et méritent d'être lues avant d'y toucher.
 *
 * 1. UNE URL PAR CASE, ÉCRITE. On aurait pu déduire l'URL de preprod de celle de dev en
 *    remplaçant un morceau de domaine. C'est exactement la magie qui envoie un jour sur le
 *    mauvais environnement sans prévenir — et un lien qui trompe est pire que pas de lien.
 *
 * 2. `http(s)` UNIQUEMENT, partout. Ces URLs sont ouvertes d'un clic depuis l'application ;
 *    `javascript:` et `data:` n'ont rien à y faire, même saisis par l'utilisateur lui-même.
 *
 * 3. LES GABARITS NE CONNAISSENT QUE QUATRE VARIABLES, refusées à la saisie si elles sont
 *    inconnues. Une faute de frappe (`{brench}`) doit se voir au moment où on l'écrit, pas
 *    produire une URL cassée trois semaines plus tard. Et chaque valeur substituée est
 *    URL-ENCODÉE : une branche `feat/x?y=1` ne fabrique pas une URL surprise.
 *
 * 4. LA FRÉCENCE, pas la fréquence. Un compteur seul ferait remonter à vie ce qu'on a
 *    beaucoup ouvert le mois dernier ; une date seule perdrait ce qu'on ouvre chaque jour
 *    depuis un an. `uses / (1 + jours)` mélange les deux, et tient en une ligne.
 */

const db = require('./db');

const MAX_LABEL = 100;
const MAX_TAG = 30;
const MAX_TAGS = 10;
const MAX_URL = 2000;
// 5 Mo : un export de marque-pages, même fourni, pèse quelques centaines de kilo-octets.
const MAX_IMPORT = 5 * 1024 * 1024;
const JOUR_MS = 24 * 60 * 60 * 1000;

// Les seules variables qu'un gabarit peut porter. Toute autre est refusée à la saisie.
const VARIABLES = ['env', 'branch', 'mr_iid', 'service'];

const nowIso = () => new Date().toISOString();

function erreur(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* ------------------------------------------------------------- validations ---- */

function lireLabel(v, msgVide) {
  const s = String(v == null ? '' : v).trim().slice(0, MAX_LABEL);
  if (!s) throw erreur(msgVide);
  return s;
}

/* Une URL absolue en http(s), et rien d'autre. `new URL()` fait le gros du travail : il
   refuse ce qui n'est pas une URL, et nous laisse juger le protocole. */
function lireUrl(v, msgInvalide) {
  const s = String(v == null ? '' : v).trim().slice(0, MAX_URL);
  let u;
  try { u = new URL(s); } catch { throw erreur(msgInvalide); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw erreur(msgInvalide);
  return s;
}

/* Les tags sont normalisés à la saisie — minuscules, sans accent, sans espace — sinon
   « Travail », « travail » et « travail » (avec une espace insécable) feraient trois filtres
   distincts pour la même idée. */
function normaliserTag(v) {
  return String(v == null ? '' : v)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, MAX_TAG);
}

function lireTags(v, msgTrop) {
  const brut = Array.isArray(v) ? v : String(v == null ? '' : v).split(',');
  const out = [];
  for (const t of brut) {
    const n = normaliserTag(t);
    if (n && !out.includes(n)) out.push(n);
  }
  if (out.length > MAX_TAGS) throw erreur(msgTrop);
  return out;
}

const litTags = (json) => { try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

/* Un gabarit : on vérifie que TOUTES les variables citées sont connues. Le message rend la
   liste des variables valides — se faire refuser sans savoir quoi écrire est le meilleur
   moyen de renoncer. */
function lireTemplate(v, msgVide, msgVariable) {
  const s = String(v == null ? '' : v).trim().slice(0, MAX_URL);
  if (!s) throw erreur(msgVide);
  const inconnues = [...s.matchAll(/\{([a-z_]+)\}/gi)]
    .map((m) => m[1])
    .filter((n) => !VARIABLES.includes(n));
  if (inconnues.length) throw erreur(msgVariable(inconnues[0], VARIABLES));
  /* Le protocole se juge sur le gabarit AVEC ses variables encore en place : `{env}` dans
     l'hôte est légitime, et `new URL()` sait déjà lire `https://kibana-{env}.corp/…`. */
  if (!/^https?:\/\//i.test(s)) throw erreur(msgVide);
  return s;
}

/* Résout un gabarit. Rend `null` dès qu'une variable manque : mieux vaut un bouton grisé
   qui dit pourquoi qu'une URL à trous menant sur une page d'erreur. */
function resoudreTemplate(gabarit, valeurs = {}) {
  let manquante = null;
  const url = String(gabarit || '').replace(/\{([a-z_]+)\}/gi, (m, nom) => {
    const v = valeurs[nom];
    if (v == null || v === '') { manquante = manquante || nom; return m; }
    // URL-encodage systématique : une branche `feat/x?y=1` ne doit pas ouvrir de paramètre.
    return encodeURIComponent(String(v));
  });
  return manquante ? { url: null, manquante } : { url, manquante: null };
}

/* ----------------------------------------------------- environnements ---- */

const listerEnvironnements = () => db.prepare('SELECT * FROM environment ORDER BY position, id').all();

function creerEnvironnement(body = {}, msgs) {
  const name = lireLabel(body.name, msgs.nomVide);
  if (db.prepare('SELECT 1 FROM environment WHERE name = ?').get(name)) throw erreur(msgs.nomPris);
  const suivant = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM environment').get().p;
  const pos = Number.isFinite(Number(body.position)) && body.position !== '' ? Number(body.position) : suivant;
  const info = db.prepare(`INSERT INTO environment (name, position, color, created_at)
    VALUES (?,?,?,?)`).run(name, pos, lireCouleur(body.color), nowIso());
  return db.prepare('SELECT * FROM environment WHERE id = ?').get(info.lastInsertRowid);
}

// Une couleur d'en-tête, en hexadécimal : elle finit dans un attribut `style`.
const lireCouleur = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : '#2f6fe0');

function majEnvironnement(id, patch = {}, msgs) {
  const env = db.prepare('SELECT * FROM environment WHERE id = ?').get(Number(id) || 0);
  if (!env) throw erreur(msgs.inconnu, 404);
  const champs = [];
  const vals = [];
  if (patch.name !== undefined) {
    const n = lireLabel(patch.name, msgs.nomVide);
    const autre = db.prepare('SELECT 1 FROM environment WHERE name = ? AND id <> ?').get(n, env.id);
    if (autre) throw erreur(msgs.nomPris);
    champs.push('name = ?'); vals.push(n);
  }
  if (patch.position !== undefined) { champs.push('position = ?'); vals.push(Number(patch.position) || 0); }
  if (patch.color !== undefined) { champs.push('color = ?'); vals.push(lireCouleur(patch.color)); }
  if (champs.length) db.prepare(`UPDATE environment SET ${champs.join(', ')} WHERE id = ?`).run(...vals, env.id);
  return db.prepare('SELECT * FROM environment WHERE id = ?').get(env.id);
}

/* Déplacer une colonne d'un cran. L'ordre des environnements est celui qu'on leur donne, et
   jusqu'ici on ne pouvait plus le corriger : une prod créée avant la preprod restait mal
   placée pour toujours.

   On RENUMÉROTE d'abord de 1 à n dans l'ordre courant, puis on échange deux voisins. Le
   détour paraît inutile, il ne l'est pas : deux environnements créés dans la même seconde
   peuvent porter la même `position`, et un échange direct entre deux valeurs égales ne
   changerait rien — le bouton semblerait cassé. Renuméroter d'abord rend le geste
   toujours vrai, quel que soit l'état d'où l'on part.

   Le tout dans une transaction : à mi-chemin, deux colonnes portent le même numéro, et
   personne ne doit voir cet instant-là. */
function deplacerEnvironnement(id, dir, msgs) {
  const env = db.prepare('SELECT 1 FROM environment WHERE id = ?').get(Number(id) || 0);
  if (!env) throw erreur(msgs.inconnu, 404);
  const sens = Number(dir) < 0 ? -1 : 1;
  let bouge = false;
  db.transaction(() => {
    const maj = db.prepare('UPDATE environment SET position = ? WHERE id = ?');
    const ordre = db.prepare('SELECT id FROM environment ORDER BY position, id').all().map((e) => e.id);
    ordre.forEach((eid, i) => maj.run(i + 1, eid));
    const i = ordre.indexOf(Number(id));
    const j = i + sens;
    // Au bout de la rangée : rien à faire, et ce n'est pas une faute — le bouton reste là.
    if (j < 0 || j >= ordre.length) return;
    maj.run(j + 1, ordre[i]);
    maj.run(i + 1, ordre[j]);
    bouge = true;
  })();
  return { ok: true, moved: bouge };
}

function supprimerEnvironnement(id, msgs) {
  const env = db.prepare('SELECT 1 FROM environment WHERE id = ?').get(Number(id) || 0);
  if (!env) throw erreur(msgs.inconnu, 404);
  db.prepare('DELETE FROM environment WHERE id = ?').run(Number(id));
  return { ok: true };
}

/* ---------------------------------------------------------- services ---- */

const lireService = (id) => db.prepare('SELECT * FROM service WHERE id = ?').get(Number(id) || 0);

/* `body.urls` est FACULTATIF, mais c'est lui qui fait la différence entre créer un service et
   créer un service UTILISABLE. Sans lui, enregistrer rendait une ligne vide qu'il fallait
   ensuite retrouver dans la grille pour la remplir case par case. Tout ou rien : une URL
   invalide au milieu ne doit pas laisser un service à moitié rempli derrière elle. */
function creerService(body = {}, msgs) {
  const name = lireLabel(body.name, msgs.nomVide);
  if (db.prepare('SELECT 1 FROM service WHERE name = ?').get(name)) throw erreur(msgs.nomPris);
  const urls = Array.isArray(body.urls) ? body.urls.filter((u) => u && String(u.url || '').trim()) : [];
  let id = 0;
  db.transaction(() => {
    const info = db.prepare('INSERT INTO service (name, repo_id, tags, pinned, created_at) VALUES (?,?,?,?,?)')
      .run(name, lireRepoId(body.repo_id), JSON.stringify(lireTags(body.tags, msgs.tropDeTags)), body.pinned ? 1 : 0, nowIso());
    id = info.lastInsertRowid;
    /* Regroupées PAR ENVIRONNEMENT avant d'être posées : `poserUrl` remplace la case entière,
       donc deux adresses du même environnement envoyées séparément ne laisseraient que la
       seconde. */
    const parEnv = new Map();
    for (const u of urls) {
      const e = Number(u.environment_id) || 0;
      if (!parEnv.has(e)) parEnv.set(e, []);
      parEnv.get(e).push({ label: u.label, url: u.url });
    }
    for (const [e, liste] of parEnv) poserUrl(id, { environment_id: e, urls: liste }, msgs);
  })();
  return lireService(id);
}

// Un dépôt inexistant ne se rattache pas : la colonne accepte NULL, autant y mettre NULL.
const lireRepoId = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return db.prepare('SELECT 1 FROM repo WHERE id = ?').get(n) ? n : null;
};

function majService(id, patch = {}, msgs) {
  const s = lireService(id);
  if (!s) throw erreur(msgs.inconnu, 404);
  const champs = [];
  const vals = [];
  if (patch.name !== undefined) {
    const n = lireLabel(patch.name, msgs.nomVide);
    if (db.prepare('SELECT 1 FROM service WHERE name = ? AND id <> ?').get(n, s.id)) throw erreur(msgs.nomPris);
    champs.push('name = ?'); vals.push(n);
  }
  if (patch.repo_id !== undefined) { champs.push('repo_id = ?'); vals.push(lireRepoId(patch.repo_id)); }
  if (patch.tags !== undefined) { champs.push('tags = ?'); vals.push(JSON.stringify(lireTags(patch.tags, msgs.tropDeTags))); }
  if (patch.pinned !== undefined) { champs.push('pinned = ?'); vals.push(patch.pinned ? 1 : 0); }
  if (champs.length) db.prepare(`UPDATE service SET ${champs.join(', ')} WHERE id = ?`).run(...vals, s.id);
  return lireService(s.id);
}

function supprimerService(id, msgs) {
  if (!lireService(id)) throw erreur(msgs.inconnu, 404);
  db.prepare('DELETE FROM service WHERE id = ?').run(Number(id));
  return { ok: true };
}

/* Poser le contenu d'une case. La case porte une LISTE d'adresses : un même service au même
   endroit expose souvent plusieurs vues — un Kibana de production, ce sont autant d'adresses
   que de filtres enregistrés. Chacune porte un libellé, sans quoi la seconde serait
   indiscernable de la première dans la liste.

   REMPLACEMENT INTÉGRAL, et non ajout : l'appelant envoie la case telle qu'elle doit être.
   C'est ce qui permet à un champ vidé d'effacer la case, à une ligne retirée de disparaître,
   et à l'ordre affiché d'être celui qu'on a posé — trois gestes qu'un « ajouter » séparé
   aurait fallu inventer un par un.

   `{ url }` seul reste accepté : c'est la saisie rapide dans la case, une adresse sans nom. */
function poserUrl(serviceId, body = {}, msgs) {
  if (!lireService(serviceId)) throw erreur(msgs.inconnu, 404);
  const envId = Number(body.environment_id) || 0;
  if (!db.prepare('SELECT 1 FROM environment WHERE id = ?').get(envId)) throw erreur(msgs.envInconnu, 404);

  const brut = Array.isArray(body.urls) ? body.urls : [{ label: body.label, url: body.url }];
  const propres = brut
    .map((u) => ({ label: String((u && u.label) || '').trim().slice(0, MAX_LABEL), url: String((u && u.url) || '').trim() }))
    .filter((u) => u.url);
  const lignes = propres.map((u) => ({ label: u.label, url: lireUrl(u.url, msgs.urlInvalide) }));

  db.transaction(() => {
    db.prepare('DELETE FROM service_url WHERE service_id = ? AND environment_id = ?').run(Number(serviceId), envId);
    const ins = db.prepare('INSERT INTO service_url (service_id, environment_id, label, url, position) VALUES (?,?,?,?,?)');
    lignes.forEach((u, i) => ins.run(Number(serviceId), envId, u.label, u.url, i));
  })();
  return { ok: true, urls: lignes };
}

// Les adresses d'une case, dans l'ordre posé.
const casesDe = (serviceId) => db.prepare(`SELECT id, environment_id, label, url FROM service_url
  WHERE service_id = ? ORDER BY environment_id, position, id`).all(Number(serviceId) || 0);

/* ------------------------------------------------- liens contextuels ---- */

const listerContextLinks = (serviceId) => db.prepare('SELECT * FROM context_link WHERE service_id = ? ORDER BY id').all(Number(serviceId) || 0);

function creerContextLink(serviceId, body = {}, msgs) {
  if (!lireService(serviceId)) throw erreur(msgs.inconnu, 404);
  const info = db.prepare('INSERT INTO context_link (service_id, label, url_template) VALUES (?,?,?)')
    .run(Number(serviceId), lireLabel(body.label, msgs.labelVide),
      lireTemplate(body.url_template, msgs.templateVide, msgs.variableInconnue));
  return db.prepare('SELECT * FROM context_link WHERE id = ?').get(info.lastInsertRowid);
}

function supprimerContextLink(id, msgs) {
  const l = db.prepare('SELECT 1 FROM context_link WHERE id = ?').get(Number(id) || 0);
  if (!l) throw erreur(msgs.inconnu, 404);
  db.prepare('DELETE FROM context_link WHERE id = ?').run(Number(id));
  return { ok: true };
}

/* ---------------------------------------------------- liens libres ---- */

function listerFreeLinks({ q = '', tag = '' } = {}) {
  const rows = db.prepare('SELECT * FROM free_link ORDER BY label COLLATE NOCASE').all()
    .map((r) => ({ ...r, tags: litTags(r.tags) }));
  const s = String(q || '').trim().toLowerCase();
  const t = normaliserTag(tag);
  return rows.filter((r) => (!t || r.tags.includes(t))
    && (!s || r.label.toLowerCase().includes(s) || r.url.toLowerCase().includes(s)
      || r.tags.some((x) => x.includes(s))));
}

function creerFreeLink(body = {}, msgs) {
  const info = db.prepare('INSERT INTO free_link (label, url, tags, created_at) VALUES (?,?,?,?)')
    .run(lireLabel(body.label, msgs.labelVide), lireUrl(body.url, msgs.urlInvalide),
      JSON.stringify(lireTags(body.tags, msgs.tropDeTags)), nowIso());
  return db.prepare('SELECT * FROM free_link WHERE id = ?').get(info.lastInsertRowid);
}

function majFreeLink(id, patch = {}, msgs) {
  const l = db.prepare('SELECT * FROM free_link WHERE id = ?').get(Number(id) || 0);
  if (!l) throw erreur(msgs.inconnu, 404);
  const champs = [];
  const vals = [];
  if (patch.label !== undefined) { champs.push('label = ?'); vals.push(lireLabel(patch.label, msgs.labelVide)); }
  if (patch.url !== undefined) { champs.push('url = ?'); vals.push(lireUrl(patch.url, msgs.urlInvalide)); }
  if (patch.tags !== undefined) { champs.push('tags = ?'); vals.push(JSON.stringify(lireTags(patch.tags, msgs.tropDeTags))); }
  if (champs.length) db.prepare(`UPDATE free_link SET ${champs.join(', ')} WHERE id = ?`).run(...vals, l.id);
  const maj = db.prepare('SELECT * FROM free_link WHERE id = ?').get(l.id);
  return { ...maj, tags: litTags(maj.tags) };
}

function supprimerFreeLink(id, msgs) {
  if (!db.prepare('SELECT 1 FROM free_link WHERE id = ?').get(Number(id) || 0)) throw erreur(msgs.inconnu, 404);
  db.prepare('DELETE FROM free_link WHERE id = ?').run(Number(id));
  return { ok: true };
}

/* Tout effacer d'un coup. C'est la sortie de secours d'un import de marque-pages : on en
   déverse deux cents, on constate que ce n'était pas ce qu'on voulait, et les supprimer un par
   un serait deux cents confirmations. Le nombre supprimé est RENDU — l'appelant s'en sert pour
   demander confirmation avant, et pour dire ce qui s'est passé après ; un « c'est fait » sans
   chiffre laisserait douter de ce qui vient de disparaître.

   Ne touche QUE les liens libres : la grille, ses services et ses URLs ne sont pas concernés. */
function supprimerTousFreeLinks() {
  const n = db.prepare('SELECT COUNT(*) c FROM free_link').get().c;
  db.prepare('DELETE FROM free_link').run();
  return { ok: true, deleted: n };
}

/* Convertit des liens libres en un service : une ligne par lien, affectée à un
   environnement. C'est le geste d'APRÈS l'import — explicite, et non une devinette faite
   à l'import sur des noms de dossiers. */
/* TOUT OU RIEN. Un environnement supprimé entre l'ouverture de la modale et le clic faisait
   échouer `poserUrl` en plein milieu : le service existait avec une partie de ses URLs,
   quelques liens libres avaient déjà disparu, et rejouer butait sur « nom déjà pris ».
   La transaction rend l'échec propre — on retrouve exactement l'état d'avant. */
function convertirEnService(body = {}, msgs) {
  let service = null;
  let faits = 0;
  const trans = db.transaction((mapping) => {
    service = creerService({ name: body.name, repo_id: body.repo_id, tags: body.tags }, msgs);
    for (const m of mapping) {
      const lien = db.prepare('SELECT * FROM free_link WHERE id = ?').get(Number(m.free_link_id) || 0);
      if (!lien) continue;
      poserUrl(service.id, { environment_id: m.environment_id, url: lien.url }, msgs);
      // Le lien libre disparaît : le garder en double ferait deux entrées pour la même adresse.
      db.prepare('DELETE FROM free_link WHERE id = ?').run(lien.id);
      faits += 1;
    }
  });
  trans(Array.isArray(body.mapping) ? body.mapping : []);
  return { service, convertis: faits };
}

/* ------------------------------------------------------------ grille ---- */

function grille() {
  const envs = listerEnvironnements();
  const services = db.prepare(`SELECT s.*, r.project FROM service s
    LEFT JOIN repo r ON r.id = s.repo_id
    ORDER BY s.pinned DESC, s.name COLLATE NOCASE`).all();
  const urls = db.prepare('SELECT * FROM service_url ORDER BY position, id').all();
  const ctx = db.prepare('SELECT service_id, COUNT(*) n FROM context_link GROUP BY service_id').all();

  /* `urls[envId]` est une LISTE, même à un seul élément : un client qui doit traiter deux
     formes selon le nombre finit toujours par en oublier une. */
  const parService = new Map();
  for (const u of urls) {
    if (!parService.has(u.service_id)) parService.set(u.service_id, {});
    const par = parService.get(u.service_id);
    (par[u.environment_id] = par[u.environment_id] || []).push({ id: u.id, label: u.label, url: u.url });
  }
  const ctxParService = new Map(ctx.map((c) => [c.service_id, c.n]));

  return {
    environments: envs,
    services: services.map((s) => ({
      ...s,
      tags: litTags(s.tags),
      urls: parService.get(s.id) || {},
      context_links: ctxParService.get(s.id) || 0,
    })),
    free_links: listerFreeLinks(),
    // Tous les tags en usage, pour les puces de filtre — sans les recalculer côté client.
    tags: [...new Set([
      ...services.flatMap((s) => litTags(s.tags)),
      ...db.prepare('SELECT tags FROM free_link').all().flatMap((r) => litTags(r.tags)),
    ])].sort(),
  };
}

/* ------------------------------------------- liens contextuels d'une MR ---- */

/* Les boutons à poser sur le détail d'une merge request : les URLs de grille du service lié
   au dépôt, plus ses gabarits résolus. Un gabarit non résoluble donne un bouton GRISÉ avec
   sa raison — pas une URL à trous, pas un bouton absent : on veut savoir qu'il existe et
   pourquoi il ne marche pas ici. */
function liensDeMr(mr) {
  if (!mr || !mr.repo_id) return { service: null, envs: [], context: [] };
  const service = db.prepare('SELECT * FROM service WHERE repo_id = ? ORDER BY id LIMIT 1').get(mr.repo_id);
  if (!service) return { service: null, envs: [], context: [] };

  const envs = listerEnvironnements();
  const parEnv = new Map();
  for (const u of casesDe(service.id)) {
    if (!parEnv.has(u.environment_id)) parEnv.set(u.environment_id, []);
    parEnv.get(u.environment_id).push(u);
  }
  /* Un bouton PAR ADRESSE : une case qui en porte trois donne trois boutons, chacun nommé.
     N'en montrer qu'un obligerait à deviner lequel, et le libellé existe pour ça. */
  const cases = envs.filter((e) => parEnv.has(e.id)).flatMap((e) => parEnv.get(e.id)
    .map((u) => ({ environment_id: e.id, env: e.name, color: e.color, url: u.url, label: u.label })));

  const valeursCommunes = { branch: mr.source_branch, mr_iid: mr.iid, service: service.name };
  const context = listerContextLinks(service.id).map((c) => {
    const parEnvRes = cases.map((k) => {
      const r = resoudreTemplate(c.url_template, { ...valeursCommunes, env: k.env });
      return { env: k.env, color: k.color, url: r.url, manquante: r.manquante };
    });
    /* Le gabarit ne cite pas `{env}` : il ne dépend pas de l'environnement, un seul bouton
       suffit — en proposer un par environnement donnerait N fois la même URL. */
    const sansEnv = !/\{env\}/i.test(c.url_template);
    const direct = sansEnv ? resoudreTemplate(c.url_template, valeursCommunes) : null;
    return {
      id: c.id,
      label: c.label,
      per_env: sansEnv ? [] : parEnvRes,
      url: direct ? direct.url : null,
      /* Sans AUCUNE case remplie, `per_env` est vide et rien ne peut dire quelle variable
         manque : la coupable est alors `{env}` lui-même, faute d'environnement où aller.
         Sans ce repli, l'info-bulle du bouton grisé annonçait « {null} ». */
      manquante: direct ? direct.manquante
        : ((parEnvRes.find((x) => x.manquante) || {}).manquante || (cases.length ? null : 'env')),
    };
  });
  return { service: { id: service.id, name: service.name }, envs: cases, context };
}

/* ---------------------------------------------------------- frécence ---- */

/* `uses / (1 + jours depuis le dernier usage)`. Assez simple pour se relire, assez juste
   pour que ce qu'on ouvre chaque matin passe devant ce qu'on a ouvert vingt fois en mars. */
function frecence(row, maintenant = Date.now()) {
  if (!row) return 0;
  const jours = Math.max(0, (maintenant - new Date(row.last_used_at).getTime()) / JOUR_MS);
  return (row.uses || 0) / (1 + jours);
}

function noterUsage(kind, ref) {
  const k = String(kind || '').slice(0, 40);
  const r = String(ref == null ? '' : ref).slice(0, 200);
  if (!k || !r) return { ok: false };
  db.prepare(`INSERT INTO launcher_usage (kind, ref, uses, last_used_at) VALUES (?,?,1,?)
    ON CONFLICT(kind, ref) DO UPDATE SET uses = uses + 1, last_used_at = excluded.last_used_at`)
    .run(k, r, nowIso());
  return { ok: true };
}

const usages = () => {
  const m = new Map();
  for (const u of db.prepare('SELECT * FROM launcher_usage').all()) m.set(`${u.kind}:${u.ref}`, u);
  return m;
};

/* ------------------------------------------------------- fuzzy match ---- */

const sansAccent = (s) => String(s == null ? '' : s)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/* LA MÊME FONCTION, CÔTÉ SQL. Le pré-filtre de la palette compare la requête — déjà dénudée
   de ses accents — à des valeurs qui, elles, les ont gardés : sans ça, `LIKE '%generation%'`
   ne trouvait pas « Génération du rapport », et le taper AVEC l'accent échouait tout autant,
   puisque la requête est dénudée avant la comparaison. Dans une application dont les titres
   de merge requests, de notes et de todos sont largement en français, cela revenait à ne plus
   rien trouver. Elle est enregistrée ici, à côté de sa jumelle en JavaScript : les deux côtés
   du `LIKE` doivent normaliser pareil, et une seule définition ne peut pas dériver. */
db.function('sans_accent', { deterministic: true }, (v) => (v == null ? null : sansAccent(v)));

/* Chaque mot de la requête doit se retrouver dans la cible, en SOUS-SÉQUENCE : « kib pre »
   trouve « Kibana · preprod ». On note mieux ce qui commence un mot — taper « api » doit
   remonter « api-core » avant « rapidité », qui contient pourtant les mêmes lettres. */
function scoreFuzzy(texte, requete) {
  const cible = sansAccent(texte);
  const mots = sansAccent(requete).split(/\s+/).filter(Boolean);
  if (!mots.length) return 1;
  let total = 0;
  for (const mot of mots) {
    const exact = cible.indexOf(mot);
    if (exact >= 0) {
      const debutDeMot = exact === 0 || /[^a-z0-9]/.test(cible[exact - 1]);
      total += debutDeMot ? 3 : 2;
      continue;
    }
    /* Sous-séquence : les lettres dans l'ordre, pas forcément contiguës — mais PROCHES.
       Sans contrainte d'étalement, « api » se retrouve dans presque n'importe quelle phrase
       française (formAt, Point, archI) et la palette se remplit de faux positifs qui
       chassent les vrais. On exige que les lettres tiennent dans une fenêtre de quatre fois
       la longueur du mot : « kib » trouve « Kibana », pas « quelque chose bien ». */
    let i = 0;
    let debut = -1;
    let fin = -1;
    for (let k = 0; k < cible.length && i < mot.length; k += 1) {
      if (cible[k] !== mot[i]) continue;
      if (debut < 0) debut = k;
      fin = k;
      i += 1;
    }
    if (i < mot.length) return 0;              // un mot absent = pas de résultat
    if (fin - debut > mot.length * 4) return 0;
    total += 1;
  }
  return total / mots.length;
}

/* ------------------------------------------------- palette (launcher) ---- */

/* Toutes les sources en SQL, à la demande — aucun index en mémoire à tenir à jour, donc rien
   à réconcilier quand une MR arrive ou qu'une note change.

   LE PRÉ-FILTRE EST EN SQL, ET C'EST LE POINT. Chaque source est plafonnée pour qu'un dépôt à
   mille merge requests ne noie pas les liens que la palette existe pour retrouver. Mais tant
   que ce plafond s'appliquait AVANT la recherche, il ne rendait que les lignes les plus
   récentes et le flou ne voyait jamais les autres : taper `!214` sur une merge request un peu
   ancienne ne rendait RIEN, sans un mot — de quoi conclure que la palette est cassée.

   D'où un `LIKE` par mot, en SQL : grossier, mais il ne laisse rien de côté. Le flou affine
   ensuite sur ce qui reste, et le plafond redevient ce qu'il aurait toujours dû être — un
   garde-fou contre une réponse démesurée, pas un filtre sur ce qui est cherchable. */
const PAR_SOURCE = 30;
const TOTAL = 12;

/* Une condition SQL par mot de la requête, chacun pouvant tomber dans n'importe laquelle des
   colonnes citées. Rend `{ cond, args }` — `cond` vide quand il n'y a pas de requête, la
   palette s'ouvrant alors sur les entrées les plus récentes.
   Le `%` et le `_` d'une saisie sont ÉCHAPPÉS : sans cela, taper « % » ramènerait tout.
   CONTIGU PAR MOT, ET C'EST DÉLIBÉRÉ. Le flou accepte les lettres d'un mot à trous (« kbana »
   pour « Kibana ») ; le pré-filtre, non — il exige le fragment entier. Le traduire fidèlement
   donnerait `%k%b%a%n%a%` ; mesuré sur mille titres de merge requests en français, « pre »
   toucherait alors 622 lignes au lieu de 190, et le plafond par source recouperait AVANT que
   la contrainte d'étalement du flou n'ait pu trier — soit exactement le défaut que ce
   pré-filtre existe pour corriger. On abrège donc par MOTS (« kib pre » trouve
   « Kibana · preprod », chaque mot étant un fragment), pas en sautant des lettres. */
function preFiltre(requete, colonnes) {
  const mots = sansAccent(requete).split(/\s+/).filter(Boolean);
  if (!mots.length) return { cond: '', args: [] };
  const args = [];
  const groupes = mots.map((mot) => {
    const like = `%${mot.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const ors = colonnes.map((c) => { args.push(like); return `sans_accent(${c}) LIKE ? ESCAPE '\\'`; });
    return `(${ors.join(' OR ')})`;
  });
  return { cond: groupes.join(' AND '), args };
}

function launcher(q, { jiraConfigure = false, actions = [] } = {}) {
  const requete = String(q || '').trim();
  const use = usages();
  const out = [];
  const pousser = (o) => out.push(o);

  // 1. Liens — les cases de la grille, puis les liens libres.
  /* UNE ENTRÉE PAR ADRESSE, libellé compris : une case qui porte « erreurs paiement » et
     « latence API » doit se trouver par ces mots-là, pas seulement par le nom du service. */
  const fCase = preFiltre(requete, ['s.name', 'e.name', 'u.url', 'u.label']);
  for (const r of db.prepare(`SELECT s.id sid, s.name service, e.id eid, e.name env, u.id uid, u.label, u.url
      FROM service_url u JOIN service s ON s.id = u.service_id JOIN environment e ON e.id = u.environment_id
      ${fCase.cond ? `WHERE ${fCase.cond}` : ''}
      ORDER BY s.name, e.position, u.position, u.id LIMIT ?`).all(...fCase.args, PAR_SOURCE * 4)) {
    pousser({
      /* La FRÉCENCE se compte par adresse (`sid:eid:uid`) et non par case : sur un Kibana de
         production, on ouvre toujours les deux mêmes filtres sur les dix enregistrés. */
      kind: 'service_url', ref: `${r.sid}:${r.eid}:${r.uid}`, group: 'links',
      label: `${r.service} · ${r.env}${r.label ? ` — ${r.label}` : ''}`, detail: r.url, url: r.url,
      texte: `${r.service} ${r.env} ${r.label || ''}`,
    });
  }
  const fLibre = preFiltre(requete, ['label', 'url', 'tags']);
  for (const r of db.prepare(`SELECT * FROM free_link ${fLibre.cond ? `WHERE ${fLibre.cond}` : ''}
      ORDER BY label COLLATE NOCASE LIMIT ?`).all(...fLibre.args, PAR_SOURCE * 2)) {
    const tags = litTags(r.tags);
    pousser({
      kind: 'free_link', ref: String(r.id), group: 'links',
      label: r.label, detail: tags.join(' · ') || r.url, url: r.url,
      texte: `${r.label} ${tags.join(' ')}`,
    });
  }

  /* 2. Merge requests — par NUMÉRO ou par mots du titre. Le numéro passe par une égalité et
     non par un `LIKE` : `!214` ne se retrouve ni dans un titre ni dans un nom de projet, et
     c'est pourtant la façon la plus courante de désigner une merge request. */
  const fMr = preFiltre(requete, ['m.title', 'p.project']);
  const iid = parseInt(String(requete).replace(/^!/, ''), 10);
  const parNum = Number.isFinite(iid);
  const condMr = fMr.cond
    ? (parNum ? `WHERE (m.iid = ? OR (${fMr.cond}))` : `WHERE ${fMr.cond}`)
    : '';
  const argsMr = condMr ? (parNum ? [iid, ...fMr.args] : fMr.args) : [];
  for (const r of db.prepare(`SELECT m.id, m.iid, m.title, m.status, p.project FROM mr m
      JOIN repo p ON p.id = m.repo_id ${condMr} ORDER BY m.id DESC LIMIT ?`)
    .all(...argsMr, PAR_SOURCE * 3)) {
    pousser({
      kind: 'mr', ref: String(r.id), group: 'mrs',
      label: `!${r.iid} — ${r.title || ''}`, detail: r.project,
      nav: { tab: 'review', mr_id: r.id, status: r.status },
      texte: `!${r.iid} ${r.iid} ${r.title || ''} ${r.project}`,
    });
  }

  // 3. Tickets surveillés — la seule liste de tickets que le serveur connaisse hors ligne.
  if (jiraConfigure) {
    const fTicket = preFiltre(requete, ['key', 'summary']);
    for (const r of db.prepare(`SELECT * FROM jira_watch ${fTicket.cond ? `WHERE ${fTicket.cond}` : ''}
        ORDER BY key LIMIT ?`).all(...fTicket.args, PAR_SOURCE)) {
      pousser({
        kind: 'ticket', ref: r.key, group: 'tickets',
        label: `${r.key} — ${r.summary || ''}`, detail: r.status || '',
        nav: { tab: 'jira', ticket: r.key },
        texte: `${r.key} ${r.summary || ''}`,
      });
    }
  }

  // 4. Pages de notes et todos ouvertes.
  const fNote = preFiltre(requete, ['title']);
  for (const r of db.prepare(`SELECT id, title FROM note_page ${fNote.cond ? `WHERE ${fNote.cond}` : ''}
      ORDER BY updated_at DESC LIMIT ?`).all(...fNote.args, PAR_SOURCE)) {
    pousser({
      kind: 'note', ref: String(r.id), group: 'notes',
      label: r.title, detail: '', nav: { tab: 'notes', page_id: r.id }, texte: r.title,
    });
  }
  const fTodo = preFiltre(requete, ['title']);
  for (const r of db.prepare(`SELECT id, title FROM todo
      WHERE status = 'open' AND archived_at IS NULL ${fTodo.cond ? `AND (${fTodo.cond})` : ''}
      ORDER BY id DESC LIMIT ?`).all(...fTodo.args, PAR_SOURCE)) {
    pousser({
      kind: 'todo', ref: String(r.id), group: 'notes',
      label: r.title, detail: '', nav: { tab: 'notes', todo_id: r.id }, texte: r.title,
    });
  }

  // 5. Navigation et actions — fournies par le client, qui seul sait ce qu'il sait faire.
  for (const a of actions) {
    pousser({ kind: 'nav', ref: a.id, group: 'nav', label: a.label, detail: '', action: a.id, texte: a.label });
  }

  const notes = out.map((o) => {
    const s = scoreFuzzy(o.texte, requete);
    return { o, s, f: frecence(use.get(`${o.kind}:${o.ref}`)) };
  }).filter((x) => x.s > 0);

  /* Score de match MULTIPLIÉ par la frécence : un résultat qu'on n'a jamais ouvert reste
     accessible (facteur 1), et celui qu'on ouvre tous les jours passe devant à match égal. */
  notes.sort((a, b) => (b.s * (1 + b.f)) - (a.s * (1 + a.f)));
  return notes.slice(0, TOTAL).map((x) => {
    const { texte, ...reste } = x.o;
    return reste;
  });
}

/* ------------------------------------------------- import de Chrome ---- */

/* Le format « Netscape bookmarks » : des `<DT><H3>` pour les dossiers, des `<DT><A HREF>`
   pour les liens, imbriqués dans des `<DL>`. On l'analyse à la main, sans jamais RENDRE ni
   exécuter quoi que ce soit du fichier — c'est du HTML fourni de l'extérieur.
   Analyseur TOLÉRANT : les exports réels ferment rarement leurs balises proprement, et un
   fichier un peu bancal ne doit pas coûter tout l'import. */
function parserBookmarks(html, msgs) {
  const texte = String(html == null ? '' : html);
  if (texte.length > MAX_IMPORT) throw erreur(msgs.tropGros);
  const out = [];
  const pile = [];
  // Un seul balayage : chaque jeton est soit un dossier, soit une fin de dossier, soit un lien.
  const RE = /<h3[^>]*>([\s\S]*?)<\/h3>|<\/dl>|<a\s+[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of texte.matchAll(RE)) {
    if (m[1] !== undefined) { pile.push(decoder(m[1]).trim() || '?'); continue; }
    if (m[0].toLowerCase().startsWith('</dl')) { pile.pop(); continue; }
    const href = decoder(m[2] || '').trim();
    if (!/^https?:\/\//i.test(href)) continue;          // `place:`, `javascript:` : ignorés
    out.push({
      label: (decoder(m[3] || '').replace(/<[^>]*>/g, '').trim() || href).slice(0, MAX_LABEL),
      url: href.slice(0, MAX_URL),
      folder: pile.join('/'),
      tags: tagsDuChemin(pile),
    });
  }
  return out;
}

/* LES RACINES DU NAVIGATEUR NE DEVIENNENT PAS DES TAGS. « Barre de favoris » est présente sur
   la totalité des liens exportés : un filtre qui répond partout ne filtre rien, et il occupait
   la première place dans la rangée de pastilles, devant ceux qui disent quelque chose.

   Une LISTE NOMMÉE, et non « on retire toujours le premier segment » : un export peut très
   bien commencer par un vrai dossier, et le perdre effacerait la seule information de rangement
   qu'on avait. Mieux vaut reconnaître les quelques noms que les navigateurs emploient, quitte
   à en oublier un, que de mutiler ce qu'on ne reconnaît pas. */
const RACINES = new Set([
  'barre-de-favoris', 'autres-favoris', 'favoris-mobiles', 'barre-personnelle',
  'menu-des-marque-pages', 'marque-pages-mobiles', 'autres-marque-pages',
  'bookmarks-bar', 'bookmarks-toolbar', 'other-bookmarks', 'mobile-bookmarks',
  'bookmarks-menu', 'favorites-bar', 'favoritos', 'lesezeichenleiste',
]);
function tagsDuChemin(pile) {
  const t = pile.map(normaliserTag).filter(Boolean);
  return (t.length && RACINES.has(t[0]) ? t.slice(1) : t).slice(0, MAX_TAGS);
}

// Entités du fichier exporté. Volontairement minimal : on ne rend jamais ce HTML.
const decoder = (s) => String(s)
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
  .replace(/&amp;/gi, '&');

/* Applique une sélection d'un import. REJOUABLE : une URL déjà présente n'est pas recréée —
   réimporter le même fichier après en avoir ajouté trois ne doit pas doubler les cent
   autres. Le compte des ignorés est rendu, pour que le silence ne passe pas pour un échec. */
function appliquerImport(body = {}, msgs) {
  const liens = Array.isArray(body.links) ? body.links : [];
  const connues = new Set(db.prepare('SELECT url FROM free_link').all().map((r) => r.url));
  let crees = 0;
  let ignores = 0;
  const ins = db.prepare('INSERT INTO free_link (label, url, tags, created_at) VALUES (?,?,?,?)');
  const now = nowIso();
  const trans = db.transaction((rows) => {
    for (const l of rows) {
      let url;
      try { url = lireUrl(l.url, msgs.urlInvalide); } catch { ignores += 1; continue; }
      if (connues.has(url)) { ignores += 1; continue; }
      connues.add(url);
      ins.run(String(l.label || url).trim().slice(0, MAX_LABEL) || url, url,
        JSON.stringify(lireTags(l.tags, msgs.tropDeTags)), now);
      crees += 1;
    }
  });
  trans(liens);
  return { created: crees, skipped: ignores };
}

module.exports = {
  deplacerEnvironnement,
  VARIABLES, MAX_LABEL, MAX_TAG, MAX_TAGS, MAX_IMPORT,
  lireUrl, lireTags, normaliserTag, lireTemplate, resoudreTemplate, scoreFuzzy, frecence,
  listerEnvironnements, creerEnvironnement, majEnvironnement, supprimerEnvironnement,
  lireService, creerService, majService, supprimerService, poserUrl,
  listerContextLinks, creerContextLink, supprimerContextLink,
  listerFreeLinks, creerFreeLink, majFreeLink, supprimerFreeLink, supprimerTousFreeLinks, convertirEnService,
  grille, liensDeMr, noterUsage, launcher, parserBookmarks, appliquerImport,
};
