'use strict';
/* LA BASE VUE PAR UN PLUGIN : les tables `plugin_<nom>_*`, et rien d'autre. Le garde lit
   chaque requête AVANT de la préparer et refuse tout nom de table hors préfixe — `repo`,
   `config`, `sqlite_master`, une table d'un autre plugin. Un plugin tiers hostile n'a donc pas
   de chemin vers les jetons de la forge par SQL.

   Le garde est lexical, pas un parseur SQL complet : il retire chaînes et commentaires, puis
   relit tout identifiant qui suit `FROM`, `JOIN`, `INTO`, `UPDATE`, `TABLE`, `ON` (index et
   déclencheur), `PRAGMA x(`. Les alias (`FROM plugin_x_t AS t`) et les CTE (`WITH t AS`) sont
   reconnus. Ce qui n'est pas reconnu est refusé : `ATTACH`, `DETACH`, `VACUUM`, et un nom
   de table non préfixé. En cas de doute, le garde dit non — un plugin légitime nomme ses
   tables, un plugin hostile n'a pas d'autre porte.

   Les migrations sont rejouées en avant seulement, numérotées, notées dans `plugin_migration`. */

const MOTS_INTERDITS = /\b(attach|detach|vacuum|reindex)\b/i;

function depouiller(sql) {
  return String(sql)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, (m) => m.slice(1, -1).replace(/""/g, '"'))   // "ident" → ident
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]/g, '$1');
}

