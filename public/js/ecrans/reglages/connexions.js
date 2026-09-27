'use strict';
/* Enregistrer et tester, la garde à vide, A38, test de connexion GitLab. */
/* ENREGISTRER ET TESTER, EN UN GESTE. Le parcours nominal d'une connexion est toujours le
   même : coller l'URL et le jeton, enregistrer, vérifier. Deux boutons de même poids
   laissaient le choix de l'ordre — et tester sans enregistrer donnait un vert qui ne
   survivait pas au rechargement. Le primaire fait les deux ; « Enregistrer seulement » reste
   pour qui ne veut pas d'appel réseau. */
/* CE BOUTON ENREGISTRE TOUT LE FORMULAIRE. Les quatre « Tester » appellent ceci d'abord — et
   `#configForm` couvre les ONZE sous-onglets des réglages, pas seulement celui qu'on regarde.
   Tester une connexion Jira enregistrait donc aussi le prompt de review qu'on venait de
   modifier deux onglets plus loin, sans le dire. On le dit : l'effet est bon, le silence non. */
function enregistrerConfig(info) {
  const f = $('#configForm');
  if (info) info.textContent = tr('settings.test.saving-all');
  return new Promise((resolve) => {
    if (!f) { resolve(); return; }
    f.addEventListener('mergerie:config-saved', resolve, { once: true });
    f.requestSubmit();
    // Filet : si l'enregistrement échoue, le test part quand même sur les valeurs de l'écran.
    setTimeout(resolve, 4000);
  });
}

/* ---------- La garde à vide, commune aux quatre boutons « Tester » ----------
   Trois boutons jumeaux (Git, Jira, Jenkins) répondaient de trois façons : GitLab appelait
   l'API avec des champs vides et rendait l'erreur du serveur, Jira ne répondait rien du tout,
   Jenkins renvoyait un libellé de serveur. Une seule garde, et l'erreur se pose SOUS le
   premier champ manquant — un test de connexion échoue à cause d'un champ, pas d'un écran. */
function gardeConnexion(champs, message, info) {
  const vide = champs.find((c) => c && !String(c.value || '').trim());
  if (!vide) return true;
  if (info) { info.textContent = ''; info.className = 'muted'; }
  signalerChamp(vide, message);
  return false;
}

/* A38 — CE QUE LES TESTS DE CONNEXION ONT DONNÉ LA DERNIÈRE FOIS. Les quatre boutons
   répondaient à l'écran et n'en gardaient rien : en rouvrant les réglages, plus rien ne disait
   si GitLab répondait encore, ni depuis quand personne n'avait vérifié. On relit donc le
   souvenir du dernier test, à l'ouverture de l'onglet. */
const CONN_INFO = { gitlab: '#configInfoGit', github: '#configInfoGithub', jira: '#configInfoJira', jenkins: '#configInfoJenkins' };
async function majEtatsConnexions() {
  let d;
  try { d = await api('/conn-tests'); } catch { return; }
  for (const [service, sel] of Object.entries(CONN_INFO)) {
    const el = $(sel);
    const e = d[service];
    // Un champ qui porte déjà le résultat d'un test qu'on vient de lancer n'est pas écrasé.
    if (!el || !e || el.textContent.trim()) continue;
    el.textContent = tr(e.ok ? 'settings.conn.last-ok' : 'settings.conn.last-ko', {
      when: fmtDateTime(e.tested_at), detail: e.detail || '',
    });
    el.className = e.ok ? 'ok' : 'err';
  }
}

/* ---------- Test de connexion GitLab (réutilise un endpoint existant) ---------- */
const btnTestGitlab = $('#btnTestGitlab');
if (btnTestGitlab) btnTestGitlab.addEventListener('click', async () => {
  const info = $('#configInfoGit') || $('#configInfo');
  const fg = $('#configForm');
  viderErreursChamps($('#sub-gitcfg'));
  if (!gardeConnexion([fg.gitlab_url, fg.access_token], tr('err.gitlab-test-incomplet'), info)) return;
  btnTestGitlab.disabled = true;
  await enregistrerConfig(info);
  info.textContent = tr('settings.test.running');
  try {
    /* On teste CE QUI EST À L'ÉCRAN, pas ce qui est en base : au premier lancement, on vient
       tout juste de taper l'URL et le jeton, et rien ne dit qu'il faut enregistrer d'abord.
       C'est déjà ce que fait « Tester GitHub », deux boutons plus bas. */
    const f = $('#configForm');
    const r = await api('/gitlab/test', { method: 'POST', body: {
      gitlab_url: f.gitlab_url.value.trim(),
      access_token: f.access_token.value,
    } });
    const n = r.count || 0;
    info.textContent = tr('settings.conn.ok', { n, count: n });
  } catch (e) {
    info.textContent = '';
    toast(explainError(e.message), true);
  } finally { btnTestGitlab.disabled = false; }
});

