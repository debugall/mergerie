'use strict';
/* Les agents : profils de session, connaissance d’un agent de domaine, skills et sous-agents de fichier.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const approbation = require('../../data/approbation');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const agentsession = require('../../agent/session');
const skillscan = require('../../agent/skillscan');
const agentprofile = require('../../agent/profile');
const agentknowledge = require('../../agent/knowledge');
const agentschedule = require('../../agent/schedule');
const demoAgents = require('../../demo/agents');
const { wrap } = require('../http');
const { reposPourScan } = require('../lib/sessions');
const { exigerMemeEtat } = require('../lib/verifications');

/* ---------- AGENTS : les profils de session ----------
   Toutes les routes rendent la MÊME forme (`agentprofile.lire`) : la liste et le détail ne
   divergent pas, et l'écran n'a qu'un rendu à écrire. `age()` n'est PAS dedans — il fait un
   fetch par dépôt, et la liste se recharge à chaque passage sur l'onglet. */
function agentOu404(id) {
  const a = agentprofile.lire(Number(id));
  if (!a) { const e = new Error(t('agents.err.not-found')); e.status = 404; throw e; }
  return a;
}
app.get('/api/agents', wrap((req, res) => { res.json(agentprofile.lister()); }));
app.get('/api/agents/:id', wrap((req, res) => { res.json(agentOu404(req.params.id)); }));
app.post('/api/agents', wrap((req, res) => {
  const errs = agentprofile.valider(req.body || {});
  if (errs.length) return res.status(400).json({ error: t(errs[0]), errors: errs });
  res.status(201).json(agentprofile.creer(req.body || {}));
}));
app.put('/api/agents/:id', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  const errs = agentprofile.valider({ ...a, ...(req.body || {}) }, a.id);
  if (errs.length) return res.status(400).json({ error: t(errs[0]), errors: errs });
  res.json(agentprofile.modifier(a.id, req.body || {}));
}));
app.delete('/api/agents/:id', wrap((req, res) => {
  agentOu404(req.params.id);
  agentprofile.supprimer(Number(req.params.id));
  res.json({ ok: true });
}));
app.post('/api/agents/:id/approve', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  exigerMemeEtat((req.body || {}).signature, approbation.signature(approbation.empreinteAgent(a.id)));
  approbation.approuverAgent(a.id);
  res.json(agentprofile.lire(a.id));
}));
app.post('/api/agents/:id/duplicate', wrap((req, res) => {
  const source = agentOu404(req.params.id);
  /* LA COPIE D'UN AGENT EN ATTENTE SERAIT APPROUVÉE à sa création — une copie est un agent créé
     ici. Ce serait approuver les permissions de l'original sans les avoir regardées. */
  if (!approbation.agentApprouve(source.id)) {
    const e = new Error(t('agents.err.not-approved', { name: source.name }));
    e.code = 'APPROBATION'; e.status = 409;
    throw e;
  }
  res.status(201).json(agentprofile.dupliquer(Number(req.params.id)));
}));
app.post('/api/agents/:id/restore', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  if (!a.builtin_key) throw new Error(t('agents.err.not-builtin'));
  res.json(agentprofile.restaurer(a.id));
}));
/* Lancer. `ask` PART ; `code` ne part pas — il rend de quoi PRÉ-REMPLIR la modale de session,
   parce qu'un agent qui se met à écrire dans des dépôts sans qu'on ait vu lesquels serait
   exactement ce que la règle « un agent ne devine jamais un dépôt » interdit. */
app.post('/api/agents/:id/run', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  const mode = (req.body && req.body.mode) === 'code' ? 'code' : 'ask';
  if (mode === 'code' && a.kind !== 'code' && !a.is_domain) throw new Error(t('agents.err.no-code-mode'));
  const question = String((req.body && req.body.question) || '');
  const repoIds = (req.body && req.body.repo_ids) || null;
  if (mode === 'code') {
    /* Le mode « code » ne lance rien ici, il préremplit une session — qui tournera avec les
       permissions de l'agent. Même porte que le lancement direct. */
    if (!approbation.agentApprouve(a.id)) {
      const e = new Error(t('agents.err.not-approved', { name: a.name }));
      e.code = 'APPROBATION'; e.status = 409;
      throw e;
    }
    const m = agentprofile.materialize(a, { mode, question, repoIds });
    return res.json({ prefill: { kind: m.kind, targets: m.targets, prompt: m.prompt, agent_id: a.id, label: m.label } });
  }
  res.json(agentprofile.lancer(a, { mode, question, repoIds, triggeredBy: 'manual' }));
}));
/* ---------- La connaissance d'un agent de domaine ----------
   Trois gestes : relire, corriger à la main, faire refaire. Le troisième est le seul qui coûte
   un appel IA, et le seul dont le résultat ATTEND une validation. */
