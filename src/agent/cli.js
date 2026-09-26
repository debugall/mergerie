'use strict';
/* LE BINAIRE D'UN LANCEMENT — le défaut, ou le profil qu'une session a choisi.

   Tout ce qui lance l'agent lit le binaire, ses arguments, ses variables, son délai et son
   backend au moment de l'appel (`copilot.binActuel()`, `policy.envAgent()`, `backends.detecter()`),
   depuis `local_config`. Plutôt que de faire passer un profil de main en main à travers la
   review, la convergence, les cinq entrées du runner de session et leurs reprises, le profil
   choisi est POSÉ SUR LE CONTEXTE ASYNCHRONE du job (`AsyncLocalStorage`) : tout ce qui
   s'exécute dans ce job — spawn, promesses, callbacks — le voit, et rien d'autre. Deux jobs
   parallèles sur deux binaires ne se voient pas. `courant()` rend null hors de tout profil,
   et chaque lecteur retombe alors sur le défaut, exactement comme avant. */
const { AsyncLocalStorage } = require('node:async_hooks');
const { t } = require('../core/i18n');

const contexte = new AsyncLocalStorage();

/** Le profil du lancement en cours, ou null (le défaut de `local_config`). */
function courant() { return contexte.getStore() || null; }

/** Exécute `fn` avec ce profil pour binaire ; `null` = le défaut, sans rien poser. */
function avec(profil, fn) { return profil ? contexte.run(profil, fn) : fn(); }

/* Le profil d'une session (`task.cli_id`), et ce qu'on en dit au journal : le nom du binaire
   qui part, ou le repli sur le défaut quand le profil choisi n'existe plus sur ce poste — une
   session venue d'un collègue, ou un profil supprimé depuis. */
function deSession(session, onLog = () => {}) {
  if (!session || !session.cli_id) return null;
  const profil = require('../data/agentcli').parId(session.cli_id);
  if (!profil) { onLog(t('log.cli.missing', { name: session.cli_name || `#${session.cli_id}` })); return null; }
  onLog(t('log.cli.using', { name: profil.name, bin: profil.bin }));
  return profil;
}

/** `avec(deSession(session))`, en une ligne pour les exécutants de jobs. */
function avecSession(session, onLog, fn) { return avec(deSession(session, onLog), fn); }

module.exports = { courant, avec, deSession, avecSession };
