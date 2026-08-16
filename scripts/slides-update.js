'use strict';
/* Met à jour les deux jeux de diapositives (`presentation.pptx` et `presentation-en.pptx`)
 * pour y ajouter les fonctionnalités arrivées après leur rédaction : l'onglet **Notes**,
 * l'onglet **Liens**, la navigation en colonne, et la palette devenue globale.
 *
 *   node scripts/slides-update.js            écrit à côté, en .new.pptx (rien n'est écrasé)
 *   node scripts/slides-update.js --write    remplace les fichiers, après sauvegarde .bak
 *
 * POURQUOI UN SCRIPT ET NON UNE ÉDITION À LA MAIN. Les deux jeux doivent rester le miroir
 * l'un de l'autre : mêmes sections, même ordre, même numérotation. Fait à la main, on ajoute
 * une diapo d'un côté, on oublie de renuméroter de l'autre, et l'écart ne se voit qu'en
 * projection. Ici les deux sont produits de la même structure, et la numérotation des
 * sections est RECALCULÉE plutôt que retapée.
 *
 * UN .pptx EST UN ZIP D'XML. On n'ajoute donc pas une diapo « vierge » : on COPIE une diapo
 * existante de même nature (une intercalaire, une de contenu) et on remplace ses textes. Le
 * gabarit, la mise en page, l'image de fond et la police viennent avec — c'est la seule
 * façon d'obtenir des diapos qui ne se distinguent pas des anciennes.
 *
 * Une diapo intercalaire porte 3 textes (numéro, titre, sous-titre), une diapo de contenu en
 * porte 8 (bandeau, titre, sous-titre, 4 puces, pied de page). Le script REFUSE de travailler
 * si le compte ne tombe pas juste : mieux vaut s'arrêter que produire un jeu abîmé.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const ECRIRE = process.argv.includes('--write');

/* ------------------------------------------------------------------ contenu ----
   Les textes des deux langues côte à côte, section par section. Les tenir ensemble est
   volontaire : c'est ce qui rend visible, en relisant, qu'aucune puce n'existe d'un seul
   côté. Les puces gardent le préfixe « •  » des diapos existantes (deux espaces).

   CETTE PASSE-CI ajoute Jenkins (une section entière, absente du jeu), les vérificateurs
   automatiques et le résultat consultable depuis la merge request, et les consignes
   permanentes. Elle rafraîchit aussi deux diapos devenues fausses : « sept onglets » et la
   question de l'IA, qui n'était proposée qu'en codage sur dépôt. */
const PUCE = '•  ';

