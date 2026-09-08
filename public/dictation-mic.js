/* Dictée vocale — la capture et l'insertion, côté navigateur (whisper.md §3.1, §6).
 *
 * Le geste : on clique le micro posé sur le champ où l'on écrit (ou Ctrl/Cmd + Maj + Espace),
 * on parle, et le texte s'écrit AU CURSEUR, comme s'il avait été tapé.
 *
 * Trois choses que ce fichier fait, et qu'on ne peut pas déléguer au serveur :
 *
 *  1. LE DÉCOUPAGE AUX SILENCES. C'est lui qui donne la réactivité : un segment se ferme
 *     après le silence réglé (700 ms par défaut) plutôt qu'à l'arrêt de la dictée. Le texte
 *     arrive donc phrase par phrase, pendant qu'on parle, et non dix secondes après.
 *
 *  2. L'INSERTION PAR `setRangeText` PUIS UN ÉVÉNEMENT `input` SYNTHÉTIQUE. Une affectation
 *     de `.value` contournerait TOUT ce qui écoute la frappe dans cette application :
 *     l'autosave des brouillons de suivi, la mention « modifications non enregistrées », la
 *     garde `configFrappe` des réglages. Le texte dicté doit être indiscernable du texte tapé.
 *
 *  3. LE CHAMP RETROUVÉ PAR UN SÉLECTEUR, JAMAIS PAR UNE RÉFÉRENCE. Les cartes de session se
 *     redessinent toutes les 1,5 s et jettent leurs `textarea` : une référence gardée pointe,
 *     au deuxième segment, sur un élément qui n'est plus dans le document — le texte partirait
 *     dans le vide sans la moindre erreur. On re-résout donc la cible à CHAQUE insertion.
 *     Si elle a vraiment disparu (modale fermée), la dictée s'arrête et le texte non inséré
 *     est proposé dans un bandeau : jamais perdu en silence.
 *
 * Rien ici ne s'affiche tant qu'aucun fournisseur n'est configuré : le réglage est la porte
 * d'entrée, et un micro sur chaque champ d'une installation qui ne sait pas transcrire serait
 * une promesse en l'air. */
