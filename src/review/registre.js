'use strict';
/* LE CONTRÔLE AU REGISTRE — ce que le registre public sait d'une dépendance AJOUTÉE : inconnue,
 * publiée pour la première fois il y a N jours, ou connue de longue date.
 *
 * C'est le seul cas où un ajout de dépendance est presque toujours une erreur : un nom inventé par
 * l'agent, un homonyme à une lettre près, un paquet publié la semaine dernière. Personne ne vérifie
 * à la main, et le relecteur ne peut pas deviner qu'un nom plausible n'existe pas.
 *
 * Règle produit : LE REGISTRE A RÉPONDU, OU IL N'A PAS RÉPONDU, ET L'OUTIL DIT LEQUEL. Une date de
 * première publication est un fait ; « inconnu » est la réponse (404) d'un registre nommé, pas un
 * verdict ; « injoignable » n'est JAMAIS traduit en « inconnu ». Rien n'est jugé : pas de score, pas
 * de blocage, pas de note, pas de notification.
 *
 * C'est le premier appel réseau de Mergerie qui ne va ni à la forge, ni à Jira : décoché par défaut,
 * limité aux noms des paquets ajoutés (jamais le manifeste, ni le dépôt, ni la merge request ; aucun
 * en-tête d'identification au-delà du User-Agent), plafonné par tour, mis en cache par nom
 * (`registry_lookup`), soumis au proxy de l'environnement (`HTTPS_PROXY` / `NO_PROXY`) et à la CA
 * d'entreprise de la forge. Ce module n'importe rien de `agent/` ni de `forge/` ; un test le garde fermé. */
const fs = require('fs');
const path = require('path');
const db = require('../db');
const glob = require('../core/glob');
const httpreq = require('../core/httpreq');
const git = require('../git/git');
const groupes = require('../data/groupes');

const VERSION = require('../../package.json').version;
const USER_AGENT = `mergerie/${VERSION} (+https://mergerie.dev)`;
const DELAI_MS = 5000;                  // une seule tentative par tour, cinq secondes
const TTL_INCONNU_MS = 24 * 3600 * 1000;    // un paquet peut être publié entre-temps
const TTL_CONNU_MS = 7 * 24 * 3600 * 1000;  // la date ne bouge pas ; c'est l'âge qui franchit N
const PLAFOND_DEFAUT = 30;
const PLAFOND_SESSION = 10;
const RECENT_DEFAUT = 30;
const MAX_REDIRECTIONS = 3;

/* ---------- Les registres, un par écosystème (`core/registres.js`) ---------- */
const { REGISTRES, ECOSYSTEMES, URLS_DEFAUT, urlsDepuis, normaliserUrls } = require('../core/registres');
const HOTES_PUBLICS = ECOSYSTEMES.map((e) => new URL(REGISTRES[e].url).hostname);

/* L'écosystème d'un analyseur de manifeste (`dependances.js`), ou null. */
const PAR_ANALYSEUR = {
  'package.json': 'npm', 'composer.json': 'composer', 'requirements.txt': 'pypi', 'pyproject.toml': 'pypi',
  'go.mod': 'go', 'Cargo.toml': 'crates', Gemfile: 'rubygems', 'pom.xml': 'maven', 'build.gradle': 'maven', csproj: 'nuget',
};
const ecosystemeDe = (parser) => PAR_ANALYSEUR[parser] || null;

/* Le nom normalisé, clé du cache : PyPI ne distingue ni la casse ni `_` / `.` / `-` ; NuGet ignore
   la casse ; les autres gardent le nom tel quel (npm, scope compris). */
function normaliser(ecosystem, name) {
  const n = String(name || '').trim();
  if (ecosystem === 'pypi') return n.toLowerCase().replace(/[-_.]+/g, '-');
  if (ecosystem === 'nuget') return n.toLowerCase();
  return n;
}

