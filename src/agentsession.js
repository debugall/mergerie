'use strict';
/* Couche d'adaptation « reprise de session d'agent » (spec §4), validée par le banc d'essai
 * de Réglages → AI sessions. Le reste de l'app ne manipule qu'une CLÉ logique de session ;
 * chaque backend la traduit en handle natif :
 *   - claude  : --session-id <uuid> (création) puis --resume <uuid> (reprise). Déterministe.
 *   - copilot : un COPILOT_HOME isolé par clé + --continue (l'unique session du home).
 *
 * Invariants (spec §4.4) : le cwd fait partie de l'identité de session (persister + vérifier) ;
 * jamais --continue côté claude ; une clé = une exécution à la fois (verrou côté appelant).
 */

const { spawn } = require('child_process');
const proc = require('./proc');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const copilot = require('./copilot');
const { DATA_DIR, ensureDir } = require('./paths');
const { t } = require('../public/i18n-runtime.js');

const TIMEOUT_MS = Number(process.env.AGENT_SESSION_TIMEOUT_MS || process.env.COPILOT_TIMEOUT_MS || 900000);
const SESSIONS_ROOT = path.join(DATA_DIR, 'agent-sessions'); // homes Copilot isolés par clé

function backendName() {
  const bin = String(copilot.COPILOT_BIN || '').toLowerCase();
  if (bin.includes('claude')) return 'claude';
  if (bin.includes('copilot')) return 'copilot';
  return 'unknown';
}

const slug = (key) => String(key).replace(/[^\w.-]/g, '_').slice(0, 120);

/* L'entrée standard de l'agent est fermée d'office. Sans ça, `spawn` lui ouvre un tube que
   personne n'alimente ni ne ferme : le CLI attend des données, avertit au bout de trois secondes
   (« no stdin data received in 3s »), et cet avertissement finit par masquer la vraie erreur dans
   le message d'échec — quand il ne fait pas sortir le processus en code 1. `ignore` équivaut au
   `< /dev/null` que le CLI conseille lui-même. */
const STDIO = ['ignore', 'pipe', 'pipe'];

/* Tout process d'agent lancé ici s'ENREGISTRE auprès de `proc` (comme le font déjà git.js et
   copilot.js). Sans cet enregistrement, `proc.cancel` levait bien son drapeau d'annulation mais
   n'avait aucun enfant à tuer : « Stop » vidait la file et laissait l'agent tourner jusqu'à son
   délai — quinze minutes à écrire dans le clone et à consommer des tokens. Or c'est le chemin
   NOMINAL (COPILOT_BIN=claude), c'est-à-dire précisément la phase qu'on veut pouvoir arrêter. */

function spawnAgent({ args, cwd, env }, onLog = () => {}) {
  return new Promise((resolve, reject) => {
    const bin = copilot.COPILOT_BIN;
    const shown = args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
    onLog(`$ ${bin} ${shown}  (cwd=${cwd})`);
    const child = spawn(bin, args, { cwd, env: { ...process.env, ...(env || {}) }, stdio: STDIO });
    proc.setActive(child);                    // sans ça, « Stop » ne tue pas l'agent (cf. en-tête)
    let stdout = ''; let stderr = ''; let obuf = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(t('err.cmd.timeout', { cmd: bin, ms: TIMEOUT_MS }))); }, TIMEOUT_MS);
    // Streame la sortie ligne par ligne : on voit l'agent avancer (copilot n'a pas de mode événements).
    child.stdout.on('data', (d) => { stdout += d; obuf = emitLines(obuf + d, onLog); });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); proc.clearActive(child); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      proc.clearActive(child);
      if (obuf) onLog(obuf);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(t('err.cmd.failed', { cmd: bin, code, sortie: (stderr || stdout).slice(0, 500) })));
    });
  });
}

function emitLines(buf, onLog) {
  const parts = buf.replace(/\r/g, '\n').split('\n');
  const remainder = parts.pop();
  for (const p of parts) if (p.trim()) onLog(p);
  return remainder;
}

// Indice court pour un appel d'outil (fichier édité, commande, motif) — pour un log lisible.
function toolHint(input) {
  if (!input || typeof input !== 'object') return '';
  const f = input.file_path || input.path || input.notebook_path;
  if (f) return ` ${f}`;
  if (input.command) return ` ${String(input.command).slice(0, 70)}`;
  if (input.pattern) return ` /${input.pattern}/`;
  if (input.url) return ` ${input.url}`;
  return '';
}

