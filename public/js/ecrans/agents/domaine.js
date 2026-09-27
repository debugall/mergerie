'use strict';
/* Agents de domaine : créer, relire, mettre à jour, le diff de lignes. */
// @expose agentFiltreSessions, ouvrirConnaissance
/* ==================== AGENTS DE DOMAINE : créer, relire, mettre à jour ====================
   Le cartographe est l'agent dont la SORTIE crée un autre agent. On lui donne un sujet ; il
   rend un document à structure imposée précédé d'un en-tête que Mergerie parse. La création
   est directe (l'agent créé n'a aucun effet tant qu'on ne le lance pas) ; la mise à jour, elle,
   attend une validation — c'est la seule sortie d'agent qui le fasse. */

let agentFiltreSessions = 0;
let knowledgeAgent = null;
let knowledgeVersion = null;

async function ouvrirDomainModal() {
  await loadRepoOptions();
  $('#domainSubject').value = '';
  $('#domainRepos').innerHTML = repoOptions.map((r) => `<label class="inline-check" data-cherche="${esc(r.project.toLowerCase())}">
      <input type="checkbox" class="dom-repo" value="${r.id}" /><span>${esc(r.project)}</span></label>`).join('')
    + `<div class="muted" data-no-match hidden>${esc(tr('agents.skills.no-match'))}</div>`;
  $('#domainModal').hidden = false;
  $('#domainSubject').focus();
}

onEl($('#btnNewDomainAgent'), 'click', ouvrirDomainModal);
onEl($('#domainCancel'), 'click', () => { $('#domainModal').hidden = true; });
onEl($('#domainForm'), 'submit', async (e) => {
  e.preventDefault();
  const subject = $('#domainSubject').value.trim();
  if (!subject) return;
  const repo_ids = $$('#domainRepos .dom-repo:checked').map((c) => Number(c.value));
  try {
    await busy($('#domainStart'), () => api('/agents/domain', { method: 'POST', body: { subject, repo_ids } }));
    $('#domainModal').hidden = true;
    toast(tr('agents.domain.started'));
    // La cartographie est une session comme une autre : on va la regarder tourner.
    navTab('task');
    loadTasks();
    refreshStatus();
  } catch (err) { toast(explainError(err.message), true); }
});

async function ouvrirConnaissance(a, { pending = false } = {}) {
  knowledgeAgent = a;
  $('#knowledgeTitle').textContent = `${a.name} — ${tr('agents.knowledge.title')}`;
  const vs = await api(`/agents/${a.id}/knowledge`).catch(() => []);
  /* CHAQUE VERSION DIT CE QU'ELLE COÛTE À LIRE. Une carte part dans le prompt de chaque run :
     voir une v4 passer de huit à trente mille tokens est la seule façon de s'apercevoir
     qu'elle a enflé, et de décider de l'élaguer avant que chaque run le paie. */
  $('#knowledgeVersions').innerHTML = vs.map((v) => `<button type="button" class="knowledge-version" data-id="${v.version}">
      <strong>v${v.version}</strong> <span class="badge k-${esc(v.status)}">${esc(tr(`agents.knowledge.status.${v.status}`))}</span>
      <span class="muted">${esc(fmtDate(v.created_at))}</span>
      ${v.tokens ? `<span class="muted knowledge-tok">${esc(tr('agents.card.tokens', { n: fmtMilliers(v.tokens) }))}</span>` : ''}
      ${v.unverified ? `<span class="badge k-warn">${esc(tr('agents.card.unverified', { n: v.unverified, count: v.unverified }))}</span>` : ''}
    </button>`).join('') || `<div class="muted">${esc(tr('agents.knowledge.none'))}</div>`;
  const choisie = pending ? (vs.find((v) => v.status === 'pending') || vs[0]) : (vs.find((v) => v.status === 'active') || vs[0]);
  $('#knowledgeModal').hidden = false;
  if (choisie) await montrerVersion(choisie.version);
}

