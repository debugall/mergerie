'use strict';
/* Rendu markdown minimal (`mdToHtml`) — échappe d'abord, puis une liste blanche ; un état vide (`emptyState`). */
// Rendu markdown minimal (titres, gras, code, listes, blockquote, tableaux GFM).
/* `opts.paragraphes` : un texte ÉCRIT PAR UNE IA (rapport, réponse, retour de session). Les agents
   reviennent à la ligne vers cent caractères, comme dans un fichier source : rendu ligne par
   ligne, chaque morceau devenait un paragraphe à part, avec sa marge — un rapport se lisait comme
   une liste de fragments. On suit alors la règle de Markdown : des lignes consécutives forment UN
   paragraphe, et une ligne indentée sous une puce la continue. Les notes et les textes Jira gardent
   le rendu ligne à ligne : là, un retour à la ligne est voulu par celui qui l'a tapé. */
const IA = { paragraphes: true };   // voir `mdToHtml` : un texte écrit par une IA
function mdToHtml(md, opts = {}) {
  if (!md) return '<p class="muted">(vide)</p>';
  const lines = md.split('\n');
  const fusion = !!opts.paragraphes;
  let html = '';
  let para = [];                 // lignes du paragraphe en cours (mode fusion)
  let li = null;                 // texte de la puce en cours (mode fusion)
  let inList = false;
  let inCode = false;
  /* Un bloc ``` peut porter un langage. Il était jeté : `mermaid` ressortait en <pre>, donc
     un diagramme se lisait comme du texte. Seul `mermaid` est distingué — les autres langages
     ne changent rien au rendu, et inventer une coloration syntaxique ici serait un autre sujet. */
  let inMermaid = false;
  const inline = (t) => esc(t)
    // Image embarquée Jira → vignette inline cliquable (URL restreinte à NOTRE proxy = sûr).
    .replace(/!\[([^\]]*)\]\((\/api\/jira\/attachment\/\d+)\)/g, '<img class="jira-inline-img" src="$2" alt="$1" data-jimg="$2" data-jname="$1" loading="lazy" />')
    /* Capture collée dans une page de notes. MÊME garde-fou : seule cette forme d'URL — la
       nôtre, servie par nous — devient une image. Une adresse écrite à la main dans le texte
       reste du texte, sinon `![](javascript:…)` ou un pixel espion chez un tiers passerait. */
    .replace(/!\[([^\]]*)\]\((\/api\/notes\/\d+\/images\/\d+)\)/g, '<img class="note-inline-img" src="$2" alt="$1" loading="lazy" />')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  /* Le `|` d'une cellule est échappé à la source (`\|`) : sans quoi il ouvrirait une colonne
     de plus et décalerait toute la ligne. On coupe donc sur les `|` NON échappés, puis on
     rend le caractère à la cellule. */
  const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const isSep = (line) => { const c = splitRow(line); return c.length > 0 && c.every((x) => /^:?-+:?$/.test(x)); };
  const flushPara = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const flushLi = () => { if (li !== null) { html += `<li>${inline(li)}</li>`; li = null; } };
  const closeList = () => { flushLi(); if (inList) { html += '</ul>'; inList = false; } };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // Continuation d'une puce : ligne indentée, sans marqueur, juste sous elle.
    if (fusion && li !== null && /^\s+\S/.test(raw) && !/^\s*([-*]|\d+[.)])\s+/.test(raw)
      && !raw.trim().startsWith('```')) {
      li += ` ${raw.trim()}`;
      continue;
    }
    if (!inCode && fusion) {
      const simple = raw.trim() !== '' && !raw.trim().startsWith('```') && !/^#{1,6}\s/.test(raw)
        && !/^\s*[-*]\s+/.test(raw) && !raw.trim().startsWith('>') && raw.trim() !== '---'
        && !(raw.includes('|') && i + 1 < lines.length && isSep(lines[i + 1]));
      if (simple) { closeList(); para.push(raw.trim()); continue; }
      flushPara();
    }

    if (raw.trim().startsWith('```')) {
      if (inCode) { html += inMermaid ? '</pre></div>' : '</pre>'; inCode = false; inMermaid = false; }
      else {
        closeList();
        inMermaid = raw.trim().slice(3).trim().toLowerCase() === 'mermaid';
        /* Le <pre> reste À L'INTÉRIEUR, et c'est voulu : il porte la source, il sert de repli
           quand le diagramme ne compile pas, et l'autolink des notes saute déjà tout <pre>.
           Le rendu remplacera son contenu par le SVG, pas le <pre> lui-même. */
        html += inMermaid ? '<div class="mermaid-wrap" data-mermaid><pre>' : '<pre>';
        inCode = true;
      }
      continue;
    }
    if (inCode) { html += esc(raw) + '\n'; continue; }

    // Tableau GFM : ligne avec « | » immédiatement suivie d'une ligne séparateur.
    if (raw.includes('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      closeList();
      const headers = splitRow(raw);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':'); const r = c.endsWith(':');
        return (l && r) ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      const cellStyle = (k) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : '');
      const thead = '<tr>' + headers.map((hh, k) => `<th${cellStyle(k)}>${inline(hh)}</th>`).join('') + '</tr>';
      let body = '';
      let j = i + 2;
      for (; j < lines.length; j++) {
        const r = lines[j];
        if (!r.includes('|') || r.trim() === '') break;
        const cells = splitRow(r);
        body += '<tr>' + headers.map((_, k) => `<td${cellStyle(k)}>${inline(cells[k] || '')}</td>`).join('') + '</tr>';
      }
      const sansEnTete = headers.every((hh) => hh === '');
      html += `<div class="md-tablewrap"><table class="md-table${sansEnTete ? ' md-table-nohead' : ''}">`
        + `<thead>${thead}</thead><tbody>${body}</tbody></table></div>`;
      i = j - 1;
      continue;
    }

    // Jusqu'à six niveaux : un « ##### 🟠 IMPORTANT » d'agent s'affichait tel quel.
    const h = raw.match(/^(#{1,6})\s+(.*)/);
    if (h) { closeList(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
    if (/^\s*[-*]\s+/.test(raw)) {
      if (!inList) { html += '<ul>'; inList = true; }
      const texte = raw.replace(/^\s*[-*]\s+/, '');
      if (fusion) { flushLi(); li = texte; } else html += `<li>${inline(texte)}</li>`;
      continue;
    }
    closeList();
    if (raw.trim().startsWith('>')) { html += `<blockquote>${inline(raw.replace(/^\s*>\s?/, ''))}</blockquote>`; continue; }
    if (raw.trim() === '---') { html += '<hr>'; continue; }
    if (raw.trim() === '') { continue; }
    html += `<p>${inline(raw)}</p>`;
  }
  flushPara();
  closeList();
  if (inCode) html += inMermaid ? '</pre></div>' : '</pre>';
  return html;
}

/* ---------- États vides ----------
   Sur un outil qui démarre à vide, c'est le PREMIER écran vu : il doit expliquer
   ce qui va se passer et proposer l'action suivante, pas afficher « Aucun X. ». */
function emptyState({ icon = 'inbox', title, text = '', actions = [] }) {
  const btns = actions.map((a) => `<button class="btn ${a.primary ? 'btn-primary' : ''}" data-empty-act="${esc(a.act)}">${a.label}</button>`).join('');
  return `<div class="empty">
    <svg class="ico"><use href="#i-${icon}"/></svg>
    <div class="empty-t">${title}</div>
    ${text ? `<p class="empty-s">${text}</p>` : ''}
    ${btns ? `<div class="empty-actions">${btns}</div>` : ''}
  </div>`;
}