// Claude en `--output-format stream-json` émet des ÉVÉNEMENTS NDJSON en DIRECT (contrairement
// à `json` qui ne rend qu'à la fin). On les streame en clair dans le log (texte de l'assistant
// + outils utilisés) et on capture le RÉSULTAT final (texte + session_id).
function runClaudeStream(args, cwd, onLog) {
  return new Promise((resolve, reject) => {
    const bin = copilot.COPILOT_BIN;
    const shown = args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
    onLog(`$ ${bin} ${shown}  (cwd=${cwd})`);
    const child = spawn(bin, args, { cwd, stdio: STDIO });
    proc.setActive(child);                    // idem : c'est LE chemin par défaut (claude)
    let stderr = ''; let buf = ''; let result = null; let sessionId = null; let lastText = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(t('err.cmd.timeout', { cmd: bin, ms: TIMEOUT_MS }))); }, TIMEOUT_MS);
    const handleLine = (line) => {
      const s = line.trim();
      if (!s) return;
      let ev;
      try { ev = JSON.parse(s); } catch { onLog(s.slice(0, 300)); return; } // ligne non-JSON : brut
      if (ev.session_id) sessionId = ev.session_id;
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const c of ev.message.content) {
          if (c.type === 'text' && String(c.text || '').trim()) { lastText = c.text; onLog(String(c.text).trim().slice(0, 600)); }
          else if (c.type === 'tool_use') { onLog(`» ${c.name}${toolHint(c.input)}`); }
        }
      } else if (ev.type === 'result') {
        result = (typeof ev.result === 'string') ? ev.result : lastText;
      }
    };
    child.stdout.on('data', (d) => { buf += d; const parts = buf.split('\n'); buf = parts.pop(); for (const p of parts) handleLine(p); });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); proc.clearActive(child); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      proc.clearActive(child);
      if (buf.trim()) handleLine(buf);
      if (code === 0) resolve({ text: (result != null ? result : lastText) || '', sessionId });
      else reject(new Error(t('err.cmd.failed', { cmd: bin, code, sortie: stderr.slice(0, 500) })));
    });
  });
}

// Entrées du home Copilot à NE PAS importer dans le home isolé : sessions/historique (pour
// que --continue reprenne la bonne session et ne pollue pas l'historique réel) et contexte
// d'agent (skills, instructions) qui altérerait le comportement.
const COPILOT_EXCLUDE_ENTRIES = new Set([
  'history', 'history-session-state', 'sessions', 'session-state', 'logs', 'tmp',
  'skills', 'copilot-instructions.md',
]);

function firstExistingDir(cands) {
  for (const c of cands) { if (c && fs.existsSync(c)) return c; }
  return null;
}

// Un home isolé n'a pas l'auth du `/login` (stockée dans le home par défaut) : on lie
// (symlink) l'auth + la config du home source en écartant sessions et contexte. Best-effort.
function bootstrapCopilotHome(home) {
  const source = firstExistingDir([
    process.env.COPILOT_HOME,
    path.join(os.homedir(), '.copilot'),
    process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, 'copilot'),
  ]);
  ensureDir(home);
  if (!source || path.resolve(source) === path.resolve(home)) return { source: null, linked: [] };
  const linked = [];
  for (const name of fs.readdirSync(source)) {
    if (COPILOT_EXCLUDE_ENTRIES.has(name)) continue;
    const dest = path.join(home, name);
    if (fs.existsSync(dest)) continue;
    try { fs.symlinkSync(path.join(source, name), dest); linked.push(name); } catch { /* best-effort */ }
  }
  return { source, linked };
}

/* Le CLI copilot dit « authentication » aussi bien quand le jeton manque que quand il n'a
   PAS PU le valider faute de réseau (« Authentication token found but could not be
   validated. … network fetch failed »). Chercher le mot « authenticat » envoyait donc vers
   /login et GH_TOKEN un utilisateur dont le seul tort était d'être derrière un proxy. On
   teste d'abord des motifs propres au transport — eux ne sont jamais ambigus. */
const NETWORK_RE = /network fetch failed|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|getaddrinfo|tunnel error|EPROTO|ENOTFOUND|Check your network connection/i;
const AUTH_RE = /authenticat|COPILOT_GITHUB_TOKEN|GH_TOKEN|not logged|No authentication/i;
const COPILOT_HOSTS = 'github.com, api.github.com, githubcopilot.com, .githubcopilot.com, api.business.githubcopilot.com';

