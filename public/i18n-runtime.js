/* Moteur de traduction — le MÊME code tourne dans le navigateur et dans Node.
   Côté navigateur il lit le dictionnaire global `I18N` ; côté serveur, un require().

   La langue courante est un état de module : l'outil est mono-utilisateur, il n'y a
   donc jamais deux langues actives en même temps. Le navigateur la pose depuis
   localStorage, le serveur depuis `config.language`. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./i18n.js'));
  else root.I18Nrt = factory(root.I18N);
}(typeof self !== 'undefined' ? self : this, function (I18N) {
  const FALLBACK = 'fr';
  let lang = FALLBACK;

  function setLang(l) { lang = I18N[l] ? l : FALLBACK; return lang; }
  function getLang() { return lang; }
  function langs() { return Object.keys(I18N); }

  // Pour toLocaleDateString / toLocaleString : remplace les 'fr-FR' en dur.
  function currentLocale() { return lang === 'en' ? 'en-US' : 'fr-FR'; }

  /* Traduit une clé.
     - clé absente → on renvoie la CLÉ elle-même, jamais une chaîne vide : un trou
       de traduction doit se voir à l'écran, pas se traduire par un libellé disparu.
     - pluriel : la clé vaut { one, other }, choisi sur params.n.
     ⚠ Le résultat n'est PAS échappé : dans un contexte innerHTML, c'est aux
     PARAMÈTRES d'être passés à esc(), pas au retour de t() (cf. i18n.md §4.2). */
  function t(key, params) {
    const dict = I18N[lang] || I18N[FALLBACK];
    let s = dict[key];
    if (s == null) {
      s = (I18N[FALLBACK] || {})[key];                 // repli sur le français
      if (s == null) {
        if (typeof console !== 'undefined') console.warn('[i18n] clé manquante :', key);
        return key;
      }
    }
    if (typeof s === 'object') s = (params && Number(params.n) === 1) ? s.one : s.other;
    return String(s).replace(/\{(\w+)\}/g, (m, k) => (params && params[k] != null ? params[k] : m));
  }

  /* Applique les traductions au HTML statique.
     ⚠ On ne touche JAMAIS au textContent d'un bouton porteur d'une icône SVG :
     cela effacerait l'icône. Les libellés concernés sont dans un <span data-i18n>. */
  function applyStaticI18n(rootEl) {
    const scope = rootEl || (typeof document !== 'undefined' ? document : null);
    if (!scope) return;
    scope.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    // data-i18n-html : réservé aux quelques libellés contenant du balisage (<code>, <strong>).
    // La source est le dictionnaire, écrit en dur dans i18n.js — jamais une donnée
    // utilisateur ni une réponse serveur. Pas de surface XSS ici, et la CSP stricte
    // interdirait de toute façon l'exécution d'un script injecté.
    scope.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    // Les info-bulles maison portent le texte deux fois : visible et accessible.
    scope.querySelectorAll('[data-i18n-tip]').forEach((el) => {
      const s = t(el.dataset.i18nTip);
      el.dataset.tip = s;
      el.setAttribute('aria-label', s);
    });
    scope.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  }

  return { t, setLang, getLang, langs, currentLocale, applyStaticI18n, dict: I18N };
}));
