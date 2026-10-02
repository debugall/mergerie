'use strict';
/* PRÉCISION TECHNIQUE D'UN TICKET — le contexte, le prompt, le bloc de réponse.
 *
 * Un ticket écrit par un PO dit le quoi, jamais le où ni le comment. On assemble ici ce que
 * l'IA doit lire pour combler l'écart — le ticket et ses commentaires, l'epic et ses enfants,
 * des pages Confluence, le complément du développeur — et la consigne qui en fait une
 * PROPOSITION courte, au format imposé, rendue dans un bloc `<<<SPEC nonce … SPEC nonce>>>`.
 *
 * Tout ce qui vient de Jira ou de Confluence est une DONNÉE : enveloppée par `nonFiable`,
 * étiquetée par sa source, jamais lue comme une consigne. Le seul texte hors balise est celui
 * que le développeur a tapé lui-même (le complément) — c'est lui qui parle.
 *
 * Deux sortes de questions, et c'est le point central : celles que seul le DÉVELOPPEUR peut
 * trancher passent par le protocole `<<<QUESTIONS>>>` (la session s'arrête et attend) ; celles
 * que seul le PO sait deviennent une SECTION de la proposition, qui part avec le commentaire.
 * Bloquer la session sur une question au PO serait une impasse : le développeur ne peut pas y
 * répondre. */
const { t } = require('../core/i18n');
const { nonFiable, nonceRun } = require('../core/nonfiable');
const jira = require('./jira');
const confluence = require('./confluence');

/** Les six sections, dans l'ordre imposé. */
const SECTIONS = ['repos', 'existing', 'todo', 'attention', 'out', 'po'];
const MAX_ENFANTS_EPIC = 30;
const CLE = /^[A-Z][A-Z0-9]+-\d+$/;

const cleValide = (k) => CLE.test(String(k || '').trim().toUpperCase());
const normaliserCle = (k) => String(k || '').trim().toUpperCase();

/* ---------- Le bloc de réponse ---------- */
function extraireSpec(text, nonce) {
  if (!nonce) return null;
  const s = String(text || '');
  const debut = `<<<SPEC ${nonce}`;
  const fin = `SPEC ${nonce}>>>`;
  /* LE DERNIER BLOC, PAS LE PREMIER : la réponse archivée est précédée de la question posée,
     qui montre elle-même le gabarit des balises — et un agent qui cite sa consigne avant de
     répondre produirait le même piège. La proposition vient toujours après. */
  const i = s.lastIndexOf(debut);
  if (i === -1) return null;
  const j = s.indexOf(fin, i + debut.length);
  if (j === -1) return null;
  const md = s.slice(i + debut.length, j).replace(/^[^\n]*\n/, (l) => (/^\s*$/.test(l) ? '' : l)).trim();
  return md || null;
}

