'use strict';
/* Les tests de connexion aux services : le souvenir du dernier résultat, et le jeton qui ne part pas vers une autre adresse.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const db = require('../../db');
const garde = require('../../core/garde');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;

/* ---------- Jenkins : voir et lancer des jobs -------------------------------
   Aucune requête n'est émise sans un geste : pas de sondage, pas de rafraîchissement de
   fond. L'écran demande, on demande à Jenkins. `configured: false` plutôt qu'une erreur —
   un onglet non configuré doit expliquer comment le configurer, pas afficher un échec. */
const jenkinsCfg = () => getConfig();
// Test de connexion — même contrat que « Tester Jira » : le masque signifie « garde le jeton ».
/* A38 — LE SOUVENIR D'UN TEST DE CONNEXION. Le bouton répondait à l'écran et n'en gardait
   rien : au retour dans les réglages, les quatre connexions étaient muettes, et « est-ce que
   GitLab marche encore ? » se rejouait à chaque fois. On note donc le RÉSULTAT et sa date —
   un souvenir de geste, jamais une surveillance : rien n'est sondé en fond. Un échec est noté
   comme un succès, c'est même le plus utile des deux. */
function noterTest(service, ok, detail) {
  try {
    db.prepare(`INSERT INTO conn_test (service, ok, detail, tested_at) VALUES (?,?,?,?)
      ON CONFLICT(service) DO UPDATE SET ok = excluded.ok, detail = excluded.detail, tested_at = excluded.tested_at`)
      .run(service, ok ? 1 : 0, String(detail || '').slice(0, 200), new Date().toISOString());
  } catch { /* trace best-effort : un test réussi ne doit pas échouer sur son journal */ }
}
/* LE JETON ENREGISTRÉ NE PART PAS VERS UNE AUTRE ADRESSE. « Tester » accepte l'URL du
   formulaire et le masque `***` (« jeton non modifié ») : une requête qui changeait l'URL en
   gardant le masque faisait envoyer le jeton en base à l'hôte de son choix. Adresse changée
   (autre origine) ⇒ le jeton doit être retapé dans la même requête. */
function exigerJetonFrais(urlCorps, urlBase, jetonCorps, jetonBase, defaut = '') {
  if (!garde.jetonFraisRequis(urlCorps, urlBase, jetonCorps, jetonBase, defaut)) return;
  const e = new Error(t('err.test.fresh-token'));
  e.status = 400;
  throw e;
}

module.exports = {
  jenkinsCfg, noterTest, exigerJetonFrais,
};
