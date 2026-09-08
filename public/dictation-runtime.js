/* Dictée vocale — la logique PURE, le MÊME code dans le navigateur et dans Node (même
   montage UMD que i18n-runtime.js, notes-runtime.js et ansi-runtime.js).
 *
 * Pourquoi partagée : le fournisseur « navigateur » (Web Speech API) transcrit SANS passer
 * par le serveur — aucun audio n'est envoyé. Son texte a pourtant besoin exactement du même
 * post-traitement que celui des deux autres : `!214`, `PROJ-720`, l'espace insécable du
 * français, la majuscule de début de phrase, les commandes vocales, la liste de corrections.
 * Deux copies de ces règles divergeraient au premier correctif ; il n'y en a donc qu'une.
 *
 * Tout ici est SANS effet de bord et sans accès à la base : ce qui dépend de l'installation
 * (le vocabulaire, les fournisseurs, le cycle de vie du moteur) vit dans `src/dictation.js`.
 *
 * Les messages d'erreur sont rendus sous forme de CLÉ i18n, jamais de phrase : c'est
 * l'appelant qui traduit, avec la langue qu'il a sous la main. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DICTRT = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const SAMPLE_RATE = 16000;
  const MAX_WAV = 10 * 1024 * 1024;   // ~5 min de PCM 16 kHz mono : au-delà, ce n'est plus de la dictée

  /* ---------- WAV ----------
     Le corps arrive du navigateur et repart vers un process : on le VALIDE avant de le
     relayer, sur son en-tête, jamais sur son extension. Un corps arbitraire n'atteint donc
     jamais le moteur. La durée lue ici est celle que la réponse renvoie — c'est elle qui
     prouve, en test, que l'audio a réellement traversé la chaîne. */
  function validerWav(buf) {
    const b = buf;
    const taille = b ? (b.length != null ? b.length : b.byteLength) : 0;
    if (!b || taille < 44) return { ok: false, cle: 'err.dictation.wav-court' };
    if (taille > MAX_WAV) return { ok: false, cle: 'err.dictation.wav-gros' };
    const vue = new DataView(b.buffer ? b.buffer.slice(b.byteOffset || 0, (b.byteOffset || 0) + taille) : b);
    const texte = (o, n) => {
      let s = '';
      for (let i = 0; i < n; i += 1) s += String.fromCharCode(vue.getUint8(o + i));
      return s;
    };
    if (texte(0, 4) !== 'RIFF' || texte(8, 4) !== 'WAVE') return { ok: false, cle: 'err.dictation.wav-forme' };
    let pos = 12;
    let fmt = null;
    let dataLen = null;
    while (pos + 8 <= taille) {
      const id = texte(pos, 4);
      const n = vue.getUint32(pos + 4, true);
      const corps = pos + 8;
      if (id === 'fmt ' && corps + 16 <= taille) {
        fmt = {
          format: vue.getUint16(corps, true),
          canaux: vue.getUint16(corps + 2, true),
          taux: vue.getUint32(corps + 4, true),
          bits: vue.getUint16(corps + 14, true),
        };
      } else if (id === 'data') {
        // Un flux écrit au fil de l'eau annonce parfois 0 : la taille réelle est ce qui reste.
        dataLen = n > 0 ? Math.min(n, taille - corps) : (taille - corps);
        break;
      }
      pos = corps + n + (n % 2);       // les morceaux RIFF sont alignés sur deux octets
      if (n === 0 && id !== 'data') break;
    }
    if (!fmt || dataLen == null) return { ok: false, cle: 'err.dictation.wav-forme' };
    if (fmt.format !== 1 || fmt.bits !== 16) return { ok: false, cle: 'err.dictation.wav-pcm' };
    if (fmt.canaux !== 1) return { ok: false, cle: 'err.dictation.wav-mono' };
    if (fmt.taux !== SAMPLE_RATE) return { ok: false, cle: 'err.dictation.wav-taux', taux: fmt.taux };
    return { ok: true, duration_ms: Math.round((dataLen / (SAMPLE_RATE * 2)) * 1000), bytes: taille };
  }

  /* Un WAV 16 kHz mono 16 bits fabriqué à la main : 44 octets d'en-tête, puis le PCM. Le
     navigateur n'a pas besoin de `MediaRecorder` (qui produit du WebM/Opus, que
     `whisper-server` ne lit pas sans ffmpeg), et le serveur s'en sert pour une seconde de
     silence — la chauffe du moteur et la sonde d'un fournisseur distant. */
  function fabriquerWav(pcm) {
    const n = pcm.length * 2;
    const buf = new ArrayBuffer(44 + n);
    const v = new DataView(buf);
    const ecrire = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
    ecrire(0, 'RIFF'); v.setUint32(4, 36 + n, true); ecrire(8, 'WAVE');
    ecrire(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ecrire(36, 'data'); v.setUint32(40, n, true);
    for (let i = 0; i < pcm.length; i += 1) v.setInt16(44 + i * 2, pcm[i], true);
    return buf;
  }

  const wavSilence = (secondes) => fabriquerWav(new Int16Array(SAMPLE_RATE * (secondes || 1)));

  /* ---------- Commandes vocales ----------
     Un tout petit jeu, et elles ne valent que SEULES dans un segment : « annule ça »
     prononcé au milieu d'une phrase reste du texte. La ponctuation ne se dicte pas —
     Whisper la met tout seul, la dicter la ferait apparaître en double. */
  const COMMANDES = {
    fr: [
      [/^(?:à la ligne|a la ligne|nouvelle ligne)$/i, 'newline'],
      [/^(?:nouveau paragraphe|saut de paragraphe)$/i, 'paragraph'],
      [/^(?:annule (?:ça|ca)|efface (?:ça|ca))$/i, 'scratch'],
    ],
    en: [
      [/^new line$/i, 'newline'],
      [/^new paragraph$/i, 'paragraph'],
      [/^scratch that$/i, 'scratch'],
    ],
  };

  const lignes = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);

  // « entendu => écrit », une par ligne : la réponse universelle aux erreurs récurrentes sur
  // SES termes à soi (« Jenkins » entendu « Jean-Kim »).
  function parserRemplacements(brut) {
    const out = [];
    for (const l of lignes(brut)) {
      const i = l.indexOf('=>');
      if (i === -1) continue;
      const de = l.slice(0, i).trim();
      const vers = l.slice(i + 2).trim();
      if (de) out.push({ de, vers });
    }
    return out;
  }

  const echapperRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* L'espace insécable du français devant `? ! : ;` — mais JAMAIS dans un bloc de code : on
     dicte parfois `a ? b : c`, et une insécable au milieu d'un extrait le rend faux. On coupe
     donc sur les ``` et on ne traite qu'un morceau sur deux. */
  function typographie(texte, lang) {
    const morceaux = String(texte).split('```');
    return morceaux.map((m, i) => {
      if (i % 2 === 1) return m;                       // dans un bloc de code : on ne touche à rien
      let s = m.replace(/\s+([,.])/g, '$1');
      // U+00A0 : c'est l'espace INSÉCABLE qui fait la typographie française. Whisper en met
      // une ordinaire, ou aucune — et une ordinaire laisse le « ? » passer seul à la ligne.
      // La garde `(\s|$)` vaut pour les DEUX langues : sans elle, « pull request 9 » devenu
      // « !9 » perdait l'espace qui le précède et se collait au mot d'avant (« look at!9 »).
      s = lang === 'fr' ? s.replace(/[ \u00a0\u202f]*([?!:;])(\s|$)/g, '\u00a0$1$2') : s.replace(/\s+([?!:;])(\s|$)/g, '$1$2');
      return s;
    }).join('```');
  }

  /* Les identifiants de Mergerie, reconstitués depuis leurs formes PARLÉES. Ce sont eux qui
     deviennent des liens dans les notes et des cibles dans la palette : les rater rendrait la
     dictée inutile pour son usage principal. */
  function identifiants(texte, prefixes) {
    let s = String(texte);
    // « MR 214 », « merge request 214 », « la MR numéro 214 » → !214
    s = s.replace(/\b(?:merge[ -]?requests?|pull[ -]?requests?|MR|PR)\s+(?:n(?:°|o|um[ée]ro)\s*)?(\d{1,6})\b/gi, '!$1');
    // « issue 42 » → #42. Jamais « ticket », qui désigne le plus souvent une clé Jira.
    s = s.replace(/\bissues?\s+(?:n(?:°|o|um[ée]ro)\s*)?(\d{1,6})\b/gi, '#$1');
    // « proj 720 », « proj tiret 720 », « proj-720 » → PROJ-720, pour les préfixes CONNUS
    for (const p of prefixes || []) {
      const re = new RegExp('\\b' + echapperRe(p) + '\\s*(?:-|tiret|dash)?\\s*(\\d{1,6})\\b', 'gi');
      s = s.replace(re, p.toUpperCase() + '-$1');
    }
    return s;
  }

  /* Normalise UN segment. Renvoie `{ text, command }` : `command` n'est posée que si le
     segment ne contenait QUE la commande. */
  function normaliserSegment(brut, opts) {
    const o = opts || {};
    const lang = o.language === 'en' ? 'en' : 'fr';
    let s = String(brut == null ? '' : brut).replace(/\s+/g, ' ').trim();
    if (!s) return { text: '', command: null };

    const nu = s.replace(/[.…!?,;:]+$/g, '').trim();
    if (o.commands !== false) {
      for (const paire of COMMANDES[lang]) if (paire[0].test(nu)) return { text: '', command: paire[1] };
    }

    for (const r of o.replacements || []) {
      const re = new RegExp('(^|[^\\p{L}\\p{N}])' + echapperRe(r.de) + '(?=[^\\p{L}\\p{N}]|$)', 'giu');
      s = s.replace(re, (m, avant) => avant + r.vers);
    }
    s = identifiants(s, o.jiraPrefixes || []);
    s = typographie(s, lang);
    return { text: s.trim(), command: null };
  }

  /* Ce qu'il faut RÉELLEMENT insérer, compte tenu de ce qui précède dans le champ : l'espace
     de jointure, et la majuscule quand la phrase d'avant s'est terminée. */
  function assembler(precedent, segment) {
    const av = String(precedent == null ? '' : precedent);
    let s = String(segment == null ? '' : segment);
    if (!s) return '';
    if (av === '' || /[.!?…]["»)\]]?\s*$/.test(av)) s = s.charAt(0).toLocaleUpperCase() + s.slice(1);
    if (!av || /[\s\n(«"'[]$/.test(av)) return s;
    if (/^[,.;:!?)»\]]/.test(s)) return s;
    return ' ' + s;
  }

  /* ---------- Anti-hallucination ----------
     Whisper INVENTE du texte sur le silence et le bruit — « Sous-titres réalisés par la
     communauté d'Amara.org » en français, « Thank you for watching » en anglais. C'est la
     dernière des quatre gardes (VAD navigateur, VAD Silero, seuils de décodage, puis
     celle-ci), et la seule qui sache reconnaître une phrase fantôme déjà décodée. */
  const FANTOMES = [
    /sous-?titr(?:es|age)[^.]{0,40}(?:amara|communaut)/i,
    /amara\.org/i,
    /merci d['’]avoir regard/i,
    /abonnez-vous à la cha/i,
    /thank(?:s| you) for watching/i,
    /subtitles? (?:by|provided by)/i,
    /please subscribe/i,
    /^\s*(?:sous-?titres?|subtitles?)\s*[:.]?\s*$/i,
  ];

  // Un même groupe de trois mots répété trois fois ou plus : le moteur boucle.
  function boucle(texte) {
    const mots = String(texte).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    if (mots.length < 9) return false;
    const compte = new Map();
    for (let i = 0; i + 3 <= mots.length; i += 1) {
      const k = mots.slice(i, i + 3).join(' ');
      const n = (compte.get(k) || 0) + 1;
      if (n >= 3) return true;
      compte.set(k, n);
    }
    return false;
  }

  function filtrerHallucination(texte, opts) {
    const o = opts || {};
    const s = String(texte == null ? '' : texte).trim();
    if (!s) return { ok: false, raison: 'vide', texte: '' };
    for (const re of FANTOMES) if (re.test(s)) return { ok: false, raison: 'fantome', texte: '' };
    if (boucle(s)) return { ok: false, raison: 'boucle', texte: '' };
    const prec = String(o.precedent || '').trim();
    if (prec && prec.toLowerCase() === s.toLowerCase()) return { ok: false, raison: 'repetition', texte: '' };
    return { ok: true, raison: null, texte: s };
  }

  /* Similarité de mots, après normalisation : c'est elle qui distingue « installé » de
     « fonctionne » dans le diagnostic. Un modèle corrompu répond, mais répond n'importe quoi. */
  function similarite(a, b) {
    const mots = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    const A = mots(a);
    const B = mots(b);
    if (!A.length || !B.length) return 0;
    const reste = B.slice();
    let communs = 0;
    for (const m of A) { const i = reste.indexOf(m); if (i !== -1) { reste.splice(i, 1); communs += 1; } }
    return (2 * communs) / (A.length + B.length);
  }

  return {
    SAMPLE_RATE, MAX_WAV, COMMANDES, FANTOMES,
    validerWav, fabriquerWav, wavSilence,
    parserRemplacements, normaliserSegment, assembler, identifiants, typographie,
    filtrerHallucination, similarite,
  };
}));
