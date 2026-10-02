'use strict';
/* LECTEUR CONFLUENCE — une page, en Markdown, pour servir de contexte à une précision de ticket.
 *
 * Deux déploiements, un seul contrat :
 *   - Cloud : la page vit sous `{jira_url}/wiki`, et le compte Jira (email + jeton d'API) y a
 *     accès — rien à configurer de plus.
 *   - Server / Data Center : une adresse à part (`confluence_url`) et un jeton personnel
 *     (`confluence_token`, en Bearer).
 * Dans les deux cas, la page est RELUE à chaque analyse : rien de son contenu n'est stocké
 * (droits, fraîcheur) — seulement son titre, sa taille et la date de lecture, pour l'écran.
 *
 * Le corps `storage` est du XHTML. On n'en garde qu'un Markdown minimal : titres, listes,
 * tableaux ligne à ligne, blocs de code des macros. Le reste du balisage tombe. Une page
 * refusée ou injoignable ne fait JAMAIS échouer l'analyse : elle rend une erreur que le prompt
 * et l'écran répètent (« page X non lue : 403 »), et l'analyse continue sans elle. */
const { t } = require('../core/i18n');
const { request } = require('../core/httpreq');

/** Plafond par page : au-delà, le texte est coupé et la coupure est DITE. */
const MAX_CHARS_PAGE = 20000;
/** Plafond par analyse, toutes pages confondues. */
const MAX_PAGES = 5;
const MAX_CHARS_TOTAL = 60000;

const base = (url) => String(url || '').trim().replace(/\/+$/, '');

/** Confluence est joignable si Jira Cloud l'est (même compte) ou si une adresse DC est posée. */
function isConfigured(cfg) {
  if (!cfg) return false;
  if (cfg.confluence_url && cfg.confluence_token) return true;
  return !!(cfg.jira_url && cfg.jira_email && cfg.jira_token);
}

/* L'id d'une page depuis son URL. Formes connues :
   Cloud  : /wiki/spaces/DEV/pages/123456/Titre, /wiki/pages/viewpage.action?pageId=123456
   DC     : /pages/viewpage.action?pageId=123456, /display/DEV/Titre (pas d'id : non résolu) */
function pageIdDe(url) {
  try {
    const u = new URL(String(url || '').trim());
    const q = u.searchParams.get('pageId');
    if (q && /^\d+$/.test(q)) return q;
    const m = /\/pages\/(\d+)(?:\/|$)/.exec(u.pathname);
    return m ? m[1] : null;
  } catch { return null; }
}

/* ---------- XHTML storage → Markdown ---------- */
const decoder = (s) => String(s || '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, '\'').replace(/&amp;/g, '&');
const sansBalises = (s) => decoder(String(s || '').replace(/<[^>]+>/g, ''));

