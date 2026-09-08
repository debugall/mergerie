'use strict';
/* Dictée vocale — un micro dans chaque champ de texte (whisper.md).
 *
 * Trois fournisseurs derrière UNE seule fonction `transcrire()` :
 *   - `local`   : whisper.cpp (`whisper-server`), lancé et surveillé par Mergerie comme
 *                 elle lance `claude`/`copilot`. Le serveur monte sur un port libre de la
 *                 boucle locale, reste chaud, et s'arrête après un quart d'heure sans usage ;
 *   - `openai`  : n'importe quel endpoint qui parle `/v1/audio/transcriptions` (OpenAI,
 *                 Groq, Mistral, LocalAI…). Le MÊME client HTTP sert les deux, parce que
 *                 `whisper-server --inference-path /v1/audio/transcriptions` répond
 *                 exactement la même forme ;
 *   - `browser` : rien ici — le navigateur transcrit lui-même (Web Speech API) et n'envoie
 *                 aucun audio au serveur. Seule la normalisation (§4.4) s'applique, côté front.
 *
 * CE QUI FAIT LA PRÉCISION n'est pas le moteur, c'est le PROMPT : Mergerie connaît déjà les
 * noms qu'on dicte — dépôts, services, environnements, préfixes Jira, branches ouvertes,
 * vérificateurs, jobs Jenkins — et les envoie avec chaque segment. Même modèle, même audio :
 * « la mer je-re-re-queuse 244 sur Eubat Front » devient « la merge request 244 sur
 * webapp-front ». C'est le levier le moins cher de toute la fonctionnalité (whisper.md §4.2).
 *
 * L'AUDIO NE TOUCHE JAMAIS LE DISQUE : le corps de la requête est relayé en mémoire au
 * moteur, et libéré à la réponse. Rien n'en est journalisé.
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const db = require('./db');
const { getConfig } = require('./config');
const { DATA_DIR, ROOT } = require('./paths');
const httpreq = require('./httpreq');
const i18n = require('../public/i18n-runtime.js');
const { countTokens } = require('./copilot');
const demo = require('./demo-dictation');
const rt = require('../public/dictation-runtime.js');
const { t } = i18n;

/* Le plafond du corps audio (10 Mo, soit un peu plus de cinq minutes de PCM 16 kHz mono) et
   la fréquence d'échantillonnage viennent du module partagé : le navigateur les applique en
   fabriquant le fichier, le serveur en le validant. */
const { MAX_WAV, SAMPLE_RATE } = rt;
const MAX_PROMPT_TOKENS = 224;   // limite du prompt initial de Whisper, tous modèles
const MODELES = ['large-v3-turbo', 'large-v3-turbo-q8_0', 'large-v3-turbo-q5_0', 'large-v3', 'large-v3-q5_0'];
const GPUS = ['', 'cuda', 'vulkan'];

const modeleParDefaut = () => path.join(DATA_DIR, 'models', 'ggml-large-v3-turbo.bin');

/* Le fournisseur EFFECTIF. En démo (et en dry-run), le MOTEUR est simulé — sinon la démo
   montrerait un micro qui ne transcrit rien, ce qui est pire que pas de micro.
   Mais « éteinte » reste éteinte : la démo remplace le moteur, jamais le réglage. Sans cette
   garde, décocher la dictée ne l'aurait pas éteinte, et l'écran aurait menti. */
function fournisseur(cfg) {
  const regle = String((cfg || getConfig()).dictation_provider || 'off');
  if (regle === 'off') return 'off';
  return demo.actif() ? 'demo' : regle;
}

/* La langue envoyée au moteur : jamais la détection automatique (elle coûte une passe et se
   trompe sur les phrases courtes truffées d'anglais).

   `auto` veut dire « celle de l'ÉCRAN », pas celle de la base : la langue vit dans le
   navigateur et voyage avec chaque requête (`X-Mergerie-Lang`), exactement comme pour les
   messages d'erreur et le jeu de démo. Lue en base, passer l'interface en anglais laissait
   dicter en français — et le moteur, à qui la langue est FORCÉE, obéissait. */
function langueDe(cfg, demandee) {
  const c = cfg || getConfig();
  const d = String(demandee || '').trim();
  if (d === 'fr' || d === 'en') return d;
  const reglee = String(c.dictation_language || 'auto');
  if (reglee === 'fr' || reglee === 'en') return reglee;
  return i18n.getLang() === 'en' ? 'en' : 'fr';
}

/* L'en-tête WAV est validé par le module PARTAGÉ (public/dictation-runtime.js) : le
   navigateur fabrique le fichier, le serveur le relaie, et une seule implémentation dit ce
   qui est acceptable. Il rend une CLÉ de traduction ; c'est ici qu'on la traduit. */
function validerWav(buf) {
  const r = rt.validerWav(Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []));
  return r.ok ? r : { ok: false, erreur: t(r.cle, { taux: r.taux }) };
}

/* ============================================================ PROMPT DE VOCABULAIRE
   Construit depuis la base, à chaque requête (whisper-server lit `prompt` par requête,
   vérifié sur 1.9.2 — whisper.md §12). L'ordre est un ordre de PRIORITÉ : ce qui est en
   tête survit à la troncature, et le glossaire de l'utilisateur est en tête parce que
   c'est lui qui porte ce qu'aucune table ne sait. */
