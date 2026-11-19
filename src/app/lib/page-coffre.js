'use strict';
/* LA PAGE DE CONNEXION DU COFFRE : ce que `GET /` sert tant que les jetons sont verrouillés (Réglages →
   Sécurité). Une page autonome, sans script — la politique de contenu n'en admet pas en ligne, et deux
   formulaires suffisent : déverrouiller, ou repartir sans jetons. Les deux thèmes suivent le système :
   le choix de l'application vit dans le navigateur, qu'aucun script ne lit ici. `referrer: same-origin` :
   sous la politique `no-referrer` du serveur, un formulaire part avec `Origin: null`, que la garde
   d'origine refuse — la page rétablit l'origine pour ses propres envois, rien de plus. */
const { t, getLang } = require('../../core/i18n');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function pageCoffre({ totp = false, erreur = '', erreurReset = '' } = {}) {
  const k = (cle, p) => esc(t(`settings.security.login.${cle}`, p));
  return `<!doctype html><html lang="${esc(getLang())}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin"><title>Mergerie — ${k('title')}</title>
<style>
:root{--bg:#f4f6fa;--panel:#fff;--text:#1b2230;--muted:#5d6779;--line:#d9dee8;--accent:#2563eb;--red:#dc2626}
@media (prefers-color-scheme: dark){:root{--bg:#0f1420;--panel:#171e2d;--text:#e7eaf0;--muted:#9aa3b5;--line:#33405a;--accent:#3b82f6;--red:#f87171}}
body{font:15px system-ui,sans-serif;background:var(--bg);color:var(--text);display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
main{background:var(--panel);border:1px solid var(--line);padding:28px 32px;border-radius:12px;width:min(400px,100%);box-sizing:border-box}
h1{font-size:18px;margin:0 0 6px}p{color:var(--muted);margin:0 0 16px;line-height:1.5}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}
input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:inherit;font:inherit}
input:focus{outline:none;border-color:var(--accent)}
button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button.danger{background:transparent;color:var(--red);border:1px solid var(--red)}
.err{color:var(--red);margin:12px 0 0}
details{margin-top:22px;border-top:1px solid var(--line);padding-top:14px}summary{cursor:pointer;color:var(--muted);font-size:13px}
details p{margin:10px 0 0;font-size:13px}
</style></head><body><main>
<form method="post" action="/coffre/deverrouiller" id="coffreConnexion"><h1>${k('title')}</h1>
<p>${k(totp ? 'intro-totp' : 'intro')}</p>
<label for="coffreMdp">${k('password')}</label>
<input type="password" id="coffreMdp" name="mdp" autocomplete="current-password" autofocus required>
${totp ? `<label for="coffreCode">${k('code')}</label>
<input type="text" id="coffreCode" name="code" inputmode="numeric" pattern="[0-9 ]{6,7}" autocomplete="one-time-code" required>` : ''}
<button type="submit">${k('submit')}</button>${erreur ? `<p class="err" role="alert">${esc(erreur)}</p>` : ''}</form>
<details${erreurReset ? ' open' : ''}><summary>${k(totp ? 'forgot-totp' : 'forgot')}</summary>
<form method="post" action="/coffre/reinitialiser" id="coffreReset">
<p>${k('reset-text')}</p>
<label for="coffrePhrase">${k('reset-label', { phrase: t('settings.security.reset-phrase') })}</label>
<input type="text" id="coffrePhrase" name="phrase" autocomplete="off" required>
<button type="submit" class="danger">${k('reset-btn')}</button>${erreurReset ? `<p class="err" role="alert">${esc(erreurReset)}</p>` : ''}</form></details>
</main></body></html>`;
}

module.exports = { pageCoffre };
