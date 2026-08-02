'use strict';
/* Client Jira Cloud minimal + convertisseur ADF → Markdown (ideas.md « Fetch Jira »).

   Auth : Basic base64(email:token). API REST v3.
   La description v3 est en ATLASSIAN DOCUMENT FORMAT — un arbre JSON, pas du texte.
   On le convertit en Markdown lisible : la cible est un PROMPT D'IA, pas un rendu
   pixel, donc « lisible et structuré » suffit. Tout nœud inconnu : on descend dans
   son contenu et on garde le texte (jamais de perte sèche). */

const https = require('https');
const http = require('http');

// Client HTTP autonome (Jira Cloud est en TLS public : pas d'agent CA self-signed).
function request(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      method, hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, statusText: res.statusMessage || '', body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout Jira (15 s)')); });
    if (body != null) req.write(body);
    req.end();
  });
}

/* ---------- Convertisseur ADF → Markdown ---------- */

// Applique les marks d'un nœud texte (gras, italique, code, lien) autour du texte.
function applyMarks(text, marks) {
  let s = text;
  for (const m of marks || []) {
    if (m.type === 'strong') s = `**${s}**`;
    else if (m.type === 'em') s = `_${s}_`;
    else if (m.type === 'code') s = `\`${s}\``;
    else if (m.type === 'strike') s = `~~${s}~~`;
    else if (m.type === 'link' && m.attrs && m.attrs.href) {
      // Défense en profondeur : le contenu Jira est EXTERNE. On ne propage qu'un
      // href http(s)/mailto ; toute autre URL (javascript:, data:…) est écartée et
      // le texte reste en clair. Le rendu (mdToHtml) est déjà sûr (échappe + n'émet
      // aucune ancre), mais ce texte est aussi stocké et injecté dans le prompt IA.
      s = /^(https?:|mailto:)/i.test(m.attrs.href) ? `[${s}](${m.attrs.href})` : s;
    }
  }
  return s;
}

// Concatène le rendu inline des enfants (texte + marks, sauts de ligne).
function inline(nodes) {
  return (nodes || []).map((n) => {
    if (n.type === 'text') return applyMarks(n.text || '', n.marks);
    if (n.type === 'hardBreak') return '\n';
    if (n.type === 'mention') return `@${(n.attrs && (n.attrs.text || n.attrs.displayName)) || ''}`.replace(/^@@/, '@');
    if (n.type === 'emoji') return (n.attrs && (n.attrs.text || n.attrs.shortName)) || '';
    if (n.type === 'inlineCard' && n.attrs && n.attrs.url) return n.attrs.url;
    // nœud inline inconnu : on tente son contenu, sinon rien.
    return n.content ? inline(n.content) : '';
  }).join('');
}

// Rend un bloc et ses enfants. `depth` sert à l'indentation des listes imbriquées.
function block(node, depth = 0) {
  if (!node) return '';
  const kids = node.content || [];
  switch (node.type) {
    case 'doc':
      return kids.map((k) => block(k, depth)).filter((s) => s !== '').join('\n\n');
    case 'paragraph':
      return inline(kids);
    case 'heading': {
      const lvl = Math.min(6, (node.attrs && node.attrs.level) || 1);
      return `${'#'.repeat(lvl)} ${inline(kids)}`;
    }
    case 'blockquote':
      return kids.map((k) => block(k, depth)).join('\n\n').split('\n').map((l) => `> ${l}`).join('\n');
    case 'bulletList':
    case 'orderedList': {
      const ordered = node.type === 'orderedList';
      return kids.map((li, i) => {
        const marker = ordered ? `${i + 1}.` : '-';
        const inner = (li.content || []).map((k) => block(k, depth + 1)).join('\n');
        // 1re ligne préfixée par la puce, lignes suivantes indentées.
        const lines = inner.split('\n');
        const head = `${'  '.repeat(depth)}${marker} ${lines.shift() || ''}`;
        const rest = lines.map((l) => `${'  '.repeat(depth + 1)}${l}`);
        return [head, ...rest].join('\n');
      }).join('\n');
    }
    case 'listItem':
      return kids.map((k) => block(k, depth)).join('\n');
    case 'codeBlock': {
      const lang = (node.attrs && node.attrs.language) || '';
      return `\`\`\`${lang}\n${inline(kids)}\n\`\`\``;
    }
    case 'rule':
      return '---';
    case 'panel':
      // panneau (info/note/warning) : on garde le contenu, préfixé.
      return kids.map((k) => block(k, depth)).join('\n\n');
    case 'table':
      return renderTable(node);
    case 'mediaSingle':
    case 'mediaGroup':
      // Image embarquée : si son nom de fichier correspond à une pièce jointe connue, on émet
      // une image Markdown vers le proxy (rendu inline) ; sinon un placeholder nommé.
      return kids.map((m) => mediaMd(m)).filter(Boolean).join('\n\n') || '_(pièce jointe)_';
    default:
      // nœud bloc inconnu : on descend, on ne perd rien.
      return kids.length ? kids.map((k) => block(k, depth)).join('\n\n') : inline(kids);
  }
}

