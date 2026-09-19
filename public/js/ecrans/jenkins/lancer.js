'use strict';
/* Jenkins : ce que la fiche propose à l'ouverture, relancer, confirmer, masquer. */
// @expose openJenkinsJob
/* ---------- Ce que la fiche propose À L'OUVERTURE ----------
   Le formulaire s'ouvrait sur les défauts DU JOB. Or on relance presque toujours ce qu'on
   vient de lancer : il fallait déplier l'historique et cliquer « reprendre » pour retrouver
   ses propres valeurs. L'ordre est donc, du plus proche au plus lointain :
     1. MA DERNIÈRE SAISIE sur ce job, dans ce navigateur — c'est mon habitude ;
     2. les paramètres du DERNIER BUILD — l'habitude de l'équipe ;
     3. les défauts déclarés par Jenkins — le repli.
   Rien n'est envoyé pour autant : c'est une proposition dans un formulaire, et le bouton
   reste à cliquer. */
const JK_SAISIE = 'aidevtools_jenkins_saisie';
const jkSaisies = () => { try { return JSON.parse(localStorage.getItem(JK_SAISIE) || '{}'); } catch { return {}; } };
function jkMemoriserSaisie(chemin, params) {
  try {
    const m = jkSaisies(); m[chemin] = params;
    localStorage.setItem(JK_SAISIE, JSON.stringify(m));
  } catch { /* stockage indisponible : on perd le confort, pas la fonction */ }
}
function jkPreremplir(d) {
  if (!d || !(d.parameters || []).length) return;
  const mienne = jkSaisies()[d.path];
  if (mienne && mienne.length) { jkPoserParams(mienne); return; }
  /* A34 — « COMME LE DERNIER RUN VERT », pas « comme le dernier run ». Un build rouge est très
     souvent une mauvaise VALEUR — une version qui n'existe pas, un environnement fermé — et la
     reproposer telle quelle refait exactement l'erreur qu'on vient de voir. On préfère donc le
     dernier build RÉUSSI ; à défaut (jamais vert), le dernier tout court, comme avant, et on le
     dit sous le formulaire pour que la proposition ne soit pas une devinette. */
  const vert = (d.builds || []).find((b) => b.result === 'SUCCESS' && (b.params || []).length);
  const dernier = (d.builds || []).find((b) => (b.params || []).length);
  const choisi = vert || dernier;
  if (!choisi) return;
  jkPoserParams(choisi.params);
  const intro = $('#jenkinsModalBody .jk-param-intro');
  if (intro && choisi === vert && dernier && dernier.number !== vert.number) {
    intro.textContent = tr('jenkins.params.from-green', { n: vert.number });
  }
}