const CONTENU = {
  fr: {
    piedDePage: 'Mergerie — présentation des fonctionnalités',
    jenkins: {
      section: { titre: 'Jenkins', sous: 'L’état des jobs et leur historique, sans ouvrir Jenkins — et sans lire un mail d’échec pour savoir ce qui a tourné.' },
      slides: [
        {
          bandeau: 'JENKINS',
          titre: 'Les jobs, et ce qu’ils ont donné',
          sous: 'Une ligne par job, son dernier résultat, sa durée — et le lancement depuis ici.',
          puces: [
            'Vert, rouge, instable ou jamais lancé : le dernier verdict est lisible sans ouvrir le job.',
            'Un job paramétré se lance depuis l’outil : les paramètres sont demandés avec leurs valeurs par défaut.',
            'Rafraîchissement automatique, débrayable — un onglet qui se recharge pendant qu’on lit est un onglet qu’on ferme.',
            'Recherche sur le nom et le dossier : une instance réelle porte des centaines de jobs.',
          ],
        },
        {
          bandeau: 'JENKINS',
          titre: 'Filtrer par dossier, par paramètre, par ce qui ne va pas',
          sous: 'Trois filtres qui se combinent, parce qu’on ne cherche jamais tout à la fois.',
          puces: [
            'Les dossiers sont en tête, cochables, avec leur propre champ de recherche.',
            'Les paramètres qui reviennent d’un job à l’autre deviennent des colonnes, et se filtrent par valeur.',
            '« Seulement ce qui ne va pas » réduit la liste aux jobs en échec ou instables.',
            'La liste reste chronologique : la mêler à un groupement par dossier donnerait deux lectures, aucune juste.',
          ],
        },
        {
          bandeau: 'JENKINS',
          titre: 'L’historique d’un job, run par run',
          sous: 'À gauche les exécutions, à droite le détail de celle qu’on regarde.',
          puces: [
            'Chaque run porte ses paramètres, aux mêmes couleurs que dans la liste — c’est ce qui distingue deux runs identiques.',
            'Le filtre par valeur de paramètre s’applique aussi ici : « montre-moi les runs de preprod ».',
            'Au-delà des dix derniers, l’historique se demande à Jenkins sans quitter la fenêtre.',
            'Le détail donne la cause du lancement, la durée, et le lien vers Jenkins pour aller plus loin.',
          ],
        },
      ],
    },
    verifAuto: {
      bandeau: 'VÉRIFICATION OBJECTIVE',
      titre: 'Automatique, dès qu’une merge request arrive',
      sous: 'Une case à cocher sur le vérificateur : plus besoin d’y penser.',
      puces: [
        'Un vérificateur coché « automatique » part tout seul sur chaque nouvelle merge request de ses dépôts.',
        'Cinq vérifications au plus par découverte : une rafale de merge requests ne doit pas saturer la file.',
        'La file de jobs et les verrous par dépôt restent les mêmes — rien ne double, rien ne se marche dessus.',
        'Utile au retour de congés : le verdict est déjà là, sur des branches qu’on n’a pas vues passer.',
      ],
    },
    verifResultat: {
      bandeau: 'VÉRIFICATION OBJECTIVE',
      titre: 'Le résultat, depuis la merge request',
      sous: 'Un bouton sur la carte : ce qui a tourné, sur quels commits, et ce que ça a donné.',
      puces: [
        '« Voir le résultat des vérificateurs » ouvre chaque vérification qui a porté sur cette merge request.',
        'Le verdict, les commits testés, le déroulé des commandes avec leur code de sortie et leur sortie.',
        'Depuis un échec, « Faire corriger par l’IA » ouvre une session de codage avec le contexte déjà écrit.',
        'Le badge de la carte dit l’état ; ce bouton dit ce qui a été fait — on n’a pas forcément vu le lancement.',
      ],
    },
    consignes: {
      bandeau: 'DEV IA',
      titre: 'Des consignes permanentes',
      sous: 'Ce qu’on redit à chaque session, écrit une fois.',
      puces: [
        'Un champ dans les réglages, ajouté au prompt de toutes les sessions de codage, sur dépôt comme hors dépôt.',
        'Au premier lancement comme à chaque suivi : une consigne oubliée au deuxième message ne sert à rien.',
        'La langue des commentaires, une commande à lancer avant de commiter, une convention de nommage.',
        'Le prompt reste visible : rien n’est ajouté dans le dos de celui qui le relit.',
      ],
    },
    ouverture: 'Un outil local, un seul utilisateur, dix onglets — et une règle : l’IA prépare, c’est toi qui merges.',
    questions: {
      titre: 'L’IA peut te poser une question',
      sous: 'Face à un choix structurant, elle s’arrête et demande au lieu de deviner.',
      puces: [
        'Proposé dans les TROIS saveurs : codage sur dépôt, codage hors dépôt, exploration.',
        'La session passe en attente, la file se libère, une todo et une notification t’avertissent.',
        'Tu réponds depuis la carte — choix proposés ou texte libre — et elle reprend où elle en était.',
        'Hors dépôt, seul le dossier qui attendait repart : les autres n’ont rien demandé.',
      ],
    },
  },

  en: {
    piedDePage: 'Mergerie — feature presentation',
    jenkins: {
      section: { titre: 'Jenkins', sous: 'Job status and history without opening Jenkins — and without reading a failure e-mail to find out what ran.' },
      slides: [
        {
          bandeau: 'JENKINS',
          titre: 'The jobs, and what they returned',
          sous: 'One line per job, its latest result, its duration — and you can launch it from here.',
          puces: [
            'Green, red, unstable or never run: the latest verdict reads without opening the job.',
            'A parameterised job launches from the tool: parameters are asked for, with their default values.',
            'Auto-refresh, switchable off — a tab that reloads while you read it is a tab you close.',
            'Search on name and folder: a real instance carries hundreds of jobs.',
          ],
        },
        {
          bandeau: 'JENKINS',
          titre: 'Filter by folder, by parameter, by what is broken',
          sous: 'Three filters that combine, because you never look for everything at once.',
          puces: [
            'Folders come first, tickable, with a search field of their own.',
            'Parameters that recur from job to job become columns, and filter by value.',
            '“Only what is broken” cuts the list down to failing and unstable jobs.',
            'The list stays chronological: mixing in a grouping by folder would give two readings, neither of them right.',
          ],
        },
        {
          bandeau: 'JENKINS',
          titre: 'A job’s history, run by run',
          sous: 'Runs on the left, the detail of the one you are looking at on the right.',
          puces: [
            'Each run carries its parameters, in the same colours as in the list — that is what tells two identical runs apart.',
            'The parameter-value filter applies here too: “show me the preprod runs”.',
            'Past the last ten, more history is fetched from Jenkins without leaving the window.',
            'The detail gives the cause of the run, its duration, and the link to Jenkins to go further.',
          ],
        },
      ],
    },
    verifAuto: {
      bandeau: 'OBJECTIVE VERIFICATION',
      titre: 'Automatic, as soon as a merge request lands',
      sous: 'One checkbox on the verifier: nothing left to remember.',
      puces: [
        'A verifier ticked “automatic” starts on its own for every new merge request in its repositories.',
        'At most five verifications per discovery: a burst of merge requests must not flood the queue.',
        'The job queue and the per-repository locks stay the same — nothing doubles, nothing collides.',
        'Worth having when you come back from leave: the verdict is already there, on branches you never saw.',
      ],
    },
    verifResultat: {
      bandeau: 'OBJECTIVE VERIFICATION',
      titre: 'The result, from the merge request',
      sous: 'A button on the card: what ran, on which commits, and what it returned.',
      puces: [
        '“See the verifier results” opens every verification that covered this merge request.',
        'The verdict, the commits tested, the command-by-command breakdown with exit codes and output.',
        'From a failure, “Have the AI fix it” opens a coding session with the context already written.',
        'The card badge says the state; this button says what was done — you may not have seen the run start.',
      ],
    },
    consignes: {
      bandeau: 'AI DEV',
      titre: 'Standing instructions',
      sous: 'What you repeat in every session, written once.',
      puces: [
        'A settings field, added to the prompt of every coding session, in a repository or outside one.',
        'On the first run and on every follow-up: an instruction forgotten by the second message is worth nothing.',
        'The language of comments, a command to run before committing, a naming convention.',
        'The prompt stays visible: nothing is added behind the back of whoever reads it.',
      ],
    },
    ouverture: 'A local tool, a single user, ten tabs — and one rule: the AI prepares, you merge.',
    questions: {
      titre: 'The AI can ask you a question',
      sous: 'Facing a structural choice, it stops and asks instead of guessing.',
      puces: [
        'Offered in ALL THREE flavours: coding in a repository, coding outside one, exploration.',
        'The session goes into waiting, the queue frees up, a todo and a notification reach you.',
        'You answer from the card — offered choices or free text — and it resumes where it left off.',
        'Outside a repository, only the folder that was waiting resumes: the others asked nothing.',
      ],
    },
  },
};

