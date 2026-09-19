#!/usr/bin/env node
'use strict';
/* LA DIRECTION DES DÉPENDANCES EST UN CONTRÔLE, PAS UNE INTENTION (refacto.md, §2 et §3.3).

   `src/` est rangé par couche, et une couche n'importe que ce qui est en dessous d'elle :

       app  →  jobs  →  session · review · verify · agent · notes · integrations
                                 ↓
                           forge · git · data · db
                                 ↓
                               core

   Ce script lit chaque `require` relatif de `src/` — en tête de fichier ou paresseux, dans une
   fonction —, retrouve le dossier de l'importeur et de l'importé, et refuse ce que le schéma
   interdit. Trois règles nommées s'y ajoutent, et une exception se déclare ICI, avec son motif,
   jamais en silence :
   — `gitlab.js` et `github.js` ne sont importés que par la porte `forge` (`forge/index.js`) ;
   — `db/` ne lit de `data/` que le registre des familles, qui est pur ;
   — rien n'importe `app/` ; `jobs/` et `demo/` ne sont importés que par qui est nommé.

   Et AUCUN CYCLE — sauf ceux qui existaient quand la règle est née, listés nommément dans
   `CYCLES_CONNUS`. Un cycle cassé se RETIRE de la liste dans le même commit (le contrôle
   l'exige : une entrée qui ne correspond plus à rien est une erreur), un cycle nouveau échoue.
   La liste vide marque la fin de l'étape 5 de refacto.md. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'src');

let failures = 0;
const fail = (title, items) => {
  failures++;
  console.log(`\n❌ ${title} (${items.length})`);
  items.forEach((i) => console.log(`   ${i}`));
};
const ok = (msg) => console.log(`✅ ${msg}`);

/* ---------- Ce que chaque dossier a le droit d'importer ---------- */

/* Le rang d'une couche : on importe son rang ou un rang inférieur. Les dossiers d'un même rang
   peuvent s'importer entre eux (`verify` lit `integrations/jira`, `review` lit `agent`). */
const RANG = {
  core: 0,
  db: 1, data: 1, forge: 1, git: 1,
  agent: 2, review: 2, session: 2, verify: 2, notes: 2, integrations: 2,
  jobs: 3,
  app: 4, racine: 4,
  demo: 4,
};

/* Ce qu'un rang n'a PAS le droit d'importer, même en dessous — les portes gardées. */
const INTERDITS = {
  core: (vers) => vers !== 'core' && 'core/ n’importe rien hors de core/',
  db: (vers, versFichier) => vers === 'data' && path.basename(versFichier) !== 'store-registry.js'
    && 'db/ ne lit de data/ que store-registry.js (pur)',
  forge: (vers) => !['core', 'forge'].includes(vers) && 'forge/ n’importe que core/',
};

/* Qui a le droit d'importer un dossier gardé. */
const IMPORTEURS = {
  /* Seul le point d'entrée (`server.js`, à la racine) monte la couche HTTP : il charge les
     middlewares et les routes dans l'ordre qui fait la sécurité du serveur. */
  app: { dossiers: ['racine'], fichiers: [], motif: 'rien n’importe la couche HTTP, sauf server.js qui la monte' },
  jobs: { dossiers: ['app', 'racine', 'jobs'], fichiers: [
    /* Lancer un agent depuis son profil ouvre un job : c'est le seul chemin qui remonte, et
       il est nommé — refacto.md §4.5, `agent/profile/lancer.js`. Tant que agent/profile.js n'est
       pas découpé, c'est lui. */
    'agent/profile.js', 'agent/profile/lancer.js',
  ], motif: 'la file de jobs se lance depuis app/, pas depuis le métier' },
  demo: { dossiers: ['app', 'racine', 'jobs', 'demo'], fichiers: [
    /* Les modules qui savent déjà répondre en mode démo (`isDemo()`), et eux seuls. */
    'review/reviewer.js', 'verify/verifyrun.js', 'integrations/dictation.js', 'git/gitops.js', 'session/taskrunner.js',
  ], motif: 'le mode démo se branche depuis app/ et cinq modules nommés' },
};

