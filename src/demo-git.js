'use strict';
/* Données STATIQUES des onglets Git pour le mode démo (MERGERIE_DEMO=1).

   Les vrais écrans Git (Explorateur, Trouver une ref, Actions) interrogent GitLab et un
   clone local EN DIRECT. Hors-ligne — comme la démo — ils seraient donc vides. Ce module
   fournit à la place un jeu fictif COHÉRENT, calé sur les 3 dépôts semés par demo-seed.js,
   uniquement pour la CONSULTATION : les boutons d'action (Créer la MR, Supprimer, Exécuter)
   ne modifient rien (voir server.js : /api/git/execute court-circuité en démo).

   Un seul jeu de vérité par dépôt (branches + tags) ; les différentes formes de réponse
   (refs, explorateur, trouver-une-ref, aperçu d'action) en dérivent pour rester cohérentes. */

const BASE = 'https://gitlab.demo';
const iso = (days) => new Date(Date.now() - days * 86400000).toISOString();
const refUrl = (project, kind, name) => `${BASE}/${project}/${kind === 'tag' ? '-/tags/' : '-/tree/'}${encodeURIComponent(name)}`;
const mrUrl = (project, iid) => `${BASE}/${project}/-/merge_requests/${iid}`;

// tag.branches : [nom, estSurLaPointe] — la 2e valeur dit si le tag pointe le dernier
// commit de cette branche (⇒ le ✓ dans « Trouver une ref »). La cohérence des SHA est
// respectée : un tag « sur la pointe » d'une branche partage le sha de cette branche.
function dataset() {
  return {
    'groupe/api-core': {
      default: 'main',
      branches: [
        { name: 'main', sha: 'a1b2c3d4', protected: true, days: 0.2, author: 'Lina Roux', ahead: 0, behind: 0, origin: null },
        { name: 'feat/PROJ-812-health', sha: 'b2c3d4e5', days: 0.4, author: 'Karim Belkacem', ahead: 3, behind: 2, origin: 'main', originConfidence: 'certain', openMr: 201 },
        { name: 'feat/PROJ-833-order-index', sha: 'c3d4e5f6', days: 2.1, author: 'Sofia Marchetti', ahead: 1, behind: 6, origin: 'main', originConfidence: 'inferred' },
        { name: 'feat/PROJ-700-upload', sha: 'd4e5f6a7', days: 4.5, author: 'Lina Roux', ahead: 0, behind: 9, mergedInto: 'main', mergedMr: 230, origin: 'main', originConfidence: 'certain' },
        { name: 'release/2.4', sha: 'e5f6a7b8', protected: true, days: 12, author: 'Lina Roux', ahead: 0, behind: 24, origin: 'main', originConfidence: 'inferred' },
      ],
      tags: [
        { name: 'v2.4.0', sha: 'e5f6a7b8', days: 12, author: 'Lina Roux', annotated: true, protected: true, tagger: 'Release Bot', message: 'Release 2.4.0 — sondes de santé et rate limiting', branches: [['release/2.4', true], ['main', false]] },
        { name: 'v2.3.1', sha: '77aa88bb', days: 34, author: 'Karim Belkacem', annotated: false, message: '', branches: [['main', false]] },
      ],
    },
    'groupe/webapp-front': {
      default: 'main',
      branches: [
        { name: 'main', sha: 'f0e1d2c3', protected: true, days: 0.5, author: 'Sofia Marchetti', ahead: 0, behind: 0, origin: null },
        { name: 'feat/PROJ-720-checkout', sha: '3c4d5e6f', days: 1, author: 'Sofia Marchetti', ahead: 4, behind: 0, origin: 'main', originConfidence: 'certain', openMr: 220 },
        { name: 'feat/PROJ-790-login', sha: '1a2b3c4d', days: 0.8, author: 'Karim Belkacem', ahead: 5, behind: 1, origin: 'main', originConfidence: 'inferred', openMr: 203 },
        { name: 'feat/PROJ-701-dark', sha: '2b3c4d5e', days: 3.2, author: 'Lina Roux', ahead: 2, behind: 4, origin: 'main', originConfidence: 'inferred' },
        { name: 'feat/PROJ-540-a11y', sha: '4d5e6f70', days: 22, author: 'Sofia Marchetti', ahead: 0, behind: 30, mergedInto: 'main', mergedMr: 190, origin: 'main', originConfidence: 'certain' },
      ],
      tags: [
        { name: 'v1.8.0', sha: '4d5e6f70', days: 22, author: 'Sofia Marchetti', annotated: true, protected: true, tagger: 'Sofia Marchetti', message: 'Release 1.8 — accessibilité', branches: [['main', false]] },
      ],
    },
    'groupe/batch-jobs': {
      default: 'main',
      branches: [
        { name: 'main', sha: '5e6f7081', protected: true, days: 1.5, author: 'Lina Roux', ahead: 0, behind: 0, origin: null },
        { name: 'hotfix/export-timeout', sha: '6f708192', days: 0.6, author: 'Karim Belkacem', ahead: 1, behind: 0, origin: 'main', originConfidence: 'inferred', openMr: 204 },
        { name: 'feat/PROJ-590-import', sha: '708192a3', days: 13, author: 'Sofia Marchetti', ahead: 0, behind: 18, mergedInto: 'main', mergedMr: 175, origin: 'main', originConfidence: 'certain' },
        { name: 'release/1.2', sha: '8192a3b4', protected: true, days: 40, author: 'Lina Roux', ahead: 0, behind: 60, origin: 'main', originConfidence: 'inferred' },
      ],
      tags: [
        { name: 'v1.2.0', sha: '8192a3b4', days: 40, author: 'Lina Roux', annotated: true, protected: true, tagger: 'Release Bot', message: 'Release 1.2', branches: [['release/1.2', true], ['main', false]] },
        { name: 'v1.1.3', sha: 'aa11bb22', days: 70, author: 'Sofia Marchetti', annotated: false, message: '', branches: [['main', false]] },
      ],
    },
  };
}

