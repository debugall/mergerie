'use strict';
/* A21 — l'erreur d'une session propose son remède (`explainError`, `errorBox`) ; une branche qui réécrit les règles de l'agent (`avecConfigAgent`). */
/* UNE BRANCHE QUI RÉÉCRIT LES RÈGLES DE L'AGENT (409 CONFIG_AGENT) : le serveur nomme les
   fichiers, on les montre, et un accord renvoie l'empreinte vue — un nouveau push qui les change
   encore redemandera. `envoyer(extra)` refait la même requête, le corps complété de l'accord. */
async function avecConfigAgent(envoyer) {
  try {
    return await envoyer({});
  } catch (e) {
    if (e.code !== 'CONFIG_AGENT' || !e.data || !e.data.empreinte) throw e;
    const ok = await confirmDialog({
      title: tr('confirm.agent-config.title'), text: e.message,
      detail: (e.data.files || []).join('\n'), confirmLabel: tr('confirm.agent-config.ok'),
    });
    if (!ok) { const annule = new Error(''); annule.annule = true; throw annule; }
    return envoyer({ accept_agent_config: e.data.empreinte });
  }
}
// Bloc d'erreur persistant, copiable et fermable.
// mrId (optionnel) : si fourni, le ✕ efface aussi l'erreur en base.
// Traduit les erreurs techniques en message actionnable, SANS masquer l'original
// (le message brut reste affiché et copiable — il sert au diagnostic).
const ERROR_HINTS = [
  /* LE SERVEUR NE RÉPOND PAS. `fetch` rend « Failed to fetch » (Chrome) ou « Load failed »
     (Safari) — deux messages en anglais, sans sujet ni verbe utile, affichés tels quels à
     quelqu'un dont l'application tourne sur SA machine et qu'il suffit de relancer. */
  [/Failed to fetch|Load failed|NetworkError|network error/i, 'err.hint.offline'],
  [/UNABLE_TO_GET_ISSUER_CERT|self.signed|CERT_|DEPTH_ZERO/i, 'err.hint.cert'],
  [/\b401\b|\b403\b|Unauthorized|Forbidden|invalid.token/i, 'err.hint.token'],
  [/ENOENT|command not found|copilot.*introuvable|spawn .* ENOENT/i, 'err.hint.cli'],
  [/timeout|ETIMEDOUT/i, 'err.hint.timeout'],
  [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i, 'err.hint.network'],
];
function errorHint(msg) {
  const hit = ERROR_HINTS.find(([re]) => re.test(String(msg || '')));
  return hit ? tr(hit[1]) : null;
}

/* A21 — L'ERREUR D'UNE SESSION PROPOSE SON REMÈDE.
 *
 * « push refusé : la branche distante a divergé » n'offrait que « Relancer », qui REFAIT TOUT
 * le codage — vingt minutes d'agent pour un problème de git de trois secondes. Le remède
 * existe pourtant déjà, ailleurs dans l'écran : le rattrapage de base, le push forcé avec
 * bail, la résolution de conflit, le re-clonage.
 *
 * La table associe un MOTIF à un geste qui existe. Rien n'est inventé ici : chaque entrée
 * clique un bouton rendu ou appelle la route que ce bouton appellerait — deux chemins pour un
 * même effet finiraient par ne plus demander la même confirmation.
 *
 * `null` = pas de remède connu : la boîte reste ce qu'elle était. On ne propose jamais un
 * geste « au cas où » sur une erreur qu'on n'a pas reconnue. */
