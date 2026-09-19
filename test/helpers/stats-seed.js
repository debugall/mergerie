'use strict';
/* JEU DE DONNÉES DU MENU « STATISTIQUES », posé directement en base.
 *
 * L'écran agrège une douzaine de tables — reviews et leurs passes, dépenses de tokens,
 * sessions, vérifications, constats, opérations Git — dont la plupart ne se remplissent qu'au
 * bout de vrais appels d'agent. Les produire par l'API demanderait des minutes de jobs pour un
 * écran qui ne fait que LIRE : on écrit donc les lignes elles-mêmes, avec des valeurs choisies
 * pour que chaque chiffre affiché se calcule de tête (médianes, moyennes, taux sans arrondi
 * ambigu).
 *
 * Ce module ne charge RIEN de `src/` : il reçoit la base (`app.db`) que le harnais a ouverte
 * APRÈS avoir posé MERGERIE_DATA_DIR.
 */

const fs = require('node:fs');
const path = require('node:path');

const H = 3600000;
const J = 24 * H;
const ilYa = (ms) => new Date(Date.now() - ms).toISOString();

/* Deux dépôts suivis, déclarés par l'API (ils doivent exister pour le combo et pour la forge),
   avec un dernier commit chez le faux GitLab. */
async function creerDepots(app, projets = ['grp/alpha', 'grp/beta']) {
  const ids = {};
  projets.forEach((p, i) => {
    app.state.commits[p] = [{
      id: `${p.replace(/\W/g, '')}0123456789abcdef`, short_id: `c0ffee${i}`,
      title: `dernier commit de ${p}`, author_name: `Auteur ${i + 1}`, author_email: `a${i}@example.com`,
      committed_date: ilYa((i + 1) * H), web_url: `https://gitlab.test/${p}/-/commit/c0ffee${i}`,
    }];
  });
  for (const p of projets) {
    const r = await app.api('POST', '/api/repos', { project: p, url: `https://gitlab.test/${p}.git` });
    if (r.status !== 200) throw new Error(`création du dépôt ${p} : ${r.status} ${r.text}`);
    ids[p] = r.body.id;
  }
  return ids;
}

function insererMr(db, repoId, iid, { titre, statut, cree = null, merge = null }) {
  return Number(db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, web_url, current_sha,
      reviewed_sha, status, updated_at, gitlab_created_at, merged_at, author)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(repoId, iid, titre, `feature/s-${iid}`, 'main',
    `https://gitlab.test/mr/${repoId}/${iid}`, `sha${repoId}${iid}`, statut === 'to_review' ? null : `sha${repoId}${iid}`,
    statut, new Date().toISOString(), cree, merge, 'Dev').lastInsertRowid);
}

function insererReview(db, dir, mrId, note) {
  const md = path.join(dir, `review-${mrId}.md`);
  fs.writeFileSync(md, `# Revue ${mrId}\n\nUn rapport sans note écrite dans le texte.\n`, 'utf8');
  db.prepare('INSERT INTO review (mr_id, md_path, created_at, updated_at, note_value) VALUES (?,?,?,?,?)')
    .run(mrId, md, ilYa(J), ilYa(J), note);
}

function insererPasse(db, mrId, version, { note, quand, resolus = null, persistants = null, disparus = null }) {
  db.prepare(`INSERT INTO review_version (mr_id, version, note_value, kind, created_at, n_resolved, n_persistent, n_disappeared)
    VALUES (?,?,?,?,?,?,?,?)`).run(mrId, version, note, 'review', quand, resolus, persistants, disparus);
}

function insererUsage(db, { kind, tokens, entree = 100, sortie = 10, owner = null, quand = ilYa(H) }) {
  db.prepare(`INSERT INTO usage (kind, prompt_chars, output_chars, tokens_est, created_at, owner_kind, owner_id)
    VALUES (?,?,?,?,?,?,?)`).run(kind, entree, sortie, tokens, quand, owner ? owner.kind : null, owner ? owner.id : null);
}

function insererTache(db, repoId, { prompt, label = null, kind = 'code', agent = null, quand = ilYa(J) }) {
  return Number(db.prepare(`INSERT INTO task (repo_id, prompt, branch, status, created_at, updated_at, finished_at,
      label, kind, agent_id, agent_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(repoId, prompt, `feature/t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    'done', quand, quand, quand, label, kind, agent ? agent.id : null, agent ? agent.name : null).lastInsertRowid);
}