app.get('/api/agents/:id/knowledge', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  res.json(agentknowledge.versions(a.id));
}));
app.get('/api/agents/:id/knowledge/:version', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  const v = agentknowledge.versionDe(a.id, req.params.version);
  if (!v) throw new Error(t('agents.err.version-not-found'));
  res.json(v);
}));
app.put('/api/agents/:id/knowledge', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  const r = agentknowledge.editer(a, (req.body || {}).content);
  agentknowledge.viderCacheAge(a.id);
  res.json(r);
}));
app.post('/api/agents/:id/knowledge/refresh', wrap(async (req, res) => {
  const a = agentOu404(req.params.id);
  if (!a.is_domain) throw new Error(t('agents.err.not-domain'));
  res.json(await agentprofile.refreshKnowledge(a, 'manual'));
}));
app.post('/api/agents/:id/knowledge/:version/activate', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  const r = agentknowledge.activer(a, req.params.version);
  if (r.error) throw new Error(t(r.error));
  agentknowledge.viderCacheAge(a.id);
  res.json(r);
}));
app.post('/api/agents/:id/knowledge/publish', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  res.json(agentknowledge.publierDansNotes(a));
}));
/* L'ÂGE fait un fetch par dépôt : jamais dans la liste, qui se recharge à chaque passage sur
   l'onglet. Route à part, appelée par la carte APRÈS son rendu, et mise en cache une heure. */
app.get('/api/agents/:id/age', wrap(async (req, res) => {
  const a = agentOu404(req.params.id);
  if (!a.is_domain) return res.json([]);
  if (demoAgents.isDemo()) return res.json(demoAgents.age(a));
  res.json(await agentknowledge.age(a));
}));
/* Créer un agent de domaine : on donne un SUJET, le cartographe fait le reste. La route ne
   crée aucun agent — elle lance une exploration dont la SORTIE en créera un. */
app.post('/api/agents/domain', wrap((req, res) => {
  const carto = agentprofile.parCle('cartographer');
  if (!carto) throw new Error(t('agents.err.no-cartographer'));
  const subject = String((req.body || {}).subject || '').trim();
  if (!subject) throw new Error(t('agents.err.subject-required'));
  /* Un sous-ensemble de dépôts restreint le RUN, jamais le profil : le cartographe est
     `all_repos` et le reste — on ne modifie pas un profil livré pour un lancement. C'est
     `ciblesDe` qui applique la restriction, une fois, pour tous les appelants : la
     cartographie comme les mises à jour de connaissance qui la relanceront. */
  res.json(agentprofile.lancer(carto, {
    mode: 'ask', question: subject, repoIds: (req.body || {}).repo_ids, triggeredBy: 'manual',
  }));
}));
/* Déclencher un tick d'horaire à la main. Attendre la minute dans un test serait un pari sur
   l'horloge d'une machine chargée ; et sur une installation réelle, c'est le bouton qui répond
   à « est-ce que mon horaire part vraiment ? » sans attendre demain matin. */
app.post('/api/agents/tick', wrap((req, res) => {
  const journal = [];
  const lances = agentschedule.tick(new Date(), (m) => journal.push(m));
  res.json({ started: lances.length, log: journal });
}));
app.get('/api/agents/:id/preview', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  res.json({ argv: agentprofile.previewFor(a, agentsession.backendName()) });
}));
// L'aperçu d'un formulaire NON ENREGISTRÉ : l'éditeur montre ce que produirait la sauvegarde.
app.post('/api/agents/preview', wrap((req, res) => {
  const corps = req.body || {};
  res.json({
    argv: agentprofile.previewFor({
      kind: corps.kind, model: corps.model, permission_mode: corps.permission_mode,
      system_prompt: corps.system_prompt,
      allowed_tools_json: JSON.stringify(corps.allowed_tools_json || []),
      disallowed_tools_json: JSON.stringify(corps.disallowed_tools_json || []),
      max_turns: corps.max_turns,
      subagents_json: JSON.stringify(corps.subagents_json || {}),
    }, agentsession.backendName()),
    errors: agentprofile.valider(corps, corps.id || null),
  });
}));
app.get('/api/skills', wrap((req, res) => {
  // En démo, aucun dépôt n'est cloné : le scan ne trouverait rien, et l'écran serait vide.
  if (demoAgents.isDemo()) return res.json(demoAgents.scan());
  const r = skillscan.scan({ repos: reposPourScan(req.query.repos), cfg: getConfig() });
  res.json(r);
}));
app.post('/api/skills/rescan', wrap((req, res) => {
  skillscan.invalidate();
  res.json({ ok: true });
}));
