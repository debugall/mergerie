'use strict';
/* LE DÉPÔT DE DONNÉES DU MODE DÉMO — pour que « partagé » se VOIE.
 *
 * Sans lui, la section « Données partagées » des réglages affiche « mode mono-poste », le pied
 * de page se tait, et le bouton « Historique » d'une page de notes reste caché. On montrerait
 * donc une fonctionnalité en décrivant ce qu'elle ferait — exactement ce que la démo existe pour
 * éviter.
 *
 * On fabrique un vrai dépôt git LOCAL, sans distant : `data-demo/shared/`, avec des commits
 * signés de trois personnes fictives. Pas de distant, et c'est volontaire : la démo ne doit rien
 * pousser nulle part, et le pied de page doit pouvoir afficher un état honnête plutôt qu'une
 * erreur réseau.
 *
 * L'HISTORIQUE EST REJOUÉ, pas inventé : on exporte l'état réel de la base de démo, puis on
 * découpe l'export en trois commits datés et signés. « par Claire » sur une carte est donc le
 * VRAI auteur du VRAI commit du VRAI fichier — la même mécanique qu'en production, pas une
 * chaîne posée dans une colonne.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SHARED_DIR, DATA_DIR } = require('../paths');

/* LE FAUX DISTANT. Un dépôt NU à côté, qui tient le rôle de la forge. Sans lui, la démo
   montrerait un dépôt sans origine : le pied de page ne pourrait afficher ni « ↑ » ni « ↓ », et
   « Synchroniser maintenant » n'aurait rien à faire. Avec lui, tout le chemin est réellement
   parcouru — commit, push, compteurs — sans qu'une seule requête sorte de la machine. */
const ORIGINE = path.join(DATA_DIR, 'shared-origin.git');

/* Trois personnes, trois façons de contribuer : celle qui reviewe, celle qui écrit les notes et
   les règles, celle qui fait tourner les agents. Les prénoms sont neutres et transparents —
   personne ne doit croire reconnaître un collègue. */
const EQUIPE = [
  { name: 'Claire', email: 'claire@exemple.test', prend: (f) => f.startsWith('reviews/') || f.startsWith('mrs/') },
  { name: 'Malik', email: 'malik@exemple.test', prend: (f) => f.startsWith('notes/') || f.startsWith('todos/') || f.startsWith('rules/') },
  { name: 'Inès', email: 'ines@exemple.test', prend: () => true },
];

const git = (args, cwd = SHARED_DIR, env = {}) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
});

const estDepot = () => fs.existsSync(path.join(SHARED_DIR, '.git'));

/**
 * Prépare le dépôt de démo. Rejouable : si le dépôt existe déjà, on ne refait rien — relancer la
 * démo ne doit pas empiler dix fois le même historique.
 * @param {(m: string) => void} onLog
 * @returns {string|null} l'URL du faux distant si quelque chose a été créé, `null` sinon
 */
function preparer(onLog = () => {}) {
  if (estDepot()) return null;
  // eslint-disable-next-line global-require
  const store = require('../store');
  store.exporterTout();

  fs.mkdirSync(SHARED_DIR, { recursive: true });
  git(['init', '--initial-branch=main']);
  git(['config', 'user.name', EQUIPE[2].name]);
  git(['config', 'user.email', EQUIPE[2].email]);

  /* Un commit par personne, daté à reculons : trois jours, deux jours, ce matin. Les dates sont
     FIXES par rapport à maintenant, pas absolues — une démo enregistrée en janvier ne doit pas
     montrer un historique de l'an dernier. */
  const tous = store.listerFichiers();
  const restants = new Set(tous);
  let n = 0;
  EQUIPE.forEach((personne, i) => {
    const siens = [...restants].filter(personne.prend);
    if (!siens.length) return;
    for (const f of siens) restants.delete(f);
    git(['add', '--', ...siens]);
    const quand = new Date(Date.now() - (EQUIPE.length - i) * 86400000).toISOString();
    git(['commit', '-m', messagePour(personne, siens)], SHARED_DIR, {
      GIT_AUTHOR_NAME: personne.name,
      GIT_AUTHOR_EMAIL: personne.email,
      GIT_COMMITTER_NAME: personne.name,
      GIT_COMMITTER_EMAIL: personne.email,
      GIT_AUTHOR_DATE: quand,
      GIT_COMMITTER_DATE: quand,
    });
    n += 1;
    onLog(`[demo] dépôt de données : ${siens.length} fichier(s) au nom de ${personne.name}`);
  });
  if (!n) return null;

  execFileSync('git', ['init', '--bare', '--initial-branch=main', ORIGINE], { stdio: 'ignore' });
  git(['remote', 'add', 'origin', ORIGINE]);
  git(['push', '-u', 'origin', 'HEAD:main']);
  onLog('[demo] dépôt de données poussé vers son faux distant');
  return ORIGINE;
}

/* Un message qui dit le GESTE, comme ceux que l'application génère — « update 42 files » ne se
   relit pas, et la démo doit montrer un historique qu'on a envie d'ouvrir. */
function messagePour(personne, fichiers) {
  const premier = fichiers.find((f) => f.startsWith('reviews/')) ? 'reviews'
    : (fichiers.find((f) => f.startsWith('notes/')) ? 'notes and todos' : 'agents and settings');
  return `${premier} from ${personne.name}`;
}

module.exports = { preparer, EQUIPE };