const REMEDES = [
  { re: /diverg|non-fast-forward|fetch first|rejected.*push/i, cle: 'err.fix.diverged', act: 'rattraper' },
  { re: /conflit|conflict/i, cle: 'err.fix.conflict', act: 'merge' },
  { re: /session .*(introuvable|not found)|resume.*(failed|impossible)|No conversation found/i, cle: 'err.fix.session', act: 'neuve' },
  { re: /clone (absent|introuvable)|not a git repository|\.git.*(absent|missing)/i, cle: 'err.fix.clone', act: 'recloner' },
];
function remedeDe(texte) {
  return REMEDES.find((r) => r.re.test(String(texte || ''))) || null;
}
function explainError(msg) {
  const hint = errorHint(msg);
  return hint ? tr('err.hint.detail', { hint, msg }) : msg;
}

// mrId / taskId : permet d'effacer l'erreur EN BASE (sinon elle revient au refresh).
/* `localId` : une session hors dépôt a sa propre table, donc sa propre route d'effacement.
   Sans lui, la croix retirait l'encart de l'écran et l'erreur revenait au rafraîchissement
   suivant — le bouton avait l'air de marcher, ce qui est pire que pas de bouton. */
function errorBox(text, mrId, taskId, localId, askId) {
  const hint = errorHint(text);
  /* `errorBox(explainError(msg))` est un appel courant : `explainError` a DÉJÀ mis l'indice en
     tête du texte, et le recalculer ici l'affichait une seconde fois, mot pour mot, deux lignes
     plus bas. On ne le pose que s'il n'y est pas encore. */
  const hintHtml = hint && !String(text || '').includes(hint) ? `<div class="errhint">${esc(hint)}</div>` : '';
  const clear = mrId ? ` data-clear-mr="${mrId}"`
    : (taskId ? ` data-clear-task="${taskId}"`
      : (localId ? ` data-clear-local="${localId}"` : (askId ? ` data-clear-ask="${askId}"` : '')));
  /* RÉESSAYER, dans le bloc. Une panne de connexion se répare à côté (on relance le serveur)
     et l'écran, lui, restait sur son message : il fallait recharger la page pour en sortir,
     ce que rien ne disait. Le bouton n'apparaît que là où il a un sens — pas sur une erreur
     de jeton ou de certificat, qu'un nouvel essai ne changera pas. */
  const reessayer = /Failed to fetch|Load failed|NetworkError|network error/i.test(String(text || ''))
    ? `<button class="btn btn-sm errretry" title="${esc(tr('err.retry-title'))}"><svg class="ico ico-sm"><use href="#i-refresh"/></svg>${tr('err.retry')}</button>` : '';
  /* UNE PILE D'APPELS N'EST PAS UN MESSAGE D'ERREUR. Une session en échec affichait quarante
     lignes de `at runCodeTask (…/taskrunner.js:388:35)` dans un bloc de 400 px, en tête de
     carte : la cause tient sur la première ligne, le reste ne sert qu'à qui va lire le code.
     On garde donc la première ligne à l'écran et on replie la pile derrière « Détails » —
     rien n'est perdu, et « Copier » copie toujours le texte entier. */
  const lignes = String(text || '').split('\n');
  const iPile = lignes.findIndex((l) => /^\s+at\s/.test(l));
  const tete = iPile > 0 ? lignes.slice(0, iPile).join('\n').trimEnd() : String(text || '');
  const pile = iPile > 0 ? lignes.slice(iPile).join('\n') : '';
  const corps = `<pre>${esc(tete)}</pre>`
    + (pile ? `<details class="err-stack"><summary>${esc(tr('err.details'))}</summary><pre>${esc(pile)}</pre></details>` : '');
  /* Le remède, quand on en connaît un POUR CETTE SESSION : il n'a de sens que là où l'objet
     est identifié (une session sur dépôt), pas sur une erreur de liste ou de découverte. */
  const rem = taskId ? remedeDe(text) : null;
  const remHtml = rem
    ? `<div class="err-remede"><button class="btn btn-sm btn-primary" data-remede="${esc(rem.act)}" data-task="${taskId}">${svgIco('zap')}${esc(tr(rem.cle))}</button></div>`
    : '';
  return `<div class="errbox" data-full="${esc(text)}"><div class="errhead"><span>${svgIco('alert')} ${tr('ui.error')}</span>`
    + `<span class="errbtns">${reessayer}<button class="btn btn-sm errcopy" title="${esc(tr('err.copy-title'))}">${tr('ui.copy')}</button>`
    + `<button class="btn btn-icon btn-sm btn-danger errclear"${clear} title="${esc(tr('err.clear-title'))}"><svg class=\"ico ico-sm\"><use href=\"#i-close\"/></svg></button></span></div>`
    + `${hintHtml}${remHtml}${corps}</div>`;
}

