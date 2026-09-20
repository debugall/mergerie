'use strict';
/* La carte d'une merge request : sa taille, ses notes, l'édition d'un commentaire, le suivi de résolution, les constats ; les boutons contextuels. */
// @expose noteBadge, remplirLiensDifferes
/* ---------- La taille d'une merge request, sur sa carte ----------
   « Par laquelle commencer ? » se répondait en ouvrant trois cartes. Le nombre de fichiers, le
   volume de lignes et la date de dernière activité tiennent sur une ligne — et ce sont
   exactement les trois choses qu'on allait chercher. Rien n'est calculé ici : tout vient du
   relevé fait à la découverte, dans le même appel que les chemins modifiés. */
function tailleMr(m) {
  const s = m && m.size;
  const bouts = [];
  if (s && s.files) bouts.push(tr('mr.size.files', { n: s.files, count: s.files }));
  if (s && (s.additions || s.deletions)) {
    bouts.push(`<span class="diffstat"><span class="plus">+${s.additions || 0}</span> <span class="moins">−${s.deletions || 0}</span></span>`);
  }
  if (m && m.updated_at) bouts.push(`<span data-when="${esc(m.updated_at)}">${esc(tr('mr.size.activity', { when: depuis(m.updated_at) }))}</span>`);
  if (!bouts.length) return '';
  return `<div class="meta mr-taille">${bouts.join(' · ')}</div>`;
}

function noteBadge(note, m) {
  const cls = noteClass(note);
  if (!cls) return `<span class="note none" title="${tr('review.note.none')}">—</span>`;
  const detail = detailNote(m);
  const bulle = detail ? ` data-tip="${esc(detail)}"` : '';
  return `<span class="note ${cls}" title="${esc(tr('review.note.title'))}"${bulle}>${esc(fmtNote(note))}</span>`;
}

$('#btnResetReports').addEventListener('click', async () => {
  if (!await confirmDialog({ text: tr('confirm.reset-all'), confirmLabel: tr('ui.delete') })) return;
  try {
    const r = await api('/reports/reset', { method: 'POST' });
    selectedMr = null;
    renderReportPlaceholder();
    toast(tr('toast.rapport-s-supprime-s-repart', { deleted: r.deleted }));
    loadReports(currentSeg);
    loadToReview();
  } catch (e) { toast(e.message, true); }
});

/* HTML d'une note (auteur, date, corps markdown). Servie telle quelle par les commentaires
   généraux du rapport ET par les fils inline du visualiseur — une seule implémentation.
   `data-raw` garde le Markdown SOURCE : le corps affiché est du HTML rendu, il ne peut pas
   servir à repeupler l'éditeur sans reperdre la mise en forme d'origine. */
function noteHtml(n, mrId) {
  const edit = n.editable && n.id != null
    ? `<button type="button" class="cmt-edit-btn" data-note="${esc(n.id)}" data-mr="${esc(mrId)}"`
      + ` data-inline="${n.position ? 1 : 0}" title="${esc(tr('cmt.edit.title'))}">${tr('cmt.edit.btn')}</button>`
    : '';
  return `<div class="cmt" data-raw="${esc(n.body)}">`
    + `<div class="cmt-head"><b>${esc(n.author)}</b> <span class="muted">${fmtDate(n.created_at)}</span>`
    + `${n.resolved ? ` <span class="tag done">${tr('cmt.resolved')}</span>` : ''}`
    + `<span class="spacer"></span>${edit}</div>`
    + `<div class="cmt-body md">${mdToHtml(n.body)}</div></div>`;
}