const SOCLE = {
  fr: ['merge request', 'pull request', 'endpoint', 'commit', 'push', 'rebase', 'pipeline',
    'npm', 'Docker', 'Jenkins', 'Jira', 'GitLab', 'GitHub', 'Claude', 'Copilot', 'README', 'CHANGELOG'],
  en: ['merge request', 'pull request', 'endpoint', 'commit', 'push', 'rebase', 'pipeline',
    'npm', 'Docker', 'Jenkins', 'Jira', 'GitLab', 'GitHub', 'Claude', 'Copilot', 'README', 'CHANGELOG'],
};
/* La phrase d'amorce est PONCTUÉE, et c'est tout son intérêt : Whisper traite le prompt
   comme le début de la transcription et en copie le style — majuscules, points, `!214` en
   chiffres. Sans elle, la sortie arrive en minuscules et sans ponctuation. */
const AMORCE = {
  fr: 'Bonjour, voici la merge request !214 sur webapp-front : il faut corriger l’endpoint /health, puis lancer npm test.',
  en: 'Hello, here is merge request !214 on webapp-front: fix the /health endpoint, then run npm test.',
};

const lignes = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);

// Les termes du vocabulaire, dans l'ordre de priorité, sans doublon (comparaison insensible).
function termesVocabulaire(cfg, language) {
  const c = cfg || getConfig();
  const out = [];
  const vus = new Set();
  const pousser = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!s || s.length > 60) return;
    const k = s.toLowerCase();
    if (vus.has(k)) return;
    vus.add(k);
    out.push(s);
  };
  const req = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };

  // 1. le glossaire : jamais évincé par la limite
  lignes(c.dictation_vocabulary).forEach(pousser);
  // 2. dépôts, services, environnements, préfixes Jira, vérificateurs, jobs Jenkins
  for (const r of req('SELECT project FROM repo WHERE enabled = 1 ORDER BY project')) {
    const p = String(r.project || '');
    pousser(p.split('/').filter(Boolean).pop());
  }
  for (const s of req('SELECT name FROM service ORDER BY pinned DESC, name')) pousser(s.name);
  for (const e of req('SELECT name FROM environment ORDER BY position')) pousser(e.name);
  for (const m of req("SELECT DISTINCT ticket_jira_key k FROM mr WHERE ticket_jira_key IS NOT NULL AND ticket_jira_key <> ''")) {
    const pref = String(m.k || '').split('-')[0];
    if (/^[A-Z][A-Z0-9]+$/.test(pref)) pousser(pref);
  }
  for (const r of req("SELECT DISTINCT branch_pattern b FROM repo WHERE branch_pattern IS NOT NULL AND branch_pattern <> ''")) {
    const pref = String(r.b || '').replace(/-$/, '');
    if (/^[A-Z][A-Z0-9]+$/.test(pref)) pousser(pref);
  }
  for (const v of req('SELECT name FROM verifier ORDER BY name')) pousser(v.name);
  for (const j of req('SELECT DISTINCT job_path FROM repo_jenkins')) {
    String(j.job_path || '').split('/').filter(Boolean).forEach(pousser);
  }
  // 3. les branches des MR ouvertes, les plus récentes d'abord
  for (const m of req("SELECT source_branch FROM mr WHERE status <> 'done' ORDER BY updated_at DESC LIMIT 20")) {
    pousser(m.source_branch);
  }
  // 4. le socle technique de la langue
  (SOCLE[language] || SOCLE.fr).forEach(pousser);
  return out;
}

/* CE QUE LE CONTEXTE GLISSANT COÛTE, RÉSERVÉ D'AVANCE. Les derniers mots dictés sont ajoutés
   APRÈS le prompt (§4.3) — et whisper ne garde que les 224 DERNIERS tokens : ajouter sans
   réserver ne rognait donc pas la queue mais la TÊTE, c'est-à-dire le glossaire de
   l'utilisateur et les noms de dépôts, exactement ce qui a la priorité la plus haute. La
   réservation vaut TOUJOURS, même quand le contexte est vide : le nombre de termes affiché
   dans les réglages est alors celui qui part réellement, à toutes les phrases. */
const RESERVE_CONTEXTE = 70;


/* Le prompt effectivement envoyé : les termes, puis l'amorce — c'est-à-dire le style AU PLUS
   PRÈS de ce qui va être transcrit. La troncature retire les termes par la fin (les moins
   prioritaires), jamais au milieu d'un terme, et l'amorce a sa place réservée. */
function construirePrompt(cfg, language) {
  const lang = language === 'en' ? 'en' : 'fr';
  const amorce = AMORCE[lang];
  const budget = MAX_PROMPT_TOKENS - countTokens(amorce) - RESERVE_CONTEXTE - 2;
  const tous = termesVocabulaire(cfg, lang);
  const gardes = [];
  let coût = 0;
  for (const terme of tous) {
    const c = countTokens(`${terme}, `);
    if (coût + c > budget) break;
    gardes.push(terme);
    coût += c;
  }
  const prompt = gardes.length ? `${gardes.join(', ')}. ${amorce}` : amorce;
  return { prompt, terms: gardes, sha: crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 12) };
}

/* La normalisation, les commandes vocales, la liste de corrections et le filtre
   anti-hallucination vivent dans le module PARTAGÉ : le fournisseur « navigateur » transcrit
   sans passer par ici et doit pourtant produire exactement le même texte. On ne garde de ce
   côté que le COMPTEUR de rejets, qui est un état de serveur — c'est lui que l'écran des
   réglages montre quand le micro capte du bruit. */
const { normaliserSegment, assembler, parserRemplacements, similarite } = rt;

let rejetes = 0;
function filtrerHallucination(texte, opts) {
  const r = rt.filtrerHallucination(texte, opts);
  if (!r.ok && r.raison !== 'vide') rejetes += 1;
  return r;
}
const compteRejets = () => rejetes;
const resetRejets = () => { rejetes = 0; };

