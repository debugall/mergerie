'use strict';
/* LE PLAN D'UN LOT DE TICKETS (Jira → Plans) — le contexte, le prompt, les blocs de réponse, le
 * commentaire.
 *
 * Une epic ou une liste de tickets, des pages Confluence, des dépôts lus chacun sur sa branche, un
 * complément, des pièces jointes : l'IA rend l'ORDRE dans lequel réaliser les tickets (et pourquoi),
 * la SPÉCIFICATION FONCTIONNELLE du lot, ce qui MANQUE à chacun pour être réalisable, et les tickets
 * qu'il FAUDRAIT créer. Chaque sortie a sa sorte de bloc au nonce du run — `<<<ORDRE>>>`,
 * `<<<FONCTIONNEL>>>`, `<<<COMPLEMENT clé>>>`, `<<<NOUVEAU réf>>>` — plus une synthèse, que l'écran
 * présente chacune à sa façon.
 *
 * Tout ce qui vient de Jira ou de Confluence est une DONNÉE (`nonFiable`), jamais une consigne. Le
 * libellé et l'état d'un ticket, dans le tableau de l'ordre, viennent de Jira et non de l'IA : elle
 * ne rend que la place et la raison. */
const crypto = require('node:crypto');
const { t } = require('../core/i18n');
const { nonFiable, nonceRun } = require('../core/nonfiable');
const jira = require('./jira');
const confluence = require('./confluence');

const MAX_TICKETS = 60;
const MAX_COMMENTAIRES = 8;
const MAX_DESCRIPTION = 4000;
const CLE = /^[A-Z][A-Z0-9]+-\d+$/;
const NOUVEAU = /^NOUVEAU-\d+$/;

/* L'AVANCEMENT, selon la catégorie de statut Jira (pas son nom, libre d'un workflow à l'autre) : un
   ticket terminé est acquis — hors de l'ordre, ses dépendances satisfaites ; un ticket en cours est
   entamé — il garde sa place en tête sauf blocage, et ce qui lui manque porte sur ce qui reste. */
const avancement = (tk) => {
  const c = tk && tk.statusCategory;
  return c === 'done' ? 'done' : c === 'indeterminate' ? 'started' : 'todo';
};
/** Les clés que l'IA doit ordonner : celles du plan, moins les tickets déjà terminés. */
const clesAOrdonner = (tickets, cles) => {
  const finis = new Set((tickets || []).filter((x) => avancement(x) === 'done').map((x) => x.key));
  return (cles || []).filter((k) => !finis.has(k));
};

/** Des clés saisies (virgules, espaces, retours) → la liste propre, sans doublon, dans l'ordre. */
function normaliserCles(brut) {
  const liste = Array.isArray(brut) ? brut : String(brut || '').split(/[\s,;]+/);
  return [...new Set(liste.map((k) => String(k || '').trim().toUpperCase()).filter((k) => CLE.test(k)))];
}

/** Ce que coûtera la préparation, en appels : une recherche par tranche de cent tickets, un appel
    par ticket si l'on veut ses commentaires, un par page Confluence. */
function budget({ nTickets, nPages, includeComments }) {
  const recherche = Math.ceil(Math.max(0, nTickets) / 100);
  return { jira: recherche + (includeComments ? nTickets : 0), confluence: nPages };
}

/* ---------- Le contexte ---------- */
async function assembler(cfg, { keys, confluenceUrls = [], includeComments = false }) {
  const lus = await jira.issuesByKeys(cfg, keys);
  const parCle = new Map(lus.map((x) => [x.key, x]));
  const tickets = keys.map((k) => parCle.get(k)).filter(Boolean);
  const manquants = keys.filter((k) => !parCle.has(k));
  if (includeComments) {
    for (const tk of tickets) {
      try { tk.comments = (await jira.listComments(cfg, tk.key, { max: MAX_COMMENTAIRES })).slice(-MAX_COMMENTAIRES); }
      catch (e) { tk.commentsError = e.message; }
    }
  }
  const pages = await confluence.lirePages(cfg, confluenceUrls);
  return { tickets, manquants, pages };
}

