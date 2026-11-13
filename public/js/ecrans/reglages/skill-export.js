'use strict';
/* Réglages → Merge Request : « Exporter le reviewer en skill ». */
/* ---------- Exporter le reviewer en skill ----------
   L'archive d'un skill Claude Code qui refait la review de Mergerie — même gabarit, mêmes règles,
   même note, mêmes constats — sur la branche courante d'un dépôt, sans Mergerie. On dit ce que
   l'archive contient après l'avoir reçue : « c'est fait » n'apprend rien, « SKILL.md + scripts/preparer.js »
   dit où aller voir. */
$('#btnSkillExport') && $('#btnSkillExport').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const info = $('#skillExportInfo');
  if (info) { info.className = 'muted'; info.textContent = tr('settings.skill.running'); }
  try {
    // POST : l'archive porte le gabarit et les règles de l'équipe — elle ne part que sur un geste de l'application.
    const res = await fetch('/api/reviewer/skill', { method: 'POST' });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || res.statusText);
    const blob = await res.blob();
    const nom = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    telecharger(blob, nom ? nom[1] : 'branch-review.zip');
    if (info) {
      info.className = 'muted ok';
      info.textContent = tr('settings.skill.done', { files: (res.headers.get('X-Mergerie-Skill') || '').split(',').filter(Boolean).join(' · ') });
    }
  } catch (err) {
    if (info) { info.className = 'muted err'; info.textContent = explainError(err.message); }
  }
}));