/* =================================================================== MULTIPART
   `/v1/audio/transcriptions` attend un `multipart/form-data`. Trente lignes ici valent mieux
   qu'une dépendance de plus : le projet en compte trois, dont une native. */
function multipart(champs, fichier) {
  const bord = `----mergerie${crypto.randomBytes(12).toString('hex')}`;
  const parts = [];
  for (const [nom, val] of Object.entries(champs)) {
    if (val == null || val === '') continue;
    parts.push(Buffer.from(`--${bord}\r\nContent-Disposition: form-data; name="${nom}"\r\n\r\n${val}\r\n`, 'utf8'));
  }
  parts.push(Buffer.from(`--${bord}\r\nContent-Disposition: form-data; name="file"; filename="${fichier.nom}"\r\n`
    + 'Content-Type: audio/wav\r\n\r\n', 'utf8'));
  parts.push(fichier.buf);
  parts.push(Buffer.from(`\r\n--${bord}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${bord}` };
}

// TLS d'entreprise, mêmes variables que les forges (documenté au guide).
const agentDictee = httpreq.makeAgentFactory('DICTATION_CA', 'DICTATION_INSECURE');

/* Un appel `/v1/audio/transcriptions`, qui sert AU LOCAL COMME AU DISTANT : `whisper-server`
   lancé avec `--inference-path /v1/audio/transcriptions` répond `{"text": …}`, exactement la
   forme d'OpenAI. Seul le cycle de vie du process distingue les deux fournisseurs. */
async function appelerTranscription(base, { wav, language, prompt, model, apiKey }) {
  const { body, contentType } = multipart(
    { model: model || 'whisper-1', language, prompt, response_format: 'json', temperature: '0' },
    { nom: 'audio.wav', buf: wav },
  );
  const headers = { 'Content-Type': contentType, 'Content-Length': String(body.length) };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const url = `${String(base).replace(/\/+$/, '')}/v1/audio/transcriptions`;
  const r = await httpreq.request(url, { method: 'POST', headers, body, agent: agentDictee() });
  if (r.status === 401 || r.status === 403) throw new Error(t('err.dictation.cle'));
  if (r.status === 413) throw new Error(t('err.dictation.wav-gros'));
  if (r.status >= 400) {
    let detail = String(r.body || '').slice(0, 200);
    try { detail = JSON.parse(r.body).error.message || detail; } catch { /* corps non JSON */ }
    throw new Error(t('err.dictation.moteur', { detail }));
  }
  let json;
  try { json = JSON.parse(r.body); } catch { throw new Error(t('err.dictation.reponse')); }
  return String(json.text == null ? '' : json.text);
}

/* ======================================================= CYCLE DE VIE DU MOTEUR LOCAL
   Un serveur RÉSIDENT, pas un `whisper-cli` par segment : recharger le modèle coûte une à
   trois secondes à chaque fois, ce qui suffirait à rendre la dictée inutilisable. Il monte
   sur un port libre de 127.0.0.1, chauffe sur une seconde de silence, sérialise les
   requêtes (deux décodages sur un même GPU se ralentissent l'un l'autre) et s'arrête après
   un quart d'heure sans usage — turbo occupe deux gigaoctets. */
const moteur = {
  child: null, port: 0, pret: null, langue: '', bin: '', modele: '',
  dernier: 0, timer: null, file: Promise.resolve(), journal: [], demarre: 0, backend: '',
};

function journaliser(ligne) {
  for (const l of String(ligne).split('\n')) {
    if (!l.trim()) continue;
    moteur.journal.push(l.slice(0, 300));
    if (/metal/i.test(l)) moteur.backend = 'Metal';
    else if (/cuda/i.test(l)) moteur.backend = 'CUDA';
    else if (/vulkan/i.test(l)) moteur.backend = 'Vulkan';
  }
  while (moteur.journal.length > 200) moteur.journal.shift();
}

// Un port libre : on en ouvre un sur 0, on lit celui que l'OS a donné, on le referme.
// `whisper-server` n'accepte pas 0 lui-même — d'où ce détour.
function portLibre() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/* Le binaire : `dictation_command` s'il est renseigné (chemin, `nice`, drapeaux), sinon
   `whisper-server` du PATH. La ligne est découpée par le MÊME analyseur que les
   vérificateurs — celui qui refuse les métacaractères de shell, puisqu'on ne lance jamais
   de shell. */
function commandeMoteur(cfg) {
  const brut = String((cfg || getConfig()).dictation_command || '').trim();
  if (!brut) return { ok: true, programme: 'whisper-server', args: [] };
  // eslint-disable-next-line global-require
  const verify = require('./verify');
  return verify.decouperCommande(brut);
}

function binaireDispo(programme) {
  try {
    const r = spawnSync(programme, ['--help'], { encoding: 'utf8', timeout: 10000 });
    if (r.error) return { ok: false, erreur: String(r.error.message) };
    const sortie = `${r.stdout || ''}${r.stderr || ''}`;
    return { ok: /usage|whisper/i.test(sortie), sortie: sortie.slice(0, 400) };
  } catch (e) { return { ok: false, erreur: String(e.message) }; }
}

// Un fichier ggml commence par la signature « lmgg » ; une page d'erreur HTML par « < ».
function modeleValide(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf.toString('latin1') === 'lmgg';
  } catch { return false; }
}

// Une seconde de silence, 16 kHz mono : chauffe le moteur (le premier décodage après le
// chargement est toujours le plus lent) et sonde un fournisseur distant. Même fabricant de
// WAV que le navigateur — il n'y en a qu'un.
const wavSilence = (secondes = 1) => Buffer.from(rt.wavSilence(secondes));

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

