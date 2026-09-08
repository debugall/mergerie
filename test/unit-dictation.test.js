'use strict';
/* La dictée vocale, tout ce qui se prouve sans micro ni modèle (whisper.md §9.1).
 *
 * Trois choses que seule une épreuve unitaire peut couvrir dans tous leurs cas :
 *
 * — LE PROMPT DE VOCABULAIRE. C'est le levier de précision de toute la fonctionnalité, et sa
 *   troncature à 224 tokens est l'endroit où il se casse en silence : un glossaire évincé par
 *   la liste des branches, et le nom qu'on venait d'ajouter à la main n'arrive plus au moteur.
 * — LA NORMALISATION. `!214` et `PROJ-720` sont ce qui devient un lien dans les notes et une
 *   cible dans la palette ; les rater rend la dictée inutile pour son usage principal. Et
 *   l'espace insécable ne doit jamais entrer dans un bloc de code.
 * — CE QU'ON REFUSE. Un en-tête WAV qui ment n'atteint jamais le moteur, et une phrase
 *   fantôme (« Sous-titres réalisés par… ») n'atteint jamais le champ.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Isole la base : dictation.js charge db.js (donc paths.js) au require.
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-'));

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const RT = require('../public/dictation-runtime.js');
const dictation = require('../src/dictation');
const demo = require('../src/demo-dictation');
const db = require('../src/db');
const { updateConfig } = require('../src/config');
const i18n = require('../public/i18n-runtime.js');
const { countTokens } = require('../src/copilot');

const NBSP = ' ';

describe('Dictée · le prompt de vocabulaire', () => {
  before(() => {
    db.exec('DELETE FROM repo');
    db.prepare("INSERT INTO repo (project, url, branch_pattern, enabled, created_at) VALUES ('groupe/webapp-front', 'u1', 'PROJ-', 1, '2026-01-01')").run();
    db.prepare("INSERT INTO repo (project, url, branch_pattern, enabled, created_at) VALUES ('groupe/api-core', 'u2', 'OPS-', 1, '2026-01-01')").run();
    db.prepare("INSERT INTO repo (project, url, branch_pattern, enabled, created_at) VALUES ('groupe/vieux', 'u3', 'X-', 0, '2026-01-01')").run();
    db.exec('DELETE FROM service');
    db.prepare("INSERT INTO service (name, tags, pinned, created_at) VALUES ('facturation', '[]', 0, '2026-01-01')").run();
    db.exec('DELETE FROM environment');
    db.prepare("INSERT INTO environment (name, position, color, created_at) VALUES ('recette', 1, '#000', '2026-01-01')").run();
  });

  test('les dépôts, services et environnements arrivent au moteur, pas les dépôts éteints', () => {
    const { terms } = dictation.construirePrompt(null, 'fr');
    assert.ok(terms.includes('webapp-front'), 'le nom court du dépôt');
    assert.ok(terms.includes('api-core'));
    assert.ok(terms.includes('facturation'));
    assert.ok(terms.includes('recette'));
    assert.ok(terms.includes('PROJ'), 'le préfixe de clé Jira, déduit du motif de branche');
    assert.ok(!terms.includes('vieux'), 'un dépôt désactivé n’a pas à peupler le vocabulaire');
  });

  test('la phrase d’amorce est là, ponctuée, dans la langue demandée', () => {
    const fr = dictation.construirePrompt(null, 'fr');
    const en = dictation.construirePrompt(null, 'en');
    assert.match(fr.prompt, /Bonjour, voici la merge request !214/);
    assert.match(en.prompt, /Hello, here is merge request !214/);
    assert.notEqual(fr.sha, en.sha, 'deux langues, deux empreintes');
  });

  test('le glossaire passe EN PREMIER et n’est jamais évincé par la limite', () => {
    // Deux cents branches : de quoi remplir le budget à elles seules.
    const now = new Date().toISOString();
    db.exec('DELETE FROM mr');
    const ins = db.prepare("INSERT INTO mr (repo_id, iid, title, source_branch, status, updated_at) VALUES (1, ?, 't', ?, 'to_review', ?)");
    for (let i = 0; i < 200; i += 1) ins.run(i + 1, `feature/branche-tres-longue-numero-${i}`, now);
    updateConfig({ dictation_vocabulary: 'Zorglub\nMachinchose' });
    const { terms, prompt } = dictation.construirePrompt(null, 'fr');
    assert.equal(terms[0], 'Zorglub');
    assert.equal(terms[1], 'Machinchose');
    assert.ok(prompt.includes('Zorglub'));
    updateConfig({ dictation_vocabulary: '' });
    db.exec('DELETE FROM mr');
  });

  test('la troncature ne coupe jamais un terme en deux, et garde l’amorce entière', () => {
    updateConfig({ dictation_vocabulary: Array.from({ length: 400 }, (_, i) => `terme-interminable-numero-${i}`).join('\n') });
    const { terms, prompt } = dictation.construirePrompt(null, 'fr');
    for (const t of terms) assert.ok(prompt.includes(t), `« ${t} » doit être entier dans le prompt`);
    assert.ok(prompt.endsWith('npm test.'), 'la place de l’amorce est réservée');
    assert.ok(terms.length < 400, 'la limite a bien tronqué');
    updateConfig({ dictation_vocabulary: '' });
  });

  test('l’empreinte est stable à contenu égal', () => {
    assert.equal(dictation.construirePrompt(null, 'fr').sha, dictation.construirePrompt(null, 'fr').sha);
  });

  /* LE CONTEXTE GLISSANT NE MANGE PAS LE GLOSSAIRE. Whisper ne garde que les 224 DERNIERS
     tokens : ajouter les soixante derniers mots dictés APRÈS un prompt déjà plein ne rognait
     pas la queue mais la TÊTE — c'est-à-dire le glossaire de l'utilisateur, la priorité la
     plus haute de toute la fonctionnalité. Sa place est donc réservée d'avance. */
  test('prompt + contexte tiennent sous la limite du moteur, glossaire compris', () => {
    updateConfig({ dictation_vocabulary: Array.from({ length: 300 }, (_, i) => `terme-tres-long-numero-${i}`).join('\n') });
    const { prompt, terms } = dictation.construirePrompt(null, 'fr');
    const ctx = Array.from({ length: 200 }, (_, i) => `motdicteassezlong${i}`).join(' ');
    const complet = dictation.promptAvecContexte(prompt, ctx);
    assert.ok(countTokens(complet) <= dictation.MAX_PROMPT_TOKENS,
      `${countTokens(complet)} tokens envoyés pour un plafond de ${dictation.MAX_PROMPT_TOKENS}`);
    assert.equal(terms[0], 'terme-tres-long-numero-0', 'le glossaire reste en tête');
    assert.ok(complet.includes(terms[0]), 'et il est toujours dans ce qui part');
    updateConfig({ dictation_vocabulary: '' });
  });

  test('le contexte est rogné par le DÉBUT, pour garder les mots les plus récents', () => {
    const ctx = Array.from({ length: 200 }, (_, i) => `motdicteassezlong${i}`).join(' ');
    const garde = dictation.contexteGlissant(ctx);
    assert.ok(countTokens(garde) <= dictation.RESERVE_CONTEXTE);
    assert.ok(garde.endsWith('motdicteassezlong199'), 'le dernier mot dicté est celui qui compte le plus');
    assert.ok(!garde.includes('motdicteassezlong0 '), 'les plus anciens sont partis');
    assert.equal(dictation.contexteGlissant(''), '');
  });
});