function enrichCopilotError(e, bootstrap, home) {
  const msg = String(e.message || '');
  if (NETWORK_RE.test(msg)) {
    return new Error([
      'Copilot : échec réseau lors de la validation du jeton — ce n’est pas un problème d’authentification.',
      `Message d’origine : ${msg.slice(0, 400)}`,
      'Causes probables : proxy d’entreprise bloquant api.github.com ou api.business.githubcopilot.com, DNS, pare-feu.',
      `Solutions : 1) vérifier que le serveur joint ces hôtes (curl -x "$HTTP_PROXY" https://api.github.com) ;`,
      `2) si un proxy est en cause, ajouter un NO_PROXY couvrant ${COPILOT_HOSTS} dans le .env du serveur ;`,
      '3) relancer ensuite le job.',
    ].join('\n'));
  }
  if (!AUTH_RE.test(msg)) return e;
  const src = bootstrap && bootstrap.source;
  return new Error([
    'Copilot : authentification introuvable dans le home isolé.',
    src ? `Auth liée depuis ${src} : ${bootstrap.linked.join(', ') || '(rien)'} — mais non reconnue.` : 'Aucun home Copilot source trouvé pour importer l’auth.',
    'Solutions : 1) définir COPILOT_GITHUB_TOKEN / GH_TOKEN dans l’environnement du serveur (.env) ;',
    `2) ou authentifier ce home une fois : COPILOT_HOME=${home} copilot puis /login.`,
  ].join('\n'));
}

/* Lance l'agent dans une session logique `key`.
 * - resume=false : crée la session (claude --session-id / copilot home neuf + bootstrap).
 * - resume=true  : reprend la session (claude --resume / copilot --continue), en passant le
 *   `handle` renvoyé au premier run.
 * Renvoie { text, sessionId, handle, backend }. Le handle et le cwd sont à PERSISTER par
 * l'appelant (le cwd fait partie de l'identité de session — refuser une reprise si mismatch).
 */
async function runInSession({ key, handle, prompt, cwd, resume = false, onLog = () => {} }) {
  const backend = backendName();
  if (backend === 'unknown') throw new Error(t('err.agent.backend', { bin: copilot.COPILOT_BIN }));
  const EXTRA = copilot.EXTRA_ARGS;

  if (backend === 'claude') {
    const id = handle || crypto.randomUUID();
    // stream-json (+ --verbose, requis en -p) : événements en DIRECT → progression visible.
    const sess = resume ? ['--resume', id] : ['--session-id', id];
    const args = [...EXTRA, ...sess, '--output-format', 'stream-json', '--verbose', '-p', prompt];
    const out = await runClaudeStream(args, cwd, onLog);
    return { text: out.text, sessionId: out.sessionId, handle: id, backend };
  }

  // copilot : home isolé par clé (persistant entre les passes d'une même session).
  const home = handle || path.join(SESSIONS_ROOT, slug(key));
  let bootstrap = null;
  if (!resume) {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* neuf */ }
    bootstrap = bootstrapCopilotHome(home);
  }
  const args = resume ? [...EXTRA, '--continue', '-p', prompt] : [...EXTRA, '-p', prompt];
  try {
    const text = await spawnAgent({ args, cwd, env: { COPILOT_HOME: home } }, onLog);
    return { text, sessionId: null, handle: home, backend };
  } catch (e) {
    throw enrichCopilotError(e, bootstrap, home);
  }
}

// Commande à COPIER pour reprendre soi-même la session dans un terminal : `cd` vers le bon
// dossier + lancement de l'agent avec le handle de session. claude : --resume <uuid> ;
// copilot : COPILOT_HOME=<home> + --continue. Renvoie null si la session n'a pas de handle.
function shQuote(s) { return `'${String(s).replace(/'/g, "'\\''")}'`; }
function resumeCommand(backend, handle, cwd) {
  if (!backend || !handle) return null;
  const bin = copilot.COPILOT_BIN;
  const extra = (copilot.EXTRA_ARGS || []).length ? ` ${copilot.EXTRA_ARGS.join(' ')}` : '';
  /* Le `cd` n'est émis que si le dossier de travail est CONNU. Il ne l'est pas quand la
     session a été fournie à la création : on sait la reprendre, pas d'où elle vient. Mieux
     vaut une commande à lancer depuis le bon dossier soi-même que pas de commande du tout —
     sans quoi le bouton disparaîtrait précisément dans le cas où l'on cherche cette session. */
  const cd = cwd ? `cd ${shQuote(cwd)} && ` : '';
  if (backend === 'claude') return `${cd}${bin}${extra} --resume ${handle}`;
  if (backend === 'copilot') return `${cd}COPILOT_HOME=${shQuote(handle)} ${bin}${extra} --continue`;
  return null;
}

module.exports = { backendName, runInSession, resumeCommand, enrichCopilotError, SESSIONS_ROOT };
