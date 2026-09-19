'use strict';
/* Commentaires de MR en mode démo.

   Les routes de commentaires tapaient directement la forge : sans jeton, la démo affichait
   « commentaires indisponibles » et la moitié de l'écran de review restait morte. On sert
   donc un fil fictif, en mémoire — il n'a pas à survivre au redémarrage, la démo se resème.

   Le jeu contient volontairement UN commentaire de moi et UN d'un collègue : c'est ce qui
   rend visible la règle « on ne modifie que les siens ». */

const ME = 'moi';

const iso = (h) => new Date(Date.now() - h * 3600000).toISOString();

// mrId -> discussions (forme normalisée GitLab, celle que le serveur simplifie ensuite)
const store = new Map();
let seq = 5000;

function note(author, body, position, hoursAgo) {
  seq += 1;
  return {
    id: seq,
    body,
    system: false,
    created_at: iso(hoursAgo),
    resolved: false,
    author: { name: author, username: author },
    position: position || null,
  };
}

function seed(mrId) {
  const discs = [
    { id: `d-${mrId}-1`, notes: [note('lina', 'Peux-tu extraire ce calcul dans une fonction ? Il sert aussi dans le rapport mensuel.', null, 30)] },
    { id: `d-${mrId}-2`, notes: [note(ME, 'Bien vu. Je le sors dans `src/pricing.js` et j’ajoute un test sur les arrondis.', null, 28)] },
    {
      id: `d-${mrId}-3`,
      notes: [note(ME, 'Attention : ici le total est recalculé à chaque rendu, alors qu’il ne dépend que du panier.',
        { new_path: 'src/checkout/cart.js', old_path: null, new_line: 44, old_line: null }, 26)],
    },
  ];
  store.set(mrId, discs);
  return discs;
}

const list = (mrId) => store.get(mrId) || seed(mrId);

function reply(mrId, discussionId, body) {
  const d = list(mrId).find((x) => String(x.id) === String(discussionId));
  if (!d) throw new Error('Discussion introuvable (démo).');
  const n = note(ME, body, d.notes[0] && d.notes[0].position, 0);
  d.notes.push(n);
  return n;
}

function post(mrId, body, position) {
  seq += 1;
  const d = { id: `d-${mrId}-${seq}`, notes: [note(ME, body, position, 0)] };
  list(mrId).push(d);
  return d;
}

/* Modifie une note. On refuse celles des autres au lieu de laisser passer : en vrai c'est
   la forge qui refuse, et une démo qui autorise ce que la réalité interdit ment. */
function update(mrId, noteId, body) {
  for (const d of list(mrId)) {
    const n = d.notes.find((x) => String(x.id) === String(noteId));
    if (!n) continue;
    if (n.author.username !== ME) throw new Error('On ne modifie que ses propres commentaires.');
    n.body = body;
    return n;
  }
  throw new Error('Commentaire introuvable (démo).');
}

module.exports = { ME, list, reply, post, update };
