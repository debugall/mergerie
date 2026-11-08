'use strict';
/* EXPORTER LE REVIEWER EN SKILL — CE QUE L'ARCHIVE CONTIENT.
 *
 * Sur une base temporaire : le skill est UN fichier `SKILL.md`, au front matter valide, AUTONOME — il ne
 * nomme jamais l'application, ni dans son texte ni dans ses chemins — et porte le gabarit de review de la
 * configuration mot pour mot (le chemin du diff rempli, `{source}`/`{target}`/`{project}` laissés à
 * l'agent), les deux commandes git que l'agent lance lui-même (le diff `cible...HEAD` depuis l'ancêtre
 * commun, les messages de commit en guise d'intention), la cible en argument avec son défaut, les
 * consignes (numéros de ligne, note sur 10, sortie), les règles de review actives avec condition et portée
 * — et rien d'une règle désactivée —, l'explication quand le réglage l'active et pas sinon. L'archive zip
 * se relit entrée par entrée. */
const { test, before, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

/* Lit les entrées locales d'un zip (signature 0x04034b50) : nom, données dégonflées (méthode 8) ou brutes (0). */
function dezipper(buf) {
  const out = []; let o = 0;
  while (o + 30 <= buf.length && buf.readUInt32LE(o) === 0x04034b50) {
    const methode = buf.readUInt16LE(o + 8); const taille = buf.readUInt32LE(o + 18);
    const nomLen = buf.readUInt16LE(o + 26); const extraLen = buf.readUInt16LE(o + 28);
    const nom = buf.slice(o + 30, o + 30 + nomLen).toString('utf8');
    const data = buf.slice(o + 30 + nomLen + extraLen, o + 30 + nomLen + extraLen + taille);
    out.push({ nom, data: methode === 8 ? zlib.inflateRawSync(data) : data });
    o += 30 + nomLen + extraLen + taille;
  }
  return out;
}

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'));

describe('Exporter le reviewer en skill', () => {
  let db; let skill; let i18n; let prompts;
  const cfg = () => require('../src/data/config').getConfig();

  before(() => {
    db = require('../src/db');
    skill = require('../src/review/skill-export');
    i18n = require('../src/core/i18n');
    prompts = require('../src/core/prompts');
    i18n.setLang('fr');
  });

  test('SKILL.md : front matter, gabarit de la configuration mot pour mot, chemin du diff rempli, variables de branche à remplir, commandes git, consignes — et jamais le nom de l’application', () => {
    db.prepare("UPDATE config SET prompt_review = ?, review_explain = '1' WHERE id = 1").run('# Mon gabarit\nRelis {source} vers {target} dans {project}.\nDiff : {diff_file} ; titre : {title}\nÉcris dans {out_file}.');
    const md = skill.skillMd(cfg(), { lang: 'fr', maintenant: new Date('2026-11-08T10:00:00Z') });
    assert.match(md, /^---\nname: branch-review\ndescription: .+\n---\n/);
    assert.ok(md.includes('# Mon gabarit\nRelis {source} vers {target} dans {project}.'), 'le gabarit personnalisé, mot pour mot, branches et projet à remplir');
    assert.ok(md.includes('Diff : .branch-review/diff.patch ; titre : (voir « L’intention »'), 'le chemin du diff rempli, le titre de MR renvoyé à l’intention');
    assert.ok(md.includes('Écris dans .branch-review/<branche>/<branche>-<date>.md'), 'le rapport rangé par branche, daté');
    assert.ok(md.includes('AAAA-MM-JJ-HH-mm-ss') && md.includes('date +%Y-%m-%d-%H-%M-%S'), 'le format de la date');
    assert.ok(md.includes('supprime `.branch-review/diff.patch`'), 'le diff est effacé à la fin, le rapport reste');
    assert.ok(md.includes('.branch-review/<branche>/<branche>-<date>-explication.md'), 'l’explication à côté du rapport');
    assert.ok(md.includes('Exporté le 2026-11-08'));
    assert.ok(md.includes('`/branch-review [cible]`') && md.includes('$ARGUMENTS'), 'la cible en argument');
    assert.ok(md.includes('refs/remotes/origin/HEAD'), 'le défaut de la cible : la branche par défaut du dépôt');
    assert.ok(md.includes('git diff origin/<cible>...HEAD > .branch-review/diff.patch'), 'le diff depuis l’ancêtre commun, lancé par l’agent');
    assert.ok(md.includes("git log --no-merges --format='- %s%n%b' origin/<cible>..HEAD"), 'l’intention : les messages de commit');
    for (const s of ['NUMÉROS DE LIGNE', 'NOTE GLOBALE', 'SORTIE —', '.git/info/exclude']) assert.ok(md.includes(s), `consigne « ${s} »`);
    assert.ok(md.includes('## Étape 3') && md.includes('Explique de façon pédagogique'), 'l’explication, puisque le réglage l’active, avec le gabarit livré');
    assert.ok(!md.includes('## Ce que ce skill ne sait pas'), 'pas de section sur ce qui manque');
    assert.ok(!/mergerie/i.test(md), 'autonome : l’application n’est nommée nulle part');
    assert.ok(!md.includes('preparer.js') && !md.includes('scripts/'), 'aucun script');
    // Sans gabarit personnalisé : le défaut livré dans la langue configurée ; sans explication quand décochée.
    db.prepare("UPDATE config SET prompt_review = '', review_explain = '0' WHERE id = 1").run();
    const md2 = skill.skillMd(cfg(), { lang: 'fr' });
    assert.ok(md2.includes(prompts.PROMPTS.fr.prompt_review.split('\n')[0]), 'le gabarit par défaut');
    assert.ok(!md2.includes('## Étape 3'), 'pas d’explication quand le réglage est décoché');
    // En anglais : le squelette traduit, le gabarit (configuré en français) tel quel.
    i18n.setLang('en');
    const en = skill.skillMd(cfg(), { lang: 'en' });
    assert.ok(en.includes('## Step 1 — the diff') && en.includes('`/branch-review [target]`') && !/mergerie/i.test(en));
    i18n.setLang('fr');
  });

  test('les règles de review actives, avec leur condition et leur portée ; une règle désactivée n’y est pas', () => {
    const repoId = Number(db.prepare("INSERT INTO repo (project, url, enabled, forge) VALUES ('grp/paiement', 'https://gitlab.test/grp/paiement.git', 1, 'gitlab')").run().lastInsertRowid);
    const gid = Number(db.prepare("INSERT INTO repo_group (name, created_at) VALUES ('backend', '2026-01-01')").run().lastInsertRowid);
    db.prepare("INSERT INTO review_rule (branch_match, content, enabled, created_at) VALUES ('PAY-', 'Vérifier les arrondis monétaires.', 1, '2026-01-01')").run();
    db.prepare("INSERT INTO review_rule (branch_match, path_match, content, enabled, repo_id, created_at) VALUES ('', 'migrations/**', 'Une migration est réversible.', 1, ?, '2026-01-01')").run(repoId);
    db.prepare("INSERT INTO review_rule (branch_match, content, enabled, group_id, created_at) VALUES ('hotfix/', 'Un hotfix porte son test de non-régression.', 1, ?, '2026-01-01')").run(gid);
    db.prepare("INSERT INTO review_rule (branch_match, content, enabled, created_at) VALUES ('SECRET-', 'RÈGLE DÉSACTIVÉE', 0, '2026-01-01')").run();
    const md = skill.skillMd(cfg(), { lang: 'fr' });
    assert.ok(md.includes('- si la branche courante contient « PAY- » · tous les dépôts\n  Vérifier les arrondis monétaires.'));
    assert.ok(md.includes('- si un fichier du diff correspond à `migrations/**` · seulement le dépôt grp/paiement\n  Une migration est réversible.'));
    assert.ok(md.includes('- si la branche courante contient « hotfix/ » · seulement les dépôts du groupe « backend »'));
    assert.ok(!md.includes('RÈGLE DÉSACTIVÉE') && !md.includes('SECRET-'), 'une règle désactivée ne part pas');
    assert.equal(skill.regles().length, 3);
  });

  test('l’archive : un seul fichier, `branch-review/SKILL.md`, relu entrée par entrée identique au texte', () => {
    const out = skill.construire(cfg(), { lang: 'fr' });
    assert.equal(out.nom, 'branch-review.zip');
    assert.deepEqual(out.fichiers, ['branch-review/SKILL.md']);
    const entrees = dezipper(out.buffer);
    assert.deepEqual(entrees.map((e) => e.nom), ['branch-review/SKILL.md']);
    assert.equal(entrees[0].data.toString('utf8'), skill.skillMd(cfg(), { lang: 'fr' }), 'le même texte que le générateur');
    assert.ok(/^---\nname: branch-review\n/.test(entrees[0].data.toString('utf8')));
  });
});
