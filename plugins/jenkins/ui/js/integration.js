'use strict';
/* Ce que Jenkins apporte AUX AUTRES ÉCRANS, par le kit : l'ouverture de l'onglet, le badge
   « dernier build sur cette branche » (cartes de merge request, explorateur Git, sessions), le
   bouton « Lancer <job> » (merge request vérifiée verte, rapport de vérification, branche),
   « Reprendre la console » dans le suivi d'une session, la section « CI rouge » du brief, le
   lien de todo vers un build, la notification de fin de build, la palette, l'onboarding.

   Rien ici n'est appelé par le cœur par son nom : le cœur demande « qu'est-ce qu'un plugin
   rend pour cette cible ? » et Jenkins répond. */

/* ---------- L'onglet, et la cadence de rafraîchissement ---------- */
ui.onTabOpen('jenkins', () => loadJenkins());
ui.onSettingsTab('jenkinscfg', () => loadJenkinsConfig());

/* La cadence vient des RÉGLAGES du plugin (Réglages → Jenkins) : c'est un réglage de l'outil,
   pas du navigateur. Lue au chargement, puis à chaque enregistrement — un changement s'applique
   sans recharger la page. 0 = jamais. */
function jkPoserCadence(s) {
  const ms = Number(s && s.jenkins_refresh_minutes) > 0 ? Number(s.jenkins_refresh_minutes) * 60000 : 0;
  if (ms !== jkPeriodeMs) { jkPeriodeMs = ms; jkAutoRelance(); }
}
ui.settings.get('jenkins').then(jkPoserCadence).catch(() => {});
ui.settings.onChange('jenkins', jkPoserCadence);

/* ---------- B2 : le dernier build qui porte CETTE branche ----------
   On pousse depuis la session, `front-build` casse sur la branche, et la carte de !219 dit
   « vérifié » — le vérificateur de Mergerie est vert, Jenkins fait autre chose. On le
   découvrait une heure plus tard en ouvrant l'onglet.

   Aucun appel de plus : la liste est déjà chargée (ouverture de l'onglet ou intervalle réglé),
   et chaque job porte la branche de son dernier build. On croise sur le NOM DE BRANCHE, et on
   l'écrit sur la carte — sans jamais le confondre avec le verdict objectif, qui est un autre
   badge, d'une autre couleur, avec un autre mot. */
/* La liste est chargée à l'ouverture de SON onglet. Pour que le badge existe sur une carte de
   merge request sans y être passé, on la demande UNE FOIS par chargement de page — et seulement
   si Jenkins est configuré. C'est le même appel que fait l'onglet, fait plus tôt : pas un
   sondage, et rien de plus quand on ouvre ensuite Jenkins (la liste est déjà là). */
let jenkinsPourCI = false;
async function assurerJenkinsPourCI() {
  if (jenkinsPourCI || (JENKINS.jobs || []).length) return;
  jenkinsPourCI = true;
  try {
    const d = await api('/plugins/jenkins/jobs');
    if (!d || !d.configured) return;
    JENKINS.jobs = d.jobs || [];
    JENKINS.configured = true;
    // La file est peut-être déjà affichée : elle se redessine avec les badges.
    reviews.reload();
    notes.refreshBrief();
  } catch { /* Jenkins injoignable : pas de badge, et rien à signaler ici */ }
}

