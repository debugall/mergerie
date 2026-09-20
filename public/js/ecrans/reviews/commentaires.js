'use strict';
/* « Répondre » à une discussion ; un constat mène à sa ligne, l'éditeur pré-rempli ; envoi groupé, tout supprimer, Échap, le clavier du viewer. */
// Délégation : « Répondre » à une discussion (fils inline ou généraux).
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.cmt-reply-btn');
  if (!btn) return;
  const wrap = btn.closest('.cmt-reply');
  if (wrap.querySelector('.cmt-editor')) { wrap.querySelector('textarea').focus(); return; }
  const disc = btn.dataset.disc; const mr = btn.dataset.mr;
  const inline = !!btn.closest('#fileContent');
  const ed = document.createElement('div');
  ed.className = 'cmt-editor';
  ed.innerHTML = `<textarea placeholder="${tr('cmt.reply.ph')}"></textarea>`
    + `<div class="cmt-actions"><button type="button" class="btn btn-sm cmt-cancel" title="${tr('cmt.cancel.title')}">${tr('ui.cancel')}</button>`
    + `<button type="button" class="btn btn-sm btn-primary cmt-send" title="${tr('cmt.reply.title', { forge: forgeLabel(split.forge) })}">${tr('cmt.reply.btn')}</button></div>`;
  wrap.appendChild(ed);
  btn.hidden = true;
  const ta = ed.querySelector('textarea'); ta.focus();
  ed.querySelector('.cmt-cancel').addEventListener('click', () => { ed.remove(); btn.hidden = false; });
  ed.querySelector('.cmt-send').addEventListener('click', async () => {
    const body = ta.value.trim(); if (!body) return;
    const s = ed.querySelector('.cmt-send'); s.disabled = true;
    try {
      await api(`/mrs/${mr}/discussions/${encodeURIComponent(disc)}/reply`, { method: 'POST', body: { body } });
      toast(tr('toast.reponse-envoyee'));
      if (inline) {
        try { const dd = await api(`/mrs/${mr}/discussions`); split.discussions = dd.discussions || []; } catch { /* ignore */ }
        renderFile();
      } else { loadMrComments(mr); }
    } catch (err) { s.disabled = false; toast(err.message, true); }
  });
});

/* ---------- Un constat mène à sa ligne, l'éditeur pré-rempli ----------
   Le rapport relève « payment.js:58 — gérer l'échec réseau du PSP ». On ouvrait le code, on
   cherchait le fichier dans l'arbre, on descendait à la ligne 58, on cliquait « + », et on
   retapait le constat en le reformulant. Un clic suffit désormais — et ce qui en sort est un
   BROUILLON, comme tout commentaire inline : on relit, on ajuste, on envoie groupé. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-finding-go]');
  if (!b) return;
  const id = selectedMr;
  if (!id) return;
  const chemin = b.dataset.findingGo;
  const ligne = Number(b.dataset.fline) || 0;
  const texte = b.dataset.ftitle || '';
  // La visionneuse peut déjà être ouverte sur cette merge request : on ne la recharge pas.
  if ($('#splitView').hidden || split.mrId !== id) await openSplit(id);
  /* Le constat peut nommer un fichier ABSENT du diff (l'IA cite parfois un chemin voisin) :
     on le dit plutôt que d'ouvrir un fichier au hasard. */
  const dansArbre = (split.files || []).find((f) => f.path === chemin)
    || (split.files || []).find((f) => f.path.endsWith(`/${chemin}`));
  /* L'ARBRE PEUT MANQUER sans que le diff manque : `/tree` est un appel séparé, et il peut
     échouer (clone occupé) là où le diff, lui, est déjà chargé. Un constat qui porte sur un
     fichier du diff doit s'ouvrir quand même — c'est le fichier qu'on vient lire. */
  const dansDiff = Object.keys(split.diffByFile || {}).find((f) => f === chemin || f.endsWith(`/${chemin}`));
  const chemAffiche = (dansArbre && dansArbre.path) || dansDiff;
  if (!chemAffiche) { toast(tr('report.finding.no-file', { file: chemin }), true); return; }
  await selectFile(chemAffiche);
  await ouvrirCommentaireSurLigne(ligne, texte);
});

