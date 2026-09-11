'use strict';
/* CE QUE LA MODALE DE SESSION EMPORTE : skills, sous-agents, et l'agent qui la porte.
 *
 * Retrouver le nom exact d'un skill se faisait au `ls` dans `~/.claude/skills/`, et deviner
 * ensuite si l'agent l'avait vraiment utilisé. La modale les liste, les fait cocher, et la
 * demande s'autocomplète au « / ». Trois choses doivent tenir ensemble et se cassent
 * séparément : la liste (avec son filtre, exigé par `check-front` 13), l'insertion (qui ne
 * doit JAMAIS écrire sans sélection explicite), et ce qui part au serveur.
 *
 * Un seul `startApp()` : les `describe` ci-dessous partagent l'app et le navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// AVANT `startApp` : le scan lit cette variable, et `paths.js` fige les siennes au chargement.
const faussHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-'));
process.env.MERGERIE_CLAUDE_HOME = faussHome;

// eslint-disable-next-line import/order
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

const { dispo } = navigateurDispo();
const ecrire = (p, texte) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, texte, 'utf8'); };

describe('Session : skills et sous-agents', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let repoId;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    const r = await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app', project: 'grp/app' });
    repoId = r.body.id;

    /* Un skill « de dépôt » suppose un clone. On le fabrique là où `cloneDirFor` ira le
       chercher, plutôt que de faire tourner une vraie session pour l'obtenir. */
    const cfg = (await app.api('GET', '/api/config')).body;
    const clone = path.join(cfg.clone_path, 'grp__app');
    ecrire(path.join(clone, '.claude/skills/revue-de-code/SKILL.md'),
      '---\nname: revue-de-code\ndescription: Relit un diff avec les conventions du dépôt.\n---\n');
    ecrire(path.join(clone, '.claude/skills/reserve/SKILL.md'),
      '---\nname: reserve\ndescription: Reserve au modele.\nuser-invocable: false\n---\n');
    ecrire(path.join(clone, '.claude/agents/chercheur.md'),
      '---\nname: chercheur\ndescription: Cherche dans UN depot.\n---\n');
    ecrire(path.join(faussHome, '.claude/skills/perso/SKILL.md'),
      '---\nname: perso\ndescription: Le mien.\n---\n');
    await app.api('POST', '/api/skills/rescan');

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
    try { fs.rmSync(faussHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const ouvrirCodage = async () => {
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="code"]').click();
    await page.locator('#btnNewTask').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    // La liste arrive d'un appel API : on attend qu'elle soit peuplée, pas qu'elle existe.
    await page.waitForFunction(() => document.querySelectorAll('#taskSkills [data-skill]').length > 0);
  };
  const fermer = async () => {
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal', { state: 'hidden' });
  };

  test('l’onglet Agents existe et porte son sous-onglet Skills', async () => {
    await page.locator('nav button[data-tab="agents"]').click();
    await page.waitForSelector('#tab-agents.active');
    await page.locator('#tab-agents .subnav [data-sub="skills"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#skillList .skill-row').length > 0);
    const noms = await page.$$eval('#skillList .skill-row strong', (els) => els.map((e) => e.textContent));
    for (const n of ['revue-de-code', 'reserve', 'chercheur', 'perso']) assert.ok(noms.includes(n), `${n} absent : ${noms}`);
  });

  test('le panneau Skills se filtre, et ne montre jamais un chemin absolu', async () => {
    await page.locator('#skillFilter').fill('perso');
    await page.waitForFunction(() => [...document.querySelectorAll('#skillList .skill-row')]
      .filter((e) => !e.hidden).length === 1);
    const visible = await page.$eval('#skillList .skill-row:not([hidden]) strong', (e) => e.textContent);
    assert.equal(visible, 'perso');
    const chemins = await page.$$eval('#skillList .skill-path', (els) => els.map((e) => e.textContent));
    for (const c of chemins) assert.ok(!c.startsWith('/'), `chemin absolu affiché : ${c}`);
    await page.locator('#skillFilter').fill('');
  });

  test('la modale de session liste skills et sous-agents, séparément', async () => {
    await ouvrirCodage();
    const skills = await page.$$eval('#taskSkills [data-skill]', (els) => els.map((e) => e.dataset.skill));
    const sous = await page.$$eval('#taskSubagents [data-skill]', (els) => els.map((e) => e.dataset.skill));
    assert.ok(skills.some((s) => s.endsWith('|revue-de-code')), skills.join(','));
    assert.ok(skills.some((s) => s.endsWith('|perso')), skills.join(','));
    assert.ok(sous.some((s) => s.endsWith('|chercheur')), sous.join(','));
    assert.ok(!skills.some((s) => s.endsWith('|chercheur')), 'un sous-agent ne doit pas être dans les skills');
  });

  test('le filtre MASQUE les lignes sans jamais décocher', async () => {
    // Filtrer en retirant du DOM ferait perdre un choix sans le dire.
    await page.locator('#taskSkills [data-skill$="|perso"]').check();
    await page.locator('#taskSkillFilter').fill('revue');
    await page.waitForFunction(() => {
      const l = document.querySelector('#taskSkills [data-skill$="|perso"]');
      return l && l.closest('label').hidden;
    });
    assert.equal(await page.locator('#taskSkills [data-skill$="|perso"]').isChecked(), true);
    await page.locator('#taskSkillFilter').fill('');
    await page.waitForFunction(() => !document.querySelector('#taskSkills [data-skill$="|perso"]').closest('label').hidden);
  });

  test('« / » propose les skills invocables, et Échap n’insère rien', async () => {
    const champ = page.locator('#taskPrompt');
    await champ.fill('Corrige le bug puis ');
    await champ.type('/re');
    await page.waitForSelector('.ac-menu:not([hidden])');
    const props = await page.$$eval('.ac-menu .combo-opt', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(props.some((p) => p.startsWith('/revue-de-code')), props.join(','));
    // `user-invocable: false` : le CLI refuserait le `/nom`, on ne le propose donc pas.
    assert.ok(!props.some((p) => p.startsWith('/reserve')), props.join(','));
    await page.keyboard.press('Escape');
    // `waitForSelector` attend la VISIBILITÉ par défaut : sur un élément qu'on veut voir
    // disparaître, c'est une attente qui n'aboutit jamais.
    await page.waitForFunction(() => document.querySelector('.ac-menu').hidden);
    assert.equal(await champ.inputValue(), 'Corrige le bug puis /re', 'Échap ne doit rien insérer');
    // …et la modale, elle, est restée ouverte : Échap n'a fermé que le menu.
    assert.equal(await page.locator('#taskModal').isVisible(), true);
  });

  test('Entrée insère le nom du skill dans la demande', async () => {
    const champ = page.locator('#taskPrompt');
    await champ.fill('Corrige le bug puis ');
    await champ.type('/revu');
    await page.waitForSelector('.ac-menu:not([hidden])');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#taskPrompt').value.includes('/revue-de-code '));
    assert.equal(await champ.inputValue(), 'Corrige le bug puis /revue-de-code ');
  });

  test('« @ » propose les sous-agents, pas les skills', async () => {
    const champ = page.locator('#taskPrompt');
    await champ.fill('Demande à ');
    await champ.type('@che');
    await page.waitForSelector('.ac-menu:not([hidden])');
    const props = await page.$$eval('.ac-menu .combo-opt', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(props.some((p) => p.startsWith('@chercheur')), props.join(','));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#taskPrompt').value.includes('chercheur'));
    assert.match(await champ.inputValue(), /@"chercheur \(agent\)" $/);
  });

  test('un « / » au milieu d’un chemin n’ouvre aucun menu', async () => {
    // Sinon écrire `src/app.js` ferait surgir un menu à chaque barre oblique.
    const champ = page.locator('#taskPrompt');
    await champ.fill('');
    await champ.type('Regarde src/re');
    await page.waitForFunction(() => {
      const m = document.querySelector('.ac-menu');
      return !m || m.hidden;
    });
  });

  test('les skills cochés ouvrent le prompt de la session créée', async () => {
    const champ = page.locator('#taskPrompt');
    await champ.fill('Ajoute un endpoint /health');
    await page.locator('#taskSkills [data-skill$="|revue-de-code"]').check();
    // Le test du filtre a laissé « perso » coché : on le retire pour que la ligne de tête
    // soit prévisible — et cela vérifie au passage que décocher se répercute bien.
    await page.locator('#taskSkills [data-skill$="|perso"]').uncheck();
    // Une branche est obligatoire en codage.
    await page.locator('#targetRows .target-row input.t-branch').first().fill('feature/skills');
    await page.locator('#taskSubmitOnly').click();
    await page.waitForSelector('#taskModal', { state: 'hidden' });
    const { body } = await app.api('GET', '/api/tasks');
    const t = (Array.isArray(body) ? body : body.tasks).find((x) => /health/.test(x.prompt));
    assert.ok(t, 'session introuvable');
    assert.match(t.prompt, /^\/revue-de-code/, t.prompt);
    assert.match(t.prompt, /Ajoute un endpoint \/health/);
  });

  test('un skill non invocable est NOMMÉ dans le prompt, jamais préfixé d’un /', async () => {
    const r = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Refais la revue',
      targets: [{ repo_id: repoId, branch: 'feature/reserve' }],
      skills: [{ name: 'reserve', source: 'repo', repo_id: repoId }],
    });
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.body.prompt.includes('/reserve'), r.body.prompt);
    assert.match(r.body.prompt, /reserve/);
  });

  /* ---------- Le combo Agent : présent partout, lu là où il a un sens ---------- */

  test('le combo Agent existe dans la modale de codage', async () => {
    await ouvrirCodage();
    assert.equal(await page.locator('#taskAgentRow').isVisible(), true);
    await fermer();
  });

  test('il est MASQUÉ hors dépôt et en question libre — et ignoré à la sauvegarde', async () => {
    // Un profil parle de dépôts ; sans dépôt, le proposer promettrait quelque chose de faux.
    for (const kind of ['local', 'ask']) {
      await page.locator('nav button[data-tab="task"]').click();
      await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
      await page.locator('#btnNewTask').click();
      await page.waitForSelector('#taskModal:not([hidden])');
      assert.equal(await page.locator('#taskAgentRow').isVisible(), false, kind);
      await fermer();
    }
    // …et le champ existe toujours dans le formulaire unique : il est simplement inerte.
    assert.equal(await page.locator('#taskAgentRow').count(), 1);
    const r = await app.api('POST', '/api/questions', { prompt: 'Une question libre', label: '' });
    assert.equal(r.status, 200, r.text);
  });

  test('choisir un agent l’applique, et il est relu à l’édition de la session', async () => {
    const enq = (await app.api('GET', '/api/agents')).body.find((a) => a.builtin_key === 'investigator');
    const cree = (await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'Où est ce code ?', targets: [{ repo_id: repoId }], agent_id: enq.id,
    })).body;
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="explore"]').click();
    await page.waitForFunction((id) => document.querySelector(`#taskList .task-row[data-task="${id}"]`), cree.id);
    await page.locator(`#taskList .task-row[data-task="${cree.id}"] [data-tedit]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => {
      const c = document.querySelector('#taskAgentBox [data-combo="taskAgentVal"]');
      return c && c.value.length > 0;
    });
    assert.match(await page.locator('#taskAgentBox [data-combo="taskAgentVal"]').inputValue(), /Enquêteur/);
    await fermer();
  });

  test('un agent supprimé laisse son nom lisible, et le combo devient inerte', async () => {
    const cree = (await app.api('POST', '/api/agents', { name: 'Passager', kind: 'explore' })).body;
    const t = (await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'Question du passager', targets: [{ repo_id: repoId }], agent_id: cree.id,
    })).body;
    await app.api('DELETE', `/api/agents/${cree.id}`);
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="explore"]').click();
    await page.waitForFunction((id) => document.querySelector(`#taskList .task-row[data-task="${id}"]`), t.id);
    await page.locator(`#taskList .task-row[data-task="${t.id}"] [data-tedit]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => {
      const c = document.querySelector('#taskAgentBox [data-combo="taskAgentVal"]');
      return c && c.value === 'Passager';
    });
    assert.equal(await page.locator('#taskAgentBox [data-combo="taskAgentVal"]').isDisabled(), true);
    await fermer();
  });

  test('l’autocomplétion vaut pour un champ de suivi CRÉÉ APRÈS le chargement', async () => {
    /* Les champs de suivi n'existent pas au chargement : ils naissent avec la carte, qui se
       redessine toutes les secondes et demie. Le câblage doit donc passer par la délégation —
       une référence gardée sur un textarea pointerait un élément déjà jeté. On fabrique ici un
       champ de suivi APRÈS coup, ce qui est exactement ce que fait le rendu d'une carte. */
    await page.evaluate(() => {
      const ta = document.createElement('textarea');
      ta.className = 'followup-text';
      ta.id = 'faux-suivi';
      document.body.appendChild(ta);
    });
    const champ = page.locator('#faux-suivi');
    await champ.click();
    await champ.type('Reprends avec /revu');
    await page.waitForSelector('.ac-menu:not([hidden])');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#faux-suivi').value.includes('/revue-de-code '));
    await page.evaluate(() => { document.querySelector('#faux-suivi').remove(); });
  });

  test('aucune erreur JavaScript pendant tout ce parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
