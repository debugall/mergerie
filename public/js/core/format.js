'use strict';
/* Le nom d'une branche se copie, le titre d'une MR, la note, dates et durées (`depuis`, `fmtDate`, `fmtHour`). */
/* ---------- Le nom d'une branche se copie ----------
   On sélectionnait `feat/PROJ-1408-paiement-3x` à la souris, en ratant le premier caractère une
   fois sur deux, pour le coller dans un terminal. Le chip devient donc copiable au clic, partout
   où il apparaît — carte de merge request, ligne de projet d'une session, explorateur de
   branches, en-tête de rapport. ⇧-clic copie la commande de récupération complète : c'est
   toujours la même, et la retaper est le geste qui suit le copier neuf fois sur dix. */
/* LE TITRE D'UNE MERGE REQUEST, ET CE QU'ON MONTRE QUAND ON NE L'A PAS.
   Une MR arrivée par le dépôt de données avant d'avoir été découverte chez la forge n'a pas
   encore de titre sur ce poste : « !42 — » laissait un tiret cadratin pendu dans le vide, qui
   se lit comme un titre vide plutôt que comme un titre pas encore connu. Sans titre, le numéro
   suffit, et l'infobulle dit pourquoi il est seul. */
function titreMr(m) {
  const t2 = String((m && m.title) || '').trim();
  if (t2) return `!${m.iid} — ${esc(t2)}`;
  return `!${m.iid} <span class="muted" title="${esc(tr('mr.title.inconnu'))}">${esc(tr('mr.title.a-decouvrir'))}</span>`;
}

const CMD_CHECKOUT = (b) => `git fetch origin && git checkout ${b}`;
function chipBranche(nom, { cible = false } = {}) {
  if (!nom) return '';
  return `<code class="branch-chip${cible ? ' branch-chip-cible' : ''}" data-copy-branch="${esc(nom)}" role="button" tabindex="0" title="${esc(tr('branch.copy.title'))}">${esc(nom)}</code>`;
}
document.addEventListener('click', (e) => {
  const c = e.target.closest && e.target.closest('[data-copy-branch]');
  if (!c) return;
  /* Le chip vit dans des cartes cliquables : sans ça, copier ouvrirait aussi le rapport. */
  e.preventDefault(); e.stopPropagation();
  const nom = c.dataset.copyBranch;
  const cmd = e.shiftKey;
  copyText(cmd ? CMD_CHECKOUT(nom) : nom, null);
  toast(tr(cmd ? 'branch.copy.cmd-done' : 'branch.copy.done', { branch: nom }));
});
/* Au clavier : Entrée copie le nom, ⇧+Entrée la commande — mêmes deux gestes que la souris. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const c = e.target.closest && e.target.closest('[data-copy-branch]');
  if (!c) return;
  e.preventDefault(); e.stopPropagation();
  const nom = c.dataset.copyBranch;
  copyText(e.shiftKey ? CMD_CHECKOUT(nom) : nom, null);
  toast(tr(e.shiftKey ? 'branch.copy.cmd-done' : 'branch.copy.done', { branch: nom }));
});

// Bouton « copier la commande de reprise » (session de codage/review/hors-dépôt). Le clic est
// géré par délégation ci-dessous : il copie la commande `cd … && claude/copilot …` du terminal.
function resumeCmdBtn(cmd) {
  if (!cmd) return '';
  return `<button class="btn btn-sm btn-ghost resume-cmd-btn" data-resume-cmd="${esc(cmd)}" title="${esc(tr('resume.cmd.title'))}"><svg class="ico ico-sm"><use href="#i-copy"/></svg><span>${esc(tr('resume.cmd.btn'))}</span></button>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-resume-cmd]');
  if (b) { e.preventDefault(); copyText(b.dataset.resumeCmd, null); toast(tr('resume.cmd.copied')); }
});

/* UNE SEULE ÉCRITURE POUR UNE NOTE. `note.raw` est le texte que l'IA a écrit : selon la passe,
   « 7,4/10 » ou « 8.4/10 ». Les afficher tels quels mettait les deux formats dans la même liste,
   à six lignes d'écart, plus un troisième dans les filtres. On rend donc TOUJOURS la valeur
   numérique, écrite dans la langue de l'interface. */
function fmtNote10(x) {
  if (x == null || !Number.isFinite(Number(x))) return '—';
  const n = Number(x);
  return `${n.toLocaleString(I18Nrt.currentLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}/10`;
}
// `note` = { raw, value } rendu par l'API, `value` dans [0,1].
const fmtNote = (note) => (note && note.value != null ? fmtNote10(note.value * 10) : '—');

/* « il y a 3 h » plutôt qu'une date : ce qu'on lit sur une liste triée par date, c'est la
   FRAÎCHEUR, pas le jour exact. `Intl` s'en charge dans la langue courante — une table de
   traductions maison pour « minute / heure / jour » n'aurait rien apporté. */
function depuis(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const paliers = [['second', 60], ['minute', 60], ['hour', 24], ['day', 7], ['week', 4.35], ['month', 12], ['year', Infinity]];
  let v = Math.round((t - Date.now()) / 1000);
  for (const [unite, taille] of paliers) {
    if (Math.abs(v) < taille) return new Intl.RelativeTimeFormat(I18Nrt.currentLocale(), { numeric: 'auto' }).format(Math.round(v), unite);
    v /= taille;
  }
  return '';
}

/* UNE DATE ABSOLUE DIT QUAND, PAS DEPUIS COMBIEN DE TEMPS. « 06/09/26 05:35 » demande un calcul
   mental ; « il y a 3 h » est la réponse qu'on cherchait. On garde l'absolu à l'écran — il est
   exact, il se compare, il se copie — et le relatif arrive au survol. Il est calculé AU SURVOL
   et non au rendu : une carte qui vit une heure mentirait sinon. */
function dateHtml(iso, texte) {
  if (!iso) return esc(texte || '');
  return `<span class="date-abs" data-when="${esc(iso)}">${esc(texte)}</span>`;
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString(I18Nrt.currentLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return ''; }
}

/* L'heure seule, à composer avec `fmtDate`. Utile là où l'ORDRE est le sujet : dans un
   classement par fraîcheur, plusieurs dépôts partagent la même journée et le rang paraît
   alors arbitraire — « pourquoi celui-ci est-il devant ? ».
   Distinct de `fmtDateTime`, qui abrège l'année sur deux chiffres : à côté d'une colonne
   qui l'écrit en entier, deux formats de date dans le même écran se remarquent. */
function fmtHour(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString(I18Nrt.currentLocale(), { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

