'use strict';
/* Vérification objective — logique PURE (plan_add_verify.md §4, §6, §7).
 *
 * Tout ce qui décide du verdict vit ici, sans git, sans réseau, sans base : c'est la partie
 * qu'on veut pouvoir prouver. L'orchestration (worktrees, checkouts, spawn) est ailleurs.
 *
 * Deux principes qui expliquent la plupart des choix ci-dessous :
 *
 *   — La réponse du script est une donnée NON FIABLE. Elle vient d'un exécutable de
 *     l'utilisateur, elle sera affichée et stockée : on la valide strictement et on la
 *     tronque, plutôt que de lui faire confiance et de réparer plus tard.
 *   — Un faux vert est le pire résultat possible. Dans le doute — schéma invalide, timeout,
 *     sortie illisible — on ne conclut pas : `verify_error`, visible.
 */

const VERDICTS = ['verified_pass', 'verified_fail', 'broken_base', 'verify_error'];

// Bornes du contrat (§4). Elles protègent l'affichage et la base, pas le script.
const MAX_REPONSE = 256 * 1024;   // réponse entière
const MAX_FAILED = 50;            // entrées d'échec retenues
const MAX_EXTRAIT = 4 * 1024;     // extrait de log par échec
const MAX_LOG = 64 * 1024;        // stderr conservé

/* ---------------------------------------------------------------- contrat script */

/* La réponse est la DERNIÈRE ligne JSON valide de stdout : un script de test écrit
   volontiers des choses avant sa conclusion, et lui demander un stdout vierge serait une
   contrainte de plus sur du code qu'on ne maîtrise pas. */
function derniereLigneJson(stdout) {
  const lignes = String(stdout || '').split('\n');
  for (let i = lignes.length - 1; i >= 0; i--) {
    const l = lignes[i].trim();
    if (!l.startsWith('{')) continue;
    try { return JSON.parse(l); } catch { /* ligne suivante */ }
  }
  return null;
}