/* Modification d'un commentaire déjà posté, en place : le corps rendu cède la place à un
   éditeur pré-rempli du Markdown source. Délégué une fois pour les deux endroits où des
   notes s'affichent — le geste et le rendu y sont identiques. */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.cmt-edit-btn');
  if (!btn) return;
  const cmt = btn.closest('.cmt');
  const body = cmt.querySelector('.cmt-body');
  if (cmt.querySelector('.cmt-edit')) return;           // déjà en cours d'édition
  const ed = document.createElement('div');
  ed.className = 'cmt-editor cmt-edit';
  ed.innerHTML = '<textarea></textarea>'
    + `<div class="cmt-actions"><button type="button" class="btn btn-sm cmt-edit-cancel">${tr('ui.cancel')}</button>`
    + `<button type="button" class="btn btn-sm btn-primary cmt-edit-save">${tr('ui.save')}</button></div>`;
  const ta = ed.querySelector('textarea');
  ta.value = cmt.dataset.raw || '';
  body.hidden = true; btn.hidden = true;
  body.after(ed);
  ta.focus();

  const close = () => { ed.remove(); body.hidden = false; btn.hidden = false; };
  ed.querySelector('.cmt-edit-cancel').addEventListener('click', close);
  ed.querySelector('.cmt-edit-save').addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) { toast(tr('cmt.edit.empty'), true); return; }
    const save = ed.querySelector('.cmt-edit-save');
    try {
      const d = await busy(save, () => api(`/mrs/${btn.dataset.mr}/notes/${encodeURIComponent(btn.dataset.note)}`, {
        method: 'PUT', body: { body: text, inline: btn.dataset.inline === '1' },
      }));
      // On réaffiche ce que la forge a RÉELLEMENT enregistré, pas ce qu'on a envoyé.
      cmt.dataset.raw = d.body || text;
      body.innerHTML = mdToHtml(cmt.dataset.raw);
      close();
      toast(tr('cmt.edit.done'));
    } catch (err) { toast(explainError(err.message), true); }
  });
});
// Bloc « Répondre » d'un fil de discussion.
function replyBtnHtml(discId, mrId) {
  return `<div class="cmt-reply"><button class="cmt-reply-btn" type="button" data-disc="${esc(discId)}" data-mr="${mrId}" title="${tr('cmt.reply-thread.title', { forge: forgeLabel(split.forge) })}">↩ ${tr('cmt.reply.btn')}</button></div>`;
}

// Commentaires généraux (non-inline) de la MR, dans le détail du rapport.
async function loadMrComments(id) {
  const el = $('#mrComments');
  if (!el) return;
  try {
    const dd = await api(`/mrs/${id}/discussions`);
    const general = (dd.discussions || []).filter((d) => d.notes[0] && !d.notes[0].position);
    if (!general.length) { el.innerHTML = `<p class="muted">${tr('cmt.none')}</p>`; return; }
    el.innerHTML = general.map((d) => `<div class="cmt-thread" data-disc="${esc(d.id)}">`
      + d.notes.map((n) => noteHtml(n, id)).join('') + replyBtnHtml(d.id, id) + '</div>').join('');
  } catch (e) { el.innerHTML = `<p class="muted">Commentaires indisponibles (${esc(e.message)})</p>`; }
}

/* Suivi de résolution : bandeau (résolus/persistants/nouveaux + évolution de la
   note) et liste des constats de la dernière passe. Chaque constat porte son état,
   avec la nuance « disparu » (non re-signalé, code inchangé) distincte de « résolu »
   (git-vérifié) — c'est le garde-fou du doc, rendu visible. */
// Clés écrites en toutes lettres (et non `tr('...' + status)`) pour rester
// greppables — c'est ce que vérifie npm run i18n:check.
const FINDING_STATUS = {
  resolved: { icon: svgIco('check'), cls: 'ok', key: 'resolution.status.resolved' },
  persistent: { icon: '●', cls: 'warn', key: 'resolution.status.persistent' },
  new: { icon: '+', cls: 'new', key: 'resolution.status.new' },
  disappeared: { icon: '~', cls: 'muted', key: 'resolution.status.disappeared' },
};
const SEV = {
  blocker: { cls: 'blocker', key: 'sev.blocker' },
  major: { cls: 'major', key: 'sev.major' },
  minor: { cls: 'minor', key: 'sev.minor' },
  info: { cls: 'info', key: 'sev.info' },
};

/* Joue une fois le compte des constats résolus. La clé (MR, version) vit en localStorage :
   elle doit survivre au rechargement de la page, sinon le tic revient à chaque F5. */
function jouerResolution(mrId, version, resolus) {
  if (!resolus || version < 2) return;
  const cle = `aidevtools_res_${mrId}_${version}`;
  try { if (localStorage.getItem(cle)) return; localStorage.setItem(cle, '1'); } catch { return; }
  const chip = $('#resolutionBox .res-chip.ok');
  if (!chip) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;  // le résultat, pas le trajet
  const texte = chip.textContent;
  const t0 = performance.now(); const dur = 700;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const n = Math.round(resolus * (1 - (1 - k) ** 3));
    chip.textContent = texte.replace(String(resolus), String(n));
    if (k < 1 && !document.hidden) requestAnimationFrame(step); else chip.textContent = texte;
  };
  requestAnimationFrame(step);
}

