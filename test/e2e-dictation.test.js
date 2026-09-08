'use strict';
/* La dictée vocale, de bout en bout (whisper.md §9.2).
 *
 * Chromium reçoit un FAUX micro alimenté par un fichier WAV, et le serveur tourne avec le
 * moteur SIMULÉ (`DICTATION_DRY_RUN=1`). La chaîne complète est donc réellement parcourue —
 * permission, capture, AudioWorklet, découpage aux silences, WAV 16 kHz, route, insertion —
 * sans modèle de 1,6 Go ni vrai micro sur le runner.
 *
 * CE QUE CHAQUE ÉPREUVE GARDE :
 *
 * — LA DURÉE MESURÉE. Le faux moteur ne rend pas une constante : il lit l'en-tête du WAV
 *   reçu et rend sa durée. Une réponse annonçant plus d'une seconde d'audio prouve que du
 *   son est vraiment passé, et pas qu'un bouton a changé de couleur.
 * — L'ÉVÉNEMENT `input`. Une affectation de `.value` aurait l'air de marcher à l'écran et
 *   contournerait l'autosave des brouillons de suivi. On le relit donc DEPUIS L'API, jamais
 *   depuis un libellé « Enregistré ».
 * — LA CIBLE RETROUVÉE PAR SÉLECTEUR. Les cartes de session se redessinent toutes les 1,5 s :
 *   le test force un rendu entre deux segments, et le texte doit continuer d'arriver.
 * — LE MICRO ABSENT QUAND LA DICTÉE EST ÉTEINTE. C'est le réglage qui est la porte d'entrée ;
 *   un micro sur chaque champ d'une installation qui ne transcrit pas est une promesse en l'air.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, attendreServeur, lancerNavigateur, navigateurDispo, ROOT } = require('./helpers/app');

const { dispo } = navigateurDispo();
const FIXTURE = path.join(ROOT, 'test/fixtures/dictation/phrase-fr.wav');
const ATTENTE = 20000;

/* UN SEUL `startApp()` pour tout le fichier (règle du projet) : le harnais lance le serveur
   EN PROCESSUS, et un second appel rendrait une instance déjà arrêtée, en attendant un
   événement `listening` qui ne viendrait jamais — le fichier expirerait au lieu d'échouer.
   Les deux familles d'épreuves partagent donc le même serveur et le même navigateur. */
let app;
let navigateur;
let page;
const erreurs = [];

