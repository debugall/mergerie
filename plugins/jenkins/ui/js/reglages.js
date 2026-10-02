'use strict';
/* B8 : la liste des jobs Jenkins liés aux dépôts. */
/* ---------- B8 : la liste des jobs Jenkins liés aux dépôts ---------- */
/* C10 — LE JOB ET SON PARAMÈTRE SE CHOISISSENT. Les deux étaient des champs libres, tapés à
   la lettre près : une faute de frappe donnait un lien qui ne se déclencherait jamais, sans
   rien pour le dire. La liste des jobs est déjà en mémoire (l'onglet Jenkins la charge), et
   les paramètres du dernier lancement de chaque job avec elle. Un combo AVEC RECHERCHE, comme
   partout où l'on choisit dans une longue liste — `npm run check` l'exige d'ailleurs. */
function renderJenkinsLinkPickers() {
  const boxJob = $('#jenkinsLinkJobBox');
  const boxParam = $('#jenkinsLinkParamBox');
  if (!boxJob || !boxParam) return;
  boxJob.innerHTML = comboHtml('jl-job', { ph: tr('jenkins.settings.links.job-ph') });
  boxParam.innerHTML = comboHtml('jl-param', { ph: tr('jenkins.settings.links.param-ph') });
  /* Réglages peut s'ouvrir SANS être passé par l'onglet Jenkins : la liste est alors vide, et
     un combo vide vaut moins qu'un champ libre. On la charge à la première ouverture du menu. */
  wireCombo(boxJob, 'jl-job', async () => {
    if (!(JENKINS.jobs || []).length) {
      try { const d = await api('/plugins/jenkins/jobs'); if (d && d.configured) JENKINS.jobs = d.jobs || []; } catch { /* injoignable */ }
    }
    return (JENKINS.jobs || []).map((j) => ({ value: j.path, label: j.path }));
  });
  /* Les paramètres proposés sont ceux du job CHOISI : proposer ceux de tous les jobs
     mélangerait `ENV` de l'un et `BRANCH` de l'autre, et on lierait sur un nom qui n'existe
     pas dans ce job-là. */
  wireCombo(boxParam, 'jl-param', () => {
    const choisi = (($('#jenkinsLinkJobBox .jl-job') || {}).value || '').trim();
    const j = (JENKINS.jobs || []).find((x) => x.path === choisi);
    return [...new Set((j && j.lastParams ? j.lastParams : []).map((p) => p.name))]
      .map((n) => ({ value: n, label: n }));
  });
}

/* Le sous-onglet Jenkins : la connexion (réglages du plugin) ET la liste des jobs liés. */
async function loadJenkinsConfig() {
  const f = $('#jenkinsConfigForm');
  if (f) {
    try {
      const s = await ui.settings.get('jenkins');
      f.jenkins_url.value = s.jenkins_url || '';
      f.jenkins_user.value = s.jenkins_user || '';
      f.jenkins_token.value = s.jenkins_token || '';
      f.jenkins_refresh_minutes.value = Number(s.jenkins_refresh_minutes) || 0;
    } catch (e) { toast(explainError(e.message), true); }
  }
  majEtatConnexionJenkins();
  loadJenkinsLinks();
}

/* Ce que le formulaire enverrait : le masque « *** » veut dire « garde le jeton ». */
function corpsJenkins(f) {
  const body = { jenkins_url: f.jenkins_url.value.trim(), jenkins_user: f.jenkins_user.value.trim(), jenkins_refresh_minutes: f.jenkins_refresh_minutes.value };
  if (f.jenkins_token.value !== '***') body.jenkins_token = f.jenkins_token.value;
  return body;
}
async function enregistrerJenkins(info) {
  const f = $('#jenkinsConfigForm');
  const s = await ui.settings.save('jenkins', corpsJenkins(f));
  f.jenkins_token.value = s.jenkins_token || '';
  if (info) info.textContent = tr('plugins.settings.saved');
  return s;
}
$('#jenkinsConfigForm') && $('#jenkinsConfigForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const info = $('#configInfoJenkins');
  try { await enregistrerJenkins(info); } catch (err) { if (info) info.textContent = ''; toast(explainError(err.message), true); }
});

/* Le souvenir du dernier test de connexion : « est-ce que ça marchait, la dernière fois que
   quelqu'un a regardé ? » — un geste noté, jamais une surveillance. */
async function majEtatConnexionJenkins() {
  const info = $('#configInfoJenkins');
  if (!info) return;
  try {
    const d = await api('/plugins/jenkins/status');
    const t = d.lastTest;
    info.textContent = t ? `${t.ok ? '✓' : '✗'} ${t.detail || ''} · ${fmtDateTime(t.tested_at)}` : '';
  } catch { /* rien à dire */ }
}