/* LES ARÊTES TOLÉRÉES, une par une, avec leur motif — et le commit qui les fera disparaître. */
const EXCEPTIONS = [
  /* Le cycle git ↔ skillscan : `git.js` invalide le cache des skills après un fetch, par un
     require paresseux. Se casse à l'étape 5 de refacto.md (un événement `apresFetch`). */
  { de: 'git/git.js', vers: 'agent/skillscan.js', motif: 'cycle connu, cassé à l’étape 5' },
];

/* `gitlab.js` et `github.js` : la règle de CLAUDE.md, enfin vérifiée. */
const PORTE_FORGE = ['forge.js', 'forge/index.js'];

/* Les cycles qui existaient quand la règle est née — chacun comme l'ensemble des fichiers qui
   se tiennent (une composante fortement connexe), par nom de fichier, où qu'ils soient rangés.
   L'ordre importe peu, l'ensemble oui. */
const CYCLES_CONNUS = [
  ['git.js', 'skillscan.js'],
  ['profile.js', 'schedule.js', 'knowledge.js', 'jobs.js', 'taskrunner.js', 'reviewer.js', 'converge.js'],
];

/* ---------- Le graphe ---------- */

function tousLesJs(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tousLesJs(p, base, out);
    else if (e.name.endsWith('.js')) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}
const fichiers = tousLesJs(SRC);
const dossierDe = (rel) => (rel.includes('/') ? rel.split('/')[0] : 'racine');
const nomDe = (rel) => `src/${rel}`;
const estDemo = (rel) => dossierDe(rel) === 'demo' || path.basename(rel).startsWith('demo-');

function resoudre(depuisRel, rel) {
  const base = path.resolve(SRC, path.dirname(depuisRel), rel);
  for (const c of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      const r = path.relative(SRC, c);
      return r.startsWith('..') ? null : r.split(path.sep).join('/');
    }
  }
  return null;
}

const graphe = new Map();   // rel → [{ vers, ligne }]
const casses = [];
for (const f of fichiers) {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8');
  const aretes = [];
  code.split('\n').forEach((l, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;
    for (const m of l.matchAll(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g)) {
      const vers = resoudre(f, m[2]);
      if (vers === null) {
        /* Hors de src/ (`../public/…`) : légitime ; ou cassé : Node le dira au premier chargement.
           Les fixtures de démo CONTIENNENT du code inventé (`require('./schemas')` dans un diff
           fictif) : ce ne sont pas des imports, on ne les compte pas. */
        if (!estDemo(f) && !fs.existsSync(path.resolve(SRC, path.dirname(f), m[2]))
          && !fs.existsSync(path.resolve(SRC, path.dirname(f), m[2]) + '.js')) {
          casses.push(`${nomDe(f)}:${i + 1}  require('${m[2]}') — ne mène nulle part`);
        }
        continue;
      }
      aretes.push({ vers, ligne: i + 1 });
    }
  });
  graphe.set(f, aretes);
}
casses.length ? fail('require qui ne mènent nulle part', casses) : ok(`Tous les require se résolvent (${fichiers.length} fichiers)`);

