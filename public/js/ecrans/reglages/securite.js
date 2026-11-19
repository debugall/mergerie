'use strict';
/* RÉGLAGES → SÉCURITÉ : le coffre des jetons (mot de passe maître) et la 2FA (src/data/coffre.js).
   Chaque action ouvre son petit formulaire ; un seul à la fois. Activer, désactiver, changer le mot de
   passe et la 2FA rendent l'état, que l'on redessine. Verrouiller recharge la page : le serveur sert
   alors la page de connexion. */
const SECU = { etat: null };
const SECU_FORMS = ['#secuFormActiver', '#secuFormDesactiver', '#secuFormMdp', '#secuFormTotp', '#secuFormTotpOff'];

function secuOuvrir(sel) {
  for (const f of SECU_FORMS) { const el = $(f); el.hidden = f !== sel; if (f !== sel) el.reset(); }
  const el = sel && $(sel);
  if (el) { const champ = el.querySelector('input'); if (champ) champ.focus(); }
}
function secuRendre(e) {
  SECU.etat = e;
  const actif = !!e.actif;
  $('#secuEtat').textContent = tr(actif ? (e.totp ? 'settings.security.state.on-totp' : 'settings.security.state.on') : 'settings.security.state.off');
  $('#secuEtat').classList.toggle('on', actif);
  $('#secuActiver').hidden = actif;
  for (const id of ['#secuDesactiver', '#secuChanger', '#secuVerrouiller']) $(id).hidden = !actif;
  $('#secuTotp').checked = !!e.totp;
  $('#secuTotp').disabled = !actif;
  secuOuvrir(null);
}
async function loadSecurite() {
  try { secuRendre(await api('/coffre')); } catch (e) { $('#secuEtat').textContent = explainError(e.message); }
}
/* Envoie un formulaire du panneau : ses champs nommés, tels quels. */
async function secuEnvoyer(form, chemin, succes) {
  const corps = Object.fromEntries(new FormData(form).entries());
  const bouton = form.querySelector('button[type="submit"]');
  bouton.disabled = true;
  try {
    const e = await api(chemin, { method: 'POST', body: corps });
    secuRendre(e);
    if (succes) toast(tr(succes));
  } catch (err) { toast(explainError(err.message), true); } finally { bouton.disabled = false; }
}

onEl($('#secuActiver'), 'click', () => secuOuvrir('#secuFormActiver'));
onEl($('#secuDesactiver'), 'click', () => secuOuvrir('#secuFormDesactiver'));
onEl($('#secuChanger'), 'click', () => secuOuvrir('#secuFormMdp'));
onEl($('#secuVerrouiller'), 'click', async () => {
  try { await api('/coffre/verrouiller', { method: 'POST' }); location.reload(); } catch (e) { toast(explainError(e.message), true); }
});
onEl($('#sub-security'), 'click', (e) => { if (e.target.closest('[data-secu-annuler]')) { secuOuvrir(null); if (SECU.etat) $('#secuTotp').checked = !!SECU.etat.totp; } });
onEl($('#secuFormActiver'), 'submit', (e) => { e.preventDefault(); secuEnvoyer(e.target, '/coffre/activer', 'settings.security.toast.enabled'); });
onEl($('#secuFormDesactiver'), 'submit', (e) => { e.preventDefault(); secuEnvoyer(e.target, '/coffre/desactiver', 'settings.security.toast.disabled'); });
onEl($('#secuFormMdp'), 'submit', (e) => { e.preventDefault(); secuEnvoyer(e.target, '/coffre/mot-de-passe', 'settings.security.toast.password'); });
onEl($('#secuFormTotp'), 'submit', (e) => { e.preventDefault(); secuEnvoyer(e.target, '/coffre/totp/activer', 'settings.security.toast.totp-on'); });
onEl($('#secuFormTotpOff'), 'submit', (e) => { e.preventDefault(); secuEnvoyer(e.target, '/coffre/totp/desactiver', 'settings.security.toast.totp-off'); });
/* La case de la 2FA n'agit pas d'elle-même : cochée, elle montre le QR code à valider ; décochée, elle
   demande le mot de passe. Elle ne change d'état qu'une fois le serveur d'accord. */
onEl($('#secuTotp'), 'change', async (e) => {
  const voulu = e.target.checked;
  e.target.checked = !!(SECU.etat && SECU.etat.totp);
  if (!voulu) { secuOuvrir('#secuFormTotpOff'); return; }
  try {
    const p = await api('/coffre/totp/preparer', { method: 'POST' });
    $('#secuQr').innerHTML = p.svg;   // SVG fabriqué par le serveur à partir de l'adresse otpauth://
    $('#secuSecret').textContent = p.secret.replace(/(.{4})/g, '$1 ').trim();
    secuOuvrir('#secuFormTotp');
  } catch (err) { toast(explainError(err.message), true); }
});

/* APRÈS UNE RÉINITIALISATION depuis la page de connexion, l'écran s'ouvre sur Réglages → Git : les jetons
   sont à ressaisir, et c'est là qu'est le premier. Lu une fois, la page chargée — après le démarrage, qui
   rouvre le dernier onglet. */
window.addEventListener('load', async () => {
  try {
    const e = await api('/coffre');
    if (!e.ressaisir) return;
    await api('/coffre/ressaisir-vu', { method: 'POST' });
    navTab('admin'); showAdminSub('gitcfg'); toast(tr('settings.security.toast.reset'), true);
  } catch { /* best-effort */ }
});
