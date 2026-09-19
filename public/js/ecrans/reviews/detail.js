'use strict';
/* Le rapport ouvert (`openReport`) : ce qui est rendu dans le détail, et ce qu'on y fait. */
// @expose openReport
/* Ce qui est actuellement rendu dans le détail : sert à ne PAS réécrire l'écran pour rien.
   Le rapport était réécrit intégralement à chaque fin de job — on lisait un constat en bas de
   page, un job se terminait ailleurs, et on repartait en haut, onglet et version reperdus.
   C'est le micro-agacement le plus coûteux de l'app : il se produit plusieurs fois par jour
   et il ne s'atténue jamais. */
let reportShown = { id: null, sig: null, stamp: null };

// Empreinte de tout ce que le détail AFFICHE. En oublier une part figerait l'écran sur une
// donnée périmée — c'est le risque exact de cette optimisation.
function reportSig(d) {
  const m = d.mr; const r = d.review; const t2 = d.ticket || {};
  return [m.status, m.closed_seen, m.squash, m.remove_source_branch, r && r.updated_at,
    // La publication du rapport change le libellé du bouton (« Publier » → « Republier ») :
    // sans elle ici, une publication automatique laissait l'ancien libellé à l'écran.
    r && r.comment_posted_at,
    d.convergence && d.convergence.status, d.stale, t2.text && t2.text.length, t2.has_image,
    t2.jira_text && t2.jira_text.length, (d.comments || []).length, d.resume_cmd].join('\u0001');
}