/* ------------------------------------------------------------------- zip ------
   Lecture et écriture d'un zip sans dépendance : les .pptx n'utilisent que « stocké » (0)
   et « dégonflé » (8), et Node sait faire les deux. Ajouter une bibliothèque pour dix
   diapositives aurait coûté plus cher que ces quatre-vingts lignes. */
function lireZip(fichier) {
  const buf = fs.readFileSync(fichier);
  // On passe par le répertoire central : c'est la seule liste faisant autorité sur le contenu.
  const fin = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (fin < 0) throw new Error(`${fichier} : ce n'est pas un zip (fin de répertoire introuvable).`);
  const nb = buf.readUInt16LE(fin + 10);
  let p = buf.readUInt32LE(fin + 16);
  const entrees = new Map();
  for (let i = 0; i < nb; i += 1) {
    const nLen = buf.readUInt16LE(p + 28);
    const eLen = buf.readUInt16LE(p + 30);
    const cLen = buf.readUInt16LE(p + 32);
    const methode = buf.readUInt16LE(p + 10);
    const tailleC = buf.readUInt32LE(p + 20);
    const debut = buf.readUInt32LE(p + 42);
    const nom = buf.toString('utf8', p + 46, p + 46 + nLen);
    // En-tête local : sa longueur varie, il faut la relire pour trouver les octets.
    const lnLen = buf.readUInt16LE(debut + 26);
    const leLen = buf.readUInt16LE(debut + 28);
    const brut = buf.subarray(debut + 30 + lnLen + leLen, debut + 30 + lnLen + leLen + tailleC);
    entrees.set(nom, methode === 8 ? zlib.inflateRawSync(brut) : Buffer.from(brut));
    p += 46 + nLen + eLen + cLen;
  }
  return entrees;
}