async function repond(port) {
  try {
    const r = await httpreq.request(`http://127.0.0.1:${port}/`, { method: 'GET' });
    return r.status > 0;
  } catch { return false; }
}

function arreterMoteur() {
  if (moteur.timer) { clearTimeout(moteur.timer); moteur.timer = null; }
  oublierMoteur();
  const c = moteur.child;
  moteur.child = null; moteur.pret = null; moteur.port = 0;
  if (!c) return;
  try { c.kill('SIGTERM'); } catch { /* déjà mort */ }
  setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ok */ } }, 2000).unref();
}

/* …ET JAMAIS D'ORPHELIN D'UNE VIE PRÉCÉDENTE. Les gestionnaires ci-dessous couvrent l'arrêt
   propre ; un `SIGKILL` sur Mergerie, une panne de courant, et le moteur survit tout seul avec
   ses deux gigaoctets. On note donc son PID et son port à côté de la base, et au premier
   démarrage suivant on tue ce qui reste — mais SEULEMENT si le port répond encore : un PID est
   réattribué, et tuer un numéro lu dans un fichier périmé tuerait n'importe quel process. */
const FICHIER_PID = () => path.join(DATA_DIR, 'dictation-engine.json');

function noterMoteur(pid, port) {
  try { fs.writeFileSync(FICHIER_PID(), JSON.stringify({ pid, port })); } catch { /* best-effort */ }
}
function oublierMoteur() {
  try { fs.rmSync(FICHIER_PID(), { force: true }); } catch { /* best-effort */ }
}

/* Le garde-fou « une seule fois par process » vit chez l'APPELANT, pas ici : cette fonction
   est le geste dangereux du fichier (tuer un PID lu sur le disque), et elle doit pouvoir être
   éprouvée seule, autant de fois qu'un test le demande. */
let orphelinRegle = false;
async function tuerOrphelin() {
  let note;
  try { note = JSON.parse(fs.readFileSync(FICHIER_PID(), 'utf8')); } catch { return; }
  if (!note || !note.pid || !note.port) { oublierMoteur(); return; }
  try { process.kill(note.pid, 0); } catch { oublierMoteur(); return; }   // plus personne
  if (!(await repond(note.port))) { oublierMoteur(); return; }            // pas notre moteur
  try { process.kill(note.pid, 'SIGTERM'); } catch { /* déjà parti */ }
  oublierMoteur();
}

/* JAMAIS D'ORPHELIN. Le moteur est un process enfant qui tient deux gigaoctets : arrêter
   Mergerie doit l'emporter avec lui. `exit` couvre la sortie normale et `process.exit()` ;
   les signaux, eux, terminent le process SANS jouer les gestionnaires de `exit` — il faut donc
   les intercepter.

   MAIS PAS AU CHARGEMENT. Poser un gestionnaire de `SIGINT` supprime le comportement PAR DÉFAUT
   de Node pour tout le serveur, et le simple fait d'importer ce module changeait ainsi la façon
   dont Mergerie s'arrête, moteur ou pas. On ne les installe donc qu'à la naissance du PREMIER
   moteur — il y a alors quelque chose à emporter —, et on ne décide pas du code de sortie à la
   place de qui que ce soit : on se retire et on RENVOIE le signal, pour que le comportement par
   défaut (ou un autre gestionnaire) s'applique tel quel. */
let signauxPoses = false;
function poserSignaux() {
  if (signauxPoses) return;
  signauxPoses = true;
  process.on('exit', () => { const c = moteur.child; if (c) { try { c.kill('SIGKILL'); } catch { /* déjà mort */ } } });
  for (const sig of ['SIGTERM', 'SIGINT']) {
    const sur = () => { arreterMoteur(); process.removeListener(sig, sur); process.kill(process.pid, sig); };
    process.on(sig, sur);
  }
}

function armerInactivite(cfg) {
  const min = Number((cfg || getConfig()).dictation_idle_minutes);
  if (moteur.timer) clearTimeout(moteur.timer);
  moteur.timer = null;
  if (!Number.isFinite(min) || min <= 0) return;    // 0 = ne jamais arrêter
  moteur.timer = setTimeout(() => {
    if (Date.now() - moteur.dernier >= min * 60000) arreterMoteur();
  }, min * 60000 + 1000);
  if (moteur.timer.unref) moteur.timer.unref();
}

/* Démarre le moteur, ou rend celui qui tourne. La langue voyageant PAR REQUÊTE, changer de
   langue ou de glossaire ne relance rien : seule une commande ou un modèle différent le fait. */