/* ---------- Les réglages ---------- */
const actif = (cfg) => String((cfg && cfg.registry_enabled) || '0') === '1';
function plafond(cfg) {
  const n = parseInt(cfg && cfg.registry_max, 10);
  return Number.isFinite(n) && n >= 0 ? n : PLAFOND_DEFAUT;
}
function joursRecent(cfg) {
  const n = parseInt(cfg && cfg.registry_recent_days, 10);
  return Number.isFinite(n) && n >= 0 ? n : RECENT_DEFAUT;
}
const urlsDe = (cfg) => urlsDepuis(cfg && cfg.registry_urls);

const lignes = (texte) => String(texte || '').split('\n').map((l) => l.trim()).filter(Boolean);
/* Les motifs de paquets privés qui valent pour un dépôt : le dépôt s'il en porte, sinon l'union de
   ses groupes qui en portent, sinon le réglage global — sans défaut livré. */
function motifsPrives(cfg, repoId) {
  const repo = repoId ? db.prepare('SELECT id, private_patterns FROM repo WHERE id = ?').get(Number(repoId)) : null;
  if (repo && lignes(repo.private_patterns).length) return { patterns: lignes(repo.private_patterns), source: { kind: 'repo', repo_id: repo.id } };
  const porteurs = repo ? groupes.groupesDuDepot(repo.id).filter((g) => lignes(g.private_patterns).length) : [];
  if (porteurs.length) {
    return { patterns: [...new Set(porteurs.flatMap((g) => lignes(g.private_patterns)))], source: { kind: 'group', groups: porteurs.map((g) => ({ id: g.id, name: g.name })) } };
  }
  return { patterns: lignes(cfg && cfg.private_patterns), source: { kind: 'config' } };
}
const cacheRegex = new Map();
function regexDe(motif) {
  if (!cacheRegex.has(motif)) {
    if (cacheRegex.size > 2000) cacheRegex.clear();
    let re = null;
    try { re = glob.globToRegex(motif); } catch { re = null; }
    cacheRegex.set(motif, re);
  }
  return cacheRegex.get(motif);
}
const estPrive = (patterns, name) => (patterns || []).map(regexDe).filter(Boolean).some((re) => re.test(String(name || '')));

/* ---------- Les paquets privés lus dans le clone ----------
   Un `.npmrc` avec `registry=` (tout npm) ou `@scope:registry=` (ce scope) ; un `composer.json` avec
   des `repositories` (un dépôt `composer` : tout Composer ; `vcs` / `path` : le paquet qu'il nomme) ;
   `GOPRIVATE` dans `go.env` (préfixes de modules) ; un `pip.conf` / `pip.ini` avec `index-url` (tout
   PyPI). Lu dans le clone local, sans réseau ; absent, rien n'est privé. Rend une fonction
   `(ecosystem, name) → fichier | null`. */
