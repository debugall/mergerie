'use strict';
/* « Question libre » : poser une question à l'IA SANS dépôt ni dossier, et garder la trace.
 *
 * C'est l'exploration débarrassée du code : même forme (une question, une réponse Markdown,
 * une session d'agent reprenable, des suivis qui continuent la même session), mais aucune
 * cible à préparer — donc pas de clone, pas de checkout, pas de garantie de lecture seule à
 * tenir sur un dépôt.
 *
 * OÙ TOURNE L'AGENT. Dans un dossier à lui, sous `tasks/ask/<id>/`. Trois raisons, dans cet
 * ordre : un agent qui décide d'écrire un fichier ne doit pas le semer dans le dépôt de
 * l'outil ni dans le répertoire courant de l'utilisateur ; le `cwd` fait partie de l'identité
 * d'une session d'agent, donc il doit être STABLE d'une passe à l'autre pour que `--resume`
 * fonctionne ; et c'est là qu'on lui demande d'écrire sa réponse, plutôt que de la lire sur la
 * sortie standard où elle arrive tronquée ou mêlée aux traces de l'agent.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const copilot = require('./copilot');
const agentsession = require('./agentsession');
const agentpass = require('./agentpass');
const pieces = require('./pieces');
const { TASKS_DIR, ensureDir } = require('./paths');
const { t } = require('../public/i18n-runtime.js');

const now = () => new Date().toISOString();

const questionById = (id) => db.prepare('SELECT * FROM question WHERE id = ?').get(Number(id));

function setQuestion(id, patch) {
  const cols = Object.keys(patch).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE question SET ${cols}, updated_at = @u WHERE id = @id`).run({ ...patch, u: now(), id });
}

// Le dossier de travail d'une question : son `cwd` d'agent et le fichier de sa réponse.
const questionDir = (id) => path.join(TASKS_DIR, 'ask', String(id));

const REPONSE_REL = 'reponse.md';

/* La réponse est ÉCRITE PAR L'AGENT dans un fichier, pas lue sur la sortie standard : les
   agents y mêlent leurs traces d'outil, et une réponse longue y arrive tronquée. On garde
   quand même le repli sur la sortie — une réponse dans un format inattendu vaut mieux que
   « rien à afficher ». */
function construirePrompt(question, { suivi, precedente, reprise, piecesBloc = '' }) {
  /* La réponse précédente n'est réinjectée que HORS session : quand l'agent s'en souvient,
     la redonner lui ferait relire son propre texte au lieu de son raisonnement. */
  const prev = (precedente && !reprise)
    ? `\n\nTu as déjà produit la réponse suivante :\n"""\n${precedente}\n"""\nPrends-la en compte et complète-la selon la nouvelle demande.`
    : '';
  const entete = suivi
    ? `QUESTION DE SUIVI : ${question}`
    : `QUESTION : ${question}`;
  return `${entete}${prev}${piecesBloc}\n\n`
    /* « aucun fichier à lire » ne vaut plus dès qu'une pièce est jointe : on ne peut pas
       demander d'ouvrir un document et interdire de lire un fichier dans la même phrase. */
    + (piecesBloc
      ? `Tu réponds à une question posée hors de tout dépôt de code : il n'y a aucun projet à `
        + `explorer et rien à modifier. Appuie-toi sur les pièces jointes ci-dessus et sur ce que `
        + `tu sais, et dis-le franchement si tu ne sais pas.\n\n`
      : `Tu réponds à une question posée hors de tout dépôt de code : il n'y a aucun projet à `
        + `explorer, aucun fichier à lire, et rien à modifier. Réponds à partir de ce que tu sais, `
        + `et dis-le franchement si tu ne sais pas.\n\n`)
    + `Rédige ta réponse en Markdown (français) et écris-la UNIQUEMENT dans le fichier `
    + `\`${REPONSE_REL}\` du répertoire courant. Ne duplique pas ce contenu sur la sortie standard.`;
}

/* Exécute une question (première passe ou suivi). `opts.instruction` = question de suivi :
   elle reprend la session de l'agent, qui garde ainsi le fil de l'échange. */