describe('Dictée · normalisation', () => {
  const fr = (s, o) => RT.normaliserSegment(s, { language: 'fr', ...(o || {}) }).text;

  test('les formes parlées d’une merge request deviennent !214', () => {
    assert.equal(fr('regarde la merge request 214'), 'regarde la !214');
    assert.equal(fr('regarde la MR 214'), 'regarde la !214');
    assert.equal(fr('regarde la MR numéro 214'), 'regarde la !214');
    assert.equal(fr('look at pull request 9', { language: 'en' }), 'look at !9');
  });

  test('une clé Jira se reconstitue depuis ses formes parlées, pour les préfixes connus', () => {
    const o = { jiraPrefixes: ['PROJ'] };
    assert.equal(fr('bloqué par proj 720', o), 'bloqué par PROJ-720');
    assert.equal(fr('bloqué par proj tiret 720', o), 'bloqué par PROJ-720');
    assert.equal(fr('bloqué par PROJ-720', o), 'bloqué par PROJ-720');
    // Un préfixe INCONNU n'est pas inventé : on ne devine pas des clés qui n'existent pas.
    assert.equal(fr('bloqué par zork 720', o), 'bloqué par zork 720');
  });

  test('« issue 42 » devient #42 ; « ticket 42 » ne bouge pas', () => {
    assert.equal(fr('voir issue 42'), 'voir #42');
    assert.equal(fr('voir ticket 42'), 'voir ticket 42');
  });

  test('l’espace avant ? ! : ; est INSÉCABLE en français, absente en anglais', () => {
    assert.equal(fr('vraiment ?'), `vraiment${NBSP}?`);
    assert.equal(fr('vraiment?'), `vraiment${NBSP}?`);
    assert.equal(RT.normaliserSegment('really ?', { language: 'en' }).text, 'really?');
    assert.equal(fr('un mot , et un point .'), 'un mot, et un point.');
  });

  test('…mais jamais à l’intérieur d’un bloc de code', () => {
    const s = fr('voici ```a ? b : c``` et alors ?');
    assert.ok(s.includes('a ? b : c'), 'le code garde ses espaces ordinaires');
    assert.ok(s.endsWith(`alors${NBSP}?`), 'hors du bloc, l’insécable est posée');
  });

  test('les corrections s’appliquent au mot entier, sans tenir compte de la casse', () => {
    const r = RT.parserRemplacements('Jean-Kim => Jenkins\n  zoulou=>Zuul\nligne sans flèche');
    assert.deepEqual(r, [{ de: 'Jean-Kim', vers: 'Jenkins' }, { de: 'zoulou', vers: 'Zuul' }]);
    assert.equal(fr('relance jean-kim ce soir', { replacements: r }), 'relance Jenkins ce soir');
    // Mot ENTIER : « zoulouville » n'est pas « zoulou ».
    assert.equal(fr('la zoulouville', { replacements: r }), 'la zoulouville');
  });

  test('une commande vocale seule est une commande ; dans une phrase, c’est du texte', () => {
    assert.deepEqual(RT.normaliserSegment('nouvelle ligne', { language: 'fr' }), { text: '', command: 'newline' });
    assert.deepEqual(RT.normaliserSegment('Annule ça.', { language: 'fr' }), { text: '', command: 'scratch' });
    assert.deepEqual(RT.normaliserSegment('new paragraph', { language: 'en' }), { text: '', command: 'paragraph' });
    assert.equal(fr('annule ça tout de suite'), 'annule ça tout de suite');
    // Désactivables : un champ où l'on dicte « nouvelle ligne » littéralement.
    assert.equal(RT.normaliserSegment('nouvelle ligne', { language: 'fr', commands: false }).text, 'nouvelle ligne');
  });

  test('l’assemblage met la majuscule après un point, et une seule espace', () => {
    assert.equal(RT.assembler('Bonjour.', 'et voilà'), ' Et voilà');
    assert.equal(RT.assembler('Bonjour', 'et voilà'), ' et voilà');
    assert.equal(RT.assembler('', 'et voilà'), 'Et voilà');
    assert.equal(RT.assembler('Bonjour ', 'et voilà'), 'et voilà', 'pas de double espace');
    assert.equal(RT.assembler('Bonjour', ', encore'), ', encore', 'pas d’espace avant une virgule');
  });
});