const branchTipDate = (proj, name) => {
  const b = (proj.branches || []).find((x) => x.name === name);
  return b ? iso(b.days) : null;
};

// --- /api/git/refs (listes des Actions + rechargement explorateur) ---
function refs(project, kind) {
  const p = dataset()[project];
  if (!p) return { kind, refs: [] };
  if (kind === 'tags') {
    return { kind, refs: p.tags.map((t) => ({ name: t.name, sha: t.sha, protected: !!t.protected, annotated: !!t.annotated, date: iso(t.days) })) };
  }
  return {
    kind,
    default: p.default,
    refs: p.branches.map((b) => ({ name: b.name, sha: b.sha, default: b.name === p.default, protected: !!b.protected, merged: !!b.mergedInto, date: iso(b.days), author: b.author })),
  };
}

// --- /api/git/branches (explorateur : graphe des branches + tags) ---
function branches(project, repoId) {
  const p = dataset()[project];
  if (!p) return { project, repo_id: repoId, default: 'main', branches: [], tags: [] };
  const rows = p.branches.map((b) => ({
    name: b.name,
    default: b.name === p.default,
    protected: !!b.protected,
    committed_date: iso(b.days),
    author: b.author,
    ahead: b.ahead,
    behind: b.behind,
    merged_into: b.mergedInto || null,
    merged_mr: b.mergedMr ? { iid: b.mergedMr, url: mrUrl(project, b.mergedMr) } : null,
    contained_in: [],
    origin: b.origin || null,
    origin_confidence: b.origin ? (b.originConfidence || 'inferred') : 'unknown',
    origin_alternatives: null,
    open_mr: b.openMr ? { iid: b.openMr, url: mrUrl(project, b.openMr), target: p.default } : null,
  }));
  const tags = p.tags
    .slice()
    .sort((a, b) => a.days - b.days) // plus récent d'abord
    .map((t) => ({ name: t.name, committed_date: iso(t.days), author: t.author, annotated: !!t.annotated, message: t.message || '', sha: t.sha, branches: t.branches.map(([n]) => n) }));
  return { project, repo_id: repoId, default: p.default, branches: rows, tags };
}