// Un paramètre, rendu selon SON type : un booléen se coche, un choix se choisit. Les
// présenter tous comme un champ texte ferait retaper des valeurs que Jenkins connaît déjà.
function jkParamChamp(p) {
  const id = `jkp-${p.name}`;
  if (p.choices && p.choices.length) {
    /* MULTIPLE quand le job l'accepte (« choose one or multiple machines ») : une liste à choix
       unique obligerait à lancer autant de fois qu'il y a de cibles. Les valeurs partent
       séparées par des virgules, la forme qu'attendent les plugins qui posent la question. */
    const choisies = new Set(String(p.value == null ? '' : p.value).split(',').map((x) => x.trim()).filter(Boolean));
    const taille = p.multiple ? ` multiple size="${Math.min(8, Math.max(3, p.choices.length))}"` : '';
    return `<select id="${esc(id)}" data-jkparam="${esc(p.name)}"${taille}>${p.choices
      .map((c) => `<option value="${esc(c)}"${choisies.has(String(c)) ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
  }
  if (/boolean/i.test(p.type)) {
    return `<label class="inline-check"><input type="checkbox" id="${esc(id)}" data-jkparam="${esc(p.name)}"${p.value === true || p.value === 'true' ? ' checked' : ''} /> <span>${esc(tr('jenkins.param.on'))}</span></label>`;
  }
  return `<input id="${esc(id)}" data-jkparam="${esc(p.name)}" value="${esc(p.value == null ? '' : String(p.value))}" />`;
}

/* `siParams` : n'afficher la fiche QUE si le job a des paramètres. Sert au bouton « Lancer » de
   la liste, qui doit consulter la fiche pour savoir s'il y a quelque chose à lire — sans la faire
   clignoter quand il n'y a rien. Rend vrai si la fenêtre a été montrée. */
let jkOuvertures = 0;
async function openJenkinsJob(chemin, { siParams = false } = {}) {
  const modal = $('#jenkinsModal');
  $('#jenkinsModalTitle').textContent = chemin;
  $('#jenkinsModalDesc').textContent = '';
  $('#jenkinsModalBody').innerHTML = skeleton(2);
  if (!siParams) modal.hidden = false;
  const jeton = ++jkOuvertures;
  try {
    const d = await api(`/jenkins/job?path=${encodeURIComponent(chemin)}`);
    /* FERMÉE PENDANT LE CHARGEMENT, ELLE LE RESTE. La fiche s'ouvre avant la réponse ; si l'on
       fait Échap entre-temps, la réponse la rouvrait d'office, par-dessus l'écran suivant. Même
       chose si une autre fiche a été demandée depuis : la plus récente gagne. */
    if (jeton !== jkOuvertures || (!siParams && modal.hidden)) return false;
    JENKINS.job = d;
    if (siParams && !d.parameters.length) return false;
    modal.hidden = false;
    $('#jenkinsModalDesc').textContent = d.description || '';
    const params = d.parameters.length
      ? `<section class="jk-bloc">
         <h4 class="jk-bloc-t">${esc(tr('jenkins.params'))}</h4>
         <p class="muted jk-param-intro">${esc(tr('jenkins.params.intro'))}</p>${d.parameters.map((p) => `<label class="jk-param"><span class="jk-param-name">${esc(p.name)}</span>
          ${p.description ? `<span class="jk-param-desc">${esc(p.description)}</span>` : ''}
          ${jkParamChamp(p)}
          ${p.unresolved ? `<span class="jk-param-warn">${esc(tr('jenkins.param.unresolved'))} ${jkLienExterne(d.url)}</span>` : ''}</label>`).join('')}</section>`
      : '';
    JENKINS.build = null;
    JENKINS.ficheFiltres = {};          // les filtres d'une fiche ne suivent pas d'un job à l'autre
    /* L'HISTORIQUE SE REPLIE QUAND IL Y A DES PARAMÈTRES À REMPLIR. Sur un job paramétré, la
       fenêtre sert à lancer : déplié, « Derniers builds » repoussait le pied de modale à plus
       d'un écran, et il fallait défiler pour trouver le bouton qu'on venait chercher. Sans
       paramètre, la fiche EST l'historique : elle reste ouverte. */
    const replie = d.parameters.length && d.buildable;
    $('#jenkinsModalBody').innerHTML = params + (replie
      ? `<details class="jk-fiche-repli"><summary>${esc(tr('jenkins.builds.show'))}</summary><div class="jk-fiche" id="jenkinsFiche"></div></details>`
      : '<div class="jk-fiche" id="jenkinsFiche"></div>');
    renderJenkinsFiche();
    jkPreremplir(d);            // ma dernière saisie, sinon le dernier build, sinon les défauts
    $('#jenkinsRun').hidden = !d.buildable;
    /* LE TITRE PORTE LE VERBE quand la fenêtre sert à lancer : « boutique/api-deploy-prod »
       seul ne dit pas ce qui va se passer. Et le focus va sur le PREMIER PARAMÈTRE — il
       restait sur le bouton de la liste, donc hors de la fenêtre qui venait de s'ouvrir. */
    if (d.parameters.length && d.buildable) {
      $('#jenkinsModalTitle').textContent = tr('jenkins.modal.run-title', { job: chemin });
      $('#jenkinsRun').querySelector('span').textContent = tr('jenkins.run.with-params');
      const premier = $('#jenkinsModalBody .jk-param input, #jenkinsModalBody .jk-param select');
      if (premier) premier.focus();
    } else {
      $('#jenkinsRun').querySelector('span').textContent = tr('jenkins.run');
    }
  } catch (e) {
    // Une erreur se montre TOUJOURS : sinon le clic sur « Lancer » resterait sans réponse.
    modal.hidden = false;
    $('#jenkinsModalBody').innerHTML = errorBox(explainError(e.message));
    $('#jenkinsRun').hidden = true;
  }
  return true;
}

// Les valeurs saisies, relues du formulaire au moment du lancement.
function jkParamsSaisis() {
  const out = {};
  $$('#jenkinsModalBody [data-jkparam]').forEach((el) => {
    if (el.type === 'checkbox') { out[el.dataset.jkparam] = String(el.checked); return; }
    // Choix multiple : Jenkins attend une seule valeur, les sélections séparées par des virgules.
    if (el.multiple) { out[el.dataset.jkparam] = [...el.selectedOptions].map((o) => o.value).join(','); return; }
    out[el.dataset.jkparam] = el.value;
  });
  return out;
}

/* RELANCER À L'IDENTIQUE. Le geste le plus fréquent après un échec : le même job, les mêmes
   valeurs — sans les retaper, et sans risquer d'en oublier une. La confirmation MONTRE ce qui
   va repartir : « relancer » ne veut rien dire si on ne voit pas avec quoi.

   Les paramètres secrets n'ont pas été rendus par Jenkins (on ne les affiche jamais) : ils ne
   peuvent donc pas repartir. On le DIT plutôt que de laisser partir un job amputé de son mot
   de passe sans que personne ne s'en aperçoive. */
async function relancerJenkins(chemin, params, caches) {
  const liste = params || [];
  const ok = await confirmDialog({
    title: tr('jenkins.rerun.title'),
    text: caches
      ? `${tr('jenkins.rerun.text', { job: chemin })} ${tr('jenkins.rerun.secrets', { n: caches, count: caches })}`
      : tr('jenkins.rerun.text', { job: chemin }),
    detail: liste.length ? liste.map((p) => `${p.name} = ${p.value}`).join('\n') : tr('jenkins.build.no-params'),
    confirmLabel: tr('jenkins.rerun'),
  });
  if (!ok) return false;
  try {
    const avant = (JENKINS.jobs.find((x) => x.path === chemin) || {}).lastNumber || 0;
    await api('/jenkins/build', { method: 'POST', body: {
      path: chemin, parameters: Object.fromEntries(liste.map((p) => [p.name, p.value])), since: avant,
    } });
    jkPoserLance(chemin);
    toast(tr('jenkins.queued', { job: chemin }));
    loadJenkins();
    return true;
  } catch (e) { toast(explainError(e.message), true); return false; }
}

/* LANCER DEMANDE CONFIRMATION. Un job Jenkins n'est pas une page qu'on ouvre : il déploie,
   il publie, il tourne sur une machine partagée. Le clic de trop n'est pas rattrapable
   depuis ici, et le nom du job dans la question est ce qui permet de s'en apercevoir. */
/* `confirmer` : la fiche paramétrée ne repose PAS la question. Remplir les paramètres d'un
   déploiement, les relire et cliquer « Lancer avec ces paramètres » est déjà un geste
   délibéré ; une seconde fenêtre qui redemande « lancer ce job ? » se clique sans la lire et
   n'apprend plus rien. La confirmation reste pour le « Lancer » direct de la liste, où l'on
   n'a rien vu du job. */
async function lancerJenkins(chemin, parametres, { confirmer = true } = {}) {
  if (confirmer && !await confirmDialog({
    title: tr('jenkins.confirm.title'), text: tr('jenkins.confirm.text', { job: chemin }),
    confirmLabel: tr('jenkins.run'),
  })) return false;
  try {
    const avant = (JENKINS.jobs.find((x) => x.path === chemin) || {}).lastNumber || 0;
    await api('/jenkins/build', { method: 'POST', body: { path: chemin, parameters: parametres || {}, since: avant } });
    jkPoserLance(chemin);
    toast(tr('jenkins.queued', { job: chemin }));
    // Jenkins met en file : l'état ne change pas dans la seconde, on redemande quand même.
    loadJenkins();
    return true;
  } catch (e) { toast(explainError(e.message), true); return false; }
}

let jkLogVu = null;   // ce que la console affiche : {chemin, numero, texte}

async function openJenkinsLog(chemin, numero) {
  $('#jenkinsLogTitle').textContent = `${chemin} #${numero}`;
  $('#jenkinsLogBody').textContent = '…';
  jkLogVu = null;
  $('#jenkinsLogInvestigate').hidden = true;
  $('#jenkinsLogModal').hidden = false;
  try {
    const d = await api(`/jenkins/console?path=${encodeURIComponent(chemin)}&build=${encodeURIComponent(numero)}`);
    $('#jenkinsLogBody').textContent = (d.truncated ? `${tr('jenkins.log.truncated')}\n\n` : '') + (d.text || '');
    $('#jenkinsLogBody').scrollTop = $('#jenkinsLogBody').scrollHeight;   // l'erreur est en bas
    /* B9 — ON NE PROPOSE D'ENQUÊTER QUE S'IL Y A DE QUOI. La même règle que sur un ticket
       (`detecterTrace`) : un build vert dont la console dit « BUILD SUCCESS » n'a rien à
       confier à l'enquêteur, et un bouton qui ouvre une session vide fait perdre deux gestes. */
    jkLogVu = { chemin, numero, texte: d.text || '' };
    $('#jenkinsLogInvestigate').hidden = !detecterTrace(jkLogVu.texte);
  } catch (e) {
    $('#jenkinsLogBody').textContent = explainError(e.message);
  }
}

$('#jenkinsLogInvestigate') && $('#jenkinsLogInvestigate').addEventListener('click', async () => {
  if (!jkLogVu) return;
  // Les trente dernières lignes utiles, comme le suivi CI : au-delà, on paie un prompt énorme
  // pour du bruit de compilation, et l'erreur est en bas.
  const lignes = String(jkLogVu.texte).split('\n').filter((l) => l.trim()).slice(-30).join('\n');
  $('#jenkinsLogModal').hidden = true;
  await enqueterSurTexte(tr('jenkins.investigate.prompt', { job: jkLogVu.chemin, n: jkLogVu.numero, log: lignes }));
});

$('#jenkinsSearch') && $('#jenkinsSearch').addEventListener('input', (e) => { JENKINS.q = e.target.value; jkMemoriserFiltres(); renderJenkins(); });
$('#jenkinsFailOnly') && $('#jenkinsFailOnly').addEventListener('change', (e) => { JENKINS.echecsSeuls = e.target.checked; jkMemoriserFiltres(); renderJenkins(); });
$('#jenkinsMineOnly') && $('#jenkinsMineOnly').addEventListener('change', (e) => { JENKINS.miensSeuls = e.target.checked; jkMemoriserFiltres(); renderJenkins(); });
$('#jenkinsMineBranches') && $('#jenkinsMineBranches').addEventListener('change', async (e) => {
  JENKINS.mesBranches = e.target.checked;
  jkMemoriserFiltres();
  // La file n'est peut-être pas chargée : sans elle le filtre ne connaîtrait aucune branche.
  if (JENKINS.mesBranches) await assurerMrsJenkins();
  renderJenkins();
});
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-jkpin]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  jkBasculerEpingle(b.dataset.jkpin);
});
$('#jenkinsReload') && $('#jenkinsReload').addEventListener('click', () => loadJenkins());
$('#jenkinsNoAuto') && $('#jenkinsNoAuto').addEventListener('change', (e) => {
  try { localStorage.setItem(JENKINS_AUTO, e.target.checked ? '0' : '1'); } catch { /* stockage indisponible */ }
  jkAutoRelance();
});
$('#jenkinsParamFiltres') && $('#jenkinsParamFiltres').addEventListener('click', (e) => {
  const h = e.target.closest('[data-jkpfhide]');
  if (h) {
    e.preventDefault();
    const nom = h.dataset.jkpfhide;
    JENKINS.paramsMasques.add(nom);
    /* On efface AUSSI sa valeur : un filtre invisible qui continue de filtrer est le meilleur
       moyen de chercher pendant dix minutes pourquoi la liste est vide. */
    JENKINS.paramFiltres = { ...JENKINS.paramFiltres, [nom]: '' };
    jkMemoriserFiltres();
    sauverFiltreJenkins();
    renderJenkins();
    return;
  }
  if (e.target.closest('#jenkinsParamHidden')) { renderJenkinsMasques(); $('#jenkinsHiddenModal').hidden = false; }
});
/* On attend un court repos avant de filtrer : à chaque frappe, le rendu remplacerait le champ
   qu'on est en train de remplir et le curseur sauterait. */
