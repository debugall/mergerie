'use strict';
/* LA CONFIGURATION D'AGENT DE L'AUTEUR D'UNE BRANCHE N'EST PAS LA NÔTRE.
 *
 * Converger ou coder sur une branche poussée par quelqu'un d'autre, c'est lancer l'agent dans SON
 * clone : son `CLAUDE.md` devient une consigne, son `.claude/settings.json` des permissions et des
 * hooks — des commandes qui s'exécutent —, son `.mcp.json` des serveurs lancés au démarrage. Une
 * MR qui ajoute ces fichiers réécrit donc les règles de l'agent qui va la corriger, avec le mode
 * d'écriture que la convergence exige.
 *
 * On ne l'interdit pas — une MR peut légitimement faire évoluer le CLAUDE.md du projet —, on le
 * fait VOIR : si la branche touche ces fichiers par rapport à sa cible, l'agent ne part pas tant
 * que l'utilisateur n'a pas dit « j'ai vu, vas-y » pour CE contenu-là. L'accord est gardé sur ce
 * poste (`local_state`), lié à une empreinte du diff de ces fichiers : un nouveau push qui les
 * change encore redemande.
 */
const crypto = require('node:crypto');
const git = require('./git');
const { etat } = require('./localstate');

const SENSIBLE = /(^|\/)(CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|\.mcp\.json)$|(^|\/)\.claude\/|^\.github\/(copilot-instructions\.md|instructions\/|agents\/|chatmodes\/)/;
const KIND = 'config-agent';

const estSensible = (chemin) => SENSIBLE.test(String(chemin || ''));

/**
 * Les fichiers de configuration d'agent que `head` change par rapport à `base`, et l'empreinte de
 * ce changement. `{ fichiers: [], empreinte: null }` quand il n'y en a pas, ou quand on ne peut
 * pas le dire (base introuvable) — ne pas savoir n'arrête pas un codage.
 */
async function examiner(cwd, base, head) {
  let noms = '';
  try {
    noms = (await git.run('git', ['diff', '--name-only', `${base}...${head}`], { cwd })).stdout;
  } catch { return { fichiers: [], empreinte: null }; }
  const fichiers = String(noms || '').split('\n').map((x) => x.trim()).filter(estSensible);
  if (!fichiers.length) return { fichiers: [], empreinte: null };
  let contenu = '';
  try { contenu = (await git.run('git', ['diff', `${base}...${head}`, '--', ...fichiers], { cwd })).stdout; } catch { contenu = fichiers.join('\n'); }
  const empreinte = crypto.createHash('sha256').update(String(contenu)).digest('hex').slice(0, 32);
  return { fichiers, empreinte };
}

const ref = (repo, branche) => `${repo.uid || repo.id}:${branche}`;
const accepte = (repo, branche, empreinte) => !!empreinte && etat.lire(KIND, ref(repo, branche), 'empreinte') === empreinte;
const accepter = (repo, branche, empreinte) => { if (empreinte) etat.ecrire(KIND, ref(repo, branche), 'empreinte', String(empreinte)); };

/** Une erreur qui porte de quoi reconnaître le cas et le résoudre à l'écran. */
function erreur(message, examen) {
  const e = new Error(message);
  e.code = 'CONFIG_AGENT';
  e.fichiers = examen.fichiers;
  e.empreinte = examen.empreinte;
  return e;
}

module.exports = { SENSIBLE, estSensible, examiner, accepte, accepter, erreur };