async function assurerMoteur(cfg) {
  const c = cfg || getConfig();
  const cmd = commandeMoteur(c);
  if (!cmd.ok) throw new Error(t('err.dictation.commande', { detail: cmd.erreur }));
  const modele = String(c.dictation_model || '').trim() || modeleParDefaut();
  if (moteur.child && (moteur.bin !== cmd.programme || moteur.modele !== modele)) arreterMoteur();
  if (moteur.pret) return moteur.pret;

  moteur.pret = (async () => {
    if (!fs.existsSync(modele)) throw new Error(t('err.dictation.modele', { chemin: modele }));
    if (!orphelinRegle) { orphelinRegle = true; await tuerOrphelin(); }
    const port = await portLibre();
    const vad = String(c.dictation_vad_model || '').trim();
    const coeurs = Math.max(1, (require('node:os').cpus() || []).length - 1);
    const args = [
      ...cmd.args,
      '-m', modele,
      '--host', '127.0.0.1', '--port', String(port),
      '--inference-path', '/v1/audio/transcriptions',
      '-t', String(coeurs), '-fa',
      '--no-speech-thold', '0.6', '--entropy-thold', '2.4', '--logprob-thold', '-1.0', '-bs', '5',
    ];
    if (vad && fs.existsSync(vad)) args.push('--vad', '--vad-model', vad);
    const t0 = Date.now();
    moteur.journal = []; moteur.backend = '';
    /* Sans shell, environnement MINIMAL : le moteur n'a besoin de rien de ce que porte le
       process Mergerie, et surtout pas des jetons de forge. */
    const child = spawn(cmd.programme, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '', HOME: process.env.HOME || '', LANG: process.env.LANG || 'C.UTF-8',
        ...(process.platform === 'win32' ? {
          SystemRoot: process.env.SystemRoot || '', TEMP: process.env.TEMP || '', USERPROFILE: process.env.USERPROFILE || '',
        } : {}),
      },
    });
    moteur.child = child; moteur.port = port; moteur.bin = cmd.programme; moteur.modele = modele;
    noterMoteur(child.pid, port);
    poserSignaux();
    child.stdout.on('data', (d) => journaliser(String(d)));
    child.stderr.on('data', (d) => journaliser(String(d)));
    child.on('error', (e) => journaliser(`spawn: ${e.message}`));
    child.on('exit', (code) => {
      journaliser(`exit ${code}`);
      if (moteur.child === child) { moteur.child = null; moteur.pret = null; moteur.port = 0; }
    });

    // Prêt = il répond en HTTP. Trente secondes : charger turbo et compiler les shaders
    // Metal prend une à trois secondes à chaud, davantage au tout premier lancement.
    const fin = Date.now() + 30000;
    for (;;) {
      if (!moteur.child) throw new Error(t('err.dictation.demarrage', { journal: moteur.journal.slice(-15).join('\n') }));
      if (await repond(port)) break;
      if (Date.now() > fin) { arreterMoteur(); throw new Error(t('err.dictation.demarrage', { journal: moteur.journal.slice(-15).join('\n') })); }
      await attendre(200);
    }
    moteur.demarre = Date.now() - t0;
    // La chauffe : le premier `/inference` après le chargement est toujours le plus lent.
    try { await appelerTranscription(`http://127.0.0.1:${port}`, { wav: wavSilence(1), language: 'fr', prompt: '', model: 'whisper-1' }); }
    catch { /* la chauffe n'est pas une condition */ }
    return port;
  })().catch((e) => { moteur.pret = null; throw e; });

  return moteur.pret;
}

/* Une requête à la fois vers le moteur local : deux décodages en parallèle sur un même GPU
   ne vont pas plus vite, ils se gênent. Le distant, lui, accepte le parallèle. */
function serialiser(fn) {
  const suivant = moteur.file.then(fn, fn);
  moteur.file = suivant.then(() => {}, () => {});
  return suivant;
}

/* ==================================================================== TRANSCRIRE */
async function transcrire({ wav, language, ctx, final } = {}) {
  const cfg = getConfig();
  const lang = langueDe(cfg, language);
  const v = validerWav(wav);
  if (!v.ok) { const e = new Error(v.erreur); e.status = 400; throw e; }

  const prov = fournisseur(cfg);
  const t0 = Date.now();
  let brut = '';

  if (prov === 'demo') {
    brut = await demo.transcrire({ duration_ms: v.duration_ms, language: lang, final });
  } else if (prov === 'local') {
    const { prompt } = construirePrompt(cfg, lang);
    const port = await assurerMoteur(cfg);
    moteur.dernier = Date.now();
    armerInactivite(cfg);
    brut = await serialiser(() => appelerTranscription(`http://127.0.0.1:${port}`, {
      wav, language: lang, prompt: promptAvecContexte(prompt, ctx), model: 'whisper-1',
    }));
    moteur.dernier = Date.now();
  } else if (prov === 'openai') {
    const { prompt } = construirePrompt(cfg, lang);
    brut = await appelerTranscription(cfg.dictation_url || 'https://api.openai.com', {
      wav, language: lang, prompt: promptAvecContexte(prompt, ctx),
      model: cfg.dictation_remote_model || 'gpt-4o-mini-transcribe',
      apiKey: cfg.dictation_api_key || '',
    });
  } else {
    const e = new Error(t('err.dictation.eteint'));
    e.code = 'DICTATION_OFF';
    e.status = 409;
    throw e;
  }

  const engineMs = Date.now() - t0;
  const garde = filtrerHallucination(brut, { precedent: '' });
  const seg = garde.ok ? normaliserSegment(garde.texte, {
    language: lang,
    replacements: parserRemplacements(cfg.dictation_replacements),
    jiraPrefixes: prefixesJira(),
  }) : { text: '', command: null };

  return {
    text: seg.text,
    command: seg.command,
    dropped: garde.ok ? null : garde.raison,
    duration_ms: v.duration_ms,
    engine_ms: engineMs,
    language: lang,
    provider: prov,
  };
}

/* Le contexte glissant : les derniers mots déjà dictés, APRÈS le vocabulaire. Sans lui,
   « API » redevient « à pied » au deuxième segment. Il est PLAFONNÉ à la place qui lui a été
   réservée dans le budget (`RESERVE_CONTEXTE`) — on retire des mots par le DÉBUT jusqu'à ce
   qu'il tienne dedans —, et jamais alimenté par une sortie filtrée : un prompt qui contient
   une hallucination la fait revenir. */