function privesDuClone(cfg, repo) {
  const cwd = repo ? git.cloneDirFor(cfg, repo) : null;
  const regles = [];
  if (!cwd || !fs.existsSync(path.join(cwd, '.git'))) return () => null;
  const lire = (f) => { try { return fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { return null; } };
  const npmrc = lire('.npmrc');
  if (npmrc) {
    for (const l of npmrc.split('\n')) {
      const m = l.trim().match(/^(@[^:=\s]+):registry\s*=\s*(\S+)/);
      if (m && !HOTES_PUBLICS.includes(hoteDe(m[2]))) regles.push({ eco: 'npm', test: (n) => n.startsWith(`${m[1]}/`), fichier: '.npmrc' });
      else if (/^registry\s*=\s*(\S+)/.test(l.trim()) && !HOTES_PUBLICS.includes(hoteDe(l.trim().replace(/^registry\s*=\s*/, '')))) regles.push({ eco: 'npm', test: () => true, fichier: '.npmrc' });
    }
  }
  const composer = lire('composer.json');
  if (composer) {
    try {
      const j = JSON.parse(composer);
      const repos = Array.isArray(j.repositories) ? j.repositories : Object.values(j.repositories || {});
      for (const r of repos) {
        if (!r || typeof r !== 'object') continue;
        if (r.type === 'composer' && r.url && !HOTES_PUBLICS.includes(hoteDe(r.url))) regles.push({ eco: 'composer', test: () => true, fichier: 'composer.json' });
        else if ((r.type === 'vcs' || r.type === 'git' || r.type === 'path') && r.url) {
          const parts = String(r.url).replace(/\.git$/, '').split('/').filter(Boolean);
          const nom = parts.slice(-2).join('/').replace(/^.*:/, '');
          regles.push({ eco: 'composer', test: (n) => n === nom, fichier: 'composer.json' });
        }
      }
    } catch { /* un composer.json illisible ne dit rien */ }
  }
  const goenv = lire('go.env');
  if (goenv) {
    const m = goenv.match(/^\s*GOPRIVATE\s*=\s*(.+)$/m);
    if (m) {
      for (const motif of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        const base = motif.replace(/\/\.\.\.$/, '');
        regles.push({ eco: 'go', test: (n) => n === base || n.startsWith(`${base}/`) || (motif.includes('*') && !!regexDe(motif) && regexDe(motif).test(n)), fichier: 'go.env' });
      }
    }
  }
  const pip = lire('pip.conf') || lire('pip.ini') || lire('.pip/pip.conf');
  if (pip && /^\s*(extra-)?index-url\s*=/m.test(pip)) regles.push({ eco: 'pypi', test: () => true, fichier: 'pip.conf' });
  return (eco, name) => { const r = regles.find((x) => x.eco === eco && x.test(String(name || ''))); return r ? r.fichier : null; };
}
function hoteDe(url) { try { return new URL(String(url).trim()).hostname; } catch { return ''; } }

/* ---------- Appeler un registre ---------- */

/* La CA d'entreprise de la forge sert aussi ici : le même proxy, les mêmes certificats. */
function optionsTls() {
  const ca = process.env.MERGERIE_CA_CERT || process.env.GITLAB_CA_CERT || process.env.GITHUB_CA_CERT;
  if (ca) { try { return { ca: fs.readFileSync(ca) }; } catch { /* chemin invalide : vérification normale */ } }
  return {};
}

/* UNE requête vers un registre : GET, User-Agent seul, délai de 5 s, redirections suivies sur le
   MÊME hôte seulement (trois au plus), aucun cookie. Rend `{ status, body }` ou jette avec un `code`. */
async function appeler(url, { requete = httpreq.request } = {}) {
  let courante = url;
  for (let i = 0; i <= MAX_REDIRECTIONS; i += 1) {
    const r = await requete(courante, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain;q=0.9, */*;q=0.1' },
      proxy: httpreq.proxyDepuisEnv(courante), tls: optionsTls(), timeoutMs: DELAI_MS,
    });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers && r.headers.location && i < MAX_REDIRECTIONS) {
      const suivante = new URL(String(r.headers.location), courante);
      if (suivante.hostname !== new URL(courante).hostname) throw Object.assign(new Error('redirect'), { code: 'EREDIRECT' });
      courante = suivante.href;
      continue;
    }
    return r;
  }
  throw Object.assign(new Error('redirect'), { code: 'EREDIRECT' });
}

const json = (body) => { try { return JSON.parse(body); } catch { return null; } };
// Une date en ISO, ou null : Maven envoie des millisecondes, les autres une chaîne.
const iso = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const minMax = (dates) => {
  const ok = dates.map(iso).filter(Boolean).sort();
  return ok.length ? { first: ok[0], latest: ok[ok.length - 1] } : { first: null, latest: null };
};
/* Le plus ancien tag d'une liste `vX.Y.Z` du proxy Go : tri sémantique simple, préversions après. */
function plusAncienneVersionGo(liste) {
  const cle = (v) => {
    const m = String(v).match(/^v(\d+)\.(\d+)\.(\d+)(.*)$/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 1 : 0] : [Infinity, 0, 0, 0];
  };
  return [...liste].sort((a, b) => { const x = cle(a); const y = cle(b); for (let i = 0; i < 4; i += 1) if (x[i] !== y[i]) return x[i] - y[i]; return 0; })[0] || null;
}
const goEscape = (module) => module.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);

/* Chaque lecteur rend `{ found: bool, first, latest }` — `found: false` seulement sur la réponse
   « inconnu » explicite du registre (404 ; 410 pour Go ; `numFound = 0` pour Maven). Tout autre
   statut hors 2xx jette `http-<code>`. `appels` compte les requêtes émises. */
const LECTEURS = {
  async npm(base, name, ctx) {
    const r = await ctx.get(`${base}/${encodeURIComponent(name).replace(/^%40/, '@')}`);
    if (r.status === 404) return { found: false };
    const j = ok(r);
    const temps = j.time || {};
    const { first, latest } = minMax(Object.entries(temps).filter(([k]) => k !== 'created' && k !== 'modified').map(([, v]) => v));
    return { found: true, first: iso(temps.created) || first, latest: latest || iso(temps.modified) };
  },
  async composer(base, name, ctx) {
    const r = await ctx.get(`${base}/p2/${name}.json`);
    if (r.status === 404) return { found: false };
    const j = ok(r);
    const versions = (j.packages && j.packages[name]) || [];
    return { found: true, ...minMax(versions.filter((v) => !/dev/.test(String(v.version || ''))).map((v) => v.time)) };
  },
  async pypi(base, name, ctx) {
    const r = await ctx.get(`${base}/pypi/${name}/json`);
    if (r.status === 404) return { found: false };
    const j = ok(r);
    const dates = [];
    for (const fichiers of Object.values(j.releases || {})) for (const f of fichiers || []) dates.push(f.upload_time_iso_8601 || f.upload_time);
    return { found: true, ...minMax(dates) };
  },
  async crates(base, name, ctx) {
    const r = await ctx.get(`${base}/api/v1/crates/${encodeURIComponent(name)}`);
    if (r.status === 404) return { found: false };
    const j = ok(r);
    return { found: true, first: iso(j.crate && j.crate.created_at), latest: iso(j.crate && j.crate.updated_at) };
  },
  async rubygems(base, name, ctx) {
    const r = await ctx.get(`${base}/api/v1/versions/${encodeURIComponent(name)}.json`);
    if (r.status === 404) return { found: false };
    const j = ok(r);
    return { found: true, ...minMax((Array.isArray(j) ? j : []).map((v) => v.created_at)) };
  },
  async go(base, name, ctx) {
    const mod = `${base}/${goEscape(name)}`;
    const r = await ctx.get(`${mod}/@v/list`);
    if (r.status === 404 || r.status === 410) return { found: false };
    ok(r, false);
    const versions = String(r.body || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const cible = versions.length ? `@v/${plusAncienneVersionGo(versions)}.info` : '@latest';
    const r2 = await ctx.get(`${mod}/${cible}`);
    if (r2.status === 404 || r2.status === 410) return { found: false };
    const j = ok(r2);
    return { found: true, first: iso(j.Time), latest: versions.length > 1 ? null : iso(j.Time) };
  },
  async maven(base, name, ctx) {
    const [g, a] = name.split(':');
    if (!g || !a) throw Object.assign(new Error('no-group'), { code: 'ENOGROUP' });
    const r = await ctx.get(`${base}/solrsearch/select?q=${encodeURIComponent(`g:${g} AND a:${a}`)}&core=gav&rows=200&wt=json`);
    const j = ok(r);
    const docs = (j.response && j.response.docs) || [];
    if (!j.response || Number(j.response.numFound) === 0 || !docs.length) return { found: false };
    return { found: true, ...minMax(docs.map((d) => d.timestamp)) };
  },
  async nuget(base, name, ctx) {
    const r = await ctx.get(`${base}/v3/registration5-gz-semver2/${name.toLowerCase()}/index.json`);
    if (r.status === 404) return { found: false };
    const j = ok(r);
    const pages = Array.isArray(j.items) ? j.items : [];
    const dates = [];
    const lirePage = async (p) => {
      let items = p.items;
      if (!Array.isArray(items) && p['@id']) { const rp = await ctx.get(p['@id']); items = (ok(rp).items) || []; }
      for (const it of items || []) if (it.catalogEntry) dates.push(it.catalogEntry.published);
    };
    if (pages.length) { await lirePage(pages[0]); if (pages.length > 1) await lirePage(pages[pages.length - 1]); }
    return { found: true, ...minMax(dates) };
  },
};
function ok(r, parse = true) {
  if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`http-${r.status}`), { code: `HTTP_${r.status}` });
  if (!parse) return r.body;
  const j = json(r.body);
  if (j == null) throw Object.assign(new Error('not-json'), { code: 'ENOTJSON' });
  return j;
}

/* Le contrôle d'UN nom : interroge le registre et rend la ligne à écrire —
   `{ status, first_published, latest_published, reason, appels }`. */
async function interroger(ecosystem, name, base, { requete, now = Date.now(), recentDays = RECENT_DEFAUT } = {}) {
  let appels = 0;
  const ctx = { get: async (u) => { appels += 1; return appeler(u, { requete }); } };
  try {
    const r = await LECTEURS[ecosystem](base, name, ctx);
    if (!r.found) return { status: 'unknown', first_published: null, latest_published: null, reason: '404', appels };
    const statut = r.first && ageEnJours(r.first, now) <= recentDays ? 'recent' : 'known';
    return { status: statut, first_published: r.first || null, latest_published: r.latest || null, reason: r.first ? null : 'no-date', appels };
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    const reason = code === 'ETIMEDOUT' ? 'timeout' : code.startsWith('HTTP_') ? `http-${code.slice(5)}` : code === 'EREDIRECT' ? 'redirect'
      : code === 'ENOTJSON' ? 'not-json' : code === 'ENOGROUP' ? 'no-group' : (code || 'error').toLowerCase();
    return { status: 'unreachable', first_published: null, latest_published: null, reason, appels };
  }
}
const ageEnJours = (isoDate, now = Date.now()) => Math.floor((now - Date.parse(isoDate)) / 86400000);

/* ---------- Le cache ---------- */
const SEL = db.prepare('SELECT * FROM registry_lookup WHERE ecosystem = ? AND name = ?');
const ECRIRE = db.prepare(`INSERT INTO registry_lookup (ecosystem, name, status, first_published, latest_published, checked_at, reason)
  VALUES (@ecosystem, @name, @status, @first_published, @latest_published, @checked_at, @reason)
  ON CONFLICT(ecosystem, name) DO UPDATE SET status = excluded.status, first_published = excluded.first_published,
    latest_published = excluded.latest_published, checked_at = excluded.checked_at, reason = excluded.reason`);
function poser(ecosystem, name, { status, first_published = null, latest_published = null, reason = null, now = new Date().toISOString() }) {
  ECRIRE.run({ ecosystem, name: normaliser(ecosystem, name), status, first_published, latest_published, checked_at: now, reason });
}
const etatDe = (ecosystem, name) => SEL.get(ecosystem, normaliser(ecosystem, name)) || null;
/* Une entrée est fraîche selon son état : 24 h pour `unknown` / `unreachable`, 7 jours pour `known` /
   `recent` ; un `skipped` ne l'est jamais (il attend le tour suivant). */
function fraiche(row, now = Date.now()) {
  if (!row || row.status === 'skipped') return false;
  const age = now - Date.parse(row.checked_at);
  return age < (row.status === 'known' || row.status === 'recent' ? TTL_CONNU_MS : TTL_INCONNU_MS);
}

/* ---------- Enrichir les dépendances ajoutées (à l'affichage) ----------
   `ajoutees` : `[{ name, group?, parser }]` d'un dépôt. Rend, par entrée, `registry` :
   `{ ecosystem, label, host, status, reason, first_published, age_days, source }` — `status` recalculé
   sur le seuil ACTUEL (changer N agit tout de suite). Jamais de réseau ici. */
function pourDependances(cfg, repoId, ajoutees, { now = Date.now(), prives = null } = {}) {
  const urls = urlsDe(cfg);
  const motifs = motifsPrives(cfg, repoId);
  const n = joursRecent(cfg);
  const repo = repoId ? db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(repoId)) : null;
  const duClone = prives || privesDuClone(cfg, repo);
  return ajoutees.map((e) => {
    const eco = ecosystemeDe(e.parser);
    if (!eco) return null;
    const nom = eco === 'maven' && e.group ? `${e.group}:${e.name}` : e.name;
    const base = { ecosystem: eco, label: REGISTRES[eco].label, host: hoteDe(urls[eco] || REGISTRES[eco].url) };
    if (estPrive(motifs.patterns, nom)) return { ...base, status: 'skipped', reason: 'private-pattern', source: motifs.source };
    const fichier = duClone(eco, nom);
    if (fichier) return { ...base, status: 'skipped', reason: 'private-config', source: fichier };
    if (!urls[eco]) return { ...base, status: 'skipped', reason: 'no-registry' };
    if (eco === 'maven' && !e.group) return { ...base, status: 'skipped', reason: 'no-group' };
    const row = etatDe(eco, nom);
    if (!row) return { ...base, status: 'skipped', reason: 'pending' };
    if (row.status === 'known' || row.status === 'recent') {
      const age = row.first_published ? ageEnJours(row.first_published, now) : null;
      return { ...base, status: age != null && age <= n ? 'recent' : 'known', reason: null, first_published: row.first_published, age_days: age, checked_at: row.checked_at };
    }
    return { ...base, status: row.status, reason: row.reason, first_published: null, checked_at: row.checked_at };
  });
}

/* Les totaux d'une liste enrichie, pour le badge, et le pied du panneau (registres contactés, dernier
   contrôle par écosystème). */
function totaux(enrichies) {
  const t = { unknown: 0, recent: 0, unreachable: 0, skipped: 0, contacted: {} };
  for (const r of enrichies) {
    if (!r) continue;
    if (r.status in t) t[r.status] += 1;
    if (r.checked_at && (!t.contacted[r.ecosystem] || t.contacted[r.ecosystem] < r.checked_at)) t.contacted[r.ecosystem] = r.checked_at;
  }
  return t;
}

/* ---------- Le tour de contrôle (découverte) ----------
   `ajoutees` : `[{ repo_id, parser, name, group }]` de toutes les MR ouvertes (dédoublonnées ici par
   écosystème + nom). Celles qu'un motif ou le clone disent privées, celles d'un écosystème sans registre,
   ne partent jamais. Au plus `max` noms par tour (0 = sans limite) ; au-delà, `skipped · cap`, repris au
   tour suivant. Rend le bilan `{ controles, appels, par_registre, inconnus, injoignables, plafonnes, hotes }`. */
async function controlerTour(cfg, ajoutees, { onLog = () => {}, max = plafond(cfg), requete, now = Date.now() } = {}) {
  const bilan = { controles: 0, appels: 0, par_registre: {}, inconnus: 0, recents: 0, injoignables: 0, plafonnes: 0, hotes: [] };
  // La démo n'a pas de réseau : son cache est semé, et rien ne part.
  if (!actif(cfg) || process.env.MERGERIE_DEMO === '1') return bilan;
  const urls = urlsDe(cfg);
  const n = joursRecent(cfg);
  const motifsParRepo = new Map(); const clonesParRepo = new Map();
  const aFaire = new Map();
  for (const e of ajoutees) {
    const eco = ecosystemeDe(e.parser);
    if (!eco || !urls[eco]) continue;
    const nom = eco === 'maven' ? (e.group ? `${e.group}:${e.name}` : null) : e.name;
    if (!nom) continue;
    const cle = `${eco}\u0001${normaliser(eco, nom)}`;
    if (aFaire.has(cle)) continue;
    if (!motifsParRepo.has(e.repo_id)) motifsParRepo.set(e.repo_id, motifsPrives(cfg, e.repo_id).patterns);
    if (estPrive(motifsParRepo.get(e.repo_id), nom)) continue;
    if (!clonesParRepo.has(e.repo_id)) clonesParRepo.set(e.repo_id, privesDuClone(cfg, db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(e.repo_id))));
    if (clonesParRepo.get(e.repo_id)(eco, nom)) continue;
    if (fraiche(etatDe(eco, nom), now)) continue;
    aFaire.set(cle, { eco, nom });
  }
  const liste = [...aFaire.values()];
  const pris = max > 0 ? liste.slice(0, max) : liste;
  const nowIso = new Date(now).toISOString();
  for (const { eco, nom } of pris) {
    const r = await interroger(eco, nom, urls[eco], { requete, now, recentDays: n });
    poser(eco, nom, { ...r, now: nowIso });
    bilan.controles += 1; bilan.appels += r.appels;
    bilan.par_registre[eco] = (bilan.par_registre[eco] || 0) + r.appels;
    if (r.status === 'unknown') bilan.inconnus += 1;
    else if (r.status === 'recent') bilan.recents += 1;
    else if (r.status === 'unreachable') bilan.injoignables += 1;
  }
  for (const { eco, nom } of liste.slice(pris.length)) {
    const row = etatDe(eco, nom);
    if (!row || row.status === 'skipped') poser(eco, nom, { status: 'skipped', reason: 'cap', now: nowIso });
    bilan.plafonnes += 1;
  }
  bilan.hotes = Object.keys(bilan.par_registre).map((e) => hoteDe(urls[e]));
  if (bilan.appels) {
    const detail = Object.entries(bilan.par_registre).map(([e, k]) => `${e} ${k}`).join(', ');
    onLog(`Registre : ${bilan.appels} appel(s) (${detail}) vers ${bilan.hotes.join(', ')} — ${bilan.inconnus} inconnu(s), ${bilan.recents} récent(s), ${bilan.injoignables} injoignable(s)${bilan.plafonnes ? `, ${bilan.plafonnes} au-delà du plafond (${max})` : ''}`);
  } else if (bilan.plafonnes) onLog(`Registre : aucun appel, ${bilan.plafonnes} contrôle(s) au-delà du plafond (${max})`);
  return bilan;
}

