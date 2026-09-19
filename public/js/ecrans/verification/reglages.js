'use strict';
/* Réglages → Vérificateurs : champs, commandes, copie, le formulaire. */
// @expose loadVerifiers, verifiers
/* ================= Vérification objective (plan_add_verify.md §8) =================
   Trois écrans se partagent le sujet : les vérificateurs (Réglages), les badges et la
   sélection multiple (Reviews), les lots (Dev IA). Tout ce qui vient d'un script de
   vérification est une donnée NON FIABLE : elle est échappée sans exception. */

/* ---------- Réglages → Vérificateurs ---------- */

let verifiers = [];

async function loadVerifiers() {
  await loadRepoOptions();
  // Le mode « in place » propose de piocher dans les répertoires locaux déclarés.
  await loadLocalRoots();
  try { verifiers = await api('/verifiers'); } catch (e) { verifiers = []; toast(explainError(e.message), true); }
  /* LE FORMULAIRE OUVERT NE NOUS APPARTIENT PAS. Ce chargement remet les commandes et les
     dépôts à zéro pour repartir d'un formulaire vierge — mais s'il revient PENDANT qu'on
     modifie un vérificateur (ouvrir l'onglet lance déjà un chargement, et cliquer « Modifier »
     avant qu'il ne soit revenu suffit), il vide ce qu'on est en train d'éditer : le nom reste,
     les commandes et les dépôts disparaissent sous les doigts. On ne touche donc à ces deux
     blocs que si le formulaire est fermé. */
  const f = $('#verifierForm');
  if (!f || f.hidden) {
    renderVerifierRepoBox();
    renderCommandList([]);
    appliquerKind();
  }
  renderVerifierList();
}

/* Couverture déclarative : une ligne par dépôt, cochée ou non. Recherche obligatoire — le
   nombre de dépôts peut être élevé, et elle MASQUE sans décocher : filtrer ne doit jamais
   modifier la sélection en cours. */
function renderVerifierRepoBox(lignes = []) {
  const box = $('#verifierRepoBox');
  if (!box) return;
  const par = new Map(lignes.map((l) => [l.repo_id, l]));
  const items = repoOptions.map((r) => {
    const l = par.get(r.id);
    return `<div class="vr-row" data-repo="${r.id}">
      <label class="repo-multi-item"><input type="checkbox" class="vr-pick" value="${r.id}" ${l ? 'checked' : ''} /> <span>${esc(r.project)}</span></label>
      <div class="vr-cfg" ${l ? '' : 'hidden'}>
        <select class="vr-mode">
          <option value="worktree" ${!l || l.mode === 'worktree' ? 'selected' : ''}>${esc(tr('verify.mode.worktree'))}</option>
          <option value="in_place" ${l && l.mode === 'in_place' ? 'selected' : ''}>${esc(tr('verify.mode.in-place'))}</option>
        </select>
        <span class="vr-ip" ${l && l.mode === 'in_place' ? '' : 'hidden'}>
          ${/* Piocher dans les répertoires locaux déclarés plutôt que retaper un chemin : une
                faute de frappe ici ne se découvre qu'au premier run, et coûte le run. Le champ
                libre reste, pour un répertoire hors de toute racine déclarée. */''}
          ${localRoots.length
    ? comboHtml('vr-local', { ph: tr('verify.ph.pick-local'), wrapClass: 'vr-local-combo' })
    : `<span class="muted">${esc(tr('verify.no-local-root'))}</span>`}
          <input class="vr-workdir" type="text" placeholder="${esc(tr('verify.ph.workdir'))}" value="${esc((l && l.workdir) || '')}" />
          <button type="button" class="btn vr-test">${esc(tr('verify.btn.test-workdir'))}</button>
          <label class="inline-check"><input type="checkbox" class="vr-allow" ${l && l.checkout_allowed ? 'checked' : ''} /> <span>${esc(tr('verify.lbl.checkout-allowed'))}</span></label>
          <span class="vr-test-info muted"></span>
        </span>
      </div>
    </div>`;
  }).join('');
  box.innerHTML = `<input class="repo-multi-search" type="search" placeholder="${esc(tr('git.explorer.search-ph'))}" />
    <div class="repo-multi-list vr-list">${items || `<span class="muted">${esc(tr('settings.repo.empty.title'))}</span>`}</div>`;
  const search = $('.repo-multi-search', box);
  search.addEventListener('input', () => {
    const q = search.value.toLowerCase().trim();
    $$('.vr-row', box).forEach((it) => { it.hidden = !!q && !$('.repo-multi-item span', it).textContent.toLowerCase().includes(q); });
  });
  cablerChoixLocal(box);
  // À l'ouverture d'un vérificateur existant, les dépôts sont déjà cochés : on propose d'emblée.
  majSuggestionsCommandes();
}