async function openReport(id, opts = {}) {
  selectedMr = id;
  // B8 : ne pas re-rendre toute la liste au clic dedans (flash + perte de scroll) —
  // on met simplement à jour la sélection.
  $$('#reportList .card').forEach((c) => c.classList.toggle('active', Number(c.dataset.id) === id));
  const d = await api(`/mrs/${id}`);
  poserAdresse(`#/reviews/${id}`);   // le rapport existe : l'adresse mène quelque part
  const sig = reportSig(d);
  const stamp = (d.review && d.review.updated_at) || '';
  /* Rechargement de fond (fin de job, sauvegarde d'un contexte) : si rien de ce qui est
     affiché n'a changé, on ne touche pas au DOM. Un clic explicite, lui, rend toujours. */
  if (opts.keep && reportShown.id === id && reportShown.sig === sig) return;
  /* Le contexte de lecture n'est restauré que si le RAPPORT lui-même n'a pas changé : après
     une re-review, revenir en haut est le bon comportement — le texte n'est plus le même. */
  const memeRapport = reportShown.id === id && reportShown.stamp === stamp;
  const garde = memeRapport ? {
    y: window.scrollY,
    vue: ($('#reportDetail [data-view].active') || {}).dataset,
    version: ($('#mdVersion') || {}).value || '',
  } : null;
  reportShown = { id, sig, stamp };
  const m = d.mr;
  const rev = d.review;
  /* La LIGNE DE LISTE de cette merge request : elle porte la note, les gravités, le conflit et
     les lots, calculés pour toute la file en une requête. Absente quand le rapport est ouvert
     avant que la liste ne soit chargée (une notification, un lien) — les badges se taisent
     alors, plutôt que d'inventer. */
  const mLigne = reportRows.find((x) => x.id === id) || toReviewRows.find((x) => x.id === id) || m;
  const detail = $('#reportDetail');
  detail.innerHTML = `
    ${/* TOP 7 — L'EN-TÊTE DIT CE QUE LA CARTE SAIT. Un rapport ouvert depuis la palette, une
          notification ou un lien n'a pas la carte sous les yeux : il manquait la note, le
          conflit, le verdict, la CI, les bloquants et la session d'origine — tout ce sur quoi
          se décide « est-ce que je merge ». Les mêmes fonctions que la carte, donc les mêmes
          badges : deux rendus différents pour un même fait finiraient par se contredire. */''}
    <div class="card" style="margin-bottom:12px">
      <div>
        <div class="title">${noteBadge(mLigne.note, mLigne)} ${titreMr(m)}</div>
        <div class="meta">${esc(m.project)}${ticketLink(d.ticket_url, d.ticket_key)} · ${chipBranche(m.source_branch)} → ${chipBranche(m.target_branch, { cible: true })}
          ${badgeDraft(mLigne)}
          ${fenteBrouillons({ ...mLigne, drafts: d.drafts || mLigne.drafts })}
          ${badgeSeverites(mLigne)}
          ${badgeCartes({ cards: d.cards || mLigne.cards })}
          ${badgeConflit(mLigne)}
          ${badgeCI(m.source_branch)}
          ${verifyBadge(d.verification)}
          ${/* A11 — LE BADGE « PÉRIMÉ » LANCE LA RE-REVIEW DELTA. Il annonçait « 3 commits
                depuis » et laissait aller la chercher dans le menu ⋯, deux clics plus loin. */''}
          ${/* A12 — SUR QUEL COMMIT CE RAPPORT PORTE. « Périmé » dit que la branche a bougé ;
                il ne dit pas ce qui a été relu. Le SHA relu, à côté, rend la comparaison
                possible sans ouvrir la forge. */''}
          ${m.reviewed_sha ? ` · <span class="muted" title="${esc(tr('report.reviewed-sha.title'))}"><code>${esc(String(m.reviewed_sha).slice(0, 8))}</code></span>` : ''}
          ${d.stale ? `<button type="button" class="tag stale" id="aStaleRe" data-stale-mr="${m.id}" title="${esc(tr('report.tag.stale-go'))}">${tr('report.tag.stale')}</button>` : ''}
          ${origineHtml(d.origin_task)}
          ${/* CE QUE CETTE REVIEW A COÛTÉ. Les statistiques n'en donnaient qu'une moyenne :
                « celle-ci a-t-elle coûté cher ? » n'avait pas de réponse là où on la lit. */''}
          ${d.tokens_est ? ` · <span class="muted" title="${esc(tr('report.cost.title'))}">${esc(tr('task.cost.tokens', { n: fmtMilliers(d.tokens_est) }))}</span>` : ''}</div>
      </div>
      <div class="spacer"></div>
      ${m.closed_seen ? `<span class="tag merged" title="${tr('mr.tag.closed-title', { forge: forgeLabel(m.forge) })}">${svgIco('merge')} ${tr('mr.tag.merged')}</span>` : ''}
      ${m.web_url ? `<a href="${esc(safeUrl(m.web_url))}" target="_blank" rel="noopener noreferrer">${forgeLabel(m.forge)} ↗</a>` : ''}
    </div>

    ${/* TROIS ACTIONS VISIBLES, le reste dans le menu « ⋯ ». Onze boutons sur trois rangées
          repoussaient la première ligne du rapport hors du premier écran — on venait pour LIRE.
          Les trois retenues sont celles du parcours : ouvrir le code, le faire corriger, merger.
          « Supprimer le rapport » descend dans le menu, en dernier et derrière un séparateur :
          il portait le même rouge que « Merger », à un centimètre de lui. */''}
    <div class="detail-actions">
      <div class="btn-group">
        <button id="aSplit" class="btn btn-primary" title="${tr('report.btn.split-title')}"><svg class=\"ico\"><use href=\"#i-expand\"/></svg>${tr('report.btn.split')}</button>
        ${d.review ? `<button id="aFix" class="btn" title="${tr('report.btn.fix-title')}"><svg class="ico"><use href="#i-bot"/></svg>${tr('report.btn.fix')}</button>` : ''}
        ${m.closed_seen ? '' : `<button id="aMerge" class="btn btn-danger" data-target="${esc(m.target_branch || '')}" title="${tr('report.btn.merge-title', { forge: forgeLabel(m.forge) })}"><svg class=\"ico\"><use href=\"#i-merge\"/></svg>${tr('task.btn.merge')}</button>`}
        <div class="split-menu-wrap">
          <button id="aMore" class="btn btn-icon" aria-haspopup="true" aria-expanded="false" title="${tr('report.btn.more-title')}">⋯</button>
          <div class="split-menu" hidden role="menu">
            <button id="aTicket" role="menuitem" title="${tr('report.btn.context-title')}">${tr('mr.btn.context')}${d.ticket && (d.ticket.text || d.ticket.has_image) ? ' ✓' : ''}</button>
            ${d.review && m.status !== 'done' && !m.closed_seen ? `<button id="aConverge" role="menuitem" title="${tr('report.btn.converge-title')}">${tr('report.btn.converge')}</button>` : ''}
            ${d.verifiable ? `<button id="aVerify" role="menuitem" title="${tr('verify.btn.verify-title')}">${tr('verify.btn.verify')}</button>` : ''}
            ${m.status !== 'done' ? `<button id="aRe" role="menuitem" title="${tr('report.btn.rerun-title')}">${tr('report.btn.rerun')}</button>` : ''}
            ${m.status !== 'done' && d.stale ? `<button id="aReInc" role="menuitem" title="${tr('report.btn.rerun-inc-title')}">${tr('report.btn.rerun-inc')}</button>` : ''}
            ${m.status !== 'done' ? `<button id="aDone" role="menuitem" title="${tr('report.btn.done-title')}">${tr('report.btn.done')}</button>` : `<button id="aReopen" role="menuitem" title="${tr('report.btn.reopen-title')}">${tr('report.btn.reopen')}</button>`}
            ${d.review ? (() => {
              /* PUBLIER LE RAPPORT SUR LA MERGE REQUEST. Le libellé change quand c'est déjà
                 parti : republier n'est pas une correction, ça pose une SECONDE copie sous les
                 yeux de l'équipe, et le bouton doit le dire avant qu'on clique. */
              const dejaPublie = d.review.comment_posted_at;
              return `<button id="aPublish" role="menuitem" data-posted="${esc(dejaPublie || '')}" title="${dejaPublie
                ? tr('report.btn.publish-again-title', { date: fmtDate(dejaPublie) })
                : tr('report.btn.publish-title')}">${dejaPublie
                ? tr('report.btn.publish-again', { forge: forgeLabel(m.forge) })
                : tr('report.btn.publish', { forge: forgeLabel(m.forge) })}</button>`;
            })() : ''}
            ${/* LE LIEN PLUTÔT QUE LE RAPPORT. Quand l'équipe partage un dépôt de données, le
                  rapport y est déjà, en Markdown rendu par la forge : publier son ADRESSE tient
                  en trois lignes là où le rapport en pose six cents, et la passe suivante n'en
                  repose pas six cents de plus. Sans dépôt de données, pas de bouton : il n'aurait
                  aucune adresse où pointer. */''}
            ${d.review && d.data_repo ? (() => {
              /* DÉJÀ PARTI ? La date est lue dans les commentaires enregistrés, qui voyagent :
                 le bouton dit donc aussi ce qu'un collègue a publié avant nous. Republier n'est
                 pas une correction — ça pose un SECOND lien vers le même rapport. */
              const dejaLien = d.review.link_posted_at;
              return `<button id="aPublishLink" role="menuitem" data-posted="${esc(dejaLien || '')}" title="${dejaLien
                ? esc(tr('report.btn.publish-link-again-title', { date: fmtDate(dejaLien) }))
                : esc(tr('report.btn.publish-link-title'))}">${dejaLien
                ? tr('report.btn.publish-link-again') : tr('report.btn.publish-link')}</button>`;
            })() : ''}
            ${addTodoBtn('mr', m.id, tr('notes.add-todo.mr', { iid: m.iid, title: String(m.title || '').slice(0, 60) }))}
            ${resumeCmdBtn(d.resume_cmd)}
            <div class="menu-sep"></div>
            <button id="aDelReport" role="menuitem" class="danger" data-iid="${esc(m.iid)}" title="${tr('mr.btn.delete-report-title')}">${tr('report.btn.delete')}</button>
          </div>
        </div>
      </div>
    </div>

    ${/* B3 — LES TODOS DÉJÀ OUVERTES SUR CETTE MERGE REQUEST. Le rapport proposait d'en
          ajouter une sans montrer celles qui existent : on en recréait une deuxième, identique,
          deux jours plus tard — et on lisait le rapport sans savoir qu'on s'était déjà promis
          quelque chose à son sujet. Cochables ici : c'est tout l'intérêt de les montrer. */''}
    ${(d.todos || []).length ? `<div class="box report-todos">
      <h4>${esc(tr('report.todos.title', { n: d.todos.length, count: d.todos.length }))}</h4>
      ${d.todos.map((t2) => `<div class="brief-item todo-row" data-todo="${t2.id}">
        <input type="checkbox" class="todo-check" data-todo-check="${t2.id}" aria-label="${esc(tr('notes.todo.done'))}" />
        <div class="brief-item-main"><div class="brief-item-title">${esc(t2.title)}</div>
          <div class="meta">${todoPrioBadge(t2.priority)}${todoDueHtml(t2)}</div></div>
      </div>`).join('')}
    </div>` : ''}

    ${/* B4 — QUI, DANS LES NOTES, PARLE DE CETTE MERGE REQUEST. Le lien existait dans un seul
          sens : la note menait ici, et le rapport ignorait qu'on avait écrit trois paragraphes
          à son sujet lundi. L'extrait est pris AUTOUR de la citation — le titre d'une page ne
          dit presque jamais ce qui a été dit de cet objet-là. */''}
    ${(d.citations || []).length ? `<div class="box report-cites">
      <h4>${esc(tr('report.cites.title', { n: d.citations.length, count: d.citations.length }))}</h4>
      ${d.citations.map((c) => `<div class="brief-item">
        <div class="brief-item-main">
          <div class="brief-item-title">${esc(c.title)}</div>
          <div class="brief-item-meta muted">${esc(String(c.excerpt || '').slice(0, 160))}</div>
        </div>
        <button type="button" class="btn btn-sm" data-cite-page="${c.id}">${esc(tr('report.cites.go'))}</button>
      </div>`).join('')}
    </div>` : ''}

    <div id="mrLinksBox"></div>

    ${m.last_error ? errorBox(m.last_error, m.id) : ''}
    ${convergeBoxHtml(d.convergence)}

    <div class="tabbar">
      <button class="active" data-view="review" title="${tr('report.tab.review-title')}">${tr('report.tab.review')}</button>
      <button data-view="explanation" title="${tr('report.tab.explain-title')}">${tr('report.tab.explain')}</button>
      <span class="spacer"></span>
      <select id="mdVersion" class="md-version" title="${tr('report.version.title')}" hidden></select>
      <button id="mdCopy" class="btn btn-sm btn-ghost md-copy" title="${tr('report.btn.copy-title')}"><svg class="ico"><use href="#i-copy"/></svg>${tr('report.btn.copy')}</button>
    </div>
    <div id="mdVersionNote" class="version-note" hidden></div>
    <div id="resolutionBox" hidden></div>
    <div id="mdView" class="md">${mdToHtml(rev && rev.md, IA)}</div>

    <div class="box">
      <h4>${tr('report.modify.title')}</h4>
      <div id="modifyHistory" class="modify-history" hidden></div>
      <textarea id="modifyInput" placeholder="${tr('report.modify.ph')}"></textarea>
      <button class="btn btn-primary" id="btnModify" title="${tr('report.btn.regen-title')}"><svg class=\"ico\"><use href=\"#i-repeat\"/></svg>${tr('report.btn.regen')}</button>
    </div>

    <!-- DEMANDER SANS RISQUER DE PERDRE CE QU'ON LIT. « Demander une modification » régénère le
         rapport et en fait une version de plus : poser une question coûtait donc le rapport
         qu'on avait sous les yeux, et la note pouvait bouger au passage. Ici, rien ne bouge. -->
    <div class="box">
      <h4>${tr('report.ask.title')}</h4>
      <p class="muted">${tr('report.ask.hint')}</p>
      <div id="askHistory" class="ask-history"></div>
      <textarea id="askInput" placeholder="${tr('report.ask.ph')}"></textarea>
      <button class="btn btn-primary" id="btnAsk" title="${tr('report.ask.btn-title')}"><svg class="ico"><use href="#i-bot"/></svg>${tr('report.ask.btn')}</button>
    </div>

    <div class="box">
      <h4>${tr('report.comments.title', { forge: forgeLabel(m.forge) })}</h4>
      <div id="mrComments" class="mr-comments"><p class="muted">${tr('ui.loading')}</p></div>
      <textarea id="commentInput" placeholder="${tr('report.comments.ph')}"></textarea>
      <button class="btn btn-primary" id="btnComment" title="${tr('report.btn.comment-title', { forge: forgeLabel(m.forge) })}"><svg class=\"ico\"><use href=\"#i-doc\"/></svg>${tr('report.btn.comment', { forge: forgeLabel(m.forge) })}</button>
      <p class="muted" style="margin-top:6px">${tr('report.comments.inline-hint')} <strong><svg class=\"ico\"><use href=\"#i-expand\"/></svg>${tr('report.btn.split')}</strong>.</p>
    </div>
  `;

  // charge et affiche les commentaires généraux (non-inline) de la MR
  loadMrComments(id);
  /* Les liens du service associé à ce dépôt (aucun service lié → rien ne s'affiche, et
     surtout pas un bloc vide). Chargé à part : ils ne doivent pas retarder le rapport. */
  renderMrLinks(id, $('#mrLinksBox'));

  // bascule rapport / explication
  // Historique des reviews : chaque passe est conservée, on peut relire les précédentes.
  let shown = { md: rev && rev.md, explanation: rev && rev.explanation };
  // Rendu d'un onglet. Cas particulier : explication absente (review lancée « seule »)
  // → on propose de la générer à la demande (1 appel IA), sans relancer la review.
  const renderView = (view) => {
    if (view === 'explanation' && !(shown.explanation && shown.explanation.trim())) {
      $('#mdView').innerHTML = `<div class="empty-explain">
          <p class="muted">${tr('report.explain.absent')}</p>
          <button id="genExplain" class="btn btn-primary"><svg class="ico"><use href="#i-bot"/></svg>${tr('report.explain.generate')}</button>
        </div>`;
      const g = $('#genExplain');
      if (g) g.addEventListener('click', async () => {
        try { await busy(g, () => api(`/mrs/${id}/explain`, { method: 'POST' })); toast(tr('toast.explain-lancee')); refreshStatus(); }
        catch (e) { toast(explainError(e.message), true); }
      });
      return;
    }
    $('#mdView').innerHTML = mdToHtml(view === 'review' ? shown.md : shown.explanation, IA);
  };
  (async () => {
    let versions = [];
    try { versions = await api(`/mrs/${id}/versions`); } catch { return; }
    // Suivi de résolution : bandeau + liste des constats, dès qu'il y a un delta.
    renderResolution(id, versions);
    renderModifyHistory(versions);
    if (versions.length < 2) return;              // une seule passe : rien à choisir
    const sel = $('#mdVersion');
    const latest = versions[0].version;
    sel.innerHTML = versions.map((v) => {
      const d = new Date(v.created_at);
      const note = v.note10 != null ? ` · ${fmtNote10(v.note10)}` : '';
      /* A12 — LE COMMIT RELU. Deux versions d'un même après-midi ne se distinguaient que par
         l'heure, alors qu'elles décrivent deux ÉTATS DU CODE : c'est le SHA qui dit si la
         passe portait sur ce qui est poussé aujourd'hui. */
      const sha = v.sha ? ` · ${v.sha}` : '';
      const tag = v.kind === 'modify' ? tr('report.version.regen') : '';
      return `<option value="${v.version}">v${v.version}${v.version === latest ? ' — actuelle' : ''} · ${d.toLocaleDateString(I18Nrt.currentLocale())} ${d.toLocaleTimeString(I18Nrt.currentLocale(), { hour: '2-digit', minute: '2-digit' })}${note}${sha}${tag}</option>`;
    }).join('');
    sel.hidden = false;
    const note = $('#mdVersionNote');
    // Version relue restaurée APRÈS que la liste existe — sinon elle n'aurait rien à choisir.
    if (garde && garde.version && [...sel.options].some((o) => o.value === garde.version)) {
      sel.value = garde.version;
      sel.dispatchEvent(new Event('change'));
    }
    sel.addEventListener('change', async () => {
      const v = Number(sel.value);
      try {
        const data = await api(`/mrs/${id}/versions/${v}`);
        shown = { md: data.md, explanation: data.explanation };
        const active = $('#reportDetail .tabbar button[data-view].active');
        const view = active ? active.dataset.view : 'review';
        renderView(view);
        const older = v !== latest;
        note.hidden = !older;
        if (older) note.textContent = tr('report.version.note', { v, latest });
      } catch (e) { toast(explainError(e.message), true); }
    });
  })();

  /* A15 — « meilleure : v2 » SÉLECTIONNE cette version dans le sélecteur existant : un second
     chemin d'affichage des versions finirait par ne plus montrer la même chose que le premier. */
  const versBest = $('#reportDetail [data-converge-version]');
  if (versBest) {
    versBest.addEventListener('click', () => {
      const sel = $('#mdVersion');
      if (!sel || sel.hidden) { toast(tr('converge.best.unavailable'), true); return; }
      sel.value = versBest.dataset.convergeVersion;
      sel.dispatchEvent(new Event('change'));
      sel.scrollIntoView({ block: 'center' });
    });
  }

  $$('#reportDetail .tabbar button[data-view]').forEach((b) => b.addEventListener('click', () => {
    $$('#reportDetail .tabbar button[data-view]').forEach((x) => x.classList.toggle('active', x === b));
    renderView(b.dataset.view);
  }));
  /* Restauration du contexte de lecture : l'onglet qu'on regardait, puis la position dans la
     page. Le défilement est repositionné après le rendu du corps, sinon la page n'est pas
     encore assez haute pour l'accepter. */
  if (garde && garde.vue && garde.vue.view && garde.vue.view !== 'review') {
    const b = $(`#reportDetail .tabbar button[data-view="${garde.vue.view}"]`);
    if (b) b.click();
  }
  if (garde && garde.y) requestAnimationFrame(() => window.scrollTo({ top: garde.y, behavior: 'auto' }));
  // copie le markdown brut de l'onglet actif (rapport ou explication)
  $('#mdCopy').addEventListener('click', () => {
    const active = $('#reportDetail .tabbar button[data-view].active');
    const view = active ? active.dataset.view : 'review';
    copyText((view === 'review' ? shown.md : shown.explanation) || '', $('#mdCopy'));
  });

  $('#aSplit').addEventListener('click', () => openSplit(id, m));
  /* Le menu « ⋯ » du rapport. Même mécanique que sur les cartes, sans `placerMenu` :
     ici le menu n'est rogné par aucun `overflow: hidden`, le positionnement CSS suffit. */
  const aMore = $('#aMore');
  aMore.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = aMore.parentElement.querySelector('.split-menu');
    const ouvrir = menu.hidden;
    closeSplitMenus();
    menu.hidden = !ouvrir;
    aMore.setAttribute('aria-expanded', String(ouvrir));
  });
  /* Un item cliqué referme le menu : sans ça il reste ouvert par-dessus la modale de
     confirmation que l'item vient d'ouvrir. */
  aMore.parentElement.querySelector('.split-menu').addEventListener('click', (e) => {
    if (e.target.closest('button')) closeSplitMenus();
  });
  $('#aTicket').addEventListener('click', () => openTicket(id, `!${m.iid} — ${m.title || ''}`));
  const aFix = $('#aFix');
  if (aFix) aFix.addEventListener('click', () => {
    const md = (rev && rev.md) || '';
    if (!md) { toast(tr('toast.aucun-rapport-de-review-a'), true); return; }
    openTaskForMr(m, {
      title: tr('report.fix.modal-title', { iid: m.iid }),
      commitMessage: tr('report.fix.commit', { branch: m.source_branch, iid: m.iid }),
      prompt: tr('prompt.apply-review', { branch: m.source_branch, md }),
      // Session de codage d'où sort la branche : proposée, jamais imposée (cf. openTaskForMr).
      sessionId: d.origin_session || '',
    }).catch((e) => toast(tr('toast.ouverture-impossible', { message: e.message }), true));
  });
  /* On DEMANDE avant d'écrire chez les autres. Le rapport part sous le nom de l'utilisateur
     sur la merge request d'un collègue : c'est le même niveau d'engagement que l'envoi des
     brouillons de commentaires, qui se confirme déjà. */
  const aPublish = $('#aPublish');   // absent tant qu'aucun rapport n'existe
  if (aPublish) aPublish.addEventListener('click', async () => {
    const forge = forgeLabel(m.forge);
    const ok = await confirmDialog({
      title: tr('report.publish.confirm.title', { forge }),
      text: tr('report.publish.confirm.text', { forge, mr: `${m.project} !${m.iid}` }),
      detail: aPublish.dataset.posted ? tr('report.btn.publish-again-title', { date: fmtDate(aPublish.dataset.posted) }) : '',
      confirmLabel: tr('report.btn.publish', { forge }),
      danger: false,
    });
    if (!ok) return;
    try {
      await busy(aPublish, () => api(`/mrs/${id}/publish-review`, { method: 'POST' }));
      toast(tr('toast.review.published', { forge }));
      /* On relit le rapport : le bouton doit passer à « Republier », et le commentaire
         apparaître dans le fil en dessous. Réécrire le libellé à la main mentirait le jour
         où le serveur aurait refusé sans lever d'erreur. */
      await openReport(id);
    } catch (e) { toast(e.message, true); }
  });

  /* Le lien part sous le même engagement que le rapport : un commentaire chez les autres. Et
     il dit ce qu'il expose — qui peut lire le dépôt de données lira le rapport. */
  const aPublishLink = $('#aPublishLink');   // absent sans dépôt de données partagé
  if (aPublishLink) aPublishLink.addEventListener('click', async () => {
    const forge = forgeLabel(m.forge);
    const ok = await confirmDialog({
      title: tr('report.publish-link.confirm.title', { forge }),
      text: tr('report.publish-link.confirm.text', { forge, mr: `${m.project} !${m.iid}` }),
      /* Ce qu'un collègue a peut-être déjà fait : la date vient du dépôt partagé, pas de ce
         poste. C'est l'avertissement qui manquait — deux liens vers le même rapport. */
      detail: aPublishLink.dataset.posted
        ? tr('report.btn.publish-link-again-title', { date: fmtDate(aPublishLink.dataset.posted) }) : '',
      confirmLabel: aPublishLink.dataset.posted
        ? tr('report.btn.publish-link-again') : tr('report.btn.publish-link'),
      danger: false,
    });
    if (!ok) return;
    try {
      /* La synchro part avant la publication : le bouton peut donc mettre quelques secondes.
         `busy` le dit — sans quoi on cliquerait une seconde fois, et deux commentaires
         partiraient pour un seul geste. */
      await busy(aPublishLink, () => api(`/mrs/${id}/publish-review-link`, { method: 'POST' }));
      toast(tr('toast.review.link-published', { forge }));
      await openReport(id);      // le commentaire doit apparaître dans le fil, en dessous
    } catch (e) { toast(e.message, true); }
  });

  const aMerge = $('#aMerge'); // absent si la MR n'est plus ouverte sur GitLab
  if (aMerge) aMerge.addEventListener('click', () => {
    openMergeModal({
      url: `/mrs/${id}/merge`, label: `!${m.iid}`, target: m.target_branch, forge: m.forge,
      project: m.project,
      mrId: id, ticketKey: m.ticket_key || jiraCleDe(m),
      squash: m.squash, removeSourceBranch: m.remove_source_branch,
      /* Pas de rattrapage ici : cette merge request n'est pas forcément issue d'une session,
         il n'y a donc pas de branche à rejouer. Le conflit, lui, se dit quand même. */
      check: `/mrs/${id}/merge-check`,
      onDone: () => openReport(id),          // recharge le détail (badge « mergée »)
    });
  });
  /* LA LISTE SUIT, pas seulement le rapport. Ces deux boutons changent le STADE de la MR : elle
     quitte « Reviewées » pour « Traitées », ou l'inverse. Ne rafraîchir que le panneau de droite
     laissait la carte dans une liste où elle n'a plus sa place, et le compteur du segment mentait
     jusqu'au prochain rechargement — le même geste depuis la file « À traiter » le faisait déjà. */
  const done = $('#aDone'); if (done) done.addEventListener('click', async () => {
    await api(`/mrs/${id}/done`, { method: 'POST' });
    toast(tr('toast.marquee-done'));
    openReport(id); loadSegment(); refreshCounts();
  });
  const reopen = $('#aReopen'); if (reopen) reopen.addEventListener('click', async () => {
    await api(`/mrs/${id}/reopen`, { method: 'POST' });
    toast(tr('toast.rouverte'));
    openReport(id); loadSegment(); refreshCounts();
  });
  /* Vérifier depuis le rapport : une MR déjà reviewée reste une MR à vérifier. La review
     donne un avis, le vérificateur un fait — les deux se lisent au même endroit. */
  const ver = $('#aVerify'); if (ver) ver.addEventListener('click', () => busy(ver, () => lancerVerification([id])));
  const re = $('#aRe'); if (re) re.addEventListener('click', async () => {
    try { await api(`/mrs/${id}/rereview`, { method: 'POST' }); toast(tr('toast.re-review-lancee')); refreshStatus(); }
    catch (e) { toast(e.message, true); }
  });
  // Re-review incrémentale : ne relit que le delta depuis le dernier SHA reviewé.
  /* A11 — le badge « périmé » et l'entrée du menu font la MÊME chose : la re-review sur le
     delta. Le badge est là où l'on découvre la péremption ; le menu, là où on cherche les
     actions. Un seul câblage pour les deux, sinon l'un des deux finirait par diverger. */
  const relancerDelta = async () => {
    try { await api(`/mrs/${id}/rereview`, { method: 'POST', body: { incremental: true } }); toast(tr('toast.re-review-inc-lancee')); refreshStatus(); }
    catch (e) { toast(e.message, true); }
  };
  const reInc = $('#aReInc'); if (reInc) reInc.addEventListener('click', relancerDelta);
  const staleBtn = $('#aStaleRe'); if (staleBtn) staleBtn.addEventListener('click', relancerDelta);
  // Converger : ouvre la modale de lancement (seuil + plafond pré-remplis depuis la config).
  const conv = $('#aConverge'); if (conv) conv.addEventListener('click', () => openConvergeModal({ type: 'mr', id, label: `!${m.iid}` }));

  /* Supprimer le rapport vit ici, avec les autres actions sur l'objet, et non plus sur la
     carte de la colonne de gauche : c'y était la SEULE action visible, ce qui la mettait
     très en avant pour ce qu'elle est — un nettoyage, pas une étape du parcours. */
  const del = $('#aDelReport'); if (del) del.addEventListener('click', async () => {
    if (!await confirmDialog({ text: tr('confirm.delete-report', { iid: m.iid }), confirmLabel: tr('ui.delete') })) return;
    try {
      await api(`/mrs/${id}/delete-review`, { method: 'POST' });
      selectedMr = null; renderReportPlaceholder();
      toast(tr('toast.rapport-de-supprime-mr-remise', { iid: m.iid }));
      loadReports(currentSeg); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  });

  champAvecBrouillon($('#modifyInput'), `modify:${id}`, () => $('#btnModify').click());
  $('#btnModify').addEventListener('click', async () => {
    const instruction = $('#modifyInput').value.trim();
    if (!instruction) return;
    const btn = $('#btnModify'); btn.disabled = true;
    try {
      // même pipeline que la review : job de fond + log en direct ; le rapport
      // affiché se recharge automatiquement à la fin du job.
      await api(`/mrs/${id}/modify`, { method: 'POST', body: { instruction } });
      $('#modifyInput').value = '';
      ecrireBrouillon(`modify:${id}`, '');   // parti : le filet n'a plus lieu d'être
      toast(tr('toast.modification-lancee-suivez-le-log'));
      refreshStatus();
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; }
  });

  /* Les échanges sont chargés à part du rapport : ils ne doivent pas retarder ce qu'on vient
     lire, et ils se rechargent seuls quand une réponse arrive. */
  chargerEchangesRevue(id);
  champAvecBrouillon($('#askInput'), `ask:${id}`, () => $('#btnAsk').click());
  $('#btnAsk').addEventListener('click', async () => {
    const question = $('#askInput').value.trim();
    if (!question) return;
    const btn = $('#btnAsk'); btn.disabled = true;
    try {
      await api(`/mrs/${id}/ask`, { method: 'POST', body: { question } });
      $('#askInput').value = '';
      ecrireBrouillon(`ask:${id}`, '');
      /* La réponse arrive par un job de fond : on POSE l'attente à l'écran plutôt que de
         laisser la boîte inchangée, ce qui ferait croire que le clic n'a rien fait. */
      const box = $('#askHistory');
      if (box) box.insertAdjacentHTML('afterbegin', `<div class="ask-entry pending"><div class="ask-q">${esc(question)}</div><div class="muted"><span class="spin"></span> ${esc(tr('report.ask.running'))}</div></div>`);
      toast(tr('report.ask.sent'));
      refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
    finally { btn.disabled = false; }
  });

  champAvecBrouillon($('#commentInput'), `comment:${id}`, () => $('#btnComment').click());
  $('#btnComment').addEventListener('click', async () => {
    const body = $('#commentInput').value.trim();
    if (!body) return;
    const btn = $('#btnComment'); btn.disabled = true;
    try { await api(`/mrs/${id}/comment`, { method: 'POST', body: { body } }); $('#commentInput').value = ''; ecrireBrouillon(`comment:${id}`, ''); toast(tr('toast.commentaire-poste-sur-gitlab')); loadMrComments(id); }
    catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; }
  });
}