const btnTestGithub = $('#btnTestGithub');
if (btnTestGithub) btnTestGithub.addEventListener('click', async () => {
  const info = $('#configInfoGithub');
  const fh = $('#configForm');
  viderErreursChamps($('#sub-gitcfg'));
  /* L'URL GitHub, elle, peut rester vide : c'est github.com. Le jeton, non. */
  if (!gardeConnexion([fh.github_token], tr('err.github-test-incomplet'), info)) return;
  btnTestGithub.disabled = true;
  await enregistrerConfig(info);
  info.textContent = tr('settings.test.running');
  try {
    const f = $('#configForm');
    const r = await api('/github/test', { method: 'POST', body: {
      github_url: f.github_url.value.trim(),
      github_token: f.github_token.value,
    } });
    info.textContent = tr('settings.github.test-ok', { login: r.login });
    info.className = 'ok';
  } catch (e) {
    info.textContent = e.message; info.className = 'err';
  } finally { btnTestGithub.disabled = false; }
});

const btnTestJira = $('#btnTestJira');
if (btnTestJira) btnTestJira.addEventListener('click', async () => {
  const f = $('#configForm');
  const info = $('#configInfoJira') || $('#configInfo');
  /* LA MÊME GARDE QUE GITLAB, avant tout appel. Le bouton ouvrait un `prompt()` du navigateur
     et sortait sans un mot si on l'annulait — à vide il ne faisait donc rien du tout, au moment
     précis où l'on cherche à savoir si la connexion marche. Trois boutons jumeaux (Git, Jira,
     Jenkins) doivent répondre pareil. */
  const champ = $('#jiraTestKey');
  const key = (champ && champ.value.trim()) || '';
  viderErreursChamps($('#sub-jiracfg'));
  if (!gardeConnexion([f.jira_url, f.jira_email, f.jira_token], tr('err.jira-test-incomplet'), info)) return;
  if (!key) { info.textContent = ''; signalerChamp(champ, tr('err.jira-test-sans-cle')); return; }
  /* ENREGISTRER D'ABORD, comme les trois boutons jumeaux. Celui-ci ne le faisait pas : un test
     Jira réussi laissait les identifiants hors de la base, et la récupération automatique des
     tickets, elle, lit la base — « ça marche » à l'écran, rien ne marchait ensuite. */
  await enregistrerConfig(info);
  info.textContent = tr('settings.jira.testing');
  try {
    // On envoie les valeurs SAISIES (URL/email/token) pour tester avant d'enregistrer.
    const r = await api('/jira/test', { method: 'POST', body: {
      key: key.trim(),
      jira_url: f.jira_url.value.trim(),
      jira_email: f.jira_email.value.trim(),
      jira_token: f.jira_token.value,
    } });
    info.textContent = tr('settings.jira.ok', { key: r.key, summary: (r.summary || '').slice(0, 60) });
  } catch (e) {
    info.textContent = '';
    toast(explainError(e.message), true);
  }
});

/* Tester Jenkins : mêmes règles que Jira — on teste les valeurs SAISIES, et le masque veut
   dire « garde le jeton déjà enregistré ». Le nom du compte rendu par Jenkins prouve que le
   couple utilisateur/jeton est le bon, pas seulement que l'URL répond. */
const btnTestJenkins = $('#btnTestJenkins');
if (btnTestJenkins) btnTestJenkins.addEventListener('click', async () => {
  const f = $('#configForm');
  const info = $('#configInfoJenkins') || $('#configInfo');
  /* MÊME GARDE, MÊME PHRASE que Git et Jira. Le serveur répondait « Jenkins non configuré
     (URL, utilisateur, jeton requis) » — une catégorie interne, et une formulation à part sur
     trois boutons jumeaux. */
  viderErreursChamps($('#sub-jenkinscfg'));
  if (!gardeConnexion([f.jenkins_url, f.jenkins_user, f.jenkins_token], tr('err.jenkins-test-incomplet'), info)) return;
  await enregistrerConfig(info);
  info.textContent = tr('settings.jenkins.testing');
  try {
    const r = await busy(btnTestJenkins, () => api('/jenkins/test', { method: 'POST', body: {
      jenkins_url: f.jenkins_url.value.trim(),
      jenkins_user: f.jenkins_user.value.trim(),
      jenkins_token: f.jenkins_token.value,
    } }));
    info.textContent = tr('settings.jenkins.ok', { user: r.user, n: r.jobs, count: r.jobs });
  } catch (e) {
    info.textContent = '';
    toast(explainError(e.message), true);
  }
});

