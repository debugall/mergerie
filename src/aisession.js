'use strict';
/* Banc d'essai « reprise de session IA » (Réglages → AI sessions).
 *
 * VALIDE, avant/pendant l'usage de la fonctionnalité « l'agent pose une question », qu'on
 * sait vraiment reprendre une session d'agent CLI. Deux passes dans la MÊME session : la 1re
 * fait mémoriser un marqueur secret, la 2e — en reprise — le redemande. S'il est restitué,
 * la reprise conserve le contexte. Utilise EXACTEMENT le runner de production (agentsession)
 * pour tester le vrai chemin.
 */

const crypto = require('crypto');
const path = require('path');
const copilot = require('./copilot');
const agentsession = require('./agentsession');
const { DATA_DIR, ensureDir } = require('./paths');
const { t } = require('../public/i18n-runtime.js');

let running = false; // une exécution du banc d'essai à la fois

// Résultat simulé en dry-run (démo / agent indisponible) : la sous-page reste consultable.
function dryRunResult(backend) {
  const marker = 'MARQUEUR-DEMO01';
  return {
    dryRun: true, backend: backend === 'unknown' ? '(dry-run)' : backend, handle: '(simulation)', marker,
    prompt1: `Mémorise ce marqueur secret : ${marker}. Réponds uniquement par « ok ».`,
    output1: 'ok',
    prompt2: 'Rappelle-moi le marqueur secret que je t’ai demandé de mémoriser juste avant.',
    output2: marker,
    sessionId1: 'sess-demo', sessionId2: 'sess-demo', recalled: true, sameSession: true,
  };
}

async function runSessionTest(onLog = () => {}) {
  if (running) throw new Error(t('err.aisession.running'));
  running = true;
  try {
    const backend = agentsession.backendName();
    if (copilot.isDryRun()) { onLog(t('log.aisession.dry-run')); return dryRunResult(backend); }

    const marker = `MARQUEUR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    // Le cwd fait partie de l'identité de session : le MÊME pour les deux passes.
    const cwd = ensureDir(path.join(DATA_DIR, 'ai-session-test'));
    const key = `session-test-${crypto.randomBytes(4).toString('hex')}`;
    const P1 = `Ceci est un test technique de reprise de session. Mémorise ce marqueur secret : ${marker}. Ne fais rien d'autre et réponds uniquement par « ok ».`;
    const P2 = 'Rappelle-moi le marqueur secret que je t’ai demandé de mémoriser dans le message précédent. Réponds UNIQUEMENT avec le marqueur, sans aucun autre texte.';

    onLog(t('log.aisession.backend', { backend, key }));
    onLog(t('log.aisession.pass1'));
    const r1 = await agentsession.runInSession({ key, prompt: P1, cwd, resume: false, onLog });

    onLog(t('log.aisession.pass2'));
    const r2 = await agentsession.runInSession({ key, handle: r1.handle, prompt: P2, cwd, resume: true, onLog });

    const recalled = String(r2.text || '').toUpperCase().includes(marker);
    const sameSession = (r1.sessionId && r2.sessionId) ? (r1.sessionId === r2.sessionId) : null;
    onLog(t(recalled ? 'log.aisession.ok' : 'log.aisession.ko'));

    return {
      dryRun: false, backend, handle: r1.handle, cwd, marker,
      prompt1: P1, output1: r1.text, sessionId1: r1.sessionId,
      prompt2: P2, output2: r2.text, sessionId2: r2.sessionId,
      recalled, sameSession,
    };
  } finally {
    running = false;
  }
}

module.exports = { runSessionTest, backendName: agentsession.backendName };