describe('Dictée · anti-hallucination', () => {
  test('les phrases fantômes connues sont écartées, dans les deux langues', () => {
    for (const s of ['Sous-titres réalisés par la communauté d\'Amara.org', 'Thank you for watching!', 'Sous-titres']) {
      assert.equal(RT.filtrerHallucination(s).ok, false, s);
    }
    assert.equal(RT.filtrerHallucination('Sous-titre le graphe de dépendances').ok, true, 'une vraie phrase qui commence pareil passe');
  });

  test('un segment qui boucle est écarté', () => {
    assert.equal(RT.filtrerHallucination('et donc voilà et donc voilà et donc voilà et donc voilà').ok, false);
    assert.equal(RT.filtrerHallucination('il faut corriger le délai puis relancer la suite de tests').ok, true);
  });

  test('un segment identique au précédent est écarté', () => {
    assert.equal(RT.filtrerHallucination('merci', { precedent: 'Merci' }).ok, false);
    assert.equal(RT.filtrerHallucination('merci', { precedent: 'bonjour' }).ok, true);
  });

  test('le compteur du serveur monte, et se remet à zéro', () => {
    dictation.resetRejets();
    dictation.filtrerHallucination('amara.org');
    dictation.filtrerHallucination('');           // vide : ce n'est pas un rejet, c'est rien
    assert.equal(dictation.compteRejets(), 1);
    dictation.resetRejets();
    assert.equal(dictation.compteRejets(), 0);
  });
});

