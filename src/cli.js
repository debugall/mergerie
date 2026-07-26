'use strict';
// Smoke test du pipeline en dry-run, sans GitLab ni copilot.
// Crée un dépôt git synthétique local (main + branche PROJ-...), puis exécute
// le pipeline reviewMr : clone/fetch -> diff ciblé -> copilot(dry-run) -> md + BDD.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const db = require('./db');
const { updateConfig } = require('./config');
const { reviewMr } = require('./reviewer');
const { DATA_DIR } = require('./paths');

process.env.COPILOT_DRY_RUN = '1';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function buildSyntheticRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-src-'));
  git(base, 'init', '-q', '-b', 'main');
  git(base, 'config', 'user.email', 'test@example.com');
  git(base, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(base, 'app.js'), 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n');
  git(base, 'add', '.');
  git(base, 'commit', '-q', '-m', 'init');
  // branche de feature
  git(base, 'checkout', '-q', '-b', 'PROJ-42-feature');
  fs.writeFileSync(path.join(base, 'app.js'),
    'function add(a, b) {\n  return a + b;\n}\nfunction sub(a, b) {\n  return a - b;\n}\nmodule.exports = { add, sub };\n');
  fs.writeFileSync(path.join(base, 'README.md'), '# Demo\nAjout de sub().\n');
  git(base, 'add', '.');
  git(base, 'commit', '-q', '-m', 'PROJ-42: add sub()');
  git(base, 'checkout', '-q', 'main');
  const sha = git(base, 'rev-parse', 'PROJ-42-feature').trim();
  return { base, sha };
}

async function main() {
  console.log('== Smoke test pipeline (dry-run) ==');
  const { base, sha } = buildSyntheticRepo();
  console.log('dépôt synthétique :', base);

  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-clones-'));
  updateConfig({ clone_path: cloneDir, gitlab_url: 'https://example.invalid', access_token: 'x' });

  // repo + MR en BDD
  db.prepare('DELETE FROM mr'); // repart propre pour le test
  const rInfo = db.prepare(`INSERT INTO repo (project, url, branch_pattern, enabled, created_at)
    VALUES (?, ?, 'PROJ-', 1, ?)`).run('demo/app', base, new Date().toISOString());
  const repoId = rInfo.lastInsertRowid;
  const mInfo = db.prepare(`INSERT INTO mr
    (repo_id, iid, title, source_branch, target_branch, web_url, current_sha, status, updated_at)
    VALUES (?, 42, 'Ajout de sub()', 'PROJ-42-feature', 'main', 'https://example.invalid/mr/42', ?, 'to_review', ?)`)
    .run(repoId, sha, new Date().toISOString());
  const mrId = mInfo.lastInsertRowid;

  const repo = { id: repoId, project: 'demo/app', url: base, branch_pattern: 'PROJ-' };
  const mr = db.prepare('SELECT * FROM mr WHERE id = ?').get(mrId);

  const out = await reviewMr(repo, mr, (m) => console.log('  ·', m));

  console.log('\n--- review.md ---');
  console.log(fs.readFileSync(out.mdPath, 'utf8'));
  console.log('\n--- explanation.md ---');
  console.log(fs.readFileSync(out.explPath, 'utf8'));

  const after = db.prepare('SELECT status, reviewed_sha, current_sha FROM mr WHERE id = ?').get(mrId);
  console.log('\nÉtat MR :', after);
  if (after.status !== 'reviewed' || after.reviewed_sha !== after.current_sha) {
    console.error('❌ statut/sha incorrects');
    process.exit(1);
  }
  console.log('\n✅ Pipeline OK (BDD:', path.relative(process.cwd(), path.join(DATA_DIR, 'reviewer.db')) + ')');
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
