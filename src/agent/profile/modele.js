'use strict';
/* Le PROFIL d’un agent : le lire, le lister, le valider, le créer, le modifier, le dupliquer, le supprimer, le restaurer — et la fiche que l’écran affiche (`decorer`). Aucun lancement ici : ce module est ce que tous les autres peuvent importer sans cycle.
   Extrait de agent/profile.js (refacto.md, étape 5) : les corps sont ceux d'origine, au mot près. */
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../db');
const { slugLibre } = require('../../core/ulid');
const { etat } = require('../../data/localstate');
const store = require('../../data/store');
const agentargs = require('../args');
const approbation = require('../../data/approbation');
const agentdefaults = require('../defaults');
const horaire = require('../horaire');
const { tokensDe } = require('../knowledge-texte');
const { getConfig } = require('../../data/config');
const i18n = require('../../core/i18n');
const { t } = i18n;

const jsonOu = (txt, repli) => { try { const v = JSON.parse(txt); return v == null ? repli : v; } catch { return repli; } };
/* Les allowlists par défaut. Une exploration LIT — et lit l'histoire du dépôt, ce qui demande
   `git log`/`show`/`blame` mais rien qui écrive. Un codage a besoin d'écrire, et de la panoplie
   habituelle. Elles ne s'appliquent que si le profil n'en donne pas : le sien fait toujours foi. */
const OUTILS_DEFAUT = {
  explore: ['Read', 'Glob', 'Grep', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git blame *)'],
  code: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git *)', 'Bash(npm *)', 'Bash(ls *)'],
};
/* ---------- Lecture ---------- */

function repos(agentId) {
  return db.prepare(`SELECT ar.repo_id, ar.branch, ar.role, repo.project
    FROM agent_repo ar JOIN repo ON repo.id = ar.repo_id
    WHERE ar.agent_id = ? ORDER BY repo.project`).all(agentId);
}
function decorer(a) {
  if (!a) return null;
  const k = db.prepare(`SELECT id, version, status, created_at, repos_json, gaps_json, tokens, md_path
    FROM agent_knowledge WHERE agent_id = ? AND status = 'active'`).get(a.id);
  const enAttente = db.prepare(`SELECT version FROM agent_knowledge
    WHERE agent_id = ? AND status = 'pending' ORDER BY version DESC`).get(a.id);
  const dernier = db.prepare(`SELECT id AS task_id, status, finished_at FROM task
    WHERE agent_id = ? ORDER BY id DESC`).get(a.id);
  /* CE QUE LE DERNIER RUN A CONSOMMÉ, en TOKENS. La carte affichait des dollars : un chiffre
     que seul le backend annonce, absent sur les backends muets, et qui ne se compare à rien
     d'un mois à l'autre quand les tarifs bougent. Les tokens sont mesurés dans tous les cas
     et disent la seule chose actionnable — combien de texte cet agent brasse à chaque passage. */
  const cout = dernier ? db.prepare(`SELECT SUM(tokens_est) tok FROM usage
    WHERE owner_kind = 'task' AND owner_id = ?`).get(dernier.task_id) : null;
  /* À APPROUVER SUR CE POSTE : permissions, outils ou horaire arrivés changés par la synchro.
     `approved_before` montre ce qui a changé, pas seulement que quelque chose a changé. */
  const approval = { pending: !approbation.agentApprouve(a.id), before: approbation.agentApprouveAvant(a.id) };
  return {
    approval_pending: approval.pending,
    approved_before: approval.before,
    approval_signature: approbation.signature(approbation.empreinteAgent(a.id)),
    ...a,
    repos: repos(a.id),
    is_domain: a.knowledge_prompt != null,
    last_run: dernier ? { ...dernier, tokens: (cout && cout.tok) || null } : null,
    /* L'HORAIRE EN TOUTES LETTRES. La carte affichait la SYNTAXE (`weekly mon 07:00`) : une
       grammaire qu'on écrit dans le formulaire, pas une phrase qu'on lit sur une carte — et
       elle ne suivait pas la langue. `phrase()` existait et n'était appelée nulle part. */
    schedule_said: (() => {
      if (!a.schedule) return '';
      try { return horaire.phrase(a.schedule) || ''; } catch { return ''; }
    })(),
    /* QUAND IL REPASSE. Un agent planifié ne montrait rien entre deux runs : ni la date du
       dernier, ni celle du prochain. Calculé, jamais stocké — une date en base se
       désynchroniserait du jour où l'horaire change. */
    next_run: (() => {
      if (!a.schedule) return null;
      try {
        const c = horaire.creneauSuivant(horaire.parse(a.schedule));
        return c ? c.toISOString() : null;
      } catch { return null; }
    })(),
    run_count: db.prepare('SELECT COUNT(*) n FROM task WHERE agent_id = ?').get(a.id).n,
    /* LA DERNIÈRE FOIS QUE SON HORAIRE A TIRÉ **ICI**. La colonne a quitté la table : trois
       instances allumées lanceraient sinon trois fois le même agent, chacune persuadée que le
       tir de la voisine était le sien. L'écran, lui, continue de lire le même champ. */
    schedule_fired_at: etat.lire('agent', a.uid, 'schedule_fired_at'),
    knowledge: k ? {
      id: k.id,
      version: k.version,
      status: k.status,
      created_at: k.created_at,
      unverified: jsonOu(k.repos_json, []).reduce((n, r) => n + ((r.unverified || []).length), 0),
      gaps: jsonOu(k.gaps_json, []).length,
      // Ce que la carte coûte à lire, à chaque run : elle part dans le prompt à chaque fois.
      tokens: tokensDe(k),
      pending_version: enAttente ? enAttente.version : null,
    } : (enAttente ? { pending_version: enAttente.version } : null),
  };
}
function lister() {
  return db.prepare('SELECT * FROM agent ORDER BY name').all().map(decorer);
}
function lire(id) {
  return decorer(db.prepare('SELECT * FROM agent WHERE id = ?').get(Number(id) || 0));
}
function parCle(builtinKey) {
  return decorer(db.prepare('SELECT * FROM agent WHERE builtin_key = ?').get(builtinKey));
}
/* ---------- Validation ---------- */

