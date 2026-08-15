'use strict';
/* Suivi de résolution entre deux passes de review (ideas.md).

   Méthode « constats structurés à la source » : l'IA émet, en plus du Markdown,
   un bloc de constats délimité. On le parse, on le retire du rapport affiché, et
   on compare mécaniquement les constats d'une passe à l'autre par leur EMPREINTE
   (fichier + titre normalisé) — pas par un id inventé par l'IA, qui ne serait pas
   stable d'une passe à l'autre.

   Garde-fou du doc : un constat disparu n'est « résolu » que si sa ligne a
   réellement changé entre les deux états du code (git diff des deux reviewed_sha).
   Sinon il est « disparu, non vérifié » — l'IA a pu simplement ne pas le
   re-signaler, et compter ça comme résolu donnerait un taux flatteur et faux. */

const crypto = require('crypto');
const git = require('./git');
const { t } = require('../public/i18n-runtime.js');

const SEVERITIES = ['blocker', 'major', 'minor', 'info'];

// Délimiteurs du bloc de constats. Sentinelles explicites, robustes au Markdown.
const START = '<<<FINDINGS';
const END = 'FINDINGS>>>';

// Retire le bloc de constats du rapport (il ne doit pas s'afficher) et le renvoie.
function splitFindings(md) {
  const s = md.indexOf(START);
  if (s === -1) return { markdown: md.trim(), block: '' };
  const e = md.indexOf(END, s);
  const block = e === -1 ? md.slice(s + START.length) : md.slice(s + START.length, e);
  const cleaned = (md.slice(0, s) + (e === -1 ? '' : md.slice(e + END.length))).trim();
  return { markdown: cleaned, block };
}

const normTitle = (titre) => String(titre || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const normFile = (f) => String(f || '').trim().replace(/^\.?\//, '');

function fingerprint(file, title) {
  return crypto.createHash('sha1').update(`${normFile(file)}\n${normTitle(title)}`).digest('hex').slice(0, 16);
}

/* Parse le bloc en constats. Format tolérant, une ligne par constat :
     sévérité | fichier | ligne | titre
   Les lignes d'en-tête, vides ou malformées sont ignorées silencieusement — mieux
   vaut moins de constats qu'un plantage sur une sortie IA imparfaite. */
function parseFindings(block) {
  const out = [];
  const seen = new Set();
  for (const raw of String(block || '').split('\n')) {
    const line = raw.trim();
    if (!line || !line.includes('|')) continue;
    const parts = line.split('|').map((x) => x.trim());
    if (parts.length < 4) continue;
    let [sev, file, ln, ...rest] = parts;
    const title = rest.join(' | ').trim();
    sev = sev.toLowerCase();
    // Ligne d'en-tête (« severity | file | line | title ») : la colonne ligne n'est
    // pas un nombre. C'est le signal le plus fiable pour l'écarter.
    if (ln && !/^\d+$/.test(ln.trim())) continue;
    if (!title || /^-+$/.test(file)) continue;          // séparateur Markdown / vide
    if (!SEVERITIES.includes(sev)) sev = 'minor';       // valeur hors barème → minor
    // Un constat ne pointe jamais le dossier d'échange interne de l'app.
    if (normFile(file).startsWith('ai-dev-tools-internal/')) continue;
    const fp = fingerprint(file, title);
    if (seen.has(fp)) continue;                          // doublon dans la même passe
    seen.add(fp);
    out.push({ fingerprint: fp, file: normFile(file), line: parseInt(ln, 10) || null, severity: sev, title });
  }
  return out;
}

/* Le garde-fou git : entre deux SHA, les lignes du fichier `file` qui ont changé
   côté ANCIEN état. Renvoie un ensemble de plages [a, b] (lignes de l'ancien
   fichier). Si un SHA manque (branche force-push + GC) ou le diff échoue, renvoie
   null → l'appelant reste prudent et ne revendique pas « résolu ». */
async function changedOldLines(cwd, oldSha, newSha, file) {
  // Les deux commits doivent être présents localement.
  for (const sha of [oldSha, newSha]) {
    try { await git.run('git', ['cat-file', '-e', sha], { cwd }); }
    catch { return null; }
  }
  let out;
  try {
    const r = await git.run('git', ['diff', '--unified=0', `${oldSha}`, `${newSha}`, '--', file], { cwd });
    out = r.stdout || '';
  } catch { return null; }
  if (!out.trim()) return [];                            // fichier inchangé entre les deux
  const ranges = [];
  for (const m of out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+/gm)) {
    const start = parseInt(m[1], 10);
    const count = m[2] == null ? 1 : parseInt(m[2], 10);
    if (count === 0) ranges.push([start, start]);        // suppression pure : ancrée sur `start`
    else ranges.push([start, start + count - 1]);
  }
  return ranges;
}

const lineInRanges = (line, ranges) => {
  if (line == null) return true;      // sans ligne, on ne peut pas exiger la preuve → on l'accorde
  return ranges.some(([a, b]) => line >= a - 1 && line <= b + 1);   // ±1 : tolérance de décalage
};

/* Compare les constats de la passe courante à ceux de la précédente et renvoie,
   pour chacun, son statut. Effectue le contrôle git pour les constats disparus. */
async function diffFindings({ cwd, current, previous, oldSha, newSha, onLog = () => {} }) {
  const prevByFp = new Map(previous.map((f) => [f.fingerprint, f]));
  const curFps = new Set(current.map((f) => f.fingerprint));

  const rows = [];
  // Constats de la passe courante : nouveaux ou persistants.
  for (const f of current) {
    rows.push({ ...f, status: prevByFp.has(f.fingerprint) ? 'persistent' : 'new' });
  }
  // Constats de la passe précédente ayant disparu : résolus (vérifié) ou disparus.
  const vanished = previous.filter((f) => !curFps.has(f.fingerprint));
  // Cache des lignes changées par fichier, pour ne pas relancer git par constat.
  const changedCache = new Map();
  for (const f of vanished) {
    let ranges;
    if (changedCache.has(f.file)) ranges = changedCache.get(f.file);
    else { ranges = await changedOldLines(cwd, oldSha, newSha, f.file); changedCache.set(f.file, ranges); }
    let status;
    if (ranges === null) status = 'disappeared';         // impossible de vérifier → prudent
    else if (ranges.length === 0) status = 'disappeared'; // fichier inchangé → non re-signalé
    else status = lineInRanges(f.line, ranges) ? 'resolved' : 'disappeared';
    rows.push({ ...f, status });
  }
  const counts = {
    n_new: rows.filter((r) => r.status === 'new').length,
    n_persistent: rows.filter((r) => r.status === 'persistent').length,
    n_resolved: rows.filter((r) => r.status === 'resolved').length,
    n_disappeared: rows.filter((r) => r.status === 'disappeared').length,
  };
  onLog(t('log.resolution.summary', { resolus: counts.n_resolved, persistants: counts.n_persistent, nouveaux: counts.n_new, disparus: counts.n_disappeared }));
  return { rows, counts };
}

module.exports = { SEVERITIES, START, END, splitFindings, parseFindings, fingerprint, changedOldLines, diffFindings };