/* Le sélecteur de projet local. Il liste TOUS les projets git de TOUTES les racines : ce
   qu'on cherche ici, c'est un répertoire de travail précis, pas une racine — la faire choisir
   d'abord ajouterait un geste sans rien apprendre. Recherche à la frappe (`wireCombo`), parce
   qu'une racine contient couramment des dizaines de projets. */
function cablerChoixLocal(box) {
  wireCombo(box, 'vr-local', async () => {
    const parRacine = await Promise.all(localRoots.map(async (r) => {
      let projets = [];
      try { projets = await localProjectsOf(r.id); } catch { projets = []; }
      return { racine: r, projets };
    }));
    const plusieurs = localRoots.length > 1;
    return parRacine.flatMap(({ racine, projets }) => projets
      // Seuls les dépôts git : le mode in place exige un dépôt dont l'origine correspond,
      // proposer un dossier ordinaire ne proposerait qu'un échec.
      .filter((p) => p.git)
      .map((p) => ({
        value: p.path,
        label: plusieurs ? `${racine.label || racine.path} / ${p.name}` : p.name,
        hint: p.branch ? `· ${p.branch}` : '',
      })));
  });
  $$('.vr-local', box).forEach((h) => h.addEventListener('change', () => {
    const champ = $('.vr-workdir', h.closest('.vr-row'));
    if (champ && h.value) champ.value = h.value;
  }));
}

/* Il n'y a plus qu'une famille : une liste de commandes rejouée dans chaque dépôt visé. La
   famille « script » (un exécutable rendant un verdict JSON) a été retirée — le formulaire n'a
   donc plus de genre à choisir, ni de moitié à masquer. */
function appliquerKind() {
  const aide = $('#verifierRepoHint');
  if (aide) aide.textContent = tr('settings.verifier.repos.commands');
}

/* Le gabarit du commentaire n'a de sens QUE si l'on publie : afficher un champ dont le contenu
   ne partira nulle part est une promesse qu'on ne tient pas. */
function majBlocCommentaire() {
  const f = $('#verifierForm');
  const bloc = $('#verifierCommentBlock');
  if (f && bloc) bloc.hidden = !f.comment_on_forge.checked;
  if (f && bloc && !bloc.hidden) { rendreChampsGabarit(); majApercuGabarit(); }
}

/* CE QUE CONTIENT CHAQUE CHAMP, avec un exemple. Un nom de variable n'apprend rien : entre
   `{tests}` et `{commits}`, personne ne devine lequel porte les noms de tests cassés.

   La LISTE vient du serveur — c'est lui qui sait ce que le moteur remplace. Une liste écrite en
   dur ici finirait par annoncer un champ qui n'existe plus, ou taire un champ ajouté depuis.
   Un champ sans description s'affiche quand même, avec son nom : mieux vaut incomplet que muet. */
/* L'aperçu se recompose à la frappe, mais pas à chaque touche : `debounce` existe déjà, et
   composer six fois par seconde pour un texte qu'on est en train d'écrire n'apprend rien. */
const majApercuGabarit = debounce(async () => {
  const box = $('#verifierCommentPreview');
  if (!box || !box.open) return;                    // replié : rien à composer
  try {
    const f = $('#verifierForm');
    const d = await api('/verifiers/comment-preview', {
      method: 'POST', body: { template: f.comment_template.value, mentions: f.mentions.value },
    });
    $('#verifierCommentPreviewBody').textContent = d.body || '';
  } catch (e) { $('#verifierCommentPreviewBody').textContent = explainError(e.message); }
}, 250);
$('#verifierCommentPreview') && $('#verifierCommentPreview').addEventListener('toggle', () => majApercuGabarit());
document.addEventListener('input', (e) => {
  if (e.target && (e.target.name === 'comment_template' || e.target.name === 'mentions')) majApercuGabarit();
});