function insererCible(db, taskId, repoId, { mrIid = null, merge = 0 } = {}) {
  db.prepare(`INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, mr_iid, mr_merged, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(taskId, repoId, 'feature/x', 'main', 'done', mrIid, merge, new Date().toISOString());
}

function insererVerif(db, repoId, verdict) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO verification (verifier_name, status, verdict, targets_json, created_at, started_at, finished_at)
    VALUES (?,?,?,?,?,?,?)`).run('tests unitaires', 'done', verdict, JSON.stringify([{ repo_id: repoId }]), now, now, now);
}

function insererGitOp(db, repoId, projet, action, statut, quand = new Date().toISOString()) {
  db.prepare(`INSERT INTO git_op (batch_id, created_at, action, repo_id, project, ref_name, status, error)
    VALUES (?,?,?,?,?,?,?,?)`).run(`lot-${Math.random().toString(36).slice(2, 9)}`, quand, action, repoId, projet,
    `ref-${Math.random().toString(36).slice(2, 7)}`, statut, statut === 'error' ? 'branche protégée' : null);
}

function insererConstat(db, mrId, titre, fichier) {
  db.prepare(`INSERT INTO finding (mr_id, version, fingerprint, file, line, severity, title, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(mrId, 1, `fp-${mrId}-${Math.random().toString(36).slice(2, 7)}`, fichier, 10,
    'major', titre, 'open', new Date().toISOString());
}

/* LE JEU COMPLET. Les valeurs attendues à l'écran sont rendues avec les identifiants : les
   tests comparent à ce qui a été posé, pas à des nombres recopiés.

   - Funnel : 2 à traiter, 3 reviewées, 1 traitée.
   - Notes (/10) : alpha !2 = 3,5 · alpha !3 = 7,5 · beta !1 = 9 · alpha !4 sans note → moyenne 6,7.
   - Par projet : alpha (moy. 5,5, pire 3,5, 1 en attente, résolution 3/4 = 75 %, tendance −3,5),
     beta (moy. 9, pire 9, 1 en attente, pas de tendance).
   - Délai de cycle : alpha !3 96 h (24 h + 72 h), beta !1 36 h (12 h + 24 h) → médianes
     66 h = 2,8 j · 18 h · 48 h = 2 j.
   - Tokens : 20 500 au total, 7 familles ; 8 000 de review pour 3 MR reviewées → 2 667 / MR. */
async function semerTout(app, { agent } = {}) {
  const db = app.db;
  const dir = fs.mkdtempSync(path.join(app.dataDir, 'stats-'));
  const repos = await creerDepots(app);
  const A = repos['grp/alpha'];
  const B = repos['grp/beta'];

  const mr = {
    a1: insererMr(db, A, 1, { titre: 'Alpha à relire', statut: 'to_review' }),
    a2: insererMr(db, A, 2, { titre: 'Alpha mal notée', statut: 'reviewed' }),
    a3: insererMr(db, A, 3, { titre: 'Alpha traitée', statut: 'done', cree: ilYa(5 * J), merge: ilYa(J) }),
    a4: insererMr(db, A, 4, { titre: 'Alpha sans note', statut: 'reviewed' }),
    b1: insererMr(db, B, 1, { titre: 'Beta bien notée', statut: 'reviewed', cree: ilYa(48 * H), merge: ilYa(12 * H) }),
    b2: insererMr(db, B, 2, { titre: 'Beta à relire', statut: 'to_review' }),
  };
  insererReview(db, dir, mr.a2, 0.35);
  insererReview(db, dir, mr.a3, 0.75);
  insererReview(db, dir, mr.a4, null);
  insererReview(db, dir, mr.b1, 0.9);

  // Les passes : alpha !2 passe de 9 (il y a 40 j) à 3,5 (il y a 2 j), 3 constats résolus sur 4.
  insererPasse(db, mr.a2, 1, { note: 0.9, quand: ilYa(40 * J) });
  insererPasse(db, mr.a2, 2, { note: 0.35, quand: ilYa(2 * J), resolus: 3, persistants: 1, disparus: 0 });
  insererPasse(db, mr.a3, 1, { note: 0.75, quand: ilYa(4 * J) });
  insererPasse(db, mr.b1, 1, { note: 0.9, quand: ilYa(36 * H) });

  // Les sessions, dont deux runs d'un agent.
  const t = {
    code: insererTache(db, A, { prompt: 'Refondre le module de paiement', label: 'Session chère' }),
    explore: insererTache(db, A, { prompt: 'Où est calculée la TVA ?', label: 'Exploration TVA', kind: 'explore' }),
    agent1: insererTache(db, B, { prompt: 'Documenter les routes', label: 'Doc 1', agent }),
    agent2: insererTache(db, B, { prompt: 'Documenter les modèles', label: 'Doc 2', agent }),
  };
  insererCible(db, t.code, A, { mrIid: 7, merge: 1 });
  insererCible(db, t.agent1, B, { mrIid: 8, merge: 0 });
  const local = Number(db.prepare(`INSERT INTO local_task (prompt, status, label, created_at, updated_at, finished_at)
    VALUES (?,?,?,?,?,?)`).run('Ranger le dossier des factures', 'done', 'Hors dépôt factures', ilYa(J), ilYa(J), ilYa(J)).lastInsertRowid);
  const question = Number(db.prepare(`INSERT INTO question (prompt, label, status, created_at, updated_at, finished_at)
    VALUES (?,?,?,?,?,?)`).run('Pourquoi ce cache ?', 'Question cache', 'done', ilYa(J), ilYa(J), ilYa(J)).lastInsertRowid);

  insererUsage(db, { kind: 'review', tokens: 6000, entree: 6000, sortie: 300, owner: { kind: 'mr', id: mr.a2 } });
  insererUsage(db, { kind: 'review', tokens: 2000, entree: 4000, sortie: 200, owner: { kind: 'mr', id: mr.b1 } });
  insererUsage(db, { kind: 'task', tokens: 5000, owner: { kind: 'task', id: t.code } });
  insererUsage(db, { kind: 'explore', tokens: 3000, owner: { kind: 'task', id: t.explore } });
  insererUsage(db, { kind: 'task', tokens: 1500, owner: { kind: 'local', id: local } });
  insererUsage(db, { kind: 'ask', tokens: 1000, owner: { kind: 'ask', id: question } });
  insererUsage(db, { kind: 'question', tokens: 500 });
  insererUsage(db, { kind: 'explain', tokens: 400 });
  insererUsage(db, { kind: 'modify', tokens: 300 });
  insererUsage(db, { kind: 'task', tokens: 500, owner: { kind: 'task', id: t.agent1 } });
  insererUsage(db, { kind: 'task', tokens: 300, owner: { kind: 'task', id: t.agent2 } });
  // Total : 6000+2000+5000+3000+1500+1000+500+400+300+500+300 = 20 500.

  db.prepare('INSERT INTO comment_log (mr_id, body, sent_at) VALUES (?,?,?)').run(mr.a2, 'Remarque 1', ilYa(J));
  db.prepare('INSERT INTO comment_log (mr_id, body, sent_at) VALUES (?,?,?)').run(mr.b1, 'Remarque 2', ilYa(J));

  // Vérifications : alpha 1 verte sur 3, beta 2 sur 2.
  insererVerif(db, A, 'verified_pass');
  insererVerif(db, A, 'verified_fail');
  insererVerif(db, A, 'verified_fail');
  insererVerif(db, B, 'verified_pass');
  insererVerif(db, B, 'verified_pass');

  // Git : 3 suppressions (1 échec), 2 créations de branche, 1 tag.
  for (const s of ['ok', 'ok', 'error']) insererGitOp(db, A, 'grp/alpha', 'delete_branch', s);
  insererGitOp(db, A, 'grp/alpha', 'new_branch', 'ok');
  insererGitOp(db, B, 'grp/beta', 'new_branch', 'ok');
  insererGitOp(db, A, 'grp/alpha', 'create_tag', 'ok');

  // Le même constat sur trois merge requests d'alpha (casse et point final différents).
  insererConstat(db, mr.a1, 'Le numéro de carte est loggé', 'src/checkout/pay.js');
  insererConstat(db, mr.a2, 'le numéro de carte est loggé.', 'src/checkout/card.js');
  insererConstat(db, mr.a3, 'Le numéro de carte est loggé', 'src/checkout/pay.js');

  return { repos, mr, t, local, question, dir };
}

module.exports = {
  H, J, ilYa, creerDepots, insererMr, insererReview, insererPasse, insererUsage, insererTache,
  insererCible, insererVerif, insererGitOp, insererConstat, semerTout,
};
