#!/usr/bin/env node
'use strict';
/* Banc de mesure de la dictée (whisper.md §5.4).
 *
 * Lance le moteur AVEC LES MÊMES PARAMÈTRES QUE MERGERIE — c'est tout l'intérêt : mesurer
 * whisper.cpp à la main avec d'autres drapeaux ne dit rien de ce que l'outil fera. On rejoue
 * donc `src/dictation.js` tel quel, sur les fichiers de `test/fixtures/dictation/*.wav`, et on
 * imprime pour chacun la latence, le texte obtenu, et le TAUX D'ERREUR MOT contre le texte de
 * référence en regard (`.txt`) quand il existe.
 *
 * C'est ce banc qui valide les chiffres écrits dans le guide — et lui seul qui dira si
 * `large-v3` vaut son surcoût sur une machine donnée. Aucun chiffre de documentation ne doit
 * être écrit sans être passé par ici.
 *
 *   MERGERIE_DATA_DIR=data node scripts/dictation-bench.js
 *   node scripts/dictation-bench.js --avec-prompt 0     # mesurer ce que le vocabulaire apporte
 *   node scripts/dictation-bench.js test/fixtures/dictation/phrase-fr.wav
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DEFAUT = path.join(ROOT, 'test', 'fixtures', 'dictation');

const args = process.argv.slice(2);
let avecPrompt = true;
const fichiers = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--avec-prompt') { avecPrompt = args[i + 1] !== '0'; i += 1; continue; }
  if (args[i] === '-h' || args[i] === '--help') {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 18).join('\n').replace(/^ ?\*ature?/gm, ''));
    process.exit(0);
  }
  fichiers.push(path.resolve(args[i]));
}

/* Distance d'édition au niveau du MOT : c'est la mesure d'usage en reconnaissance vocale, et
   la seule qui compte ici — une lettre fausse dans « webapp-front » rend le nom inutilisable
   au même titre qu'un mot entier manquant. */
function tauxErreurMot(reference, obtenu) {
  const mots = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}!#/\-\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const R = mots(reference);
  const O = mots(obtenu);
  if (!R.length) return null;
  const d = Array.from({ length: R.length + 1 }, (_, i) => [i, ...Array(O.length).fill(0)]);
  for (let j = 0; j <= O.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= R.length; i += 1) {
    for (let j = 1; j <= O.length; j += 1) {
      d[i][j] = R[i - 1] === O[j - 1] ? d[i - 1][j - 1]
        : 1 + Math.min(d[i - 1][j - 1], d[i - 1][j], d[i][j - 1]);
    }
  }
  return d[R.length][O.length] / R.length;
}

async function main() {
  // Après la lecture des arguments : `paths.js` lit MERGERIE_DATA_DIR au chargement, et on
  // ne veut pas ouvrir la base avant d'avoir pu échouer sur une option inconnue.
  // eslint-disable-next-line global-require
  const dictation = require('../src/dictation');

  let liste = fichiers;
  if (!liste.length) {
    if (!fs.existsSync(DEFAUT)) {
      console.error(`Aucun fichier à mesurer : ${path.relative(ROOT, DEFAUT)} n'existe pas.`);
      console.error('Enregistre des phrases de 5 à 60 s en WAV 16 kHz mono, avec un .txt de référence en regard.');
      process.exit(1);
    }
    liste = fs.readdirSync(DEFAUT).filter((f) => f.endsWith('.wav')).sort().map((f) => path.join(DEFAUT, f));
  }
  if (!liste.length) { console.error('Aucun .wav trouvé.'); process.exit(1); }

  const { prompt, terms } = dictation.construirePrompt(null, 'fr');
  console.log(`Fournisseur : ${dictation.fournisseur()}`);
  console.log(`Vocabulaire : ${terms.length} termes${avecPrompt ? '' : ' (DÉSACTIVÉ pour cette mesure)'}`);
  if (avecPrompt) console.log(`Prompt      : ${prompt.slice(0, 120)}…`);
  console.log('');

  let sommeWer = 0;
  let nWer = 0;
  for (const f of liste) {
    const wav = fs.readFileSync(f);
    const v = dictation.validerWav(wav);
    if (!v.ok) { console.log(`${path.basename(f)} : ${v.erreur}`); continue; }
    const lang = /-en\./.test(f) ? 'en' : 'fr';
    const t0 = Date.now();
    let r;
    try { r = await dictation.transcrire({ wav, language: lang }); }
    catch (e) { console.log(`${path.basename(f)} : ✗ ${e.message}`); continue; }
    const ms = Date.now() - t0;
    const ref = f.replace(/\.wav$/, '.txt');
    const wer = fs.existsSync(ref) ? tauxErreurMot(fs.readFileSync(ref, 'utf8'), r.text) : null;
    if (wer != null) { sommeWer += wer; nWer += 1; }
    console.log(`${path.basename(f)}  ${v.duration_ms} ms d'audio → ${ms} ms (×${(v.duration_ms / ms).toFixed(1)} temps réel)`
      + (wer == null ? '' : `  ·  erreur mot ${(wer * 100).toFixed(1)} %`));
    console.log(`   « ${r.text} »`);
    if (wer != null) console.log(`   réf. « ${fs.readFileSync(ref, 'utf8').trim()} »`);
  }
  if (nWer) console.log(`\nTaux d'erreur mot moyen : ${((sommeWer / nWer) * 100).toFixed(1)} % sur ${nWer} fichier(s)`);
  dictation.arreterMoteur();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
