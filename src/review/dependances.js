'use strict';
/* LES DÉPENDANCES AJOUTÉES PAR UNE MERGE REQUEST — « +2 dépendances » sur la carte, avant la review.
 *
 * C'est la deuxième question devant une merge request produite par un agent, après les tests : un
 * paquet ajouté pour trente lignes, la première bibliothèque venue, un nom qui n'existe pas sur le
 * registre. Personne ne lit le manifeste dans un diff de quatorze fichiers ; la carte le dit.
 *
 * Une dépendance ajoutée est un FAIT : une ligne de manifeste qui n'existait pas avant, lue par
 * comparaison des lignes `−` / `+` d'un diff que la forge envoie déjà — gardé au passage par le
 * relevé des fichiers (`croisements.js`, `mr_manifest_diff`), sans un appel de plus, sans IA, sans
 * registre, sans licence ni CVE. Rien n'est jugé : le badge compte, le panneau nomme, l'humain
 * décide. On compte les dépendances DIRECTES (celles du manifeste, que quelqu'un a choisies), pas
 * les lockfiles. Ce module n'importe rien de `agent/` et un test le garde fermé.
 *
 * Les analyseurs lisent des LIGNES, volontairement : un diff ne contient pas le fichier entier, un
 * parse JSON / TOML / XML n'aurait rien à parser. Quand une ligne ne se lit pas, ils ne comptent
 * rien ; un manifeste sans analyseur est dit « modifié, non analysé », jamais compté. */
const fs = require('fs');
const db = require('../db');
const glob = require('../core/glob');
const groupes = require('../data/groupes');
/* Le contrôle au registre (`registre.js`) : appelé SEULEMENT si son réglage est coché, à l'affichage
   et sans réseau — le réseau, c'est le tour de découverte (`croisements.releverTour`). */
const registre = require('./registre');

const DEFAUT_MANIFESTES = [
  'package.json', 'composer.json', 'requirements*.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml',
  'Gemfile', 'pom.xml', 'build.gradle*', '*.csproj',
];
const MAX_DIFF = 200 * 1024;      // au-delà, ce n'est plus un manifeste qu'on relit
const { MAX_MOTIFS, normaliserMotifs } = glob;

/* ---------- Les réglages ---------- */
const actif = (cfg) => String((cfg && cfg.deps_enabled) ?? '1') !== '0' && String((cfg && cfg.mr_files_enabled) ?? '1') !== '0';
const lignes = (texte) => String(texte || '').split('\n').map((l) => l.trim()).filter(Boolean);

/* Les motifs qui valent pour un dépôt : le dépôt s'il en porte, sinon l'union de ses groupes qui
   en portent, sinon le réglage global, sinon les défauts livrés — la même résolution que les tests
   touchés, et la source est nommée pour le lien du panneau. */