async function runQuestion(id, onLog = () => {}, opts = {}) {
  const q = questionById(id);
  if (!q) throw new Error(t('err.question-introuvable'));

  const suivi = String((opts.instruction || '')).trim();
  const question = suivi || q.prompt;
  const cwd = questionDir(q.id);
  ensureDir(cwd);
  const outAbs = path.join(cwd, REPONSE_REL);
  const precedente = q.md_path && fs.existsSync(q.md_path) ? fs.readFileSync(q.md_path, 'utf8') : null;

  setQuestion(q.id, { status: 'running', last_error: null });

  /* Le `cwd` fait partie de l'identité d'une session : si celle qu'on a enregistrée vient
     d'ailleurs (session fournie à la main, dossier de données déplacé), on ne la reprend pas
     — l'agent répondrait « session inconnue » et on perdrait la passe. */
  const reprenable = !copilot.isDryRun() && agentsession.backendName() !== 'unknown';
  let reprise = reprenable && !!q.session_key;
  if (reprise && q.session_cwd && path.resolve(q.session_cwd) !== path.resolve(cwd)) {
    onLog(t('log.ask.cwd-mismatch'));
    reprise = false;
  }

  /* Les pièces jointes vivent DÉJÀ dans le répertoire de travail de l'agent (`ask/<id>`) : on
     les référence par leur nom, sans rien copier. */
  const piecesBloc = pieces.blocPrompt('ask', q.id, { ids: opts.imageIds, dest: cwd, onLog });
  const prompt = construirePrompt(question, { suivi: !!suivi, precedente, reprise, piecesBloc });
  try { fs.rmSync(outAbs, { force: true }); } catch { /* pas de réponse précédente */ }

  onLog(t('log.ask.run', { mode: copilot.isDryRun() ? 'dry-run' : t('log.mode.ai') }));
  let stdout = '';
  try {
    if (reprenable) {
      const key = `ask-${q.id}`;
      let creee = !reprise;
      let r;
      try {
        r = await agentsession.runInSession({ key, handle: reprise ? q.session_key : null, prompt, cwd, resume: reprise, onLog });
      } catch (e) {
        if (!reprise) throw e;
        // Même repli qu'ailleurs : la session est perdue, pas la question. On repart d'une
        // session neuve en réinjectant la réponse précédente, seul fil qui lui reste.
        onLog(t('log.task.resume-failed', { raison: String(e.message).split('\n')[0] }));
        r = await agentsession.runInSession({
          key, prompt: construirePrompt(question, { suivi: !!suivi, precedente, reprise: false, piecesBloc }), cwd, resume: false, onLog,
        });
        creee = true;
      }
      stdout = r.text || '';
      copilot.recordUsage('ask', prompt, stdout);
      // À chaque passe : une reprise peut rendre un identifiant nouveau (cf. agentsession).
      setQuestion(q.id, { session_key: r.handle, session_backend: r.backend, session_cwd: cwd });
    } else {
      stdout = await copilot.runPrompt(prompt, cwd, { kind: 'ask' }, onLog);
    }
  } catch (e) {
    setQuestion(q.id, { status: 'error', last_error: e.message, finished_at: now() });
    throw e;
  }

  let contenu = '';
  if (fs.existsSync(outAbs)) contenu = fs.readFileSync(outAbs, 'utf8').trim();
  if (contenu) {
    copilot.addOutputToLastUsage(contenu);
  } else {
    onLog(t('log.ask.stdout-fallback', { fichier: REPONSE_REL }));
    contenu = (stdout || '').trim() || t('ask.no-answer');
  }

  const mdPath = path.join(cwd, 'question.md');
  const entete = `# ${question}\n\n> ${t('ask.md.header', { date: new Date().toLocaleString('fr-FR') })}\n\n---\n\n`;
  fs.writeFileSync(mdPath, entete + contenu, 'utf8');
  /* Chaque suivi ÉCRASE `question.md` : on archive donc la passe, sans quoi une étude menée
     en cinq questions ne garderait que la dernière réponse — c'est-à-dire perdrait ce qu'on
     lui demande justement de garder. `unit_id = 0` : une question n'a pas de sous-unité. */
  agentpass.record('ask', q.id, 0, { kind: suivi ? 'followup' : 'run', prompt: question, text: contenu });
  setQuestion(q.id, { md_path: mdPath, status: 'done', last_error: null, finished_at: now() });
  onLog(t('log.ask.answer-saved'));
  return { mdPath };
}

module.exports = { runQuestion, questionById, questionDir, setQuestion };
