'use strict';
/* Le brief « Aujourd'hui ». */
// @expose loadBrief
/* ---------- Le brief « Aujourd'hui » ---------- */

async function loadBrief() {
  const box = $('#briefBox');
  if (!box) return;
  box.innerHTML = skeleton(4);
  await notesIndex();
  let d;
  try { d = await api('/brief'); } catch (err) { box.innerHTML = `<p class="err">${esc(explainError(err.message))}</p>`; return; }
  /* Le seuil du filtre « prêtes à merger » de l'onglet Reviews vient d'ICI : le brief est la
     seule source de cette règle, et les deux écrans doivent compter la même chose. */
  if (d.ready_threshold) seuilPret = Number(d.ready_threshold) || 8;
  renderBrief(d);
  /* B4 — LA LISTE JENKINS ARRIVE APRÈS, ET LE BRIEF SE REDESSINE. On ne fait pas attendre le
     brief pour une CI : il s'affiche d'abord, et la section « CI rouge » apparaît quand la
     liste est là. Un seul appel par page (`assurerJenkinsPourCI` se garde lui-même), et rien
     n'est sondé — c'est la même liste que celle de l'onglet Jenkins. */
  if (!(JENKINS.jobs || []).length) {
    await assurerJenkinsPourCI();
    if ((JENKINS.jobs || []).length && $('#briefBox')) renderBrief(d);
  }
}

/* A/Notes 3 — LE TEXTE DU DAILY. Composé à partir de ce que le brief affiche DÉJÀ : rien
   n'est recalculé, et ce qu'on colle est donc exactement ce qu'on vient de lire. Volontairement
   pauvre — trois lignes, pas un rapport : un daily se dit en trente secondes. */
function texteDuDaily(d) {
  const l = [];
  const a = d.activity;
  if (a && (a.merged || a.opened || a.verified)) {
    l.push(`${tr('notes.brief.sec.activity')} : ${[
      a.merged ? tr('notes.brief.activity.merged', { n: a.merged, count: a.merged }) : '',
      a.opened ? tr('notes.brief.activity.opened', { n: a.opened, count: a.opened }) : '',
      a.verified ? tr('notes.brief.activity.verified', { n: a.verified, count: a.verified }) : '',
    ].filter(Boolean).join(' · ')}`);
  }
  const fresh = (d.fresh_mrs || []).length;
  const stale = (d.stale_mrs || []).length;
  if (fresh) l.push(`${tr('notes.brief.sec.fresh')} : ${fresh}`);
  if (stale) l.push(`${tr('notes.brief.sec.stale')} : ${stale}`);
  if (d.ready_to_merge) l.push(`${tr('notes.brief.sec.ready')} : ${d.ready_to_merge}`);
  const enAttente = Object.values(d.pending_sessions || {}).reduce((t, n) => t + (Number(n) || 0), 0);
  if (enAttente) l.push(`${tr('notes.brief.sec.pending')} : ${enAttente}`);
  const verifs = (d.verifications || []).length;
  if (verifs) l.push(`${tr('notes.brief.sec.verifications')} : ${verifs}`);
  return l.length ? l.join('\n') : tr('notes.brief.empty.title');
}

/* Une section vide n'est pas rendue. Un écran qui affiche sept titres dont six sous-titrés
   « rien » apprend qu'il ne s'est rien passé — ce qui n'était pas la question posée. */
function briefSection(titre, corps, { icon = 'inbox', hint = '' } = {}) {
  if (!corps) return '';
  return `<section class="brief-sec">
    <h3><svg class="ico"><use href="#i-${icon}"/></svg>${esc(titre)}</h3>
    ${hint ? `<p class="muted brief-hint">${esc(hint)}</p>` : ''}
    ${corps}
  </section>`;
}

/* Écarter une ligne : une croix discrète, à droite, sur chaque item qui peut revenir tous les
   matins. Sans confirmation — rien n'est supprimé, et « Tout réafficher » est au pied du brief. */
const briefHideBtn = (kind, ref) => `<button type="button" class="btn btn-icon btn-sm brief-hide" data-brief-hide="${kind}:${ref}" title="${esc(tr('notes.brief.hide'))}" aria-label="${esc(tr('notes.brief.hide'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button>`;