/* La photo d'un ticket gardée par le plan : ce que le tableau de l'ordre affiche sans relire Jira, et
   l'empreinte de son contenu (description, commentaires lus) — de quoi dire, à la relecture, qu'il a
   changé sans garder tout son texte. */
const empreinte = (tk) => crypto.createHash('sha1')
  .update(`${String(tk.descriptionMd || '').trim()}\n${(tk.comments || []).map((c) => `${c.id || ''}:${c.bodyMd || ''}`).join('\n')}`)
  .digest('hex').slice(0, 16);
const photoTicket = (tk) => ({
  key: tk.key, summary: tk.summary || '', status: tk.status || '', statusCategory: tk.statusCategory || '',
  type: tk.type || '', url: tk.url || '', digest: empreinte(tk),
});

/* CE QUI A CHANGÉ DANS JIRA entre deux photos : l'état, le libellé, le contenu (une photo sans
   empreinte — d'avant qu'elle existe — ne dit rien du contenu), un ticket devenu illisible ou de
   nouveau lisible. Rend une liste, vide quand rien n'a bougé. */
function changementsJira(avant, apres, manquantsApres = []) {
  const vieux = new Map((avant || []).map((x) => [x.key, x]));
  const out = [];
  for (const n of apres || []) {
    const v = vieux.get(n.key);
    if (!v) { out.push({ key: n.key, kind: 'back' }); continue; }
    if (v.status !== n.status) out.push({ key: n.key, kind: 'status', from: v.status, to: n.status });
    if (v.summary !== n.summary) out.push({ key: n.key, kind: 'summary', from: v.summary, to: n.summary });
    if (v.digest && n.digest && v.digest !== n.digest) out.push({ key: n.key, kind: 'content' });
  }
  for (const k of manquantsApres) if (vieux.has(k)) out.push({ key: k, kind: 'missing' });
  return out;
}
/* La photo d'une page Confluence : titre, taille, erreur de lecture, et l'empreinte de son texte. */
const photoPage = (pg) => ({
  url: pg.url, title: pg.title || '', chars: pg.chars, truncated: pg.truncated, error: pg.error || null,
  digest: pg.error ? '' : crypto.createHash('sha1').update(String(pg.markdown || '')).digest('hex').slice(0, 16),
});
/* CE QUI A CHANGÉ DANS CONFLUENCE, page par page (repérée par son URL) : le texte, le titre, une page
   devenue illisible ou de nouveau lisible. `key` nomme la page pour l'humain — son titre, sinon l'URL. */
function changementsConfluence(avant, apres) {
  const vieilles = new Map((avant || []).map((x) => [x.url, x]));
  const out = [];
  for (const n of apres || []) {
    const v = vieilles.get(n.url);
    const key = n.title || (v && v.title) || n.url;
    if (!v) continue;
    if (!v.error && n.error) { out.push({ key, url: n.url, kind: 'page-missing', error: n.error }); continue; }
    if (v.error && !n.error) { out.push({ key, url: n.url, kind: 'page-back' }); continue; }
    if (n.error) continue;
    if (v.title && n.title && v.title !== n.title) out.push({ key, url: n.url, kind: 'page-title', from: v.title, to: n.title });
    if (v.digest && n.digest && v.digest !== n.digest) out.push({ key, url: n.url, kind: 'page-content' });
  }
  return out;
}
/** Les changements en une ligne chacun — ce que la version garde comme « demande », et ce que l'IA lit. */
const texteChangements = (chs) => chs.map((c) => t(`jira.plan.change.${c.kind}`, c)).join('\n');

