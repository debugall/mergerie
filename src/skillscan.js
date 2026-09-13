'use strict';
/* Découverte des skills et des sous-agents de fichier (spec agents §8.4).
 *
 * Un skill est un DOSSIER sur le disque (`<nom>/SKILL.md`), un sous-agent de fichier un
 * `.claude/agents/<nom>.md` : ni l'un ni l'autre n'a de place en base, parce que la vérité
 * est le disque et que la recopier ferait diverger les deux. Mergerie les LIT, les liste, et
 * ne les écrit jamais — écrire dans le `.claude/` d'un dépôt ou de l'utilisateur est un
 * interdit de la spécification (§18).
 *
 * Deux sources : les clones des dépôts (le skill d'équipe, versionné avec le code) et le home
 * de l'utilisateur (le sien). Un dépôt non cloné n'est pas une erreur : il est SIGNALÉ, parce
 * que sans ça la liste serait silencieusement incomplète et personne ne saurait pourquoi son
 * skill n'apparaît pas.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('./git');
const { t } = require('../public/i18n-runtime.js');

const TTL_MS = 5 * 60 * 1000;
let cache = null; // { cle, at, valeur }

/* Le home où chercher `.claude/`. `MERGERIE_CLAUDE_HOME` existe pour les tests : déplacer
   `HOME` lui-même casserait tout le reste de la machine de test (le cache des navigateurs
   Playwright y vit, entre autres), là où cette variable ne déplace que ce scan. */
function homeDir() {
  return process.env.MERGERIE_CLAUDE_HOME || os.homedir();
}

/* Frontmatter minimal : un bloc `---` en tête, des lignes `clé: valeur`. On ne dépend d'aucun
   parseur YAML — le format réellement utilisé par ces fichiers tient en ces deux règles, et un
   fichier plus exotique doit dégrader vers « pas de frontmatter » plutôt que faire échouer un
   scan qui liste vingt autres skills corrects. */
function lireFrontmatter(texte) {
  const s = String(texte || '');
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, corps: s };
  const data = {};
  for (const ligne of m[1].split(/\r?\n/)) {
    const mm = ligne.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!mm) continue;
    data[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return { data, corps: s.slice(m[0].length) };
}

