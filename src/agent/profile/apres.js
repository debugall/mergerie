'use strict';
/* Ce qu’on fait de la SORTIE d’un run réussi : la carte d’un agent de domaine, la page de notes, les sous-pages, les entrées d’un agent de fichier.
   Extrait de agent/profile.js (réorganisation de src/ par couches) : les corps sont ceux d'origine, au mot près. */
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../db');
const store = require('../../data/store');
const agentinput = require('../input');
const protocol = require('../protocol');
const notes = require('../../notes/notes');
const i18n = require('../../core/i18n');
const { t } = i18n;
const knowledge = require('../knowledge');
const { parCle } = require('./modele');

/* ---------- Ce qu'on fait de la sortie ---------- */

async function apresRun(task, onLog = () => {}) {
  if (!task || !task.agent_id) return;
  const a = db.prepare('SELECT * FROM agent WHERE id = ?').get(task.agent_id);
  if (!a) return;
  let texte = '';
  try { if (task.md_path && fs.existsSync(task.md_path)) texte = fs.readFileSync(task.md_path, 'utf8'); }
  catch { texte = ''; }

  if (a.output_kind === 'agent') {
    return knowledge.ingest(task, a, texte, onLog);
  }
  /* UNE MISE À JOUR DE CONNAISSANCE porte l'agent de DOMAINE (c'est sur sa carte qu'elle doit
     apparaître), mais c'est le cartographe qui l'a exécutée — et lui seul émet `<<<AGENT>>>`.
     La présence de ce bloc sur un agent de domaine est donc le signal fiable : un agent de
     domaine, lui, n'émet jamais ce bloc (il n'a que `<<<STALE>>>`). */
  if (a.knowledge_prompt && protocol.extraire(texte, 'AGENT').block) {
    const carto = parCle('cartographer');
    if (carto) return knowledge.ingest(task, carto, texte, onLog);
  }
  if (a.output_kind === 'note_page') return versPageDeNotes(a, task, texte, onLog);

  /* Sortie « rapport » : rien à ranger, sauf les ÉCARTS qu'un agent de domaine a constatés
     dans sa propre connaissance. Il ne la corrige pas lui-même — il la signale, et la
     correction reste un geste. */
  if (a.knowledge_prompt) {
    const { block } = protocol.extraire(texte, 'STALE');
    if (block) {
      const gaps = protocol.lignes(block).map((c) => ({ project: c[0] || '', path: c[1] || '', note: c[2] || '' }));
      if (gaps.length) knowledge.addGaps(a, task, gaps);
      onLog(t('agents.log.gaps', { n: gaps.length, count: gaps.length }));
    }
  }
  return null;
}
/* Sortie « page de notes » : créée au premier run, MISE À JOUR ensuite. Jamais dupliquée —
   sinon la carte des services existerait en douze exemplaires au bout de trois mois, et
   aucun ne serait « la » page. Le run garde son propre md : la page en est une copie. */
function versPageDeNotes(agent, task, texte, onLog) {
  const msgs = {
    titreVide: t('err.notes.title-required'), inconnue: t('err.notes.unknown'),
    tropProfond: t('err.notes.parent-too-deep'), soiMeme: t('err.notes.parent-self'),
  };
  /* LES SOUS-PAGES, décidées par l'agent. Une documentation tient rarement en une page : un
     texte général, et le détail de chaque point à côté. C'est l'agent qui juge combien il en
     faut et comment il les découpe — nous, on range. Ce qui reste après extraction est la
     page RACINE : le texte général, avec ses renvois. */
  const { blocks, rest } = protocol.extraireTous(texte, 'PAGE');
  const entete = t('agents.note.header', { name: agent.name, date: new Date().toLocaleString(i18n.currentLocale()) });
  const contenu = `${entete}\n\n${protocol.nettoyer(rest)}`;
  const id = Number(agent.output_ref) || 0;
  const page = id && notes.lirePage ? notes.lirePage(id) : null;
  let racineId;
  if (id && page) {
    notes.majPage(id, { content: contenu }, msgs);
    racineId = id;
    onLog(t('agents.log.note-updated', { title: page.title }));
  } else {
    const cree = notes.creerPage({ title: `${agent.name} — ${t('agents.note.title-suffix')}`, content: contenu }, msgs);
    store.ecrire('agent', () => {
      db.prepare('UPDATE agent SET output_ref = ?, updated_at = ? WHERE id = ?')
        .run(String(cree.id), new Date().toISOString(), agent.id);
      return agent.id;
    });
    racineId = cree.id;
    onLog(t('agents.log.note-created', { title: cree.title }));
  }
  return { page_id: racineId, children: rangerSousPages(agent, racineId, blocks, entete, msgs, onLog) };
}
/* Chaque bloc `<<<PAGE>>>` devient une sous-page de la racine, APPARIÉE PAR TITRE : l'agent
   repasse chaque semaine, et vingt exemplaires de « Détail du routage » au bout de cinq mois
   seraient exactement ce que la règle « jamais dupliquée » interdit pour la page racine.
   Ce qui a disparu de la sortie n'est PAS supprimé, seulement signalé : une sous-page a pu
   être relue et complétée à la main, et un run qui l'oublie n'est pas un ordre d'effacer. */