function contexteGlissant(brut) {
  let mots = String(brut || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(-60);
  while (mots.length && countTokens(mots.join(' ')) > RESERVE_CONTEXTE) mots = mots.slice(1);
  return mots.join(' ');
}

function promptAvecContexte(prompt, ctx) {
  const c = contexteGlissant(ctx);
  return c ? `${prompt} ${c}` : prompt;
}

function prefixesJira() {
  const out = new Set();
  const req = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };
  for (const r of req("SELECT DISTINCT branch_pattern b FROM repo WHERE branch_pattern IS NOT NULL AND branch_pattern <> ''")) {
    const p = String(r.b || '').replace(/-$/, '').toUpperCase();
    if (/^[A-Z][A-Z0-9]+$/.test(p)) out.add(p);
  }
  for (const m of req("SELECT DISTINCT ticket_jira_key k FROM mr WHERE ticket_jira_key IS NOT NULL AND ticket_jira_key <> ''")) {
    const p = String(m.k || '').split('-')[0].toUpperCase();
    if (/^[A-Z][A-Z0-9]+$/.test(p)) out.add(p);
  }
  return [...out];
}

/* ======================================================================= STATUT */
function statut() {
  const cfg = getConfig();
  const prov = fournisseur(cfg);
  const lang = langueDe(cfg);
  const { terms } = construirePrompt(cfg, lang);
  const modele = String(cfg.dictation_model || '').trim() || modeleParDefaut();
  return {
    provider: prov,
    ready: prov === 'demo' || (prov === 'local' ? !!moteur.child : prov !== 'off'),
    model: prov === 'openai' ? (cfg.dictation_remote_model || '') : path.basename(modele),
    language: lang,
    /* LA PLATEFORME DU SERVEUR, pas celle du navigateur : c'est la machine qui HÉBERGE
       Mergerie qui installe le moteur, et l'écran doit nommer ce qui va s'y passer. Déduite de
       l'agent utilisateur, elle se trompait dès que l'on ouvrait l'outil depuis une autre
       machine — la confirmation promettait alors Homebrew à un serveur Linux. */
    platform: process.platform,
    silence_ms: Math.min(1500, Math.max(400, Number(cfg.dictation_silence_ms) || 700)),
    final_pass: cfg.dictation_final_pass !== '0',
    commands: rt.COMMANDES[lang].map(([, nom]) => nom),
    vocab_terms: terms.length,
    vocab: terms.slice(0, 60),
    dropped: rejetes,
    engine: prov === 'local' ? `whisper.cpp${moteur.backend ? ` · ${moteur.backend}` : ''}` : '',
    last_log: prov === 'local' ? moteur.journal.slice(-15) : [],
  };
}

async function warmup() {
  const cfg = getConfig();
  if (fournisseur(cfg) !== 'local') return { ok: true, warm: false };
  await assurerMoteur(cfg);
  moteur.dernier = Date.now();
  armerInactivite(cfg);
  return { ok: true, warm: true, startup_ms: moteur.demarre };
}

/* ================================================================= DIAGNOSTIC
   Un moteur local, c'est trois choses qui peuvent manquer indépendamment (le binaire, le
   modèle, le micro) et une qui peut mentir (un binaire présent qui ne charge pas le
   modèle). On ne « pingue » donc pas : on DÉROULE la chaîne et on nomme la première marche
   qui casse, avec le geste qui la répare. Les étapes s'arrêtent à la première ✗ — inutile de
   démarrer un moteur sans modèle —, les suivantes passent en `skip`. */

const ECHANTILLON = {
  fr: { fichier: 'audio/dictation-test-fr.wav', attendu: 'Mergerie, test de la dictée : merge request 214 sur webapp-front.' },
  en: { fichier: 'audio/dictation-test-en.wav', attendu: 'Mergerie, dictation test: merge request 214 on webapp-front.' },
};