const COLONNES = ['name', 'description', 'kind', 'scope_kind', 'system_prompt', 'prompt_template',
  'model', 'permission_mode', 'allowed_tools_json', 'disallowed_tools_json', 'max_turns',
  'skills_json', 'subagents_json', 'output_kind', 'output_ref', 'knowledge_prompt', 'schedule',
  /* QUI honore l'horaire. Une équipe, trois instances allumées : sans ce champ, le même agent
     planifié tournerait trois fois et serait facturé trois fois. */
  'runner',
  'defaults_json'];
function valider(body, id = null) {
  const errs = [];
  const nom = String((body && body.name) || '').trim();
  if (!nom) errs.push('agents.err.name-required');
  else {
    const autre = db.prepare('SELECT id FROM agent WHERE name = ?').get(nom);
    if (autre && autre.id !== Number(id)) errs.push('agents.err.name-taken');
  }
  if (body.kind != null && !['explore', 'code'].includes(body.kind)) errs.push('agents.err.kind');
  if (body.scope_kind != null && !['repos', 'all_repos'].includes(body.scope_kind)) errs.push('agents.err.scope');
  if (body.output_kind != null && !['report', 'note_page', 'agent'].includes(body.output_kind)) errs.push('agents.err.output-kind');
  /* UN SEUL NIVEAU (décision 9). Un agent de domaine qui créerait des agents ouvrirait une
     hiérarchie que rien ne borne, et dont personne ne saurait plus qui a écrit quoi. */
  if (body.output_kind === 'agent' && String(body.knowledge_prompt || '').trim()) {
    errs.push('agents.err.domain-cannot-create');
  }
  /* Un horaire sans borne de tours est un agent qui peut partir seul, la nuit, sans limite de
     travail. La borne est la seule chose qui rende l'automatique acceptable. */
  if (String(body.schedule || '').trim() && !(Number(body.max_turns) > 0)) {
    errs.push('agents.err.schedule-needs-max-turns');
  }
  if (String(body.schedule || '').trim()) {
    if (!horaire.parse(body.schedule)) errs.push('agents.err.schedule-syntax');
  }
  /* `subagents_json` arrive tantôt en OBJET (formulaire du front), tantôt en TEXTE (relecture
     d'une ligne de base). Ne traiter que le second laissait passer sans un mot un sous-agent
     incomplet venu du formulaire — précisément le cas que la validation existe pour attraper. */
  const sous = (body.subagents_json && typeof body.subagents_json === 'object')
    ? body.subagents_json : jsonOu(body.subagents_json, {});
  errs.push(...agentargs.validate({
    model: body.model,
    permissionMode: body.permission_mode,
    maxTurns: body.max_turns,
    agents: sous,
  }));
  return [...new Set(errs)];
}
/* A18 — LE BROUILLON D'UN PROFIL QU'ON ESSAIE, réduit à ce qui CHANGE LE RUN. On ne recopie
   pas le formulaire entier dans la session : ni l'horaire (un essai ne se planifie pas), ni la
   sortie, ni le périmètre (les dépôts sont ceux que la modale a cochés). Le nom sert à
   l'écran et au prompt système. La validation est celle d'un vrai profil : ce qui échouerait
   au lancement doit échouer ici, pas trois minutes plus tard dans un journal.

   `name` est le seul champ où la validation diffère : un brouillon n'entre pas dans la table,
   il n'a donc pas à être unique — on refuse seulement le vide. */
