'use strict';
/* Thème clair / sombre, densité. */
/* ---------- Thème clair / sombre ----------
   Préférence locale au navigateur : 'auto' (suit le système), 'dark' ou 'light'.
   Le thème résolu est posé sur <html data-theme>, le CSS fait le reste.
   (Une première application a déjà lieu dans <head> pour éviter le flash.) */
(function theme() {
  const KEY = 'aidevtools_theme';
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const read = () => { try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; } };
  const apply = (pref) => {
    const resolved = pref === 'auto' ? (mq.matches ? 'light' : 'dark') : pref;
    document.documentElement.setAttribute('data-theme', resolved);
  };
  const sel = $('#themeSelect');
  if (sel) {
    sel.value = read();
    sel.addEventListener('change', () => {
      const pref = sel.value;
      try { localStorage.setItem(KEY, pref); } catch { /* stockage indisponible */ }
      apply(pref);
    });
  }
  // en mode auto, on suit les changements de thème du système en direct
  const onSys = () => { if (read() === 'auto') apply('auto'); };
  if (mq.addEventListener) mq.addEventListener('change', onSys);
  else if (mq.addListener) mq.addListener(onSys); // navigateurs plus anciens
  apply(read());
})();

/* ---------- Densité (confortable / compact) ----------
   Préférence locale au navigateur ; posée sur <html data-density>, le CSS resserre les listes. */
(function density() {
  const KEY = 'mergerie_density';
  const read = () => { try { return localStorage.getItem(KEY) || 'cozy'; } catch { return 'cozy'; } };
  const apply = (v) => document.documentElement.setAttribute('data-density', v === 'compact' ? 'compact' : 'cozy');
  const sel = $('#densitySelect');
  if (sel) {
    sel.value = read();
    sel.addEventListener('change', () => {
      try { localStorage.setItem(KEY, sel.value); } catch { /* stockage indisponible */ }
      apply(sel.value);
    });
  }
  apply(read());
})();

/* Liste actuellement visible : celle dans laquelle `j`/`k` se déplacent. */
function listeCourante() {
  /* C12 — `j`/`k` ne connaissaient que quatre listes : Jira, Jenkins, les todos et les lots
     s'arpentaient à la souris, alors que ce sont exactement les écrans qu'on descend ligne à
     ligne. L'ordre compte : la PREMIÈRE liste visible et non vide gagne, donc une liste d'un
     autre onglet ne capte jamais les touches. */
  // `#askList` manquait : les questions libres étaient la seule saveur de Dev IA à la souris.
  for (const sel of ['#toReviewList', '#reportList', '#taskList', '#localList', '#askList',
    '#jiraList', '#jiraWatchList', '#jenkinsBox', '#todoList', '#lotList']) {
    const el = $(sel);
    if (el && !el.hidden && el.offsetParent !== null && el.querySelector('.card')) return el;
  }
  return null;
}