describe('Dictée vocale · du micro au champ', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  before(async () => {
    // Le faux moteur : le serveur le voit par l'environnement, comme le dry-run de l'agent.
    process.env.DICTATION_DRY_RUN = '1';
    process.env.DICTATION_INSTALL_SCRIPT = path.join(ROOT, 'test/helpers/fake-install-whisper.sh');
    process.env.FAKE_INSTALL_SLEEP = '1';
    app = await startApp();
    await app.configure({ dictation_provider: 'local', dictation_silence_ms: '400' });

    navigateur = await lancerNavigateur({
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        // Le fichier BOUCLE (pas de `%noloop`) : plusieurs segments se succèdent, ce qu'il
        // faut pour éprouver ce qui arrive APRÈS le premier — le redessin d'une carte.
        `--use-file-for-fake-audio-capture=${FIXTURE}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    const ctx = await navigateur.newContext({ viewport: { width: 1400, height: 950 }, permissions: ['microphone'] });
    await ctx.grantPermissions(['microphone'], { origin: app.base });
    page = await ctx.newPage();
    page.on('pageerror', (e) => erreurs.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') erreurs.push(m.text()); });
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="task"]');
  });

  /* La modale de session porte une garde « saisie en cours » : on ne la laisse pas ouverte
     d'une épreuve à l'autre, sinon la suivante clique dans le vide (le voile intercepte).
     On arrête aussi la dictée en cours — c'est ce que fait l'utilisateur en partant. */
  const fermerModale = async () => {
    await page.evaluate(() => { if (window.mergerieDictation) window.mergerieDictation.arreter(); });
    if (await page.isVisible('#taskModal:not([hidden])').catch(() => false)) {
      await page.click('#taskCancel').catch(() => {});
      await page.waitForSelector('#taskModal[hidden]', { timeout: ATTENTE }).catch(() => {});
    }
  };

  const ouvrirModaleSession = async () => {
    await fermerModale();
    await page.click('nav button[data-tab="task"]');
    await page.click('#tab-task .subnav [data-kind="code"]');
    await page.click('#btnNewTask');
    await page.waitForSelector('#taskModal:not([hidden]) textarea[name="prompt"]');
  };

  test('le micro se pose sur le champ où l’on écrit, et pas ailleurs', async () => {
    await ouvrirModaleSession();
    await page.focus('#taskModal textarea[name="prompt"]');
    await page.waitForSelector('#dictationMic:not([hidden])', { timeout: ATTENTE });

    // Il suit le champ : posé à l'angle bas-droit de celui qui a le focus.
    const dedans = await page.evaluate(() => {
      const b = document.querySelector('#dictationMic').getBoundingClientRect();
      const c = document.querySelector('#taskModal textarea[name="prompt"]').getBoundingClientRect();
      return b.right <= c.right + 8 && b.bottom <= c.bottom + 8 && b.top >= c.top;
    });
    assert.ok(dedans, 'le micro est à l’angle du champ, pas au coin de l’écran');

    // Un champ de recherche n'est pas un champ de rédaction : le micro s'en va.
    await fermerModale();
    await page.click('nav button[data-tab="links"]');
    await page.focus('#linkSearch').catch(() => {});
    await page.waitForFunction(() => document.querySelector('#dictationMic').hidden, null, { timeout: ATTENTE });
  });

  test('on clique, on parle, et le texte scripté atterrit dans le champ — avec la durée de l’audio', async () => {
    await ouvrirModaleSession();
    const champ = '#taskModal textarea[name="prompt"]';
    await page.focus(champ);
    await page.waitForSelector('#dictationMic:not([hidden])');

    const reponse = page.waitForResponse((r) => r.url().includes('/api/dictation/transcribe') && r.status() === 200, { timeout: ATTENTE });
    await page.click('#dictationMic');
    const r = await reponse;
    const corps = await r.json();
    assert.ok(corps.duration_ms >= 1000, `l’audio a traversé la chaîne (${corps.duration_ms} ms mesurés sur le WAV reçu)`);
    assert.ok(corps.text, 'le moteur simulé rend une phrase');

    await page.waitForFunction((sel) => document.querySelector(sel).value.trim().length > 10, champ, { timeout: ATTENTE });
    const valeur = await page.inputValue(champ);
    assert.match(valeur, /health|!216|PROJ-1408/, 'la phrase du moteur simulé est bien celle qui s’écrit');
    await fermerModale();
  });

  test('le texte s’insère AU CURSEUR, au milieu de ce qui est déjà écrit', async () => {
    await ouvrirModaleSession();
    const champ = '#taskModal textarea[name="prompt"]';
    await page.fill(champ, 'DEBUT. FIN');
    // Le curseur juste après « DEBUT. »
    await page.evaluate((sel) => { const el = document.querySelector(sel); el.focus(); el.setSelectionRange(7, 7); }, champ);
    await page.waitForSelector('#dictationMic:not([hidden])');
    await page.click('#dictationMic');
    await page.waitForFunction((sel) => document.querySelector(sel).value.length > 20, champ, { timeout: ATTENTE });
    const v = await page.inputValue(champ);
    await page.evaluate(() => window.mergerieDictation.arreter());
    assert.ok(v.startsWith('DEBUT.'), 'ce qui précédait est intact');
    assert.ok(v.trimEnd().endsWith('FIN'), 'ce qui suivait est intact — on a écrit au milieu, pas à la fin');
    assert.ok(v.length > 'DEBUT. FIN'.length + 10, 'et quelque chose a bien été inséré entre les deux');
    await fermerModale();
  });

  /* Une session créée par l'API n'existe pas dans une page déjà ouverte : on recharge, puis
     on déplie son formulaire de suivi. C'est le champ le plus exigeant de l'application —
     il vit dans une carte que le rendu périodique jette et refait. */
  const ouvrirSuiviLocal = async (id) => {
    /* Le formulaire de suivi n'apparaît que sur une session qui a DÉJÀ tourné : on pose donc
       l'état qu'un vrai passage aurait laissé, plutôt que de dévoiler le formulaire à la
       main — c'est la carte réelle qu'on veut éprouver, pas un fragment de gabarit. */
    app.db.prepare("UPDATE local_task_dir SET status = 'done', updated_at = ? WHERE task_id = ?").run(new Date().toISOString(), id);
    app.db.prepare("UPDATE local_task SET status = 'done', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    await fermerModale();
    await page.reload();
    await page.waitForSelector('nav button[data-tab="task"]');
    await page.click('nav button[data-tab="task"]');
    await page.click('#tab-task .subnav [data-kind="local"]');
    await page.waitForSelector(`#localList [data-lfollow="${id}"]`, { timeout: ATTENTE });
    await page.click(`#localList [data-lfollow="${id}"]`);
    const champ = `#localList .followup[data-lfollowform="${id}"] .followup-text`;
    await page.waitForSelector(champ);
    return champ;
  };

  test('l’événement `input` part vraiment : le brouillon de suivi se relit DEPUIS L’API', async () => {
    const dir = fs.mkdtempSync(path.join(app.dataDir, 'sess-'));
    const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'Une passe', dirs: [dir] })).body;
    const champ = await ouvrirSuiviLocal(lt.id);
    await page.focus(champ);
    await page.waitForSelector('#dictationMic:not([hidden])');
    await page.click('#dictationMic');
    await page.waitForFunction((sel) => { const el = document.querySelector(sel); return !!el && el.value.trim().length > 10; }, champ, { timeout: ATTENTE });
    await page.evaluate(() => window.mergerieDictation.arreter());

    // Enregistrer puis RELIRE DEPUIS LE SERVEUR : le libellé « Enregistré » ne prouve rien.
    await page.click(`#localList .followup[data-lfollowform="${lt.id}"] [data-lfollowsave="${lt.id}"]`);
    await attendreServeur(async () => {
      const l = (await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === lt.id);
      return !!(l && l.followup_draft && l.followup_draft.length > 10);
    }, 'le brouillon dicté est arrivé en base');
  });

  test('la carte se redessine pendant la dictée : le texte continue d’arriver dans le NOUVEAU champ', async () => {
    const dir = fs.mkdtempSync(path.join(app.dataDir, 'sess2-'));
    const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'Deuxième', dirs: [dir] })).body;
    const champ = await ouvrirSuiviLocal(lt.id);
    await page.focus(champ);
    await page.waitForSelector('#dictationMic:not([hidden])');
    await page.click('#dictationMic');
    await page.waitForFunction((sel) => { const el = document.querySelector(sel); return !!el && el.value.trim().length > 5; }, champ, { timeout: ATTENTE });

    // On JETTE le textarea et on le refait, exactement comme le rendu périodique des cartes.
    const avant = await page.inputValue(champ);
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const neuf = el.cloneNode(false);
      neuf.value = el.value;
      el.replaceWith(neuf);
    }, champ);
    /* Un segment de PLUS doit atterrir dans le remplaçant. C'est le seul moyen de prouver que
       la cible est re-résolue à chaque insertion : avec une référence gardée, le texte serait
       parti dans l'élément détaché et l'écran n'aurait plus jamais bougé. */
    await page.waitForFunction((args) => {
      const el = document.querySelector(args.sel);
      return !!el && el.value.length > args.n;
    }, { sel: champ, n: avant.length }, { timeout: ATTENTE });
    await page.evaluate(() => window.mergerieDictation.arreter());
    const apres = await page.inputValue(champ);
    assert.ok(apres.length > avant.length, 'le texte n’est pas parti dans l’élément détaché');
    assert.ok(apres.startsWith(avant), 'et il s’est ajouté à ce qui était déjà là');
  });

  test('Échap arrête la dictée, et le raccourci la relance', async () => {
    await ouvrirModaleSession();
    const champ = '#taskModal textarea[name="prompt"]';
    await page.fill(champ, '');
    await page.focus(champ);
    await page.waitForSelector('#dictationMic:not([hidden])');
    await page.keyboard.press('Control+Shift+Space');
    await page.waitForFunction(() => ['listening', 'warming', 'transcribing'].includes(document.querySelector('#dictationMic').dataset.etat), null, { timeout: ATTENTE });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => ['ready', 'final'].includes(document.querySelector('#dictationMic').dataset.etat), null, { timeout: ATTENTE });
    await fermerModale();
  });

  test('le raccourci est écrit dans la modale « ? » — sinon il n’existe pour personne', async () => {
    await fermerModale();
    await page.click('nav button[data-tab="review"]');
    await page.keyboard.press('?');
    await page.waitForSelector('#shortcutsModal:not([hidden])', { timeout: ATTENTE });
    const txt = await page.textContent('#shortcutsList');
    assert.match(txt, /Maj \+ Espace|Shift \+ Space/i);
    await page.click('#shortcutsClose');
  });

  test('dictée éteinte : plus un seul micro à l’écran', async () => {
    await app.api('PUT', '/api/config', { dictation_provider: 'off' });
    await page.evaluate(() => window.mergerieDictation.relireStatut());
    await ouvrirModaleSession();
    await page.focus('#taskModal textarea[name="prompt"]');
    await page.waitForFunction(() => document.querySelector('#dictationMic').hidden, null, { timeout: ATTENTE });
    await fermerModale();
    await app.api('PUT', '/api/config', { dictation_provider: 'local' });
    await page.evaluate(() => window.mergerieDictation.relireStatut());
  });

  /* LA LANGUE DE L'ÉCRAN DÉCIDE DE CELLE QU'ON DICTE. Elle vit dans le navigateur et voyage
     par en-tête ; le serveur la FORCE au moteur. Sans l'en-tête, l'écran passait en anglais et
     l'on continuait de dicter en français — le moteur, obéissant, rendait du français. */
  test('l’écran en anglais fait dicter en anglais', async () => {
    await fermerModale();
    await page.evaluate(() => localStorage.setItem('aidevtools_lang', 'en'));
    await page.reload();
    await page.waitForSelector('nav button[data-tab="task"]');
    await ouvrirModaleSession();
    const champ = '#taskModal textarea[name="prompt"]';
    await page.focus(champ);
    await page.waitForSelector('#dictationMic:not([hidden])');
    const reponse = page.waitForResponse((r) => r.url().includes('/api/dictation/transcribe') && r.status() === 200, { timeout: ATTENTE });
    await page.click('#dictationMic');
    const corps = await (await reponse).json();
    assert.equal(corps.language, 'en', 'la langue forcée au moteur suit l’écran');
    await fermerModale();
    await page.evaluate(() => localStorage.setItem('aidevtools_lang', 'fr'));
    await page.reload();
    await page.waitForSelector('nav button[data-tab="task"]');
  });

  /* UNE PHRASE DANS L'AUTRE LANGUE ne vaut pas d'aller changer un réglage : ⇧-clic sur le
     micro dicte dans l'autre langue, le temps de cette dictée-là, et la bulle le DIT — sans
     quoi un ⇧-clic distrait produirait du texte dans la mauvaise langue en silence. */
  test('⇧-clic sur le micro dicte dans l’autre langue, et l’annonce', async () => {
    await ouvrirModaleSession();
    const champ = '#taskModal textarea[name="prompt"]';
    await page.focus(champ);
    await page.waitForSelector('#dictationMic:not([hidden])');
    const reponse = page.waitForResponse((r) => r.url().includes('/api/dictation/transcribe') && r.status() === 200, { timeout: ATTENTE });
    await page.click('#dictationMic', { modifiers: ['Shift'] });
    await page.waitForFunction(() => /EN/.test(document.querySelector('#dictationHint').textContent), null, { timeout: ATTENTE });
    const corps = await (await reponse).json();
    assert.equal(corps.language, 'en', 'l’écran est en français, ce segment part en anglais');
    await fermerModale();
    // …et la dictée suivante retrouve la langue de l'écran : la surcharge ne dure qu'une fois.
    await ouvrirModaleSession();
    await page.focus(champ);
    const suivante = page.waitForResponse((r) => r.url().includes('/api/dictation/transcribe') && r.status() === 200, { timeout: ATTENTE });
    await page.click('#dictationMic');
    assert.equal((await (await suivante).json()).language, 'fr');
    await fermerModale();
  });

  /* ÉTEINDRE LA DICTÉE PENDANT QU'ON DICTE. Le serveur refuse alors le segment suivant en 409 :
     c'est un refus DÉFINITIF — le réessayer ne changerait rien —, donc le micro s'arrête et le
     dit, au lieu de continuer à écouter un moteur qui n'écrit plus. */
  test('la dictée coupée sous les pieds s’arrête et le dit, au lieu d’écouter dans le vide', async () => {
    await ouvrirModaleSession();
    await page.focus('#taskModal textarea[name="prompt"]');
    await page.waitForSelector('#dictationMic:not([hidden])');
    await page.click('#dictationMic');
    await page.waitForFunction(() => document.querySelector('#dictationMic').dataset.etat === 'listening', null, { timeout: ATTENTE });
    await app.api('PUT', '/api/config', { dictation_provider: 'off' });
    await page.waitForFunction(() => document.querySelector('#dictationMic').dataset.etat === 'error', null, { timeout: ATTENTE });
    await app.api('PUT', '/api/config', { dictation_provider: 'local' });
    await page.evaluate(() => window.mergerieDictation.relireStatut());
    await fermerModale();
    /* LE 409 EST PROVOQUÉ PAR CETTE ÉPREUVE. Le navigateur le journalise comme une erreur de
       ressource — ce n'est pas une erreur JavaScript, et c'est exactement le refus qu'on
       venait vérifier. On le retire NOMMÉMENT plutôt que d'apprendre au collecteur à ignorer
       les erreurs réseau : il attraperait alors les vraies. */
    for (let i = erreurs.length - 1; i >= 0; i -= 1) if (/409/.test(erreurs[i])) erreurs.splice(i, 1);
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});

