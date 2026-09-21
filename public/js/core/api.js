'use strict';
/* `api` : la langue voyage avec la requête, le code du refus quand le serveur en donne un. */
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    cache: 'no-store', // jamais de cache : on veut toujours le contenu à jour
    /* LA LANGUE VOYAGE AVEC LA REQUÊTE. Elle vit dans le navigateur (localStorage), le serveur
       la lisait en base : changer de langue à l'écran laissait les messages du serveur — et les
       libellés qu'il fabrique, comme ceux du mode démo — dans l'ancienne. */
    headers: { 'Content-Type': 'application/json', 'X-Mergerie-Lang': readLang(), ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    /* LE JETON LOCAL EST RÉGÉNÉRÉ À CHAQUE DÉMARRAGE DU SERVEUR (revue de add-secure-layer-2) :
       un onglet resté ouvert depuis avant un redémarrage porte l'ANCIEN cookie, et resterait
       bloqué en 401 sur chaque appel jusqu'à ce qu'on recharge la page à la main. On le fait à
       sa place — recharger repose un cookie frais (`GET /` le fait), et c'est la seule sortie :
       aucun jeton présenté par l'utilisateur ne peut réparer celui-ci. */
    if (data.code === 'JETON_LOCAL') { location.reload(); }
    const e = new Error(data.error || res.statusText);
    /* Le CODE du refus, quand le serveur en donne un. Reconnaître un cas particulier au mot
       près dans le message ne marcherait pas : il est traduit. */
    if (data.code) e.code = data.code;
    e.data = data;
    throw e;
  }
  return data;
}

