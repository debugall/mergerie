'use strict';
/* Export d'une réponse d'agent (HTML · Word · PDF). */
// @expose telecharger
/* ---------- Export d'une réponse d'agent (HTML · Word · PDF) ----------
   Une réponse d'IA se relit souvent ailleurs que dans Mergerie : dans un ticket, dans un
   compte rendu, envoyée à quelqu'un qui n'a pas l'outil. Copier le Markdown ne suffit pas
   quand le destinataire attend un document.

   Répartition : le HTML et le PDF se fabriquent ICI — le contenu rendu est déjà à l'écran,
   et le PDF passe par la boîte d'impression du navigateur, donc sans rien installer et avec
   le même rendu qu'à l'écran. Le .docx est un ZIP : c'est le serveur qui l'assemble. */

// Feuille de style embarquée dans l'export : le document doit rester lisible seul, sans
// l'application autour. Volontairement sobre — c'est un document, pas une capture d'écran.
const CSS_EXPORT = `
  body { font: 15px/1.6 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1b2230; background: #fff; max-width: 820px; margin: 32px auto; padding: 0 20px; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  h2 { font-size: 21px; margin: 28px 0 8px; }
  h3 { font-size: 17px; margin: 22px 0 6px; }
  h4 { font-size: 15px; margin: 18px 0 6px; }
  p, li { margin: 8px 0; }
  code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .9em;
    background: #f2f4f8; padding: 1px 5px; border-radius: 4px; }
  pre { background: #f6f8fa; border: 1px solid #e2e6ee; border-radius: 6px; padding: 12px;
    overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 10px 0; padding: 2px 14px; border-left: 3px solid #ccc; color: #555; }
  table { border-collapse: collapse; margin: 12px 0; width: 100%; }
  th, td { border: 1px solid #ccd2dd; padding: 6px 10px; text-align: left; }
  th { background: #f2f4f8; }
  .meta { color: #5d6a80; font-size: 12px; margin: 0 0 24px; }
  @media print { body { margin: 0; max-width: none; } }
`;

/* Le document autonome. Le titre et la date sont dans le corps, pas seulement dans le nom du
   fichier : un document imprimé ou transféré perd son nom de fichier bien avant son contenu. */
function documentExport(titre) {
  const corps = $('#taskMdBody');
  return `<!doctype html><html lang="${I18Nrt.currentLocale().slice(0, 2)}"><head><meta charset="utf-8" />`
    + `<title>${esc(titre)}</title><style>${CSS_EXPORT}</style></head><body>`
    + `<h1>${esc(titre)}</h1><p class="meta">Mergerie — ${esc(fmtDateTime(new Date().toISOString()))}</p>`
    + (corps ? corps.innerHTML : '') + '</body></html>';
}

// Nom de fichier lisible : on écarte ce qui casse un chemin, on garde les accents.
const nomExport = (titre) => (String(titre || '').trim()
  .replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, ' ').slice(0, 80).trim() || 'mergerie');

function telecharger(blob, nom) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nom;
  document.body.appendChild(a); a.click(); a.remove();
  // Révocation différée : sur certains navigateurs, révoquer trop tôt annule le téléchargement.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function exporterReponse(format) {
  const titre = $('#taskMdTitle').textContent || 'Mergerie';
  if (!currentMd.trim()) { toast(tr('export.empty'), true); return; }
  try {
    if (format === 'html') {
      telecharger(new Blob([documentExport(titre)], { type: 'text/html;charset=utf-8' }), `${nomExport(titre)}.html`);
      toast(tr('export.done', { format: 'HTML' }));
      return;
    }
    if (format === 'docx') {
      /* `api()` renvoie du JSON : ici on veut l'octet brut, donc `fetch` direct. Le nom du
         fichier vient du serveur (`Content-Disposition`), mais on le repose côté client :
         `a.download` est ce que le navigateur écoute pour un Blob. */
      const res = await fetch('/api/export/docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: titre, markdown: currentMd }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || res.statusText);
      telecharger(await res.blob(), `${nomExport(titre)}.docx`);
      toast(tr('export.done', { format: 'Word' }));
      return;
    }
    /* PDF : on passe par la boîte d'impression du navigateur, « Enregistrer au format PDF ».
       Produire un vrai PDF demanderait un moteur de rendu complet côté serveur (~300 Mo)
       pour un résultat moins fidèle que celui du navigateur, qui sait déjà mettre ce
       document en pages. Une iframe cachée plutôt qu'un onglet : rien ne clignote, et les
       bloqueurs de fenêtres n'ont pas leur mot à dire. */
    const cadre = document.createElement('iframe');
    cadre.setAttribute('aria-hidden', 'true');
    cadre.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(cadre);
    cadre.srcdoc = documentExport(titre);
    await new Promise((r) => { cadre.onload = r; });
    toast(tr('export.pdf-hint'));
    cadre.contentWindow.focus();
    cadre.contentWindow.print();
    // On attend la fermeture de la boîte avant de retirer l'iframe : la détruire pendant
    // l'impression annulerait le rendu sur certains navigateurs.
    setTimeout(() => cadre.remove(), 60_000);
  } catch (e) { toast(explainError(e.message), true); }
}

$('#taskMdExport') && $('#taskMdExport').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#taskMdExportMenu');
  const ouvert = menu.hidden;
  closeSplitMenus();
  menu.hidden = !ouvert;
  $('#taskMdExport').setAttribute('aria-expanded', String(ouvert));
});
$('#taskMdExportMenu') && $('#taskMdExportMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-export]'); if (!b) return;
  closeSplitMenus();
  busy(b, () => exporterReponse(b.dataset.export));
});
/* Échap sur cette vue est traité AVEC celui du diff plein écran, là où l'ordre des deux se
   décide (chercher « LE PLUS HAUT D'ABORD ») : un gestionnaire de plus ici refermerait les
   deux vues d'un seul coup. */

const taskSearchEl = $('#taskSearch');
// Filtrage local (aucun appel serveur), regroupé : renderTasks reconstruit toute la liste.
if (taskSearchEl) taskSearchEl.addEventListener('input', debounce(renderTasks));

/* La case « afficher les sessions masquées » vaut pour les trois sous-onglets et survit au
   rechargement : c'est une préférence de vue, pas un filtre de passage. Même stockage que
   le sous-onglet courant. */
const showHiddenEl = $('#taskShowHidden');
if (showHiddenEl) {
  showHiddenEl.checked = showHiddenTasks;
  showHiddenEl.addEventListener('change', () => {
    showHiddenTasks = showHiddenEl.checked;
    try { localStorage.setItem('aidevtools_show_hidden', showHiddenTasks ? '1' : '0'); } catch { /* ignore */ }
    renderTasks();
  });
}

try { taskKind = localStorage.getItem('aidevtools_task_kind') || 'code'; } catch { /* ignore */ }