function brouillonValide(body) {
  const nom = String((body && body.name) || '').trim();
  if (!nom) throw Object.assign(new Error(i18n.t('agents.err.name-required')), { status: 400 });
  const errs = valider({ ...body, name: `\u0000essai\u0000` }).filter((e) => !/name-(required|taken)/.test(e));
  if (errs.length) throw Object.assign(new Error(errs.map((e) => i18n.t(e)).join(' · ')), { status: 400 });
  const sous = (body.subagents_json && typeof body.subagents_json === 'object')
    ? body.subagents_json : jsonOu(body.subagents_json, {});
  return {
    name: nom,
    kind: body.kind === 'code' ? 'code' : 'explore',
    model: String(body.model || ''),
    permission_mode: String(body.permission_mode || ''),
    allowed_tools_json: JSON.stringify(Array.isArray(body.allowed_tools_json) ? body.allowed_tools_json : jsonOu(body.allowed_tools_json, [])),
    disallowed_tools_json: JSON.stringify(Array.isArray(body.disallowed_tools_json) ? body.disallowed_tools_json : jsonOu(body.disallowed_tools_json, [])),
    max_turns: Number(body.max_turns) || null,
    subagents_json: JSON.stringify(sous),
    system_prompt: String(body.system_prompt || ''),
  };
}
/* ---------- Écriture ---------- */

