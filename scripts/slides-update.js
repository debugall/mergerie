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
   côté. Les puces gardent le préfixe « •  » des diapos existantes (deux espaces). */
const PUCE = '•  ';

const CONTENU = {
  fr: {
    piedDePage: 'Mergerie — présentation des fonctionnalités',
    notes: {
      section: { titre: 'Notes', sous: 'Le bloc-notes du quotidien, dans l’outil : ancré à ce qu’on y suit, et dans la sauvegarde.' },
      slides: [
        {
          bandeau: 'NOTES',
          titre: 'Le brief du matin',
          sous: 'Sept sections, action d’abord — et chacune disparaît quand elle est vide.',
          puces: [
            'Rappels échus, todos du jour, sessions où l’IA attend une réponse, vérifications en échec.',
            'MR arrivées depuis hier, MR dormantes reviewées il y a plus de N jours, activité de la veille.',
            'Une section vide est masquée : sept titres sous-titrés « rien » n’apprennent rien.',
            'On coche et on reporte SUR PLACE : un brief qui oblige à changer d’écran ne sert à rien.',
          ],
        },
        {
          bandeau: 'NOTES',
          titre: 'Des todos qui se cochent, pas qui se pilotent',
          sous: 'Priorité, échéance, report en un clic — et rien qui disparaisse.',
          puces: [
            'Ajout inline : on tape, Entrée, c’est créé. Tri par priorité puis par échéance.',
            'Statut binaire, à faire ou fait. Pas d’« en cours » : une todo se coche, elle ne se pilote pas.',
            'Échéance affichée en relatif, en rouge seulement si elle est dépassée. Report +1 h ou demain 9 h.',
            'Une todo faite reste barrée sept jours, puis part aux archives — consultable, jamais perdue.',
          ],
        },
        {
          bandeau: 'NOTES',
          titre: 'Des pages, et des références qui deviennent des liens',
          sous: 'Du Markdown libre, et ce qu’on cite reconnu tout seul.',
          puces: [
            'Pages libres, épinglables, recherche sur le titre ET le contenu, sauvegarde automatique.',
            '« !214 » et « PROJ-720 » deviennent cliquables sans qu’on ait rien à baliser.',
            'Une URL collée devient un lien — http et https seulement, parce qu’on colle sans relire.',
            'Rien ne part vers l’IA ni vers une forge : tout vit en local, et aucun token n’est consommé.',
          ],
        },
      ],
    },
    liens: {
      section: { titre: 'Liens', sous: 'Les liens de travail ont une structure que les marque-pages d’un navigateur ne savent pas représenter.' },
      slides: [
        {
          bandeau: 'LIENS',
          titre: 'La grille services × environnements',
          sous: 'Le même service en local, dev, preprod et prod — vu d’un coup, pas éclaté en quatre dossiers.',
          puces: [
            'Lignes = services, avec leurs tags et le dépôt associé. Colonnes = environnements, chacun sa couleur.',
            'Une case = une URL ÉCRITE. Deviner l’adresse de preprod depuis celle de dev envoie un jour au mauvais endroit.',
            'Une case vide affiche un « + » : on colle l’adresse dans la case, Entrée valide, Échap annule.',
            'Filtre par tag : un service appartient souvent à deux familles à la fois, qu’un arbre obligerait à trancher.',
          ],
        },
        {
          bandeau: 'LIENS',
          titre: 'Liens libres, tags et import des marque-pages',
          sous: 'Ce qui n’a pas de dimension environnement reste à plat, retrouvé par ses tags.',
          puces: [
            'Confluence, une doc, un outil : un libellé, une URL, des tags, une recherche instantanée.',
            'Import des marque-pages Chrome avec aperçu : l’arbre tel quel, chaque lien cochable, tagué par son dossier.',
            'Rejouable — réimporter le même fichier ne duplique pas ce qui est déjà là. Le fichier est lu, jamais exécuté.',
            '« Convertir en service » : le mapping vers les environnements est explicite, jamais deviné depuis l’URL.',
          ],
        },
        {
          bandeau: 'LIENS',
          titre: 'La palette globale — Ctrl+K, ou la touche « o »',
          sous: 'Un champ dans l’en-tête, et tout le cockpit derrière.',
          puces: [
            'Cherche partout à la fois : cases de la grille, liens libres, MR, tickets surveillés, pages, todos, navigation.',
            'Interroge le serveur et filtre en base : elle voit ce que l’onglet courant n’a pas chargé.',
            'Insensible aux accents et à la casse ; on abrège par mots — « kib pre » trouve « Kibana · preprod ».',
            'Classement par frécence : ce qu’on ouvre souvent ET récemment remonte, pas ce qu’on a martelé le mois dernier.',
          ],
        },
        {
          bandeau: 'LIENS',
          titre: 'Liens contextuels sur les merge requests',
          sous: 'Des adresses qui dépendent de la merge request, résolues au moment du clic.',
          puces: [
            'Sur une MR : les URLs du service, puis des gabarits à {env}, {branch}, {mr_iid}, {service} résolus au clic.',
            'Une variable inconnue est refusée à la saisie ; sans valeur, le bouton reste grisé et dit pourquoi.',
            'Chaque valeur substituée est URL-encodée : une branche « feat/x?y=1 » n’ouvre pas un paramètre surprise.',
            'Le bouton ouvre l’adresse dans un nouvel onglet, sans donner la main sur la page qui l’a ouvert.',
          ],
        },
      ],
    },
    navigation: {
      bandeau: 'CONFORT D’USAGE',
      titre: 'La navigation tient dans une colonne',
      sous: 'À neuf entrées, un bandeau horizontal n’avait plus de place.',
      puces: [
        'Chaque entrée a sa ligne, ses badges tiennent, et la dixième ne coûtera rien.',
        'La colonne se replie en icônes d’un bouton, se souvient du choix, et se replie seule sous 1100 px.',
        'Repliée, les libellés sont masqués et non retirés : le survol et les lecteurs d’écran disent toujours où l’on va.',
        'La place libérée en haut porte le champ de la palette, qui avait le problème inverse : invisible sans le raccourci.',
      ],
    },
    palette: {
      titre: 'La palette globale et les raccourcis',
      sous: 'Ctrl+K ou la touche « o » — sauter n’importe où sans lâcher le clavier.',
      puces: [
        'La palette cherche partout : liens, MR, tickets surveillés, pages, todos, et les actions de navigation.',
        'Chiffres pour les onglets, / pour la recherche, r pour chercher les MR, l pour les logs.',
        'j et k parcourent la liste visible, Entrée ouvre, Échap ferme.',
        '? affiche la liste complète des raccourcis, à tout moment.',
      ],
    },
    demo: 'MR à traiter, rapports notés, suivi de résolution, notes, liens, statistiques, sessions Dev IA.',
  },

  en: {
    piedDePage: 'Mergerie — feature presentation',
    notes: {
      section: { titre: 'Notes', sous: 'The day-to-day notepad, inside the tool: anchored to what you track, and inside the backup.' },
      slides: [
        {
          bandeau: 'NOTES',
          titre: 'The morning brief',
          sous: 'Seven sections, action first — and each one disappears when it is empty.',
          puces: [
            'Overdue reminders, today’s todos, sessions where the AI is waiting for an answer, failed verifications.',
            'MRs that arrived since yesterday, MRs reviewed more than N days ago and still open, yesterday’s activity.',
            'An empty section is hidden: seven headings subtitled “nothing” teach you nothing.',
            'You tick and postpone IN PLACE: a brief that makes you change screens is not a brief.',
          ],
        },
        {
          bandeau: 'NOTES',
          titre: 'Todos you tick off, not todos you manage',
          sous: 'Priority, due date, one-click postpone — and nothing that disappears.',
          puces: [
            'Inline add: you type, Enter, it exists. Sorted by priority, then by due date.',
            'Binary status, to do or done. No “in progress”: a todo gets ticked, it does not get managed.',
            'Due dates shown relatively, in red only once overdue. Postpone by +1 h or to tomorrow 9 am.',
            'A done todo stays struck through for seven days, then moves to the archive — still readable, never lost.',
          ],
        },
        {
          bandeau: 'NOTES',
          titre: 'Pages, and references that turn into links',
          sous: 'Free-form Markdown, and what you mention recognised on its own.',
          puces: [
            'Free pages, pinnable, searched on title AND content, saved as you type.',
            '“!214” and “PROJ-720” become clickable without you marking anything up.',
            'A pasted URL becomes a link — http and https only, because you paste without re-reading.',
            'Nothing goes to the AI or to a forge: it all lives locally, and no tokens are spent.',
          ],
        },
      ],
    },
    liens: {
      section: { titre: 'Links', sous: 'Work links have a structure that a browser’s bookmarks cannot represent.' },
      slides: [
        {
          bandeau: 'LINKS',
          titre: 'The services × environments grid',
          sous: 'The same service in local, dev, staging and production — seen at once, not scattered across four folders.',
          puces: [
            'Rows = services, with their tags and linked repository. Columns = environments, each with its colour.',
            'A cell = a WRITTEN URL. Guessing staging from dev by swapping part of a domain sends you to the wrong place one day.',
            'An empty cell shows a “+”: you paste the address into the cell, Enter confirms, Esc cancels.',
            'Filter by tag: a service often belongs to two families at once, which a folder tree would force you to choose between.',
          ],
        },
        {
          bandeau: 'LINKS',
          titre: 'Free links, tags and bookmark import',
          sous: 'Whatever has no environment dimension stays flat, found by its tags.',
          puces: [
            'Confluence, a doc, a tool: a label, a URL, tags, and an instant search.',
            'Chrome bookmark import with a preview: the tree as it was, each link tickable, tagged by its folder.',
            'Replayable — re-importing the same file does not duplicate what is there. The file is parsed, never executed.',
            '“Convert to service”: the mapping onto environments is explicit, never guessed from the URL.',
          ],
        },
        {
          bandeau: 'LINKS',
          titre: 'The global palette — Ctrl+K, or the “o” key',
          sous: 'One field in the header, and the whole cockpit behind it.',
          puces: [
            'Searches everything at once: grid cells, free links, MRs, watched tickets, pages, todos, navigation.',
            'Queries the server and filters in the database: it sees what the current tab has not loaded.',
            'Accent- and case-insensitive; you abbreviate by words — “kib pre” finds “Kibana · preprod”.',
            'Ranked by frecency: what you open often AND recently comes up, not what you hammered last month.',
          ],
        },
        {
          bandeau: 'LINKS',
          titre: 'Contextual links on merge requests',
          sous: 'Addresses that depend on the merge request, resolved at click time.',
          puces: [
            'On an MR: the service’s URLs, then templates with {env}, {branch}, {mr_iid}, {service} resolved on click.',
            'An unknown variable is refused as you type it; with no value, the button stays greyed and says why.',
            'Every substituted value is URL-encoded: a branch “feat/x?y=1” does not open a surprise parameter.',
            'The button opens the address in a new tab, with no handle on the page that opened it.',
          ],
        },
      ],
    },
    navigation: {
      bandeau: 'EVERYDAY COMFORT',
      titre: 'Navigation fits in one column',
      sous: 'At nine entries, a horizontal bar had run out of room.',
      puces: [
        'Each entry gets its own row, its badges fit, and the tenth will cost nothing.',
        'The column folds down to icons from a button, remembers the choice, and folds on its own below 1100 px.',
        'Folded, labels are hidden rather than removed: hover and screen readers still say where each entry leads.',
        'The space this freed at the top carries the palette’s field, which had the opposite problem: invisible without the shortcut.',
      ],
    },
    palette: {
      titre: 'The global palette and the shortcuts',
      sous: 'Ctrl+K or the “o” key — jump anywhere without leaving the keyboard.',
      puces: [
        'The palette searches everything: links, MRs, watched tickets, pages, todos, and navigation actions.',
        'Digits for tabs, / for search, r to search MRs, l for logs.',
        'j and k walk the visible list, Enter opens, Esc closes.',
        '? shows the full list of shortcuts, at any time.',
      ],
    },
    demo: 'MRs to handle, scored reports, resolution tracking, notes, links, stats, AI Dev sessions.',
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
  if (intercalaires.length !== 12) {
    throw new Error(`${fichier} : ${intercalaires.length} sections trouvées au lieu de 12 — le jeu a changé, le script doit être relu avant d'écrire.`);
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

  // --- Section Notes, juste après « Dev IA » (donc avant l'intercalaire suivante) ---
  const poserSection = (avantIndex, bloc, numero) => {
    const sldIds = [creer(modeleInter, [numero, bloc.section.titre, bloc.section.sous])];
    for (const s of bloc.slides) {
      sldIds.push(creer(modeleContenu, [s.bandeau, s.titre, s.sous, ...s.puces.map((p) => PUCE + p), C.piedDePage]));
    }
    aInserer.push({ avantIndex, sldIds });
  };

  const idxStats = intercalaires.find((s) => s.num === '05').i;      // « 05 Statistiques »
  const idxReglages = intercalaires.find((s) => s.num === '09').i;   // « 09 Réglages »
  poserSection(idxStats, C.notes, '05');
  poserSection(idxReglages, C.liens, '10');

  // --- Une diapo de plus dans « Confort d'usage » : la navigation en colonne ---
  const idxSecurite = intercalaires.find((s) => s.num === '11').i;
  const nav = C.navigation;
  aInserer.push({
    avantIndex: idxSecurite,
    sldIds: [creer(modeleContenu, [nav.bandeau, nav.titre, nav.sous, ...nav.puces.map((p) => PUCE + p), C.piedDePage])],
  });

  // --- Renumérotation des sections : recalculée, jamais retapée ---
  const nouvelOrdre = [];
  intercalaires.forEach((s) => {
    let n = +s.num;
    if (n >= 5) n += 1;    // Notes s'intercale en 05
    if (n >= 10) n += 1;   // Liens s'intercale en 10 (après le premier décalage)
    nouvelOrdre.push({ f: s.f, num: String(n).padStart(2, '0'), ancien: s.num });
  });
  for (const s of nouvelOrdre) {
    if (s.num !== s.ancien) poser(s.f, remplacerTextes(lire(s.f), [s.num, null, null]));
  }

  // --- Diapos existantes à rafraîchir ---
  const majPalette = fichiers.find((f) => /Palette de commandes|palette and the shortcuts|Command palette/i.test(lire(f)));
  if (majPalette) {
    const x = lire(majPalette);
    poser(majPalette, remplacerTextes(x, [null, C.palette.titre, C.palette.sous, ...C.palette.puces.map((p) => PUCE + p), null]));
  } else console.warn(`  ⚠ ${lang} : diapo « palette » introuvable, non mise à jour.`);

  const majDemo = fichiers.find((f) => /30 secondes|30 seconds/i.test(lire(f)));
  if (majDemo) {
    const x = lire(majDemo);
    poser(majDemo, remplacerTextes(x, [null, null, null, null, C.demo, null, null, null]));
  } else console.warn(`  ⚠ ${lang} : diapo « mode démo » introuvable, non mise à jour.`);

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