let jkFrappe = null;
const jkApresFrappe = (fn) => { clearTimeout(jkFrappe); jkFrappe = setTimeout(fn, 250); };

$('#jenkinsParamFiltres') && $('#jenkinsParamFiltres').addEventListener('input', (e) => {
  const champ = e.target.closest('[data-jkpf]');
  if (!champ) return;
  const nom = champ.dataset.jkpf;
  const valeur = champ.value.trim();
  jkApresFrappe(() => {
    JENKINS.paramFiltres = { ...JENKINS.paramFiltres, [nom]: valeur };
    jkMemoriserFiltres();
    renderJenkins();
    const rendu = $(`#jenkinsParamFiltres [data-jkpf="${CSS.escape(nom)}"]`);
    if (rendu) { rendu.focus(); rendu.setSelectionRange(rendu.value.length, rendu.value.length); }
  });
});
$('#jenkinsFolderSearch') && $('#jenkinsFolderSearch').addEventListener('input', (e) => { JENKINS.qDossier = e.target.value; renderJenkinsDossiers(); });
/* Masquer / remettre. Le clic sur la croix est intercepté AVANT le `change` du label : sans
   ça, cliquer la croix cocherait aussi la case qui la porte. */
$('#jenkinsFolderList') && $('#jenkinsFolderList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-jkhide]');
  if (!b) return;
  e.preventDefault();
  JENKINS.masques.add(b.dataset.jkhide);
  sauverFiltreJenkins();
  renderJenkins();
});
$('#jenkinsFolderHidden') && $('#jenkinsFolderHidden').addEventListener('click', () => {
  renderJenkinsMasques();
  $('#jenkinsHiddenModal').hidden = false;
});
$('#jenkinsHiddenList') && $('#jenkinsHiddenList').addEventListener('click', (e) => {
  const d = e.target.closest('[data-jkshow]');
  const p = e.target.closest('[data-jkpfshow]');
  if (!d && !p) return;
  if (d) JENKINS.masques.delete(d.dataset.jkshow);
  if (p) JENKINS.paramsMasques.delete(p.dataset.jkpfshow);
  sauverFiltreJenkins();
  renderJenkins();
  // Plus rien à remettre : la modale n'a plus de raison d'être ouverte.
  if (!JENKINS.masques.size && !JENKINS.paramsMasques.size) $('#jenkinsHiddenModal').hidden = true;
  else renderJenkinsMasques();
});
$('#jenkinsHiddenAll') && $('#jenkinsHiddenAll').addEventListener('click', () => {
  JENKINS.masques.clear();
  JENKINS.paramsMasques.clear();
  sauverFiltreJenkins();
  renderJenkins();
  $('#jenkinsHiddenModal').hidden = true;
});
$('#jenkinsHiddenClose') && $('#jenkinsHiddenClose').addEventListener('click', () => { $('#jenkinsHiddenModal').hidden = true; });
fermerAuFond('#jenkinsHiddenModal', () => { $('#jenkinsHiddenModal').hidden = true; }, { salissable: false });
$('#jenkinsFolderList') && $('#jenkinsFolderList').addEventListener('change', (e) => {
  const c = e.target.closest('[data-jkfolder]');
  if (!c) return;
  const d = c.dataset.jkfolder;
  if (c.checked) JENKINS.horsDossiers.delete(d); else JENKINS.horsDossiers.add(d);
  sauverFiltreJenkins();
  renderJenkins();
});
/* « Tout cocher / décocher » ne portent que sur ce qui est VISIBLE dans le filtre : sinon,
   après une recherche, le bouton toucherait des dossiers qu'on ne voit pas. */