function storageToMarkdown(xhtml) {
  let s = String(xhtml || '').replace(/\r/g, '');
  // Macros de code : le corps CDATA devient un bloc ``` ; les autres macros perdent leur enveloppe.
  s = s.replace(/<ac:structured-macro[^>]*ac:name="(?:code|noformat)"[^>]*>[\s\S]*?<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/g,
    (_, code) => `\n\`\`\`\n${code.trim()}\n\`\`\`\n`);
  s = s.replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/g, '');
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Titres, paragraphes, listes, tableaux.
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, titre) => `\n${'#'.repeat(Number(n))} ${sansBalises(titre).trim()}\n`);
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, item) => `- ${sansBalises(item).replace(/\s+/g, ' ').trim()}\n`);
  s = s.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, ligne) => {
    const cellules = [...ligne.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => sansBalises(m[1]).replace(/\s+/g, ' ').trim());
    return cellules.length ? `| ${cellules.join(' | ')} |\n` : '';
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|blockquote|pre)>/gi, '\n');
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<(code|tt)>([\s\S]*?)<\/\1>/gi, '`$2`');
  s = s.replace(/<a [^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => `[${sansBalises(txt).trim() || href}](${href})`);
  s = sansBalises(s);
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Coupe à `max` caractères, en le disant. */
function tronquer(md, max = MAX_CHARS_PAGE) {
  const texte = String(md || '');
  if (texte.length <= max) return { markdown: texte, truncated: false };
  return { markdown: `${texte.slice(0, max)}\n\n[${t('jira.spec.page-truncated', { n: texte.length - max })}]`, truncated: true };
}

const origineDe = (u) => { try { return new URL(String(u || '').trim()).origin; } catch { return null; } };

/** Les origines auxquelles on accepte d'envoyer des identifiants : le Jira configuré (Cloud) et
    le Confluence Server/DC configuré. Jamais une autre. */
function originesAdmises(cfg) {
  const out = [];
  if (cfg && cfg.confluence_url && cfg.confluence_token) out.push(origineDe(cfg.confluence_url));
  if (cfg && cfg.jira_url && cfg.jira_email && cfg.jira_token) out.push(origineDe(cfg.jira_url));
  return out.filter(Boolean);
}
/** Une URL de page est admise si son origine est l'une des origines configurées. */
const urlAdmise = (cfg, url) => { const o = origineDe(url); return !!o && originesAdmises(cfg).includes(o); };

/* OÙ ET COMMENT LIRE — ET SURTOUT À QUI PARLER. Les identifiants (Basic Jira, Bearer Confluence)
   ne partent QUE vers l'origine configurée : l'URL d'une page vient d'un formulaire, ou d'une spec
   reçue par la synchro d'équipe, et `https://ailleurs.example/wiki/pages/1` recevrait sinon
   l'email et le jeton Jira (et servirait de rebond vers le réseau interne). La racine du wiki
   est donc TOUJOURS dérivée de la configuration, jamais de l'URL de la page ; une page d'une
   autre origine est refusée avant tout appel. */
function cible(cfg, url) {
  const o = origineDe(url);
  if (cfg.confluence_url && cfg.confluence_token && o === origineDe(cfg.confluence_url)) {
    return { racine: base(cfg.confluence_url), headers: { Authorization: `Bearer ${cfg.confluence_token}`, Accept: 'application/json' }, cloud: false };
  }
  if (cfg.jira_url && cfg.jira_email && cfg.jira_token && o === origineDe(cfg.jira_url)) {
    const b64 = Buffer.from(`${cfg.jira_email}:${cfg.jira_token}`).toString('base64');
    return { racine: `${base(cfg.jira_url)}/wiki`, headers: { Authorization: `Basic ${b64}`, Accept: 'application/json' }, cloud: true };
  }
  return null;
}

/** Lit UNE page. Rend toujours un objet : `{ url, id, title, markdown, chars, truncated, fetched_at, error }`. */
async function lirePage(cfg, url) {
  const out = { url: String(url || '').trim(), id: null, title: '', markdown: '', chars: 0, truncated: false, fetched_at: new Date().toISOString(), error: null };
  const id = pageIdDe(out.url);
  if (!id) { out.error = t('jira.spec.page-no-id'); return out; }
  out.id = id;
  if (!isConfigured(cfg)) { out.error = t('jira.spec.page-not-configured'); return out; }
  const c = cible(cfg, out.url);
  if (!c) { out.error = t('jira.spec.page-host'); return out; }
  const { racine, headers, cloud } = c;
  const tentatives = cloud
    ? [`${racine}/api/v2/pages/${id}?body-format=storage`, `${racine}/rest/api/content/${id}?expand=body.storage`]
    : [`${racine}/rest/api/content/${id}?expand=body.storage`];
  let derniere = null;
  for (const u of tentatives) {
    let res;
    try { res = await request(u, { headers }); } catch (e) { derniere = e.message; continue; }
    if (res.status === 404 && tentatives.length > 1 && u === tentatives[0]) { derniere = '404'; continue; }
    if (res.status < 200 || res.status >= 300) { derniere = `${res.status}`; break; }
    let data = {};
    try { data = JSON.parse(res.body); } catch { derniere = t('err.jira.not-json'); break; }
    const corps = (data.body && ((data.body.storage && data.body.storage.value) || (data.body.view && data.body.view.value))) || '';
    out.title = String(data.title || '');
    const brut = storageToMarkdown(corps);
    const { markdown, truncated } = tronquer(brut);
    out.markdown = markdown; out.chars = brut.length; out.truncated = truncated;
    return out;
  }
  out.error = t('jira.spec.page-unread', { status: derniere || '?' });
  return out;
}

/** Lit plusieurs pages, dans l'ordre, en respectant les plafonds. */
async function lirePages(cfg, urls) {
  const liste = [...new Set((urls || []).map((u) => String(u || '').trim()).filter(Boolean))].slice(0, MAX_PAGES);
  const out = [];
  let total = 0;
  for (const url of liste) {
    const p = await lirePage(cfg, url);
    if (total + p.markdown.length > MAX_CHARS_TOTAL) {
      const reste = Math.max(0, MAX_CHARS_TOTAL - total);
      const coupe = tronquer(p.markdown, reste);
      p.markdown = coupe.markdown; p.truncated = p.truncated || coupe.truncated;
    }
    total += p.markdown.length;
    out.push(p);
  }
  return out;
}

module.exports = { isConfigured, pageIdDe, storageToMarkdown, lirePage, lirePages, urlAdmise, originesAdmises, MAX_PAGES, MAX_CHARS_PAGE, MAX_CHARS_TOTAL };