const premiereLigne = (corps) => (String(corps || '').split(/\r?\n/).find((l) => l.trim() && !/^#/.test(l.trim())) || '').trim();

// `allowed-tools: Read, Grep` ou `tools: [Read, Grep]` : virgules et espaces, crochets écartés.
function outilsDe(v) {
  if (v == null) return [];
  return String(v).replace(/^\[|\]$/g, '').split(/[,\s]+/).map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function lireUn(fichier, { nomDefaut, source, repoId, project, cheminAffiche, kind }) {
  let texte = '';
  try { texte = fs.readFileSync(fichier, 'utf8'); } catch { return null; }
  const { data, corps } = lireFrontmatter(texte);
  return {
    name: String(data.name || nomDefaut).trim(),
    description: String(data.description || premiereLigne(corps) || '').slice(0, 300),
    source,
    repo_id: repoId || null,
    project: project || null,
    path: cheminAffiche,
    kind,
    /* Deux drapeaux qui changent la façon dont on s'en sert : `user-invocable: false` interdit
       le `/nom` dans la demande (il faut alors le nommer en toutes lettres), et
       `disable-model-invocation: true` dit que l'agent ne le choisira jamais de lui-même. */
    userInvocable: String(data['user-invocable'] ?? '') !== 'false',
    modelInvocable: String(data['disable-model-invocation'] ?? '') !== 'true',
    tools: outilsDe(data['allowed-tools'] != null ? data['allowed-tools'] : data.tools),
  };
}

function listerDossier(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// Les skills d'une racine `.claude` : `<racine>/skills/<nom>/SKILL.md`.
function skillsDe(racine, meta) {
  const out = [];
  for (const e of listerDossier(path.join(racine, 'skills'))) {
    if (!e.isDirectory()) continue;
    const f = path.join(racine, 'skills', e.name, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    const x = lireUn(f, { ...meta, nomDefaut: e.name, kind: 'skill', cheminAffiche: `${meta.prefixe}/.claude/skills/${e.name}/SKILL.md` });
    if (x) out.push(x);
  }
  return out;
}

// Les sous-agents de fichier : `<racine>/agents/<nom>.md`.
function sousAgentsDe(racine, meta) {
  const out = [];
  for (const e of listerDossier(path.join(racine, 'agents'))) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const nom = e.name.replace(/\.md$/, '');
    const x = lireUn(path.join(racine, 'agents', e.name), {
      ...meta, nomDefaut: nom, kind: 'agent', cheminAffiche: `${meta.prefixe}/.claude/agents/${e.name}`,
    });
    if (x) out.push(x);
  }
  return out;
}

/* Scan complet. `repos` : les dépôts à regarder (déjà filtrés par l'appelant). Rend aussi les
   projets NON CLONÉS : c'est la seule façon d'expliquer une liste courte. */
function scanBrut({ repos, cfg }) {
  const items = [];
  const uncloned = [];
  for (const repo of repos || []) {
    let dir = null;
    try { dir = git.cloneDirFor(cfg, repo); } catch { dir = null; }
    if (!dir || !fs.existsSync(dir)) { uncloned.push(repo.project); continue; }
    const meta = { source: 'repo', repoId: repo.id, project: repo.project, prefixe: repo.project };
    items.push(...skillsDe(path.join(dir, '.claude'), meta));
    items.push(...sousAgentsDe(path.join(dir, '.claude'), meta));
  }
  // Le home de l'utilisateur. Chemins affichés relatifs au home : un chemin absolu n'apprend
  // rien de plus et met le nom du compte à l'écran.
  const home = { source: 'user', repoId: null, project: null, prefixe: '~' };
  items.push(...skillsDe(path.join(homeDir(), '.claude'), home));
  items.push(...sousAgentsDe(path.join(homeDir(), '.claude'), home));
  return { items, uncloned };
}

/* Cache mémoire : un scan lit quelques dizaines de fichiers, et la modale de session le
   redemande à chaque changement de cibles. La clé porte les dépôts ET le home : deux appels
   sur des périmètres différents ne doivent pas se rendre la réponse de l'autre. */
function scan({ repos, cfg }) {
  const ids = (repos || []).map((r) => r.id).sort((a, b) => a - b);
  const cle = `${ids.join(',')}|${homeDir()}|${(cfg && cfg.clone_path) || ''}`;
  if (cache && cache.cle === cle && Date.now() - cache.at < TTL_MS) return cache.valeur;
  const valeur = scanBrut({ repos, cfg });
  cache = { cle, at: Date.now(), valeur };
  return valeur;
}

// Appelé par la route de rescan et par `git.ensureRepo` après un fetch : un skill ajouté
// dans le dépôt doit apparaître au prochain regard, pas cinq minutes plus tard.
function invalidate() { cache = null; }

/* La ligne de skills qui ouvre la demande (spec agents §8.6, point 1).
 *
 * Le client envoie ce qu'il a coché ; on le RÉSOUT contre le disque plutôt que de recopier
 * son texte — c'est la seule façon de savoir si un skill accepte le `/nom` (`user-invocable`),
 * et ça évite qu'un corps de requête fabriqué injecte n'importe quoi en tête du prompt.
 * Un skill qui n'accepte pas le `/nom` est NOMMÉ en toutes lettres : l'agent le choisira ou
 * non, mais il saura qu'il existe. */
function ligneSkills(choisis, { repos, cfg }) {
  if (!Array.isArray(choisis) || !choisis.length) return '';
  const { items } = scan({ repos, cfg });
  const morceaux = [];
  for (const c of choisis) {
    const s = items.find((x) => x.name === (c && c.name)
      && x.source === (c && c.source)
      && (x.repo_id || null) === ((c && c.repo_id) || null)
      && x.kind === 'skill');
    if (!s) continue;
    morceaux.push(s.userInvocable ? `/${s.name}` : t('agents.prompt.use-skill', { name: s.name }));
  }
  return morceaux.join(' ');
}

module.exports = { scan, invalidate, lireFrontmatter, ligneSkills };