function tronquer(s, max) {
  const t = String(s == null ? '' : s);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/* Valide et NORMALISE la réponse d'un run. Renvoie { ok: true, run } ou
   { ok: false, erreur } — `erreur` est destinée à l'utilisateur : elle doit dire ce qui
   cloche, pas « invalide ». */
function validerReponse(stdout) {
  const brut = String(stdout || '');
  if (brut.length > MAX_REPONSE) {
    return { ok: false, erreur: `réponse trop volumineuse (${brut.length} octets, maximum ${MAX_REPONSE})` };
  }
  const d = derniereLigneJson(brut);
  if (!d) return { ok: false, erreur: 'aucune ligne JSON valide en fin de sortie standard' };
  if (d.version !== 1) return { ok: false, erreur: `version attendue 1, reçue ${JSON.stringify(d.version)}` };
  if (!['pass', 'fail', 'error'].includes(d.status)) {
    return { ok: false, erreur: `status attendu pass|fail|error, reçu ${JSON.stringify(d.status)}` };
  }
  if (d.failed != null && !Array.isArray(d.failed)) {
    return { ok: false, erreur: 'failed doit être une liste' };
  }
  const failed = (d.failed || [])
    // Un échec sans nom de test ne peut pas être imputé : le garder brouillerait le delta.
    .filter((f) => f && typeof f === 'object' && f.test)
    .slice(0, MAX_FAILED)
    .map((f) => ({
      test: tronquer(f.test, 500),
      message: tronquer(f.message, 2000),
      log_excerpt: tronquer(f.log_excerpt, MAX_EXTRAIT),
    }));
  const nb = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
  return {
    ok: true,
    run: {
      version: 1,
      status: d.status,
      total: nb(d.total),
      failed,
      // `fail` sans détail est ACCEPTÉ : mieux vaut un rouge sans liste qu'un refus de conclure.
      failed_tronque: (d.failed || []).length > MAX_FAILED,
      duration_ms: nb(d.duration_ms),
    },
  };
}

/* ---------------------------------------------------------------- vérificateur « commandes »

   Deuxième famille de vérificateurs : au lieu d'un script qui s'engage sur un contrat, une
   simple LISTE DE COMMANDES (`npm ci`, `npm test`). Le verdict vient alors des CODES DE
   SORTIE — rien d'autre ne le touche. Ce qui suit ne sert qu'à retrouver, quand c'est
   possible sans deviner, le NOM des tests cassés : c'est lui qui rend le delta base/tête
   causal. Quand on ne le trouve pas, on le dit au lieu de l'inventer. */

// Métacaractères de shell. Il n'y a pas de shell ici : les laisser passer donnerait un
// `npm test && lint` qui échoue de façon incompréhensible (« && » deviendrait un argument).
const META_SHELL = /[;|&<>`$\n\r]|\$\(/;

/* Découpe une commande en programme + arguments, guillemets respectés. Même esprit que la
   palette de commandes git : on tokenise nous-mêmes plutôt que de confier la ligne à un shell. */
function decouperCommande(ligne) {
  const s = String(ligne || '').trim();
  if (!s) return { ok: false, erreur: 'commande vide' };
  if (META_SHELL.test(s)) {
    return { ok: false, erreur: 'les tubes, redirections, enchaînements et variables ne sont pas interprétés (aucun shell) — mets-les dans un script' };
  }
  const toks = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; else cur += c; has = true; }
    else if (c === '"' || c === "'") { quote = c; has = true; }
    else if (/\s/.test(c)) { if (has) { toks.push(cur); cur = ''; has = false; } }
    else { cur += c; has = true; }
  }
  if (quote) return { ok: false, erreur: 'guillemet non fermé' };
  if (has) toks.push(cur);
  if (!toks.length) return { ok: false, erreur: 'commande vide' };
  return { ok: true, programme: toks[0], args: toks.slice(1) };
}

/* ---------- TAP ----------
   Format ligne à ligne, émis par beaucoup de runners dès que leur sortie n'est pas un
   terminal — ce qui est toujours le cas ici. Rien à déclarer : on le reconnaît au passage. */

const RE_TAP_VERSION = /^\s*TAP version \d+\s*$/;
const RE_TAP_PLAN = /^(\s*)1\.\.(\d+)\s*(#.*)?$/;
const RE_TAP_TEST = /^(\s*)(not )?ok\b\s*(\d+)?\s*-?\s*(.*)$/;
const RE_TAP_SUBTEST = /^(\s*)#\s*Subtest:\s*(.*)$/;
const RE_TAP_BAILOUT = /^\s*Bail out!\s*(.*)$/;

// Les directives changent le SENS de la ligne : un `not ok … # TODO` est un échec ATTENDU,
// le compter accuserait une branche pour un test que son auteur a lui-même désarmé.
function directive(desc) {
  /* En TAP, « # » ouvre un commentaire : tout ce qui suit sort du nom du test. Ça vaut pour
     les directives (`# SKIP`, `# TODO`) comme pour les annotations libres — vitest écrit
     `# time=12.34ms`, et le garder ferait un nom de test différent à chaque run, donc un
     delta base/tête qui n'apparie plus rien. Le `{` final de vitest part avec. */
  const i = desc.search(/\s#/);
  const commentaire = i >= 0 ? desc.slice(i) : '';
  const nom = (i >= 0 ? desc.slice(0, i) : desc).trim().replace(/\s*\{\s*$/, '');
  const dir = /#\s*(TODO|SKIP)\b/i.exec(commentaire);
  return {
    desc: nom,
    todo: !!dir && dir[1].toUpperCase() === 'TODO',
    skip: !!dir && dir[1].toUpperCase() === 'SKIP',
  };
}

/* Reconnaît un flux TAP sans le confondre avec un log ordinaire : il faut une ligne de
   version, un plan, ou au moins trois lignes de test numérotées. Les motifs sont ancrés en
   début de ligne et exigent la forme complète — un log qui contient le mot « ok » ne suffit pas. */
function estTap(lignes) {
  if (lignes.some((l) => RE_TAP_VERSION.test(l))) return true;
  if (lignes.some((l) => RE_TAP_PLAN.test(l))) return true;
  return lignes.filter((l) => { const m = RE_TAP_TEST.exec(l); return m && m[3]; }).length >= 3;
}

/* Analyse un flux TAP et rend les FEUILLES en échec, avec leur nom complet.
 *
 * Deux pièges, et ils se paient tous les deux par un verdict faux :
 *   — les sous-tests. Un échec apparaît à son niveau ET dans la ligne de sa suite ; compter
 *     les deux double chaque échec. On ne retient donc qu'une ligne dont aucune ligne plus
 *     indentée ne vient d'être fermée.
 *   — la troncature. On ne garde que la fin de la sortie : le plan de tête (`1..43`) permet
 *     de savoir qu'on n'a qu'une vue partielle, et de le DIRE plutôt que de la présenter
 *     comme exhaustive.
 */
function parserTap(sortie) {
  const lignes = String(sortie || '').split('\n');
  if (!estTap(lignes)) return null;

  const feuilles = [];
  let total = 0;                   // feuilles lues, quel que soit leur résultat
  const pile = [];                 // indentations des résultats déjà lus, non encore refermés
  const nomsParIndent = new Map(); // dernier « # Subtest: » vu à chaque indentation
  let plan = null;                 // plan de PREMIER niveau (indentation 0)
  let racines = 0;                 // résultats de premier niveau réellement lus
  let bailOut = null;

  for (let i = 0; i < lignes.length; i += 1) {
    const l = lignes[i];

    const bail = RE_TAP_BAILOUT.exec(l);
    if (bail) { bailOut = bail[1].trim() || 'sans raison indiquée'; continue; }

    const sub = RE_TAP_SUBTEST.exec(l);
    if (sub) {
      const ind = sub[1].length;
      nomsParIndent.set(ind, sub[2].trim());
      for (const k of [...nomsParIndent.keys()]) if (k > ind) nomsParIndent.delete(k);
      continue;
    }

    const pl = RE_TAP_PLAN.exec(l);
    if (pl) { if (pl[1].length === 0) plan = Number(pl[2]); continue; }

    const m = RE_TAP_TEST.exec(l);
    if (!m) continue;
    const ind = m[1].length;
    const echec = !!m[2];

    // Cette ligne referme-t-elle des résultats plus indentés ? Alors elle les RÉSUME.
    const estParent = pile.some((d) => d > ind);
    while (pile.length && pile[pile.length - 1] > ind) pile.pop();
    pile.push(ind);
    if (ind === 0) racines += 1;
    if (estParent) continue;

    /* Vitest annonce ses blocs par une accolade OUVRANTE sur la ligne de résultat elle-même,
       là où node fait suivre le bloc d'une ligne de résultat. Une ligne qui ouvre un bloc est
       donc, elle aussi, un parent — et le nom sous lequel ses enfants seront rangés. */
    const { desc, todo, skip } = directive(m[4] || '');
    if (/\{\s*$/.test((m[4] || '').trim())) {
      nomsParIndent.set(ind, desc);
      for (const k of [...nomsParIndent.keys()]) if (k > ind) nomsParIndent.delete(k);
      continue;
    }
    if (!skip) total += 1;
    if (!echec || todo || skip) continue;

    const ancetres = [...nomsParIndent.keys()].filter((k) => k < ind).sort((a, b) => a - b)
      .map((k) => nomsParIndent.get(k));
    const bloc = corpsEchec(lignes, i + 1, ind);
    feuilles.push({
      test: [...ancetres, desc].filter(Boolean).join(' › ') || desc || `test ${m[3] || ''}`.trim(),
      message: bloc.message,
      log_excerpt: bloc.texte,
    });
  }

  return {
    tests: feuilles,
    total,
    plan,
    racines,
    bailOut,
    // Vérifiable seulement si un plan de premier niveau existe. `null` = on ne sait pas.
    complet: plan == null ? null : plan === racines,
  };
}

/* Le détail d'un échec, tel que le runner l'a écrit sous la ligne `not ok`.
 *
 * TAP 13 prévoit un bloc YAML entre `---` et `...` (node, vitest, tap). Mocha, lui, se
 * contente de lignes indentées. On accepte les deux : le format n'est pas négociable pour le
 * verdict, mais le priver du message d'erreur reviendrait à afficher « un test a cassé » et à
 * laisser l'utilisateur rouvrir son terminal. */
function corpsEchec(lignes, depart, indParent) {
  const yaml = blocYaml(lignes, depart, indParent);
  if (yaml.texte) return yaml;
  const corps = [];
  for (let i = depart; i < lignes.length && corps.length < 20; i += 1) {
    const l = lignes[i];
    if (!l.trim()) { if (corps.length) break; continue; }
    // On s'arrête à la première ligne qui appartient de nouveau au protocole.
    if (RE_TAP_TEST.test(l) || RE_TAP_PLAN.test(l) || RE_TAP_SUBTEST.test(l) || RE_TAP_BAILOUT.test(l)) break;
    if ((l.match(/^\s*/) || [''])[0].length <= indParent) break;
    corps.push(l.trim());
  }
  const texte = corps.join('\n');
  return { texte: tronquer(texte, MAX_EXTRAIT), message: tronquer(corps[0] || '', 2000) };
}

/* Le bloc de diagnostic YAML d'une ligne `not ok` : entre `---` et `...`, plus indenté.
   Pas de vrai analyseur YAML — on veut le texte, et le message s'il est nommé. */
function blocYaml(lignes, depart, indParent) {
  let i = depart;
  while (i < lignes.length && !lignes[i].trim()) i += 1;
  if (i >= lignes.length || !/^\s*---\s*$/.test(lignes[i])) return { texte: '', message: '' };
  if ((lignes[i].match(/^\s*/) || [''])[0].length <= indParent) return { texte: '', message: '' };
  const corps = [];
  for (i += 1; i < lignes.length && !/^\s*\.\.\.\s*$/.test(lignes[i]); i += 1) corps.push(lignes[i]);
  const texte = corps.join('\n').replace(/^\s+$/gm, '').trim();
  const mm = /^\s*(?:error|message|failure):\s*(?:\|-?)?\s*(.*)$/mi.exec(texte);
  let message = mm ? mm[1].trim() : '';
  // `error: |-` annonce un bloc littéral : la valeur est sur les lignes suivantes.
  if (!message && mm) {
    const apres = texte.slice(mm.index + mm[0].length).split('\n').map((x) => x.trim()).filter(Boolean);
    message = apres[0] || '';
  }
  return { texte: tronquer(texte, MAX_EXTRAIT), message: tronquer(message, 2000) };
}

/* ---------- JUnit XML ----------
   Le format pivot inter-langages : pytest, jest, phpunit, maven, cargo… savent tous
   l'écrire. Contrairement au TAP il demande un réglage (le chemin du fichier), mais il ne
   subit pas la troncature de la sortie et porte le détail complet.

   Analyseur volontairement ÉTROIT : on cherche des `<testcase>` et leurs `<failure>` /
   `<error>`, rien d'autre. Un XML qui ne ressemble pas à ça rend `null` — on ne devine pas. */
function decoderXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

const premiereLigne = (s) => (String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '');

function parserJUnit(xml) {
  const s = String(xml || '');
  if (!/<testsuites?\b/i.test(s) && !/<testcase\b/i.test(s)) return null;
  const tests = [];
  let total = 0;
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/gi;
  let m = re.exec(s);
  while (m) {
    total += 1;
    const attrs = m[1] || '';
    const corps = m[3] || '';
    // XML autorise les deux styles de guillemets, et les fichiers réels utilisent les deux.
    const attr = (n) => {
      const a = new RegExp(`\\b${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
      return a ? decoderXml(a[1] != null ? a[1] : a[2]) : '';
    };
    const ko = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/i.exec(corps);
    const texteKo = ko ? decoderXml(ko[4] || '').trim() : '';
    // `<skipped/>` : test non exécuté, ni succès ni échec.
    if (ko && !/<skipped\b/i.test(corps)) {
      const msg = /\bmessage\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(ko[2] || '');
      const classe = attr('classname');
      const nom = attr('name');
      tests.push({
        test: [classe, nom].filter(Boolean).join(' › ') || nom || classe || 'test sans nom',
        /* PHPUnit et jest-junit n'émettent PAS d'attribut `message` : tout est dans le
           texte de l'élément. Sa première ligne non vide en fait un message utilisable. */
        message: tronquer(msg ? decoderXml(msg[1] != null ? msg[1] : msg[2]) : premiereLigne(texteKo), 2000),
        log_excerpt: tronquer(texteKo, MAX_EXTRAIT),
      });
    }
    m = re.exec(s);
  }
  if (!total) return null;
  return { tests, total };
}

/* ---------- Ce qui est NOUVEAU par rapport à la base ----------
   Même sans nom de test, on a deux sorties comparables : celles de la base et celles de la
   tête. Les lignes présentes dans l'une et pas dans l'autre pointent, en pratique, l'échec
   introduit. Déterministe, gratuit, et ça marche avec n'importe quel `make test`. */
function nouvellesLignes(sortieBase, sortieHead, max = 40) {
  const norm = (s) => String(s || '').split('\n').map((l) => l.replace(/\s+$/, ''));
  const vues = new Set(norm(sortieBase).map((l) => l.trim()).filter(Boolean));
  const out = [];
  for (const l of norm(sortieHead)) {
    const t = l.trim();
    if (!t || vues.has(t)) continue;
    out.push(l);
    if (out.length >= max) break;
  }
  return out;
}

/* Compose la réponse d'un run « commandes » à partir de ce qui s'est réellement passé.
 * `resultats` : [{ command, code, duration_ms, output }], dans l'ordre, arrêté au 1er échec.
 *
 * LE CODE DE SORTIE DÉCIDE. `detail` (TAP ou JUnit) ne fournit que des noms. Si les deux se
 * contredisent — sortie 0 avec des tests rouges, ou l'inverse — on suit le code de sortie et
 * on le SIGNALE : c'est presque toujours un vrai problème dans la commande de test, et le
 * masquer rendrait un mauvais service.
 */
function composerRunCommandes(resultats, detail) {
  const echecs = resultats.filter((r) => r.code !== 0);
  const status = echecs.length ? 'fail' : 'pass';
  const nommes = (detail && detail.tests) || [];
  /* Le format reconnu et le code de sortie se contredisent : tout vert mais sortie non nulle,
     ou l'inverse. On ne tranche pas en silence — le code de sortie fait foi et le rapport
     signale la contradiction, qui trahit presque toujours un vrai défaut de la commande. */
  const incoherence = detail ? (status === 'pass') !== (nommes.length === 0) : false;

  /* Plusieurs dépôts : la commande seule ne suffit plus à identifier l'échec — `npm test`
     casse dans le front OU dans l'api, et le delta base/tête doit pouvoir les distinguer. */
  const multi = new Set(resultats.map((r) => r.repo).filter(Boolean)).size > 1;
  const cle = (r) => (multi && r.repo ? `${r.repo} › ${r.command}` : r.command);

  let failed;
  let source;
  if (status === 'fail' && nommes.length) {
    failed = nommes.slice(0, MAX_FAILED);
    source = detail.source;
  } else if (status === 'fail') {
    /* Aucun nom de test : la COMMANDE devient la clé du delta. C'est la bonne dégradation —
       base rouge et tête rouge sur la même commande donnent un delta vide, donc « base
       rouge », et non une accusation de la branche. */
    failed = echecs.slice(0, MAX_FAILED).map((r) => ({
      test: cle(r),
      message: `code de sortie ${r.code}`,
      log_excerpt: tronquer(queue(r.output, 60), MAX_EXTRAIT),
    }));
    source = 'command';
  } else {
    failed = [];
    source = detail ? detail.source : null;
  }

  return {
    version: 1,
    status,
    total: detail && detail.total != null ? detail.total : null,
    failed,
    failed_tronque: nommes.length > MAX_FAILED || echecs.length > MAX_FAILED,
    duration_ms: resultats.reduce((a, r) => a + (r.duration_ms || 0), 0),
    commands: resultats.map((r) => ({
      command: r.command,
      repo: r.repo || null,
      code: r.code,
      duration_ms: r.duration_ms || 0,
      output_tail: tronquer(queue(r.output, 40), MAX_EXTRAIT),
    })),
    detail_source: source,
    detail_partiel: !!(detail && detail.complet === false),
    incoherence: !!incoherence,
  };
}

/* Assemble les détails trouvés dépôt par dépôt. `source` devient « mixte » quand ils ne
   viennent pas tous du même endroit : le rapport doit pouvoir le dire plutôt que de laisser
   croire que tout a été lu de la même façon. */
function fusionnerDetails(details) {
  const utiles = (details || []).filter(Boolean);
  if (!utiles.length) return null;
  const sources = new Set(utiles.map((d) => d.source));
  return {
    tests: utiles.flatMap((d) => d.tests || []),
    total: utiles.reduce((a, d) => a + (d.total || 0), 0),
    source: sources.size === 1 ? [...sources][0] : 'mixte',
    complet: utiles.every((d) => d.complet !== false),
  };
}

// Les N dernières lignes non vides : les runners mettent leur bilan à la fin.
function queue(sortie, n) {
  const l = String(sortie || '').split('\n');
  while (l.length && !l[l.length - 1].trim()) l.pop();
  return l.slice(-n).join('\n');
}

/* ---------------------------------------------------------------- verdicts (§7) */

// Ce qui a cassé ENTRE la base et la branche. Clé : le nom du test.
function deltaImputable(base, head) {
  const dejaRouges = new Set(((base && base.failed) || []).map((f) => f.test));
  return ((head && head.failed) || []).filter((f) => !dejaRouges.has(f.test));
}

/* Compose le verdict des deux runs. `base` vaut null quand le run base est désactivé : le
   résultat est alors NON CAUSAL — on sait que la branche est rouge, pas qu'elle l'a rendue
   rouge. L'appelant l'affiche différemment, d'où `causal`. */
function composerVerdict(base, head) {
  if (!head || head.status === 'error') {
    return { verdict: 'verify_error', imputable: [], causal: false };
  }
  if (!base) {
    return {
      verdict: head.status === 'pass' ? 'verified_pass' : 'verified_fail',
      imputable: head.status === 'pass' ? [] : (head.failed || []),
      causal: false,
    };
  }
  if (base.status === 'error') return { verdict: 'verify_error', imputable: [], causal: false };

  if (base.status === 'pass') {
    return head.status === 'pass'
      ? { verdict: 'verified_pass', imputable: [], causal: true }
      : { verdict: 'verified_fail', imputable: head.failed || [], causal: true };
  }
  // base rouge : la branche n'est pas comptable de ce qui était déjà cassé.
  if (head.status === 'pass') return { verdict: 'broken_base', imputable: [], causal: true };
  const delta = deltaImputable(base, head);
  return delta.length
    ? { verdict: 'verified_fail', imputable: delta, causal: true }
    : { verdict: 'broken_base', imputable: [], causal: true };
}

/* Un verdict porte sur des SHAs. Si la branche a avancé depuis, il n'est pas faux — il est
   PÉRIMÉ, ce qui n'est pas la même chose et se dit autrement à l'écran. */
function estPerime(targets, shaCourantParMr) {
  return (targets || []).some((t) => {
    const courant = shaCourantParMr && shaCourantParMr[t.mr_id];
    return !!courant && !!t.head_sha && courant !== t.head_sha;
  });
}

/* ---------------------------------------------------------------- remotes */

/* Deux URLs de remote désignent-elles le même dépôt ? On compare hôte + chemin, en ignorant
   le protocole, l'utilisateur, le port, le `.git` final et la casse de l'hôte : `git@h:g/p.git`
   et `https://h/g/p` sont le même dépôt, et refuser le checkout pour cette raison serait
   incompréhensible pour l'utilisateur. */
function normaliserRemote(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  u = u.replace(/\.git$/i, '');
  const scp = /^[^/]+@([^:/]+):(.+)$/.exec(u);           // git@hote:groupe/projet
  if (scp) return `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+/, '')}`;
  try {
    const p = new URL(u);
    return `${p.hostname.toLowerCase()}${p.pathname.replace(/\/+$/, '')}`.replace(/\/{2,}/g, '/');
  } catch {
    return u.replace(/^\/+/, '');
  }
}

const memeDepot = (a, b) => {
  const na = normaliserRemote(a);
  return !!na && na === normaliserRemote(b);
};

/* ---------------------------------------------------------------- commentaire de forge

   LE CORPS PUBLIÉ SUR LA MERGE REQUEST. Isolé ici — pas de base, pas de réseau — parce que
   c'est du TEXTE que des gens vont lire sur leur MR : il doit se prouver sans monter un serveur.

   Un GABARIT, et non une chaîne en dur : le ton d'une équipe n'est pas celui d'une autre, et
   quelqu'un voudra y mettre le lien de son tableau de bord ou retirer la liste des commits.
   Les champs absents laissent une ligne vide plutôt qu'un `{trou}` : un gabarit qui affiche ses
   propres marqueurs sur une vraie merge request est pire que pas de gabarit. */
const GABARIT_COMMENTAIRE_DEFAUT = [
  '{verdict}',
  '',
  '{tests}',
  '',
  '{commandes}',
  '',
  '{commits}',
  '',
  '{mentions}',
  '',
  '_Vérifié le {date} à {heure}._',
].join('\n');

const CHAMPS_COMMENTAIRE = ['verdict', 'tests', 'commandes', 'commits', 'mentions', 'verificateur', 'date', 'heure'];

/* DES BLOCS D'EXEMPLE, pour montrer à quoi ressemble un gabarit une fois rempli. Ils passent
   par la MÊME fonction que le vrai commentaire : un aperçu composé autrement finirait par
   mentir sur ce qui part. Un cas rouge, parce que c'est celui où le contenu compte. */
const EXEMPLE_COMMENTAIRE = {
  verificateur: 'integ',
  verdict: '**integ** : ✗ 2 test(s) cassé(s) par cette branche',
  tests: ['Tests cassés :',
    '- `panier › total` — attendu 42, reçu 41',
    '- `paiement › devise absente`'].join('\n'),
  commandes: ['Commandes en échec :',
    '- grp/api › `npm test` — code de sortie 1'].join('\n'),
  mentions: '@amady @bruno',
  commits: ['Commits testés :',
    '- grp/api · `feat/PROJ-720-checkout` @ `a1b2c3d4`',
    '- grp/front · `feat/PROJ-720-tunnel` @ `9f8e7d6c`'].join('\n'),
};

/* PUBLIER TOUT SEUL, OU SE TAIRE. La case « Publier le verdict en commentaire » n'écrit sur la
   merge request que si LA BASE EST VERTE — et elle publie alors le verdict, vert comme rouge :

     · base verte, tête rouge → « ce qui marchait avant ne marche plus, et c'est cette branche » ;
     · base verte, tête verte → « vérifié, et ça tient » : sur une merge request qu'on va relire,
       un vert ÉCRIT vaut mieux qu'un badge qu'il faut aller chercher dans un autre outil.

   Ce qui reste tu, et pourquoi :
     · la base est déjà rouge → ce n'est pas imputable à la branche, et le dire sur SA merge
       request revient à l'accuser de ce que quelqu'un d'autre a cassé ;
     · pas de run base (double run désactivé, ou vérification de branche) → on ne SAIT PAS si
       c'était déjà rouge. Publier reviendrait à affirmer ce qu'on n'a pas vérifié.
     · run en erreur (commande introuvable, délai dépassé) → il n'y a pas de verdict à publier.

   C'est donc la BASE qui décide de publier, et la tête de ce qu'on écrit. La publication À LA
   MAIN, depuis le rapport, reste possible dans tous les cas : là, c'est un humain qui décide, et
   il a le texte sous les yeux. */
function doitCommenterAuto(base, head) {
  if (!base || base.status !== 'pass') return false;
  return !!head && (head.status === 'pass' || head.status === 'fail');
}

/* Rend le corps du commentaire. `donnees` porte déjà les blocs composés (verdict, tests,
   commits) : cette fonction ne fait que les poser dans le gabarit, et c'est voulu — le QUOI se
   décide ailleurs, le COMMENT s'écrit ici.

   L'horodatage est celui de l'INSTANT où le corps est composé, passé en paramètre plutôt que lu
   de l'horloge : une fonction qui lit l'heure toute seule ne se teste pas. */
function composerCommentaire(donnees, gabarit, maintenant = new Date()) {
  const modele = String(gabarit || '').trim() || GABARIT_COMMENTAIRE_DEFAUT;
  const valeurs = {
    verdict: donnees.verdict || '',
    tests: donnees.tests || '',
    commandes: donnees.commandes || '',
    mentions: donnees.mentions || '',
    commits: donnees.commits || '',
    verificateur: donnees.verificateur || '',
    date: maintenant.toLocaleDateString('fr-FR'),
    heure: maintenant.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
  };
  const rendu = modele.replace(/\{(\w+)\}/g, (brut, cle) => (
    CHAMPS_COMMENTAIRE.includes(cle) ? valeurs[cle] : brut
  ));
  /* Un bloc vide (aucun test cassé sur un verdict vert) laisserait trois sauts de ligne au
     milieu du commentaire : on les ramène à un paragraphe, et on retire les blancs de bout. */
  return rendu.replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
  GABARIT_COMMENTAIRE_DEFAUT, CHAMPS_COMMENTAIRE, EXEMPLE_COMMENTAIRE, composerCommentaire, doitCommenterAuto,
  VERDICTS, MAX_FAILED, MAX_LOG, MAX_REPONSE,
  validerReponse, derniereLigneJson, deltaImputable, composerVerdict, estPerime,
  normaliserRemote, memeDepot, tronquer, queue,
  decouperCommande, estTap, parserTap, parserJUnit, nouvellesLignes, composerRunCommandes,
  fusionnerDetails,
};
