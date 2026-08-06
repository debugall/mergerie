'use strict';
/* Export d'une réponse d'agent en .docx — Markdown → OOXML, sans aucune dépendance.
 *
 * Pourquoi ici et pas dans le navigateur : un .docx est un ZIP, et Node sait déjà le
 * fabriquer (`zlib.deflateRawSync`). Le faire au front demanderait d'embarquer une
 * bibliothèque de compression pour un bouton.
 *
 * Le sous-ensemble Markdown traité est exactement celui que l'application AFFICHE
 * (`mdToHtml` côté front) : titres, paragraphes, listes, blocs de code, citations, filets,
 * tableaux GFM, et en ligne `code`, **gras**, *italique*. Ce qui sort du lot est écrit tel
 * quel plutôt que perdu — un export qui escamote silencieusement une partie du texte est
 * pire qu'un export un peu fruste.
 */

const { zipper } = require('./zip');

/* ---------------------------------------------------------------- Markdown → OOXML */

const echapper = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // Les caractères de contrôle rendent le document ILLISIBLE pour Word (« contenu
  // illisible », sans autre explication). Ils n'ont rien à faire dans un texte.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

// Un fragment de texte, avec sa mise en forme. `xml:space` préserve les espaces de bord.
function run(texte, { gras, italique, code } = {}) {
  const props = [
    gras ? '<w:b/>' : '',
    italique ? '<w:i/>' : '',
    code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/>' : '',
  ].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${echapper(texte)}</w:t></w:r>`;
}

/* Découpe une ligne en fragments formatés. L'ordre compte : le code littéral d'abord, sinon
   des astérisques à l'intérieur d'un `**bold**` cité en code seraient interprétés. */
function fragments(ligne) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let dernier = 0;
  let m = re.exec(ligne);
  while (m) {
    if (m.index > dernier) out.push(run(ligne.slice(dernier, m.index)));
    if (m[1]) out.push(run(m[1].slice(1, -1), { code: true }));
    else if (m[2]) out.push(run(m[2].slice(2, -2), { gras: true }));
    else out.push(run(m[3].slice(1, -1), { italique: true }));
    dernier = m.index + m[0].length;
    m = re.exec(ligne);
  }
  if (dernier < ligne.length) out.push(run(ligne.slice(dernier)));
  return out.join('') || run('');
}

const para = (contenu, style, extra = '') =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>${contenu}</w:p>`;

// Une cellule de tableau. `w:tcW` à 0 = largeur automatique, répartie par Word.
const cellule = (contenu, entete) =>
  `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${entete ? '<w:shd w:val="clear" w:fill="EFEFEF"/>' : ''}</w:tcPr>`
  + `<w:p><w:pPr>${entete ? '<w:rPr><w:b/></w:rPr>' : ''}</w:pPr>${contenu}</w:p></w:tc>`;

function corpsDocument(markdown) {
  const lignes = String(markdown || '').split('\n');
  const out = [];
  const cellules = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const estSep = (l) => { const c = cellules(l); return c.length > 0 && c.every((x) => /^:?-+:?$/.test(x)); };

  for (let i = 0; i < lignes.length; i += 1) {
    const brut = lignes[i];

    // Bloc de code : chaque ligne devient un paragraphe monospace, indenté et grisé.
    if (brut.trim().startsWith('```')) {
      const dedans = [];
      i += 1;
      for (; i < lignes.length && !lignes[i].trim().startsWith('```'); i += 1) dedans.push(lignes[i]);
      for (const l of dedans) out.push(para(run(l || ' ', { code: true }), 'MergerieCode'));
      continue;
    }

    // Tableau GFM : une ligne à barres suivie d'une ligne de séparation.
    if (brut.includes('|') && i + 1 < lignes.length && estSep(lignes[i + 1])) {
      const entetes = cellules(brut);
      let rangs = `<w:tr>${entetes.map((h) => cellule(fragments(h), true)).join('')}</w:tr>`;
      let j = i + 2;
      for (; j < lignes.length; j += 1) {
        const l = lignes[j];
        if (!l.includes('|') || l.trim() === '') break;
        const c = cellules(l);
        rangs += `<w:tr>${entetes.map((_, k) => cellule(fragments(c[k] || ''), false)).join('')}</w:tr>`;
      }
      out.push('<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>'
        + '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="BBBBBB"/><w:left w:val="single" w:sz="4" w:color="BBBBBB"/>'
        + '<w:bottom w:val="single" w:sz="4" w:color="BBBBBB"/><w:right w:val="single" w:sz="4" w:color="BBBBBB"/>'
        + '<w:insideH w:val="single" w:sz="4" w:color="BBBBBB"/><w:insideV w:val="single" w:sz="4" w:color="BBBBBB"/>'
        + '</w:tblBorders></w:tblPr>' + rangs + '</w:tbl>');
      // Word colle le paragraphe suivant au tableau sans ce séparateur.
      out.push('<w:p/>');
      i = j - 1;
      continue;
    }

    const titre = brut.match(/^(#{1,6})\s+(.*)/);
    if (titre) { out.push(para(fragments(titre[2]), `Heading${Math.min(titre[1].length, 4)}`)); continue; }

    /* Listes : la vraie numérotation Word demande un `numbering.xml` entier pour un résultat
       identique à l'œil. On indente et on pose la puce dans le texte — c'est ce que l'export
       doit rendre lisible, pas ce qu'il doit rendre modifiable comme liste native. */
    const puce = brut.match(/^(\s*)[-*]\s+(.*)/);
    if (puce) {
      const niveau = Math.min(Math.floor(puce[1].length / 2), 3);
      out.push(para(run('• ') + fragments(puce[2]), null, `<w:ind w:left="${360 + niveau * 360}" w:hanging="180"/>`));
      continue;
    }
    const num = brut.match(/^(\s*)(\d+)[.)]\s+(.*)/);
    if (num) {
      const niveau = Math.min(Math.floor(num[1].length / 2), 3);
      out.push(para(run(`${num[2]}. `) + fragments(num[3]), null, `<w:ind w:left="${360 + niveau * 360}" w:hanging="180"/>`));
      continue;
    }

    if (brut.trim().startsWith('>')) { out.push(para(fragments(brut.replace(/^\s*>\s?/, '')), 'MergerieQuote')); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(brut)) {
      out.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>');
      continue;
    }
    if (brut.trim() === '') continue;
    out.push(para(fragments(brut)));
  }
  return out.join('');
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="280" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="240" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:outlineLvl w:val="2"/><w:spacing w:before="200" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:pPr><w:outlineLvl w:val="3"/><w:spacing w:before="180" w:after="80"/></w:pPr><w:rPr><w:b/><w:i/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="MergerieCode"><w:name w:val="Mergerie Code"/><w:pPr><w:shd w:val="clear" w:fill="F4F4F4"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="240"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="MergerieQuote"><w:name w:val="Mergerie Quote"/><w:pPr><w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:color="CCCCCC"/></w:pBdr></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>
</w:styles>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const RELS_DOC = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

/* Rend un .docx complet. `titre` devient le premier paragraphe : ouvert six mois plus tard,
   un fichier doit dire de quelle session il vient. */
function markdownToDocx(titre, markdown) {
  const entete = titre ? para(run(String(titre)), 'Title') : '';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${entete}${corpsDocument(markdown)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body>
</w:document>`;
  const b = (s) => Buffer.from(s, 'utf8');
  return zipper([
    { nom: '[Content_Types].xml', data: b(CONTENT_TYPES) },
    { nom: '_rels/.rels', data: b(RELS) },
    { nom: 'word/_rels/document.xml.rels', data: b(RELS_DOC) },
    { nom: 'word/styles.xml', data: b(STYLES) },
    { nom: 'word/document.xml', data: b(document) },
  ]);
}

module.exports = { markdownToDocx, corpsDocument };
