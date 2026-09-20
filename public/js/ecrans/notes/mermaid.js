'use strict';
/* Les diagrammes Mermaid des notes, le thème des diagrammes, un autolien dit ce qu'il désigne. */
/* ---------- Les diagrammes Mermaid des notes ----------
   Un bloc ```mermaid devient un SVG. La bibliothèque fait 5,4 Mo : elle n'est PAS chargée avec
   l'application, mais au premier diagramme rencontré, une seule fois pour la session (la
   promesse est mémorisée, y compris pendant le chargement — sans quoi trois diagrammes dans une
   page déclencheraient trois téléchargements concurrents). Une note sans diagramme ne paie rien.

   Elle n'est pas non plus une dépendance npm : le fichier est posé dans `public/vendor/`, voir
   son README. Rien ne sort de la machine, ici comme ailleurs. */
let mermaidPret = null;
function chargerMermaid() {
  if (mermaidPret) return mermaidPret;
  mermaidPret = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/mermaid.min.js';
    s.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('mermaid')));
    /* L'échec est DÉFINITIF pour la session : on remet la promesse à zéro pour qu'un prochain
       rendu retente, plutôt que de garder une promesse rejetée qui rejetterait pour toujours. */
    s.onerror = () => { mermaidPret = null; reject(new Error('mermaid')); };
    document.head.appendChild(s);
  });
  return mermaidPret;
}

const themeMermaid = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'default' : 'dark');

/* Une passe DIFFÉRÉE et groupée. L'aperçu d'une page se réécrit à chaque frappe : rendre les
   diagrammes à chaque touche rendrait la saisie collante, puisque le innerHTML les détruit et
   qu'il faut tout refaire. On attend donc une pause. */
let mermaidTimer = null;
function planifierMermaid(delai = 250) {
  if (mermaidTimer) clearTimeout(mermaidTimer);
  mermaidTimer = setTimeout(() => { mermaidTimer = null; rendreMermaid(); }, delai);
}

let mermaidSeq = 0;
async function rendreMermaid() {
  const blocs = [...document.querySelectorAll('[data-mermaid]:not([data-mermaid-done])')];
  if (!blocs.length) return;
  let mermaid;
  try { mermaid = await chargerMermaid(); } catch {
    for (const b of blocs) marquerMermaidKo(b, tr('notes.mermaid.unavailable'));
    return;
  }
  mermaid.initialize({
    startOnLoad: false,
    theme: themeMermaid(),
    /* `strict` : le contenu d'une note est écrit à la main ou par un agent. Les libellés sont
       nettoyés, aucun HTML ne s'y exécute, aucun gestionnaire de clic n'est posé. */
    securityLevel: 'strict',
    /* Sans ça, un diagramme fautif laisse SA PROPRE bannière d'erreur greffée dans la page,
       hors de notre bloc, et on ne peut plus l'enlever. On préfère montrer la source. */
    suppressErrorRendering: true,
  });
  for (const bloc of blocs) {
    const pre = bloc.querySelector('pre');
    const source = pre ? pre.textContent : '';
    bloc.setAttribute('data-mermaid-done', '');
    if (!source.trim()) continue;
    try {
      mermaidSeq += 1;
      const { svg } = await mermaid.render(`mmd-${mermaidSeq}`, source);
      /* La source reste dans le DOM, cachée : c'est elle qu'on relit quand le diagramme est
         faux, et c'est elle que le prochain rendu (changement de thème) réutilisera. */
      pre.hidden = true;
      const vue = document.createElement('div');
      vue.className = 'mermaid-svg';
      vue.innerHTML = svg;
      bloc.appendChild(vue);
      bloc.classList.remove('mermaid-ko');
    } catch (e) {
      marquerMermaidKo(bloc, String((e && e.message) || e).split('\n')[0]);
    }
  }
}

/* Un diagramme qui ne compile pas ne doit RIEN casser : la source reste lisible, l'erreur est
   dite au-dessus. Une page de notes contenant une faute de frappe reste une page de notes. */