/* ---------- Le prompt ---------- */
function blocTicket(tk) {
  const parts = [`## ${tk.key} — ${tk.summary || ''}`];
  const meta = [tk.type, tk.status ? `${tk.status} (${t(`jira.plan.progress.${avancement(tk)}`)})` : '', tk.priority ? `${t('jira.meta.priority')} : ${tk.priority}` : '',
    tk.epic && tk.epic.key ? `epic ${tk.epic.key}` : ''].filter(Boolean).join(' · ');
  if (meta) parts.push(meta);
  const lies = (tk.related || []).slice(0, 15);
  if (lies.length) parts.push(`${t('jira.plan.prompt.links')} : ${lies.map((r) => `${r.relation} ${r.key}${r.status ? ` (${r.status})` : ''}`).join(' ; ')}`);
  const desc = String(tk.descriptionMd || '').trim();
  parts.push('', desc ? (desc.length > MAX_DESCRIPTION ? `${desc.slice(0, MAX_DESCRIPTION)}\n…` : desc) : `(${t('jira.no-description')})`);
  const coms = tk.comments || [];
  if (coms.length) {
    parts.push('', `### ${t('jira.spec.prompt.comments')}`);
    for (const c of coms) parts.push(`- ${c.author || '?'} (${String(c.created || '').slice(0, 10)}) : ${String(c.bodyMd || '').replace(/\s+/g, ' ').slice(0, 600)}`);
  }
  return parts.join('\n');
}

/** Le texte de la QUESTION posée à l'exploration — ce que l'écran montre et laisse modifier. Le
    lanceur y ajoute ses propres règles (dépôts listés, lecture seule, fichier de sortie, questions). */