/* LA LIGNE DE PROJET D'UNE SESSION : le contrôle se fait quand la ligne se calcule, sous le même cache,
   en arrière-plan (l'écran se redessine toutes les secondes et demie ; le résultat paraît au rendu
   suivant), au plus dix noms par session. Un seul contrôle en cours par clé. */
const enCours = new Set();
function controlerBientot(cfg, cle, ajoutees, { max = PLAFOND_SESSION } = {}) {
  if (!actif(cfg) || process.env.MERGERIE_DEMO === '1' || enCours.has(cle)) return false;
  const manquantes = ajoutees.filter((e) => { const eco = ecosystemeDe(e.parser); return eco && !fraiche(etatDe(eco, eco === 'maven' && e.group ? `${e.group}:${e.name}` : e.name)); });
  if (!manquantes.length) return false;
  enCours.add(cle);
  controlerTour(cfg, manquantes, { max }).catch(() => {}).finally(() => enCours.delete(cle));
  return true;
}

function purgerPerimees({ now = Date.now(), ageMs = 90 * 24 * 3600 * 1000 } = {}) {
  return db.prepare('DELETE FROM registry_lookup WHERE checked_at < ?').run(new Date(now - ageMs).toISOString()).changes;
}

module.exports = {
  REGISTRES, ECOSYSTEMES, URLS_DEFAUT, USER_AGENT, DELAI_MS, PLAFOND_DEFAUT, PLAFOND_SESSION, RECENT_DEFAUT, TTL_INCONNU_MS, TTL_CONNU_MS,
  actif, plafond, joursRecent, urlsDe, normaliserUrls, motifsPrives, estPrive, privesDuClone,
  ecosystemeDe, normaliser, appeler, interroger, poser, etatDe, fraiche,
  pourDependances, totaux, controlerTour, controlerBientot, purgerPerimees,
};