/* Ouvre l'éditeur de commentaire sur la ligne demandée, pré-rempli. La ligne peut ne pas être
   dans le diff affiché (constat sur du code inchangé) : on prend alors la plus proche, et à
   défaut la première du fichier — mieux vaut un commentaire à trois lignes près qu'aucun. */
async function ouvrirCommentaireSurLigne(ligne, texte) {
  /* ON CLIQUE JUSQU'À L'EFFET, et on re-résout la ligne à chaque essai. Trois pièges, tous
     silencieux, se cumulaient ici :
       — `selectFile` rend la main avant que les lignes soient peintes (gros diff, rendu
         différé) : on trouvait zéro ligne et on sortait sans rien dire ;
       — toutes les lignes ne se commentent pas — une ligne SUPPRIMÉE ou un en-tête de section
         n'ont pas de bouton « ＋ ». Le repli prenait `rows[0]` sans regarder ;
       — et surtout, le fichier se RE-REND (les brouillons arrivent après coup) : la ligne
         visée est alors détachée du document entre la visée et le clic, et cliquer un nœud
         détaché ne remonte à aucun gestionnaire. Aucune erreur, aucun éditeur.
     Vu de l'utilisateur, les trois donnent la même chose : je clique un constat, il ne se
     passe rien. On boucle donc sur l'EFFET — l'éditeur est là — plutôt que sur le geste. */
  const commentablesMaintenant = () => $$('#fileContent .dl-row').filter((r) => r.querySelector('.ln-comment'));
  const viser = (rows) => {
    let cible = rows.find((r) => Number(r.dataset.new) === ligne);
    if (!cible && ligne) {
      let ecart = Infinity;
      for (const r of rows) {
        const n = Number(r.dataset.new);
        if (!n) continue;
        const d = Math.abs(n - ligne);
        if (d < ecart) { ecart = d; cible = r; }
      }
    }
    return cible || rows[0];
  };

  for (let essai = 0; essai < 40; essai += 1) {
    const rows = commentablesMaintenant();
    if (rows.length) {
      const cible = viser(rows);
      cible.scrollIntoView({ block: 'center' });
      cible.querySelector('.ln-comment').click();
      const ed = cible.nextElementSibling;
      if (ed && ed.classList.contains('cmt-editor')) {
        const ta = ed.querySelector('textarea');
        if (ta && texte && !ta.value) { ta.value = texte; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  /* Deux secondes sans une seule ligne commentable : le fichier n'en a pas dans ce diff (un
     constat sur du code supprimé n'a pas de ligne où se poser). On le DIT — c'est la seule
     chose qu'on ne doit jamais faire en silence. */
  toast(tr('report.finding.no-line'), true);
}

// Commentaire inline : bouton « ＋ » d'une ligne de diff -> éditeur -> discussion GitLab.
$('#fileContent').addEventListener('click', (e) => {
  const btn = e.target.closest('.ln-comment');
  if (!btn) return;
  const row = btn.closest('.dl-row');
  if (row.nextElementSibling && row.nextElementSibling.classList.contains('cmt-editor')) {
    row.nextElementSibling.querySelector('textarea').focus(); return;
  }
  const ed = document.createElement('div');
  ed.className = 'cmt-editor';
  const forge = forgeLabel(split.forge);
  ed.innerHTML = `<textarea placeholder="${tr('cmt.inline.ph')}"></textarea>`
    + `<div class="cmt-actions"><button type="button" class="btn btn-sm cmt-cancel" title="${tr('cmt.cancel.title')}">${tr('ui.cancel')}</button>`
    /* ENREGISTRER SANS ENVOYER : le geste de relecture. On écrit ses remarques au fil des
       fichiers, on les corrige, on en retire — et on les envoie toutes quand on a fini. */
    + `<button type="button" class="btn btn-sm cmt-draft-save" title="${tr('cmt.draft.title')}">${tr('cmt.draft.btn')}</button>`
    + `<button type="button" class="btn btn-sm btn-primary cmt-send" title="${tr('cmt.inline.title', { forge })}">${tr('cmt.inline.btn', { forge })}</button></div>`;
  row.after(ed);
  const ta = ed.querySelector('textarea'); ta.focus();
  ed.querySelector('.cmt-cancel').addEventListener('click', () => ed.remove());
  ed.querySelector('.cmt-draft-save').addEventListener('click', async () => {
    const body = ta.value.trim(); if (!body) return;
    const b = ed.querySelector('.cmt-draft-save'); b.disabled = true;
    try {
      const cree = await api(`/mrs/${split.mrId}/comment-drafts`, { method: 'POST', body: {
        body, old_path: split.fileOldPath, new_path: split.fileNewPath,
        old_line: row.dataset.old || null, new_line: row.dataset.new || null,
      } });
      split.drafts = [...(split.drafts || []), cree];
      majBoutonBrouillons();
      ed.remove();
      renderFile();
      toast(tr('toast.commentaire-en-attente'));
    } catch (err) { b.disabled = false; toast(explainError(err.message), true); }
  });
  ed.querySelector('.cmt-send').addEventListener('click', async () => {
    const body = ta.value.trim(); if (!body) return;
    const send = ed.querySelector('.cmt-send'); send.disabled = true;
    try {
      await api(`/mrs/${split.mrId}/discussion`, { method: 'POST', body: {
        body, old_path: split.fileOldPath, new_path: split.fileNewPath,
        old_line: row.dataset.old || null, new_line: row.dataset.new || null,
      } });
      toast(tr('toast.commentaire-poste-sur-la-ligne'));
      ed.remove();
      // recharge les discussions pour afficher le nouveau commentaire en place
      try { const dd = await api(`/mrs/${split.mrId}/discussions`); split.discussions = dd.discussions || []; } catch { /* ignore */ }
      renderFile();
    } catch (err) { send.disabled = false; toast(err.message, true); }
  });
});
/* Modifier / supprimer un commentaire en attente, et les envoyer tous. Délégué : le contenu
   du fichier est régénéré à chaque changement de fichier. */
$('#fileContent').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-draftdel]');
  if (del) {
    const id = Number(del.dataset.draftdel);
    try {
      await api(`/mrs/${split.mrId}/comment-drafts/${id}`, { method: 'DELETE' });
      split.drafts = (split.drafts || []).filter((d) => d.id !== id);
      majBoutonBrouillons(); renderFile();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  const edit = e.target.closest('[data-draftedit]');
  if (!edit) return;
  const id = Number(edit.dataset.draftedit);
  const bloc = edit.closest('.cmt-draft');
  const d = (split.drafts || []).find((x) => x.id === id);
  if (!bloc || !d || bloc.querySelector('textarea')) return;
  const corps = bloc.querySelector('.cmt-draft-body');
  corps.innerHTML = '<textarea class="cmt-draft-edit"></textarea>';
  const ta = corps.querySelector('textarea');
  ta.value = d.body; ta.focus();
  bloc.querySelector('.cmt-actions').innerHTML = `<button type="button" class="btn btn-sm" data-draftcancel="1">${esc(tr('ui.cancel'))}</button>`
    + `<button type="button" class="btn btn-sm btn-primary" data-draftsave="${id}">${esc(tr('ui.save'))}</button>`;
  bloc.querySelector('[data-draftcancel]').addEventListener('click', () => renderFile());
  bloc.querySelector('[data-draftsave]').addEventListener('click', async () => {
    const body = ta.value.trim(); if (!body) return;
    try {
      const maj = await api(`/mrs/${split.mrId}/comment-drafts/${id}`, { method: 'PUT', body: { body } });
      split.drafts = (split.drafts || []).map((x) => (x.id === id ? maj : x));
      renderFile();
    } catch (err) { toast(explainError(err.message), true); }
  });
});

/* L'ENVOI GROUPÉ. Publier chez la forge notifie l'auteur : ça se confirme, et la question dit
   COMBIEN partent — c'est le seul moyen de s'apercevoir qu'on en avait oublié un. */
$('#draftsSend') && $('#draftsSend').addEventListener('click', async () => {
  const n = (split.drafts || []).length;
  if (!n) return;
  const ok = await confirmDialog({
    title: tr('cmt.draft.confirm.title'),
    text: tr('cmt.draft.confirm.text', { n, count: n, forge: forgeLabel(split.forge) }),
    detail: (split.drafts || []).map((d) => `${d.new_path || d.old_path}:${d.new_line || d.old_line || '?'} — ${String(d.body).split('\n')[0].slice(0, 80)}`).join('\n'),
    confirmLabel: tr('cmt.draft.send'),
    danger: false,
  });
  if (!ok) return;
  try {
    const r = await busy($('#draftsSend'), () => api(`/mrs/${split.mrId}/comment-drafts/send`, { method: 'POST' }));
    await chargerBrouillons();
    /* Ce qui a échoué RESTE en attente, et on le dit : un « envoyé » global sur un lot à
       moitié parti ferait fermer la MR en croyant le travail fait. */
    if (r.failed && r.failed.length) toast(tr('cmt.draft.partial', { n: r.sent, count: r.sent, f: r.failed.length }), true);
    else toast(tr('cmt.draft.sent', { n: r.sent, count: r.sent }));
    try { const dd = await api(`/mrs/${split.mrId}/discussions`); split.discussions = dd.discussions || []; } catch { /* ignore */ }
    renderFile();
  } catch (err) { toast(explainError(err.message), true); }
});

/* TOUT SUPPRIMER. Le pendant de l'envoi groupé : une remarque qu'on ne veut plus — ou que la
   forge refuse — bloque le lot, et la retirer demandait de rouvrir le fichier où elle se
   trouve, un par un. La confirmation DIT COMBIEN et LESQUELLES (même détail que l'envoi) : on
   ne vide pas dix remarques écrites hier sur un « êtes-vous sûr ? » anonyme. Rouge, parce que
   c'est irréversible — rien n'est envoyé nulle part, ces remarques n'existent qu'ici. */
$('#draftsWipe') && $('#draftsWipe').addEventListener('click', async () => {
  const n = (split.drafts || []).length;
  if (!n) return;
  const ok = await confirmDialog({
    title: tr('cmt.draft.wipe.confirm.title'),
    text: tr('cmt.draft.wipe.confirm.text', { n, count: n }),
    detail: (split.drafts || []).map((d) => `${d.new_path || d.old_path}:${d.new_line || d.old_line || '?'} — ${String(d.body).split('\n')[0].slice(0, 80)}`).join('\n'),
    confirmLabel: tr('ui.delete'),
  });
  if (!ok) return;
  try {
    const r = await busy($('#draftsWipe'), () => api(`/mrs/${split.mrId}/comment-drafts`, { method: 'DELETE' }));
    await chargerBrouillons();
    renderFile();
    toast(tr('cmt.draft.wiped', { n: r.deleted, count: r.deleted }));
  } catch (err) { toast(explainError(err.message), true); }
});

$('#treeSearch').addEventListener('input', renderTree);
$('#treeList').addEventListener('click', (e) => { const f = e.target.closest('.tree-file[data-path]'); if (f) selectFile(f.dataset.path); });
/* On note ce que l'utilisateur ouvre et ferme, à l'instant où il le fait. Rendre l'arbre avec
   `<details open>` ne déclenche PAS `toggle` : la mémoire ne retient donc que ses gestes à lui,
   jamais l'état par défaut recalculé. En phase de capture, car `toggle` ne remonte pas. */
$('#treeList').addEventListener('toggle', (e) => {
  const d = e.target.closest && e.target.closest('details.tree-folder');
  if (d) memoDossiers()[d.dataset.dir] = d.open;
}, true);
$('#reportToggle').addEventListener('click', () => {
  const hidden = $('.code-body', $('#splitView')).classList.toggle('no-report');
  $('#reportToggle').classList.toggle('off', hidden);
});
$('#treeToggle').addEventListener('click', () => {
  const hidden = $('.code-body', $('#splitView')).classList.toggle('no-tree');
  $('#treeToggle').classList.toggle('off', hidden);
});
$('#splitClose').addEventListener('click', closeSplit);
/* ÉCHAP DANS LES VUES PLEIN ÉCRAN : LE PLUS HAUT D'ABORD, et un seul gestionnaire pour en
   décider. Le diff d'une itération s'ouvre PAR-DESSUS la liste des itérations ; avec deux
   gestionnaires indépendants, le premier fermait le diff et le second, voyant le diff déjà
   fermé, fermait la liste dans la même touche — on revenait à la liste des sessions au lieu de
   revenir à l'itération qu'on relisait. Une garde dans le second n'y peut rien : il s'exécute
   après. C'est donc ici, et ici seulement, que se tranche à qui Échap appartient. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#splitView').hidden) { closeSplit(); return; }
  if (!$('#taskMdView').hidden) $('#taskMdView').hidden = true;
});

/* LE CLAVIER DU VIEWER PLEIN ÉCRAN. Il ne répondait qu'à Échap — et le clavier GLOBAL se
   retire dès qu'il s'ouvre, par sécurité : on se retrouvait donc à la souris pour parcourir un
   diff de quarante fichiers, alors que c'est l'écran où l'on passe le plus de temps.
 *
 * Les touches reprennent celles qui existent déjà ailleurs plutôt que d'en inventer :
 *   `n` / `p` : le changement suivant / précédent (les boutons ‹ › du bandeau) ;
 *   `]` / `[` : le fichier MODIFIÉ suivant / précédent — pas le fichier suivant de l'arbre :
 *               dans un dépôt de mille fichiers, ce qu'on parcourt, c'est ce qui a changé ;
 *   `f`       : le constat suivant, quand le rapport en porte.
 * Rien ne part si l'on est en train d'écrire (un commentaire inline, une recherche). */
document.addEventListener('keydown', (e) => {
  if ($('#splitView').hidden) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const changes = split.changeBlocks || [];
  const modifies = (split.files || []).filter((f) => f.changed);
  const allerFichier = (pas) => {
    if (!modifies.length) return;
    const i = modifies.findIndex((f) => f.path === split.path);
    const j = ((i < 0 ? (pas > 0 ? -1 : 0) : i) + pas + modifies.length) % modifies.length;
    selectFile(modifies[j].path);
  };
  switch (e.key) {
    case 'n': if (changes.length) { e.preventDefault(); goToChange(split.changeIdx + 1); } break;
    case 'p': if (changes.length) { e.preventDefault(); goToChange(split.changeIdx - 1); } break;
    case ']': e.preventDefault(); allerFichier(1); break;
    case '[': e.preventDefault(); allerFichier(-1); break;
    case 'f': if ($$('[data-finding-go]').length) { e.preventDefault(); constatSuivant(); } break;
    default: break;
  }
});

/* Le constat suivant du rapport : on clique le BOUTON RENDU, celui-là même qui mène à la ligne
   — la logique de résolution du chemin vit là-bas et n'a pas à être recopiée ici. */
let constatIdx = -1;
function constatSuivant() {
  const boutons = $$('[data-finding-go]');
  if (!boutons.length) return;
  constatIdx = (constatIdx + 1) % boutons.length;
  boutons[constatIdx].click();
  boutons[constatIdx].scrollIntoView({ block: 'center' });
}