function motifsPour(cfg, repoId) {
  const repo = repoId ? db.prepare('SELECT id, manifest_patterns FROM repo WHERE id = ?').get(Number(repoId)) : null;
  if (repo && lignes(repo.manifest_patterns).length) return { manifests: lignes(repo.manifest_patterns), source: { kind: 'repo', repo_id: repo.id } };
  const porteurs = repo ? groupes.groupesDuDepot(repo.id).filter((g) => lignes(g.manifest_patterns).length) : [];
  if (porteurs.length) {
    return {
      manifests: [...new Set(porteurs.flatMap((g) => lignes(g.manifest_patterns)))],
      source: { kind: 'group', groups: porteurs.map((g) => ({ id: g.id, name: g.name })) },
    };
  }
  if (lignes(cfg && cfg.manifest_patterns).length) return { manifests: lignes(cfg.manifest_patterns), source: { kind: 'config' } };
  return { manifests: DEFAUT_MANIFESTES, source: { kind: 'default' } };
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
/* Le prédicat « ce chemin est un manifeste », passé au relevé et aux clients forge : le filtre se
   fait AVANT de jeter le reste des diffs, pour que la mémoire ne porte jamais tous les diffs. */
function predicat(motifs) {
  const res = (motifs || []).map(regexDe).filter(Boolean);
  return (chemin) => {
    const p = String(chemin || '').replace(/^\.?\//, '');
    return !!p && res.some((re) => re.test(p));
  };
}

/* ---------- Lire un diff ---------- */

/* Les blocs d'un diff unifié, un par fichier : `{ path, diff }`, le chemin étant le nouveau
   (l'ancien pour une suppression). */
function blocsDuDiff(diff) {
  const out = [];
  const texte = String(diff || '');
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let m; let prev = null;
  const pousser = (hdr, fin) => {
    if (!hdr) return;
    const chemin = hdr[2] && hdr[2] !== '/dev/null' ? hdr[2] : hdr[1];
    out.push({ path: chemin, diff: texte.slice(hdr.index, fin) });
  };
  while ((m = re.exec(texte))) { pousser(prev, m.index); prev = m; }
  pousser(prev, texte.length);
  return out;
}
const blocsManifestes = (diff, manifeste) => blocsDuDiff(diff).filter((b) => manifeste(b.path));

/* Les lignes d'un diff (d'un bloc ou d'un hunk nu comme la forge le rend), marquées `+`, `-` ou
   ` ` — les en-têtes exclus. */
function lignesDuDiff(texte) {
  const out = [];
  for (const l of String(texte || '').split('\n')) {
    if (/^(diff --git|index [0-9a-f]|@@ |\\ No newline|new file mode|deleted file mode|similarity index|rename (from|to)|old mode|new mode|Binary files)/.test(l)) continue;
    if (/^(---|\+\+\+) (a\/|b\/|\/dev\/null)/.test(l)) continue;
    const marque = l[0];
    if (marque === '+' || marque === '-' || marque === ' ') out.push({ marque, texte: l.slice(1) });
    else out.push({ marque: ' ', texte: l });
  }
  return out;
}

/* ---------- Les analyseurs, un par écosystème ----------
   Chacun lit les lignes dans l'ordre (contexte compris, pour connaître la section) et rend les
   entrées `{ name, version, section }` des lignes `-` et `+`. `section` : 'prod', 'dev' ou null
   (inconnue). */

const VERSION_NPM = /^(\^|~|[<>]=?|=|\*$|x$|\d|latest$|next$|workspace:|npm:|file:|link:|git|https?:|github:)/;
const CLES_JSON = new Set(['name', 'version', 'description', 'main', 'module', 'types', 'typings', 'license', 'author', 'homepage',
  'repository', 'bugs', 'private', 'type', 'keywords', 'files', 'bin', 'exports', 'browser', 'engines', 'scripts', 'config',
  'publishConfig', 'workspaces', 'sideEffects', 'packageManager', 'funding', 'minimum-stability', 'prefer-stable', 'autoload',
  'autoload-dev', 'extra', 'scripts-descriptions', 'authors', 'support', 'readme', 'unpkg', 'jsdelivr', 'style']);

/* `package.json`, `composer.json` : `"nom": "contrainte"` sous une section de dépendances. La
   section se lit par les lignes du hunk ; sans en-tête lisible, la ligne compte si elle ressemble
   à une dépendance (une valeur qui est une contrainte, un nom qui n'est pas une clé connue). */
function analyserJson(lgs, sections) {
  const moins = []; const plus = [];
  let section = null;     // null = inconnue, 'other' = une autre section, 'prod' / 'dev'
  for (const l of lgs) {
    const t = l.texte;
    const tete = t.match(/^\s*"([^"]+)"\s*:\s*[{[]\s*$/);
    if (tete) { section = sections[tete[1]] || 'other'; continue; }
    if (/^\s*[}\]]/.test(t)) { section = null; continue; }
    const e = t.match(/^\s*"([^"]+)"\s*:\s*"([^"]*)"\s*,?\s*$/);
    if (!e || l.marque === ' ' || section === 'other') continue;
    const [, name, version] = e;
    if (section === null && (CLES_JSON.has(name) || !VERSION_NPM.test(version.trim()))) continue;
    (l.marque === '+' ? plus : moins).push({ name, version, section });
  }
  return { moins, plus };
}

/* `requirements*.txt` : `nom[extras] opérateur version` ou `nom` seul ; `-r`, `--option`, `#`
   et les URL ignorés. */
