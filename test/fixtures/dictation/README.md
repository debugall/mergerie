# Fichiers audio de la dictée

## `phrase-fr.wav` — fixture de test (versionnée)

Trois secondes, 16 kHz mono 16 bits, **synthétique** : 0,3 s de silence, 2,2 s de porteuse
modulée à ~4,5 « syllabes » par seconde, 0,5 s de silence. Son CONTENU n'a aucune importance —
en test, le moteur est simulé (`DICTATION_DRY_RUN=1`) et rend une phrase scriptée. Ce que le
test vérifie, c'est sa **durée**, que le faux moteur mesure sur le WAV reçu : elle prouve que
l'audio a réellement traversé la chaîne (permission → capture → WAV 16 kHz → route → insertion).

Régénérée par :

```sh
node -e "
const fs=require('fs'), RT=require('./public/dictation-runtime.js'), SR=16000;
const n=SR*3, pcm=new Int16Array(n);
for(let i=0;i<n;i++){const t=i/SR; if(t<0.3||t>2.5){pcm[i]=0;continue;}
  const env=0.35*(0.55+0.45*Math.sin(2*Math.PI*4.5*t));
  const s=Math.sin(2*Math.PI*140*t)*0.6+Math.sin(2*Math.PI*430*t)*0.3+Math.sin(2*Math.PI*1150*t)*0.1;
  pcm[i]=Math.round(s*env*32767);}
fs.writeFileSync('test/fixtures/dictation/phrase-fr.wav', Buffer.from(RT.fabriquerWav(pcm)));"
```

## Ce qui n'est pas ici : les enregistrements de référence

Le banc de mesure (`scripts/dictation-bench.js`) et l'étape « Transcription » du panneau de
diagnostic veulent de **vraies voix** — un son synthétique ne dit rien de la justesse d'un
moteur. Ces fichiers ne sont pas versionnés, pour une raison de licence : la sortie des voix
système (macOS `say`, SAPI) n'est pas clairement redistribuable.

Pour les produire soi-même — trois phrases FR, trois EN, de 5 à 60 s, en WAV **16 kHz mono
16 bits**, avec le texte de référence dans un `.txt` du même nom :

```sh
# macOS
say -o /tmp/p.aiff "Il faut corriger la merge request 216 sur webapp-front, puis lancer npm test."
ffmpeg -i /tmp/p.aiff -ar 16000 -ac 1 -c:a pcm_s16le test/fixtures/dictation/phrase-fr.wav
echo "Il faut corriger la !216 sur webapp-front, puis lancer npm test." > test/fixtures/dictation/phrase-fr.txt
```

Utilise les noms de la démo (`webapp-front`, `!216`, `PROJ-1408`) : c'est là que le prompt de
vocabulaire se voit, et c'est ce qu'on cherche à mesurer.

L'échantillon du panneau de diagnostic, lui, se dépose dans `public/audio/` sous les noms
`dictation-test-fr.wav` et `dictation-test-en.wav` (~3 s), et dit :

- FR — « Mergerie, test de la dictée : merge request 214 sur webapp-front. »
- EN — « Mergerie, dictation test: merge request 214 on webapp-front. »

Tant qu'ils sont absents, l'étape « Transcription » prouve seulement que le moteur **répond**,
et le dit en toutes lettres plutôt que de se déclarer verte.