async function renderResolution(id, versions) {
  const box = $('#resolutionBox');
  if (!box) return;
  const latest = versions[0];
  if (!latest) { box.hidden = true; return; }
  /* LE BANDEAU N'ARRIVE QU'À LA DEUXIÈME PASSE ; LA LISTE DES CONSTATS EXISTE DÈS LA PREMIÈRE.
     Les deux vivaient dans la même boîte, et la boîte entière était masquée faute de delta à
     raconter : une review d'UNE SEULE passe n'affichait donc aucun constat, aucune gravité,
     aucun filtre — alors que la liste était là, complète, dans la réponse du serveur. Invisible
     tant qu'on reviewe ses propres merge requests (on relance, on passe en v2) ; systématique
     sur une review REÇUE d'un collègue, qui arrive avec sa passe unique et rien d'autre. */
  const r = latest.resolution;
  // Évolution de la note entre l'avant-dernière et la dernière passe.
  const prev = versions[1];
  const noteFrom = prev ? prev.note10 : null;
  const noteTo = latest.note10;
  const noteBit = (noteFrom != null && noteTo != null && noteFrom !== noteTo)
    ? ` · ${tr('resolution.note-evo', { from: noteFrom, to: noteTo })}` : '';
  const bits = !r ? '' : [
    r.resolved ? `<span class="res-chip ok">${tr('resolution.resolved', { n: r.resolved, count: r.resolved })}</span>` : '',
    r.persistent ? `<span class="res-chip warn">${tr('resolution.persistent', { n: r.persistent, count: r.persistent })}</span>` : '',
    r.new ? `<span class="res-chip new">${tr('resolution.new', { n: r.new, count: r.new })}</span>` : '',
    r.disappeared ? `<span class="res-chip muted" title="${tr('resolution.disappeared-hint')}">${tr('resolution.disappeared', { n: r.disappeared, count: r.disappeared })}</span>` : '',
  ].filter(Boolean).join('');
  const banniere = r ? `<div class="resolution-banner">
      <span class="res-title">${tr('resolution.title', { v: latest.version })}</span>${bits}<span class="res-note">${noteBit}</span>
    </div>` : '';
  box.innerHTML = `${banniere}<div id="findingsChips" class="findings-chips" hidden></div><div id="findingsList" class="findings-list"></div>`;
  box.hidden = false;
  /* Le compte des constats résolus se JOUE, une seule fois par (MR, version). C'est la seule
     micro-récompense de l'app entièrement dérivée d'un fait : l'IA avait trouvé huit choses,
     il en reste deux. Rejouée à chaque ouverture du rapport elle deviendrait un tic — d'où la
     clé mémorisée. Jamais sur une première review : il n'y a rien à résoudre. */
  if (r) jouerResolution(id, latest.version, r.resolved);

  // Liste détaillée des constats de la dernière passe.
  const list = $('#findingsList');
  let data;
  /* Sans bandeau, la boîte n'a que la liste à montrer : pas de constat, pas de boîte — sinon
     l'écran gagnerait un cadre vide là où il n'y avait rien. */
  const vide = () => { list.hidden = true; if (!r) box.hidden = true; };
  try { data = await api(`/mrs/${id}/findings`); } catch { vide(); return; }
  if (!data.findings || !data.findings.length) { vide(); return; }
  list.innerHTML = data.findings.map((f) => {
    const st = FINDING_STATUS[f.status] || { icon: '·', cls: '', key: null };
    const sv = SEV[f.severity] || SEV.minor;
    /* UN CONSTAT EST UNE PORTE. Il nommait un fichier et une ligne, et il fallait ouvrir le
       code, chercher le fichier dans l'arbre, descendre à la ligne, cliquer « + » et retaper
       le constat en le reformulant. Le chemin devient un lien : la visionneuse s'ouvre sur
       cette ligne, l'éditeur de commentaire dessous, pré-rempli du constat. Il reste un
       BROUILLON comme tout commentaire inline — on relit, on ajuste, on envoie groupé. */
    const loc = f.file
      ? `<button type="button" class="f-loc" data-finding-go="${esc(f.file)}" data-fline="${f.line || ''}" data-ftitle="${esc(f.title || '')}" title="${esc(tr('report.finding.go-title'))}"><code>${esc(f.file)}${f.line ? ':' + f.line : ''}</code></button>`
      : '';
    return `<div class="finding f-${st.cls}" data-sev="${esc(f.severity || 'minor')}" data-status="${esc(f.status || '')}">
        <span class="f-mark" title="${st.key ? esc(tr(st.key)) : ''}">${st.icon}</span>
        <span class="f-sev sev-${sv.cls}">${esc(tr(sv.key))}</span>
        ${loc}
        <span class="f-title">${esc(f.title || '')}</span>
        ${/* A6 — UN CONSTAT MÈNE À UNE QUESTION OU À UNE CORRECTION CIBLÉE. Il ne menait qu'au
              code : pour demander « pourquoi celui-là ? », il fallait descendre au champ de
              questions et retaper le constat ; pour le faire corriger, on envoyait le rapport
              ENTIER, quarante constats compris, pour en faire traiter un. */''}
        <span class="f-actions">
          <button type="button" class="btn btn-sm btn-ghost f-ask" data-f-ask="${esc(f.title || '')}" data-f-file="${esc(f.file || '')}" data-f-line="${f.line || ''}" title="${esc(tr('report.finding.ask-title'))}">${svgIco('info')}</button>
          <button type="button" class="btn btn-sm btn-ghost f-fix" data-f-fix="${esc(f.title || '')}" data-f-file="${esc(f.file || '')}" data-f-line="${f.line || ''}" data-f-sev="${esc(f.severity || '')}" title="${esc(tr('report.finding.fix-title'))}">${svgIco('bot')}</button>
        </span>
        ${/* DEPUIS QUAND. « Persistant » dit « déjà là à la passe d'avant » ; il ne dit pas
              qu'un constat traîne depuis la première review. Trois passes plus tard, c'est
              exactement la différence entre « pas encore corrigé » et « jamais corrigé ». */''}
        ${f.since && f.since < data.version ? `<span class="f-since muted" title="${esc(tr('report.finding.since.title', { v: f.since }))}">${esc(tr('report.finding.since', { v: f.since }))}</span>` : ''}
      </div>`;
  }).join('');
  /* A10 — LES CONSTATS SE FILTRENT PAR GRAVITÉ. La liste était plate : sur un rapport à
     quarante constats, les deux bloquants se cherchaient à l'œil parmi les « info ». Les chips
     MASQUENT, comme partout ailleurs — et « masquer les résolus » enlève le bruit d'une
     troisième passe, où l'essentiel de la liste est déjà traité. */
  const parSev = {};
  for (const f of data.findings) parSev[f.severity] = (parSev[f.severity] || 0) + 1;
  const resolus = data.findings.filter((f) => f.status === 'resolved').length;
  const chips = $('#findingsChips');
  if (chips) {
    chips.innerHTML = ['blocker', 'major', 'minor', 'info']
      .filter((k) => parSev[k])
      .map((k) => `<button type="button" class="chip${sevMasquees.has(k) ? '' : ' active'}" data-f-sev-chip="${k}"
        title="${esc(tr('report.finding.chip-title'))}">${esc(tr((SEV[k] || SEV.minor).key))} <span class="muted">${parSev[k]}</span></button>`).join('')
      + (resolus ? `<label class="inline-check"><input type="checkbox" id="masquerResolus"${masquerResolus ? ' checked' : ''} />
        <span>${esc(tr('report.finding.hide-resolved', { n: resolus, count: resolus }))}</span></label>` : '')
      /* A7 — HUIT CONSTATS, HUIT OUVERTURES DU VIEWER. Les poser en commentaires demandait, pour
         chacun, de chercher le fichier, descendre à la ligne, cliquer « + » et recopier le
         constat. Ils portent déjà leur fichier et leur ligne : ce sont des brouillons inline
         tout faits. Rien n'est envoyé — on relit et on envoie groupé, comme d'habitude. */
      + `<span class="spacer"></span>
        <button type="button" class="btn btn-sm" data-f-drafts="all" title="${esc(tr('report.finding.drafts-all-title'))}">${svgIco('doc')}${esc(tr('report.finding.drafts-all'))}</button>
        ${parSev.blocker ? `<button type="button" class="btn btn-sm" data-f-drafts="blocking" title="${esc(tr('report.finding.drafts-blocking-title'))}">${esc(tr('report.finding.drafts-blocking', { n: parSev.blocker, count: parSev.blocker }))}</button>` : ''}`;
    chips.hidden = data.findings.length < 2;
    $$('#findingsChips [data-f-drafts]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const r = await busy(b, () => api(`/mrs/${id}/comment-drafts/from-findings`, {
          method: 'POST', body: { blocking_only: b.dataset.fDrafts === 'blocking' },
        }));
        /* ON DIT CE QUI N'EST PAS PARTI. Un constat sans fichier ni ligne n'a pas d'endroit où
           s'accrocher, un brouillon identique existe déjà : taire ces deux cas ferait croire à
           un compte qui ne tombe pas juste. */
        const restes = [
          r.skipped_no_position ? tr('report.finding.drafts-skipped', { n: r.skipped_no_position, count: r.skipped_no_position }) : '',
          /* HORS DU DIFF : le cas le plus fréquent, et le seul qui surprend. Un constat peut
             parler d'une ligne que la branche n'a pas touchée — une remarque inline, non : la
             forge refuse la position, et l'écran l'afficherait collée à une ligne que personne
             n'a modifiée. On le dit plutôt que de compter juste sans expliquer. */
          r.skipped_outside_diff ? tr('report.finding.drafts-outside', { n: r.skipped_outside_diff, count: r.skipped_outside_diff }) : '',
          r.skipped_existing ? tr('report.finding.drafts-dup', { n: r.skipped_existing, count: r.skipped_existing }) : '',
        ].filter(Boolean).join(' · ');
        toast(`${tr('report.finding.drafts-done', { n: r.created, count: r.created })}${restes ? ` — ${restes}` : ''}`);
        openReport(id, { force: true });      // le badge « brouillons » de l'en-tête doit suivre
        await rafraichirBrouillons(id);       // et celui de la carte dans la liste, avec lui
      } catch (e) { toast(explainError(e.message), true); }
    }));
  }
  appliquerFiltreConstats();
  list.hidden = false;
}

