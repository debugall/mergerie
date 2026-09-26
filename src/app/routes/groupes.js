'use strict';
/* Les groupes de dépôts : lister, créer, modifier (membres et gabarits compris), supprimer.
   Un groupe est d'équipe : chaque écriture passe par le store, qui l'envoie dans le dépôt de
   données. Ses membres sont des dépôts de CE poste — un dépôt inconnu ici est refusé à la
   saisie (l'import de la synchro, lui, garde en marge ce qu'il ne peut rattacher). */
const { app } = require('../app');
const db = require('../../db');
const store = require('../../data/store');
const groupes = require('../../data/groupes');
const { t } = require('../../core/i18n');
const { repoById, wrap } = require('../http');

function lireGroupe(body, courant) {
  const b = body || {};
  const name = (b.name != null ? String(b.name) : (courant && courant.name) || '').trim().slice(0, 80);
  if (!name) throw new Error(t('err.group.name-required'));
  const texte = (champ, max) => (b[champ] != null ? String(b[champ]).trim().slice(0, max) : ((courant && courant[champ]) || ''));
  let repos = null;
  if (b.repos != null) {
    repos = [...new Set((Array.isArray(b.repos) ? b.repos : []).map(Number).filter(Boolean))];
    for (const id of repos) if (!repoById(id)) throw new Error(t('err.projet-inconnu'));
  }
  return {
    name, description: texte('description', 500),
    prompt_review: texte('prompt_review', 20000), prompt_modify: texte('prompt_modify', 20000),
    prompt_fix: texte('prompt_fix', 20000), ai_extra_instructions: texte('ai_extra_instructions', 5000),
    repos,
  };
}
function ecrireMembres(groupId, repos) {
  if (repos == null) return;
  db.prepare('DELETE FROM repo_group_member WHERE group_id = ?').run(groupId);
  const ins = db.prepare('INSERT OR IGNORE INTO repo_group_member (group_id, repo_id) VALUES (?, ?)');
  for (const id of repos) ins.run(groupId, id);
}
const avecMembres = (id) => groupes.lister().find((g) => g.id === Number(id)) || null;

app.get('/api/repo-groups', wrap((req, res) => {
  /* Ce que chaque groupe PORTE, compté : règles, vérificateurs — pour que la liste dise à quoi il sert. */
  const regles = new Map(db.prepare('SELECT group_id, COUNT(*) n FROM review_rule WHERE group_id IS NOT NULL GROUP BY group_id').all().map((r) => [r.group_id, r.n]));
  const verifs = new Map(db.prepare('SELECT group_id, COUNT(*) n FROM verifier_group GROUP BY group_id').all().map((r) => [r.group_id, r.n]));
  res.json(groupes.lister().map((g) => ({ ...g, rules: regles.get(g.id) || 0, verifiers: verifs.get(g.id) || 0 })));
}));
app.post('/api/repo-groups', wrap((req, res) => {
  const g = lireGroupe(req.body, null);
  if (db.prepare('SELECT 1 FROM repo_group WHERE name = ?').get(g.name)) throw new Error(t('err.group.name-taken', { name: g.name }));
  const cree = store.ecrire('repo_group', () => {
    const id = db.prepare(`INSERT INTO repo_group (name, description, prompt_review, prompt_modify, prompt_fix, ai_extra_instructions, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(g.name, g.description, g.prompt_review, g.prompt_modify, g.prompt_fix, g.ai_extra_instructions, new Date().toISOString()).lastInsertRowid;
    ecrireMembres(id, g.repos || []);
    return id;
  });
  res.json(avecMembres(cree.id));
}));
app.put('/api/repo-groups/:id', wrap((req, res) => {
  const cur = groupes.parId(req.params.id);
  if (!cur) throw new Error(t('err.group.not-found'));
  const g = lireGroupe(req.body, cur);
  if (db.prepare('SELECT 1 FROM repo_group WHERE name = ? AND id <> ?').get(g.name, cur.id)) throw new Error(t('err.group.name-taken', { name: g.name }));
  store.ecrire('repo_group', () => {
    db.prepare(`UPDATE repo_group SET name = ?, description = ?, prompt_review = ?, prompt_modify = ?, prompt_fix = ?, ai_extra_instructions = ? WHERE id = ?`)
      .run(g.name, g.description, g.prompt_review, g.prompt_modify, g.prompt_fix, g.ai_extra_instructions, cur.id);
    ecrireMembres(cur.id, g.repos);
    return cur.id;
  });
  res.json(avecMembres(cur.id));
}));
app.delete('/api/repo-groups/:id', wrap((req, res) => {
  /* Les règles qui visaient ce groupe redeviennent générales SI elles n'ont pas de dépôt : on
     préfère les DÉSACTIVER — une règle qui se mettrait à valoir partout au moment où son groupe
     disparaît est exactement le genre de silence qu'on évite. */
  const id = Number(req.params.id);
  if (!groupes.parId(id)) throw new Error(t('err.group.not-found'));
  for (const r of db.prepare('SELECT id FROM review_rule WHERE group_id = ? AND repo_id IS NULL').all(id)) {
    store.ecrire('review_rule', () => { db.prepare('UPDATE review_rule SET group_id = NULL, enabled = 0 WHERE id = ?').run(r.id); return r.id; });
  }
  for (const r of db.prepare('SELECT id FROM review_rule WHERE group_id = ?').all(id)) {
    store.ecrire('review_rule', () => { db.prepare('UPDATE review_rule SET group_id = NULL WHERE id = ?').run(r.id); return r.id; });
  }
  store.supprimer('repo_group', id);
  res.json({ ok: true });
}));
/* La configuration EFFECTIVE d'un dépôt, et d'où vient chaque valeur : ce que la fiche du dépôt
   affiche (« gabarit de review : du groupe backend »). */
app.get('/api/repos/:id/effective', wrap((req, res) => {
  const repo = repoById(Number(req.params.id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const { getConfig } = require('../../data/config');
  const { config, origines } = groupes.configPourDepot(getConfig(), repo.id);
  const champs = {};
  for (const c of groupes.CHAMPS_HERITES) champs[c] = { value: config[c] || '', origin: origines[c] ? { kind: 'group', ...origines[c] } : { kind: 'global' } };
  res.json({ groups: groupes.groupesDuDepot(repo.id).map((g) => ({ id: g.id, name: g.name })), fields: champs });
}));