describe('Dictée · validation du WAV', () => {
  const entete = ({ format = 1, canaux = 1, taux = 16000, bits = 16, data = 32000 } = {}) => {
    const b = Buffer.alloc(44 + data);
    b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8, 'latin1');
    b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(format, 20); b.writeUInt16LE(canaux, 22);
    b.writeUInt32LE(taux, 24); b.writeUInt32LE(taux * 2, 28);
    b.writeUInt16LE(2, 32); b.writeUInt16LE(bits, 34);
    b.write('data', 36, 'latin1'); b.writeUInt32LE(data, 40);
    return b;
  };

  test('un WAV 16 kHz mono 16 bits passe, et sa durée est mesurée', () => {
    const r = dictation.validerWav(entete({ data: 32000 }));
    assert.equal(r.ok, true);
    assert.equal(r.duration_ms, 1000);
  });

  test('tout le reste est refusé, avec une raison différente à chaque fois', () => {
    const raisons = new Set();
    for (const [quoi, buf] of [
      ['court', Buffer.alloc(10)],
      ['pas RIFF', Buffer.alloc(100)],
      ['stéréo', entete({ canaux: 2 })],
      ['44,1 kHz', entete({ taux: 44100 })],
      ['8 bits', entete({ bits: 8 })],
      ['compressé', entete({ format: 3 })],
    ]) {
      const r = dictation.validerWav(buf);
      assert.equal(r.ok, false, quoi);
      assert.ok(r.erreur && !r.erreur.startsWith('err.'), `${quoi} : le message doit être traduit`);
      raisons.add(r.erreur);
    }
    assert.ok(raisons.size >= 5, 'chaque refus dit ce qui cloche, pas « invalide »');
  });

  test('une taille de bloc « data » incohérente retombe sur ce qui reste vraiment', () => {
    const b = entete({ data: 32000 });
    b.writeUInt32LE(9999999, 40);          // le bloc annonce dix mégaoctets qu'il n'a pas
    const r = dictation.validerWav(b);
    assert.equal(r.ok, true);
    assert.equal(r.duration_ms, 1000, 'on mesure ce qui est là, pas ce qui est annoncé');
  });
});