let champsGabarit = null;
async function rendreChampsGabarit() {
  const el = $('#verifierCommentFields');
  if (!el || el.dataset.rendu) return;
  if (!champsGabarit) {
    try { champsGabarit = (await api('/verifiers/comment-template-default')).champs || []; }
    catch { return; }        // hors ligne : le gabarit reste modifiable, sans son aide
  }
  el.innerHTML = champsGabarit.map((nom) => `<div class="champ-gabarit">
      <dt><code>{${esc(nom)}}</code></dt>
      <dd>${esc(tr(`settings.verifier.champ.${nom}`))}</dd>
    </div>`).join('');
  el.dataset.rendu = '1';
}
document.addEventListener('change', (e) => {
  if (e.target && e.target.name === 'comment_on_forge') majBlocCommentaire();
});
$('#btnCommentTemplateDefaut') && $('#btnCommentTemplateDefaut').addEventListener('click', async () => {
  /* On va CHERCHER le défaut au serveur au lieu de le recopier ici : deux copies d'un même
     texte finissent toujours par diverger, et c'est celle de l'écran qui aurait tort. */
  try {
    const d = await api('/verifiers/comment-template-default');
    $('#verifierForm').comment_template.value = d.template || '';
  } catch (e) { toast(explainError(e.message), true); }
});

/* Une commande par ligne éditable. L'ordre est PORTEUR DE SENS — `npm ci` avant `npm test` —
   donc il se corrige sans tout retaper : deux flèches par ligne, désactivées aux extrémités
   plutôt qu'inertes, pour qu'on voie où on est dans la liste. */
function renderCommandList(commands) {
  const el = $('#verifierCommandList');
  if (!el) return;
  const liste = commands && commands.length ? commands : [''];
  el.innerHTML = liste.map((c, i) => `<div class="vc-row">
    <span class="vc-rank muted">${i + 1}</span>
    <input class="vc-cmd" type="text" value="${esc(c)}" placeholder="${esc(tr('settings.verifier.ph.command-line'))}" />
    <button type="button" class="btn vc-move" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="${esc(tr('settings.verifier.btn.move-up'))}">${svgIco('up')}</button>
    <button type="button" class="btn vc-move" data-dir="1" ${i === liste.length - 1 ? 'disabled' : ''} title="${esc(tr('settings.verifier.btn.move-down'))}">${svgIco('down')}</button>
    ${/* La corbeille n'apparaît qu'à partir de deux lignes : sur une commande unique, elle
          propose de vider le seul champ obligatoire du bloc. */''}
    ${liste.length > 1 ? `<button type="button" class="btn btn-danger vc-del" title="${esc(tr('ui.delete'))}">${svgIco('trash')}</button>` : ''}
  </div>`).join('');
}

/* ---------- Les commandes que les dépôts couverts savent déjà lancer ----------
   On recopiait `npm run test:integ -- --tag paiement-3x` depuis un terminal, en se trompant
   d'un tiret. Le dépôt les DÉCLARE : on les propose, on ne les invente pas. La liste suit les
   dépôts cochés — cocher un dépôt de plus ajoute ses commandes, en décocher retire les
   siennes ; une commande déjà dans le formulaire n'est plus proposée. */