/* Ce qui est masqué dans la liste des constats. En mémoire d'écran : c'est un coup d'œil, pas
   une préférence — on ne veut pas retrouver des constats cachés trois jours plus tard. */
let sevMasquees = new Set();
let masquerResolus = false;
function appliquerFiltreConstats() {
  $$('#findingsList .finding').forEach((f) => {
    const masque = sevMasquees.has(f.dataset.sev) || (masquerResolus && f.dataset.status === 'resolved');
    f.hidden = masque;
  });
  $$('#findingsChips [data-f-sev-chip]').forEach((c) => c.classList.toggle('active', !sevMasquees.has(c.dataset.fSevChip)));
}
/* Où se trouve le constat, écrit une fois : le prompt le cite pour que l'IA n'ait pas à le
   rechercher, et la phrase reste lisible quand la ligne manque. */
function ouConstat(b) {
  const f = b.dataset.fFile;
  if (!f) return '';
  return b.dataset.fLine ? tr('report.finding.at', { file: f, line: b.dataset.fLine })
    : tr('report.finding.in', { file: f });
}

/* A6 — « POURQUOI CE CONSTAT ? » : la question part dans le champ des échanges de la revue, et
   n'attend qu'un clic de plus. On ne l'envoie PAS tout seul : une question coûte un appel IA,
   et c'est à l'utilisateur de décider ce qu'il demande — on lui fait gagner la frappe, pas la
   décision. */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-f-ask]');
  if (!b) return;
  const champ = $('#askInput');
  if (!champ) return;
  champ.value = tr('report.finding.ask-prompt', { title: b.dataset.fAsk, ou: ouConstat(b) });
  champ.scrollIntoView({ block: 'center', behavior: 'smooth' });
  champ.focus();
});