const jkDossiersVisibles = () => $$('#jenkinsFolderList [data-jkfolder]').map((c) => c.dataset.jkfolder);
$('#jenkinsFoldersAll') && $('#jenkinsFoldersAll').addEventListener('click', () => {
  jkDossiersVisibles().forEach((d) => JENKINS.horsDossiers.delete(d));
  sauverFiltreJenkins(); renderJenkins();
});
$('#jenkinsFoldersNone') && $('#jenkinsFoldersNone').addEventListener('click', () => {
  jkDossiersVisibles().forEach((d) => JENKINS.horsDossiers.add(d));
  sauverFiltreJenkins(); renderJenkins();
});
$('#jenkinsModalBody') && $('#jenkinsModalBody').addEventListener('input', (e) => {
  const champ = e.target.closest('[data-jkff]');
  if (!champ) return;
  const nom = champ.dataset.jkff;
  const valeur = champ.value.trim();
  jkApresFrappe(async () => {
    JENKINS.ficheFiltres = { ...JENKINS.ficheFiltres, [nom]: valeur };
    /* CHERCHER PLUS LOIN QUE CE QU'ON A SOUS LES YEUX. Dix builds suffisent pour « ce qui vient
       de se passer », pas pour « quand est-ce parti en prod la dernière fois ». Dès qu'un filtre
       est posé, on redemande la fiche avec un historique profond — une seule fois par job. */
    if (valeur && JENKINS.job && (JENKINS.job.depth || 0) < JK_HISTO_PROFOND) await approfondirFiche();
    renderJenkinsFiche();
    const rendu = $(`#jenkinsModalBody [data-jkff="${CSS.escape(nom)}"]`);
    if (rendu) { rendu.focus(); rendu.setSelectionRange(rendu.value.length, rendu.value.length); }
  });
});
$('#jenkinsClose') && $('#jenkinsClose').addEventListener('click', () => { $('#jenkinsModal').hidden = true; });
$('#jenkinsLogClose') && $('#jenkinsLogClose').addEventListener('click', () => { $('#jenkinsLogModal').hidden = true; });
fermerAuFond('#jenkinsModal', () => { $('#jenkinsModal').hidden = true; }, { salissable: false });
fermerAuFond('#jenkinsLogModal', () => { $('#jenkinsLogModal').hidden = true; }, { salissable: false });
$('#jenkinsRun') && $('#jenkinsRun').addEventListener('click', async () => {
  const j = JENKINS.job;
  if (!j) return;
  const saisis = jkParamsSaisis();
  // Lancé depuis la fiche : on la referme, le geste est fait et la liste redemande l'état.
  if (await lancerJenkins(j.path, saisis, { confirmer: !j.parameters.length })) {
    /* CE QU'ON VIENT DE TAPER SERA PROPOSÉ LA PROCHAINE FOIS. Mémorisé APRÈS le lancement
       seulement : un formulaire abandonné en cours de saisie ne fait pas une habitude. */
    if (j.parameters.length) jkMemoriserSaisie(j.path, Object.entries(saisis).map(([name, value]) => ({ name, value })));
    $('#jenkinsModal').hidden = true;
  }
});

