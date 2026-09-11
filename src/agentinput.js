'use strict';
/* Ce que Mergerie ÉCRIT pour l'agent avant de le lancer (spec agents §8.3).
 *
 * Une session lancée dans un clone a déjà le code, le CLAUDE.md du dépôt, ses skills. Ce
 * qu'elle n'a pas, Mergerie l'a : les vingt autres clones, ce qui vient d'être mergé, et la
 * connaissance transverse d'un agent de domaine. Ces fichiers sont exactement ça — le contexte
 * qui vit ENTRE les dépôts.
 *
 * Où ils sont écrits n'est pas un détail : à la RACINE des clones, sous `ai-dev-tools-internal/`.
 * Ce dossier est dans le `.git/info/exclude` de chaque clone, mais la racine, elle,
 * n'appartient à aucun dépôt — un fichier écrit là ne peut être commité par personne. Écrit
 * ailleurs, il finirait dans un `git add -A`.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const { ensureDir } = require('./paths');
const { t } = require('../public/i18n-runtime.js');

const WORK_REL = 'ai-dev-tools-internal';
const MAX_RECENT = 30000;

function ecrire(root, nom, contenu) {
  ensureDir(path.join(root, WORK_REL));
  fs.writeFileSync(path.join(root, WORK_REL, nom), contenu, 'utf8');
  return `${WORK_REL}/${nom}`;
}

const jour = (iso) => String(iso || '').slice(0, 10);

/* Les merge requests mergées des sept derniers jours, par dépôt. C'est le « quoi de neuf »
   qu'aucun clone ne porte : l'agent voit le code d'aujourd'hui, pas ce qui vient d'y entrer. */
function mrsRecentes(repoId) {
  const depuis = new Date(Date.now() - 7 * 86400000).toISOString();
  return db.prepare(`SELECT iid, title, author, updated_at FROM mr
    WHERE repo_id = ? AND status = 'merged' AND COALESCE(updated_at, '') >= ?
    ORDER BY updated_at DESC LIMIT 20`).all(repoId, depuis);
}

// Les services rattachés au dépôt et leurs adresses par environnement (onglet Liens).
function servicesDe(repoId) {
  const out = [];
  for (const s of db.prepare('SELECT id, name FROM service WHERE repo_id = ? ORDER BY name').all(repoId)) {
    const urls = db.prepare(`SELECT e.name AS env, u.url FROM service_url u
      JOIN environment e ON e.id = u.environment_id
      WHERE u.service_id = ? ORDER BY e.position LIMIT 10`).all(s.id);
    out.push({ name: s.name, urls });
  }
  return out;
}

/* `recent.md` — écrit dès qu'un run regarde PLUSIEURS dépôts. Pour une session ordinaire
   (sans agent), rien n'est écrit : ce contexte n'a pas été demandé, et un fichier qui apparaît
   dans le dossier de travail sans raison est une surprise, pas un service. */
function ecrireRecent(root, repos) {
  if (!repos || !repos.length) return null;
  const morceaux = [`# ${t('agents.input.recent-title')}`, ''];
  let tronque = false;
  for (const r of repos) {
    const bloc = [`## ${r.project}`];
    if (r.uncloned) {
      bloc.push(t('agents.input.not-cloned'));
    } else {
      const mrs = mrsRecentes(r.repo_id);
      bloc.push(mrs.length
        ? mrs.map((m) => `- !${m.iid} ${m.title || ''} — ${m.author || '?'} — ${jour(m.updated_at)}`).join('\n')
        : t('agents.input.no-recent-mr'));
      const svc = servicesDe(r.repo_id);
      if (svc.length) {
        bloc.push('', `### ${t('agents.input.services')}`);
        for (const s of svc) bloc.push(`- **${s.name}** : ${s.urls.map((u) => `${u.env} → ${u.url}`).join(' · ') || '—'}`);
      }
    }
    const texte = `${bloc.join('\n')}\n`;
    /* Plafonné, et coupé PAR DÉPÔT : couper au milieu d'une ligne donnerait une adresse
       tronquée qu'on croirait vraie. La ligne de coupe dit qu'il manque quelque chose. */
    if (morceaux.join('\n').length + texte.length > MAX_RECENT) { tronque = true; break; }
    morceaux.push(texte);
  }
  if (tronque) morceaux.push(t('agents.input.truncated'));
  return ecrire(root, 'recent.md', morceaux.join('\n'));
}

// `knowledge.md` — la version active de la connaissance d'un agent de domaine, telle quelle.
function ecrireKnowledge(root, contenu) {
  if (!String(contenu || '').trim()) return null;
  return ecrire(root, 'knowledge.md', String(contenu));
}

/* Les trois fichiers d'une MISE À JOUR de connaissance : ce qu'on savait, ce qu'on a vu de
   faux, et ce qui a bougé depuis. « Regarde d'abord là » — c'est la différence entre une
   cartographie qui recommence à zéro et une qui vérifie. */
function ecrireRefresh(root, { precedent, gaps, commits }) {
  const out = [];
  if (String(precedent || '').trim()) out.push(ecrire(root, 'knowledge-previous.md', String(precedent)));
  out.push(ecrire(root, 'gaps.md', rendreGaps(gaps)));
  out.push(ecrire(root, 'commits.md', rendreCommits(commits)));
  return out;
}

function rendreGaps(gaps) {
  const l = Array.isArray(gaps) ? gaps : [];
  if (!l.length) return `# ${t('agents.input.gaps-title')}\n\n${t('agents.input.no-gap')}\n`;
  return `# ${t('agents.input.gaps-title')}\n\n`
    + l.map((g) => `- **${g.project || '?'}** \`${g.path || ''}\` — ${g.note || ''}${g.at ? ` (${jour(g.at)})` : ''}`).join('\n')
    + '\n';
}

function rendreCommits(parDepot) {
  const l = Array.isArray(parDepot) ? parDepot : [];
  if (!l.length) return `# ${t('agents.input.commits-title')}\n\n${t('agents.input.no-commit')}\n`;
  const bloc = l.map((d) => `## ${d.project}\n${(d.lines || []).slice(0, 200).join('\n') || t('agents.input.no-commit')}`);
  return `# ${t('agents.input.commits-title')}\n\n${bloc.join('\n\n')}\n`;
}

module.exports = { ecrireRecent, ecrireKnowledge, ecrireRefresh, WORK_REL };
