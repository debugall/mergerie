'use strict';
/* Moteur de dictée SIMULÉ, sur le modèle de demo-verify.js et demo-docker.js.
 *
 * Actif en mode démo (MERGERIE_DEMO=1) et en dry-run (DICTATION_DRY_RUN=1, ce que pose le
 * harnais de tests). Il ne fabrique pas du texte au hasard : il VALIDE l'en-tête WAV reçu et
 * mesure la DURÉE RÉELLE de l'audio, si bien qu'un test peut prouver que la chaîne complète
 * a été traversée — permission, capture, WAV 16 kHz, route, insertion — sans modèle ni micro.
 *
 * Les phrases rendues sont choisies pour MONTRER ce que le vocabulaire apporte : `/health`,
 * `!216`, `PROJ-1408` s'écrivent comme on les écrit, pas comme on les entend.
 *
 * Hors démo, SANS moteur, on ne rend rien : un faux texte en mode réel serait un mensonge,
 * comme un faux verdict de vérification. */

const actif = () => process.env.MERGERIE_DEMO === '1' || process.env.DICTATION_DRY_RUN === '1';

const PHRASES = {
  fr: [
    'Ajouter un endpoint /health qui renvoie le statut de la base, puis lancer npm test avant de pousser.',
    'Corriger le délai d’attente sur !216 dans webapp-front et ajouter un test pour PROJ-1408.',
    'Relire la merge request !214 : la migration doit passer sur une base neuve.',
  ],
  en: [
    'Add a /health endpoint that returns the database status, then run npm test before pushing.',
    'Fix the timeout on !216 in webapp-front and add a test for PROJ-1408.',
    'Review merge request !214: the migration must run on a brand-new database.',
  ],
};

// Une phrase après l'autre, par langue : deux dictées de suite ne rendent pas la même chose,
// et le tour de rôle se lit sans état caché à maintenir.
const rang = { fr: 0, en: 0 };

/* La seconde passe (l'audio complet, à l'arrêt) rend la MÊME phrase que le dernier segment :
   c'est ce qu'un utilisateur verrait — un texte qui se corrige sans changer de sens. */
function transcrire({ duration_ms: duree, language, final } = {}) {
  const lang = language === 'en' ? 'en' : 'fr';
  const liste = PHRASES[lang];
  const i = final ? (rang[lang] + liste.length - 1) % liste.length : rang[lang];
  if (!final) rang[lang] = (rang[lang] + 1) % liste.length;
  // Un segment trop court est du bruit : le vrai moteur ne rendrait rien non plus.
  if (Number(duree) > 0 && Number(duree) < 300) return Promise.resolve('');
  return new Promise((r) => { setTimeout(() => r(liste[i]), 300); });
}

function reset() { rang.fr = 0; rang.en = 0; }

module.exports = { actif, transcrire, reset, PHRASES };
