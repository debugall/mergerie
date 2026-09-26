'use strict';
/* Blocs de protocole d'un run d'agent (spec agents §9.5).
 *
 * Trois blocs, un par besoin, sur le modèle éprouvé de `<<<FINDINGS>>>` (`resolution.js`) et
 * de `<<<QUESTIONS>>>` (`questions.js`) : l'agent rend du Markdown pour l'humain ET quelques
 * lignes délimitées pour la machine.
 *
 *   <<<REPO>>>   l'enquêteur nomme le dépôt trouvé → bouton « Corriger sur <dépôt> »
 *   <<<AGENT>>>  le cartographe décrit l'agent à créer → une ligne `agent` + son périmètre
 *   <<<STALE>>>  un agent de domaine signale ce qu'il a vu de faux dans sa connaissance
 *   <<<PAGE>>>   un agent à sortie « page de notes » découpe sa doc en sous-pages (répétable)
 *
 * RÈGLE : un bloc mal formé n'est JAMAIS une erreur de run. L'agent a travaillé, son rapport
 * est lisible ; c'est le protocole qui a raté, et le run vaut mieux que son protocole. On
 * l'ignore et on le journalise.
 */
const protocolesecret = require('../core/protocolesecret');

/* LE NONCE DE CES BLOCS (plan_secure.md, lot D, point 1) — une donnée (description de MR,
   ticket, fichier lu par l'agent) ne le connaît pas, donc ne peut pas fabriquer un `<<<AGENT>>>`
   que `extraire`/`extraireTous` liraient comme la sortie de CE run. La consigne (`composer()`,
   profile/prompt.js) est écrite UNE FOIS, à la création de la tâche — avant que `task.id`
   n'existe — et persistée dans `task.prompt` ; le nonce doit donc rester calculable plus tard
   à partir de ce qu'on a encore sous la main (`task.agent_id`), pas d'un tirage aléatoire perdu
   entre-temps. Dérivé de l'id de l'agent PAR HMAC (`core/protocolesecret.js`) : un simple hachage
   de l'id, sans secret, se précalcule pour tous les ids plausibles — un fichier lu par l'agent
   pourrait alors porter un `<<<AGENT …>>>` tout formé. L'HMAC le ferme : sans le secret du
   poste, fermé à l'agent (`agentpolicy.interditsDonnees`/`sandboxDenyRead`), deviner le nonce
   d'un id ne dit rien du nonce d'un autre. */
const nonceAgentRun = (agentId) => protocolesecret.hmac(`agent-${agentId}`, 12);

// Un seul bloc par balise est pris : le premier. Un agent qui en émet deux a hésité, et
// deviner lequel compte reviendrait à choisir à sa place.
function bornes(text, nom, nonce) {
  if (!nonce) return null;
  const start = `<<<${nom} ${nonce}`;
  const end = `${nom} ${nonce}>>>`;
  const s = String(text || '');
  const i = s.indexOf(start);
  if (i === -1) return null;
  const j = s.indexOf(end, i + start.length);
  if (j === -1) return null;    // balise ouverte jamais refermée : bloc inexploitable
  return { i, j, fin: j + end.length, contenu: s.slice(i + start.length, j) };
}

/* Extrait le bloc AU NONCE DU RUN et rend le RESTE — c'est ce reste qui s'affiche. Le bloc ne
   doit jamais apparaître à l'écran : c'est un canal de service, pas du contenu. */
function extraire(text, nom, nonce) {
  const s = String(text || '');
  const b = bornes(s, nom, nonce);
  if (!b) return { block: null, rest: s.trim() };
  return { block: b.contenu.trim(), rest: (s.slice(0, b.i) + s.slice(b.fin)).trim() };
}

/* TOUS les blocs d'une même balise AU NONCE DU RUN, et le reste. `extraire` n'en prend qu'un, à
   dessein : un agent qui émet deux `<<<AGENT>>>` a hésité. Mais une documentation a SIX
   sous-pages ou n'en a aucune, et la répétition y est la forme normale — pas une hésitation. */
function extraireTous(text, nom, nonce) {
  const blocks = [];
  let s = String(text || '');
  if (!nonce) return { blocks, rest: s.trim() };
  // Borné : un bloc jamais refermé rend `bornes` nul et arrête la boucle de lui-même.
  for (;;) {
    const b = bornes(s, nom, nonce);
    if (!b) break;
    blocks.push(b.contenu.trim());
    s = s.slice(0, b.i) + s.slice(b.fin);
  }
  return { blocks, rest: s.trim() };
}

/* Retire TOUS les blocs connus d'un coup, QUEL QUE SOIT LEUR NONCE : ce que l'API rend et ce que
   l'écran affiche. Volontairement plus large qu'`extraireTous` — ce n'est pas ici qu'on décide
   si un bloc fait foi (nonce du run), seulement qu'un canal de service ne s'affiche jamais et ne
   se réinjecte jamais tel quel dans un prompt (le résultat part de toute façon sous `nonFiable`,
   quand il est réutilisé : `taskrunner.redigerTranscription`, `partage.js`). */
const NOMS = ['REPO', 'AGENT', 'STALE', 'PAGE'];
function nettoyer(text) {
  let s = String(text || '');
  for (const n of NOMS) {
    const bloc = new RegExp(`<<<${n}(?: [^\\n]*)?[\\s\\S]*?${n}(?: [^\\n]*)?>>>`, 'g');
    s = s.replace(bloc, '').trim();
  }
  return s;
}

/* Les lignes utiles d'un bloc : champs séparés par ` | `, trimés, lignes vides écartées.
   Une ligne de séparation Markdown (`---|---`) est écartée aussi : un agent qui a compris
   « tableau » plutôt que « bloc » en produit une, et elle n'est jamais une donnée. */
function lignes(block) {
  const out = [];
  for (const brut of String(block || '').split('\n')) {
    const l = brut.trim();
    if (!l) continue;
    const champs = l.split('|').map((x) => x.trim());
    if (champs.every((x) => !x || /^-+$/.test(x))) continue;
    out.push(champs);
  }
  return out;
}

module.exports = { extraire, extraireTous, lignes, nettoyer, NOMS, nonceAgentRun };