function composerPrompt({ tickets, manquants = [], pages = [], complement = '', nonce }) {
  const morceaux = [t('jira.plan.prompt.role', { n: tickets.length, count: tickets.length })];
  morceaux.push(nonFiable(t('jira.plan.prompt.label-tickets'), tickets.map(blocTicket).join('\n\n')));
  const parAvancement = (a) => tickets.filter((x) => avancement(x) === a).map((x) => x.key).join(', ');
  if (parAvancement('done')) morceaux.push(t('jira.plan.prompt.done', { keys: parAvancement('done') }));
  if (parAvancement('started')) morceaux.push(t('jira.plan.prompt.started', { keys: parAvancement('started') }));
  if (manquants.length) morceaux.push(t('jira.plan.prompt.missing', { keys: manquants.join(', ') }));
  for (const p of pages) {
    if (p.error) morceaux.push(t('jira.spec.prompt.page-unread', { url: p.url, error: p.error }));
    else morceaux.push(nonFiable(t('jira.spec.prompt.label-page', { title: p.title || p.url }), `${p.title ? `# ${p.title}\n\n` : ''}${p.markdown}`));
  }
  if (String(complement || '').trim()) morceaux.push(`${t('jira.plan.prompt.complement')}\n${String(complement).trim()}`);
  morceaux.push(t('jira.plan.prompt.task'));
  morceaux.push(t('jira.plan.prompt.format', { nonce }));
  return morceaux.join('\n\n');
}

/** L'instruction d'un SUIVI : le plan courant, la demande, les mêmes blocs en retour. */
function composerSuivi({ markdown, instruction, nonce }) {
  return [
    t('jira.plan.prompt.followup-intro'),
    nonFiable(t('jira.plan.prompt.label-current'), markdown),
    `${t('jira.plan.prompt.followup-instruction')}\n${String(instruction || '').trim()}`,
    t('jira.plan.prompt.format', { nonce }),
  ].join('\n\n');
}

/** L'instruction d'une RELECTURE DES SOURCES : les changements, les tickets et les pages touchés tels
    qu'ils sont maintenant, l'avancement de tout le lot, le plan courant — et le plan complet en retour. */
function composerRelecture({ markdown, changements, tickets, pages = [], nonce }) {
  const touches = new Set(changements.filter((c) => !c.url).map((c) => c.key));
  const pagesTouchees = new Set(changements.filter((c) => c.url && /^page-(content|title|back)$/.test(c.kind)).map((c) => c.url));
  const parAvancement = (a) => tickets.filter((x) => avancement(x) === a).map((x) => x.key).join(', ');
  const morceaux = [t('jira.plan.prompt.refresh-intro')];
  morceaux.push(nonFiable(t('jira.plan.prompt.label-changes'), texteChangements(changements)));
  const relus = tickets.filter((x) => touches.has(x.key));
  if (relus.length) morceaux.push(nonFiable(t('jira.plan.prompt.label-changed-tickets'), relus.map(blocTicket).join('\n\n')));
  for (const p of pages.filter((x) => pagesTouchees.has(x.url) && !x.error)) {
    morceaux.push(nonFiable(t('jira.spec.prompt.label-page', { title: p.title || p.url }), `${p.title ? `# ${p.title}\n\n` : ''}${p.markdown}`));
  }
  if (parAvancement('done')) morceaux.push(t('jira.plan.prompt.done', { keys: parAvancement('done') }));
  if (parAvancement('started')) morceaux.push(t('jira.plan.prompt.started', { keys: parAvancement('started') }));
  morceaux.push(nonFiable(t('jira.plan.prompt.label-current'), markdown));
  morceaux.push(t('jira.plan.prompt.format', { nonce }));
  return morceaux.join('\n\n');
}

/* ---------- Les blocs de réponse ---------- */
const echapper = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* LE DERNIER BLOC D'ORDRE, ET CE QUI LE SUIT. La réponse archivée est précédée de la question, qui
   montre elle-même le gabarit des balises au vrai nonce : on part donc de la DERNIÈRE ouverture
   d'`ORDRE`, et un gabarit recopié se reconnaît à ce qu'aucune ligne n'y nomme un ticket du plan.
   Rend `null` sans ordre exploitable. */
function extraire(texte, nonce, clesConnues) {
  if (!nonce) return null;
  const s = String(texte || '');
  const i = s.lastIndexOf(`<<<ORDRE ${nonce}`);
  if (i === -1) return null;
  const zone = s.slice(i);
  const blocs = (nom) => {
    const re = new RegExp(`<<<${nom} ${echapper(nonce)}[ \\t]*([^\\n]*)\\n([\\s\\S]*?)\\n?[ \\t]*${nom} ${echapper(nonce)}>>>`, 'g');
    const out = [];
    let m;
    while ((m = re.exec(zone))) out.push({ arg: m[1].trim(), corps: m[2].trim() });
    return out;
  };
  const connues = new Set(clesConnues || []);
  const [ordreBrut] = blocs('ORDRE');
  if (!ordreBrut) return null;
  const ordre = [];
  const vues = new Set();
  for (const ligne of ordreBrut.corps.split('\n')) {
    const m = /^\s*(?:\d+[.)]\s*)?([A-Z][A-Z0-9]+-\d+)\s*(?:[|—–:-]+\s*(.*))?$/.exec(ligne.trim());
    if (!m) continue;
    const key = m[1];
    if (vues.has(key) || !(connues.has(key) || NOUVEAU.test(key))) continue;
    vues.add(key);
    ordre.push({ key, raison: String(m[2] || '').trim(), nouveau: NOUVEAU.test(key) });
  }
  if (!ordre.some((x) => !x.nouveau)) return null;
  const complements = {};
  for (const b of blocs('COMPLEMENT')) {
    const key = b.arg.toUpperCase();
    if (connues.has(key) && b.corps && !/^\(?(rien|aucun|none|nothing)\b/i.test(b.corps)) complements[key] = b.corps;
  }
  const nouveaux = [];
  for (const b of blocs('NOUVEAU')) {
    const ref = b.arg.toUpperCase();
    if (!NOUVEAU.test(ref) || nouveaux.some((x) => x.ref === ref)) continue;
    const lignes = b.corps.split('\n');
    const titre = (lignes[0] || '').replace(/^#+\s*|^(titre|title)\s*:\s*/i, '').trim();
    nouveaux.push({ ref, titre: titre || ref, markdown: lignes.slice(1).join('\n').trim() });
  }
  const [synthese] = blocs('SYNTHESE');
  const [fonctionnel] = blocs('FONCTIONNEL');
  // Un ticket à créer cité dans l'ordre sans son bloc reste dans l'ordre : on le nomme par sa référence.
  return { ordre, complements, nouveaux, synthese: synthese ? synthese.corps : '', fonctionnel: fonctionnel ? fonctionnel.corps : '' };
}

/* ---------- Le document ---------- */
/* Les titres d'un texte de l'IA, rangés SOUS la section qui l'accueille (niveau 3 au moins), quel
   que soit le niveau qu'elle a choisi ; un `#` dans un bloc de code n'est pas un titre. */
function sousTitres(md, niveau = 3) {
  const lignes = String(md || '').split('\n');
  let code = false;
  const titres = [];
  lignes.forEach((l, i) => {
    if (/^\s*```/.test(l)) code = !code;
    else if (!code && /^#{1,6}\s/.test(l)) titres.push(i);
  });
  if (!titres.length) return String(md || '');
  const decalage = Math.max(0, niveau - Math.min(...titres.map((i) => /^#+/.exec(lignes[i])[0].length)));
  for (const i of titres) lignes[i] = `${'#'.repeat(Math.min(6, /^#+/.exec(lignes[i])[0].length + decalage))}${lignes[i].replace(/^#+/, '')}`;
  return lignes.join('\n');
}

/* LE PLAN EN MARKDOWN : ce qui est rangé dans chaque version, montré à l'agent pour un suivi, et
   exporté (md, docx, pdf). Le tableau de l'ordre porte le libellé et l'état VENUS DE JIRA. */
function markdownDe({ label, resultat, tickets, date }) {
  const parCle = new Map((tickets || []).map((x) => [x.key, x]));
  const nouveauDe = (ref) => (resultat.nouveaux || []).find((n) => n.ref === ref);
  const cellule = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const lignes = [`# ${t('jira.plan.doc.title', { label })}`, ''];
  if (date) lignes.push(`_${t('jira.plan.doc.meta', { date, n: (tickets || []).length, count: (tickets || []).length })}_`, '');
  lignes.push(`## ${t('jira.plan.doc.order')}`, '');
  lignes.push(`| # | ${t('jira.plan.col.ticket')} | ${t('jira.plan.col.summary')} | ${t('jira.plan.col.status')} | ${t('jira.plan.col.why')} |`, '|---|---|---|---|---|');
  resultat.ordre.forEach((o, i) => {
    const tk = parCle.get(o.key);
    const nv = o.nouveau ? nouveauDe(o.key) : null;
    const libelle = tk ? tk.summary : (nv ? nv.titre : '');
    const etat = tk ? tk.status : t('jira.plan.new-status');
    lignes.push(`| ${i + 1} | ${o.nouveau ? o.key : (tk && tk.url ? `[${o.key}](${tk.url})` : o.key)} | ${cellule(libelle)} | ${cellule(etat)} | ${cellule(o.raison)} |`);
  });
  const places = new Set(resultat.ordre.map((o) => o.key));
  const oublies = (tickets || []).filter((x) => !places.has(x.key) && avancement(x) !== 'done');
  const finis = (tickets || []).filter((x) => !places.has(x.key) && avancement(x) === 'done');
  if (finis.length) lignes.push('', `> ${t('jira.plan.doc.done', { keys: finis.map((x) => `${x.key} (${x.status})`).join(', ') })}`);
  if (oublies.length) lignes.push('', `> ${t('jira.plan.doc.unplaced', { keys: oublies.map((x) => x.key).join(', ') })}`);
  if (resultat.fonctionnel) lignes.push('', `## ${t('jira.plan.doc.functional')}`, '', sousTitres(resultat.fonctionnel));
  const cles = Object.keys(resultat.complements || {});
  if (cles.length) {
    lignes.push('', `## ${t('jira.plan.doc.complements')}`);
    for (const k of resultat.ordre.map((o) => o.key).filter((k) => cles.includes(k)).concat(cles.filter((k) => !places.has(k)))) {
      const tk = parCle.get(k);
      lignes.push('', `### ${k}${tk ? ` — ${tk.summary}` : ''}`, '', resultat.complements[k]);
    }
  }
  if ((resultat.nouveaux || []).length) {
    lignes.push('', `## ${t('jira.plan.doc.new')}`);
    for (const n of resultat.nouveaux) lignes.push('', `### ${n.ref} — ${n.titre}`, '', n.markdown || '');
  }
  if (resultat.synthese) lignes.push('', `## ${t('jira.plan.doc.summary')}`, '', resultat.synthese);
  return `${lignes.join('\n').trim()}\n`;
}

/* ---------- Le commentaire ---------- */
/* La ligne repère : le préfixe (Réglages), le nom du plan, la version, et une étiquette tirée de
   l'uid du plan — c'est elle qui retrouve LE commentaire de CE plan quand l'id mémorisé manque, et
   qui le distingue de la précision technique du même ticket, qui a sa propre ligne. */
const etiquette = (uid) => `plan ${String(uid || '').slice(-6).toLowerCase()}`;
function ligneRepere(marker, label, uid, version) {
  return `${String(marker || '').trim() || t('jira.plan.marker')} — ${label} · v${Number(version) || 1} · ${etiquette(uid)}`;
}
function corpsCommentaire({ marker, label, uid, version, markdown }) {
  return `**${ligneRepere(marker, label, uid, version)}**\n\n${String(markdown || '').trim()}`;
}
/** Parmi les commentaires d'un ticket, le dernier qui porte l'étiquette de CE plan et que ce compte peut éditer. */
function commentaireRepere(comments, uid, monAccountId) {
  const tag = etiquette(uid);
  const miens = (comments || []).filter((c) => {
    const premiere = String(c.bodyMd || '').trim().split('\n')[0].replace(/[*_]+/g, '').trim();
    return c.id && premiere.endsWith(tag) && (!monAccountId || !c.authorId || c.authorId === monAccountId);
  });
  return miens.length ? miens[miens.length - 1] : null;
}

/* ---------- Dry-run ---------- */
/** Ce qu'un agent bien luné rendrait : un ordre (le dernier ticket d'abord, un ticket à créer en
    deuxième place), un complément pour le premier ticket, une spécification fonctionnelle, un
    ticket à créer, une synthèse. */
function sortieDryRun(nonce, cles) {
  const liste = (cles || []).slice().reverse();
  const ordre = liste.map((k, i) => `${i + 1}. ${k} | ${t('jira.plan.dryrun.why', { key: k })}`);
  ordre.splice(1, 0, `${liste.length > 0 ? 2 : 1}. NOUVEAU-1 | ${t('jira.plan.dryrun.why-new')}`);
  const renum = ordre.map((l, i) => l.replace(/^\d+\./, `${i + 1}.`));
  const premier = cles && cles[0];
  return [
    t('jira.plan.dryrun.intro'),
    `<<<ORDRE ${nonce}\n${renum.join('\n')}\nORDRE ${nonce}>>>`,
    premier ? `<<<COMPLEMENT ${nonce} ${premier}\n${t('jira.plan.dryrun.complement', { key: premier })}\nCOMPLEMENT ${nonce}>>>` : '',
    `<<<FONCTIONNEL ${nonce}\n${t('jira.plan.dryrun.functional', { key: premier || '' })}\nFONCTIONNEL ${nonce}>>>`,
    `<<<NOUVEAU ${nonce} NOUVEAU-1\n${t('jira.plan.dryrun.new-title')}\n${t('jira.plan.dryrun.new-body')}\nNOUVEAU ${nonce}>>>`,
    `<<<SYNTHESE ${nonce}\n${t('jira.plan.dryrun.summary')}\nSYNTHESE ${nonce}>>>`,
  ].filter(Boolean).join('\n\n') + '\n';
}

module.exports = {
  MAX_TICKETS, CLE, avancement, clesAOrdonner, normaliserCles, budget, assembler, photoTicket, photoPage, changementsJira, changementsConfluence, texteChangements, composerPrompt, composerSuivi, composerRelecture, extraire, markdownDe,
  ligneRepere, corpsCommentaire, commentaireRepere, etiquette, sortieDryRun, nonceRun,
};
