'use strict';
/* Une adresse qu'on rend cliquable : `esc`, `safeUrl`, `safeImg` ; le nom de la forge d'une ligne. */
/* UNE ADRESSE QU'ON REND CLIQUABLE doit mener quelque part d'inoffensif. `esc()` protège
   l'attribut, pas le SCHÉMA : une `web_url` en `javascript:…` venue du dépôt partagé devenait un
   lien qui exécutait du code au clic. On garde http(s), les chemins de l'application, une ancre
   et mailto ; tout le reste devient `#`. `npm run check` exige ce passage pour tout `href`. */
function safeUrl(u) {
  const t = String(u == null ? '' : u).trim();
  if (/^https?:\/\//i.test(t) || /^\/(?!\/)/.test(t) || /^#/.test(t) || /^mailto:/i.test(t)) return t;
  return '#';
}
/* Une IMAGE : en plus, les `data:image/…` (une capture collée) et les `blob:` (un aperçu local). */
function safeImg(u) {
  const t = String(u == null ? '' : u).trim();
  if (/^data:image\/(png|jpe?g|gif|webp|bmp);/i.test(t) || /^blob:/i.test(t)) return t;
  return safeUrl(t);
}

function esc(s) {
  // échappe pour contexte contenu ET attribut (guillemets inclus)
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Lien vers le ticket Jira (si une URL Jira est configurée et une clé détectée).
function ticketLink(url, key) {
  if (!url || !key) return '';
  return ` · <a href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer" title="${esc(tr('mr.link.ticket-title'))}">${svgIco('tag')} ${esc(key)} ↗</a>`;
}

/* Les liens sortants (ticket, forge) ont leur PROPRE ligne. Dans la ligne d'identité, ils
   arrivaient après le projet, l'auteur et la date : celle-ci est tronquée à la largeur de la
   carte, et c'est donc exactement eux qui disparaissaient derrière les points de suspension —
   d'autant plus sûrement que le chemin du projet est long. Sur leur ligne, ils passent à la
   ligne au lieu d'être coupés. Rien n'est rendu quand il n'y a aucun lien : une carte sans
   ticket ne doit pas payer une ligne vide. */
function mrLinks(m) {
  const liens = [];
  if (m.ticket_url && m.ticket_key) {
    liens.push(`<a href="${esc(safeUrl(m.ticket_url))}" target="_blank" rel="noopener noreferrer" title="${esc(tr('mr.link.ticket-title'))}">`
      + `${svgIco('tag')} ${esc(m.ticket_key)} ↗</a>`);
  }
  if (m.web_url) {
    liens.push(`<a href="${esc(safeUrl(m.web_url))}" target="_blank" rel="noopener noreferrer" title="${esc(tr('mr.link.forge-title', { forge: forgeLabel(m.forge) }))}">`
      + `${svgIco('merge')} ${forgeLabel(m.forge)} ↗</a>`);
  }
  return liens.length ? `<div class="meta links">${liens.join('')}</div>` : '';
}

// Date courte lisible (JJ/MM/AAAA) à partir d'un ISO GitLab.
// Séparateur de milliers, partagé par les cartes du tableau de bord.
const fmtNum = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// Nom de la forge d'une ligne, pour les libellés de lien (« GitLab ↗ » / « GitHub ↗ »).
function forgeLabel(forge) { return forge === 'github' ? 'GitHub' : 'GitLab'; }