describe('Dictée vocale · les réglages, « Tester » et « Installer »', { skip: dispo ? false : 'chromium absent' }, () => {
  before(async () => {
    await page.evaluate(() => {
      if (window.mergerieDictation) window.mergerieDictation.arreter();
      document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; });
    });
    await page.click('nav button[data-tab="admin"]');
    await page.click('#tab-admin .subnav [data-sub="dictation"]');
    await page.waitForSelector('#sub-dictation.active');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
    delete process.env.DICTATION_DRY_RUN;
    delete process.env.DICTATION_INSTALL_SCRIPT;
    delete process.env.FAKE_INSTALL_SLEEP;
  });

  test('les treize réglages font l’aller-retour PAR L’API, et la clé ne redescend jamais', async () => {
    await page.selectOption('#sub-dictation [name="dictation_provider"]', 'openai');
    await page.fill('#sub-dictation [name="dictation_url"]', 'https://voxtral.demo.invalid/');
    await page.fill('#sub-dictation [name="dictation_api_key"]', 'sk-secret-a-ne-pas-rendre');
    await page.fill('#sub-dictation [name="dictation_remote_model"]', 'voxtral-mini');
    await page.selectOption('#sub-dictation [name="dictation_language"]', 'en');
    await page.fill('#sub-dictation [name="dictation_vocabulary"]', 'Zorglub');
    await page.fill('#sub-dictation [name="dictation_replacements"]', 'Jean-Kim => Jenkins');
    await page.fill('#sub-dictation [name="dictation_silence_ms"]', '900');
    await page.fill('#sub-dictation [name="dictation_idle_minutes"]', '5');
    await page.uncheck('#sub-dictation [name="dictation_final_pass"]');
    await page.click('#sub-dictation button[type="submit"][form="configForm"]');

    await attendreServeur(async () => {
      const c = (await app.api('GET', '/api/config')).body;
      return c.dictation_provider === 'openai' && c.dictation_vocabulary === 'Zorglub'
        && c.dictation_silence_ms === 900 && c.dictation_final_pass === '0';
    }, 'les réglages de dictée sont en base');

    const c = (await app.api('GET', '/api/config')).body;
    assert.equal(c.dictation_url, 'https://voxtral.demo.invalid', 'le slash final est absorbé');
    assert.equal(c.dictation_remote_model, 'voxtral-mini');
    assert.equal(c.dictation_language, 'en');
    assert.equal(c.dictation_replacements, 'Jean-Kim => Jenkins');
    assert.equal(c.dictation_idle_minutes, 5);
    assert.equal(c.dictation_api_key, '***', 'la clé ne redescend jamais au front');
  });

  test('choisir « navigateur » déplie l’avertissement — et lui seul', async () => {
    await page.selectOption('#sub-dictation [name="dictation_provider"]', 'browser');
    await page.waitForSelector('#dictationBrowserWarn:not([hidden])');
    const txt = await page.textContent('#dictationBrowserWarn');
    assert.match(txt, /Google|Apple/, 'on dit où part l’audio, en toutes lettres');
    await page.selectOption('#sub-dictation [name="dictation_provider"]', 'local');
    await page.waitForFunction(() => document.querySelector('#dictationBrowserWarn').hidden);
    // Les champs du fournisseur distant n'ont plus rien à demander.
    await page.waitForFunction(() => [...document.querySelectorAll('#sub-dictation .dictation-remote')].every((e) => e.hidden));
  });

  test('« Tester » déroule la chaîne et rend un verdict, moteur simulé compris', async () => {
    await page.click('#sub-dictation button[type="submit"][form="configForm"]');
    await attendreServeur(async () => (await app.api('GET', '/api/config')).body.dictation_provider === 'local', 'le fournisseur local est enregistré');
    await page.click('#dictationTest');
    await page.waitForSelector('#dictationVerdict:not([hidden])', { timeout: ATTENTE });
    // Les étapes navigateur arrivent après (elles écoutent le micro deux secondes).
    await page.waitForFunction(() => document.querySelectorAll('#dictationSteps .dict-step').length >= 8, null, { timeout: ATTENTE });
    const lignes = await page.$$eval('#dictationSteps .dict-step', (els) => els.map((e) => e.className));
    assert.ok(lignes.some((c) => c.includes('dict-ok')), 'au moins une marche est franchie');
    const verdict = await page.textContent('#dictationVerdict');
    assert.ok(verdict.trim().length > 3);
  });

  test('« Installer » demande d’abord ce qui va se passer, puis montre le journal en direct', async () => {
    await page.click('#dictationInstall');
    await page.waitForSelector('#dictInstallModal:not([hidden])');
    const confirme = await page.textContent('#dictInstallConfirm');
    assert.ok(confirme.trim().length > 20, 'la confirmation NOMME ce qui va se passer');
    await page.selectOption('#dictInstallModel', 'large-v3-turbo');
    await page.click('#dictInstallGo');
    await page.waitForSelector('#dictationLog:not([hidden])');
    await page.waitForFunction(() => /whisper|Moteur/.test(document.querySelector('#dictationLog').textContent), null, { timeout: ATTENTE });

    // À la fin, le script a rempli les réglages, et on les relit DEPUIS L'API.
    await attendreServeur(async () => {
      const c = (await app.api('GET', '/api/config')).body;
      return /ggml-large-v3-turbo\.bin$/.test(c.dictation_model || '');
    }, 'l’installation a écrit le chemin du modèle dans les réglages', 30000);
    const c = (await app.api('GET', '/api/config')).body;
    assert.match(c.dictation_command, /whisper-server$/, 'hors PATH : le chemin du binaire est écrit');
    assert.match(c.dictation_vad_model, /silero/, 'et celui du modèle de détection de voix');

    // Le champ à l'écran suit : loadConfig a été rappelé.
    await page.waitForFunction(() => /ggml-large-v3-turbo/.test(document.querySelector('#sub-dictation [name="dictation_model"]').value), null, { timeout: ATTENTE });
    // Et le libellé du bouton a changé : on n'« installe » plus ce qui est là.
    await page.waitForFunction(() => /nstall|Réinstall/i.test(document.querySelector('#dictationInstallLabel').textContent), null, { timeout: ATTENTE });
  });

  test('un modèle hors liste est refusé par le serveur, quoi que dise le client', async () => {
    const r = await app.api('POST', '/api/dictation/install', { model: 'large-v3; rm -rf /', vad: true });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /mod[èe]le/i);
  });

  test('« Stop » pendant l’installation donne un job ARRÊTÉ, pas un job en erreur', async () => {
    process.env.FAKE_INSTALL_SLEEP = '20';
    const job = (await app.api('POST', '/api/dictation/install', { model: 'large-v3', vad: false })).body;
    await attendreServeur(async () => {
      const d = (await app.api('GET', `/api/jobs/${job.id}/log`)).body;
      return d && d.status === 'running';
    }, 'l’installation tourne');
    const stop = await app.api('POST', `/api/jobs/${job.id}/stop`);
    // Un job qui a fini avant qu'on le stoppe répond légitimement 409 : les deux issues sont
    // acceptables, l'invariant est qu'il ne finit PAS en « error ».
    assert.ok([200, 409].includes(stop.status), `stop → ${stop.status}`);
    await attendreServeur(async () => {
      const d = (await app.api('GET', `/api/jobs/${job.id}/log`)).body;
      return d && !['running', 'queued'].includes(d.status);
    }, 'le job est terminé', 30000);
    const fin = (await app.api('GET', `/api/jobs/${job.id}/log`)).body;
    assert.ok(['stopped', 'done'].includes(fin.status), `un arrêt demandé n’est pas un échec (statut : ${fin.status})`);
    process.env.FAKE_INSTALL_SLEEP = '1';
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
