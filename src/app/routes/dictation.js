'use strict';
/* La dictée vocale : transcrire un segment, l’état du moteur, le préchauffer, le tester, l’installer.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const jobs = require('../../jobs');
const dictation = require('../../integrations/dictation');
const { wrap } = require('../http');

/* ---------- Dictée vocale (whisper.md) -------------------------------------
   Quatre routes, aucune n'écrit l'audio sur disque. Le fournisseur « navigateur » ne passe
   jamais par ici : il transcrit dans la page et n'envoie rien. */

/* Un segment (ou, avec `final=1`, l'audio complet de la session pour la seconde passe).
   Corps BRUT `audio/wav` ; le numéro de segment, le contexte glissant et la langue voyagent
   en query — c'est ce qui évite d'écrire un parseur multipart ou d'ajouter une dépendance.
   `seq` revient tel quel dans la réponse : deux segments peuvent se chevaucher en vol, et
   c'est le front qui les remet en ordre avant d'insérer. */
app.post('/api/dictation/transcribe', wrap(async (req, res) => {
  const wav = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const r = await dictation.transcrire({
    wav,
    language: req.query.lang,
    ctx: req.query.ctx,
    final: req.query.final === '1',
  });
  res.json({ ...r, seq: Number(req.query.seq) || 0 });
}));
app.get('/api/dictation/status', wrap((req, res) => { res.json(dictation.statut()); }));
/* Chauffe : appelée au survol du micro et à l'ouverture d'une modale de session quand la
   dictée est active. Charger le modèle prend une à trois secondes ; les payer AVANT le
   premier segment, c'est la différence entre « ça répond » et « ça rame ». */
app.post('/api/dictation/warmup', wrap(async (req, res) => { res.json(await dictation.warmup()); }));
/* Le diagnostic complet : binaire, modèle, VAD, démarrage, TRANSCRIPTION d'un échantillon
   embarqué, vocabulaire, fournisseur distant. C'est l'étape « transcription » qui compte —
   c'est elle qui transforme « installé » en « fonctionne ». */
app.post('/api/dictation/test', wrap(async (req, res) => { res.json(await dictation.diagnostic()); }));
/* Installation du moteur : un job, exactement comme une action Docker — donc un journal en
   direct et un « Stop » qui tue proprement. Le corps ne choisit QUE le modèle (liste
   fermée), le VAD (booléen) et le GPU (énumération) : le chemin du script est fixe. */
app.post('/api/dictation/install', wrap((req, res) => {
  const b = req.body || {};
  // Validé ICI, avant de mettre quoi que ce soit en file : un corps hors liste doit répondre
  // 400 tout de suite, pas créer un job qui échouera trois secondes plus tard.
  dictation.commandeInstallation({ model: b.model, vad: b.vad !== false, gpu: b.gpu || '' });
  res.json(jobs.startInstallJob({ model: b.model || 'large-v3-turbo', vad: b.vad !== false, gpu: b.gpu || '' }));
}));