// Tableau ADF → tableau Markdown (best-effort).
function renderTable(node) {
  const rows = (node.content || []).filter((r) => r.type === 'tableRow');
  if (!rows.length) return '';
  const cells = (row) => (row.content || []).map((c) => inline((c.content || []).flatMap((p) => p.content || [])).replace(/\n/g, ' ').trim());
  const out = [];
  const head = cells(rows[0]);
  out.push(`| ${head.join(' | ')} |`);
  out.push(`| ${head.map(() => '---').join(' | ')} |`);
  for (const r of rows.slice(1)) out.push(`| ${cells(r).join(' | ')} |`);
  return out.join('\n');
}

// Convertit une description ADF (ou une chaîne, ou null) en Markdown.
// Map { filename minuscule → id de pièce jointe } pour résoudre les images embarquées vers le
// proxy de téléchargement. Positionnée le temps d'une conversion (les fonctions block/inline
// sont module-scopées ; on évite de threader le contexte dans toute la récursion).
let _mediaMap = null;
function mediaMd(m) {
  const at = (m && m.attrs) || {};
  const name = at.alt || at.__fileName || at.title || '';
  const id = _mediaMap && name ? _mediaMap[String(name).toLowerCase()] : null;
  if (id) return `![${String(name).replace(/[[\]]/g, '')}](/api/jira/attachment/${id})`;
  return name ? `_${String(name).replace(/[_]/g, ' ')}_` : '_(pièce jointe)_';
}

function adfToMarkdown(adf, opts) {
  if (adf == null) return '';
  if (typeof adf === 'string') return adf.trim();          // v2 / renderedFields déjà texte
  _mediaMap = (opts && opts.attachments) || null;
  try { return block(adf).replace(/\n{3,}/g, '\n\n').trim(); }
  catch { return ''; }                                     // ADF biscornu : on n'échoue jamais
  finally { _mediaMap = null; }
}

/* ---------- Récupération d'un ticket ---------- */

// Déduit la clé de ticket (ex. PROJ-21977) : d'abord entre crochets dans le titre,
// sinon depuis la branche source. Partagé par discover et server.
function ticketKey(title, branch) {
  let m = /\[([A-Za-z]+-\d+)\]/.exec(title || '');
  if (m) return m[1].toUpperCase();
  m = /([A-Za-z]+-\d+)/.exec(branch || '');
  return m ? m[1].toUpperCase() : null;
}

function isConfigured(cfg) {
  return !!(cfg && cfg.jira_url && cfg.jira_email && cfg.jira_token);
}

function authHeader(cfg) {
  const b64 = Buffer.from(`${cfg.jira_email}:${cfg.jira_token}`).toString('base64');
  return `Basic ${b64}`;
}

/* Récupère summary + description d'un ticket. Renvoie { summary, descriptionMd, key }.
   Lève une erreur claire sur 401/403/404 pour que l'appelant la stocke/affiche. */