function analyserRequirements(lgs) {
  const moins = []; const plus = [];
  for (const l of lgs) {
    if (l.marque === ' ') continue;
    const t = l.texte.trim();
    if (!t || t.startsWith('#') || t.startsWith('-') || /^https?:/.test(t) || t.startsWith('.') || t.startsWith('/')) continue;
    const e = t.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*([^#;]*)/);
    if (!e) continue;
    (l.marque === '+' ? plus : moins).push({ name: e[1], version: e[3].trim(), section: 'prod' });
  }
  return { moins, plus };
}

/* `pyproject.toml` : `"nom>=x"` dans `dependencies = [...]` (prod) ou les listes d'extras / de
   groupes (dev) ; `nom = "x"` sous `[tool.poetry.dependencies]` (prod), `[tool.poetry.dev-dependencies]`
   et `[tool.poetry.group.*.dependencies]` (dev quand le groupe s'appelle dev, test, lint, docs). */
function analyserPyproject(lgs) {
  const moins = []; const plus = [];
  let table = null;       // 'poetry-prod', 'poetry-dev', 'project', 'optional', 'groups', 'other'
  let liste = null;       // section de la liste `[...]` ouverte, sinon null
  for (const l of lgs) {
    const t = l.texte;
    const th = t.match(/^\s*\[([^\]]+)\]\s*$/);
    if (th) {
      const n = th[1].trim();
      if (n === 'tool.poetry.dependencies') table = 'poetry-prod';
      else if (n === 'tool.poetry.dev-dependencies') table = 'poetry-dev';
      else if (/^tool\.poetry\.group\.([^.]+)\.dependencies$/.test(n)) { const g = n.match(/^tool\.poetry\.group\.([^.]+)\./)[1]; table = /dev|test|lint|docs|typing/i.test(g) ? 'poetry-dev' : 'poetry-prod'; }
      else if (n === 'project') table = 'project';
      else if (n === 'project.optional-dependencies' || n === 'dependency-groups') table = 'optional';
      else table = 'other';
      liste = null;
      continue;
    }
    if (liste) {
      if (/^\s*\]/.test(t)) { liste = null; continue; }
      const e = t.match(/^\s*"([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*([^"]*)"/);
      if (e && l.marque !== ' ') (l.marque === '+' ? plus : moins).push({ name: e[1], version: e[3].trim(), section: liste });
      continue;
    }
    const ouverture = t.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*\[\s*$/);
    if (ouverture) {
      if (table === 'project' && ouverture[1] === 'dependencies') liste = 'prod';
      else if (table === 'optional') liste = 'dev';
      continue;
    }
    if (table === 'poetry-prod' || table === 'poetry-dev') {
      const e = t.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(?:"([^"]*)"|\{[^}]*?version\s*=\s*"([^"]*)"|\{)/);
      if (e && l.marque !== ' ') (l.marque === '+' ? plus : moins).push({ name: e[1], version: (e[2] ?? e[3] ?? '').trim(), section: table === 'poetry-dev' ? 'dev' : 'prod' });
    }
  }
  return { moins, plus };
}

/* `go.mod` : `module v1.2.3` dans un bloc `require (...)` ou sur une ligne `require module v…` ;
   `// indirect` est transitif, ignoré. */
function analyserGoMod(lgs) {
  const moins = []; const plus = [];
  let bloc = null;        // 'require', 'other'
  for (const l of lgs) {
    const t = l.texte;
    if (/^\s*require\s*\(\s*$/.test(t)) { bloc = 'require'; continue; }
    if (/^\s*(replace|exclude|retract|tool)\s*\(\s*$/.test(t)) { bloc = 'other'; continue; }
    if (/^\s*\)\s*$/.test(t)) { bloc = null; continue; }
    let e = null;
    if (bloc === 'require') e = t.match(/^\s*(\S+)\s+(v\S+)(.*)$/);
    else if (!bloc) { const s = t.match(/^\s*require\s+(\S+)\s+(v\S+)(.*)$/); if (s) e = s; }
    if (!e || l.marque === ' ' || /\/\/\s*indirect/.test(e[3])) continue;
    (l.marque === '+' ? plus : moins).push({ name: e[1], version: e[2], section: 'prod' });
  }
  return { moins, plus };
}

/* `Cargo.toml` : `nom = "x"` ou `nom = { version = "x", … }` sous `[dependencies]` (prod),
   `[dev-dependencies]` (dev), `[build-dependencies]`, `[workspace.dependencies]`, `[target.….dependencies]` ;
   la forme `[dependencies.nom]` + `version = "x"` aussi. */
function analyserCargo(lgs) {
  const moins = []; const plus = [];
  let section = 'other'; let tableNom = null;
  for (const l of lgs) {
    const t = l.texte;
    const th = t.match(/^\s*\[([^\]]+)\]\s*$/);
    if (th) {
      const n = th[1].trim();
      const m = n.match(/^(?:workspace\.|target\.[^.]+\.)?(dependencies|dev-dependencies|build-dependencies)(?:\.(\S+))?$/);
      if (m) { section = m[1] === 'dev-dependencies' ? 'dev' : 'prod'; tableNom = m[2] || null; } else { section = 'other'; tableNom = null; }
      continue;
    }
    if (section === 'other' || l.marque === ' ') continue;
    if (tableNom) {
      const v = t.match(/^\s*version\s*=\s*"([^"]*)"/);
      if (v) (l.marque === '+' ? plus : moins).push({ name: tableNom, version: v[1], section });
      continue;
    }
    const e = t.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|\{(.*)\})\s*$/);
    if (!e) continue;
    let version = e[2] ?? '';
    if (e[3] != null) {
      const v = e[3].match(/version\s*=\s*"([^"]*)"/); const src = e[3].match(/\b(git|path)\s*=/);
      version = v ? v[1] : (src ? src[1] : '');
    }
    (l.marque === '+' ? plus : moins).push({ name: e[1], version, section });
  }
  return { moins, plus };
}

