'use strict';
/* « RÉSUME-MOI LA PÉRIODE » — l'option qui coûte UN appel IA, jamais par défaut : la vue de base
 * du rattrapage est zéro IA, zéro réseau, comme le brief. Utile au-delà d'une trentaine de merge
 * requests ; en dessous, la liste se lit plus vite.
 *
 * Le prompt est fait des TITRES — merge requests mergées, arrivées, fermées, pushs directs —,
 * dépôt par dépôt, balisés comme donnée (`nonFiable`) : ce sont des textes écrits par d'autres.
 * La sortie est du Markdown non fiable, rendue comme un rapport d'agent, rangée sur la ligne
 * `periode` (`resume`, `resume_at`). Un job, parce qu'un appel IA ne tient pas dans une requête. */
const path = require('node:path');
const db = require('../db');
const copilot = require('../agent/copilot');
const { TASKS_DIR, ensureDir } = require('../core/paths');
const { t } = require('../core/i18n');
const { nonFiable } = require('../core/nonfiable');

const MAX_LIGNES_PAR_DEPOT = 80;

/* Les faits de la période, en texte, dépôt par dépôt. */
function faits(items, repos) {
  const projet = (id) => (repos.find((r) => r.id === id) || {}).project || '?';
  const parDepot = new Map();
  for (const it of items) {
    if (!['mr_merged', 'mr_new', 'mr_closed', 'push'].includes(it.kind)) continue;
    const k = projet(it.repo_id);
    if (!parDepot.has(k)) parDepot.set(k, []);
    const l = parDepot.get(k);
    if (l.length >= MAX_LIGNES_PAR_DEPOT) continue;
    const x = it.extra || {};
    const jour = String(it.at || '').slice(0, 10);
    if (it.kind === 'push') l.push(`- push direct sur ${x.branche || '?'} par ${it.author || '?'} le ${jour} : ${(x.commits || []).map((c) => c.title).join(' · ') || it.title || ''}`);
    else if (it.kind === 'mr_merged') l.push(`- !${it.ref} — ${it.title || ''} (mergée le ${jour} par ${it.author || '?'})`);
    else if (it.kind === 'mr_new') l.push(`- !${it.ref} — ${it.title || ''} (ouverte le ${jour}, toujours ouverte)`);
    else l.push(`- !${it.ref} — ${it.title || ''} (fermée sans merge le ${jour})`);
  }
  return [...parDepot].map(([k, l]) => `## ${k}\n${l.join('\n')}`).join('\n\n');
}

async function resumer(periodeId, onLog = () => {}) {
  const p = db.prepare('SELECT * FROM periode WHERE id = ?').get(Number(periodeId));
  if (!p) throw new Error(t('err.periode.introuvable'));
  const items = db.prepare('SELECT * FROM periode_item WHERE periode_id = ? ORDER BY at DESC').all(p.id)
    .map((it) => { let extra = {}; try { extra = JSON.parse(it.extra || '{}'); } catch { /* illisible */ } return { ...it, extra }; });
  const repos = db.prepare('SELECT id, project FROM repo').all();
  const corps = faits(items, repos) || t('notes.periode.resume.nothing');
  const prompt = `${t('notes.periode.resume.prompt', { from: p.depuis.slice(0, 10), to: p.jusqua.slice(0, 10) })}\n\n${nonFiable('faits de la période', corps)}`;
  const cwd = path.join(TASKS_DIR, 'periode', String(p.id));
  ensureDir(cwd);
  onLog(t('log.periode.resume-run', { mode: copilot.isDryRun() ? 'dry-run' : t('log.mode.ai') }));
  const texte = await copilot.runPrompt(prompt, cwd, { kind: 'ask', owner: { kind: 'periode', id: p.id } }, onLog);
  const resume = String(texte || '').trim();
  if (!resume) throw new Error(t('err.periode.resume-vide'));
  db.prepare('UPDATE periode SET resume = ?, resume_at = ? WHERE id = ?').run(resume, new Date().toISOString(), p.id);
  return resume;
}

module.exports = { resumer, faits };