function marquerMermaidKo(bloc, message) {
  bloc.classList.add('mermaid-ko');
  const pre = bloc.querySelector('pre');
  if (pre) pre.hidden = false;
  let err = bloc.querySelector('.mermaid-err');
  if (!err) {
    err = document.createElement('p');
    err.className = 'mermaid-err';
    bloc.prepend(err);
  }
  err.textContent = `${tr('notes.mermaid.failed')} ${message}`.trim();
}

/* LE THÈME CHANGE, LES DIAGRAMMES AUSSI. Les couleurs sont cuites dans le SVG au rendu : un
   diagramme sombre laissé sur un fond clair devient illisible. On observe l'attribut plutôt que
   de se brancher sur la bascule — l'ordre de définition des blocs de ce fichier n'a alors
   aucune importance, et le mode « auto » qui suit le système passe par le même chemin. */
if (typeof MutationObserver === 'function') {
  new MutationObserver(() => {
    const faits = document.querySelectorAll('[data-mermaid][data-mermaid-done]');
    if (!faits.length) return;
    for (const b of faits) {
      b.removeAttribute('data-mermaid-done');
      const vue = b.querySelector('.mermaid-svg');
      if (vue) vue.remove();
    }
    planifierMermaid(0);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/* ---------- Un autolien dit ce qu'il désigne, au survol ----------
   `!214` dans une note du daily ne portait que son numéro : on cliquait, on changeait d'écran,
   on lisait, on revenait. Titre, note, verdict, état — quatre faits, une bulle, et la note se
   relit sans la quitter. Le résumé est demandé UNE fois par objet et gardé pour la page. */
const cacheResume = new Map();
async function resumeAutolien(el) {
  const cle = el.dataset.noteMr ? `mr:${el.dataset.noteMr}` : `ticket:${el.dataset.noteTicket}`;
  if (cacheResume.has(cle)) return cacheResume.get(cle);
  let texte = '';
  try {
    if (el.dataset.noteMr) {
      const d = await api(`/mrs/${el.dataset.noteMr}/resume`);
      const bouts = [`!${d.iid} — ${d.title || ''}`, d.project];
      if (d.note != null) bouts.push(fmtNote10(d.note * 10));
      if (d.verdict) bouts.push(tr(`mr.ref.verdict.${d.verdict}`));
      bouts.push(tr(d.closed ? 'notes.todo.mr.closed' : 'notes.todo.mr.open-since', { when: depuis(d.created_at) }));
      texte = bouts.filter(Boolean).join('\n');
    } else if (el.dataset.noteTicket) {
      /* Les tickets SURVEILLÉS sont la seule liste que le serveur connaisse hors ligne : on y
         cherche la clé. Un ticket non surveillé n'a pas de bulle — mieux que d'aller interroger
         Jira au survol, ce qui ferait un appel réseau par passage de souris. */
      const cle = el.dataset.noteTicket.toUpperCase();
      const d = await api('/jira/watch');
      const w = (d.watched || d.rows || []).find((x) => String(x.key).toUpperCase() === cle);
      texte = w ? [`${w.key} — ${w.summary || ''}`, w.status || ''].filter(Boolean).join('\n') : '';
    }
  } catch { texte = ''; }         // objet inconnu ou hors ligne : pas de bulle, pas d'erreur
  cacheResume.set(cle, texte);
  return texte;
}
document.addEventListener('mouseover', async (e) => {
  const a = e.target.closest && e.target.closest('.note-link[data-note-mr], .note-link[data-note-ticket]');
  if (!a || a.dataset.resumeFait === '1') return;
  a.dataset.resumeFait = '1';
  const texte = await resumeAutolien(a);
  if (!texte) return;
  a.dataset.tip = texte;
  showTip(a);              // on survole déjà : la bulle doit s'ouvrir maintenant
});

/* Clic sur un lien d'autolink : la navigation vit ici, pas dans le module de rendu, qui ne
   sait pas où sont les onglets. Délégation, comme partout ailleurs. */
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('.note-link');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.noteMr) { navMrReport(Number(a.dataset.noteMr)); return; }
  if (a.dataset.noteMrSearch) {
    navReviews('reviewed');
    const s = $('#searchReview');
    if (s) { s.value = a.dataset.noteMrSearch; s.dispatchEvent(new Event('input')); }
    return;
  }
  if (a.dataset.noteTicket) {
    ouvrirTicketJira(a.dataset.noteTicket);
  }
});