function ecrireZip(fichier, entrees) {
  const morceaux = [];
  const central = [];
  let offset = 0;
  for (const [nom, contenu] of entrees) {
    const nomBuf = Buffer.from(nom, 'utf8');
    const deflate = zlib.deflateRawSync(contenu, { level: 9 });
    const crc = crc32(contenu);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflate.length, 18); local.writeUInt32LE(contenu.length, 22);
    local.writeUInt16LE(nomBuf.length, 26);
    morceaux.push(local, nomBuf, deflate);

    const ce = Buffer.alloc(46);
    ce.writeUInt32LE(0x02014b50, 0);
    ce.writeUInt16LE(20, 4); ce.writeUInt16LE(20, 6); ce.writeUInt16LE(0, 8); ce.writeUInt16LE(8, 10);
    ce.writeUInt32LE(crc, 16);
    ce.writeUInt32LE(deflate.length, 20); ce.writeUInt32LE(contenu.length, 24);
    ce.writeUInt16LE(nomBuf.length, 28);
    ce.writeUInt32LE(offset, 42);
    central.push(ce, nomBuf);
    offset += local.length + nomBuf.length + deflate.length;
  }
  const centralBuf = Buffer.concat(central);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(entrees.size, 8); fin.writeUInt16LE(entrees.size, 10);
  fin.writeUInt32LE(centralBuf.length, 12); fin.writeUInt32LE(offset, 16);
  fs.writeFileSync(fichier, Buffer.concat([...morceaux, centralBuf, fin]));
}

