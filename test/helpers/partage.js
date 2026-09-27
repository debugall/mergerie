'use strict';
/* OUTILS DES SUITES « PARTAGE » — un dépôt de données nu, et un collègue qui y écrit.
 *
 * Le partage se juge dans le DÉPÔT NU, jamais sur un libellé : c'est la seule preuve que quelque
 * chose est parti chez les autres. Et le travail d'un collègue arrive exactement comme la synchro
 * le fait arriver : un clone, un fichier écrit, un commit SIGNÉ DE SON NOM, un push — puis un
 * tour de synchro de ce poste. L'auteur affiché (« par Claire ») est celui que git connaît.
 *
 * Ce fichier ne charge rien de `src/` : il peut être requis en tête d'un fichier de test. */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/* Un dépôt nu sur `main`, prêt à être rattaché. */
function creerDepotNu(racine, nom = 'donnees.git') {
  const nu = path.join(racine, nom);
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', nu], { stdio: 'ignore' });
  return nu;
}

/* Les fichiers de `main` dans le dépôt nu (liste vide tant que rien n'est parti). */
function fichiersDuDepot(nu) {
  try {
    return execFileSync('git', ['-C', nu, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter((f) => f.trim());
  } catch { return []; }
}

function contenuDuDepot(nu, fichier) {
  return execFileSync('git', ['-C', nu, 'show', `main:${fichier}`], { encoding: 'utf8' });
}

/* Tout le texte du dépôt, fichiers et contenus : pour prouver qu'une chose N'Y EST PAS, où
   qu'elle ait pu être rangée. */
function toutLeDepot(nu) {
  return fichiersDuDepot(nu).map((f) => `${f}\n${contenuDuDepot(nu, f)}`).join('\n');
}

/* LE COLLÈGUE. Son identité passe par l'ENVIRONNEMENT, pas par `-c user.name` : `startApp()`
   pose `GIT_AUTHOR_NAME=Test` pour tout le processus, et l'environnement l'emporte sur la
   configuration — un commit « de Claire » serait sinon signé « Test ». Son clone est gardé d'un
   geste à l'autre et remis à jour avant chaque écriture. */
function collegue(racine, nu, nom, email = `${nom.toLowerCase()}@exemple.test`) {
  const dossier = path.join(racine, `chez-${nom.toLowerCase()}`);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: nom, GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: nom, GIT_COMMITTER_EMAIL: email,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const git = (...args) => execFileSync('git', ['-C', dossier, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    nom,
    dossier,
    /* `fn(ecrire, lire, supprimer)` modifie le clone ; on commite et on pousse. */
    publier(message, fn) {
      if (!fs.existsSync(dossier)) execFileSync('git', ['clone', '-q', nu, dossier], { env, stdio: 'ignore' });
      else git('pull', '-q', '--rebase', 'origin', 'main');
      const ecrire = (rel, contenu) => {
        const p = path.join(dossier, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, typeof contenu === 'string' ? contenu : `${JSON.stringify(contenu, null, 2)}\n`);
      };
      const lire = (rel) => fs.readFileSync(path.join(dossier, rel), 'utf8');
      const lireJson = (rel) => JSON.parse(lire(rel));
      fn({ ecrire, lire, lireJson });
      git('add', '-A');
      git('commit', '-q', '-m', message);
      git('push', '-q', 'origin', 'HEAD:main');
    },
  };
}

/* UN TOUR DE SYNCHRO JUSQU'À L'EFFET. `POST /api/data-sync/now` commite, tire et pousse ; mais
   un tour déjà en cours (celui du rattachement, sur une machine lente) peut rendre la main sans
   avoir vu la dernière écriture. On relance donc jusqu'à ce que la condition — lue dans le dépôt
   nu ou par l'API — soit vraie. */
async function synchroniserJusqua(app, cond, quoi, ms = 30000) {
  const fin = Date.now() + ms;
  for (;;) {
    await app.api('POST', '/api/data-sync/now');
    if (await cond()) return;
    if (Date.now() > fin) throw new Error(`délai dépassé : ${quoi}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/* Un identifiant de ligne au format du dépôt (ULID, 26 caractères Crockford). Seul le suffixe
   change : ce qui compte est qu'il soit unique et valide. */
function uidDe(suffixe) {
  const s = String(suffixe).toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, '0');
  return `01M2W3G1TTH4D0M8EQ${s.padStart(8, '0').slice(-8)}`;
}

module.exports = {
  creerDepotNu, fichiersDuDepot, contenuDuDepot, toutLeDepot, collegue, synchroniserJusqua, uidDe,
};
