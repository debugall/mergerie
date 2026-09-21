'use strict';
/* « TESTER LE SANDBOX » (plan_secure.md, lot A) — Réglages → Session IA.
 *
 * Le sandbox du CLI (`--settings`) dépend du système d'exploitation et du binaire installé :
 * Seatbelt sur macOS, bubblewrap sur Linux/WSL2, rien sur Windows natif. Aucun réglage ne doit
 * prétendre qu'il protège tant qu'il n'a pas été VU en train de le faire, sur CETTE machine —
 * `policy.js` ne bascule en mode `sandbox` que si `agent_sandbox_verified` a été posé par CE
 * banc d'essai, jamais par un simple `PUT /api/config`.
 *
 * Un run réel, payant, déclenché SEULEMENT par le bouton (jamais au démarrage, jamais planifié) :
 * deux sondes Bash sous `--settings` sandboxé — une qui doit RÉUSSIR (écrire dans le dossier de
 * travail) et une qui doit ÉCHOUER (joindre le réseau, hors domaines autorisés). Le sandbox n'est
 * marqué vérifié que si les DEUX sondes se comportent comme attendu — c'est le CODE DE SORTIE de
 * chaque commande, lu dans la sortie du CLI, qui tranche, jamais le texte libre de l'agent.
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const proc = require('../core/proc');
const copilot = require('./copilot');
const agentpolicy = require('./policy');
const { DATA_DIR, ensureDir } = require('../core/paths');
const { t } = require('../core/i18n');

const TIMEOUT_MS = 120000;
let running = false;

const MARQUEUR_ECRITURE = () => `sonde-${crypto.randomBytes(3).toString('hex')}`;

function prompt(marqueur) {
  return [
    "Test technique, non interactif : exécute EXACTEMENT ces deux commandes avec l'outil Bash,",
    "l'une après l'autre, chacune une seule fois, et ne fais rien d'autre.",
    '',
    `1) echo ${marqueur} > sonde.txt && cat sonde.txt ; echo "ECRITURE_EXIT:$?"`,
    '2) curl -s -o /dev/null -w "%{http_code}" --max-time 4 https://example.com/ ; echo "RESEAU_EXIT:$?"',
    '',
    'Réponds uniquement avec la sortie brute des deux commandes, rien d\'autre.',
  ].join('\n');
}

function appeler(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const bin = copilot.COPILOT_BIN;
    const child = spawn(bin, args, proc.options({ cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }));
    proc.setActive(child);
    let out = ''; let err = '';
    const timer = setTimeout(() => { proc.tuerGroupe(child, 'SIGKILL'); reject(new Error(t('err.cmd.timeout', { cmd: bin, ms: TIMEOUT_MS }))); }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); proc.clearActive(child); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      proc.clearActive(child);
      if (code === 0) resolve(out);
      else reject(new Error(t('err.cmd.failed', { cmd: bin, code, sortie: (err || out).slice(0, 500) })));
    });
  });
}

/** Lance le banc d'essai réel. Rend `{ ok, detail, texte }` — `ok` décide `agent_sandbox_verified`
 *  côté appelant (la route), jamais ici : ce module ne touche pas la base. */
async function testerSandbox(onLog = () => {}) {
  if (running) throw new Error(t('err.sandboxtest.running'));
  running = true;
  try {
    const backend = agentpolicy.backendDe(copilot.COPILOT_BIN);
    if (backend !== 'claude') {
      return { ok: false, detail: t('agents.sandboxtest.non-claude', { backend }) };
    }
    if (copilot.isDryRun()) {
      return { ok: false, detail: t('agents.sandboxtest.dry-run') };
    }
    const cap = agentpolicy.capacites(copilot.COPILOT_BIN);
    if (!cap.settings) {
      return { ok: false, detail: t('agents.sandboxtest.no-settings') };
    }
    const cwd = ensureDir(path.join(DATA_DIR, 'tmp', `sandbox-test-${Date.now()}`));
    const marqueur = MARQUEUR_ECRITURE();
    const settings = agentpolicy.sandboxSettings(cwd);
    const args = [
      '--permission-mode', 'acceptEdits',
      ...(cap.permissionPrompts ? ['--permission-prompts', 'none'] : []),
      '--allowedTools', 'Bash',
      '--settings', JSON.stringify(settings),
      '-p', prompt(marqueur),
    ];
    onLog(t('agents.sandboxtest.log.running'));
    const texte = await appeler(args, cwd, agentpolicy.envAgent('claude'));

    const ecriture = /ECRITURE_EXIT:(-?\d+)/.exec(texte);
    const reseau = /RESEAU_EXIT:(-?\d+)/.exec(texte);
    const ecritureOk = !!ecriture && ecriture[1] === '0' && texte.includes(marqueur);
    const reseauBloque = !!reseau && reseau[1] !== '0';

    const ok = ecritureOk && reseauBloque;
    const detail = t(ok ? 'agents.sandboxtest.ok' : 'agents.sandboxtest.ko', {
      ecriture: t(ecritureOk ? 'agents.sandboxtest.pass' : 'agents.sandboxtest.fail'),
      reseau: t(reseauBloque ? 'agents.sandboxtest.blocked' : 'agents.sandboxtest.leaked'),
    });
    onLog(detail);
    return { ok, detail, texte, ecritureOk, reseauBloque };
  } finally {
    running = false;
  }
}

module.exports = { testerSandbox };