function renderBrief(d) {
  const box = $('#briefBox');
  const jour = new Date(d.date).toLocaleDateString(I18Nrt.currentLocale(), {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const rappels = (d.reminders || []).map((t) => briefTodoRow(t, true)).join('');
  const todos = (d.todos || []).map((t) => briefTodoRow(t, false)).join('');

  const sessions = (d.sessions || []).map((s) => `<div class="brief-item">
      <div class="brief-item-main">
        <div class="brief-item-title">${esc(String(s.prompt || '').slice(0, 120))}</div>
        ${/* TOP 20 — une session HORS DÉPÔT n'a pas de projet : afficher « 0 projet » sous son
              intitulé se lirait comme un défaut. On dit alors sa saveur, qui est l'information
              utile — c'est elle qui dit dans quel sous-onglet on va atterrir. */''}
        <div class="meta">${s.targets ? esc(tr('notes.brief.session.targets', { n: s.targets, count: s.targets }))
    : esc(tr(`job.kind.${s.kind === 'ask' ? 'ask' : 'local'}`))}</div>
      </div>
      <button type="button" class="btn btn-primary" data-brief-session="${s.task_id}" data-brief-kind="${esc(s.kind === 'ask' ? 'ask' : (s.kind === 'local' ? 'local' : 'code'))}">${esc(tr('notes.brief.session.go'))}</button>
      ${briefHideBtn('session', s.task_id)}
    </div>`).join('');

  const verifs = (d.verifications || []).map((v) => `<div class="brief-item">
      <div class="brief-item-main">
        <div class="brief-item-title">${esc(v.lot_name || v.verifier_name || '')}${v.failed_label ? ` — <code>${esc(v.failed_label)}</code>` : ''}</div>
        ${/* Une vérification de BRANCHE n'a pas de numéro de MR : sans ce repli, sa ligne
              n'affichait que « N tests cassés », sans dire OÙ. */''}
        <div class="meta">${esc(tr('notes.brief.verif.failed', { n: v.failed, count: v.failed }))}
          ${v.targets.map((c) => (c.iid
    ? ` · !${esc(c.iid)}`
    : ` · ${esc(c.project || '')}${c.branch ? ` · ${esc(c.branch)}` : ''}`)).join('')}</div>
      </div>
      ${/* LE BRIEF PORTE L'ACTION, PAS SEULEMENT LE LIEN. Chaque ligne se fermait en trois
             gestes : « voir », changer d'onglet, retrouver la carte, cliquer le vrai bouton.
             Une action par ligne — celle qui la ferme —, jamais deux. */''}
      <button type="button" class="btn btn-primary" data-brief-verif-fix="${v.verification_id}" title="${esc(tr('notes.brief.verif.fix-title'))}">${esc(tr('notes.brief.verif.fix'))}</button>
      <button type="button" class="btn" data-brief-verif="${v.verification_id}">${esc(tr('notes.brief.verif.go'))}</button>
      ${briefHideBtn('verification', v.verification_id)}
    </div>`).join('');

  const fresh = (d.fresh_mrs || []).map((m) => `<div class="brief-item brief-clickable" data-brief-mr="${m.id}">
      <div class="brief-item-main">
        <div class="brief-item-title">!${m.iid} — ${esc(m.title || '')}</div>
        <div class="meta">${esc(m.project)}${m.author ? ` · ${esc(m.author)}` : ''}</div>
      </div>
      <button type="button" class="btn btn-primary" data-brief-review="${m.id}" data-iid="${esc(m.iid)}">${esc(tr('mr.btn.review'))}</button>
      ${briefHideBtn('mr', m.id)}
    </div>`).join('');

  const stale = (d.stale_mrs || []).map((m) => `<div class="brief-item brief-clickable" data-brief-mr="${m.id}">
      <div class="brief-item-main">
        <div class="brief-item-title">!${m.iid} — ${esc(m.title || '')}</div>
        <div class="meta">${esc(m.project)} · ${esc(tr('notes.brief.stale.line', { n: m.days, count: m.days }))}</div>
      </div>
      ${briefHideBtn('mr', m.id)}
    </div>`).join('');

  /* LES SESSIONS QUI ATTENDENT UN GESTE. Trois attentes, un seul oubli : le travail est fait,
     il ne manque qu'un clic. Des nombres, pas des listes — le détail vit dans Dev IA, et à trois
     lignes de plus le brief cesserait d'être un brief. Une attente à zéro ne s'affiche pas. */
  const ps = d.pending_sessions || {};
  const attentes = [
    ['to_run', 'notes.brief.sess.to-run', ps.to_run],
    ['to_push', 'notes.brief.sess.to-push', ps.to_push],
    ['to_mr', 'notes.brief.sess.to-mr', ps.to_mr],
  ].filter(([, , n]) => n > 0).map(([cle, k, n]) => `<div class="brief-item brief-clickable" data-brief-sess="${cle}">
      <div class="brief-item-main"><div class="brief-item-title">${esc(tr(k, { n, count: n }))}</div></div>
      ${/* Le VERBE de l'attente : lancer, pousser, créer la MR. Il mène à Dev IA filtré sur
            ces sessions-là — le geste lui-même reste sur la carte, qui seule sait sur quel
            projet il porte. */''}
      <button type="button" class="btn btn-primary" data-brief-sess-go="${cle}">${esc(tr(`notes.brief.sess.${cle.replace('_', '-')}.action`))}</button>
      ${briefHideBtn('sess', cle)}
    </div>`).join('');

  /* CE QUE LES AGENTS ONT PRODUIT PENDANT LA NUIT. Le documentaliste planifié tourne à 7:00 :
     sans cette section, personne ne saurait qu'il a réécrit « Carte des services », et une page
     dont on ignore qu'elle vient de changer ne sert à rien. On dit aussi ce qui ATTEND — un run
     arrêté sur une question, une connaissance à valider. */
  const agentsBrief = (d.agents || []).map((a) => {
    const bouton = a.kind === 'note_page'
      ? `<button type="button" class="btn btn-primary" data-brief-agent-page="${a.page_id}">${esc(tr('agents.brief.open-page'))}</button>`
      : (a.kind === 'pending'
        ? `<button type="button" class="btn btn-primary" data-brief-agent-review="${a.agent_id}">${esc(tr('agents.btn.review'))}</button>`
        : `<button type="button" class="btn" data-brief-session="${a.task_id}">${esc(tr('notes.brief.session.go'))}</button>`);
    return `<div class="brief-item">
      <div class="brief-item-main">
        <div class="brief-item-title">${esc(tr(`agents.brief.kind.${a.kind}`, { name: a.name || '', title: a.title || '' }))}</div>
        <div class="meta">${esc(a.name || '')}${a.at ? ` · ${esc(fmtDateTime(a.at))}` : ''}</div>
      </div>
      ${bouton}
    </div>`;
  }).join('');

  /* B7 — LE BRIEF SIGNALE LE NETTOYAGE quand il y a vraiment de quoi. En dessous de dix, ce
     serait un rappel de plus pour trois branches : le bouton de l'onglet Git suffit. */
  const branches = (brMergees.total >= 10) ? `<div class="brief-item">
      <div class="brief-item-main"><div class="brief-item-title">${esc(tr('notes.brief.branches', { n: brMergees.total, count: brMergees.total }))}</div></div>
      <button type="button" class="btn btn-primary" data-brief-branches>${esc(tr('notes.brief.branches.go'))}</button>
    </div>` : '';

  /* B4 — CE QUE JENKINS A CASSÉ SUR MES BRANCHES. Le brief listait les vérifications rouges
     de l'outil et ignorait la CI de l'équipe : le nightly cassait à 23 h et on l'apprenait à
     11 h par un collègue. Calculé À L'OUVERTURE, depuis la liste que l'onglet Jenkins charge
     déjà — aucun sondage, aucune requête de plus : on croise les jobs rouges avec les branches
     de mes merge requests ouvertes. Sans Jenkins configuré, la section n'existe pas. */
  const rougesCI = (JENKINS.jobs || []).length
    ? toReviewRows.concat(reportRows)
      .filter((m) => !m.closed_seen)
      .map((m) => ({ m, ci: ciDeLaBranche(m.source_branch) }))
      .filter((x) => x.ci && x.ci.statut === 'echec' && !x.ci.enCours)
      // une même branche peut porter deux MR : on ne le dit qu'une fois
      .filter((x, i, tous) => tous.findIndex((y) => y.ci.path === x.ci.path && y.m.source_branch === x.m.source_branch) === i)
      .slice(0, 8)
    : [];
  const ciCasse = rougesCI.map(({ m, ci }) => `<div class="brief-item">
      <div class="brief-item-main">
        <div class="brief-item-title">${esc(ci.path)} <span class="muted">#${esc(String(ci.number))}</span></div>
        <div class="brief-item-meta muted">${esc(tr('notes.brief.ci.on', { branch: m.source_branch, iid: m.iid }))}</div>
      </div>
      <button type="button" class="btn btn-primary" data-ci-job="${esc(ci.path)}">${esc(tr('notes.brief.ci.details'))}</button>
      <button type="button" class="btn" data-brief-review="${m.id}" data-iid="${esc(m.iid)}">${esc(tr('mr.btn.review'))}</button>
    </div>`).join('');

  /* B11 — CE QUE JE PEUX MERGER MAINTENANT. Une ligne, un nombre, une porte : le brief ne
     refait pas la file, il dit combien ne demandent plus rien. Rien n'est mergé d'ici. */
  const pretes = d.ready_to_merge ? `<div class="brief-item">
      <div class="brief-item-main"><div class="brief-item-title">${esc(tr('notes.brief.ready', { n: d.ready_to_merge, count: d.ready_to_merge }))}</div>
        <div class="brief-item-meta muted">${esc(tr('notes.brief.ready.hint', { seuil: d.ready_threshold }))}</div></div>
      <button type="button" class="btn btn-primary" data-brief-pretes>${esc(tr('notes.brief.ready.go'))}</button>
    </div>` : '';

  /* TOP 1 — LES REMARQUES ÉCRITES ET JAMAIS ENVOYÉES. La perte de travail la plus silencieuse
     de l'outil : on rédige trois commentaires inline dans le viewer, on referme pour aller voir
     autre chose, et la merge request se merge sans eux. Les plus anciens d'abord — c'est
     l'ancienneté qui inquiète, pas le nombre. Le bouton ouvre le viewer, là où ils s'envoient. */
  const brouillons = (d.drafts || []).map((b) => `<div class="brief-item">
      <div class="brief-item-main">
        <div class="brief-item-title">!${b.iid} — ${esc(String(b.title || '').slice(0, 80))}</div>
        <div class="brief-item-meta muted">${esc(b.project)} · ${esc(tr('notes.brief.drafts.n', { n: b.n, count: b.n }))}
          · <span data-when="${esc(b.depuis || '')}">${esc(depuis(b.depuis))}</span></div>
      </div>
      <button type="button" class="btn btn-primary" data-brief-drafts="${b.mr_id}">${esc(tr('notes.brief.drafts.go'))}</button>
    </div>`).join('');

  /* TOP 20 — LES SUIVIS ÉCRITS ET JAMAIS ENVOYÉS. Même famille, autre écran : on rédige une
     correction pendant que la session tourne, puis on passe à autre chose. Ceux qui partent
     tout seuls à la fin (« automatiquement ») sont dits comme tels — ils n'attendent personne. */
  const suivis = (d.followups || []).map((f) => `<div class="brief-item">
      <div class="brief-item-main">
        <div class="brief-item-title">${esc(f.texte)}</div>
        <div class="brief-item-meta muted">${esc(f.label)}${f.auto ? ` · ${esc(tr('notes.brief.followups.auto'))}` : ''}</div>
      </div>
      <button type="button" class="btn btn-primary" data-brief-session="${f.id}" data-brief-kind="${esc(f.kind)}">${esc(tr('notes.brief.session.go'))}</button>
    </div>`).join('');

  /* B14 — CE QUE GIT A LAISSÉ EN PLAN. Un merge résolu à moitié la veille au soir ne vit que
     dans un dossier de travail : aucun badge ne le rappelle, et on le retrouve trois jours plus
     tard en cherchant autre chose. Une opération en échec (branche non supprimée, tag refusé)
     ne se voyait qu'en rouvrant l'historique du lot. Les deux réclament un geste. */
  const gitSuspens = (d.git || []).map((g) => (g.kind === 'merge' ? `<div class="brief-item">
      <div class="brief-item-main">
        <div class="brief-item-title">${esc(g.source)} → ${esc(g.target)}</div>
        <div class="brief-item-meta muted">${esc(g.project)} · ${esc(tr(`git.merge.status.${g.status}`))}
          · <span data-when="${esc(g.at || '')}">${esc(depuis(g.at))}</span></div>
      </div>
      <button type="button" class="btn btn-primary" data-brief-merge="${g.merge_id}">${esc(tr('notes.brief.git.merge.go'))}</button>
    </div>` : `<div class="brief-item">
      <div class="brief-item-main">
        <div class="brief-item-title">${esc(tr('notes.brief.git.failed', { n: g.n, count: g.n }))} — <code>${esc(g.ref)}</code></div>
        <div class="brief-item-meta muted">${esc(g.project)}${g.error ? ` · ${esc(g.error)}` : ''}
          · <span data-when="${esc(g.at || '')}">${esc(depuis(g.at))}</span></div>
      </div>
      <button type="button" class="btn" data-brief-gitop="${esc(g.project)}">${esc(tr('notes.brief.git.op.go'))}</button>
    </div>`)).join('');

  /* TOP 14 — LES CONTENEURS TOMBÉS, tels que la veille de fond les a vus. Daté : c'est un
     relevé, pas un direct, et le dire évite de prendre une minute de retard pour une panne. */
  const dk = d.docker;
  const dockerBas = dk && (dk.containers || []).length ? (dk.containers.map((c) => `<div class="brief-item">
      <div class="brief-item-main">
        <div class="brief-item-title">${esc(c.name)}</div>
        <div class="brief-item-meta muted">${c.project ? `${esc(c.project)} · ` : ''}${esc(c.status || c.state)}</div>
      </div>
      <button type="button" class="btn" data-brief-docker="${esc(c.name)}" data-brief-project="${esc(c.project || '')}">${esc(tr('notes.brief.docker.go'))}</button>
    </div>`).join('') + `<p class="brief-item-meta muted">${esc(tr('notes.brief.docker.seen'))} <span data-when="${esc(dk.at)}">${esc(depuis(dk.at))}</span></p>`) : '';

  const a = d.activity;
  const activite = a ? `<p class="brief-activity">${[
    a.merged ? esc(tr('notes.brief.activity.merged', { n: a.merged, count: a.merged })) : '',
    a.opened ? esc(tr('notes.brief.activity.opened', { n: a.opened, count: a.opened })) : '',
    a.verified ? esc(tr('notes.brief.activity.verified', { n: a.verified, count: a.verified })) : '',
  ].filter(Boolean).join(' · ')}</p>` : '';

  const corps = [
    briefSection(tr('notes.brief.sec.reminders'), rappels, { icon: 'clock' }),
    briefSection(tr('notes.brief.sec.todos'), todos, { icon: 'check' }),
    briefSection(tr('notes.brief.sec.sessions'), sessions, { icon: 'bot' }),
    briefSection(tr('notes.brief.sec.verifications'), verifs, { icon: 'alert' }),
    briefSection(tr('notes.brief.sec.drafts'), brouillons, { icon: 'doc', hint: tr('notes.brief.drafts.hint') }),
    briefSection(tr('notes.brief.sec.followups'), suivis, { icon: 'repeat', hint: tr('notes.brief.followups.hint') }),
    briefSection(tr('notes.brief.sec.pending'), attentes, { icon: 'bot', hint: tr('notes.brief.pending.hint') }),
    briefSection(tr('notes.brief.sec.git'), gitSuspens, { icon: 'branch', hint: tr('notes.brief.git.hint') }),
    briefSection(tr('agents.brief.title'), agentsBrief, { icon: 'zap', hint: tr('agents.brief.hint') }),
    briefSection(tr('notes.brief.sec.fresh'), fresh, { icon: 'merge', hint: tr('notes.brief.fresh.hint') }),
    briefSection(tr('notes.brief.sec.stale'), stale, { icon: 'clock', hint: tr('notes.brief.stale.hint', { n: d.stale_days }) }),
    briefSection(tr('notes.brief.sec.ci'), ciCasse, { icon: 'alert' }),
    briefSection(tr('notes.brief.sec.docker'), dockerBas, { icon: 'inbox', hint: tr('notes.brief.docker.hint') }),
    briefSection(tr('notes.brief.sec.ready'), pretes, { icon: 'merge' }),
    briefSection(tr('notes.brief.sec.cleanup'), branches, { icon: 'branch' }),
    briefSection(tr('notes.brief.sec.activity'), activite, { icon: 'chart' }),
  ].join('');

  box.innerHTML = `<header class="brief-head">
      <div class="brief-hello">${esc(tr('notes.brief.hello'))}</div>
      <div class="brief-date">${esc(jour)}</div>
      <span class="spacer"></span>
      ${/* A/Notes 3 — LE DAILY. « Hier j'ai mergé deux MR, aujourd'hui il m'en reste trois à
            traiter » se retape tous les matins alors que le brief l'a sous les yeux. Cinq
            lignes de texte brut, prêtes à coller dans un canal ou un document — pas un
            export, un presse-papiers. */''}
      <button type="button" class="btn btn-sm" id="briefCopy" title="${esc(tr('notes.brief.copy.title'))}">${svgIco('copy')}${esc(tr('notes.brief.copy'))}</button>
    </header>
    ${corps || emptyState({ icon: 'check', title: esc(tr('notes.brief.empty.title')), text: esc(tr('notes.brief.empty.text')) })}
    ${d.hidden_count ? `<p class="brief-hidden-foot muted">${esc(tr('notes.brief.hidden', { n: d.hidden_count, count: d.hidden_count }))}
      <button type="button" class="btn btn-sm" id="briefRestore">${esc(tr('notes.brief.restore'))}</button></p>` : ''}`;
  const btnCopie = $('#briefCopy');
  if (btnCopie) {
    btnCopie.addEventListener('click', () => {
      copyText(texteDuDaily(d), null);
      toast(tr('notes.brief.copied'));
    });
  }
}

// Une ligne de todo dans le brief : cochable et snoozable sur place — c'est tout l'intérêt
// d'un brief, agir sans changer d'écran.
function briefTodoRow(t, avecSnooze) {
  return `<div class="brief-item todo-row" data-todo="${t.id}">
    <input type="checkbox" class="todo-check" data-todo-check="${t.id}" aria-label="${esc(tr('notes.todo.done'))}" />
    <div class="brief-item-main">
      <div class="brief-item-title">${esc(t.title)}</div>
      <div class="meta">${todoPrioBadge(t.priority)}${todoDueHtml(t)}${todoLinkHtml(t)}${todoEtatMr(t)}${todoEtatTicket(t)}</div>
    </div>
    ${avecSnooze ? todoSnoozeHtml(t.id) : ''}
  </div>`;
}

/* Les deux pastilles du menu Notes, calculées depuis les todos ouvertes déjà en mémoire :
   ROUGE = ce qui presse, BLEU = le reste à faire. Leur somme est le nombre de todos à faire.

   « Presse » n'est pas seulement la priorité haute : une todo normale dont l'échéance est
   dépassée depuis trois jours réclame autant. Compter la seule priorité aurait laissé le
   retard invisible dans le menu — et le retard est précisément ce qu'on vient d'oublier.
   La bulle énumère la composition, pour qu'un chiffre qui ne correspond pas au nombre de
   pastilles « Haute » s'explique de lui-même. */
function majBadgeNotes() {
  const rouge = $('#navTodoUrgent');
  const bleu = $('#navCountNotes');
  if (!rouge || !bleu) return;
  const maintenant = Date.now();
  const ouvertes = NOTES.open || [];
  const enRetard = ouvertes.filter((t) => t.due_at && new Date(t.due_at).getTime() <= maintenant);
  const hautes = ouvertes.filter((t) => t.priority === 'high' && !enRetard.includes(t));
  const urgentes = enRetard.length + hautes.length;
  const reste = ouvertes.length - urgentes;

  const poser = (el, n, bulle) => {
    el.hidden = !n;
    el.textContent = String(n);
    el.dataset.tip = bulle;
    /* `title = ''` et non l'absence de title : sur un enfant, un title VIDE empêche le
       navigateur de remonter à celui du bouton parent — sans ça, survoler le chiffre
       afficherait « Notes, todos et rappels… » par-dessus notre bulle. */
    el.title = '';
    el.setAttribute('aria-label', bulle);
  };
  poser(rouge, urgentes, [
    enRetard.length ? tr('nav.todos.late', { n: enRetard.length, count: enRetard.length }) : '',
    hautes.length ? tr('nav.todos.high', { n: hautes.length, count: hautes.length }) : '',
  ].filter(Boolean).join(' · '));
  poser(bleu, reste, tr('nav.todos.rest', { n: reste, count: reste }));
}

document.addEventListener('click', async (e) => {
  /* La croix EST dans une ligne cliquable (une MR ouvre son rapport) : elle se teste donc en
     premier, sinon écarter une ligne l'ouvrirait en même temps. */
  const h = e.target.closest && e.target.closest('[data-brief-hide]');
  if (h) {
    const [kind, ...reste] = h.dataset.briefHide.split(':');
    try {
      await busy(h, () => api('/brief/hidden', { method: 'POST', body: { kind, ref: reste.join(':') } }));
      toast(tr('toast.brief-ecarte')); loadBrief();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  const r = e.target.closest && e.target.closest('#briefRestore');
  if (r) {
    try {
      await busy(r, () => api('/brief/hidden', { method: 'DELETE' }));
      toast(tr('toast.brief-restaure')); loadBrief();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  /* Le brief mène À LA SESSION, pas à l'onglet : il nomme un objet précis, l'ouvrir sur une
     liste de douze cartes ferait recommencer la recherche qu'il vient d'épargner. */
  const s = e.target.closest && e.target.closest('[data-brief-session]');
  if (s) { ouvrirSession(s.dataset.briefSession, s.dataset.briefKind || 'code'); return; }
  /* TOP 1 — les remarques jamais envoyées : on ouvre le viewer, là où elles s'envoient. */
  const bd = e.target.closest && e.target.closest('[data-brief-drafts]');
  if (bd) {
    /* On ouvre le VIEWER, pas seulement le rapport : c'est là que vivent les commentaires
       inline et le bouton « Envoyer les commentaires ». Appelé directement plutôt que par un
       clic différé sur le bouton de l'écran — attendre un rendu au chronomètre est le genre de
       pari que ce projet refuse partout ailleurs. */
    const id = Number(bd.dataset.briefDrafts);
    navMrReport(id);
    await openSplit(id);
    return;
  }
  /* B14 — le merge laissé à moitié : on va dans l'écran où le dossier de travail attend. */
  const bm = e.target.closest && e.target.closest('[data-brief-merge]');
  if (bm) { navTab('git'); showGitSub('merge'); return; }
  /* …et l'opération en échec : l'historique, filtré sur le projet et sur les seuls échecs.
     On remplit les VRAIS champs de filtre et on rejoue le filtrage, plutôt que d'écrire un
     second chemin de recherche qui dériverait du premier. */
  const bo = e.target.closest && e.target.closest('[data-brief-gitop]');
  if (bo) {
    navTab('git'); showGitSub('history');
    const f = $('#gitHistFilter'); const err = $('#gitHistErrOnly');
    if (f) f.value = bo.dataset.briefGitop || '';
    if (err) err.checked = true;
    filtrerHistoriqueGit();
    return;
  }
  /* Un conteneur tombé : l'onglet Docker, sur le sous-onglet où il VIT — un service compose
     n'est pas au même endroit qu'un container lancé à la main, et arriver sur le mauvais des
     deux oblige à chercher ce qu'on venait de trouver. */
  const bdk = e.target.closest && e.target.closest('[data-brief-docker]');
  if (bdk) { navTab('docker'); showDockerSub(bdk.dataset.briefProject ? 'compose' : 'orphans'); return; }
  /* B7 — la carte du domaine touché : on l'ouvre, en lecture, là où elle vit. */
  const mc = e.target.closest && e.target.closest('[data-mr-card]');
  if (mc) {
    navTab('agents');
    showAgentsSub('list');
    await loadAgentList();
    const ag = agentDe(mc.dataset.mrCard);
    if (ag) await ouvrirConnaissance(ag);
    return;
  }
  /* B4 — une note qui cite cette merge request : on l'ouvre là où elle vit. */
  const cp = e.target.closest && e.target.closest('[data-cite-page]');
  if (cp) { navTab('notes'); showNotesSub('pages'); openNotePage(Number(cp.dataset.citePage)); return; }
  /* Une page écrite par un agent pendant la nuit : on l'ouvre là où elle vit. */
  const ap = e.target.closest && e.target.closest('[data-brief-agent-page]');
  if (ap) { navTab('notes'); showNotesSub('pages'); openNotePage(Number(ap.dataset.briefAgentPage)); return; }
  /* Une connaissance à valider : on ouvre SA modale, et on clique le VRAI bouton — une seule
     implémentation du geste, comme pour « Corriger » ci-dessous. */
  const ar = e.target.closest && e.target.closest('[data-brief-agent-review]');
  if (ar) {
    navTab('agents');
    showAgentsSub('list');
    await loadAgentList();
    const a = agentDe(ar.dataset.briefAgentReview);
    if (a) await ouvrirConnaissance(a, { pending: true });
    return;
  }
  /* CORRIGER, depuis le brief. Le rapport de vérification a déjà son bouton « Corriger » —
     on l'ouvre, et on clique le VRAI bouton : une seule implémentation du geste, et ce qui
     est impossible (verdict autre qu'un échec) reste impossible. */
  const vf = e.target.closest && e.target.closest('[data-brief-verif-fix]');
  if (vf) {
    e.stopPropagation();
    await openVerifyReport(Number(vf.dataset.briefVerifFix));
    const fix = $('#verifyFix');
    if (fix && !fix.hidden) fix.click();
    return;
  }
  // Reviewer une merge request fraîche, sans quitter le brief : c'est le geste qui la ferme.
  const rv = e.target.closest && e.target.closest('[data-brief-review]');
  if (rv) {
    e.stopPropagation();
    try {
      await busy(rv, () => api(`/mrs/${rv.dataset.briefReview}/review`, { method: 'POST' }));
      toast(tr('toast.review-de-lancee', { iid: rv.dataset.iid })); refreshStatus();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  /* Les trois attentes mènent à Dev IA sur la saveur « codage » — c'est là que vivent les
     sessions à lancer, à pousser, à transformer en merge request. */
  // Le nettoyage des branches mène à Git → Actions, où le lot se pré-remplit.
  const br = e.target.closest && e.target.closest('[data-brief-branches]');
  if (br) {
    e.stopPropagation();
    navTab('git');
    showGitSub('actions');
    const b2 = $('#gitMergedFill');
    if (b2) b2.click();
    return;
  }
  const sg = e.target.closest && e.target.closest('[data-brief-sess-go]');
  if (sg) {
    e.stopPropagation();
    navTab('task');
    const sous = $('#tab-task .subnav [data-kind="code"]');
    if (sous) sous.click();
    return;
  }
  const att = e.target.closest && e.target.closest('[data-brief-sess]');
  if (att) { navTab('task'); return; }
  const v = e.target.closest && e.target.closest('[data-brief-verif]');
  if (v) { openVerifyReport(Number(v.dataset.briefVerif)); return; }
  const m = e.target.closest && e.target.closest('[data-brief-mr]');
  if (m) navMrReport(Number(m.dataset.briefMr));
});

