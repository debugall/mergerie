'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const proc = require('../core/proc');
const db = require('../db');
const { t } = require('../core/i18n');

// Comptage de tokens : utilise `gpt-tokenizer` (pur JS, hors-ligne) s'il est installé,
// sinon repli sur l'estimation ≈ 4 caractères / token (approx usuelle GPT/Claude).
// Ainsi le compteur fonctionne même sans la lib (env corporate sans npm).
let _tokenizer = null; // null = pas encore tenté, false = indisponible
function loadTokenizer() {
  if (_tokenizer !== null) return _tokenizer;
  try {
    const gt = require('gpt-tokenizer');
    const enc = gt.encode || (gt.default && gt.default.encode);
    _tokenizer = typeof enc === 'function' ? (txt) => enc(txt).length : false;
  } catch { _tokenizer = false; }
  return _tokenizer;
}
function countTokens(text) {
  const s = String(text || '');
  const tk = loadTokenizer();
  if (tk) { try { return tk(s); } catch { /* repli */ } }
  return Math.ceil(s.length / 4);
}

// Persiste la consommation d'un appel IA pour le footer télémétrie.
// Best-effort : ne doit jamais faire échouer un appel IA.
// `extraInput` : contenu que l'agent lit lui-même mais qui ne transite pas par le
// prompt (typiquement le diff, dont on ne passe que le CHEMIN). Sans lui, on comptait
// quelques centaines de tokens là où l'agent en consomme des dizaines de milliers.
let lastUsageId = null;
/* `owner` : { kind, id } — à quel objet la dépense se rattache (une session de dev, une
   question libre, un codage hors dépôt). Facultatif : sans lui la ligne reste comptée dans sa
   famille, comme avant. C'est ce qui permet de dire QUELLES sessions coûtent, pas seulement
   combien coûtent les sessions. */
/* `costUsd` : le coût ANNONCÉ par le backend, quand il en annonce un (le flux `claude` le
   donne à la fin de chaque passe). L'estimation en tokens reste calculée dans tous les cas —
   elle est le seul chiffre disponible sur un backend muet, et les deux se lisent côte à côte. */
