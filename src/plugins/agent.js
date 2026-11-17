'use strict';
/* L'AGENT IA, VU D'UN PLUGIN (`ctx.agent`, permission `agent`) : une question, une réponse, rien d'autre.
 *
 * Saveur `ask` — lecture seule, comme « Résume-moi la période » —, dans un dossier VIDE créé pour l'appel et effacé
 * après : l'agent n'a aucun dépôt, aucun fichier à lire ni à écrire. Ce que le plugin cite d'ailleurs (`data` : des
 * logs collés, un texte saisi) est balisé ici comme donnée non fiable, avec un nonce que le plugin ne connaît pas.
 * L'appel compte dans le budget du jour et la télémétrie, imputé au plugin (`owner: { kind: 'plugin' }`). */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const copilot = require('../agent/copilot');
const { nonFiable } = require('../core/nonfiable');
const { TASKS_DIR, ensureDir } = require('../core/paths');

const available = () => !copilot.isDryRun();

async function ask({ plugin, prompt, data = [] }) {
  const corps = [prompt, ...data.map((d) => nonFiable(d.label, d.text)).filter(Boolean)].join('\n\n');
  const cwd = ensureDir(path.join(TASKS_DIR, 'plugin-ask', String(plugin), crypto.randomBytes(6).toString('hex')));
  const simulated = copilot.isDryRun();
  try {
    const text = await copilot.runPrompt(corps, cwd, { kind: 'ask', owner: { kind: 'plugin', id: String(plugin) } });
    return { text: String(text == null ? '' : text), simulated };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

module.exports = { ask, available };