/* …et « CORRIGER CECI » : une session de codage sur CE constat, pas sur le rapport entier.
   Envoyer les quarante constats pour en faire traiter un fait rouvrir du code qu'on ne voulait
   pas voir toucher — et c'est le reproche le plus fréquent fait à « Faire corriger ». */
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-f-fix]');
  if (!b || !selectedMr) return;
  const m = reportRows.find((x) => x.id === selectedMr) || {};
  await openTaskForMr(m, {
    prompt: tr('report.finding.fix-prompt', { title: b.dataset.fFix, ou: ouConstat(b) }),
    commitMessage: `fix: ${String(b.dataset.fFix || '').slice(0, 60)}`,
  });
});

document.addEventListener('click', (e) => {
  const chip = e.target.closest && e.target.closest('[data-f-sev-chip]');
  if (!chip) return;
  const k = chip.dataset.fSevChip;
  if (sevMasquees.has(k)) sevMasquees.delete(k); else sevMasquees.add(k);
  appliquerFiltreConstats();
});
document.addEventListener('change', (e) => {
  if (!e.target.matches || !e.target.matches('#masquerResolus')) return;
  masquerResolus = e.target.checked;
  appliquerFiltreConstats();
});

/* ---------- Boutons contextuels sur une merge request ---------- */

