'use strict';
/* Protocole « l'IA pose une question » (ask → stop → resume).
 *
 * Calque le bloc <<<FINDINGS>>> du pipeline de review : mêmes garde-fous (extraction par
 * délimiteurs, JSON strict, troncature, tolérance au malformé). Quand l'option est active,
 * on injecte l'INSTRUCTION dans le prompt ; en fin de session, on PARSE le bloc éventuel.
 */

const MAX_QUESTIONS = 5;

// Consigne ajoutée au prompt quand la session autorise les questions. On demande à l'agent
// de s'arrêter AVANT d'implémenter la partie ambiguë, pour minimiser le travail perdu (§8).
const QUESTIONS_INSTRUCTION = `

---
IMPORTANT — Tu peux poser des questions. Si tu rencontres une décision structurante que tu
ne peux PAS trancher avec confiance (choix d'architecture, ambiguïté du besoin, conflit entre
deux conventions du dépôt), n'invente pas : émets à la toute fin de ta sortie un bloc exactement
au format ci-dessous, puis ARRÊTE-TOI avant d'implémenter la partie ambiguë.

<<<QUESTIONS
[
  {
    "id": "q1",
    "question": "La question, formulée simplement.",
    "context": "Pourquoi ça se pose / ce qui rend le choix ambigu (1-2 phrases).",
    "options": [
      { "value": "a", "label": "Option A (courte)" },
      { "value": "b", "label": "Option B (courte)" }
    ]
  }
]
QUESTIONS>>>

Règles : 5 questions maximum ; "options" à null si un choix fermé n'a pas de sens (réponse
libre attendue) ; ne mets ce bloc QUE si tu as réellement besoin d'une décision humaine. Si tu
peux trancher raisonnablement toi-même, fais-le et n'émets aucun bloc.`;

// Extrait et valide le bloc. Renvoie un tableau de questions normalisées, ou null si absent
// / malformé (dans ce cas l'appelant traite la sortie comme un résultat standard, sans bloquer).
function parseQuestions(text) {
  const s = String(text || '');
  const m = s.match(/<<<QUESTIONS\s*([\s\S]*?)\s*QUESTIONS>>>/);
  if (!m) return null;
  let arr;
  try { arr = JSON.parse(m[1].trim()); } catch { return null; }
  if (!Array.isArray(arr) || !arr.length) return null;

  const out = [];
  for (let i = 0; i < arr.length && out.length < MAX_QUESTIONS; i += 1) {
    const q = arr[i] || {};
    const question = String(q.question || '').trim();
    if (!question) continue; // une entrée sans question est ignorée
    let options = null;
    if (Array.isArray(q.options) && q.options.length) {
      options = q.options
        .map((o) => ({ value: String((o && o.value) ?? '').trim(), label: String((o && o.label) ?? '').trim() }))
        .filter((o) => o.value && o.label);
      if (!options.length) options = null;
    }
    out.push({
      id: String(q.id || `q${out.length + 1}`).trim() || `q${out.length + 1}`,
      question,
      context: String(q.context || '').trim(),
      options,
      answer: null,
    });
  }
  return out.length ? out : null;
}

// Construit l'instruction de reprise à partir des questions + réponses de l'utilisateur (§7).
function buildAnswerInstruction(questions) {
  const lines = (questions || [])
    .filter((q) => q && q.answer != null && String(q.answer).trim())
    .map((q) => `- ${q.question} → ${String(q.answer).trim()}`);
  return [
    'Voici les réponses à tes questions :',
    ...lines,
    '',
    'Poursuis la tâche à partir de là. L\'état courant des fichiers reflète le travail déjà',
    'effectué avant ta question.',
  ].join('\n');
}

module.exports = { QUESTIONS_INSTRUCTION, MAX_QUESTIONS, parseQuestions, buildAnswerInstruction };