function ciDeLaBranche(branche) {
  const b = String(branche || '').trim();
  if (!b || !(JENKINS.jobs || []).length) return null;
  const j = (JENKINS.jobs || []).find((x) => String(x.ref || '').trim() === b);
  if (!j || !j.lastNumber) return null;
  return { path: j.path, number: j.lastNumber, statut: j.statut, enCours: !!j.enCours };
}
function badgeCI(branche) {
  assurerJenkinsPourCI();          // une fois par page : le badge a besoin de la liste
  const ci = ciDeLaBranche(branche);
  if (!ci) return '';
  /* LE VOCABULAIRE DE JENKINS, PAS UN AUTRE : `succes` / `echec` / `instable` / `desactive` /
     `inconnu`, tels que le serveur les normalise. */
  const ok = ci.statut === 'succes';
  const rouge = ci.statut === 'echec';
  const cls = ci.enCours ? 'to_review' : (ok ? 'done' : (rouge ? 'stale' : (ci.statut === 'instable' ? 'to_review' : '')));
  const signe = ci.enCours ? '⋯' : (ok ? '✓' : (rouge ? '✗' : '~'));
  return `<button type="button" class="tag ${cls}" data-ci-job="${esc(ci.path)}" title="${esc(tr('jenkins.ci.title', { job: ci.path }))}">CI #${ci.number} ${signe}</button>`;
}
ui.onDecorator('ci-badge-mr', (m) => badgeCI(m.source_branch));
ui.onDecorator('ci-badge-branch', (o) => badgeCI(o.branch && o.branch.name));
ui.onDecorator('ci-badge-session', (o) => badgeCI(o.target && o.target.branch));
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-ci-job]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  navTab('jenkins');
  openJenkinsJob(b.dataset.ciJob);
});

/* ---------- B8 : « Lancer <job> » avec la branche pré-remplie ----------
   Le job est déclaré pour le dépôt (Réglages → Jenkins) : il apparaît sur une merge request
   VÉRIFIÉE VERTE, sur un rapport de vérification vert, sur une ligne de l'explorateur Git. On
   ouvre la FICHE (jamais un lancement direct) : les paramètres se lisent, et le bouton reste à
   cliquer. La liste des liens est minuscule et chargée une fois par page. */
let jkLiensParDepot = null;
async function assurerLiensParDepot() {
  if (jkLiensParDepot) return jkLiensParDepot;
  jkLiensParDepot = new Map();
  try {
    const d = await api('/plugins/jenkins/links');
    for (const l of (d.links || [])) {
      if (!jkLiensParDepot.has(l.repo_id)) jkLiensParDepot.set(l.repo_id, []);
      jkLiensParDepot.get(l.repo_id).push({ path: l.job_path, param: l.param || '' });
    }
    if (jkLiensParDepot.size) reviews.reload();   // les cartes déjà affichées gagnent leur bouton
  } catch { /* pas de lien : rien à proposer, c'est le cas courant */ }
  return jkLiensParDepot;
}
const jobsDuDepot = (repoId) => (jkLiensParDepot && jkLiensParDepot.get(Number(repoId))) || [];
const boutonJob = (j, branche, { menu = false, icone = false } = {}) => (menu
  ? `<button role="menuitem" data-mr-jenkins="${esc(j.path)}" data-param="${esc(j.param || '')}" data-branch="${esc(branche)}" title="${esc(tr('jenkins.mr.run-title'))}">${esc(tr('jenkins.mr.run', { job: j.path }))}</button>`
  : (icone
    ? `<button class="btn btn-sm btn-ghost" data-mr-jenkins="${esc(j.path)}" data-param="${esc(j.param || '')}" data-branch="${esc(branche)}" title="${esc(tr('jenkins.branch.title', { job: j.path, branch: branche }))}">${svgIco('pipeline')}</button>`
    : `<button type="button" class="btn" data-mr-jenkins="${esc(j.path)}" data-param="${esc(j.param || '')}" data-branch="${esc(branche)}" title="${esc(tr('jenkins.mr.run-title'))}">${esc(tr('jenkins.mr.run', { job: j.path }))}</button>`));
ui.onAction('run-job', {
  render: (m) => ((m.verification && m.verification.verdict === 'verified_pass' && !m.verification.stale)
    ? jobsDuDepot(m.repo_id).map((j) => boutonJob(j, m.source_branch, { menu: true })).join('') : ''),
});
ui.onAction('verif-job', { render: (m) => jobsDuDepot(m.repo_id).slice(0, 1).map((j) => boutonJob(j, m.source_branch)).join('') });
ui.onAction('branch-job', { render: (o) => (o.branch && !o.branch.default ? jobsDuDepot(o.repo_id).slice(0, 1).map((j) => boutonJob(j, o.branch.name, { icone: true })).join('') : '') });
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-mr-jenkins]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  navTab('jenkins');
  await openJenkinsJob(b.dataset.mrJenkins);
  const nom = b.dataset.param;
  if (!nom) return;
  const champ = $(`#jenkinsModalBody [data-jkparam="${CSS.escape(nom)}"]`);
  if (champ) jkPoserParams([{ name: nom, value: b.dataset.branch }]);
});