async function diagnostic() {
  const cfg = getConfig();
  const prov = fournisseur(cfg);
  const lang = langueDe(cfg);
  const etapes = [];
  let casse = false;
  const ajouter = (key, status, detail, remedy) => {
    etapes.push({ key, status: casse && status !== 'ok' ? 'skip' : status, detail: detail || '', remedy: remedy || '' });
    if (!casse && status === 'fail') casse = true;
  };
  const saut = (key) => etapes.push({ key, status: 'skip', detail: '', remedy: '' });

  if (prov === 'demo') {
    for (const k of ['binary', 'model', 'vad', 'start', 'transcribe', 'vocab']) {
      ajouter(k, 'ok', t('dictation.diag.demo'));
    }
    saut('remote');
    return { provider: prov, verdict: 'ready', steps: etapes };
  }
  if (prov === 'off') {
    ajouter('provider', 'fail', '', t('dictation.diag.remedy.off'));
    return { provider: prov, verdict: 'off', steps: etapes };
  }

  if (prov === 'local') {
    const cmd = commandeMoteur(cfg);
    if (!cmd.ok) ajouter('binary', 'fail', cmd.erreur, t('dictation.diag.remedy.binary'));
    else if (moteur.child) {
      /* UN MOTEUR QUI TOURNE EST SA PROPRE PREUVE. `whisper-server --help` ne rend pas la main
         tant qu'un autre whisper-server est en vie (mesuré : 71 ms seul, dix secondes de délai
         dépassé avec un serveur en fond) : re-sonder le binaire faisait donc échouer l'étape
         « Binaire » précisément quand la dictée marchait — vert à froid, rouge une fois chaud.
         On ne relance pas une sonde pour redemander ce que l'on a déjà sous les yeux. */
      ajouter('binary', 'ok', `${cmd.programme} — ${t('dictation.diag.running')}`);
    } else {
      const b = binaireDispo(cmd.programme);
      if (b.ok) ajouter('binary', 'ok', `${cmd.programme}${b.sortie ? ` — ${(b.sortie.split('\n')[0] || '').trim().slice(0, 80)}` : ''}`);
      else ajouter('binary', 'fail', b.erreur || cmd.programme, t('dictation.diag.remedy.binary'));
    }

    const modele = String(cfg.dictation_model || '').trim() || modeleParDefaut();
    if (!casse) {
      if (fs.existsSync(modele) && modeleValide(modele)) {
        const mo = Math.round(fs.statSync(modele).size / 1048576);
        ajouter('model', 'ok', `${path.basename(modele)} — ${mo} Mo`);
      } else ajouter('model', 'fail', modele, t('dictation.diag.remedy.model'));
    } else ajouter('model', 'skip');

    const vad = String(cfg.dictation_vad_model || '').trim();
    if (vad && fs.existsSync(vad)) ajouter('vad', 'ok', `${path.basename(vad)} — ${Math.round(fs.statSync(vad).size / 1024)} ko`);
    else ajouter('vad', 'warn', '', t('dictation.diag.remedy.vad'));

    if (!casse) {
      try {
        const t0 = Date.now();
        await assurerMoteur(cfg);
        ajouter('start', 'ok', t('dictation.diag.started', { ms: Date.now() - t0, backend: moteur.backend || 'CPU' }));
      } catch (e) {
        ajouter('start', 'fail', e.message, moteur.journal.slice(-15).join('\n'));
      }
    } else ajouter('start', 'skip');
  } else {
    for (const k of ['binary', 'model', 'vad', 'start']) saut(k);
  }

  // L'étape qui compte : celle qui transforme « installé » en « fonctionne ».
  if (!casse) {
    const ech = ECHANTILLON[lang] || ECHANTILLON.fr;
    const p = path.join(ROOT, 'public', ech.fichier);
    if (!fs.existsSync(p)) {
      /* Sans échantillon de référence, on ne peut pas juger la JUSTESSE — mais on peut
         encore prouver que le décodage fonctionne, en envoyant une seconde de silence. On
         le dit tel quel : « il répond » n'est pas « il transcrit bien », et laisser croire
         l'un pour l'autre serait exactement le mensonge que cette étape existe pour éviter. */
      try {
        const t0 = Date.now();
        await transcrire({ wav: wavSilence(1), language: lang });
        ajouter('transcribe', 'warn', `${t('dictation.diag.sample-missing')} (${Date.now() - t0} ms)`, ech.fichier);
      } catch (e) { ajouter('transcribe', 'fail', e.message, t('dictation.diag.remedy.transcribe')); }
    } else {
      try {
        const t0 = Date.now();
        const r = await transcrire({ wav: fs.readFileSync(p), language: lang });
        const sim = similarite(r.text, ech.attendu);
        if (sim >= 0.8) ajouter('transcribe', 'ok', `« ${r.text} » — ${Date.now() - t0} ms`);
        else ajouter('transcribe', 'fail', `« ${r.text} »`, t('dictation.diag.remedy.transcribe'));
      } catch (e) { ajouter('transcribe', 'fail', e.message, t('dictation.diag.remedy.transcribe')); }
    }
  } else ajouter('transcribe', 'skip');

  const { terms } = construirePrompt(cfg, lang);
  ajouter('vocab', 'ok', t('dictation.diag.vocab', { n: terms.length, count: terms.length }));

  if (prov === 'openai') {
    try {
      const t0 = Date.now();
      await appelerTranscription(cfg.dictation_url || 'https://api.openai.com', {
        wav: wavSilence(1), language: lang, prompt: '',
        model: cfg.dictation_remote_model || 'gpt-4o-mini-transcribe', apiKey: cfg.dictation_api_key || '',
      });
      ajouter('remote', 'ok', `${cfg.dictation_remote_model || ''} — ${Date.now() - t0} ms`);
    } catch (e) { ajouter('remote', 'fail', e.message, t('dictation.diag.remedy.remote')); }
  } else saut('remote');

  const verdict = etapes.some((e) => e.status === 'fail') ? 'incomplete' : 'ready';
  return { provider: prov, verdict, steps: etapes, vocab: terms.slice(0, 60) };
}

/* =================================================================== INSTALLATION
   Le bouton lance le script du dépôt qui correspond au système DU SERVEUR — c'est la machine
   qui héberge Mergerie qui dicte, pas celle du navigateur.

   Ce que le serveur refuse : le chemin du script est FIXE, jamais reçu du client ; le modèle
   vient d'une liste fermée, le GPU d'une énumération, le VAD d'un booléen. `spawn` sans
   shell, environnement minimal — jamais les jetons du process. */