describe('Dictée · le client HTTP, contre un vrai serveur', () => {
  let srv;
  let recu;
  let base;
  before(async () => {
    srv = http.createServer((req, res) => {
      const morceaux = [];
      req.on('data', (c) => morceaux.push(c));
      req.on('end', () => {
        recu = { url: req.url, headers: req.headers, corps: Buffer.concat(morceaux) };
        if (req.headers.authorization === 'Bearer mauvaise') { res.writeHead(401).end('{}'); return; }
        if (/\/v1\/audio\/transcriptions$/.test(req.url)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: 'la merge request 214 sur webapp-front' }));
          return;
        }
        res.writeHead(404).end('{}');
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  after(() => srv.close());

  test('le multipart porte le fichier, le modèle, la langue et le prompt', async () => {
    const texte = await dictation.appelerTranscription(base, {
      wav: dictation.wavSilence(1), language: 'fr', prompt: 'webapp-front', model: 'mon-modele', apiKey: 'bonne',
    });
    assert.equal(texte, 'la merge request 214 sur webapp-front');
    assert.match(recu.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.equal(recu.headers.authorization, 'Bearer bonne');
    const s = recu.corps.toString('latin1');
    assert.ok(s.includes('name="model"') && s.includes('mon-modele'));
    assert.ok(s.includes('name="language"') && s.includes('fr'));
    assert.ok(s.includes('name="prompt"') && s.includes('webapp-front'));
    assert.ok(s.includes('filename="audio.wav"') && s.includes('RIFF'));
  });

  test('une clé refusée donne un message qui parle de la clé, pas un code HTTP', async () => {
    await assert.rejects(
      () => dictation.appelerTranscription(base, { wav: dictation.wavSilence(1), language: 'fr', prompt: '', apiKey: 'mauvaise' }),
      (e) => /cl[ée]/i.test(e.message) && !/401/.test(e.message),
    );
  });

  test('la route de l’URL est bien celle d’OpenAI, et le slash final est absorbé', async () => {
    await dictation.appelerTranscription(`${base}/`, { wav: dictation.wavSilence(1), language: 'fr', prompt: '' });
    assert.equal(recu.url, '/v1/audio/transcriptions');
  });
});

describe('Dictée · le moteur simulé', () => {
  /* La démo remplace le MOTEUR, jamais le réglage : « éteinte » reste éteinte même en
     dry-run, sans quoi décocher la dictée ne l'aurait pas éteinte et l'écran aurait menti.
     Chaque épreuve pose donc explicitement le fournisseur qu'elle veut éprouver. */
  beforeEach(() => { demo.reset(); updateConfig({ dictation_provider: 'local' }); });

  test('il mesure la VRAIE durée de l’audio et rend une phrase de la bonne langue', async () => {
    process.env.DICTATION_DRY_RUN = '1';
    const r = await dictation.transcrire({ wav: dictation.wavSilence(2), language: 'fr' });
    assert.equal(r.duration_ms, 2000, 'la durée vient du WAV reçu, pas d’une constante');
    assert.equal(r.provider, 'demo');
    assert.match(r.text, /health|!216|PROJ-1408/, 'la phrase montre ce que le vocabulaire apporte');
    const en = await dictation.transcrire({ wav: dictation.wavSilence(1), language: 'en' });
    assert.match(en.text, /[a-z]/);
    assert.ok(!/é|è|ç/.test(en.text), 'la phrase anglaise n’est pas la française');
    delete process.env.DICTATION_DRY_RUN;
  });

  test('un WAV qui ment n’atteint jamais le moteur, même simulé', async () => {
    process.env.DICTATION_DRY_RUN = '1';
    await assert.rejects(() => dictation.transcrire({ wav: Buffer.alloc(10), language: 'fr' }), /transcrire|WAV|court/i);
    delete process.env.DICTATION_DRY_RUN;
  });

  test('sans fournisseur, on refuse — jamais un faux texte', async () => {
    delete process.env.DICTATION_DRY_RUN;
    updateConfig({ dictation_provider: 'off' });
    await assert.rejects(() => dictation.transcrire({ wav: dictation.wavSilence(1) }), (e) => e.code === 'DICTATION_OFF');
  });
});

/* LE MOTEUR LOCAL, POUR DE VRAI — avec un faux `whisper-server` qui répond comme le vrai.
   C'est le seul endroit où le cycle de vie complet est éprouvé : port libre trouvé par Node,
   attente du « prêt », chauffe, transcription, arrêt. Et surtout la règle née d'un défaut
   mesuré : `whisper-server --help` NE REND PAS LA MAIN tant qu'un autre tourne, si bien que
   re-sonder le binaire faisait échouer l'étape « Binaire » exactement quand la dictée
   marchait. Le faux binaire reproduit ce piège : son `--help` dort pour toujours. */
describe('Dictée · le moteur local et son diagnostic', () => {
  const faux = path.join(__dirname, 'helpers', 'fake-whisper-server.js');
  const modele = path.join(process.env.MERGERIE_DATA_DIR, 'ggml-faux.bin');

  before(() => {
    fs.writeFileSync(modele, Buffer.concat([Buffer.from('lmgg'), Buffer.alloc(64)]));
    delete process.env.DICTATION_DRY_RUN;
    updateConfig({
      dictation_provider: 'local',
      dictation_command: `${process.execPath} ${faux}`,
      dictation_model: modele,
      dictation_vad_model: '',
    });
  });
  after(() => { dictation.arreterMoteur(); updateConfig({ dictation_provider: 'off', dictation_command: '' }); });

  test('le moteur démarre sur un port libre, chauffe, et transcrit', async () => {
    const r = await dictation.warmup();
    assert.equal(r.warm, true);
    const seg = await dictation.transcrire({ wav: dictation.wavSilence(2), language: 'fr' });
    assert.equal(seg.provider, 'local');
    assert.equal(seg.duration_ms, 2000);
    assert.match(seg.text, /!214/, 'la normalisation s’applique aussi au fournisseur local');
  });

  test('le diagnostic ne re-sonde PAS un binaire déjà démarré — et reste rapide', async () => {
    await dictation.warmup();                     // le moteur tourne : son --help dort désormais
    const t0 = Date.now();
    const d = await dictation.diagnostic();
    const ms = Date.now() - t0;
    const par = Object.fromEntries(d.steps.map((x) => [x.key, x]));
    assert.equal(par.binary.status, 'ok', 'un moteur qui tourne EST la preuve que son binaire marche');
    assert.match(par.binary.detail, /démarré|running/i);
    assert.equal(par.start.status, 'ok');
    assert.equal(d.verdict, 'ready');
    /* La sonde bloquée coûtait dix secondes de délai dépassé : moins de cinq suffit à prouver
       qu'elle n'a pas été lancée, même sur une machine chargée. */
    assert.ok(ms < 5000, `diagnostic rendu en ${ms} ms — la sonde du binaire a dû être relancée`);
  });

  test('arrêter le moteur libère le port et efface sa note', async () => {
    await dictation.warmup();
    const note = path.join(process.env.MERGERIE_DATA_DIR, 'dictation-engine.json');
    assert.equal(fs.existsSync(note), true, 'un moteur qui tourne laisse de quoi le retrouver');
    dictation.arreterMoteur();
    assert.equal(fs.existsSync(note), false, 'et l’arrêt reprend sa note avec lui');
  });
});

describe('Dictée · les réglages', () => {
  test('un fournisseur inconnu retombe sur « éteint » plutôt que d’être écrit tel quel', () => {
    assert.equal(updateConfig({ dictation_provider: 'nimportequoi' }).dictation_provider, 'off');
    assert.equal(updateConfig({ dictation_provider: 'local' }).dictation_provider, 'local');
  });

  test('la fin de phrase et l’inactivité sont bornées', () => {
    assert.equal(updateConfig({ dictation_silence_ms: '10' }).dictation_silence_ms, 400);
    assert.equal(updateConfig({ dictation_silence_ms: '99999' }).dictation_silence_ms, 1500);
    assert.equal(updateConfig({ dictation_silence_ms: 'abc' }).dictation_silence_ms, 700);
    assert.equal(updateConfig({ dictation_idle_minutes: '0' }).dictation_idle_minutes, 0, '0 = ne jamais arrêter, c’est un choix');
    assert.equal(updateConfig({ dictation_idle_minutes: '9999' }).dictation_idle_minutes, 240);
  });

  /* « Celle de l'interface » veut dire celle de L'ÉCRAN, qui voyage par en-tête à chaque
     requête — pas celle enregistrée en base. Lue en base, passer l'écran en anglais laissait
     dicter en français, et le moteur, à qui la langue est FORCÉE, obéissait. */
  test('la langue forcée l’emporte, sinon c’est celle de l’écran', () => {
    updateConfig({ dictation_language: 'auto', language: 'fr' });
    i18n.setLang('en');
    assert.equal(dictation.langueDe(null), 'en', 'l’écran est en anglais : on dicte en anglais');
    i18n.setLang('fr');
    assert.equal(dictation.langueDe(null), 'fr');
    updateConfig({ dictation_language: 'en' });
    i18n.setLang('fr');
    assert.equal(dictation.langueDe(null), 'en', 'le forçage passe devant l’écran');
    assert.equal(dictation.langueDe(null, 'fr'), 'fr', 'et la demande du segment passe devant tout');
    updateConfig({ dictation_language: 'auto' });
  });
});