// --- /api/git/tag-author (le « vrai » tagger, à la demande) ---
function tagAuthor(project, tag) {
  const p = dataset()[project];
  const t = p && p.tags.find((x) => x.name === tag);
  if (!t) return { found: false, annotated: false, author: '', date: null };
  return { found: true, annotated: !!t.annotated, author: t.annotated ? (t.tagger || t.author) : t.author, date: iso(t.days) };
}

// --- /api/git/find-ref (recherche d'une ref à travers tous les dépôts) ---
function findRef(name, type, repos) {
  const D = dataset();
  const kinds = type === 'both' ? ['branch', 'tag'] : [type];
  const out = repos.map((r) => {
    const p = D[r.project];
    const matches = [];
    if (p) {
      for (const kind of kinds) {
        if (kind === 'branch') {
          const b = p.branches.find((x) => x.name === name);
          if (b) matches.push({ kind: 'branch', sha: b.sha, date: iso(b.days), author: b.author, url: refUrl(r.project, 'branch', name) });
        } else {
          const t = p.tags.find((x) => x.name === name);
          if (t) matches.push({
            kind: 'tag', sha: t.sha, date: iso(t.days), author: t.author, url: refUrl(r.project, 'tag', name),
            branches: t.branches.map(([n, isTip]) => ({ name: n, tipDate: branchTipDate(p, n), isTip: !!isTip })),
          });
        }
      }
    }
    return { project: r.project, repo_id: r.id, matches, error: null };
  });
  return { name, type, repos: out };
}

// --- Aperçu d'action (gitops.preview) : fournit les listes dans les formes que renvoie
// gitlab.js, pour réutiliser TELLE QUELLE la logique d'états/commandes de gitops. ---
function listsFor(project) {
  const p = dataset()[project];
  if (!p) return [[], [], [], []];
  const branchesFull = p.branches.map((b) => ({ name: b.name, sha: b.sha, default: b.name === p.default, protected: !!b.protected, merged: !!b.mergedInto, committed_date: iso(b.days), author: b.author }));
  const tags = p.tags.map((t) => ({ name: t.name, sha: t.sha, target: `tagobj-${t.name}`, annotated: !!t.annotated, committed_date: iso(t.days) }));
  const protBranches = p.branches.filter((b) => b.protected).map((b) => b.name);
  const protTags = p.tags.filter((t) => t.protected).map((t) => t.name);
  return [branchesFull, tags, protBranches, protTags];
}

const isDemo = () => process.env.MERGERIE_DEMO === '1';

/* --- /api/git/compare (comparaison de contenu entre deux dépôts) ---
   Les arborescences fictives vivent dans `demo-diff.js` : un seul jeu de vérité par projet,
   comme partout ailleurs en démo. On y ajoute une différence de CONTENU sur les fichiers
   homonymes les plus évidents — sinon la troisième colonne (« des deux côtés, mais
   différents ») resterait vide et la démo ne montrerait pas ce qu'elle sert à montrer. */
const DIFFERENTS_EN_DEMO = new Set(['README.md', 'package.json', 'src/main.js']);

/* Les deux côtés arrivent sous la forme { ref, kind } : en démo la résolution ne coûte rien,
   mais l'écran affiche le genre, et une démo qui rendrait « branche » pour un tag mentirait. */
