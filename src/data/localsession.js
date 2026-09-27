'use strict';
/* LE HANDLE D'UNE SESSION D'AGENT — propre à la machine qui l'a créée.
 *
 * `claude` et `copilot` gardent leurs sessions dans le `~/.claude` du poste. Un handle venu d'un
 * collègue ne désigne rien ici : le reprendre échouerait — ou pire, tomberait sur une session
 * homonyme et repartirait sur un contexte qui n'est pas le bon. Il ne peut donc pas voyager avec
 * la session, alors que la session, elle, se partage : ses passes se relisent, son diff compte.
 *
 * Le repli existe déjà dans le code : quand il n'y a pas de handle, on démarre une session neuve
 * avec le contexte réinjecté. Sortir ces trois colonnes ne fait donc qu'une chose — rendre ce
 * repli NORMAL entre deux postes, au lieu d'exceptionnel.
 *
 * TROIS COLONNES QUI VOYAGENT ENSEMBLE, et c'est pour ça qu'elles ont leur table plutôt qu'une
 * ligne chacune dans `local_state` : un handle sans son `cwd` perd le garde-fou qui empêche de
 * reprendre une session dans un autre dossier — le cas exact que `taskrunner` vérifie avant
 * chaque reprise.
 */
const db = require('../db');

const VIDE = { session_key: null, session_backend: null, session_cwd: null };

const lireSql = db.prepare('SELECT session_key, session_backend, session_cwd FROM local_session WHERE scope = ? AND ref = ?');
const ecrireSql = db.prepare(`INSERT INTO local_session (scope, ref, session_key, session_backend, session_cwd, updated_at)
  VALUES (@scope, @ref, @session_key, @session_backend, @session_cwd, @updated_at)
  ON CONFLICT (scope, ref) DO UPDATE SET
    session_key = @session_key, session_backend = @session_backend,
    session_cwd = @session_cwd, updated_at = @updated_at`);
const oublierSql = db.prepare('DELETE FROM local_session WHERE scope = ? AND ref = ?');

/** Les trois champs, toujours présents — un appelant ne doit pas avoir à tester leur existence. */
function lire(scope, ref) {
  if (!ref) return { ...VIDE };
  return { ...VIDE, ...(lireSql.get(scope, String(ref)) || {}) };
}

/**
 * Écrit le handle. Un `session_key` nul EFFACE la ligne : « pas de session » ne doit pas laisser
 * une ligne à trois nuls, que la prochaine lecture prendrait pour un handle vide mais existant.
 */
function ecrire(scope, ref, { session_key: cle, session_backend: backend, session_cwd: cwd } = {}) {
  if (!ref) return;
  if (!cle) { oublierSql.run(scope, String(ref)); return; }
  ecrireSql.run({
    scope,
    ref: String(ref),
    session_key: String(cle),
    session_backend: backend || null,
    session_cwd: cwd || null,
    updated_at: new Date().toISOString(),
  });
}

/** Oublie le handle d'un parent — appelé là où le parent disparaît, ou au « détacher ». */
const oublier = (scope, ref) => { if (ref) oublierSql.run(scope, String(ref)); };

/** `ref -> handle` pour tout un scope : une liste de sessions ne fait pas une requête par ligne. */
function carte(scope) {
  const m = new Map();
  for (const r of db.prepare('SELECT * FROM local_session WHERE scope = ?').all(scope)) {
    m.set(r.ref, { session_key: r.session_key, session_backend: r.session_backend, session_cwd: r.session_cwd });
  }
  return m;
}

/**
 * Recolle le handle sur une ligne chargée en base — `session_key` & co. restent les champs que
 * tout le reste du code lit, et rien en aval ne voit la différence.
 */
const resoudre = (scope, row, m = null) => (row
  ? { ...row, ...(m ? (m.get(row.uid) || VIDE) : lire(scope, row.uid)) }
  : row);

/** Toutes les sessions connues d'un scope, pour la liste « reprendre une session existante ». */
const connues = (scope) => db.prepare(
  `SELECT ref, session_key, session_backend, session_cwd, updated_at FROM local_session
   WHERE scope = ? AND session_key IS NOT NULL AND session_key <> '' ORDER BY updated_at DESC`,
).all(scope);

module.exports = { lire, ecrire, oublier, carte, resoudre, connues, VIDE };