async function fetchIssue(cfg, key) {
  if (!isConfigured(cfg)) throw new Error('Jira non configuré (URL, email, token requis).');
  const base = String(cfg.jira_url).trim().replace(/\/+$/, '');
  const url = `${base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description`;
  const res = await request(url, {
    headers: { Authorization: authHeader(cfg), Accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) throw new Error(`Jira ${res.status} : accès refusé (email/token ?)`);
  if (res.status === 404) throw new Error(`Jira 404 : ticket ${key} introuvable`);
  if (res.status < 200 || res.status >= 300) throw new Error(`Jira ${res.status} ${res.statusText}`);
  let data;
  try { data = JSON.parse(res.body); } catch { throw new Error('Jira : réponse non-JSON'); }
  const fields = data.fields || {};
  return {
    key: data.key || key,
    summary: fields.summary || '',
    descriptionMd: adfToMarkdown(fields.description),
  };
}

// Bloc de contexte prêt à stocker : titre + description.
function issueToContext(issue) {
  const parts = [];
  if (issue.summary) parts.push(`# ${issue.summary}`);
  if (issue.descriptionMd) parts.push(issue.descriptionMd);
  return parts.join('\n\n').trim();
}

/* ---------- Onglet Jira : tickets qui me sont affectés ---------- */

const jiraBase = (cfg) => String(cfg.jira_url).trim().replace(/\/+$/, '');
const issueUrl = (cfg, key) => `${jiraBase(cfg)}/browse/${encodeURIComponent(key)}`;

// GET JSON authentifié, erreurs Jira remontées en clair (401/403 = auth, autres = status).
/* Jira explique ses refus dans le CORPS de la réponse (`errorMessages`) : « The JQL query is
   unbounded », « Field 'sprint' does not exist »… On les jetait, et l'utilisateur ne lisait que
   « Jira 400 Bad Request » — de quoi ne rien pouvoir faire. */
function detailErreur(body) {
  try {
    const d = JSON.parse(body || '{}');
    const msgs = [...(d.errorMessages || []), ...Object.values(d.errors || {})].filter(Boolean);
    return msgs.length ? ` : ${msgs.join(' · ').slice(0, 300)}` : '';
  } catch { return body ? ` : ${String(body).slice(0, 200)}` : ''; }
}

async function jiraGet(cfg, pathAndQuery) {
  const res = await request(jiraBase(cfg) + pathAndQuery, {
    headers: { Authorization: authHeader(cfg), Accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) throw new Error(`Jira ${res.status} : accès refusé (email/token ?)`);
  if (res.status === 404) throw new Error('Jira 404 : ressource introuvable');
  if (res.status < 200 || res.status >= 300) throw new Error(`Jira ${res.status} ${res.statusText}${detailErreur(res.body)}`);
  try { return JSON.parse(res.body); } catch { throw new Error('Jira : réponse non-JSON'); }
}

const personOf = (p) => (p ? {
  accountId: p.accountId || p.name || p.key || '', name: p.displayName || p.name || '',
  email: p.emailAddress || '', avatar: (p.avatarUrls && (p.avatarUrls['24x24'] || p.avatarUrls['32x32'])) || '',
} : null);

// Recherche JQL partagée : Jira Cloud a retiré `/search` (410) → on tente `/search/jql`
// (enhanced), repli sur `/search` si 404 (Server/DC). Max 100 (page Jira).
async function runSearch(cfg, jql, fields, max = 50) {
  const n = Math.min(Math.max(1, max), 100);
  const qs = `jql=${encodeURIComponent(jql)}&maxResults=${n}&fields=${encodeURIComponent(fields)}`;
  try { return await jiraGet(cfg, `/rest/api/3/search/jql?${qs}`); }
  catch (e) { if (/Jira 404/.test(e.message)) return jiraGet(cfg, `/rest/api/3/search?${qs}`); throw e; }
}

// Métadonnées d'un ticket depuis l'objet issue (partagé liste + détail).
function issueMeta(data, perso = []) {
  const f = data.fields || {};
  const person = personOf;
  return {
    key: data.key,
    summary: f.summary || '',
    status: f.status ? f.status.name : '',
    statusCategory: f.status && f.status.statusCategory ? f.status.statusCategory.key : '', // new | indeterminate | done
    priority: f.priority ? f.priority.name : '',
    type: f.issuetype ? f.issuetype.name : '',
    typeIcon: f.issuetype ? f.issuetype.iconUrl : '',
    assignee: person(f.assignee),
    reporter: person(f.reporter),
    labels: f.labels || [],
    project: f.project ? `${f.project.key}${f.project.name ? ` — ${f.project.name}` : ''}` : '',
    created: f.created || '',
    updated: f.updated || '',
    duedate: f.duedate || '',
    components: (f.components || []).map((c) => c.name),
    fixVersions: (f.fixVersions || []).map((v) => v.name),
    epic: epicOf(f),
    // { customfield_10020: [{ v, l }] } — vide si le champ n'a pas été demandé.
    custom: Object.fromEntries((perso || []).map((id) => [id, valeursPerso(f[id])])),
  };
}

/* Epic d'un ticket. Jira Cloud a unifié la hiérarchie : le lien vers l'epic passe par le champ
   `parent`, y compris pour les projets d'équipe. Mais `parent` sert AUSSI aux sous-tâches, dont
   le parent est une story — l'annoncer comme epic serait faux. On ne retient donc que les
   parents dont le type est bien un epic : `hierarchyLevel` quand Jira le donne (1 = epic),
   sinon le nom du type, seule information disponible sur les instances plus anciennes. */
/* Ajoute les URL Jira à un ticket : la sienne, et celle de son epic. Regroupé ici parce que
   `issueMeta` ne connaît pas la config — les trois appelants oubliaient sinon l'un ou l'autre. */
function withUrls(cfg, meta) {
  const out = { ...meta, url: issueUrl(cfg, meta.key) };
  if (out.epic) out.epic = { ...out.epic, url: issueUrl(cfg, out.epic.key) };
  return out;
}

function epicOf(f) {
  const p = f && f.parent;
  if (!p || !p.key) return null;
  const t = (p.fields && p.fields.issuetype) || {};
  // Le nom du type est LOCALISÉ (Epic, Épique, Épopée…) : on retire les accents avant de comparer,
  // sinon « Épique » ne correspond à rien et l'epic disparaît sur une instance en français.
  const sansAccent = String(t.name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const estEpic = t.hierarchyLevel != null ? Number(t.hierarchyLevel) >= 1 : /(epic|epique|epopee)/.test(sansAccent);
  if (!estEpic) return null;
  return {
    key: p.key,
    summary: (p.fields && p.fields.summary) || '',
    color: (p.fields && p.fields.color && p.fields.color.key) || '',
  };
}

const TICKET_FIELDS = 'summary,status,priority,issuetype,assignee,reporter,created,updated,labels,project,duedate,parent';

/* ---------- Champs personnalisés (sprint, espace, équipe…) --------------------
   Leur identifiant (`customfield_10020`) CHANGE d'une instance à l'autre : le coder en dur
   marcherait chez l'un et pas chez l'autre. On interroge donc l'instance, et l'utilisateur
   choisit dans SES champs.

   `customfield_\d+` est la seule forme acceptée : cet identifiant part dans la requête `fields`
   de l'API, il ne doit pas pouvoir y injecter autre chose. */
const CHAMP_PERSO = /^customfield_\d+$/;
const champPersoValide = (id) => CHAMP_PERSO.test(String(id || ''));

/* Types de champs sur lesquels filtrer a un sens : on veut des valeurs qui SE RÉPÈTENT d'un
   ticket à l'autre. Un champ texte libre ou une date donnerait autant de valeurs que de
   tickets — une liste déroulante inutilisable. */
const TYPES_FILTRABLES = new Set(['option', 'array', 'user', 'version', 'component', 'priority',
  'resolution', 'group', 'project', 'issuetype', 'status', 'securitylevel', 'number']);

// Champs de l'instance utilisables comme filtre, triés par nom.
async function listFields(cfg) {
  if (!isConfigured(cfg)) throw new Error('Jira non configuré (URL, email, token requis).');
  const data = await jiraGet(cfg, '/rest/api/3/field');
  return (Array.isArray(data) ? data : [])
    .filter((f) => f && f.custom && champPersoValide(f.id))
    .filter((f) => TYPES_FILTRABLES.has((f.schema && f.schema.type) || ''))
    .map((f) => ({ id: f.id, name: f.name || f.id, type: (f.schema && f.schema.type) || '' }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/* Valeurs d'un champ personnalisé, ramenées à des couples { v, l }. Jira y met de tout : une
   chaîne, un nombre, un objet { value } (liste de choix), { name } (sprint, version, équipe),
   { displayName } (personne), ou un tableau de ces choses. On accepte les quatre plutôt que
   d'en privilégier une : le champ « sprint » de l'un est le champ « équipe » de l'autre. */
function valeursPerso(brut) {
  const un = (x) => {
    if (x == null) return null;
    if (typeof x === 'string' || typeof x === 'number') return { v: String(x), l: String(x) };
    const l = x.value || x.name || x.displayName || x.key || null;
    return l ? { v: String(x.id != null ? x.id : l), l: String(l) } : null;
  };
  return (Array.isArray(brut) ? brut : [brut]).map(un).filter(Boolean);
}

// Identité de l'utilisateur courant (pour cocher « moi » par défaut dans le filtre par assigné).
async function myself(cfg) {
  const data = await jiraGet(cfg, '/rest/api/3/myself');
  return personOf(data) || { accountId: '', name: 'Moi', email: '', avatar: '' };
}

// Découvre les personnes ASSIGNÉES récemment (pour proposer les cases du filtre par assigné) :
// pool des tickets assignés les plus récemment mis à jour → assignés distincts, « moi » en tête.
async function listAssignees(cfg) {
  if (!isConfigured(cfg)) throw new Error('Jira non configuré (URL, email, token requis).');
  const me = await myself(cfg).catch(() => ({ accountId: '', name: 'Moi', email: '', avatar: '' }));
  const byId = new Map();
  try {
    const data = await runSearch(cfg, 'assignee IS NOT EMPTY ORDER BY updated DESC', 'assignee', 100);
    for (const i of (data.issues || [])) {
      const p = personOf(i.fields && i.fields.assignee);
      if (p && p.accountId && !byId.has(p.accountId)) byId.set(p.accountId, p);
    }
  } catch { /* pas de découverte → au moins « moi » */ }
  if (me.accountId && !byId.has(me.accountId)) byId.set(me.accountId, me);
  const people = [...byId.values()].sort((a, b) => (a.accountId === me.accountId ? -1 : b.accountId === me.accountId ? 1 : a.name.localeCompare(b.name)));
  return { me, people };
}

// Tickets assignés aux personnes demandées (accountIds). Vide → `assignee = currentUser()` (moi).
// Écarte les terminés sauf `includeDone`. Triés du plus récemment mis à jour au plus ancien.
async function searchByAssignees(cfg, { accountIds = [], includeDone = false, max = 100, extra = [] } = {}) {
  if (!isConfigured(cfg)) throw new Error('Jira non configuré (URL, email, token requis).');
  // accountId Jira : alphanumérique + `:._@|-`. On rejette le reste (anti-injection JQL) et on quote.
  const ids = (accountIds || []).map(String).filter((s) => /^[A-Za-z0-9:._@|-]{1,128}$/.test(s));
  /* Sélection VIDE = aucune contrainte d'assigné : on prend tout ce que le compte voit, même
     ce qui n'est affecté à personne ou à quelqu'un d'autre. Retomber sur `currentUser()`
     revenait à ignorer ce que l'utilisateur venait de demander en décochant tout le monde. */
  const clauses = [];
  if (ids.length) clauses.push(`assignee IN (${ids.map((id) => `"${id}"`).join(', ')})`);
  if (!includeDone) clauses.push('statusCategory != Done');
  /* Jira Cloud REFUSE une recherche sans aucune contrainte (« unbounded ») : personne de coché
     ET les terminés inclus donnerait un simple ORDER BY, rejeté en 400. On borne alors sur
     l'activité récente — sans effet visible, la liste étant de toute façon triée par date de
     mise à jour et plafonnée à cent résultats. */
  if (!clauses.length) clauses.push('updated >= -365d');
  const jql = `${clauses.join(' AND ')} ORDER BY updated DESC`;
  // Champs personnalisés demandés par le filtre : réclamés en plus, jamais à la place.
  const perso = [...new Set((extra || []).map(String).filter(champPersoValide))];
  const data = await runSearch(cfg, jql, [TICKET_FIELDS, ...perso].join(','), max);
  const issues = (data.issues || []).map((i) => withUrls(cfg, issueMeta(i, perso)));
  return { issues, total: data.total != null ? data.total : issues.length };
}

/* Clé de ticket Jira : PROJET-123. Tout ce qui n'a pas cette forme est refusé avant de
   toucher au JQL — une clé vient de l'utilisateur, elle ne doit jamais s'y injecter. */
const CLE_VALIDE = /^[A-Z][A-Z0-9]{0,20}-[1-9][0-9]{0,9}$/;
const cleValide = (k) => CLE_VALIDE.test(String(k || '').trim().toUpperCase());

/* État courant d'une liste de tickets, en UN appel. Sert à la surveillance : comparer
   l'état renvoyé au dernier état connu. Les clés introuvables sont simplement absentes
   du résultat — l'appelant en déduit ce qu'il veut (ticket supprimé, droits perdus). */
async function statusOfKeys(cfg, keys) {
  if (!isConfigured(cfg)) throw new Error('Jira non configuré (URL, email, token requis).');
  const propres = [...new Set((keys || []).map((k) => String(k).trim().toUpperCase()).filter(cleValide))];
  if (!propres.length) return [];
  const issues = [];
  // Par paquets : une JQL `key in (...)` de 300 clés serait refusée par Jira.
  for (let i = 0; i < propres.length; i += 50) {
    const lot = propres.slice(i, i + 50);
    const data = await runSearch(cfg, `key IN (${lot.join(', ')})`, TICKET_FIELDS, lot.length);
    for (const it of (data.issues || [])) issues.push(withUrls(cfg, issueMeta(it)));
  }
  return issues;
}

/* Combien de tickets me sont affectés ET en cours. « En cours » = catégorie de statut
   `indeterminate` côté Jira : c'est la seule définition qui traverse les workflows, les
   noms d'états étant libres d'un projet à l'autre. */
async function countMineInProgress(cfg) {
  if (!isConfigured(cfg)) throw new Error('Jira non configuré (URL, email, token requis).');
  const data = await runSearch(cfg, 'assignee = currentUser() AND statusCategory = "In Progress"', 'summary', 1);
  return data.total != null ? data.total : (data.issues || []).length;
}

// Détail complet d'un ticket : métadonnées + description (ADF→Markdown) + commentaires (idem)
// + pièces jointes (métadonnées seulement ; le CONTENU se télécharge à la demande via le proxy).
async function issueDetail(cfg, key) {
  if (!isConfigured(cfg)) throw new Error('Jira non configuré (URL, email, token requis).');
  const fields = 'summary,description,status,priority,issuetype,assignee,reporter,created,updated,labels,project,duedate,components,fixVersions,attachment,parent';
  const data = await jiraGet(cfg, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fields)}`);
  const attachments = ((data.fields || {}).attachment || []).map((a) => ({
    id: String(a.id), filename: a.filename || `pièce-${a.id}`, size: a.size || 0,
    mimeType: a.mimeType || '', created: a.created || '', author: a.author ? (a.author.displayName || a.author.name || '') : '',
  }));
  // Map nom→id : sert à résoudre les images EMBARQUÉES (description ET commentaires) vers le proxy.
  const attMap = {};
  for (const a of attachments) attMap[a.filename.toLowerCase()] = a.id;
  const mdOpts = { attachments: attMap };
  let comments = [];
  try {
    const c = await jiraGet(cfg, `/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=100&orderBy=created`);
    comments = (c.comments || []).map((cm) => ({
      author: cm.author ? (cm.author.displayName || cm.author.name || '') : '',
      created: cm.created || '',
      bodyMd: adfToMarkdown(cm.body, mdOpts),
    }));
  } catch { comments = []; } // les commentaires ne doivent pas faire échouer le détail
  let trans = [];
  try { trans = await transitions(cfg, key); } catch { trans = []; } // droits insuffisants → pas de changement d'état proposé
  return { ...withUrls(cfg, issueMeta(data)), descriptionMd: adfToMarkdown((data.fields || {}).description, mdOpts), comments, attachments, transitions: trans };
}

// Texte brut → ADF minimal (Jira v3 exige l'ADF pour créer un commentaire). Les lignes vides
// séparent des paragraphes ; les retours simples deviennent des sauts de ligne (hardBreak).
function textToAdf(text) {
  const paras = String(text).replace(/\r/g, '').split(/\n{2,}/).map((s) => s.replace(/^\n+|\n+$/g, '')).filter((s) => s.length);
  const content = (paras.length ? paras : ['']).map((blk) => {
    const nodes = [];
    blk.split('\n').forEach((line, i) => { if (i) nodes.push({ type: 'hardBreak' }); if (line) nodes.push({ type: 'text', text: line }); });
    return { type: 'paragraph', content: nodes };
  });
  return { type: 'doc', version: 1, content };
}

// Poste un commentaire (texte) sur un ticket. Renvoie le commentaire créé (mappé comme les autres).
async function addComment(cfg, key, text) {
  if (!isConfigured(cfg)) throw new Error('Jira non configuré (URL, email, token requis).');
  const t = String(text || '').trim();
  if (!t) throw new Error('Commentaire vide.');
  const res = await request(jiraBase(cfg) + `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    method: 'POST',
    headers: { Authorization: authHeader(cfg), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: textToAdf(t) }),
  });
  if (res.status === 401 || res.status === 403) throw new Error(`Jira ${res.status} : commentaire refusé (droits ?)`);
  if (res.status < 200 || res.status >= 300) throw new Error(`Jira ${res.status} ${res.statusText}${res.body ? ` : ${res.body.slice(0, 200)}` : ''}`);
  let data = {}; try { data = JSON.parse(res.body); } catch { /* corps vide */ }
  return {
    author: data.author ? (data.author.displayName || data.author.name || '') : '',
    created: data.created || new Date().toISOString(),
    bodyMd: adfToMarkdown(data.body) || t,
  };
}

// Transitions POSSIBLES du ticket (= les changements d'état autorisés pour l'utilisateur) :
// chaque transition a un id, un nom (l'action) et l'état cible.
async function transitions(cfg, key) {
  const data = await jiraGet(cfg, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  return (data.transitions || []).map((tr) => ({
    id: String(tr.id),
    name: tr.name || '',
    to: tr.to ? { name: tr.to.name || '', statusCategory: tr.to.statusCategory ? tr.to.statusCategory.key : '' } : null,
  }));
}

// Applique une transition (change l'état du ticket). Renvoie 204 sans corps en cas de succès.
async function transitionIssue(cfg, key, transitionId) {
  if (!isConfigured(cfg)) throw new Error('Jira non configuré (URL, email, token requis).');
  const id = String(transitionId || '');
  if (!/^\d+$/.test(id)) throw new Error('Transition invalide.');
  const res = await request(jiraBase(cfg) + `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    headers: { Authorization: authHeader(cfg), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ transition: { id } }),
  });
  if (res.status === 401 || res.status === 403) throw new Error(`Jira ${res.status} : changement d'état refusé (droits ?)`);
  if (res.status < 200 || res.status >= 300) throw new Error(`Jira ${res.status} ${res.statusText}${res.body ? ` : ${res.body.slice(0, 200)}` : ''}`);
  return { ok: true };
}

/* Requête BINAIRE (pièce jointe) : suit les redirections (le endpoint de contenu Jira renvoie
   un 302 vers un média signé Atlassian) en RETIRANT l'auth sur un autre hôte (on ne fuite pas
   le token vers l'URL signée). Bufferisé, borné en taille (les pièces jointes sont modestes). */
function requestBinary(url, headers, { maxBytes = 25 * 1024 * 1024, redirects = 4 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      method: 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, headers,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        const loc = new URL(res.headers.location, url);
        const nextHeaders = loc.hostname === u.hostname ? headers : { Accept: '*/*' }; // pas d'auth hors hôte Jira
        resolve(requestBinary(loc.toString(), nextHeaders, { maxBytes, redirects: redirects - 1 }));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); reject(new Error(`Jira ${res.statusCode} : téléchargement refusé`)); return; }
      const chunks = []; let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); reject(new Error('Pièce jointe trop volumineuse (max 25 Mo)')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ contentType: res.headers['content-type'] || 'application/octet-stream', buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout Jira (30 s)')));
    req.end();
  });
}

// Télécharge UNE pièce jointe (à la demande). L'ID est numérique ; l'URL est construite sur la
// base Jira CONFIGURÉE (jamais fournie par le client) → pas de SSRF depuis l'écran.
async function downloadAttachment(cfg, id) {
  if (!isConfigured(cfg)) throw new Error('Jira non configuré (URL, email, token requis).');
  if (!/^\d+$/.test(String(id))) throw new Error('Identifiant de pièce jointe invalide.');
  const meta = await jiraGet(cfg, `/rest/api/3/attachment/${encodeURIComponent(id)}`);
  const url = `${jiraBase(cfg)}/rest/api/3/attachment/content/${encodeURIComponent(id)}`;
  const bin = await requestBinary(url, { Authorization: authHeader(cfg), Accept: '*/*' });
  return { filename: meta.filename || `piece-${id}`, mimeType: meta.mimeType || bin.contentType, buffer: bin.buffer };
}

module.exports = { isConfigured, statusOfKeys, listFields, champPersoValide, countMineInProgress, cleValide, fetchIssue, issueToContext, adfToMarkdown, ticketKey, listAssignees, searchByAssignees, myself, issueDetail, issueUrl, downloadAttachment, transitions, transitionIssue, addComment };