function ecrireRepos(agentId, liste) {
  db.prepare('DELETE FROM agent_repo WHERE agent_id = ?').run(agentId);
  const ins = db.prepare('INSERT OR IGNORE INTO agent_repo (agent_id, repo_id, branch, role) VALUES (?,?,?,?)');
  for (const r of liste || []) {
    const rid = Number(r && r.repo_id);
    if (!rid) continue;
    ins.run(agentId, rid, String((r && r.branch) || '').trim(), r && r.role === 'target' ? 'target' : 'readonly');
  }
}
function valeursDe(body, base = {}) {
  const v = { ...base };
  for (const c of COLONNES) if (body[c] !== undefined) v[c] = body[c];
  v.name = String(v.name || '').trim().slice(0, 120);
  v.description = String(v.description || '');
  v.kind = v.kind === 'code' ? 'code' : 'explore';
  v.scope_kind = v.scope_kind === 'repos' ? 'repos' : 'all_repos';
  v.system_prompt = String(v.system_prompt || '');
  v.prompt_template = String(v.prompt_template || '');
  v.model = String(v.model || '').trim();
  v.permission_mode = String(v.permission_mode || '').trim();
  for (const c of ['allowed_tools_json', 'disallowed_tools_json', 'skills_json']) {
    v[c] = JSON.stringify(Array.isArray(v[c]) ? v[c] : jsonOu(v[c], []));
  }
  v.subagents_json = JSON.stringify(typeof v.subagents_json === 'object' && v.subagents_json
    ? v.subagents_json : jsonOu(v.subagents_json, {}));
  v.defaults_json = JSON.stringify(typeof v.defaults_json === 'object' && v.defaults_json
    ? v.defaults_json : jsonOu(v.defaults_json, {}));
  v.max_turns = Number(v.max_turns) > 0 ? Math.round(Number(v.max_turns)) : null;
  v.output_kind = ['report', 'note_page', 'agent'].includes(v.output_kind) ? v.output_kind : 'report';
  v.output_ref = v.output_ref ? String(v.output_ref) : null;
  v.knowledge_prompt = String(v.knowledge_prompt || '').trim() || null;
  v.schedule = String(v.schedule || '').trim() || null;
  v.runner = String(v.runner || '').trim() || null;
  return v;
}
function creer(body) {
  const v = valeursDe(body, {});
  const now = new Date().toISOString();
  /* LE SLUG EST FIGÉ ICI, une fois pour toutes : c'est lui qui nommera le dossier de l'agent
     dans le dépôt de données partagé (`agents/documentaliste/`). Renommer l'agent ensuite ne le
     déplace pas — sinon chaque renommage apparaîtrait chez les collègues comme une suppression
     suivie d'un ajout, et l'historique git du dossier serait perdu. */
  const slug = slugLibre(v.name, (x) => !!db.prepare('SELECT 1 FROM agent WHERE slug = ?').get(x));
  const cols = [...COLONNES, 'builtin_key', 'slug', 'created_at', 'updated_at'];
  /* Le périmètre est écrit DANS la même transaction : il vit dans le fichier de l'agent, et un
     fichier écrit sans lui décrirait un agent sans dépôts. */
  const cree = store.ecrire('agent', () => {
    const id = db.prepare(`INSERT INTO agent (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`)
      .run({ ...v, builtin_key: body.builtin_key || null, slug, created_at: now, updated_at: now }).lastInsertRowid;
    ecrireRepos(id, body.repos);
    return id;
  });
  /* Créé ICI — par l'écran, par une copie, par le semis des agents livrés : approuvé au passage.
     Ce qui arrive par la synchro ne passe pas par cette fonction, et attendra. */
  approbation.approuverAgent(cree.id);
  return lire(cree.id);
}
function modifier(id, patch) {
  const a = db.prepare('SELECT * FROM agent WHERE id = ?').get(Number(id) || 0);
  if (!a) return null;
  const v = valeursDe(patch, a);
  store.ecrire('agent', () => {
    db.prepare(`UPDATE agent SET ${COLONNES.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...v, id: a.id, updated_at: new Date().toISOString() });
    if (patch.repos !== undefined) ecrireRepos(a.id, patch.repos);
    return a.id;
  });
  /* Modifié dans le formulaire qui montre les permissions : c'est une approbation. */
  approbation.approuverAgent(a.id);
  return lire(a.id);
}
function supprimer(id) {
  const a = db.prepare('SELECT * FROM agent WHERE id = ?').get(Number(id) || 0);
  if (!a) return false;
  /* Les `task` gardent `agent_name` : la session reste lisible et la carte continue de dire
     qui l'a produite. C'est `ON DELETE SET NULL` sur `agent_id` qui s'en charge. */
  /* Les versions de connaissance partent en cascade SQL — mais leurs FICHIERS, eux, ne se
     suppriment pas tout seuls : on les retire AVANT l'agent, sans quoi le dépôt garderait des
     cartes que la base ne connaît plus, et l'hydratation suivante les ferait revenir. */
  for (const k of db.prepare('SELECT id FROM agent_knowledge WHERE agent_id = ?').all(a.id)) {
    store.supprimer('agent_knowledge', k.id);
  }
  store.supprimer('agent', a.id);
  // Pas de cascade sur le DISQUE : les versions de connaissance s'effacent explicitement.
  // eslint-disable-next-line global-require
  const { AGENTS_DIR } = require('../../core/paths');
  try { fs.rmSync(path.join(AGENTS_DIR, String(a.id)), { recursive: true, force: true }); } catch { /* best-effort */ }
  return true;
}
// Un nom libre à partir d'un nom pris : « X (copie) », « X (copie 2) »…
function nomLibre(base) {
  let n = base.slice(0, 110);
  if (!db.prepare('SELECT 1 FROM agent WHERE name = ?').get(n)) return n;
  for (let i = 2; i < 100; i += 1) {
    n = `${base.slice(0, 105)} (${i})`;
    if (!db.prepare('SELECT 1 FROM agent WHERE name = ?').get(n)) return n;
  }
  return `${base.slice(0, 100)} ${Date.now()}`;
}
function dupliquer(id) {
  const a = db.prepare('SELECT * FROM agent WHERE id = ?').get(Number(id) || 0);
  if (!a) return null;
  /* Une copie est un agent NEUF : ni `builtin_key` (sinon deux agents se disputeraient le
     bouton « Restaurer »), ni connaissance (elle est datée par SHA et appartient à l'original). */
  const copie = creer({
    ...a,
    name: nomLibre(`${a.name} ${t('agents.copy-suffix')}`),
    builtin_key: null,
    repos: repos(a.id),
  });
  return copie;
}
function exigerApprobation(agent) {
  if (!agent || !agent.id || approbation.agentApprouve(agent.id)) return;
  const e = new Error(t('agents.err.not-approved', { name: agent.name }));
  e.code = 'APPROBATION';
  e.status = 409;
  throw e;
}
/* ---------- Agents livrés ---------- */

function seedBuiltins() {
  const lang = (getConfig().language === 'en') ? 'en' : 'fr';
  for (const cle of agentdefaults.CLES) {
    if (db.prepare('SELECT 1 FROM agent WHERE builtin_key = ?').get(cle)) continue;
    const d = agentdefaults.ligneDefaut(cle, lang);
    if (!d) continue;
    /* Ne JAMAIS réécrire une ligne existante : le rôle a pu être affiné au fil des runs, et
       un semis au démarrage qui écrase est une perte silencieuse à chaque redémarrage. */
    creer({ ...d, name: nomLibre(d.name), builtin_key: cle, repos: [] });
  }
}
function restaurer(id) {
  const a = db.prepare('SELECT * FROM agent WHERE id = ?').get(Number(id) || 0);
  if (!a || !a.builtin_key) return null;
  const lang = (getConfig().language === 'en') ? 'en' : 'fr';
  const d = agentdefaults.ligneDefaut(a.builtin_key, lang);
  if (!d) return null;
  // Le nom aussi revient au défaut — sauf s'il est pris par un AUTRE agent.
  const pris = db.prepare('SELECT id FROM agent WHERE name = ?').get(d.name);
  return modifier(a.id, { ...d, name: (pris && pris.id !== a.id) ? a.name : d.name });
}

module.exports = {
  jsonOu, OUTILS_DEFAUT, repos, decorer, lister, lire, parCle, COLONNES, valider, brouillonValide, ecrireRepos, valeursDe, creer, modifier, supprimer, nomLibre, dupliquer, exigerApprobation, seedBuiltins, restaurer,
};