/* ---------- La matrice ---------- */
{
  const soucis = [];
  for (const [de, aretes] of graphe) {
    const dDe = dossierDe(de);
    for (const { vers, ligne } of aretes) {
      const dVers = dossierDe(vers);
      const ou = `${nomDe(de)}:${ligne}  → ${nomDe(vers)}`;
      if (RANG[dDe] === undefined) { soucis.push(`${ou} — dossier « ${dDe} » inconnu du schéma (refacto.md §2)`); continue; }
      if (RANG[dVers] === undefined) { soucis.push(`${ou} — dossier « ${dVers} » inconnu du schéma (refacto.md §2)`); continue; }
      /* Un fichier encore à la racine de `src/` n'est pas classé : le temps du déménagement,
         l'importer ne dit rien de la direction. Une fois `server.js` et `cli.js` seuls à la
         racine, plus rien ne les importe, et la ligne ne sert plus. */
      if (dVers === 'racine') continue;
      if (EXCEPTIONS.some((e) => e.de === de && e.vers === vers)) continue;
      if (dVers !== dDe && RANG[dVers] > RANG[dDe] && !IMPORTEURS[dVers]) {
        soucis.push(`${ou} — ${dDe}/ (rang ${RANG[dDe]}) importe ${dVers}/ (rang ${RANG[dVers]}) : la flèche remonte`);
        continue;
      }
      const interdit = INTERDITS[dDe] && INTERDITS[dDe](dVers, vers);
      if (interdit) { soucis.push(`${ou} — ${interdit}`); continue; }
      const garde = IMPORTEURS[dVers];
      if (garde && dDe !== dVers && !garde.dossiers.includes(dDe) && !garde.fichiers.includes(de) && !garde.fichiers.includes(path.basename(de))) {
        soucis.push(`${ou} — ${garde.motif}`);
        continue;
      }
      if (['gitlab.js', 'github.js'].includes(path.basename(vers)) && !PORTE_FORGE.includes(de)) {
        soucis.push(`${ou} — GitLab et GitHub ne se parlent qu'à travers forge (clientFor)`);
      }
    }
  }
  soucis.length
    ? fail('Dépendances qui violent le schéma des couches (refacto.md §2)', soucis)
    : ok(`Chaque import respecte la direction des couches (${[...new Set(fichiers.map(dossierDe))].length} dossiers)`);
}

/* ---------- Les cycles (composantes fortement connexes, Tarjan) ---------- */
{
  let index = 0;
  const idx = new Map(); const low = new Map(); const pile = []; const dessus = new Set();
  const composantes = [];
  const visiter = (v) => {
    idx.set(v, index); low.set(v, index); index++;
    pile.push(v); dessus.add(v);
    for (const { vers } of graphe.get(v) || []) {
      if (!idx.has(vers)) { visiter(vers); low.set(v, Math.min(low.get(v), low.get(vers))); }
      else if (dessus.has(vers)) low.set(v, Math.min(low.get(v), idx.get(vers)));
    }
    if (low.get(v) === idx.get(v)) {
      const c = [];
      let w;
      do { w = pile.pop(); dessus.delete(w); c.push(w); } while (w !== v);
      if (c.length > 1 || (graphe.get(v) || []).some((a) => a.vers === v)) composantes.push(c.sort());
    }
  };
  for (const f of fichiers) if (!idx.has(f)) visiter(f);

  const cle = (c) => c.map((f) => path.basename(f)).sort().join(' ');
  const connus = new Set(CYCLES_CONNUS.map(cle));
  const trouves = new Set(composantes.map(cle));
  const nouveaux = composantes.filter((c) => !connus.has(cle(c)));
  const disparus = CYCLES_CONNUS.filter((c) => !trouves.has(cle(c)));
  const soucis = [
    ...nouveaux.map((c) => `cycle : ${c.map(nomDe).join(' ↔ ')}`),
    ...disparus.map((c) => `CYCLES_CONNUS : « ${c.join(', ')} » n'existe plus (ou a changé de forme) — à retirer ou à réécrire dans scripts/check-deps.js`),
  ];
  soucis.length
    ? fail('Cycles de dépendances hors de la liste connue', soucis)
    : ok(composantes.length
      ? `Aucun cycle nouveau (${composantes.length} connu${composantes.length > 1 ? 's' : ''}, à casser — refacto.md étape 5)`
      : 'Aucun cycle de dépendances');
}

console.log(failures ? '\nContrôles des dépendances : ÉCHEC\n' : '\nContrôles des dépendances : OK\n');
process.exit(failures ? 1 : 0);
