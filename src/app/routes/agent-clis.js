'use strict';
/* Les autres binaires d'agent de ce poste (Réglages → Session IA) : lister, créer, modifier,
   supprimer, promouvoir en défaut, tester. Le défaut lui-même se règle par `/api/config`. */
const { app } = require('../app');
const agentcli = require('../../data/agentcli');
const cli = require('../../agent/cli');
const { wrap } = require('../http');

/* La liste, avec le défaut en tête (`id: null`) : c'est ce que le sélecteur d'une session
   affiche, et l'écran des réglages n'a pas à recomposer l'entrée « par défaut » lui-même. */
app.get('/api/agent-clis', wrap((req, res) => {
  const copilot = require('../../agent/copilot');
  /* `available` : le binaire répond à `--version` sur cette machine (cache d'une minute, par
     binaire) — la liste dit d'un coup d'œil lequel est introuvable, sans attendre un lancement. */
  const avecEtat = (c) => ({ ...c, available: c.bin ? copilot.binaryAvailable(c.bin) : false });
  res.json({ defaut: avecEtat(agentcli.defaut()), items: agentcli.lister().map(avecEtat), dryRunForced: copilot.dryRunForce() });
}));
app.post('/api/agent-clis', wrap((req, res) => { res.json(agentcli.creer(req.body)); }));
app.put('/api/agent-clis/:id', wrap((req, res) => { res.json(agentcli.modifier(Number(req.params.id), req.body)); }));
app.delete('/api/agent-clis/:id', wrap((req, res) => { agentcli.supprimer(Number(req.params.id)); res.json({ ok: true }); }));
/* L'échange avec le défaut. Ce qu'il change de binaire par défaut passe par `updateConfig`,
   donc la preuve de sandbox tombe et la détection se refait, comme pour une saisie à l'écran. */
app.post('/api/agent-clis/:id/default', wrap((req, res) => {
  const r = agentcli.utiliserParDefaut(Number(req.params.id));
  const copilot = require('../../agent/copilot');
  const policy = require('../../agent/policy');
  copilot.redetecter(); policy.oublierBackend(); policy.oublierCapacites();
  res.json(r);
}));
/* « Tester » CE binaire : le même appel court que `/api/agent/test`, posé sur son profil. */
app.post('/api/agent-clis/:id/test', wrap(async (req, res) => {
  const profil = agentcli.parId(Number(req.params.id));
  if (!profil) throw new Error(require('../../core/i18n').t('err.cli.not-found'));
  res.json(await cli.avec(profil, () => require('./agents').testerAgent()));
}));