/* Les liens du service associé au dépôt de la MR : ses URLs de grille, puis ses gabarits
   résolus avec la branche et le numéro. Un gabarit non résoluble ICI reste affiché, GRISÉ,
   avec sa raison — le faire disparaître laisserait croire qu'il n'existe pas. */
/* Les boutons contextuels, quelle que soit LEUR SOURCE : une merge request, la ligne de projet
   d'une session, ou un ticket Jira. Le serveur résout `{env}` / `{branch}` / `{mr_iid}` de la
   même façon dans les trois cas — c'est le même geste, il porte donc les mêmes boutons. */
/* Les blocs de liens rendus DANS UNE LISTE se remplissent après coup, une fois par ligne :
   les demander pendant le rendu ferait attendre la liste pour un ornement. */
function remplirLiensDifferes(racine) {
  for (const el of $$('[data-liens-task]', racine || document)) {
    if (el.dataset.liensFait === '1') continue;
    el.dataset.liensFait = '1';
    renderLiensContextuels(`/tasks/${el.dataset.liensTask}/targets/${el.dataset.liensTarget}/links`, el);
  }
  for (const el of $$('[data-liens-ticket]', racine || document)) {
    if (el.dataset.liensFait === '1') continue;
    el.dataset.liensFait = '1';
    renderLiensContextuels(`/jira/issues/${encodeURIComponent(el.dataset.liensTicket)}/links`, el);
  }
}

async function renderLiensContextuels(route, box) {
  if (!box) return;
  let d;
  try { d = await api(route); } catch { return; }
  return renderBoutonsLiens(d, box);
}

async function renderMrLinks(mrId, box) {
  if (!box) return;
  let d;
  try { d = await api(`/mrs/${mrId}/links`); } catch { return; }
  return renderBoutonsLiens(d, box);
}

function renderBoutonsLiens(d, box) {
  if (!d.service || (!d.envs.length && !d.context.length)) return;
  const boutons = [
    /* Un bouton PAR ADRESSE : une case qui porte « erreurs paiement » et « latence API » en
       donne deux, chacun nommé. Sans le libellé, deux boutons « Ouvrir · prod » côte à côte
       obligeraient à en survoler un pour savoir lequel est lequel. */
    /* LA RÉFÉRENCE A TROIS SEGMENTS, comme partout ailleurs : la frécence se compte PAR
       ADRESSE (`service:environnement:adresse`). À deux, chaque ouverture depuis une merge
       request se perdait — ni la palette ni « dernière ouverture » ne la voyaient passer. */
    ...d.envs.map((e) => `<a class="btn btn-sm" href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener noreferrer"
        data-usekind="service_url" data-useref="${d.service.id}:${e.environment_id}:${e.id}" title="${esc(e.url)}">
        <span class="link-env-dot" style="background:${esc(e.color)}"></span>${esc(e.label
          ? tr('links.mr.open-named', { env: e.env, name: e.label })
          : tr('links.mr.open', { env: e.env }))}</a>`),
    ...d.context.flatMap((c) => {
      if (c.per_env.length) {
        return c.per_env.map((k) => (k.url
          ? `<a class="btn btn-sm" href="${esc(safeUrl(k.url))}" target="_blank" rel="noopener noreferrer">${svgIco('zap')}${esc(c.label)} · ${esc(k.env)}</a>`
          : `<button type="button" class="btn btn-sm" disabled title="${esc(tr('links.mr.unresolved', { name: `{${k.manquante}}` }))}">${svgIco('zap')}${esc(c.label)} · ${esc(k.env)}</button>`));
      }
      return [c.url
        ? `<a class="btn btn-sm" href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener noreferrer">${svgIco('zap')}${esc(c.label)}</a>`
        : `<button type="button" class="btn btn-sm" disabled title="${esc(tr('links.mr.unresolved', { name: `{${c.manquante}}` }))}">${svgIco('zap')}${esc(c.label)}</button>`];
    }),
  ];
  box.innerHTML = `<div class="mr-links"><span class="muted">${esc(d.service.name)}</span>${boutons.join('')}</div>`;
}