let verifSuggSeq = 0;
async function majSuggestionsCommandes() {
  const box = $('#verifierSuggestions');
  if (!box) return;
  const ids = $$('#verifierRepoBox .vr-row').filter((row) => $('.vr-pick', row) && $('.vr-pick', row).checked)
    .map((row) => Number(row.dataset.repo)).filter(Boolean);
  if (!ids.length) { box.hidden = true; box.innerHTML = ''; return; }
  const seq = ++verifSuggSeq;
  let liste = [];
  try { liste = (await api(`/verifiers/command-suggestions?repo_ids=${ids.join(',')}`)).suggestions || []; } catch { liste = []; }
  if (seq !== verifSuggSeq) return;            // une coche plus récente a déjà répondu
  const deja = new Set($$('#verifierCommandList .vc-cmd').map((x) => x.value.trim()).filter(Boolean));
  const restantes = liste.filter((s) => !deja.has(s.command));
  box.hidden = !restantes.length;
  if (!restantes.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<p class="field-note">${esc(tr('settings.verifier.sugg.intro'))}</p>`
    + restantes.map((s) => `<button type="button" class="chip vc-sugg-btn" data-sugg="${esc(s.command)}" title="${esc([s.source, s.desc, s.repos.join(', ')].filter(Boolean).join(' · '))}">${esc(s.command)}</button>`).join('');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-sugg]');
  if (!b) return;
  /* On AJOUTE à la suite, sans rien écraser : la première ligne vide d'un formulaire neuf est
     remplie, sinon on en ouvre une nouvelle. L'ordre des commandes est celui du clic. */
  const vals = $$('#verifierCommandList .vc-cmd').map((x) => x.value);
  const vide = vals.findIndex((v) => !v.trim());
  if (vide >= 0) vals[vide] = b.dataset.sugg; else vals.push(b.dataset.sugg);
  renderCommandList(vals);
  majSuggestionsCommandes();
});

/* Déplace la ligne `i` d'un cran. On relit les valeurs À L'ÉCRAN avant de réordonner : une
   commande en cours de frappe, pas encore enregistrée, ne doit pas être perdue par le
   réaffichage. */
function deplacerCommande(i, dir) {
  const vals = $$('#verifierCommandList .vc-cmd').map((x) => x.value);
  const j = i + dir;
  if (j < 0 || j >= vals.length) return;
  [vals[i], vals[j]] = [vals[j], vals[i]];
  renderCommandList(vals);
  const champs = $$('#verifierCommandList .vc-cmd');
  if (champs[j]) champs[j].focus();
}

function commandesDuFormulaire() {
  return $$('#verifierCommandList .vc-cmd').map((i) => i.value.trim()).filter(Boolean);
}

// Les lignes de couverture telles que l'API les attend.
function verifierReposFromForm() {
  return $$('#verifierRepoBox .vr-row').filter((row) => $('.vr-pick', row).checked).map((row) => {
    const mode = $('.vr-mode', row).value;
    return {
      repo_id: Number(row.dataset.repo),
      mode,
      workdir: mode === 'in_place' ? $('.vr-workdir', row).value.trim() : null,
      checkout_allowed: mode === 'in_place' && $('.vr-allow', row).checked ? 1 : 0,
    };
  });
}

$('#verifierRepoBox') && $('#verifierRepoBox').addEventListener('change', (e) => {
  const row = e.target.closest && e.target.closest('.vr-row');
  if (!row) return;
  if (e.target.classList.contains('vr-pick')) {
    $('.vr-cfg', row).hidden = !e.target.checked;
    // Les commandes proposées suivent les dépôts couverts : cocher en ajoute, décocher en retire.
    majSuggestionsCommandes();
  }
  if (e.target.classList.contains('vr-mode')) $('.vr-ip', row).hidden = e.target.value !== 'in_place';
});

/* « Tester le répertoire » : on répond pendant que le formulaire est encore sous les yeux.
   Découvrir un mauvais chemin au premier run, c'est un run perdu et une erreur loin de sa cause. */
$('#verifierRepoBox') && $('#verifierRepoBox').addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('.vr-test');
  if (!b) return;
  const row = b.closest('.vr-row');
  const info = $('.vr-test-info', row);
  const workdir = $('.vr-workdir', row).value.trim();
  info.className = 'vr-test-info muted';
  info.textContent = tr('verify.test.running');
  try {
    const r = await busy(b, () => api('/verifiers/test-workdir', { method: 'POST', body: { repo_id: Number(row.dataset.repo), workdir } }));
    if (!r.ok) { info.className = 'vr-test-info err'; info.textContent = r.raison || tr('verify.test.ko'); return; }
    /* Deux réserves distinctes, et une seule est bloquante : des modifications non commitées
       feraient refuser le run, des fichiers non suivis non — mais il faut savoir qu'ils
       seront là pendant les tests. Les taire ferait passer pour propre un répertoire qui ne
       l'est pas tout à fait. */
    info.className = 'vr-test-info ok';
    const reserves = [
      r.dirty ? tr('verify.test.dirty') : '',
      r.untracked ? tr('verify.test.untracked', { n: r.untracked, count: r.untracked }) : '',
    ].filter(Boolean);
    info.textContent = tr('verify.test.ok', { branch: r.branche || '?' })
      + (reserves.length ? ` — ${reserves.join(' · ')}` : '');
  } catch (err) { info.className = 'vr-test-info err'; info.textContent = explainError(err.message); }
});

function renderVerifierList() {
  const el = $('#verifierList');
  if (!el) return;
  if (!verifiers.length) {
    el.innerHTML = emptyState({ icon: 'check', title: tr('verify.verifiers.empty.title'), text: tr('verify.verifiers.empty.text') });
    return;
  }
  /* UN VÉRIFICATEUR HÉRITÉ DE LA FAMILLE « SCRIPT » se voit du premier coup d'œil et ne se
     modifie pas : le formulaire ne sait plus le décrire, et le lancer est refusé côté serveur.
     Il reste listé, avec le geste à faire — le supprimer sans le dire priverait quelqu'un de sa
     configuration, l'afficher comme les autres lui ferait croire qu'il tourne encore. */
  el.innerHTML = verifiers.map((v) => {
    const herite = v.kind !== 'commands';
    return `<div class="card${herite ? ' is-hidden' : ''}" data-id="${v.id}">
    <div class="card-main">
      <div class="title">${esc(v.name)}${herite ? ` <span class="tag stale">${esc(tr('verify.kind.script-removed.tag'))}</span>` : ''}${v.approval_pending ? ` <span class="tag warn">${esc(tr('approval.tag'))}</span>` : ''}</div>
      ${v.approval_pending ? blocApprobation({
    texte: tr(v.approved_before ? 'approval.verifier.changed' : 'approval.verifier.new'),
    avant: v.approved_before ? (v.approved_before.commands || []) : null,
    apres: v.commands || [],
    bouton: `<button type="button" class="btn btn-primary btn-sm" data-vapprove="${v.id}">${esc(tr('approval.btn'))}</button>`,
  }) : ''}
      <div class="meta">${herite
    ? `<code>${esc(v.command || '')}</code>`
    : (v.commands || []).map((c) => `<button type="button" class="code-copy" data-copy-txt="${esc(c)}" title="${esc(tr('verify.copy-command'))}"><code>${esc(c)}</code></button>`).join(' <span class="muted">→</span> ')}</div>
      <div class="meta">${(v.repos || []).map((r) => {
    const p = (repoOptions.find((x) => x.id === r.repo_id) || {}).project || `#${r.repo_id}`;
    return `<span class="tag">${esc(p)} · ${esc(r.mode === 'in_place' ? tr('verify.mode.in-place-short') : tr('verify.mode.worktree-short'))}</span>`;
  }).join(' ')}</div>
      ${/* CE QU'IL A DONNÉ, ET CE QUI L'ATTEND. Une liste de vérificateurs sans verdict ne dit
            pas lesquels servent : le dernier verdict avec sa date, et le nombre de merge
            requests à traiter que sa couverture concerne. */''}
      <div class="meta muted">${[
    v.last ? `<span class="tmr-verdict v-${esc(v.last.verdict)}">${esc(tr(`mr.ref.verdict.${v.last.verdict}`))}</span>${v.last.at ? ` <span data-when="${esc(v.last.at)}">${esc(fmtDate(v.last.at))}</span>` : ''}` : esc(tr('verify.verifier.never')),
    v.pending_mrs ? esc(tr('verify.verifier.pending', { n: v.pending_mrs, count: v.pending_mrs })) : '',
    /* A/Réglages 3 — combien de sessions le portent. Renommer ou supprimer se faisait à
       l'aveugle : douze sessions le relanceraient en finissant, et rien ne le disait. */
    v.used_by_tasks ? esc(tr('verify.verifier.used-by', { n: v.used_by_tasks, count: v.used_by_tasks })) : '',
    /* CE QUI MANQUE SUR CE POSTE. Les valeurs d'environnement ne voyagent pas — ce sont des
       secrets en puissance. Un vérificateur reçu d'un collègue arrive avec les NOMS de ses
       variables : le dire ici évite un échec au lancement dont la cause serait à chercher. */
    (v.env_missing || []).length
      ? `<span class="tag warn" title="${esc((v.env_missing || []).join(', '))}">${esc(tr('verify.verifier.env-missing', { n: v.env_missing.length, count: v.env_missing.length }))}</span>` : '',
  ].filter(Boolean).join(' · ')}</div>
      ${herite
    ? `<p class="field-note">${esc(tr('verify.kind.script-removed.hint'))}</p>`
    : `<div class="meta muted">${[
    esc(tr('verify.kind.commands')),
    esc(tr('verify.verifier.meta', { timeout: v.timeout_s })),
    v.run_base ? esc(tr('verify.verifier.with-base')) : '',
    v.comment_on_forge ? esc(tr('verify.verifier.comments')) : '',
    v.auto_on_mr ? esc(tr('verify.verifier.auto')) : '',
    /* A27 — CE QUI NE SE VOYAIT QU'EN OUVRANT LE FORMULAIRE. Quatre réglages décident de ce
       que ce vérificateur fait vraiment — repartir sur une MR périmée, lire un rapport JUnit,
       lire le TAP de la sortie, mentionner quelqu'un en commentant — et la ligne n'en disait
       rien : pour savoir pourquoi celui-ci repart tout seul et pas l'autre, il fallait ouvrir
       les deux. */
    v.auto_on_stale ? esc(tr('verify.verifier.auto-stale')) : '',
    v.report_path ? esc(tr('verify.verifier.report-path', { path: v.report_path })) : '',
    v.parse_tap ? esc(tr('verify.verifier.parse-tap')) : '',
    v.mentions ? esc(tr('verify.verifier.mentions', { who: v.mentions })) : '',
  ].filter(Boolean).join(' · ')}</div>`}
    </div>
    <div class="card-actions"><div class="btn-group">
      ${herite ? '' : `<button class="btn" data-vbranch="${v.id}" title="${esc(tr('verify.branch.title'))}">${svgIco('branch')}${esc(tr('verify.branch.btn'))}</button>
      <button class="btn" data-vedit="${v.id}">${svgIco('edit')}${esc(tr('settings.repo.edit'))}</button>
      <button class="btn" data-vcopy="${v.id}" title="${esc(tr('verify.verifier.duplicate.title'))}">${svgIco('copy')}${esc(tr('verify.verifier.duplicate'))}</button>`}
      <button class="btn btn-danger" data-vdel="${v.id}">${svgIco('trash')}${esc(tr('ui.delete'))}</button>
    </div></div>
  </div>`;
  }).join('');
  $$('#verifierList [data-vedit]').forEach((b) => b.addEventListener('click', () => editerVerifier(Number(b.dataset.vedit))));
  /* APPROUVER, c'est dire « j'ai vu ces commandes, elles peuvent tourner sur MA machine ». */
  $$('#verifierList [data-vapprove]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const vu = (verifiers || []).find((x) => x.id === Number(b.dataset.vapprove));
      await busy(b, () => api(`/verifiers/${b.dataset.vapprove}/approve`, { method: 'POST', body: { signature: vu && vu.approval_signature } }));
      toast(tr('approval.done'));
      loadVerifiers();
    } catch (e) {
      toast(explainError(e.message), true);
      if (e.code === 'APPROBATION_PERIMEE') loadVerifiers();
    }
  }));
  $$('#verifierList [data-vcopy]').forEach((b) => b.addEventListener('click', () => dupliquerVerifier(Number(b.dataset.vcopy))));
  $$('#verifierList [data-vdel]').forEach((b) => b.addEventListener('click', async () => {
    const v = verifiers.find((x) => x.id === Number(b.dataset.vdel));
    if (!await confirmDialog({ title: tr('verify.verifier.del.title'), text: tr('verify.verifier.del.text', { name: (v && v.name) || '' }), confirmLabel: tr('ui.delete') })) return;
    supprimerAvecAnnulation({
      element: b.closest('.card'),
      message: tr('verify.verifier.deleted', { name: (v && v.name) || '' }),
      supprimer: () => api(`/verifiers/${b.dataset.vdel}`, { method: 'DELETE' }),
      apres: loadVerifiers,
    });
  }));
}

/* UN NOM LIBRE POUR LA COPIE. Les noms de vérificateurs sont uniques : recopier celui de
   l'original ferait échouer l'enregistrement au moment du clic, après avoir tout ajusté. On
   propose donc « X (copie) », puis « (copie 2) » — le champ reste sélectionné, renommer est le
   premier geste attendu. */
function nomLibreVerifier(nom) {
  const pris = new Set(verifiers.map((v) => v.name));
  let candidat = tr('verify.verifier.copy-name', { name: nom });
  for (let i = 2; pris.has(candidat); i += 1) candidat = tr('verify.verifier.copy-name-n', { name: nom, n: i });
  return candidat;
}

/* DUPLIQUER : le formulaire est rempli comme pour une modification, mais SANS identifiant —
   enregistrer crée donc un nouveau vérificateur au lieu d'écraser celui d'origine. C'est le
   geste de qui a dix dépôts à couvrir avec la même commande à un détail près : tout retaper,
   ou pire, modifier l'existant en croyant en créer un autre. */
function dupliquerVerifier(id) {
  const v = verifiers.find((x) => x.id === id);
  if (!v) return;
  remplirFormVerifier({ ...v, id: '', name: nomLibreVerifier(v.name) },
    tr('verify.verifier.duplicating', { name: v.name }));
  const f = $('#verifierForm');
  f.name.focus(); f.name.select();   // renommer est le premier geste
}

function editerVerifier(id) {
  const v = verifiers.find((x) => x.id === id);
  if (!v) return;
  remplirFormVerifier(v, tr('verify.verifier.editing', { name: v.name }));
}

function remplirFormVerifier(v, info) {
  const f = $('#verifierForm');
  f.id.value = v.id;
  f.name.value = v.name;
  f.report_path.value = v.report_path || '';
  f.parse_tap.checked = v.parse_tap == null ? true : !!v.parse_tap;
  /* Les valeurs viennent du POSTE : le serveur les recompose en « CLE=valeur » à partir des
     noms d'équipe et de ce qui est renseigné ici. Un vérificateur reçu d'un collègue arrive
     donc avec ses noms et des valeurs vides — à remplir. */
  f.env.value = v.env || '';
  f.timeout_s.value = v.timeout_s;
  f.run_base.checked = !!v.run_base;
  f.comment_on_forge.checked = !!v.comment_on_forge;
  f.auto_on_mr.checked = !!v.auto_on_mr;
  f.auto_on_stale.checked = !!v.auto_on_stale;
  f.comment_template.value = v.comment_template || '';
  f.mentions.value = v.mentions || '';
  majBlocCommentaire();
  renderCommandList(v.commands || []);
  renderVerifierRepoBox(v.repos || []);
  appliquerKind();
  $('#verifierInfo').textContent = info;
  ouvrirFormVerifier(true);
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#btnAddCommand') && $('#btnAddCommand').addEventListener('click', () => {
  renderCommandList([...commandesDuFormulaire(), '']);
  const champs = $$('#verifierCommandList .vc-cmd');
  if (champs.length) champs[champs.length - 1].focus();
});
$('#verifierCommandList') && $('#verifierCommandList').addEventListener('click', (e) => {
  const lignes = $$('#verifierCommandList .vc-row');
  const bouge = e.target.closest && e.target.closest('.vc-move');
  if (bouge) {
    deplacerCommande(lignes.indexOf(bouge.closest('.vc-row')), Number(bouge.dataset.dir));
    return;
  }
  const b = e.target.closest && e.target.closest('.vc-del');
  if (!b) return;
  renderCommandList(lignes.filter((r) => r !== b.closest('.vc-row')).map((r) => $('.vc-cmd', r).value));
});

/* Le formulaire reste FERMÉ tant qu'on ne demande rien. Déployé en permanence, il occupait
   l'écran entier — champs, liste de commandes, tableau des dépôts couverts — au-dessus de la
   liste des vérificateurs, qui est pourtant ce qu'on vient consulter. Il s'ouvre sur
   « Ajouter » ou sur « Modifier », et se referme dès qu'on a fini. */
function ouvrirFormVerifier(ouvert) {
  const f = $('#verifierForm');
  if (!f) return;
  f.hidden = !ouvert;
  const b = $('#btnNewVerifier');
  // Le bouton d'ouverture disparaît pendant l'édition : deux formulaires n'ont pas de sens,
  // et « Ajouter » alors qu'on modifie un vérificateur existant se lirait comme une erreur.
  if (b) b.hidden = ouvert;
}

function viderFormVerifier() {
  const f = $('#verifierForm');
  f.reset(); f.id.value = ''; f.run_base.checked = true; f.parse_tap.checked = true;
  /* C15 — le délai effectif s'ÉCRIT. Vide, avec « 900 » en gris, on ne sait pas si le
     vérificateur n'a pas de limite ou s'il en a une qu'on ne voit pas. */
  if (f.timeout_s) f.timeout_s.value = 900;
  renderVerifierRepoBox([]);
  renderCommandList([]);
  appliquerKind();
  majBlocCommentaire();
  $('#verifierInfo').textContent = '';
}

$('#btnNewVerifier') && $('#btnNewVerifier').addEventListener('click', () => {
  viderFormVerifier();
  ouvrirFormVerifier(true);
  const f = $('#verifierForm');
  /* `preventScroll` : sans lui, le focus redéfile de son côté et annule le dégagement que
     `scroll-margin-top` vient de ménager sous l'en-tête fixe — le champ « Nom » finissait
     caché derrière, et on croyait que le formulaire commençait à « Commandes ». */
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
  f.name.focus({ preventScroll: true });
});

$('#btnVerifierCancel') && $('#btnVerifierCancel').addEventListener('click', () => {
  viderFormVerifier();
  ouvrirFormVerifier(false);
});

$('#verifierForm') && $('#verifierForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  /* UN VÉRIFICATEUR SANS DÉPÔT NE SERT À RIEN, et s'enregistrait sans un mot : il n'apparaît
     ensuite dans aucune modale de lancement, et on cherche pourquoi. Même chose pour les
     commandes — le serveur les refusait vides, mais en exposant son type interne
     (« un vérificateur "commandes" a besoin… ») dans un toast à l'autre bout de l'écran. */
  viderErreursChamps(f);
  const commandes = commandesDuFormulaire();
  if (!commandes.length) {
    signalerChamp($('#verifierCommandList .vc-cmd'), tr('err.verifier-sans-commande'));
    return;
  }
  if (!verifierReposFromForm().length) {
    const boite = $('#verifierRepoBox');
    erreurChamp(boite && boite.querySelector('input'), tr('err.verifier-sans-depot'));
    if (boite) boite.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  const body = {
    name: f.name.value.trim(),
    commands: commandes,
    report_path: f.report_path.value.trim(),
    env: f.env.value,
    parse_tap: f.parse_tap.checked ? 1 : 0,
    timeout_s: Number(f.timeout_s.value) || undefined,
    run_base: f.run_base.checked ? 1 : 0,
    comment_on_forge: f.comment_on_forge.checked ? 1 : 0,
    auto_on_stale: f.auto_on_stale.checked ? 1 : 0,
    comment_template: f.comment_template.value,
    mentions: f.mentions.value,
    auto_on_mr: f.auto_on_mr.checked ? 1 : 0,
    repos: verifierReposFromForm(),
  };
  const id = f.id.value;
  try {
    await api(id ? `/verifiers/${id}` : '/verifiers', { method: id ? 'PUT' : 'POST', body });
    toast(tr('verify.verifier.saved'));
    viderFormVerifier();
    ouvrirFormVerifier(false);
    await loadVerifiers();
  } catch (err) { toast(explainError(err.message), true); }
});