(function () {
  'use strict';
  const tr = (k, p) => (window.I18Nrt ? window.I18Nrt.t(k, p) : k);
  const RT = window.DICTRT;
  const $ = (sel, root) => (root || document).querySelector(sel);
  /* LA LANGUE VOYAGE AVEC CHAQUE REQUÊTE, comme partout ailleurs dans l'application : elle vit
     dans le navigateur, et le serveur en a besoin — c'est elle qui décide de la langue FORCÉE
     du moteur quand le réglage dit « celle de l'interface ». On la relit ici plutôt que
     d'appeler `readLang` d'app.js : `const` au premier niveau d'un script classique reste dans
     la portée du script et n'est PAS sur `window`. Le repli silencieux aurait dicté en
     français dans une interface anglaise, sans que rien ne le dise. */
  const langue = () => { try { return localStorage.getItem('aidevtools_lang') || 'fr'; } catch { return 'fr'; } };
  const enTetes = (extra) => ({ 'X-Mergerie-Lang': langue(), ...(extra || {}) });

  const TRAME_MS = 32;            // un paquet du worklet
  const MAX_SEGMENT_MS = 12000;   // au-delà, on coupe même sans silence : la phrase est longue
  const MIN_PAROLE_MS = 400;      // en dessous, c'est une respiration ou un clic
  const PREROLL_MS = 320;         // ce qu'on garde AVANT le début de parole, pour ne pas la couper
  const MAX_SESSION_MS = 300000;  // l'audio complet gardé pour la seconde passe (5 min)
  const PLANCHER_RMS = 0.006;     // en dessous, c'est du bruit de fond quelle que soit la salle

  /* ---------- Ce qu'on peut dicter, et ce qu'on ne dicte pas ----------
     Une liste d'EXCLUSION, pas une annotation des vingt-cinq gabarits : un champ ajouté
     demain est couvert sans qu'on y pense. On ne dicte pas une URL, un jeton, un chemin ni
     une recherche — le micro y serait du bruit. */
  const TYPES_EXCLUS = new Set(['password', 'url', 'email', 'search', 'number', 'date', 'time', 'color', 'file', 'checkbox', 'radio', 'hidden', 'range']);
  const NOMS_EXCLUS = /token|key|secret|url|path|chemin|_dir|email|command|template$|env$/i;
  const CLASSES_EXCLUES = /(^|\s)(search|cb-search|rc-search|combo-search|[\w-]*-filter)(\s|$)/;
  const IDS_EXCLUS = /^(mergeEditor|paletteInput|linkSearch)$/;

  function dictable(el) {
    if (!el || el.disabled || el.readOnly) return false;
    const tag = el.tagName;
    if (tag !== 'TEXTAREA' && tag !== 'INPUT') return false;
    if (tag === 'INPUT' && TYPES_EXCLUS.has((el.type || 'text').toLowerCase())) return false;
    if (el.id && IDS_EXCLUS.test(el.id)) return false;
    if (el.name && NOMS_EXCLUS.test(el.name)) return false;
    if (CLASSES_EXCLUES.test(el.className || '')) return false;
    /* Un champ explicitement sorti du correcteur l'est presque toujours parce qu'il porte du
       code, un chemin ou une clé — on n'y dicte pas. « Presque » : le commentaire de verdict
       est de la prose, et ne coupe le correcteur qu'à cause des noms de tests qu'on y colle.
       Il rentre donc par la seule porte prévue pour ça, `data-dictation="1"` — une exception
       nommée vaut mieux qu'une règle qu'on affaiblit pour un cas. */
    if (el.getAttribute('spellcheck') === 'false' && el.dataset.dictation !== '1') return false;
    if (el.closest('[data-no-dictation]')) return false;
    return true;
  }

  /* ---------- Un sélecteur STABLE vers le champ ----------
     On remonte jusqu'au premier ancêtre qui porte une identité (`id`, ou un attribut `data-`
     — c'est ainsi que sont marquées les cartes de session et les formulaires de suivi), puis
     on redescend en chemin d'enfants. Ce chemin survit au redessin de la carte ; une
     référence à l'élément, non. */
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'));

  function ancre(n) {
    for (const nom of n.getAttributeNames()) {
      if (!nom.startsWith('data-')) continue;
      const v = n.getAttribute(nom);
      if (v != null && v !== '') return `[${nom}="${cssEsc(v)}"]`;
    }
    return '';
  }

  function selecteurStable(el) {
    if (el.id) return `#${cssEsc(el.id)}`;
    const chemin = [];
    let n = el;
    for (let i = 0; n && n !== document.body && i < 10; i += 1) {
      const parent = n.parentElement;
      let sel = n.tagName.toLowerCase();
      const classes = [...n.classList].filter((c) => !/^(active|open|hidden)$/.test(c));
      if (classes.length) sel += `.${classes.map(cssEsc).join('.')}`;
      if (parent) {
        const memes = [...parent.children].filter((c) => { try { return c.matches(sel); } catch { return false; } });
        if (memes.length > 1) sel += `:nth-child(${[...parent.children].indexOf(n) + 1})`;
      }
      if (n.id) { chemin.unshift(`#${cssEsc(n.id)}`); return chemin.join(' > '); }
      const a = ancre(n);
      if (a && n !== el) { chemin.unshift(`${n.tagName.toLowerCase()}${a}`); return chemin.join(' > '); }
      chemin.unshift(sel);
      n = parent;
    }
    return chemin.join(' > ');
  }

  /* ---------- État ---------- */
  const D = {
    statut: null,          // ce que le serveur dit de la dictée (fournisseur, silence, langue…)
    cible: null,           // l'élément focalisé qui porterait le micro
    actif: false,
    selecteur: '',
    pos: 0,                // où insérer, dans la valeur du champ
    debut: 0,              // où la dictée a commencé (bornes de la seconde passe)
    attendu: '',           // la valeur qu'on a laissée : sert à voir si l'utilisateur a retouché
    texte: '',             // ce qui a été dicté (contexte glissant, et seconde passe)
    dernier: '',           // le segment précédent, pour écarter une répétition
    seq: 0,
    attendus: new Map(),   // seq -> réponses arrivées dans le désordre
    prochain: 1,
    perdu: '',             // texte transcrit dont le champ n'existait plus
    reco: null,            // SpeechRecognition, fournisseur « navigateur »
    /* LA LANGUE D'UNE SEULE DICTÉE. On écrit une phrase en anglais dans une interface
       française, et changer un réglage pour trois mots serait absurde : ⇧-clic sur le micro
       dicte dans l'AUTRE langue, le temps de cette dictée-là. Le modificateur est déjà celui
       de l'application (⇧-clic copie la commande de checkout sur une branche), et un menu
       déroulant à une seule entrée serait plus lourd que ce qu'il propose. */
    forcee: '',
  };

  // La langue effectivement dictée : la surcharge d'un ⇧-clic, sinon celle du réglage.
  const langueDictee = () => D.forcee || (D.statut && D.statut.language) || 'fr';

  let ctxAudio = null;
  let flux = null;
  let noeud = null;
  let capture = null;

  /* ---------- Le bouton ---------- */
  function btn() { return $('#dictationMic'); }

  function placer() {
    const b = btn();
    if (!b || !D.cible || !D.cible.isConnected) return;
    const r = D.cible.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { b.hidden = true; return; }
    b.hidden = false;
    b.style.left = `${Math.max(4, r.right - 34)}px`;
    b.style.top = `${Math.max(4, r.bottom - 34)}px`;
  }

  function etat(nom, texte) {
    const b = btn();
    if (!b) return;
    b.dataset.etat = nom;
    b.title = texte || tr('dictation.btn');
    b.setAttribute('aria-label', b.title);
    const bulle = $('#dictationHint');
    if (bulle) {
      bulle.hidden = !(nom === 'listening' || nom === 'warming' || nom === 'final');
      if (!bulle.hidden) {
        bulle.textContent = texte || '';
        const r = D.cible && D.cible.isConnected ? D.cible.getBoundingClientRect() : null;
        if (r) { bulle.style.left = `${r.left}px`; bulle.style.top = `${r.bottom + 4}px`; }
      }
    }
  }

  function niveau(v) {
    const b = btn();
    if (!b) return;
    b.style.setProperty('--vu', String(Math.min(1, v * 12)));
  }

  /* ---------- Insertion ----------
     `setRangeText` puis un `InputEvent` : le texte dicté doit être indiscernable du texte
     tapé pour tout ce qui écoute la frappe dans cette application. */
  function champ() {
    if (!D.selecteur) return null;
    const el = $(D.selecteur);
    return el && dictable(el) ? el : null;
  }

  function inserer(texte, commande) {
    const el = champ();
    if (!el) { D.perdu += texte; montrerPerdu(); arreter(); return; }

    // L'utilisateur a tapé, ou la carte s'est redessinée avec une autre valeur : on se
    // réancre sur ce qu'il y a MAINTENANT plutôt que d'écrire à une position périmée.
    if (el.value !== D.attendu) {
      D.pos = (document.activeElement === el && el.selectionStart != null) ? el.selectionStart : el.value.length;
      D.debut = -1;                              // la plage de la seconde passe n'est plus fiable
      D.texte = '';
    }

    let bout = texte;
    if (commande === 'newline') bout = '\n';
    else if (commande === 'paragraph') bout = '\n\n';
    else if (commande === 'scratch') {
      // « annule ça » : on retire le dernier segment inséré, rien de plus.
      const n = D.dernierInsere ? D.dernierInsere.length : 0;
      if (n && D.pos >= n) {
        el.setRangeText('', D.pos - n, D.pos, 'end');
        D.pos -= n;
        D.texte = D.texte.slice(0, Math.max(0, D.texte.length - n));
        D.dernierInsere = '';
        emettre(el, '', 'deleteContentBackward');
        D.attendu = el.value;
      }
      return;
    } else {
      bout = RT.assembler(el.value.slice(0, D.pos), texte);
    }
    if (!bout) return;

    el.setRangeText(bout, D.pos, D.pos, 'end');
    D.pos += bout.length;
    D.dernierInsere = bout;
    D.texte = `${D.texte}${bout}`;
    emettre(el, bout, 'insertText');
    D.attendu = el.value;
    placer();
  }

  function emettre(el, data, inputType) {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data: data || null }));
  }

  /* La seconde passe : l'audio complet, transcrit d'un bloc, remplace la plage insérée — mais
     UNIQUEMENT si l'on n'y a pas retouché entre-temps. Corriger par-dessus une correction
     serait le meilleur moyen d'effacer ce que l'utilisateur vient d'écrire lui-même. */
  function remplacerPlage(texte) {
    const el = champ();
    if (!el || D.debut < 0 || el.value !== D.attendu) return;
    const bout = RT.assembler(el.value.slice(0, D.debut), texte);
    if (!bout || bout.trim() === el.value.slice(D.debut, D.pos).trim()) return;
    el.setRangeText(bout, D.debut, D.pos, 'end');
    D.pos = D.debut + bout.length;
    emettre(el, bout, 'insertReplacementText');
    D.attendu = el.value;
  }

  /* ---------- Le bandeau « texte non inséré » ----------
     Le champ a disparu (modale annulée, carte retirée) alors qu'un segment était en vol. On ne
     jette pas ce que l'utilisateur a dit : on le lui propose. */
  function montrerPerdu() {
    const box = $('#dictationLost');
    if (!box || !D.perdu.trim()) return;
    $('#dictationLostText').textContent = D.perdu.trim();
    box.hidden = false;
  }

  /* ---------- Envoi d'un segment ---------- */
  async function envoyer(pcm, seq, final) {
    const wav = RT.fabriquerWav(pcm);
    const ctx = D.texte.trim().split(/\s+/).slice(-60).join(' ');
    const q = new URLSearchParams({ seq: String(seq), ctx, final: final ? '1' : '0', lang: langueDictee() });
    let r;
    try {
      r = await fetch(`/api/dictation/transcribe?${q}`, {
        method: 'POST',
        headers: enTetes({ 'Content-Type': 'audio/wav' }),
        body: wav,
      });
    } catch (e) { echec(seq, final, tr('dictation.err.engine', { detail: e.message }), false); return; }
    const data = await r.json().catch(() => ({}));
    /* 400 et 409 sont DÉFINITIFS : la dictée est éteinte, ou l'audio ne convient pas. Les
       réessayer ne changerait rien, et laisser tourner un micro qui n'écrit plus est pire que
       s'arrêter en le disant. Tout le reste (réseau qui hoquette, moteur qui bafouille sur un
       segment) ne doit PAS emporter deux minutes de dictée. */
    if (!r.ok) { echec(seq, final, data.error || tr('dictation.err.engine', { detail: r.status }), r.status === 400 || r.status === 409); return; }
    if (final) { remplacerPlage(data.text || ''); return; }
    ranger(seq, data);
    if (D.actif) etat('listening', libelleEcoute());
  }

  /* Deux segments peuvent se chevaucher en vol : on remet dans l'ordre avant d'insérer.
     Un segment PERDU (`null`) prend quand même sa place dans la file : sans lui, `prochain`
     resterait bloqué sur son numéro et tous les segments suivants attendraient un tour qui ne
     viendrait jamais — la dictée cesserait d'écrire sans un mot. */
  function ranger(seq, data) {
    D.attendus.set(seq, data);
    while (D.attendus.has(D.prochain)) {
      const d = D.attendus.get(D.prochain);
      D.attendus.delete(D.prochain);
      D.prochain += 1;
      if (!d || (!d.text && !d.command)) continue;
      const g = RT.filtrerHallucination(d.text, { precedent: D.dernier });
      if (g.ok || d.command) { inserer(d.text, d.command); D.dernier = d.text; }
    }
  }

  function echec(seq, final, msg, definitif) {
    if (!final) ranger(seq, null);
    // `erreur` dit déjà le message : le redire ici en ferait deux à l'écran pour un seul défaut.
    if (definitif) { erreur(msg); return; }
    if (window.toast) window.toast(msg, true);
    if (D.actif) etat('listening', libelleEcoute());
  }

  /* L'ÉTAT D'ERREUR DOIT SURVIVRE À CE QUI L'A CAUSÉ. Écrit AVANT l'arrêt, il était effacé
     dans la seconde : `arreter()` repasse le bouton en « prêt » — et le repasse une seconde
     fois quand la relecture finale rend la main. On arrête donc d'abord, on marque ensuite, et
     on saute la relecture : renvoyer neuf mégaoctets à un moteur qui vient de refuser un
     segment de trois secondes ne peut que refuser aussi. */
  function erreur(msg) {
    if (window.toast) window.toast(msg, true);
    arreter(true);
    etat('error', msg);
  }

  /* ---------- Capture et découpage aux silences ----------
     Un segment s'ouvre à la parole, se ferme après le silence réglé, ou au bout de douze
     secondes. Le seuil est ADAPTATIF : le bruit de fond d'un bureau ouvert n'est pas celui
     d'une chambre, et un seuil fixe rendrait la dictée inutilisable dans l'un des deux. */
  function nouvelleCapture() {
    return {
      preroll: [], segment: [], tout: [], msTout: 0,
      msParole: 0, msSilence: 0, bruit: PLANCHER_RMS, ouvert: false,
    };
  }

  function trame(f32) {
    if (!capture) return;
    let somme = 0;
    for (let i = 0; i < f32.length; i += 1) somme += f32[i] * f32[i];
    const rms = Math.sqrt(somme / f32.length);
    niveau(rms);

    const pcm = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i += 1) {
      const v = Math.max(-1, Math.min(1, f32[i]));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }

    // L'audio COMPLET de la session, pour la seconde passe (borné : cinq minutes).
    if (capture.msTout < MAX_SESSION_MS) { capture.tout.push(pcm); capture.msTout += TRAME_MS; }

    const seuil = Math.max(PLANCHER_RMS, capture.bruit * 2.5);
    const parle = rms > seuil;
    if (!parle) capture.bruit = capture.bruit * 0.95 + rms * 0.05;    // moyenne glissante du fond

    if (capture.ouvert) {
      capture.segment.push(pcm);
      if (parle) { capture.msParole += TRAME_MS; capture.msSilence = 0; }
      else capture.msSilence += TRAME_MS;
      const silenceMax = (D.statut && D.statut.silence_ms) || 700;
      if (capture.msSilence >= silenceMax || capture.msParole >= MAX_SEGMENT_MS) fermerSegment();
      return;
    }

    if (parle) {
      capture.ouvert = true;
      capture.segment = capture.preroll.concat([pcm]);
      capture.preroll = [];
      capture.msParole = TRAME_MS;
      capture.msSilence = 0;
      etat('listening', libelleEcoute());
      return;
    }
    // Pas encore de parole : on garde de quoi ne pas couper la première syllabe.
    capture.preroll.push(pcm);
    while (capture.preroll.length * TRAME_MS > PREROLL_MS) capture.preroll.shift();
  }

  function concat(liste) {
    let n = 0;
    for (const p of liste) n += p.length;
    const out = new Int16Array(n);
    let o = 0;
    for (const p of liste) { out.set(p, o); o += p.length; }
    return out;
  }

  function fermerSegment() {
    if (!capture || !capture.ouvert) return;
    const morceaux = capture.segment;
    const parole = capture.msParole;
    capture.segment = []; capture.ouvert = false; capture.msParole = 0; capture.msSilence = 0;
    if (parole < MIN_PAROLE_MS || !morceaux.length) return;    // respiration, clic : rien à envoyer
    D.seq += 1;
    etat('transcribing', tr('dictation.transcribing'));
    envoyer(concat(morceaux), D.seq, false);
  }

  /* ---------- Démarrer / arrêter ---------- */
  async function demarrer(autreLangue) {
    if (D.actif) { arreter(); return; }
    if (!D.cible || !D.cible.isConnected) return;
    if (!window.isSecureContext) { erreur(tr('dictation.err.insecure')); return; }
    if (!D.statut || D.statut.provider === 'off') { erreur(tr('dictation.err.no-engine')); return; }

    D.selecteur = selecteurStable(D.cible);
    D.pos = D.cible.selectionStart != null ? D.cible.selectionStart : D.cible.value.length;
    D.debut = D.pos;
    D.attendu = D.cible.value;
    D.texte = ''; D.dernier = ''; D.dernierInsere = '';
    D.seq = 0; D.prochain = 1; D.attendus.clear(); D.perdu = '';
    D.forcee = autreLangue ? (D.statut.language === 'en' ? 'fr' : 'en') : '';

    if (D.statut.provider === 'browser') { demarrerNavigateur(); return; }

    etat('warming', tr('dictation.warming'));
    try {
      flux = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      erreur(/NotAllowed|Permission/i.test(String(e && e.name)) ? tr('dictation.err.denied') : tr('dictation.err.engine', { detail: e.message }));
      return;
    }
    try {
      ctxAudio = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RT.SAMPLE_RATE });
      if (!ctxAudio.audioWorklet) throw new Error('AudioWorklet');
      await ctxAudio.audioWorklet.addModule('/dictation-worklet.js');
      noeud = new AudioWorkletNode(ctxAudio, 'collecteur-dictee');
      noeud.port.onmessage = (ev) => trame(ev.data);
      ctxAudio.createMediaStreamSource(flux).connect(noeud);
      // Un worklet sans destination n'est pas ordonnancé dans certains navigateurs : on le
      // relie à un gain MUET plutôt qu'à la sortie, sinon on s'entendrait parler.
      const muet = ctxAudio.createGain();
      muet.gain.value = 0;
      noeud.connect(muet).connect(ctxAudio.destination);
    } catch (e) {
      erreur(tr('dictation.err.unsupported'));
      return;
    }
    capture = nouvelleCapture();
    D.actif = true;
    etat('listening', libelleEcoute());
  }

  /* La bulle DIT dans quelle langue on dicte quand ce n'est pas celle de l'écran : sans ça,
     un ⇧-clic distrait produirait du texte dans la mauvaise langue sans rien annoncer. */
  function libelleEcoute() {
    return D.forcee ? tr('dictation.listening-lang', { lang: D.forcee.toUpperCase() }) : tr('dictation.listening');
  }

  function arreter(surErreur) {
    if (!D.actif && !flux && !D.reco) { if (!surErreur) etat('ready'); return; }
    const c = capture;
    D.actif = false;
    if (D.reco) { try { D.reco.stop(); } catch { /* déjà arrêtée */ } D.reco = null; }
    if (c && c.ouvert) fermerSegment();
    if (noeud) { try { noeud.port.onmessage = null; noeud.disconnect(); } catch { /* détaché */ } noeud = null; }
    if (ctxAudio) { try { ctxAudio.close(); } catch { /* déjà fermé */ } ctxAudio = null; }
    if (flux) { flux.getTracks().forEach((tk) => { try { tk.stop(); } catch { /* ok */ } }); flux = null; }
    capture = null;
    if (!surErreur) etat('ready');
    // La seconde passe : l'audio complet, en arrière-plan, pendant qu'on relit.
    if (!surErreur && c && c.tout.length && D.statut && D.statut.final_pass && D.statut.provider !== 'browser') {
      etat('final', tr('dictation.final'));
      // …et si c'est la relecture elle-même qui échoue, on ne recouvre pas son message.
      envoyer(concat(c.tout), 0, true).finally(() => { const b = btn(); if (!b || b.dataset.etat !== 'error') etat('ready'); });
    }
    if (D.perdu.trim()) montrerPerdu();
  }

  /* ---------- Fournisseur « navigateur » (Web Speech API) ----------
     Aucun audio ne passe par le serveur ici — mais le texte reçoit exactement le même
     post-traitement que celui des deux autres fournisseurs (module partagé). */
  function demarrerNavigateur() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { erreur(tr('dictation.err.unsupported')); return; }
    const reco = new SR();
    reco.lang = langueDictee() === 'en' ? 'en-US' : 'fr-FR';
    reco.continuous = true;
    reco.interimResults = false;
    reco.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        if (!ev.results[i].isFinal) continue;
        const brut = ev.results[i][0].transcript;
        const g = RT.filtrerHallucination(brut, { precedent: D.dernier });
        if (!g.ok) continue;
        const seg = RT.normaliserSegment(g.texte, { language: langueDictee() });
        inserer(seg.text, seg.command);
        D.dernier = g.texte;
      }
    };
    reco.onerror = (ev) => {
      erreur(ev.error === 'not-allowed' ? tr('dictation.err.denied') : tr('dictation.err.engine', { detail: ev.error }));
    };
    reco.onend = () => { if (D.actif) { try { reco.start(); } catch { /* redémarrage refusé */ } } };
    D.reco = reco;
    D.actif = true;
    try { reco.start(); } catch (e) { erreur(tr('dictation.err.engine', { detail: e.message })); return; }
    etat('listening', libelleEcoute());
  }

  /* ---------- Câblage ---------- */
  async function relireStatut() {
    try {
      const r = await fetch('/api/dictation/status', { cache: 'no-store', headers: enTetes() });
      D.statut = r.ok ? await r.json() : null;
    } catch { D.statut = null; }
    if (!D.statut || D.statut.provider === 'off') {
      const b = btn();
      if (b) b.hidden = true;
      D.cible = null;
    }
  }

  document.addEventListener('focusin', (e) => {
    const b = btn();
    if (!b) return;
    if (b.contains(e.target)) return;         // le clic sur le micro ne change pas la cible
    if (!D.statut || D.statut.provider === 'off') { b.hidden = true; return; }
    if (!dictable(e.target)) {
      if (D.actif) return;                    // on dicte : on ne perd pas le bouton en cours de route
      b.hidden = true; D.cible = null; return;
    }
    if (D.actif && e.target !== D.cible) arreter();
    D.cible = e.target;
    etat(D.actif ? 'listening' : 'ready');
    placer();
  });

  window.addEventListener('scroll', placer, true);
  window.addEventListener('resize', placer);

  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#dictationMic')) { e.preventDefault(); demarrer(e.shiftKey); return; }
    const cp = e.target.closest && e.target.closest('#dictationLostCopy');
    if (cp) {
      const txt = $('#dictationLostText').textContent;
      if (window.copyText) window.copyText(txt, cp);
      else navigator.clipboard.writeText(txt).catch(() => {});
      return;
    }
    if (e.target.closest && e.target.closest('#dictationLostClose')) {
      $('#dictationLost').hidden = true; D.perdu = '';
    }
  });

  /* Le raccourci : `Ctrl/Cmd + Maj + Espace`. Les touches nues (`d`, `m`, `v`, `c`, `x`) sont
     prises par les cartes et ne marchent de toute façon pas dans un champ. */
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.shiftKey && (e.ctrlKey || e.metaKey)) {
      if (!D.cible && dictable(document.activeElement)) D.cible = document.activeElement;
      if (!D.cible) return;
      e.preventDefault();
      demarrer();
      return;
    }
    /* Échap pendant la dictée ARRÊTE LA DICTÉE, et rien d'autre : sans `stopPropagation`,
       le même Échap fermait aussi la modale par-dessus, emportant le texte qu'on venait de
       dicter. Un second Échap ferme la modale, comme d'habitude. */
    if (e.key === 'Escape' && D.actif) { e.preventDefault(); e.stopPropagation(); arreter(); }
  }, true);

  // La chauffe au SURVOL : charger le modèle prend une à trois secondes, autant les payer
  // pendant que la souris s'approche plutôt qu'après le premier mot.
  let chauffe = 0;
  document.addEventListener('mouseover', (e) => {
    if (!e.target.closest || !e.target.closest('#dictationMic')) return;
    if (!D.statut || D.statut.provider !== 'local' || D.statut.ready) return;
    if (Date.now() - chauffe < 30000) return;
    chauffe = Date.now();
    fetch('/api/dictation/warmup', { method: 'POST', headers: enTetes() }).catch(() => {});
  });

  window.mergerieDictation = { relireStatut, arreter, etat: () => ({ ...D, statut: D.statut }) };
  document.addEventListener('DOMContentLoaded', relireStatut);
  if (document.readyState !== 'loading') relireStatut();
}());