function rangerSousPages(agent, racineId, blocks, entete, msgs, onLog) {
  const existantes = notes.sousPages(racineId);
  const vues = new Set();
  const out = [];
  for (const bloc of blocks) {
    const lignes = String(bloc || '').split('\n');
    const i = lignes.findIndex((l) => /^title\s*:/i.test(l.trim()));
    // Un bloc sans titre est un bloc mal formé : le run vaut mieux que son protocole.
    if (i === -1) { onLog(t('agents.log.subpage-untitled')); continue; }
    const titre = lignes[i].replace(/^\s*title\s*:/i, '').trim();
    const corps = lignes.slice(i + 1).join('\n').trim();
    if (!titre || !corps) { onLog(t('agents.log.subpage-untitled')); continue; }
    const texte = `${entete}\n\n${corps}`;
    const deja = existantes.find((p) => p.title.toLowerCase() === titre.toLowerCase());
    if (deja) {
      notes.majPage(deja.id, { content: texte }, msgs);
      out.push(deja.id);
    } else {
      out.push(notes.creerPage({ title: titre, content: texte, parent_id: racineId }, msgs).id);
    }
    vues.add(titre.toLowerCase());
  }
  const orphelines = existantes.filter((p) => !vues.has(p.title.toLowerCase()));
  if (orphelines.length) {
    onLog(t('agents.log.subpages-orphan', { n: orphelines.length, count: orphelines.length,
      titles: orphelines.map((p) => p.title).join(', ') }));
  }
  if (out.length) onLog(t('agents.log.subpages', { n: out.length, count: out.length }));
  return out;
}
/* Les fichiers d'entrée à écrire avant un run (appelé par les exécutants, qui savent où est
   la racine des clones). Rend la liste { path, role } que `composer` annonce à l'agent. */
function ecrireEntrees(task, root, cibles) {
  if (!task || !task.agent_id) return [];
  const a = db.prepare('SELECT * FROM agent WHERE id = ?').get(task.agent_id);
  if (!a) return [];
  const out = [];
  /* `recent.md` dès que plusieurs dépôts sont en jeu : c'est là que « ce qui vient d'être
     mergé » a une valeur qu'aucun clone ne porte. */
  if (a.scope_kind === 'all_repos' || (cibles || []).length >= 2) {
    const p = agentinput.ecrireRecent(root, cibles);
    if (p) out.push({ path: p, role: t('agents.input.role-recent') });
  }
  if (a.knowledge_prompt) {
    const ak = knowledge;
    /* UNE MISE À JOUR reçoit trois fichiers de plus : ce qu'on savait, ce qu'on a vu de faux,
       et les commits qui ont touché les chemins cités. « Regarde d'abord là » — c'est la
       différence entre vérifier une carte et la refaire. */
    const ctx = ak.prendreContexteRefresh(a.id);
    if (ctx) {
      const [prec, gaps, commits] = agentinput.ecrireRefresh(root, ctx);
      if (prec) out.push({ path: prec, role: t('agents.input.role-previous') });
      out.push({ path: gaps, role: t('agents.input.role-gaps') });
      out.push({ path: commits, role: t('agents.input.role-commits') });
    } else {
      const p = agentinput.ecrireKnowledge(root, ak.contenuActif(a));
      if (p) out.push({ path: p, role: t('agents.input.role-knowledge') });
    }
  }
  return out;
}
/* Le bloc « voici ce que je t'ai écrit », ajouté à la demande AU MOMENT du lancement : les
   fichiers d'entrée n'existent qu'une fois les clones à jour, ils ne peuvent donc pas être
   dans le prompt stocké. */
function blocEntrees(task, entrees) {
  if (!task || !task.agent_id || !entrees || !entrees.length) return '';
  const a = db.prepare('SELECT * FROM agent WHERE id = ?').get(task.agent_id);
  if (!a) return '';
  const lignes = [t('agents.prompt.inputs'), ...entrees.map((f) => `- \`${f.path}\` — ${f.role}`)];
  if (a.knowledge_prompt) lignes.push(t('agents.prompt.read-knowledge-first'));
  return `\n\n${lignes.join('\n')}`;
}

module.exports = {
  apresRun, versPageDeNotes, rangerSousPages, ecrireEntrees, blocEntrees,
};
