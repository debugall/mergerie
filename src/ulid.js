'use strict';
/* UN ULID — l'identité d'une ligne qui doit survivre au partage.
 *
 * Les entiers auto-incrémentés sont LOCAUX par nature : deux postes créent chacun le dépôt
 * n° 12, deux reviews de la même merge request reçoivent chacune la version 2. Dès que le
 * travail accumulé part dans un dépôt git d'équipe, ces numéros se télescopent. Il faut donc
 * une identité qu'on peut produire sans se concerter, et qui reste la même partout.
 *
 * Un ULID répond exactement à ça, et rend en prime un service que l'UUID ne rend pas : ses
 * 26 caractères se TRIENT DANS L'ORDRE DE CRÉATION, parce que les dix premiers encodent
 * l'horodatage à la milliseconde. C'est ce qui permet de numéroter les versions d'une review
 * et les passes d'une session en relisant les fichiers, sans compteur partagé : deux postes
 * qui reviewent la même MR en même temps produisent v2 et v3, jamais deux v2, et dans le même
 * ordre chez tout le monde.
 *
 *   01JCXZ8F7K  9M2N4PQRSTVWXY
 *   └ 48 bits d'horodatage     └ 80 bits d'aléa
 *
 * Écrit ici plutôt qu'installé : le projet tient à trois dépendances, et celle-ci fait vingt
 * lignes. L'alphabet est le Crockford base32 de la spécification ULID — ni I, ni L, ni O, ni U,
 * pour qu'un identifiant lu à voix haute ou recopié à la main ne soit pas ambigu.
 */
const crypto = require('node:crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford base32 : ni I, L, O, ni U

/** Encode `valeur` sur `longueur` caractères de base32, poids fort en tête. */
function encoder(valeur, longueur) {
  let out = '';
  for (let i = longueur - 1; i >= 0; i--) {
    out = ALPHABET[Number(valeur % 32n)] + out;
    valeur /= 32n;
  }
  return out;
}

/* MONOTONE DANS LA MILLISECONDE — et ce n'est pas un détail de confort.
 *
 * Tout l'édifice repose sur « trier les uid = retrouver l'ordre de création » : c'est ainsi que
 * les versions d'une review et les passes d'une session se renumérotent sans compteur partagé.
 * Or on insère volontiers vingt-cinq lignes dans la même milliseconde : leurs horodatages sont
 * alors égaux, et l'ordre retomberait sur la partie ALÉATOIRE, c'est-à-dire sur rien.
 *
 * On garde donc le dernier tirage : dans la même milliseconde, le suivant vaut le précédent
 * plus un. Le résultat reste un ULID valide (c'est la variante « monotonic » de la
 * spécification), et l'ordre local est exact. Deux processus qui tirent en même temps ne se
 * suivent pas, mais ils ne se rencontrent pas non plus — 80 bits d'aléa les séparent —, et
 * c'est tout ce qu'on demande à deux postes distincts.
 *
 * Débordement : à 2^80 - 1, on ne peut plus incrémenter. On retire alors, et l'ordre de CES
 * deux lignes-là est perdu — après un millier de milliards de milliards d'insertions dans la
 * même milliseconde. Le cas est écrit pour ne pas boucler, pas parce qu'il arrivera. */
const MAX_ALEA = (1n << 80n) - 1n;
let dernierMs = -1;
let dernierAlea = 0n;

/**
 * Un identifiant de 26 caractères, triable par date de création.
 * @param {number} [ms] l'horodatage à encoder — le présent par défaut (les tests le figent).
 */
function ulid(ms = Date.now()) {
  const t = Math.max(0, Math.floor(ms));
  /* 16 caractères de base32 = 80 bits. On tire 10 octets et on les lit comme un grand entier :
     passer par `randomBytes` plutôt que par `Math.random` n'est pas du zèle — deux postes qui
     démarrent en même temps partageraient sinon la même graine, et c'est précisément la
     collision que cette identité existe pour éviter. */
  const tirer = () => BigInt(`0x${crypto.randomBytes(10).toString('hex')}`);
  if (t === dernierMs && dernierAlea < MAX_ALEA) dernierAlea += 1n;
  else { dernierMs = t; dernierAlea = tirer(); }
  return encoder(BigInt(t), 10) + encoder(dernierAlea, 16);
}

/** Vrai si la chaîne a la forme d'un ULID. Sert aux contrôles, jamais à deviner. */
const estUlid = (s) => typeof s === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);

/** L'instant encodé en tête d'un ULID, en millisecondes — `null` si ce n'en est pas un. */
function instantDe(s) {
  if (!estUlid(s)) return null;
  let v = 0n;
  for (const c of s.slice(0, 10)) v = v * 32n + BigInt(ALPHABET.indexOf(c));
  return Number(v);
}

/* UN SLUG : le nom de fichier d'un objet qu'on nomme en toutes lettres (un agent, une page de
   notes). Il est FIGÉ À LA CRÉATION — renommer l'agent ne déplace pas son dossier, sans quoi
   chaque renommage produirait chez les collègues une suppression et un ajout au lieu d'un
   changement de titre, et l'historique du fichier serait perdu. */
function slugifier(nom) {
  const base = String(nom || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // « Déploiement » → « Deploiement »
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  // Un nom entièrement fait de ponctuation ou d'idéogrammes ne donne rien : on ne rend jamais
  // une chaîne vide, qui produirait le fichier « .json » et ferait se marcher dessus deux objets.
  return base || 'sans-nom';
}

/**
 * Le premier slug libre pour `nom`, suffixé `-2`, `-3`… si besoin.
 * @param {string} nom
 * @param {(slug: string) => boolean} pris rend vrai si le slug est déjà utilisé
 */
function slugLibre(nom, pris) {
  const base = slugifier(nom);
  if (!pris(base)) return base;
  for (let n = 2; n < 10000; n++) {
    const essai = `${base}-${n}`;
    if (!pris(essai)) return essai;
  }
  // Inatteignable en pratique ; on rend quelque chose d'unique plutôt que de boucler.
  return `${base}-${ulid().toLowerCase()}`;
}

module.exports = { ulid, estUlid, instantDe, slugifier, slugLibre, ALPHABET };