let TABLE_CRC = null;
function crc32(buf) {
  if (!TABLE_CRC) {
    TABLE_CRC = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE_CRC[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = TABLE_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ------------------------------------------------------------------- XML ------ */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Remplace les textes d'une diapo, dans l'ordre où ils apparaissent. `null` = on ne touche pas.
function remplacerTextes(xml, textes) {
  let i = 0;
  return xml.replace(/<a:t>([^<]*)<\/a:t>/g, (m, ancien) => {
    const t = textes[i]; i += 1;
    return t == null ? m : `<a:t>${esc(t)}</a:t>`;
  });
}
const compterTextes = (xml) => (xml.match(/<a:t>/g) || []).length;

/* ---------------------------------------------------------------- traitement --- */
function traiter(fichier, lang) {
  const C = CONTENU[lang];
  const z = lireZip(fichier);
  const lire = (n) => z.get(n).toString('utf8');
  const poser = (n, s) => z.set(n, Buffer.from(s, 'utf8'));

  const pres = lire('ppt/presentation.xml');
  const ordre = [...pres.matchAll(/<p:sldId id="(\d+)" r:id="(rId\d+)"\/>/g)].map((m) => ({ id: +m[1], rid: m[2] }));
  const relsPres = lire('ppt/_rels/presentation.xml.rels');
  // rId -> fichier de diapo, pour retrouver l'ordre RÉEL (les noms de fichier ne le donnent pas).
  const cible = {};
  for (const m of relsPres.matchAll(/Id="(rId\d+)"[^>]*Target="(slides\/slide\d+\.xml)"/g)) cible[m[1]] = `ppt/${m[2]}`;
  const fichiers = ordre.map((o) => cible[o.rid]);

  // Repères : les diapos intercalaires portent exactement 3 textes, dont un numéro « NN ».
  const intercalaires = [];
  fichiers.forEach((f, i) => {
    const x = lire(f);
    const ts = [...x.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);
    if (ts.length === 3 && /^\d{2}$/.test(ts[0])) intercalaires.push({ i, f, num: ts[0], titre: ts[1] });
  });
  if (intercalaires.length !== 14) {
    throw new Error(`${fichier} : ${intercalaires.length} sections trouvées au lieu de 14 — le jeu a changé, le script doit être relu avant d'écrire.`);
  }

  let maxId = Math.max(...ordre.map((o) => o.id));
  let maxRid = Math.max(...[...relsPres.matchAll(/Id="rId(\d+)"/g)].map((m) => +m[1]));
  let maxSlide = Math.max(...fichiers.map((f) => +f.match(/slide(\d+)\.xml$/)[1]));
  const nouvellesRels = [];
  const nouveauxTypes = [];
  const aInserer = [];   // { apresIndex, sldId }

  /* Fabrique une diapo en COPIANT une diapo existante de même nature. On copie aussi ses
     relations : le fond, la police et la mise en page viennent avec, ce qu'une diapo
     construite de zéro n'aurait jamais eu. */
  const creer = (modeleFichier, textes) => {
    const modele = lire(modeleFichier);
    if (compterTextes(modele) !== textes.length) {
      throw new Error(`${modeleFichier} : ${compterTextes(modele)} textes, ${textes.length} fournis.`);
    }
    maxSlide += 1;
    const nom = `ppt/slides/slide${maxSlide}.xml`;
    poser(nom, remplacerTextes(modele, textes));
    const relsModele = `ppt/slides/_rels/${path.basename(modeleFichier)}.rels`;
    poser(`ppt/slides/_rels/slide${maxSlide}.xml.rels`, lire(relsModele));
    maxRid += 1; maxId += 1;
    nouvellesRels.push(`<Relationship Id="rId${maxRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${maxSlide}.xml"/>`);
    nouveauxTypes.push(`<Override PartName="/ppt/slides/slide${maxSlide}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
    return `<p:sldId id="${maxId}" r:id="rId${maxRid}"/>`;
  };

  const modeleInter = intercalaires[7].f;                       // une intercalaire quelconque
  const modeleContenu = fichiers[intercalaires[7].i + 1];       // la diapo de contenu qui la suit

  /* GARDE-FOU D'IDEMPOTENCE. Le script a déjà servi une fois (Notes, Liens, navigation) et les
     fichiers d'origine ont été remplacés. Relancé sur un jeu déjà à jour, il ajouterait une
     seconde fois les mêmes diapos, sans rien signaler — et ça ne se verrait qu'en projection. */
  if (fichiers.some((f) => /JENKINS/.test(lire(f)))) {
    throw new Error(`${fichier} : une diapo « JENKINS » existe déjà — le jeu a déjà reçu cette passe.`);
  }

  const poserSection = (avantIndex, bloc, numero) => {
    const sldIds = [creer(modeleInter, [numero, bloc.section.titre, bloc.section.sous])];
    for (const s of bloc.slides) {
      sldIds.push(creer(modeleContenu, [s.bandeau, s.titre, s.sous, ...s.puces.map((p) => PUCE + p), C.piedDePage]));
    }
    aInserer.push({ avantIndex, sldIds });
  };
  const poserDiapo = (avantIndex, d) => aInserer.push({
    avantIndex,
    sldIds: [creer(modeleContenu, [d.bandeau, d.titre, d.sous, ...d.puces.map((p) => PUCE + p), C.piedDePage])],
  });

  /* Une diapo s'insère AVANT l'intercalaire suivante : c'est la seule façon de la poser à la
     FIN d'une section sans dépendre du nombre de diapos qu'elle contient aujourd'hui. */
  const avant = (num) => intercalaires.find((s) => s.num === num).i;

  // --- Section Jenkins, entre Docker (08) et Jira (09) ---
  poserSection(avant('09'), C.jenkins, '09');
  // --- Deux diapos à la fin de « Vérification objective » (03), donc avant « Dev IA » (04) ---
  /* DEUX DIAPOS AU MÊME POINT D'INSERTION S'INVERSENT : elles sont posées en partant de la fin
     pour ne pas décaler les repères, donc la dernière déclarée arrive en premier. */
  poserDiapo(avant('04'), C.verifResultat);
  poserDiapo(avant('04'), C.verifAuto);
  // --- Une diapo à la fin de « Dev IA » (04), donc avant « Notes » (05) ---
  poserDiapo(avant('05'), C.consignes);

  // --- Renumérotation des sections : recalculée, jamais retapée ---
  const nouvelOrdre = intercalaires.map((s) => {
    const n = +s.num;
    return { f: s.f, num: String(n >= 9 ? n + 1 : n).padStart(2, '0'), ancien: s.num };
  });
  for (const s of nouvelOrdre) {
    if (s.num !== s.ancien) poser(s.f, remplacerTextes(lire(s.f), [s.num, null, null]));
  }

  /* --- Diapos existantes devenues fausses ---
     Une diapo qui annonce « sept onglets » vieillit mal : elle est fausse avant d'être
     démodée. Même chose pour la question de l'IA, longtemps réservée au codage sur dépôt. */
  const ouverture = intercalaires.find((s) => s.num === '01');
  poser(ouverture.f, remplacerTextes(lire(ouverture.f), [null, null, C.ouverture]));

  const majQuestions = fichiers.find((f) => /poser une question|ask you a question/i.test(lire(f)));
  if (majQuestions) {
    const q = C.questions;
    poser(majQuestions, remplacerTextes(lire(majQuestions),
      [null, q.titre, q.sous, ...q.puces.map((x) => PUCE + x), null]));
  } else console.warn(`  ⚠ ${lang} : diapo « question de l'IA » introuvable, non mise à jour.`);

  // --- Assemblage : sldIdLst, rels et Content_Types ---
  let sldLst = ordre.map((o) => `<p:sldId id="${o.id}" r:id="${o.rid}"/>`);
  // On insère en partant de la FIN : sinon chaque insertion décale les repères suivants.
  for (const ins of aInserer.sort((a, b) => b.avantIndex - a.avantIndex)) {
    sldLst = [...sldLst.slice(0, ins.avantIndex), ...ins.sldIds, ...sldLst.slice(ins.avantIndex)];
  }
  poser('ppt/presentation.xml', pres.replace(/<p:sldIdLst>.*?<\/p:sldIdLst>/s, `<p:sldIdLst>${sldLst.join('')}</p:sldIdLst>`));
  poser('ppt/_rels/presentation.xml.rels', relsPres.replace('</Relationships>', `${nouvellesRels.join('')}</Relationships>`));
  poser('[Content_Types].xml', lire('[Content_Types].xml').replace('</Types>', `${nouveauxTypes.join('')}</Types>`));

  const sortie = ECRIRE ? fichier : fichier.replace(/\.pptx$/, '.new.pptx');
  if (ECRIRE) fs.copyFileSync(fichier, `${fichier}.bak`);
  ecrireZip(sortie, z);
  return { sortie, ajoutees: nouvellesRels.length, total: sldLst.length };
}

for (const [f, lang] of [['presentation.pptx', 'fr'], ['presentation-en.pptx', 'en']]) {
  const r = traiter(path.join(ROOT, f), lang);
  console.log(`✓ ${path.basename(r.sortie)} — ${r.ajoutees} diapos ajoutées, ${r.total} au total`);
}
if (!ECRIRE) console.log('\n(rien n’a été écrasé : relance avec --write pour remplacer les fichiers d’origine)');