async function montrerVersion(n) {
  knowledgeVersion = n;
  $$('#knowledgeVersions .knowledge-version').forEach((b) => b.classList.toggle('active', Number(b.dataset.id) === Number(n)));
  const v = await api(`/agents/${knowledgeAgent.id}/knowledge/${n}`);
  $('#knowledgeBody').innerHTML = mdToHtml(v.content || '', IA);
  $('#knowledgeBody').hidden = false;
  $('#knowledgeEdit').hidden = true;
  $('#knowledgeEdit').value = v.content || '';
  $('#knowledgeSave').hidden = true;
  $('#knowledgeValidate').hidden = v.status !== 'pending';
  const box = $('#knowledgeDiff');
  box.hidden = v.status !== 'pending';
  if (v.status === 'pending') {
    const active = await api(`/agents/${knowledgeAgent.id}/knowledge`).then((l) => l.find((x) => x.status === 'active'));
    const avant = active ? (await api(`/agents/${knowledgeAgent.id}/knowledge/${active.version}`)).content : '';
    box.innerHTML = `<p class="muted">${esc(v.diff_summary || '')}</p>${diffLignesHtml(avant, v.content || '')}`;
  }
}

/* Un diff de LIGNES, calculé ici : la plus longue sous-séquence commune, puis ce qui reste de
   part et d'autre. Une carte fait deux pages — pas la peine de charger une bibliothèque. */
function diffLignesHtml(avant, apres) {
  const a = String(avant || '').split('\n');
  const b = String(apres || '').split('\n');
  const n = a.length; const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(['=', a[i]]); i += 1; j += 1; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push(['-', a[i]]); i += 1; }
    else { out.push(['+', b[j]]); j += 1; }
  }
  while (i < n) { out.push(['-', a[i]]); i += 1; }
  while (j < m) { out.push(['+', b[j]]); j += 1; }
  return out.map(([signe, texte]) => {
    const cls = signe === '+' ? 'diff-add' : (signe === '-' ? 'diff-del' : '');
    return `<div class="diff-line ${cls}">${esc(signe === '=' ? '  ' : `${signe} `)}${esc(texte)}</div>`;
  }).join('');
}

onEl($('#knowledgeClose'), 'click', () => { $('#knowledgeModal').hidden = true; });
onEl($('#knowledgeVersions'), 'click', (e) => {
  const b = e.target.closest('.knowledge-version');
  if (b) montrerVersion(Number(b.dataset.id));
});
onEl($('#knowledgeEditBtn'), 'click', () => {
  $('#knowledgeBody').hidden = true;
  $('#knowledgeEdit').hidden = false;
  $('#knowledgeSave').hidden = false;
  $('#knowledgeEdit').focus();
});
onEl($('#knowledgeSave'), 'click', (e) => busy(e.currentTarget, async () => {
  try {
    await api(`/agents/${knowledgeAgent.id}/knowledge`, { method: 'PUT', body: { content: $('#knowledgeEdit').value } });
    toast(tr('agents.knowledge.saved'));
    await ouvrirConnaissance(knowledgeAgent);
    await loadAgentList();
  } catch (err) { toast(explainError(err.message), true); }
}));
onEl($('#knowledgeValidate'), 'click', (e) => busy(e.currentTarget, async () => {
  try {
    await api(`/agents/${knowledgeAgent.id}/knowledge/${knowledgeVersion}/activate`, { method: 'POST' });
    toast(tr('agents.knowledge.activated'));
    await ouvrirConnaissance(knowledgeAgent);
    await loadAgentList();
  } catch (err) { toast(explainError(err.message), true); }
}));
onEl($('#knowledgePublish'), 'click', (e) => busy(e.currentTarget, async () => {
  try { await api(`/agents/${knowledgeAgent.id}/knowledge/publish`, { method: 'POST' }); toast(tr('agents.knowledge.published')); }
  catch (err) { toast(explainError(err.message), true); }
}));