/* `Gemfile` : `gem 'nom', 'x'` ; dans `group :test, :development do … end` ou avec `group: :test` → dev. */
function analyserGemfile(lgs) {
  const moins = []; const plus = [];
  let groupe = null; let profondeur = 0;
  for (const l of lgs) {
    const t = l.texte;
    const g = t.match(/^\s*group\s+(.+?)\s+do\s*$/);
    if (g) { groupe = /test|development/.test(g[1]) ? 'dev' : 'prod'; profondeur = 1; continue; }
    if (groupe && /\bdo\s*$/.test(t)) { profondeur += 1; continue; }
    if (groupe && /^\s*end\s*$/.test(t)) { profondeur -= 1; if (profondeur <= 0) groupe = null; continue; }
    const e = t.match(/^\s*gem\s+['"]([^'"]+)['"](.*)$/);
    if (!e || l.marque === ' ') continue;
    const reste = e[2];
    const versions = [...reste.matchAll(/,\s*['"]([^'"]+)['"]/g)].map((x) => x[1]).filter((v) => !/^(require|group|platforms?|source|git|github|branch|path|tag|ref)$/.test(v));
    const local = reste.match(/group:\s*(:\w+|\[[^\]]*\])/);
    const section = local ? (/test|development/.test(local[1]) ? 'dev' : 'prod') : (groupe || 'prod');
    (l.marque === '+' ? plus : moins).push({ name: e[1], version: versions.join(', '), section });
  }
  return { moins, plus };
}

/* `pom.xml` : un bloc `<dependency>` porte `<artifactId>`, `<version>`, `<scope>` sur des lignes
   séparées. On suit chaque bloc : son `<artifactId>` ajouté → ajoutée, retiré → retirée, inchangé
   avec une `<version>` `-` et une `+` → changée. `<scope>test</scope>` → dev. */
function analyserPom(lgs) {
  const moins = []; const plus = [];
  let bloc = null;
  for (const l of lgs) {
    const t = l.texte;
    if (/<dependency>/.test(t)) { bloc = { marqueNom: null, name: null, group: null, vMoins: null, vPlus: null, vCtx: null, scope: null, marqueBloc: l.marque }; continue; }
    if (!bloc) continue;
    const a = t.match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/);
    if (a) { bloc.name = a[1]; bloc.marqueNom = l.marque; continue; }
    // Le groupe sert au contrôle au registre (Maven Central cherche `g:a`) ; le nom affiché reste l'artefact.
    const g = t.match(/<groupId>\s*([^<\s]+)\s*<\/groupId>/);
    if (g) { bloc.group = g[1]; continue; }
    const v = t.match(/<version>\s*([^<]*?)\s*<\/version>/);
    if (v) { if (l.marque === '-') bloc.vMoins = v[1]; else if (l.marque === '+') bloc.vPlus = v[1]; else bloc.vCtx = v[1]; continue; }
    const s = t.match(/<scope>\s*([^<\s]+)\s*<\/scope>/);
    if (s) { bloc.scope = s[1]; continue; }
    if (/<\/dependency>/.test(t)) {
      const section = bloc.scope === 'test' ? 'dev' : 'prod';
      if (bloc.name) {
        const groupe = bloc.group ? { group: bloc.group } : {};
        if (bloc.marqueNom === '+' || (bloc.marqueNom === ' ' && bloc.marqueBloc === '+')) plus.push({ name: bloc.name, version: bloc.vPlus ?? bloc.vCtx ?? '', section, ...groupe });
        else if (bloc.marqueNom === '-' || (bloc.marqueNom === ' ' && bloc.marqueBloc === '-')) moins.push({ name: bloc.name, version: bloc.vMoins ?? bloc.vCtx ?? '', section, ...groupe });
        else if (bloc.vMoins != null || bloc.vPlus != null) {
          moins.push({ name: bloc.name, version: bloc.vMoins ?? bloc.vCtx ?? '', section, ...groupe });
          plus.push({ name: bloc.name, version: bloc.vPlus ?? bloc.vCtx ?? '', section, ...groupe });
        }
      }
      bloc = null;
    }
  }
  return { moins, plus };
}

/* `build.gradle`, `build.gradle.kts` : `implementation 'g:a:v'`, `api(...)`, `testImplementation`
   (→ dev), ou la notation `group: 'g', name: 'a', version: 'v'`. Le nom est `g:a`. */