function compare(projetA, coteA, projetB, coteB) {
  // eslint-disable-next-line global-require
  const { arbreDeProjet } = require('./demo-diff');
  const a = arbreDeProjet(projetA);
  const b = arbreDeProjet(projetB);
  const setB = new Set(b);
  const setA = new Set(a);
  const communs = a.filter((f) => setB.has(f));
  return {
    a: { project: projetA, ref: coteA.ref, kind: coteA.kind, files: a.length },
    b: { project: projetB, ref: coteB.ref, kind: coteB.kind, files: b.length },
    only_a: a.filter((f) => !setB.has(f)),
    only_b: b.filter((f) => !setA.has(f)),
    differ: communs.filter((f) => DIFFERENTS_EN_DEMO.has(f)),
    same: communs.filter((f) => !DIFFERENTS_EN_DEMO.has(f)).length,
    tronque: false,
  };
}

/* Un diff unifié entre deux textes. On rogne les lignes identiques en tête et en queue, et
   le reste part en un seul bloc : ce n'est pas le diff MINIMAL qu'un algorithme LCS rendrait,
   mais c'en est un vrai, calculé sur le contenu réellement servi par la démo — pas un texte
   inventé qui finirait par contredire ce que l'écran affiche à côté. */
function diffUnifie(texteA, texteB) {
  if (texteA === texteB) return '';
  const a = texteA ? texteA.replace(/\n$/, '').split('\n') : [];
  const b = texteB ? texteB.replace(/\n$/, '').split('\n') : [];
  let tete = 0;
  while (tete < a.length && tete < b.length && a[tete] === b[tete]) tete += 1;
  let queue = 0;
  while (queue < a.length - tete && queue < b.length - tete
    && a[a.length - 1 - queue] === b[b.length - 1 - queue]) queue += 1;

  const contexte = Math.min(3, tete);
  const debut = tete - contexte;
  const finA = a.length - queue; const finB = b.length - queue;
  const apresA = a.slice(finA, finA + Math.min(3, queue));
  const lgA = finA - debut + apresA.length;
  const lgB = finB - debut + apresA.length;
  // Un côté vide se numérote à partir de 0, comme le fait git : « @@ -1,10 +0,0 @@ ».
  const lignes = [
    `@@ -${lgA ? debut + 1 : 0},${lgA} +${lgB ? debut + 1 : 0},${lgB} @@`,
    ...a.slice(debut, tete).map((l) => ` ${l}`),
    ...a.slice(tete, finA).map((l) => `-${l}`),
    ...b.slice(tete, finB).map((l) => `+${l}`),
    ...apresA.map((l) => ` ${l}`),
  ];
  return `${lignes.join('\n')}\n`;
}

// --- /api/git/compare/file : les deux versions d'un même chemin, en diff.
function compareFile(projetA, coteA, projetB, coteB, chemin) {
  // eslint-disable-next-line global-require
  const { arbreDeProjet, corpsDeProjet } = require('./demo-diff');
  const presentA = arbreDeProjet(projetA).includes(chemin);
  const presentB = arbreDeProjet(projetB).includes(chemin);
  if (!presentA && !presentB) throw new Error(`fichier absent des deux côtés : ${chemin}`);
  /* Un fichier homonyme n'est « différent » que s'il est dans la liste : ailleurs, les deux
     côtés doivent rendre EXACTEMENT le même corps, sinon l'écran dirait « identiques » d'un
     côté et montrerait un diff de l'autre. */
  const memeContenu = presentA && presentB && !DIFFERENTS_EN_DEMO.has(chemin);
  const corpsA = presentA ? corpsDeProjet(chemin, projetA, coteA.ref) : '';
  const corpsB = presentB ? corpsDeProjet(chemin, memeContenu ? projetA : projetB, memeContenu ? coteA.ref : coteB.ref) : '';
  const diff = diffUnifie(corpsA, corpsB);
  return {
    path: chemin,
    a: { project: projetA, ref: coteA.ref, kind: coteA.kind, exists: presentA, size: corpsA.length },
    b: { project: projetB, ref: coteB.ref, kind: coteB.kind, exists: presentB, size: corpsB.length },
    diff,
    binaire: false,
    identique: !diff,
    trop_gros: false,
  };
}

module.exports = { isDemo, refs, branches, tagAuthor, findRef, listsFor, compare, compareFile };