/* B17 — la fiche d'un dépôt (Réglages → Dépôts) : ses jobs liés, chacun une porte vers la fiche du job. */
ui.onDecorator('repo-sheet-jobs', (d) => {
  const jobs = jobsDuDepot(d.id);
  if (!jobs.length) return '';
  return `<div class="repo-sheet-sec"><h5>${esc(tr('jenkins.repo-sheet'))}</h5><ul>${jobs.map((j) => `<li><button type="button" class="lien-reglage" data-sheet-jenkins="${esc(j.path)}">${esc(j.path)}</button>${j.param ? ` <span class="muted">${esc(j.param)}</span>` : ''}</li>`).join('')}</ul></div>`;
});
document.addEventListener('click', async (e) => {
  const j = e.target.closest && e.target.closest('[data-sheet-jenkins]');
  if (!j) return;
  navTab('jenkins'); await loadJenkins(); openJenkinsJob(j.dataset.sheetJenkins);
});

/* ---------- B3 : la console d'un build rouge dans le suivi d'une session ----------
   `CI #42 ✗ · Module not found` : on ouvrait Détails, on sélectionnait la console à la souris, on
   copiait, on ouvrait « Envoyer un suivi », on collait, on expliquait. Le bouton fait le même
   chemin que « Reprendre le rapport de vérif », avec le texte que Jenkins a écrit. Le verdict
   reste celui de Jenkins : l'agent ne reçoit que le texte à corriger. */
ui.onAction('session-ci', {
  render: ({ task, target }) => {
    const ci = ciDeLaBranche(target && target.branch);
    return ci && ci.statut === 'echec' && !ci.enCours && ['committed', 'pushed', 'error'].includes(target.status)
      ? `<button class="btn btn-sm" data-followci="${task.id}" data-tgci="${target.id}" data-job="${esc(ci.path)}" data-build="${ci.number}"
           title="${esc(tr('jenkins.followup.title', { job: ci.path, n: ci.number }))}">${svgIco('bot')}${esc(tr('jenkins.followup.btn'))}</button>`
      : '';
  },
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-followci]');
  if (!b) return;
  const champ = sessions.followupField(b.dataset.followci, b.dataset.tgci);
  if (!champ) return;
  try {
    const d = await busy(b, () => api(`/plugins/jenkins/console?path=${encodeURIComponent(b.dataset.job)}&build=${encodeURIComponent(b.dataset.build)}`));
    const lignes = String((d && d.text) || '').split('\n').filter((l) => l.trim()).slice(-30).join('\n');
    if (!lignes) { toast(tr('jenkins.build.tail-empty'), true); return; }
    if (champ.value.trim() && !await confirmDialog({
      title: tr('jenkins.followup.confirm.title'),
      text: tr('jenkins.followup.confirm.text'),
      confirmLabel: tr('jenkins.followup.btn'),
      danger: false,
    })) return;
    champ.value = tr('jenkins.followup.prompt', { job: b.dataset.job, n: b.dataset.build, log: lignes });
    champ.focus();
    champ.dispatchEvent(new Event('input', { bubbles: true }));   // l'autosave doit le voir
    toast(tr('jenkins.followup.filled', { n: b.dataset.build }));
  } catch (err) { toast(explainError(err.message), true); }
});