/* ---------- La ligne repère du commentaire ---------- */
const repereDefaut = () => t('jira.spec.marker');
function ligneRepere(marker, version) {
  return `${String(marker || '').trim() || repereDefaut()} v${Number(version) || 1}`;
}
/** La version annoncée par un commentaire portant la ligne repère ; `null` s'il ne la porte pas. */
function versionDuRepere(texte, marker) {
  const m = String(marker || '').trim() || repereDefaut();
  const premiere = String(texte || '').trim().split('\n')[0].replace(/^[*_#\s]+|[*_\s]+$/g, '');
  if (!premiere.startsWith(m)) return null;
  const v = /v(\d+)\s*$/.exec(premiere);
  return v ? Number(v[1]) : 0;
}

/* ---------- Le ticket au moment de l'analyse ---------- */
function snapshotDe(ticket) {
  return JSON.stringify({ summary: ticket.summary || '', description: ticket.descriptionMd || '', updated: ticket.updated || '' });
}
/** Le ticket a-t-il changé de SENS depuis la photo ? Un changement d'état n'en est pas un. */
function perimee(snapshotJson, ticket) {
  if (!snapshotJson || !ticket) return false;
  let photo; try { photo = JSON.parse(snapshotJson); } catch { return false; }
  const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  return norm(photo.summary) !== norm(ticket.summary) || norm(photo.description) !== norm(ticket.descriptionMd);
}

/* ---------- Le contexte ---------- */
const extrait = (md, lignes = 3) => String(md || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, lignes).join(' ').slice(0, 400);

/** Lit tout ce que l'analyse doit connaître. Chaque source manquante est DITE, jamais fatale —
    sauf le ticket lui-même, sans lequel il n'y a rien à préciser. */
async function assembler(cfg, { ticketKey, includeEpic = true, confluenceUrls = [] }) {
  const cle = normaliserCle(ticketKey);
  const ticket = await jira.issueDetail(cfg, cle);
  let enfants = [];
  let epicErreur = null;
  const epic = ticket.epic || (ticket.type && /epic|epique|epopee/i.test(ticket.type) ? { key: cle, summary: ticket.summary } : null);
  if (includeEpic && epic && epic.key) {
    try { enfants = (await jira.epicChildren(cfg, epic.key)).filter((e) => e.key !== cle).slice(0, MAX_ENFANTS_EPIC); } catch (e) { epicErreur = e.message; }
  }
  const pages = await confluence.lirePages(cfg, confluenceUrls);
  return { ticket, epic, enfants, epicErreur, pages };
}

/* ---------- Le prompt ---------- */
function blocTicket(ticket) {
  const parts = [`# ${ticket.key} — ${ticket.summary || ''}`];
  const meta = [ticket.type, ticket.status, ticket.priority ? `${t('jira.meta.priority')} : ${ticket.priority}` : ''].filter(Boolean).join(' · ');
  if (meta) parts.push(meta);
  parts.push('', ticket.descriptionMd || `(${t('jira.no-description')})`);
  const coms = (ticket.comments || []).slice(-10);
  if (coms.length) {
    parts.push('', `## ${t('jira.spec.prompt.comments')}`);
    for (const c of coms) parts.push(`- ${c.author || '?'} (${c.created || ''}) : ${String(c.bodyMd || '').replace(/\s+/g, ' ').slice(0, 600)}`);
  }
  const lies = (ticket.related || []).slice(0, 10);
  if (lies.length) {
    parts.push('', `## ${t('jira.spec.prompt.related')}`);
    for (const r of lies) parts.push(`- ${r.relation} ${r.key} — ${r.summary || ''} (${r.status || ''})`);
  }
  return parts.join('\n');
}

function blocEpic(epic, enfants) {
  const parts = [`# ${epic.key} — ${epic.summary || ''}`];
  for (const e of enfants) parts.push(`- ${e.key} — ${e.summary || ''} (${e.status || ''})${e.descriptionMd ? ` : ${extrait(e.descriptionMd)}` : ''}`);
  return parts.join('\n');
}

/** Le texte de la QUESTION posée à l'exploration : le lanceur y ajoute ses propres règles
    (lecture seule, fichier de sortie, bloc de questions). */
function composerQuestion({ ticket, epic, enfants, epicErreur, pages, complement, detail, nonce, consignesEquipe }) {
  const synthese = detail !== 'detaille';
  const morceaux = [];
  morceaux.push(t('jira.spec.prompt.role', { key: ticket.key }));
  morceaux.push(nonFiable(t('jira.spec.prompt.label-ticket', { key: ticket.key }), blocTicket(ticket)));
  if (epic && epic.key) {
    if (enfants.length) morceaux.push(t('jira.spec.prompt.epic-intro', { key: epic.key }), nonFiable(t('jira.spec.prompt.label-epic', { key: epic.key }), blocEpic(epic, enfants)));
    else if (epicErreur) morceaux.push(t('jira.spec.prompt.epic-unread', { key: epic.key, error: epicErreur }));
  }
  for (const p of pages || []) {
    if (p.error) morceaux.push(t('jira.spec.prompt.page-unread', { url: p.url, error: p.error }));
    else morceaux.push(nonFiable(t('jira.spec.prompt.label-page', { title: p.title || p.url }), `${p.title ? `# ${p.title}\n\n` : ''}${p.markdown}`));
  }
  if (complement && String(complement).trim()) morceaux.push(`${t('jira.spec.prompt.complement')}\n${String(complement).trim()}`);
  if (consignesEquipe && String(consignesEquipe).trim()) morceaux.push(`${t('jira.spec.prompt.team')}\n${String(consignesEquipe).trim()}`);
  morceaux.push(t('jira.spec.prompt.explore'));
  morceaux.push(t(synthese ? 'jira.spec.prompt.format-short' : 'jira.spec.prompt.format-long', {
    sections: SECTIONS.map((s, i) => `${i + 1}. ${t(`jira.spec.section.${s}`)}`).join('\n'),
  }));
  morceaux.push(t('jira.spec.prompt.protocol', { nonce }));
  return morceaux.join('\n\n');
}

/** L'instruction d'un SUIVI : la proposition courante, la demande, le même bloc en retour. */
function composerSuivi({ ticketKey, version, markdown, instruction, nonce }) {
  return [
    t('jira.spec.prompt.followup-intro', { key: ticketKey, version }),
    nonFiable(t('jira.spec.prompt.label-proposal', { version }), markdown),
    `${t('jira.spec.prompt.followup-instruction')}\n${String(instruction || '').trim()}`,
    t('jira.spec.prompt.followup-rules', { nonce }),
  ].join('\n\n');
}

/** Ce qu'un agent bien luné rendrait en dry-run : un bloc complet au nonce demandé. */
function sortieDryRun(nonce, ticketKey) {
  const corps = SECTIONS.map((s) => `## ${t(`jira.spec.section.${s}`)}\n${t(`jira.spec.dryrun.${s}`, { key: ticketKey })}`).join('\n\n');
  return `${t('jira.spec.dryrun.intro', { key: ticketKey })}\n\n<<<SPEC ${nonce}\n${corps}\nSPEC ${nonce}>>>\n`;
}

/** Le texte posté sur Jira : la ligne repère, puis la proposition. */
function corpsCommentaire(marker, version, markdown) {
  return `**${ligneRepere(marker, version)}**\n\n${String(markdown || '').trim()}`;
}

/** Parmi les commentaires d'un ticket, celui qui porte la ligne repère ET que ce compte peut
    éditer (le sien) — le dernier posté s'il y en a plusieurs. */
function commentaireRepere(comments, marker, monAccountId) {
  const miens = (comments || []).filter((c) => c.id && versionDuRepere(c.bodyMd, marker) !== null
    && (!monAccountId || !c.authorId || c.authorId === monAccountId));
  return miens.length ? miens[miens.length - 1] : null;
}

module.exports = {
  SECTIONS, MAX_ENFANTS_EPIC, cleValide, normaliserCle, nonceRun,
  extraireSpec, ligneRepere, versionDuRepere, snapshotDe, perimee,
  assembler, composerQuestion, composerSuivi, sortieDryRun, corpsCommentaire, commentaireRepere,
};