function commandeInstallation(opts = {}) {
  const plateforme = opts.platform || process.platform;
  const modele = String(opts.model || 'large-v3-turbo');
  if (!MODELES.includes(modele)) { const e = new Error(t('err.dictation.modele-inconnu', { modele })); e.status = 400; throw e; }
  const gpu = String(opts.gpu || '');
  if (!GPUS.includes(gpu)) { const e = new Error(t('err.dictation.gpu-inconnu', { gpu })); e.status = 400; throw e; }
  if (gpu && plateforme === 'darwin') { const e = new Error(t('err.dictation.gpu-macos')); e.status = 400; throw e; }
  if (gpu === 'vulkan' && plateforme === 'win32') { const e = new Error(t('err.dictation.gpu-windows')); e.status = 400; throw e; }
  const vad = opts.vad !== false;
  const dataDir = opts.dataDir || DATA_DIR;
  const racine = opts.root || ROOT;
  // Un script de test peut se substituer au vrai (bout en bout) : il reste choisi par
  // l'ENVIRONNEMENT du serveur, jamais par le corps de la requête.
  const surcharge = String(process.env.DICTATION_INSTALL_SCRIPT || '').trim();

  if (plateforme === 'win32') {
    const script = surcharge || path.join(racine, 'scripts', 'install-whisper.ps1');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Dir', dataDir, '-Model', modele];
    if (!vad) args.push('-NoVad');
    if (gpu === 'cuda') args.push('-Cuda');
    return { programme: 'powershell.exe', args, script };
  }
  if (plateforme === 'darwin' || plateforme === 'linux') {
    const script = surcharge || path.join(racine, 'scripts', 'install-whisper.sh');
    const args = [script, '--dir', dataDir, '--model', modele];
    if (!vad) args.push('--no-vad');
    if (gpu === 'cuda') args.push('--cuda');
    if (gpu === 'vulkan') args.push('--vulkan');
    return { programme: 'sh', args, script };
  }
  const e = new Error(t('err.dictation.plateforme', { plateforme }));
  e.status = 400;
  throw e;
}

/* DES FINS DE LIGNE WINDOWS DANS UN SCRIPT SHELL. Un dépôt extrait avec `core.autocrlf=true`
   — le défaut de Git pour Windows, hérité par WSL quand le clone vient de là — porte des CRLF,
   et `sh` (dash) échoue alors dès la première ligne, sur un message tronqué par le retour
   chariot lui-même : « 26: set: Illegal option - ». `.gitattributes` l'empêche pour les
   prochains clones ; pour ceux qui existent, on n'exige pas un `dos2unix` : on écrit une copie
   normalisée dans le dossier temporaire des données et on lance celle-là, en le disant. Le
   chemin d'origine reste FIXE (celui du dépôt) : la copie n'est qu'une transcription. Sans
   objet pour PowerShell, qui lit les deux. */
function scriptSansCR(cmd, tmpDir) {
  if (cmd.programme !== 'sh') return { cmd, normalise: false };
  let contenu;
  try { contenu = fs.readFileSync(cmd.script, 'utf8'); } catch { return { cmd, normalise: false }; }
  if (!contenu.includes('\r')) return { cmd, normalise: false };
  const dossier = tmpDir || path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(dossier, { recursive: true });
  const copie = path.join(dossier, path.basename(cmd.script));
  fs.writeFileSync(copie, contenu.replace(/\r\n?/g, '\n'), { mode: 0o755 });
  const args = cmd.args.map((a) => (a === cmd.script ? copie : a));
  return { cmd: { ...cmd, args, script: copie }, normalise: true, origine: cmd.script };
}

// L'environnement du script : le minimum, plus le marqueur qui lui dit qu'il tourne sans
// terminal (pas de barre de progression, et une ligne MERGERIE_RESULT à la fin).
function envInstallation(dataDir) {
  return {
    PATH: process.env.PATH || '', HOME: process.env.HOME || '', LANG: process.env.LANG || 'C.UTF-8',
    MERGERIE_JOB: '1', MERGERIE_DATA_DIR: dataDir || DATA_DIR,
    ...(process.platform === 'win32' ? {
      SystemRoot: process.env.SystemRoot || '', TEMP: process.env.TEMP || '', USERPROFILE: process.env.USERPROFILE || '',
    } : {}),
  };
}

/* La dernière ligne du script : `MERGERIE_RESULT {…}`. Absente ou tronquée, l'installation
   est en ERREUR — un script qui ne rend pas de résultat n'a pas fini son travail, et
   remplir les réglages à sa place inventerait des chemins. */
function lireResultatInstallation(sortie) {
  const lignesSortie = String(sortie || '').split('\n');
  for (let i = lignesSortie.length - 1; i >= 0; i -= 1) {
    const l = lignesSortie[i].trim();
    const i2 = l.indexOf('MERGERIE_RESULT');
    if (i2 === -1) continue;
    try {
      const o = JSON.parse(l.slice(i2 + 'MERGERIE_RESULT'.length).trim());
      if (o && typeof o === 'object' && o.server && o.model) return o;
    } catch { /* ligne suivante */ }
  }
  return null;
}

/* Ce que le résultat écrit dans les réglages. `dictation_command` reste VIDE quand le
   binaire est dans le PATH : y mettre un chemin absolu figerait une installation que
   Homebrew, demain, déplacera. */
function reglagesDepuisResultat(res) {
  const patch = {
    dictation_model: String(res.model || ''),
    dictation_vad_model: res.vad ? String(res.vad) : '',
    dictation_command: res.in_path ? '' : String(res.server || ''),
  };
  if (String(getConfig().dictation_provider || 'off') === 'off') patch.dictation_provider = 'local';
  return patch;
}

module.exports = {
  transcrire, statut, warmup, diagnostic, arreterMoteur,
  validerWav, construirePrompt, termesVocabulaire, normaliserSegment, assembler,
  filtrerHallucination, parserRemplacements, similarite, compteRejets, resetRejets,
  commandeInstallation, scriptSansCR, envInstallation, lireResultatInstallation, reglagesDepuisResultat,
  contexteGlissant, promptAvecContexte, RESERVE_CONTEXTE,
  langueDe, fournisseur, wavSilence, modeleParDefaut, appelerTranscription,
  tuerOrphelin, noterMoteur,
  MODELES, GPUS, MAX_WAV, SAMPLE_RATE, MAX_PROMPT_TOKENS,
};
