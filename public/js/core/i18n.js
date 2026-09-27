'use strict';
/* Traduction : `tr`, la langue lue avant tout (LANG_KEY, readLang), et son changement à l'écran. */
/* Traduction. Nommée `tr` et non `t` comme le proposait i18n.md : `t` est déjà
   pris comme variable locale à onze endroits de ce fichier (const t = d.task,
   const t = s.tasks…). Ces locales masqueraient la fonction globale dans les
   fonctions de rendu — exactement celles qu’il faut traduire. */
const tr = (key, params) => I18Nrt.t(key, params);

/* La langue est posée ICI, tout en haut, et pas dans le bloc « Langue » plus bas :
   plusieurs tables de libellés sont construites à l'évaluation du module. Les
   initialiser avant setLang() les figerait en français quel que soit le réglage. */
const LANG_KEY = 'aidevtools_lang';
const readLang = () => { try { return localStorage.getItem(LANG_KEY) || 'fr'; } catch { return 'fr'; } };
I18Nrt.setLang(readLang());
/* ---------- Langue (i18n) ----------
   La préférence vit à DEUX endroits, volontairement :
   - localStorage : pour appliquer la langue avant le premier rendu (comme le thème) ;
   - config.language en base : parce que le SERVEUR en a besoin — ses messages
     d’erreur sont affichés tels quels à l’utilisateur (i18n.md §2.1).
   Au changement, on recharge la page. C’est délibéré : re-traduire à chaud
   supposerait de re-rendre chaque vue dynamique déjà affichée ; un rechargement
   couvre tout, et l’onglet courant est de toute façon mémorisé. */

(function language() {
  document.documentElement.lang = I18Nrt.getLang();
  I18Nrt.applyStaticI18n();
  const sel = $("#langSelect");
  if (!sel) return;
  sel.value = I18Nrt.getLang();
  sel.addEventListener("change", async () => {
    const lang = sel.value;
    try { localStorage.setItem(LANG_KEY, lang); } catch { /* stockage indisponible */ }
    // On persiste AVANT de recharger, sinon le serveur resterait dans l’ancienne langue.
    try { await api("/config", { method: "PUT", body: { language: lang } }); }
    catch (e) { toast(explainError(e.message), true); return; }
    location.reload();
  });
})();