/* ---------- B4 : ce que Jenkins a cassé sur MES branches, dans le brief ----------
   Le brief listait les vérifications rouges de l'outil et ignorait la CI de l'équipe : le
   nightly cassait à 23 h et on l'apprenait à 11 h par un collègue. Calculé À L'OUVERTURE,
   depuis la liste que l'onglet charge déjà — aucun sondage, aucune requête de plus : on croise
   les jobs rouges avec les branches de mes merge requests ouvertes. La liste arrive APRÈS le
   brief, qui se redessine alors (`notes.refreshBrief`). Sans Jenkins configuré, la section
   n'existe pas. */
ui.onBriefSection('ci-rouge', () => {
  if (!(JENKINS.jobs || []).length) { assurerJenkinsPourCI(); return ''; }
  const rouges = reviews.rows()
    .filter((m) => !m.closed_seen)
    .map((m) => ({ m, ci: ciDeLaBranche(m.source_branch) }))
    .filter((x) => x.ci && x.ci.statut === 'echec' && !x.ci.enCours)
    // une même branche peut porter deux MR : on ne le dit qu'une fois
    .filter((x, i, tous) => tous.findIndex((y) => y.ci.path === x.ci.path && y.m.source_branch === x.m.source_branch) === i)
    .slice(0, 8);
  return rouges.map(({ m, ci }) => `<div class="brief-item">
      <div class="brief-item-main">
        <div class="brief-item-title">${esc(ci.path)} <span class="muted">#${esc(String(ci.number))}</span></div>
        <div class="brief-item-meta muted">${esc(tr('jenkins.brief.on', { branch: m.source_branch, iid: m.iid }))}</div>
      </div>
      <button type="button" class="btn btn-primary" data-ci-job="${esc(ci.path)}">${esc(tr('jenkins.brief.details'))}</button>
      <button type="button" class="btn" data-brief-review="${m.id}" data-iid="${esc(m.iid)}">${esc(tr('jenkins.brief.review-btn'))}</button>
    </div>`).join('');
});

/* ---------- B16 : une todo liée à un build (`<job>#<numéro>`) rouvre la fiche du job ---------- */
ui.onLinkKind('build', {
  render: (t) => {
    const [chemin, num] = String(t.link_ref).split('#');
    return `<button type="button" class="note-link" data-todo-build="${esc(chemin)}" title="${esc(tr('jenkins.todo.link-title'))}">${svgIco('pipeline')} ${esc(tr('jenkins.todo.link', { job: chemin, n: num || '' }))}</button>`;
  },
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-todo-build]');
  if (!b) return;
  navTab('jenkins'); await loadJenkins(); openJenkinsJob(b.dataset.todoBuild);
});

/* ---------- La fin d'un build QUE J'AI LANCÉ ----------
   L'événement vient du serveur : il arrive donc l'onglet fermé, l'onglet Jenkins jamais ouvert,
   ou la page rechargée entre-temps. */
ui.onNotif('jenkins_done', (e) => ({
  title: tr('jenkins.notif.title', { job: e.path }),
  body: tr(`jenkins.notif.${e.ok ? 'ok' : 'ko'}`, { number: e.number || '', result: e.result || '' }),
  onClick: () => { navTab('jenkins'); openJenkinsJob(e.path); },
}));

/* ---------- La palette : « Aller à Jenkins », et ouvrir un job rattaché ---------- */
ui.registerPaletteAction({ label: tr('jenkins.palette.go'), tab: 'jenkins', run: () => { const b = ui.tabButton('jenkins'); if (b) b.click(); } });
ui.onPaletteResult('jenkins', (nav) => {
  if (!nav.jenkins_path) return;
  navTab('jenkins'); loadJenkins().then(() => openJenkinsJob(nav.jenkins_path));
});

/* L'état vide de l'onglet mène aux réglages de la connexion. */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-empty-act="jenkins-config"]');
  if (!b) return;
  navTab('admin'); settings.showTab('jenkinscfg');
  const champ = $('[name="jenkins_url"]');
  if (champ) champ.focus();
});

/* Au chargement : le badge du jour sans ouvrir l'onglet (comme Docker), et les jobs liés aux
   dépôts pour les boutons des cartes. */
amorcerBadgeJenkins();
assurerLiensParDepot();