function recordUsage(kind, prompt, output, extraInput, owner, costUsd) {
  try {
    const inText = String(prompt || '') + (extraInput ? `\n${extraInput}` : '');
    const outText = String(output || '');
    const tokens = countTokens(inText) + countTokens(outText);
    const info = db.prepare(`INSERT INTO usage (kind, prompt_chars, output_chars, tokens_est, created_at, owner_kind, owner_id, cost_usd)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(kind || null, inText.length, outText.length, tokens, new Date().toISOString(),
        (owner && owner.kind) || null, (owner && owner.id) || null,
        typeof costUsd === 'number' ? costUsd : null);
    lastUsageId = info.lastInsertRowid;
  } catch { /* usage best-effort */ }
}

// L'agent écrit son rapport DANS UN FICHIER (on lui demande explicitement de ne pas
// le dupliquer sur stdout) : ce texte échappait donc au comptage. On complète la
// ligne du dernier appel une fois le fichier lu — pas de nouvelle ligne, pour ne pas
// gonfler le nombre d'appels.
function addOutputToLastUsage(text) {
  try {
    if (!lastUsageId || !text) return;
    const s = String(text);
    db.prepare('UPDATE usage SET output_chars = output_chars + ?, tokens_est = tokens_est + ? WHERE id = ?')
      .run(s.length, countTokens(s), lastUsageId);
  } catch { /* best-effort */ }
}

const COPILOT_BIN = process.env.COPILOT_BIN || 'copilot';
const TIMEOUT_MS = Number(process.env.COPILOT_TIMEOUT_MS || 900000);
// Args additionnels passés à copilot (ex: --allow-all-tools). Séparés par des espaces.
const EXTRA_ARGS = (process.env.COPILOT_ARGS || '').split(' ').filter(Boolean);

let _binAvailable = null;
function binaryAvailable() {
  if (_binAvailable !== null) return _binAvailable;
  try {
    const r = spawnSync(COPILOT_BIN, ['--version'], { timeout: 5000 });
    _binAvailable = !r.error;
  } catch {
    _binAvailable = false;
  }
  return _binAvailable;
}

function isDryRun() {
  return process.env.COPILOT_DRY_RUN === '1' || !binaryAvailable();
}

function emitLines(buf, onLog) {
  const parts = buf.replace(/\r/g, '\n').split('\n');
  const remainder = parts.pop();
  for (const p of parts) onLog(p);
  return remainder;
}

// Lance `copilot -p "<prompt>"` dans cwd, renvoie stdout (le rapport).
// onLog reçoit la commande puis la sortie en temps réel (ligne à ligne).
/* `meta.saveur` (ou `meta.kind`) choisit les permissions (`agentpolicy`) : une review n'emporte
   pas le `--dangerously-skip-permissions` de `COPILOT_ARGS`. Requis ici, pas en tête : agentpolicy
   ne dépend de rien, mais on garde ce module chargeable tel quel par les scripts. */
function runReal(prompt, cwd, onLog = () => {}, meta = {}) {
  const agentpolicy = require('./policy');
  const backend = agentpolicy.backendDe(COPILOT_BIN);
  const pol = agentpolicy.argvPermissions({
    backend, bin: COPILOT_BIN, extra: EXTRA_ARGS, kind: meta.saveur || meta.kind, addDirs: meta.addDirs,
  });
  if (pol.note) onLog(t('agents.log.copilot-not-restricted'));
  agentpolicy.exigerBudget();                // le plafond du jour, avant de dépenser
  const flags = [...pol.extra, ...pol.args];
  flags.push(...agentpolicy.argsMaxTurns(backend, flags));
  prompt = require('../core/nonfiable').avecPreambule(prompt);   // ce qui est balisé comme donnée est dit tel
  return new Promise((resolve, reject) => {
    // flags additionnels (ex: --yolo) placés AVANT -p
    const args = [...flags, '-p', prompt];
    // commande COMPLÈTE (non tronquée) : prompt encodé en une ligne lisible
    const parts = [COPILOT_BIN, ...flags, '-p', JSON.stringify(prompt)];
    if (proc.isCancelled()) return reject(new Error(t('err.job.stopped')));
    onLog(`$ ${parts.join(' ')}  (cwd=${cwd})`);
    /* stdin fermée : sinon le CLI attend des données sur un tube que personne n'alimente,
       avertit au bout de trois secondes et l'avertissement masque la vraie erreur. */
    const env = agentpolicy.envAgent(backend === 'unknown' ? null : backend);
    const child = spawn(COPILOT_BIN, args, proc.options({ cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }));
    proc.setActive(child);
    let stdout = '';
    let stderr = '';
    let obuf = '';
    let ebuf = '';
    const timer = setTimeout(() => {
      // Le GROUPE : l'agent a pu lancer un serveur ou des tests, qui lui survivraient (proc.js).
      proc.tuerGroupe(child, 'SIGKILL');
      reject(new Error(t('err.cmd.timeout', { cmd: 'copilot', ms: TIMEOUT_MS })));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; obuf = emitLines(obuf + d, onLog); });
    child.stderr.on('data', (d) => { stderr += d; ebuf = emitLines(ebuf + d, onLog); });
    child.on('error', (e) => { clearTimeout(timer); proc.clearActive(child); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      proc.clearActive(child);
      if (obuf) onLog(obuf);
      if (ebuf) onLog(ebuf);
      if (proc.isCancelled()) return reject(new Error(t('err.job.stopped')));
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(t('err.cmd.failed', { cmd: 'copilot', code, sortie: stderr || stdout })));
    });
  });
}

// Rapport mock déterministe à partir du diff, pour développer/tester sans copilot.
function mockReport(prompt, cwd, meta = {}) {
  let diffPath = meta.diff_file || meta.diffFile;
  // le diff_file est relatif au cwd (le clone) : on le résout pour le mock
  if (diffPath && !path.isAbsolute(diffPath) && cwd) diffPath = path.join(cwd, diffPath);
  const diff = diffPath && fs.existsSync(diffPath)
    ? fs.readFileSync(diffPath, 'utf8')
    : '';
  const files = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
  const added = (diff.match(/^\+(?!\+\+)/gm) || []).length;
  const removed = (diff.match(/^-(?!--)/gm) || []).length;
  const kind = meta.kind || 'review';
  /* LE MOCK JOUE L'AGENT BIEN LUNÉ (plan_secure.md, lot D, point 1) : il lit dans le PROMPT le
     nonce que `findingsInstruction` a demandé, et l'utilise dans son propre bloc — sans ça,
     `resolution.splitFindings` ne reconnaîtrait jamais un bloc à nonce fixe en dry-run. */
  const nonceFindings = (String(prompt || '').match(/<<<FINDINGS (\S+)/) || [])[1] || 'dry-run';

  /* PROPOSITION DE MERGE (dry-run) : un bloc `<<<FiHj … FiHj>>>` et son `<<<RiHj … RiHj>>>`
     par conflit RÉEL de chaque fichier de `meta.fichiers` (même protocole que
     `<<<QUESTIONS … QUESTIONS>>>` : pas de `>>>` sur la balise ouvrante), pour que la file
     complète (job → parsing → écran) s'exerce sans backend — le choix retenu (« garder la
     source ») est arbitraire, seul compte que le format soit celui attendu, sur PLUSIEURS
     fichiers à la fois comme le fait le vrai appel groupé. */
  if (kind === 'merge-ai') {
    const { decouper } = require('../git/conflits');
    return (meta.fichiers || []).map((f, i) => {
      const conflits = decouper(f.raw || '').filter((m) => m.type === 'conflit');
      return conflits.map((m, j) => {
        const texte = (m.theirs.length ? m.theirs : m.ours).join('\n');
        return `<<<F${i + 1}H${j + 1}\n${texte}\nF${i + 1}H${j + 1}>>>\n`
          + `<<<R${i + 1}H${j + 1}\nraison (dry-run) du conflit ${i + 1}.${j + 1}\nR${i + 1}H${j + 1}>>>`;
      }).join('\n');
    }).join('\n');
  }

  if (kind === 'explain') {
    return [
      `# Explication (mock)`,
      '',
      `> Généré en **dry-run** (copilot indisponible). Branche \`${meta.source || '?'}\` → \`${meta.target || '?'}\`.`,
      '',
      `## Ce que fait la MR`,
      `Cette MR modifie ${files.length} fichier(s) : ${added} ligne(s) ajoutée(s), ${removed} supprimée(s).`,
      '',
      `## Fichiers concernés`,
      ...(files.length ? files.map((f) => `- \`${f}\``) : ['- (aucun changement détecté)']),
      '',
      `## Pour progresser`,
      `Regarde comment les changements ci-dessus s'articulent ; en dry-run, l'analyse réelle sera produite par l'agent${meta.skill ? ` via le skill \`${meta.skill}\`` : ''}.`,
    ].join('\n');
  }

  return [
    `# Rapport de revue (mock)`,
    '',
    `> Généré en **dry-run** (copilot indisponible).${meta.skill ? ` Skill visé : \`${meta.skill}\`.` : ''}`,
    `> Branche \`${meta.source || '?'}\` → \`${meta.target || '?'}\`.`,
    '',
    `## Résumé`,
    `- Fichiers modifiés : **${files.length}**`,
    `- Lignes ajoutées : **${added}**, supprimées : **${removed}**`,
    '',
    `## Fichiers`,
    ...(files.length ? files.map((f) => `- \`${f}\``) : ['- (aucun changement détecté dans le diff)']),
    '',
    `## Constats (placeholder)`,
    `Aucune analyse réelle en dry-run. Installe/configure \`copilot\` puis relance pour obtenir la revue${meta.skill ? ` via le skill \`${meta.skill}\`` : ''}.`,
    '',
    `## Note globale`,
    `${files.length ? Math.max(2, 9 - files.length) : 8}/10 (dry-run).`,
    '',
    // Bloc de constats déterministe (contrat avec resolution.js) : un constat par
    // fichier modifié, à une VRAIE ligne changée (extraite du diff) pour que le
    // garde-fou git du suivi de résolution soit réellement exercé en dry-run.
    // TITRE stable par fichier → un même fichier reste « persistant » d'une passe à
    // l'autre ; un fichier qui sort du diff devient « résolu ».
    `<<<FINDINGS ${nonceFindings}`,
    ...mockFindingLines(diff).map((x, i) => `${['blocker', 'major', 'minor', 'info'][i % 4]} | ${x.file} | ${x.line} | Point de revue sur ${x.file}`),
    `FINDINGS ${nonceFindings}>>>`,
  ].join('\n');
}