const CONFIGS_GRADLE = /^\s*(implementation|api|compileOnly|compileOnlyApi|runtimeOnly|testImplementation|testCompileOnly|testRuntimeOnly|androidTestImplementation|annotationProcessor|kapt|ksp|debugImplementation|releaseImplementation|compile|testCompile|classpath)\s*\(?\s*(.*)$/;
function analyserGradle(lgs) {
  const moins = []; const plus = [];
  for (const l of lgs) {
    if (l.marque === ' ') continue;
    const e = l.texte.match(CONFIGS_GRADLE);
    if (!e) continue;
    const section = /^(test|androidTest)/.test(e[1]) ? 'dev' : 'prod';
    const reste = e[2];
    const court = reste.match(/^['"]([^'"]+)['"]/);
    let name = null; let version = '';
    if (court) {
      const parts = court[1].split(':');
      if (parts.length < 2) continue;
      name = `${parts[0]}:${parts[1]}`; version = parts[2] || '';
    } else {
      const g = reste.match(/group\s*[:=]\s*['"]([^'"]+)['"]/); const n = reste.match(/\bname\s*[:=]\s*['"]([^'"]+)['"]/); const v = reste.match(/version\s*[:=]\s*['"]([^'"]+)['"]/);
      if (!g || !n) continue;
      name = `${g[1]}:${n[1]}`; version = v ? v[1] : '';
    }
    (l.marque === '+' ? plus : moins).push({ name, version, section });
  }
  return { moins, plus };
}

/* `*.csproj` : `<PackageReference Include="nom" Version="x" />`. */
function analyserCsproj(lgs) {
  const moins = []; const plus = [];
  for (const l of lgs) {
    if (l.marque === ' ') continue;
    const t = l.texte;
    if (!/<PackageReference\b/.test(t)) continue;
    const n = t.match(/Include\s*=\s*"([^"]+)"/); const v = t.match(/Version\s*=\s*"([^"]+)"/);
    if (!n) continue;
    (l.marque === '+' ? plus : moins).push({ name: n[1], version: v ? v[1] : '', section: 'prod' });
  }
  return { moins, plus };
}

const ANALYSEURS = [
  { nom: 'package.json', test: (b) => b === 'package.json', lire: (l) => analyserJson(l, { dependencies: 'prod', devDependencies: 'dev', peerDependencies: 'prod', optionalDependencies: 'prod' }), python: false },
  { nom: 'composer.json', test: (b) => b === 'composer.json', lire: (l) => analyserJson(l, { require: 'prod', 'require-dev': 'dev' }) },
  { nom: 'requirements.txt', test: (b) => /^requirements.*\.txt$/.test(b), lire: analyserRequirements, python: true },
  { nom: 'pyproject.toml', test: (b) => b === 'pyproject.toml', lire: analyserPyproject, python: true },
  { nom: 'go.mod', test: (b) => b === 'go.mod', lire: analyserGoMod },
  { nom: 'Cargo.toml', test: (b) => b === 'Cargo.toml', lire: analyserCargo },
  { nom: 'Gemfile', test: (b) => b === 'Gemfile', lire: analyserGemfile },
  { nom: 'pom.xml', test: (b) => b === 'pom.xml', lire: analyserPom },
  { nom: 'build.gradle', test: (b) => /^build\.gradle(\.kts)?$/.test(b), lire: analyserGradle },
  { nom: 'csproj', test: (b) => /\.csproj$/.test(b), lire: analyserCsproj },
];
function analyseurPour(chemin) {
  const base = String(chemin || '').split('/').pop();
  return ANALYSEURS.find((a) => a.test(base)) || null;
}

/* ---------- Rapprocher ---------- */

/* Le majeur d'une contrainte : l'entier de tête de `^3.2`, `~3`, `3.x`, `>=3.0`, `v1.2.3` ; null
   quand il ne se lit pas (`*`, `latest`, une URL, rien). */
function majeurDe(contrainte) {
  const m = String(contrainte || '').trim().match(/^[\^~=\s]*(?:>=?|<=?|==|~=|!=)?\s*v?(\d+)/);
  return m ? Number(m[1]) : null;
}
/* true : le majeur change ; false : il ne change pas ; null : l'une des deux contraintes ne se lit pas. */
function sautDeMajeur(de, a) {
  const x = majeurDe(de); const y = majeurDe(a);
  if (x == null || y == null) return null;
  return x !== y;
}

const cle = (e, python) => (python ? e.name.toLowerCase().replace(/_/g, '-') : e.name);
/* `+` seul → ajoutée ; `−` seul → retirée ; les deux → changée si la contrainte diffère, rien
   sinon (une ligne déplacée). L'ordre du fichier est gardé dans chaque groupe. */
function rapprocher({ moins, plus }, python = false) {
  const parMoins = new Map(); const parPlus = new Map();
  for (const e of moins) if (!parMoins.has(cle(e, python))) parMoins.set(cle(e, python), e);
  for (const e of plus) if (!parPlus.has(cle(e, python))) parPlus.set(cle(e, python), e);
  const added = []; const removed = []; const changed = [];
  for (const e of plus) {
    const k = cle(e, python);
    if (!parMoins.has(k)) { if (parPlus.get(k) === e) added.push({ name: e.name, version: e.version, section: e.section, ...(e.group ? { group: e.group } : {}) }); continue; }
    const avant = parMoins.get(k);
    if (parPlus.get(k) !== e) continue;
    if (String(avant.version).trim() === String(e.version).trim()) continue;
    changed.push({ name: e.name, from: avant.version, to: e.version, section: e.section ?? avant.section, major: sautDeMajeur(avant.version, e.version) });
  }
  for (const e of moins) if (!parPlus.has(cle(e, python)) && parMoins.get(cle(e, python)) === e) removed.push({ name: e.name, version: e.version, section: e.section });
  return { added, removed, changed };
}

/* L'analyse d'UN manifeste : `{ path, parser, added, removed, changed }` ; `parser: null` quand
   aucun analyseur ne connaît ce fichier (un motif ajouté par l'équipe pour un écosystème non
   couvert) — « manifeste modifié, non analysé », sans compte. */
function analyser(chemin, diff) {
  const a = analyseurPour(chemin);
  if (!a) return { path: chemin, parser: null, added: [], removed: [], changed: [] };
  return { path: chemin, parser: a.nom, ...rapprocher(a.lire(lignesDuDiff(diff)), !!a.python) };
}

/* Le total de plusieurs manifestes, pour le badge. */
function totaux(analyses) {
  const t = { added: 0, removed: 0, changed: 0, major: 0, major_unknown: 0, unparsed: 0 };
  for (const a of analyses) {
    if (!a.parser) { t.unparsed += 1; continue; }
    t.added += a.added.length; t.removed += a.removed.length; t.changed += a.changed.length;
    for (const c of a.changed) { if (c.major === true) t.major += 1; else if (c.major === null) t.major_unknown += 1; }
  }
  return t;
}

/* ---------- Écrire (appelé par le relevé des fichiers) ---------- */

/* Les diffs des manifestes d'une merge request, sur son SHA de tête, dans le même geste que
   `mr_files`. `manifests: null` = le relevé ne les a pas cherchés (réglage décoché, liste refusée) :
   `mr_file_fetch.manifests` reste NULL et la carte n'affiche rien. Un diff de plus de 200 Ko n'est
   pas gardé, la ligne porte `refused = 'too-large'`. */
const poserManifestes = db.transaction((mrId, sha, manifests, { now = new Date().toISOString() } = {}) => {
  db.prepare('DELETE FROM mr_manifest_diff WHERE mr_id = ?').run(mrId);
  if (!Array.isArray(manifests)) {
    db.prepare('UPDATE mr_file_fetch SET manifests = NULL WHERE mr_id = ?').run(mrId);
    return 0;
  }
  const ins = db.prepare('INSERT OR REPLACE INTO mr_manifest_diff (mr_id, path, head_sha, diff, fetched_at, refused) VALUES (?, ?, ?, ?, ?, ?)');
  for (const m of manifests) {
    const texte = String(m.diff || '');
    if (Buffer.byteLength(texte, 'utf8') > MAX_DIFF) ins.run(mrId, m.path, sha || null, null, now, 'too-large');
    else ins.run(mrId, m.path, sha || null, texte, now, null);
  }
  db.prepare('UPDATE mr_file_fetch SET manifests = ? WHERE mr_id = ?').run(manifests.length, mrId);
  return manifests.length;
});

/* ---------- Lire ---------- */

/* Les manifestes FRAIS des merge requests ouvertes : le relevé porte sur la tête actuelle, n'a pas
   été refusé, et a bien cherché les manifestes. Rend `Map<mr_id, { repo_id, sha, at, rows[] }>`
   — une entrée même sans manifeste touché, pour distinguer « rien » de « pas cherché ». */
function manifestesFrais(mrIds = null) {
  const borne = Array.isArray(mrIds) && mrIds.length ? `AND mr.id IN (${mrIds.map(() => '?').join(',')})` : '';
  const par = new Map();
  for (const r of db.prepare(`SELECT mr.id, mr.repo_id, ff.head_sha, ff.fetched_at, d.path, d.diff, d.refused
      FROM mr JOIN mr_file_fetch ff ON ff.mr_id = mr.id AND ff.head_sha IS mr.current_sha AND ff.refused IS NULL AND ff.manifests IS NOT NULL
      LEFT JOIN mr_manifest_diff d ON d.mr_id = mr.id AND d.head_sha IS mr.current_sha
      WHERE COALESCE(mr.closed_seen, 0) = 0 ${borne} ORDER BY mr.id, d.path`).all(...(borne ? mrIds : []))) {
    if (!par.has(r.id)) par.set(r.id, { repo_id: r.repo_id, sha: r.head_sha, at: r.fetched_at, rows: [] });
    if (r.path) par.get(r.id).rows.push({ path: r.path, diff: r.diff, refused: r.refused });
  }
  return par;
}

/* LE CONTRÔLE AU REGISTRE sur les ajoutées d'un dépôt : chaque ligne ajoutée gagne `registry`, les
   comptes gagnent `unknown` / `recent`, et `registry` (sur la carte) dit si le contrôle est actif,
   quels registres ont été contactés et quand, et d'où viennent les motifs de paquets privés. Réglage
   décoché : `{ enabled: false }`, rien d'autre — et aucun appel à `registre.js` au-delà du réglage. */
function controler(cfg, repoId, analyses, { now = Date.now(), prives = null } = {}) {
  if (!registre.actif(cfg)) return { unknown: 0, recent: 0, registry: { enabled: false } };
  const ajoutees = analyses.flatMap((a) => (a.parser ? a.added.map((e) => ({ ...e, parser: a.parser })) : []));
  const enrichies = registre.pourDependances(cfg, repoId, ajoutees, { now, prives });
  let i = 0;
  for (const a of analyses) if (a.parser) for (const e of a.added) { e.registry = enrichies[i] || null; i += 1; }
  const t = registre.totaux(enrichies);
  return { unknown: t.unknown, recent: t.recent, registry: { enabled: true, contacted: t.contacted, private: registre.motifsPrives(cfg, repoId).source } };
}

/* CE QUE LA CARTE AFFICHE, par merge request : les comptes, les manifestes avec leurs lignes
   (ajoutées, puis changées, puis retirées, dans l'ordre du fichier), d'où viennent les motifs, le
   relevé, et un refus éventuel. Absent = rien à dire (aucun manifeste touché, ou pas cherché). */
function pourCartes(cfg, { mrIds = null } = {}) {
  const out = {};
  if (!actif(cfg)) return out;
  const motifsParRepo = new Map();
  const privesParRepo = new Map();
  for (const [id, m] of manifestesFrais(mrIds)) {
    const refused = m.rows.some((r) => r.refused) ? 'too-large' : null;
    const analyses = m.rows.filter((r) => !r.refused).map((r) => analyser(r.path, r.diff));
    const t = totaux(analyses);
    if (!refused && t.added + t.removed + t.changed + t.unparsed === 0) continue;
    if (!motifsParRepo.has(m.repo_id)) motifsParRepo.set(m.repo_id, motifsPour(cfg, m.repo_id));
    if (t.added && registre.actif(cfg) && !privesParRepo.has(m.repo_id)) privesParRepo.set(m.repo_id, registre.privesDuClone(cfg, db.prepare('SELECT * FROM repo WHERE id = ?').get(m.repo_id)));
    const reg = t.added ? controler(cfg, m.repo_id, analyses, { prives: privesParRepo.get(m.repo_id) || null }) : { unknown: 0, recent: 0, registry: { enabled: registre.actif(cfg) } };
    out[id] = {
      ...t, alert: t.added > 0, unknown: reg.unknown, recent: reg.recent,
      manifests: analyses.filter((a) => !a.parser || a.added.length + a.removed.length + a.changed.length),
      patterns: motifsParRepo.get(m.repo_id).source, registry: reg.registry,
      fetch: { sha: m.sha, at: m.at }, refused,
    };
  }
  return out;
}

/* LES DÉPENDANCES AJOUTÉES PAR LES MR OUVERTES, pour le tour de contrôle au registre :
   `[{ repo_id, parser, name, group }]`, sans dédoublonnage (le tour le fait par écosystème + nom). */
function ajouteesOuvertes(cfg) {
  const out = [];
  if (!actif(cfg)) return out;
  for (const m of manifestesFrais().values()) {
    for (const r of m.rows) {
      if (r.refused) continue;
      const a = analyser(r.path, r.diff);
      if (a.parser) for (const e of a.added) out.push({ repo_id: m.repo_id, parser: a.parser, name: e.name, group: e.group || null });
    }
  }
  return out;
}

/* LES MR QUI AJOUTENT DES DÉPENDANCES, pour le brief : celles dont le badge est accentué, les plus
   anciennes d'abord. `key` est ce qu'on écarte : CETTE merge request SUR CE SHA. */
function ajoutantDesDependances(cfg, limite = 8) {
  const cartes = pourCartes(cfg);
  const ids = Object.keys(cartes).filter((id) => cartes[id].alert).map(Number);
  if (!ids.length) return [];
  const out = db.prepare(`SELECT mr.id, mr.iid, mr.title, mr.author, mr.gitlab_created_at, mr.repo_id, mr.status, repo.project
      FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id IN (${ids.map(() => '?').join(',')})
      ORDER BY mr.gitlab_created_at IS NULL, mr.gitlab_created_at, mr.id`).all(...ids)
    .map((m) => ({
      key: `${m.id}:${cartes[m.id].fetch.sha || ''}`, mr_id: m.id, iid: m.iid, title: m.title || '', author: m.author || '', status: m.status,
      project: m.project, repo_id: m.repo_id, added: cartes[m.id].added, major: cartes[m.id].major, created_at: m.gitlab_created_at,
      unknown: cartes[m.id].unknown || 0, recent: cartes[m.id].recent || 0,
    }));
  return limite > 0 ? out.slice(0, limite) : out;
}

/* LA LIGNE DE PROJET D'UNE SESSION DE CODAGE : le diff de la branche (`task_target.diff_path`, écrit
   à chaque passe — base...tête, manifestes compris) analysé avec les motifs du dépôt. Mémorisé par
   commit : l'écran se redessine toutes les secondes et demie. `null` sans commit, sans diff, hors
   dépôt, ou réglage décoché. */
const cacheCibles = new Map();
function pourCible(cfg, cible) {
  if (!actif(cfg) || !cible || !cible.commit_sha || !cible.diff_path || !cible.repo_id) return null;
  const motifs = motifsPour(cfg, cible.repo_id);
  const k = [cible.id, cible.commit_sha, cible.diff_path, motifs.manifests.join('|')].join('\u0001');
  let lu = cacheCibles.get(k);
  if (!lu) {
    let diff = null;
    try { diff = fs.readFileSync(cible.diff_path, 'utf8'); } catch { return null; }
    const analyses = blocsManifestes(diff, predicat(motifs.manifests)).map((b) => analyser(b.path, b.diff));
    const t = totaux(analyses);
    lu = {
      r: { added: t.added, removed: t.removed, changed: t.changed, major: t.major, unknown: 0, recent: 0 },
      ajoutees: analyses.flatMap((a) => (a.parser ? a.added.map((e) => ({ ...e, parser: a.parser, repo_id: cible.repo_id })) : [])),
    };
    if (cacheCibles.size > 500) cacheCibles.clear();
    cacheCibles.set(k, lu);
  }
  /* Le contrôle au registre de la branche, HORS du cache : les comptes se relisent à chaque rendu, et ce
     qui manque part en arrière-plan, dix noms au plus par session — le rendu suivant les montre. */
  if (lu.ajoutees.length && registre.actif(cfg)) {
    const reg = registre.totaux(registre.pourDependances(cfg, cible.repo_id, lu.ajoutees));
    registre.controlerBientot(cfg, `cible:${cible.id}:${cible.commit_sha}`, lu.ajoutees);
    return { ...lu.r, unknown: reg.unknown, recent: reg.recent };
  }
  return { ...lu.r };
}

/* L'APERÇU D'UN RÉGLAGE : « sur les MR ouvertes de ce dépôt, ces motifs désignent 3 manifestes » —
   compté sur `mr_files`, pour vérifier un motif sans attendre une merge request. */
function apercu(cfg, { repoId = null, groupId = null, manifest_patterns = null } = {}) {
  let repoIds = null;
  if (repoId) repoIds = [Number(repoId)];
  else if (groupId) repoIds = groupes.membres(groupId);
  const borne = repoIds ? `AND mr.repo_id IN (${repoIds.length ? repoIds.map(() => '?').join(',') : 'NULL'})` : '';
  const rows = db.prepare(`SELECT mr.id, mr.repo_id, f.path FROM mr
      JOIN mr_file_fetch ff ON ff.mr_id = mr.id AND ff.head_sha IS mr.current_sha AND ff.refused IS NULL
      LEFT JOIN mr_files f ON f.mr_id = mr.id
      WHERE COALESCE(mr.closed_seen, 0) = 0 ${borne}`).all(...(repoIds || []));
  const out = { mrs: 0, manifests: 0, with_manifest: 0 };
  const vus = new Set(); const avec = new Set();
  const predicats = new Map();
  for (const r of rows) {
    vus.add(r.id);
    if (!r.path) continue;
    if (!predicats.has(r.repo_id)) predicats.set(r.repo_id, predicat(lignes(manifest_patterns).length ? lignes(manifest_patterns) : motifsPour(cfg, r.repo_id).manifests));
    if (predicats.get(r.repo_id)(r.path)) { out.manifests += 1; avec.add(r.id); }
  }
  out.mrs = vus.size; out.with_manifest = avec.size;
  return out;
}

/* ---------- Purger ---------- */
function purger(mrIds) {
  const ids = (Array.isArray(mrIds) ? mrIds : [mrIds]).map(Number).filter(Number.isInteger);
  if (!ids.length) return 0;
  return db.prepare(`DELETE FROM mr_manifest_diff WHERE mr_id IN (${ids.map(() => '?').join(',')})`).run(...ids).changes;
}

module.exports = {
  DEFAUT_MANIFESTES, MAX_DIFF, MAX_MOTIFS,
  actif, normaliserMotifs, motifsPour, predicat,
  blocsDuDiff, blocsManifestes, lignesDuDiff, analyseurPour, analyser, rapprocher, totaux, majeurDe, sautDeMajeur,
  poserManifestes, pourCartes, ajouteesOuvertes, ajoutantDesDependances, pourCible, apercu, purger,
};
