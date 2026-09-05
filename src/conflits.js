'use strict';
/* LES MARQUEURS DE CONFLIT, et rien d'autre.
 *
 * Module VOLONTAIREMENT PUR : il ne require ni la base, ni le disque, ni la configuration. Un
 * test peut donc l'importer en tête de fichier sans rien démarrer — ce qui n'est pas un détail
 * de confort : `src/db` OUVRE la base au chargement, et un `require` posé avant que le harnais
 * n'ait défini `MERGERIE_DATA_DIR` ouvre la base RÉELLE de l'utilisateur. C'est arrivé, et un
 * test a écrit dedans. La règle qui l'empêche est ici : ce qui est pur reste pur.
 */

/* DÉCOUPER UN FICHIER EN CONFLIT. Fonction PURE : c'est elle que l'écran utilise pour proposer
 * « garder celle-ci / celle-là / les deux », et c'est elle qu'on teste.
 *
 * Deux styles existent. Le style par défaut donne trois marqueurs ; `diff3` en ajoute un
 * quatrième (`|||||||`) avec la version d'origine. On lit les deux, et on RETIENT la base
 * quand elle est là : savoir d'où l'on part est souvent ce qui permet de trancher.
 *
 * Ce qui n'est pas un conflit ressort tel quel, dans l'ordre : recoller les morceaux doit
 * redonner exactement le fichier.
 */
function decouper(texte) {
  const lignes = String(texte).split('\n');
  const out = [];
  let stable = [];
  let i = 0;
  const poser = () => { if (stable.length) { out.push({ type: 'stable', lignes: stable }); stable = []; } };
  while (i < lignes.length) {
    if (/^<{7}( |$)/.test(lignes[i])) {
      const debut = i;
      const ours = []; const base = []; const theirs = [];
      let ou = 'ours';
      i += 1;
      while (i < lignes.length && !/^>{7}( |$)/.test(lignes[i])) {
        if (/^\|{7}( |$)/.test(lignes[i])) { ou = 'base'; i += 1; continue; }
        if (/^={7}$/.test(lignes[i])) { ou = 'theirs'; i += 1; continue; }
        (ou === 'ours' ? ours : ou === 'base' ? base : theirs).push(lignes[i]);
        i += 1;
      }
      if (i >= lignes.length) {
        /* Marqueur ouvert jamais refermé : le fichier n'est pas un conflit valide. On rend le
           texte tel quel plutôt que d'en perdre la fin — l'écran basculera en édition libre. */
        stable = stable.concat(lignes.slice(debut));
        break;
      }
      poser();
      out.push({ type: 'conflit', ours, base, theirs });
      i += 1;                                        // la ligne `>>>>>>>`
    } else {
      stable.push(lignes[i]);
      i += 1;
    }
  }
  poser();
  return out;
}

/** Recolle les morceaux : `choix[n]` vaut 'ours' | 'theirs' | 'deux' pour le nième conflit. */
function recoller(morceaux, choix = []) {
  const lignes = [];
  let n = 0;
  for (const m of morceaux) {
    if (m.type === 'stable') { lignes.push(...m.lignes); continue; }
    const c = choix[n] || 'ours';
    n += 1;
    if (c === 'theirs') lignes.push(...m.theirs);
    else if (c === 'deux') lignes.push(...m.ours, ...m.theirs);
    else lignes.push(...m.ours);
  }
  return lignes.join('\n');
}

module.exports = { decouper, recoller };