/* Le remède CLIQUE CE QUI EXISTE. Chaque cas mène au geste déjà rendu sur la carte ou dans
   l'onglet Git : c'est ce qui garantit qu'il demandera la même confirmation et écrira la même
   chose que si on l'avait trouvé soi-même. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-remede]');
  if (!b) return;
  const id = Number(b.dataset.task);
  const t2 = allTasks.find((x) => x.id === id);
  const cible = t2 && (t2.targets || [])[0];
  if (b.dataset.remede === 'rattraper') {
    const bouton = $(`#taskList [data-tgrebase="${cible ? cible.id : ''}"]`);
    if (bouton) { bouton.click(); return; }
    toast(tr('err.fix.none'), true);
    return;
  }
  if (b.dataset.remede === 'merge') {
    // L'écran de merge de Git, pré-rempli sur la branche et sa base : la résolution vit là-bas.
    navTab('git'); showGitSub('merge');
    toast(tr('err.fix.conflict-go', { branch: (cible && cible.branch) || '' }));
    return;
  }
  if (b.dataset.remede === 'neuve') {
    // Repartir d'une session d'agent neuve : on vide le handle, le prochain run en créera une.
    if (!cible) return;
    try {
      await api(`/tasks/${id}/targets/${cible.id}/forget-session`, { method: 'POST' });
      toast(tr('err.fix.session-done')); loadTasks();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  if (b.dataset.remede === 'recloner') {
    if (!cible) return;
    if (!await confirmDialog({ text: tr('confirm.reclone'), confirmLabel: tr('settings.repo.reclone') })) return;
    try { await api(`/repos/${cible.repo_id}/reclone`, { method: 'POST' }); toast(tr('settings.repo.recloned')); }
    catch (err) { toast(explainError(err.message), true); }
  }
});

/* Rejouer le chargement de l'onglet courant — exactement ce que fait un clic sur son bouton
   de navigation, la seule voie qui remette AUSSI la vue dans son état de départ. */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('.errretry');
  if (!b) return;
  const actif = $('nav button[data-tab].active');
  if (actif) actif.click(); else window.location.reload();
});

// Délégation : bouton "copier" de n'importe quel errbox (liste, détail, discover).
document.addEventListener('click', (e) => {
  const b = e.target.closest('.errcopy');
  if (!b) return;
  const box = b.closest('.errbox');
  // Le texte COMPLET, pile comprise : c'est ce qu'on colle dans un ticket, replié ou non.
  const pre = box.querySelector('pre');
  copyText(box.dataset.full || pre.textContent, b);
});

// Délégation : bouton "✕" pour fermer un errbox (et effacer en base si MR).
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.errclear');
  if (!b) return;
  const box = b.closest('.errbox');
  const mrId = b.dataset.clearMr;
  const taskId = b.dataset.clearTask;
  const localId = b.dataset.clearLocal;
  const askId = b.dataset.clearAsk;
  const url = mrId ? `/mrs/${mrId}/clear-error`
    : (taskId ? `/tasks/${taskId}/clear-error`
      : (localId ? `/local-tasks/${localId}/clear-error`
        : (askId ? `/questions/${askId}/clear-error` : null)));
  if (url) { try { await api(url, { method: 'POST' }); } catch { /* on ferme quand même */ } }
  box.remove();
});