/* Tester Jenkins : on teste les valeurs SAISIES, et le masque veut dire « garde le jeton déjà
   enregistré ». Le nom du compte rendu par Jenkins prouve que le couple utilisateur/jeton est le
   bon, pas seulement que l'URL répond. La garde à vide pose l'erreur SOUS le premier champ
   manquant — un test de connexion échoue à cause d'un champ, pas d'un écran. */
$('#btnTestJenkins') && $('#btnTestJenkins').addEventListener('click', async () => {
  const f = $('#jenkinsConfigForm');
  const info = $('#configInfoJenkins');
  viderErreursChamps($('#sub-jenkinscfg'));
  const vide = [f.jenkins_url, f.jenkins_user, f.jenkins_token].find((c) => !String(c.value || '').trim());
  if (vide) { signalerChamp(vide, tr('jenkins.err.test-incomplete')); info.textContent = ''; return; }
  try {
    await enregistrerJenkins(null);
    info.textContent = tr('jenkins.settings.testing');
    const r = await busy($('#btnTestJenkins'), () => api('/plugins/jenkins/test', { method: 'POST', body: {
      jenkins_url: f.jenkins_url.value.trim(), jenkins_user: f.jenkins_user.value.trim(), jenkins_token: f.jenkins_token.value,
    } }));
    info.textContent = tr('jenkins.settings.ok', { user: r.user, n: r.jobs, count: r.jobs });
  } catch (e) {
    info.textContent = '';
    toast(explainError(e.message), true);
  }
});

async function loadJenkinsLinks() {
  const box = $('#jenkinsLinkRepo');
  if (box) {
    // Choix de dépôt AVEC RECHERCHE, comme partout : `npm run check` refuse une liste sans.
    await repos.load();
    box.innerHTML = repoComboHtml(null, { idClass: 'jl-repo', defaultFirst: true });
    wireRepoCombos(box);
  }
  renderJenkinsLinkPickers();
  const el = $('#jenkinsLinkList');
  if (!el) return;
  let d;
  try { d = await api('/plugins/jenkins/links'); } catch { d = { links: [] }; }
  el.innerHTML = (d.links || []).length
    ? (d.links || []).map((l) => `<div class="card repo-row">
        <div class="repo-view"><div style="min-width:0">
          <div class="title">${esc(l.project)} <span class="muted">→</span> <code>${esc(l.job_path)}</code></div>
          ${l.param ? `<div class="meta muted">${esc(tr('jenkins.settings.links.param'))} : <code>${esc(l.param)}</code></div>` : ''}
        </div>
        <div class="spacer"></div>
        <button class="btn btn-icon btn-sm btn-danger" data-jl-del="${l.id}" title="${esc(tr('ui.delete'))}"><svg class="ico"><use href="#i-close"/></svg></button>
        </div></div>`).join('')
    : `<p class="muted">${esc(tr('jenkins.settings.links.empty'))}</p>`;
}
$('#jenkinsLinkForm') && $('#jenkinsLinkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  viderErreursChamps(f);
  const repoId = Number(($('#jenkinsLinkRepo .jl-repo') || {}).value || 0);
  if (!repoId) { toast(tr('err.depot-introuvable'), true); return; }
  /* LE COMBO PROPOSE, IL N'IMPOSE PAS. Un job que le compte ne voit pas (droits, dossier
     filtré) doit rester saisissable : on prend la valeur choisie, à défaut ce qui est TAPÉ. */
  const saisi = (cls, box) => {
    const cache = $(`.${cls}`, box);
    const visible = $('[data-combo]', box);
    return String((cache && cache.value) || (visible && visible.value) || '').trim();
  };
  const job = saisi('jl-job', $('#jenkinsLinkJobBox'));
  const param = saisi('jl-param', $('#jenkinsLinkParamBox'));
  if (!job) return void signalerChamp($('#jenkinsLinkJobBox [data-combo]'), tr('jenkins.err.job-required'));
  try {
    await api('/plugins/jenkins/links', { method: 'POST', body: { repo_id: repoId, job_path: job, param } });
    renderJenkinsLinkPickers();
    loadJenkinsLinks();
  } catch (err) { toast(explainError(err.message), true); }
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-jl-del]');
  if (!b) return;
  try { await api(`/plugins/jenkins/links/${b.dataset.jlDel}`, { method: 'DELETE' }); loadJenkinsLinks(); }
  catch (err) { toast(explainError(err.message), true); }
});