// Pour chaque fichier du diff, la ligne (côté nouveau) de sa 1re ligne ajoutée.
// Le dossier d'échange interne est exclu : un constat n'y pointe jamais.
function mockFindingLines(diff) {
  const out = [];
  let file = null; let newLine = 0; let taken = false;
  for (const l of String(diff).split('\n')) {
    const mf = l.match(/^\+\+\+ b\/(.+)$/);
    if (mf) { file = mf[1]; taken = false; continue; }
    const mh = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (mh) { newLine = parseInt(mh[1], 10); continue; }
    if (!file || file.startsWith('ai-dev-tools-internal/')) continue;
    if (l.startsWith('+') && !l.startsWith('+++')) {
      if (!taken) { out.push({ file, line: newLine }); taken = true; }
      newLine += 1;
    } else if (!l.startsWith('-')) { newLine += 1; }
  }
  return out;
}

async function runPrompt(prompt, cwd, meta = {}, onLog = () => {}) {
  let output;
  if (isDryRun()) {
    const parts = [COPILOT_BIN, ...EXTRA_ARGS, '-p', JSON.stringify(prompt)];
    onLog(`$ ${parts.join(' ')}  (DRY-RUN — copilot indisponible)`);
    onLog(t('log.copilot.mock'));
    // petit délai simulé pour rendre la progression visible
    await new Promise((r) => setTimeout(r, 150));
    output = mockReport(prompt, cwd, meta);
    onLog(t('log.copilot.mock-done', { n: output.length }));
  } else {
    output = await runReal(prompt, cwd, onLog, meta);
  }
  /* `meta.owner` : à QUI imputer cet appel. Sans lui, une review coûtait « la moyenne » et
     on ne pouvait pas dire laquelle avait été chère — alors que les sessions, elles, portent
     leur coût depuis 1.4.0. Facultatif : les appels sans propriétaire restent comptés. */
  recordUsage(meta.kind, prompt, output, meta.extraInput, meta.owner);
  return output;
}

module.exports = { runPrompt, recordUsage, addOutputToLastUsage, isDryRun, binaryAvailable, countTokens, COPILOT_BIN, EXTRA_ARGS };