document.addEventListener('click', (e) => {
  const box = e.target.closest && e.target.closest('#jenkinsBox');
  if (box) {
    const run = e.target.closest('[data-jkrun]');
    if (run) {
      /* Un job PARAMÉTRÉ ne se lance pas depuis la liste : on ouvre sa fiche, où les
         paramètres se lisent. Lancer avec les valeurs par défaut sans les avoir vues est
         exactement la façon de déployer la mauvaise version. Sans paramètre, rien à lire :
         le job part, et aucune fenêtre ne s'ouvre — le bouton fait ce qu'il annonce. */
      openJenkinsJob(run.dataset.jkrun, { siParams: true }).then((montree) => {
        if (!montree) lancerJenkins(run.dataset.jkrun, {});
      });
      return;
    }
    const rerun = e.target.closest('[data-jkrerun]');
    if (rerun) {
      const j = JENKINS.jobs.find((x) => x.path === rerun.dataset.jkrerun);
      if (j) relancerJenkins(j.path, j.lastParams, j.lastParamsCaches);
      return;
    }
    const open = e.target.closest('[data-jkopen]') || e.target.closest('[data-jkjob]');
    if (open) { openJenkinsJob(open.dataset.jkopen || open.dataset.jkjob); return; }
  }
  const ff = e.target.closest && e.target.closest('[data-jkreuse]');
  if (ff) { jkReprendreParams(ff.dataset.jkreuse); return; }
  /* Relancer UNE exécution précise, avec SES valeurs : c'est ce qu'on veut après avoir lu la
     console d'un build raté, pas les valeurs du dernier lancement qui n'est pas celui-là. */
  const rb = e.target.closest && e.target.closest('[data-jkrerunbuild]');
  if (rb) {
    const d = JENKINS.job;
    const b = d && (d.builds || []).find((x) => x.number === Number(rb.dataset.jkrerunbuild));
    if (b) relancerJenkins(d.path, b.params, b.paramsCaches).then((parti) => { if (parti) $('#jenkinsModal').hidden = true; });
    return;
  }
  const build = e.target.closest && e.target.closest('[data-jkbuild]');
  if (build) { JENKINS.build = Number(build.dataset.jkbuild); renderJenkinsFiche(); return; }
  const log = e.target.closest && e.target.closest('[data-jklog]');
  if (log) openJenkinsLog(log.dataset.jkpath, log.dataset.jklog);
});