/** Les noms de table qu'une requête touche, hors alias et CTE. */
function tablesDe(sql) {
  /* `ON CONFLICT (…) DO UPDATE SET …` : le `UPDATE` n'y désigne pas une table (c'est la suite d'un `INSERT INTO <table>`), le garde ne le lit donc pas comme tel. */
  const s = depouiller(sql).replace(/\bdo\s+update\s+set\b/gi, 'DO SET');
  if (MOTS_INTERDITS.test(s)) throw new Error(`requête refusée : ${s.match(MOTS_INTERDITS)[0].toUpperCase()} n'est pas permis à un plugin`);
  const alias = new Set();
  for (const m of s.matchAll(/\bwith\s+(?:recursive\s+)?([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s+as\b/gi)) alias.add(m[1].toLowerCase());
  for (const m of s.matchAll(/,\s*([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s+as\s*\(/gi)) alias.add(m[1].toLowerCase());
  for (const m of s.matchAll(/\b(?:from|join)\s+[A-Za-z_]\w*\s+(?:as\s+)?([A-Za-z_]\w*)/gi)) {
    const a = m[1].toLowerCase();
    if (!['where', 'on', 'join', 'left', 'inner', 'cross', 'natural', 'order', 'group', 'limit', 'set', 'using', 'union', 'except', 'intersect', 'as'].includes(a)) alias.add(a);
  }
  const tables = new Set();
  const noter = (n) => { const t = String(n).toLowerCase(); if (!alias.has(t)) tables.add(t); };
  for (const m of s.matchAll(/\b(?:from|join|into|update)\s+(?:or\s+\w+\s+)?([A-Za-z_]\w*)/gi)) noter(m[1]);
  for (const m of s.matchAll(/\btable\s+(?:if\s+(?:not\s+)?exists\s+)?([A-Za-z_]\w*)/gi)) noter(m[1]);
  for (const m of s.matchAll(/\b(?:index|trigger)\s+(?:if\s+(?:not\s+)?exists\s+)?[A-Za-z_]\w*\s+(?:before\s+|after\s+|instead\s+of\s+)?(?:insert\s+|update\s+(?:of\s+[\w, ]+)?|delete\s+)?on\s+([A-Za-z_]\w*)/gi)) noter(m[1]);
  for (const m of s.matchAll(/\bpragma\s+\w+\s*\(\s*([A-Za-z_]\w*)/gi)) noter(m[1]);
  if (/\bpragma\b/i.test(s) && !/\bpragma\s+(table_info|index_list|index_info|foreign_key_list)\s*\(/i.test(s)) throw new Error('requête refusée : seuls PRAGMA table_info / index_list / index_info / foreign_key_list sont permis à un plugin');
  return [...tables];
}

/** Le préfixe des tables d'un plugin. */
const prefixeDe = (nom) => `plugin_${String(nom).replace(/-/g, '_')}_`;

/** LES PRÉFIXES SE CHEVAUCHENT : `plugin_jenkins_` est le début de `plugin_jenkins_teams_notify_`. Un test « commence par » dirait donc
    que la table du second est au premier — qui pourrait la lire, la vider, ou l'emporter à sa désinstallation. La règle : une table
    appartient au plugin dont le préfixe est le PLUS LONG parmi ceux des plugins CONNUS.
    @param {string} table @param {string[]} noms les noms de tous les plugins connus
    @returns {string|null} le nom du propriétaire */
function proprietaire(table, noms) {
  let meilleur = null;
  for (const n of noms) {
    const p = prefixeDe(n);
    if (String(table).startsWith(p) && (meilleur === null || p.length > prefixeDe(meilleur).length)) meilleur = n;
  }
  return meilleur;
}

/** Les préfixes d'AUTRES plugins qui étendent `prefixe` : ce que la table d'un plugin ne peut pas être. */
function prefixesPlusLongs(prefixe, noms) {
  return (noms || []).map(prefixeDe).filter((p) => p.length > prefixe.length && p.startsWith(prefixe));
}

/** Lève si la requête touche une table hors du préfixe — ou qui est celle d'un autre plugin au préfixe plus long. */
function verifier(prefixe, sql, longs = []) {
  for (const t of tablesDe(sql)) {
    if (!t.startsWith(prefixe)) throw new Error(`requête refusée : la table « ${t} » n'appartient pas au plugin (préfixe attendu : ${prefixe})`);
    if (longs.some((p) => t.startsWith(p))) throw new Error(`requête refusée : la table « ${t} » appartient à un autre plugin`);
  }
}

/**
 * Le `ctx.db` d'un plugin, sur une connexion better-sqlite3 (celle du cœur, ou une base en
 * mémoire dans le SDK de test).
 */
function creer(db, nom, { classer = () => {}, autres = () => [] } = {}) {
  const prefixe = prefixeDe(nom);
  // Relus à CHAQUE requête : un plugin installé après l'activation de celui-ci compte aussi.
  const longs = () => prefixesPlusLongs(prefixe, autres());
  const api = {
    prefix: prefixe,
    prepare(sql) { verifier(prefixe, sql, longs()); return db.prepare(sql); },
    exec(sql) {
      // Plusieurs instructions possibles : chacune est vérifiée.
      for (const part of String(sql).split(';')) if (part.trim()) verifier(prefixe, part, longs());
      db.exec(sql);
    },
    transaction(fn) { return db.transaction(fn)(); },
    tables() {
      // En JS, pas en `LIKE` : le « _ » du préfixe y est un joker (`plugin_jenkins_` attraperait `plugin_jenkinsX…`).
      const plus = longs();
      return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name).filter((n) => n.startsWith(prefixe) && !plus.some((p) => n.startsWith(p)));
    },
    classify(table, famille) {
      if (!String(table).startsWith(prefixe) || longs().some((p) => String(table).startsWith(p))) throw new Error(`classify : la table « ${table} » n'appartient pas au plugin`);
      if (!['L', 'C'].includes(famille)) throw new Error('classify : famille L ou C (le partage P d’une table de plugin n’est pas ouvert en V1)');
      classer(table, famille);
    },
    appliedVersions() { return db.prepare('SELECT version FROM plugin_migration WHERE plugin = ? ORDER BY version').all(nom).map((r) => r.version); },
    markApplied(version) { db.prepare('INSERT OR IGNORE INTO plugin_migration (plugin, version, applied_at) VALUES (?, ?, ?)').run(nom, Number(version), new Date().toISOString()); },
    /** Joue en avant les migrations non encore appliquées. Rend le nombre jouées. */
    migrate(migrations) {
      if (!Array.isArray(migrations)) throw new Error('migrate : tableau de { version, up } attendu');
      const faites = new Set(db.prepare('SELECT version FROM plugin_migration WHERE plugin = ?').all(nom).map((r) => r.version));
      let n = 0;
      const tri = [...migrations].sort((a, b) => a.version - b.version);
      for (const m of tri) {
        if (!Number.isInteger(m.version) || m.version < 1) throw new Error('migrate : version entière ≥ 1 requise');
        if (faites.has(m.version)) continue;
        db.transaction(() => {
          if (typeof m.up === 'string') api.exec(m.up);
          else if (typeof m.up === 'function') m.up(api);
          else throw new Error(`migrate : version ${m.version} — up doit être du SQL ou une fonction`);
          db.prepare('INSERT INTO plugin_migration (plugin, version, applied_at) VALUES (?, ?, ?)').run(nom, m.version, new Date().toISOString());
        })();
        n += 1;
      }
      return n;
    },
  };
  return api;
}

module.exports = { creer, verifier, tablesDe, prefixeDe, proprietaire, prefixesPlusLongs };
