'use strict';
/* LA FRISE D'UNE SESSION DE CODAGE, pour le cockpit : toutes les étapes de son déroulé, dans l'ordre, chacune
   avec son état — ce qui est fait, ce qui tourne, ce qui attend, ce qui viendra. Une lecture, aucun appel :
   l'état des projets, du job, des boucles de convergence, de la chaîne de validation et de son scénario.

     codage → push → [review, puis correction + review par passe] → [vérificateur : base, branche, diagnostic]…
            → [scénario : écrire, pousser, lancer] → validée

   Une étape porte `cle` (l'écran la nomme), `etat` (fait · en_cours · en_file · a_toi · echec · a_venir ·
   saute) et ce qui la précise : `n` (la passe), `nom` (le vérificateur), `projet`, `note`, `essai`, `detail`,
   `verification_id`, `seuil` et `max` (la note visée et les passes permises, sur une étape de convergence),
   `depuis` (l'heure où l'étape active a commencé — ou s'est mise à attendre). `si` marque une étape qui n'aura lieu que si la précédente ne suffit pas (une passe de
   convergence de plus, tant que la note reste sous le seuil). `courante` : l'index de la première étape qui
   tourne, attend ou a échoué. */
const db = require('../db');
const { getConfig } = require('../data/config');
const groupes = require('../data/groupes');
const scenarioMod = require('./chaine-scenario');
const { convergeDefaults } = require('../review/converge');

const lire = (j, defaut) => { try { return JSON.parse(j); } catch { return defaut; } };
const ACTIVES = new Set(['en_cours', 'en_file', 'a_toi', 'echec']);

/* L'état d'un côté de vérificateur (`chaine-verif.etat`) dit dans la langue de la frise. */
function etatCote(c, attention) {
  if (!c) return 'a_venir';
  if (c.etat === 'pass') return 'fait';
  if (c.etat === 'running') return 'en_cours';
  if (c.etat === 'queued') return 'en_file';
  if (c.etat === 'broken') return attention ? 'a_toi' : 'echec';
  return 'a_venir';
}

/* Les étapes de la boucle de convergence d'un projet, depuis sa dernière boucle lancée pour cette session.
   Sans boucle encore (le job vient de partir), ce qui va se passer : la review, puis des passes possibles. */
function etapesConvergence(run, projet, maxDefaut) {
  const out = [];
  // La note visée et les passes permises : celles de la boucle, ou les réglages tant qu'elle n'est pas partie.
  const seuil = run ? run.threshold : convergeDefaults().threshold;
  const max = run ? run.max_passes : maxDefaut;
  const poser = () => { for (const e of out) { e.seuil = seuil; e.max = max; } return out; };
  if (!run) {
    out.push({ cle: 'review', n: 0, etat: 'a_venir', projet });
    for (let k = 1; k <= maxDefaut; k += 1) {
      out.push({ cle: 'fix', n: k, etat: 'a_venir', projet, si: true }, { cle: 'review', n: k, etat: 'a_venir', projet, si: true });
    }
    return poser();
  }
  // L'étape qui tourne a commencé au dernier changement d'étape (avant la colonne, au départ de la boucle).
  const depuis = run.phase_at || run.started_at || null;
  const notesLues = lire(run.notes_json, null);
  const notes = notesLues || [run.start_note];
  const p = run.passes_done || 0;
  const tourne = run.status === 'running';
  // Coupée (erreur, arrêt, serveur arrêté) : l'étape où elle en était porte l'échec.
  const coupe = run.status === 'error' || run.status === 'stopped';
  // Pas encore de note de départ : la première review tourne (la MR n'en avait pas, ou une périmée).
  const initialeEnCours = tourne && run.phase === 'review' && p === 0 && !notesLues;
  out.push({ cle: 'review', n: 0, etat: initialeEnCours ? 'en_cours' : (coupe && p === 0 && run.phase === 'review' && !notesLues ? 'echec' : 'fait'), projet, note: notes[0] == null ? null : notes[0], depuis: initialeEnCours ? depuis : null });
  for (let k = 1; k <= run.max_passes; k += 1) {
    if (k <= p) {
      out.push({ cle: 'fix', n: k, etat: 'fait', projet });
      let etat = 'fait';
      if (k === p && tourne && run.phase === 'review') etat = 'en_cours';
      else if (k === p && coupe && run.phase === 'review') etat = 'echec';
      out.push({ cle: 'review', n: k, etat, projet, note: notes[k] == null ? null : notes[k], depuis: etat === 'en_cours' ? depuis : null });
      continue;
    }
    /* Une question pendant la correction : la passe reprendra à la réponse — sa review suivra, puis les
       passes restantes si la note reste sous le seuil. */
    if (k === p + 1 && run.status === 'needs_input') {
      out.push({ cle: 'fix', n: k, etat: 'a_toi', projet, depuis: run.finished_at || depuis }, { cle: 'review', n: k, etat: 'a_venir', projet });
      for (let j = k + 1; j <= run.max_passes; j += 1) {
        out.push({ cle: 'fix', n: j, etat: 'a_venir', projet, si: true }, { cle: 'review', n: j, etat: 'a_venir', projet, si: true });
      }
      break;
    }
    if (k === p + 1 && coupe && run.phase === 'fix') { out.push({ cle: 'fix', n: k, etat: 'echec', projet, detail: run.message || '' }); break; }
    if (!tourne) break;   // finie : les passes qui n'ont pas eu lieu n'auront pas lieu
    const enCours = k === p + 1 && run.phase === 'fix';
    out.push({ cle: 'fix', n: k, etat: enCours ? 'en_cours' : 'a_venir', projet, si: !enCours, depuis: enCours ? depuis : null },
      { cle: 'review', n: k, etat: 'a_venir', projet, si: !enCours });
  }
  if (!tourne && run.status !== 'needs_input' && !(coupe && run.phase)) {
    out.push({ cle: 'converge-fin', etat: coupe ? 'echec' : 'fait', projet, detail: run.status, note: run.best_note == null ? null : run.best_note });
  }
  return poser();
}

/* DEPUIS QUAND : une étape qui tourne depuis 40 min ne se lit pas comme une qui vient de partir. L'heure vient
   de ce qui la porte — le job du codage, la vérification lancée ; une question, du dernier changement de la
   session. Sans source sûre, rien : mieux vaut ne rien dire qu'une durée fausse. */
function poserDepuis(etapes, { job, attente }) {
  const debutJob = job && !job.enFile ? (db.prepare('SELECT started_at FROM job WHERE id = ?').get(job.jobId) || {}).started_at : null;
  for (const e of etapes) {
    if (ACTIVES.has(e.etat) && e.etat !== 'echec' && !e.depuis) {
      if (e.verification_id) {
        const v = db.prepare('SELECT started_at, created_at FROM verification WHERE id = ?').get(e.verification_id);
        if (v) e.depuis = e.etat === 'en_file' ? v.created_at : (v.started_at || v.created_at);
      } else if (['code', 'commit', 'push', 'mr'].includes(e.cle)) {
        e.depuis = e.etat === 'a_toi' ? attente(e) : (e.etat === 'en_cours' ? debutJob : null);
      }
    }
    if (!e.depuis) delete e.depuis;
  }
}

/* Le vérificateur unique « Vérifier après » (sans chaîne) : sa dernière vérification depuis la session. */
function etapeVerificateur(task) {
  const v = db.prepare('SELECT id, name FROM verifier WHERE id = ?').get(task.verifier_id);
  if (!v) return null;
  const run = db.prepare('SELECT id, status, verdict FROM verification WHERE verifier_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 1')
    .get(v.id, task.created_at || '');
  let etat = 'a_venir';
  if (run && run.status === 'queued') etat = 'en_file';
  else if (run && run.status === 'running') etat = 'en_cours';
  else if (run) etat = run.verdict === 'verified_pass' ? 'fait' : 'echec';
  return { cle: 'verif', nom: v.name, verifier_id: v.id, etat, verification_id: run ? run.id : null };
}

/* La chaîne : chaque vérificateur sur la base puis la branche (et son diagnostic), puis le scénario. */
function etapesChaine(task, chaine) {
  const out = [];
  const attention = !!(chaine && chaine.status === 'attention');
  if (chaine && chaine.steps) {
    for (const s of chaine.steps) {
      const base = { cle: 'verif', cote: 'base', nom: s.verifier_name, verifier_id: s.verifier_id, etat: etatCote(s.base, attention), essai: s.base.essai || 0, verification_id: s.base.verification_id || null };
      const head = { cle: 'verif', cote: 'head', nom: s.verifier_name, verifier_id: s.verifier_id, etat: base.etat === 'fait' ? etatCote(s.head, attention) : 'a_venir', essai: (s.head && s.head.essai) || 0, verification_id: (s.head && s.head.verification_id) || null };
      if (s.erreur) (base.etat === 'fait' ? head : base).etat = attention ? 'a_toi' : 'echec';
      if (s.erreur) (base.etat === 'fait' ? head : base).detail = s.erreur;
      out.push(base, head);
      if (s.diag) {
        let etat = 'fait';
        if (s.diag.en_cours) etat = 'en_cours';
        else if (s.diag.cause && s.diag.cause !== 'branche') etat = 'a_toi';
        out.push({ cle: 'diag', nom: s.verifier_name, verifier_id: s.verifier_id, etat, n: s.diag.rounds, detail: s.diag.cause || '' });
      }
    }
  } else {
    for (const id of lire(task.verify_chain, [])) {
      const v = db.prepare('SELECT name FROM verifier WHERE id = ?').get(Number(id));
      if (!v) continue;
      out.push({ cle: 'verif', cote: 'base', nom: v.name, verifier_id: Number(id), etat: 'a_venir' }, { cle: 'verif', cote: 'head', nom: v.name, verifier_id: Number(id), etat: 'a_venir' });
    }
  }
  /* L'ÉTAPE TESTS : écrire (une étape par dépôt touché, avec sa zone), rejouer (une par vérificateur, avec son
     essai), corriger (le numéro de la correction). « Déjà couvert » : écrire fait, avec les tests cités, le
     rejeu sans objet. Un dépôt de tests porte sa merge request (brouillon jusqu'au vert, puis prête). */
  const cfgScen = scenarioMod.lireScenario(task);
  let mrTests = null;
  if (cfgScen) {
    const sc = (chaine && chaine.scenario) || null;
    const noms = (chaine && chaine.steps ? chaine.steps.map((x) => ({ id: x.verifier_id, nom: x.verifier_name }))
      : lire(task.verify_chain, []).map((id) => ({ id: Number(id), nom: (db.prepare('SELECT name FROM verifier WHERE id = ?').get(Number(id)) || {}).name })))
      .filter((x) => x.nom);
    const touches = sc ? sc.depots.filter((d) => d.ajoutes.length || d.modifies.length || d.supprimes.length) : [];
    const mrs = sc ? sc.depots.filter((d) => d.zone === 'tests' && d.mr_url) : [];
    if (mrs.length) mrTests = mrs.every((d) => d.mr_pret) ? 'prete' : 'brouillon';
    const erreurEcrire = sc && sc.erreur && sc.cause !== 'rouge' ? (attention ? 'a_toi' : 'echec') : null;
    if (sc && sc.couvert && !touches.length) {
      out.push({ cle: 'scen-ecrire', etat: 'fait', couvert: sc.couvert.par, detail: sc.couvert.raison || '' });
      for (const v of noms) out.push({ cle: 'scen-rejouer', nom: v.nom, verifier_id: v.id, etat: 'saute' });
    } else {
      if (!touches.length) {
        let etat = 'a_venir';
        if (sc && sc.en_cours === 'ecrire') etat = 'en_cours';
        else if (erreurEcrire) etat = erreurEcrire;
        out.push({ cle: 'scen-ecrire', etat, detail: etat === 'a_toi' || etat === 'echec' ? sc.erreur : '' });
      } else {
        touches.forEach((d, i) => out.push({ cle: 'scen-ecrire', etat: erreurEcrire && i === touches.length - 1 ? erreurEcrire : 'fait', projet: d.project, zone: d.zone,
          compte: { ajoutes: d.ajoutes.length, modifies: d.modifies.length, supprimes: d.supprimes.length },
          ...(d.zone === 'tests' && d.mr_url ? { mr: { url: d.mr_url, iid: d.mr_iid, pret: !!d.mr_pret } } : {}),
          detail: erreurEcrire && i === touches.length - 1 ? sc.erreur : '' }));
      }
      const parId = new Map(((sc && sc.rejeu) || []).map((r) => [r.verifier_id, r]));
      for (const v of noms) {
        const r = parId.get(v.id);
        out.push({ cle: 'scen-rejouer', nom: v.nom, verifier_id: v.id, etat: r ? etatCote(r, attention) : 'a_venir',
          essai: r ? r.essai || 0 : 0, verification_id: r ? r.verification_id || null : null });
      }
      if (sc && (sc.en_cours === 'corriger' || sc.corrections)) {
        out.push({ cle: 'scen-corriger', etat: sc.en_cours === 'corriger' ? 'en_cours' : 'fait', n: sc.corrections || 0, max: sc.max });
      }
    }
  }
  const valide = chaine && ['validated', 'passed'].includes(chaine.status);
  // Les tests d'un dépôt séparé vivent dans leur merge request : la validation dit où elle en est.
  out.push({ cle: 'validee', etat: valide ? 'fait' : 'a_venir', ...(mrTests ? { mr_tests: mrTests } : {}) });
  return out;
}

function frise(task, { chaine = null, job = null } = {}) {
  const cibles = db.prepare(`SELECT tt.id, tt.repo_id, tt.status, tt.commit_sha, tt.mr_iid, tt.mr_url, tt.last_error, r.project FROM task_target tt
    JOIN repo r ON r.id = tt.repo_id WHERE tt.task_id = ? ORDER BY tt.id`).all(task.id);
  const plusieurs = cibles.length > 1;
  const jobKind = job ? (db.prepare('SELECT kind FROM job WHERE id = ?').get(job.jobId) || {}).kind : null;
  const etapes = [];

  /* PAR PROJET : son codage, son push, sa boucle de convergence — chaque étape porte son projet quand la session
     en a plusieurs, et l'écran dessine une frise par projet. La chaîne, qui porte sur l'ensemble, vient après. */
  const pousser = task.auto_push || task.verify_chain || task.converge_after || jobKind === 'converge-session';
  const maxDefaut = Number(getConfig().converge_max_passes) || 3;
  const unTourne = cibles.some((c) => c.status === 'running');
  for (const c of cibles) {
    const projet = plusieurs ? c.project : null;
    const debut = etapes.length;
    // Chaque étape de ce projet porte sa cible : la carte la range sous la ligne du dépôt.
    const marquer = () => { for (let k = debut; k < etapes.length; k += 1) etapes[k].cible = c.id; };
    const codeFait = !!c.commit_sha || ['committed', 'pushed', 'done'].includes(c.status);
    let codage = 'a_venir';
    if (codeFait) codage = 'fait';
    else if (c.status === 'needs_input' || task.status === 'planned') codage = 'a_toi';
    else if (c.status === 'running') codage = 'en_cours';
    else if (c.status === 'error') codage = 'echec';
    else if (job) codage = job.enFile || unTourne ? 'en_file' : 'en_cours';
    else if (task.status === 'needs_input' && !plusieurs) codage = 'a_toi';
    else if (task.status === 'error' && !plusieurs) codage = 'echec';
    const erreur = codage === 'echec' ? String(c.last_error || task.last_error || '').split('\n')[0].slice(0, 200) : '';
    etapes.push({ cle: 'code', etat: codage, projet, detail: erreur });

    // Le push : poussé (une MR ouverte l'a été) — en cours tant que le job tourne sur du code fait.
    const pousse = c.status === 'pushed' || !!c.mr_iid;
    if (pousser || pousse) {
      // La MR ouverte voyage avec le push : la phase Code la donne en lien.
      etapes.push({ cle: 'push', etat: pousse ? 'fait' : (codeFait && job ? 'en_cours' : 'a_venir'), projet, mr_iid: c.mr_iid || null, mr_url: c.mr_url || null });
    }

    // La convergence de ce projet, lancée pour cette session (après sa création).
    const mr = c.mr_iid ? db.prepare('SELECT id FROM mr WHERE repo_id = ? AND iid = ?').get(c.repo_id, c.mr_iid) : null;
    const run = mr ? db.prepare('SELECT * FROM convergence_run WHERE mr_id = ? AND started_at >= ? ORDER BY id DESC LIMIT 1').get(mr.id, task.created_at || '') : null;
    // Pas encore de boucle : elle viendra si le job converge, ou si la session pas encore lancée doit converger.
    if (run || jobKind === 'converge-session' || (task.converge_after && ['new', 'running'].includes(task.status))) {
      etapes.push(...etapesConvergence(run, projet, maxDefaut));
    }
    marquer();
  }

  const avantChaine = etapes.length;
  if (task.verify_chain) etapes.push(...etapesChaine(task, chaine));
  else if (task.verifier_id) { const v = etapeVerificateur(task); if (v) etapes.push(v); }
  /* PLUSIEURS PROJETS : la validation porte sur l'ensemble, mais chaque frise de dépôt doit rester entière.
     Une étape de vérificateur va donc dans la frise des dépôts qu'il couvre (`cibles`) ; un vérificateur qui
     n'en couvre aucun (il teste un dépôt de tests, les projets mis en position), le scénario et « validée »
     vont dans toutes. */
  if (plusieurs) {
    const toutes = cibles.map((c) => c.id);
    const couvertes = new Map();
    for (const e of etapes.slice(avantChaine)) {
      if (e.verifier_id && !couvertes.has(e.verifier_id)) {
        const cov = groupes.couvertureVerifier(e.verifier_id);
        couvertes.set(e.verifier_id, cibles.filter((c) => cov.has(c.repo_id)).map((c) => c.id));
      }
      const siennes = e.verifier_id ? couvertes.get(e.verifier_id) : [];
      e.cibles = siennes.length ? siennes : toutes;
    }
  }

  /* Rien d'actif alors que la session attend ou a échoué : une question posée par un suivi après le codage,
     un push refusé. L'attente se pose sur le codage, l'échec sur la dernière étape faite de la session. */
  // (Une session sans projet — importée, ou dont les dépôts ont disparu — n'a pas d'étape où le poser.)
  if (etapes.length && !etapes.some((e) => ACTIVES.has(e.etat)) && !job) {
    if (task.status === 'needs_input' || task.status === 'planned') etapes[0].etat = 'a_toi';
    else if (task.status === 'error') {
      const i = etapes[1] && etapes[1].cle === 'push' && etapes[0].etat === 'fait' ? 1 : 0;
      etapes[i].etat = 'echec';
      etapes[i].detail = String(task.last_error || '').split('\n')[0].slice(0, 200);
    }
  }
  poserDepuis(etapes, { job, attente: () => task.updated_at || null });
  const courante = etapes.findIndex((e) => ACTIVES.has(e.etat));
  return { etapes, courante: courante < 0 ? null : courante, continuer: job ? null : continuer(task, etapes, courante, cibles, chaine) };
}

/* « CONTINUER » : ce qui fait repartir le déroulé arrêté sur une étape — rien quand un job tourne. L'écran
   appelle la route existante de l'action : `code` relance le codage des projets sans commit, `push` pousse
   ce qui est commité, `converge` reprend la convergence (le code déjà fait n'est pas refait, la MR ouverte
   est reprise, puis la chaîne part d'elle-même), `chaine` relance la chaîne — ou la démarre si elle n'est
   jamais partie —, `repondre` ouvre la session : une question attend une réponse, rien ne peut la sauter. */
function continuer(task, etapes, courante, cibles, chaine) {
  const e = courante >= 0 ? etapes[courante] : null;
  // Une question pendant une correction de convergence : une fois répondue, la convergence se reprend.
  const repondue = task.status !== 'needs_input' && !cibles.some((c) => c.status === 'needs_input');
  if (e && e.etat === 'a_toi' && e.cle === 'fix' && repondue) return { action: 'converge' };
  if (e && e.etat === 'a_toi' && (e.cle === 'code' || e.cle === 'fix')) return { action: 'repondre' };
  if (e && e.etat === 'echec') {
    if (e.cle === 'code') {
      const ids = cibles.filter((c) => !c.commit_sha && !['committed', 'pushed', 'done'].includes(c.status)).map((c) => c.id);
      return { action: 'code', targets: ids.length ? ids : cibles.map((c) => c.id) };
    }
    if (e.cle === 'push') return { action: 'push' };
    if (['review', 'fix', 'converge-fin'].includes(e.cle)) return { action: 'converge' };
  }
  if (e && (e.etat === 'echec' || e.etat === 'a_toi') && (e.cle === 'diag' || e.cle === 'verif' || e.cle.startsWith('scen-'))) {
    return task.verify_chain ? { action: 'chaine' } : null;
  }
  // Rien d'arrêté, mais la chaîne n'est jamais partie alors que le code est poussé : elle se démarre.
  const pousse = etapes.some((x) => x.cle === 'push' && x.etat === 'fait');
  const convergenceFinie = !etapes.some((x) => (x.cle === 'review' || x.cle === 'fix') && x.etat !== 'fait' && !x.si);
  if (courante < 0 && task.verify_chain && !chaine && pousse && convergenceFinie) return { action: 'chaine' };
  return null;
}

/* LA FRISE D'UNE SESSION HORS DÉPÔT : par dossier, le codage, puis — avec une branche — le commit, le push, la
   merge request et la boucle de convergence. Plusieurs dossiers : chaque étape dit le sien. */
function friseLocale(lt, { job = null } = {}) {
  const dirs = db.prepare('SELECT * FROM local_task_dir WHERE task_id = ? ORDER BY id').all(lt.id);
  const plusieurs = dirs.length > 1;
  const converger = !!lt.converge_after || !!(job && job.entry && job.entry.opts && job.entry.opts.converger);
  const maxDefaut = Number(getConfig().converge_max_passes) || 3;
  const etapes = [];
  for (const d of dirs) {
    const projet = plusieurs ? (d.dir_label || '?') : null;
    const debut = etapes.length;
    etapesDossier(d, projet);
    // Chaque étape de ce dossier porte sa cible : la carte la range sous la ligne du dossier.
    for (let k = debut; k < etapes.length; k += 1) etapes[k].cible = d.id;
  }
  function etapesDossier(d, projet) {
    let code = 'a_venir';
    if (d.status === 'done') code = 'fait';
    else if (d.status === 'running') code = 'en_cours';
    else if (d.status === 'needs_input') code = 'a_toi';
    else if (d.status === 'error') code = 'echec';
    else if (job) code = 'en_file';
    etapes.push({ cle: 'code', etat: code, projet, dir_id: d.id, detail: code === 'echec' ? String(d.last_error || '').split('\n')[0].slice(0, 200) : '' });
    if (!lt.branch) return;
    const gs = d.git_status || '';
    const note = String(d.git_note || '');
    const enRoute = code === 'fait' && !!job;
    etapes.push({ cle: 'commit', etat: ['committed', 'pushed'].includes(gs) ? 'fait' : gs === 'unchanged' ? 'saute' : enRoute ? 'en_cours' : 'a_venir', projet, dir_id: d.id });
    if (gs === 'unchanged') return;   // rien de modifié : ni push, ni MR, ni convergence
    // Une MR déjà ouverte (« Converger » depuis la carte, sans les cases) garde ses étapes.
    if (lt.auto_push || lt.create_mr || converger || gs === 'pushed') {
      etapes.push({ cle: 'push', etat: gs === 'pushed' ? 'fait' : (gs === 'committed' && enRoute ? 'en_cours' : 'a_venir'), projet, dir_id: d.id });
    }
    if (!(lt.create_mr || converger || d.mr_iid)) return;
    let mr = 'a_venir';
    if (d.mr_iid) mr = 'fait';
    else if (note === 'no-origin' || note === 'no-repo') mr = 'saute';
    else if (note.startsWith('mr-error')) mr = 'echec';
    else if (gs === 'pushed' && job) mr = 'en_cours';
    etapes.push({ cle: 'mr', etat: mr, projet, dir_id: d.id, mr_iid: d.mr_iid || null, mr_url: d.mr_url || null, detail: mr === 'saute' ? note : mr === 'echec' ? note.replace(/^mr-error:\s*/, '') : '' });
    if (mr === 'saute') return;
    const mrRow = d.mr_iid && d.repo_id ? db.prepare('SELECT id FROM mr WHERE repo_id = ? AND iid = ?').get(d.repo_id, d.mr_iid) : null;
    const run = mrRow ? db.prepare('SELECT * FROM convergence_run WHERE mr_id = ? AND started_at >= ? ORDER BY id DESC LIMIT 1').get(mrRow.id, lt.created_at || '') : null;
    if (run || converger) etapes.push(...etapesConvergence(run, projet, maxDefaut));
  }
  if (!etapes.some((e) => ACTIVES.has(e.etat)) && !job && lt.status === 'error' && etapes.length) {
    etapes[0].etat = 'echec';
    etapes[0].detail = String(lt.last_error || '').split('\n')[0].slice(0, 200);
  }
  const parDossier = new Map(dirs.map((d) => [d.id, d]));
  poserDepuis(etapes, { job, attente: (e) => ((parDossier.get(e.dir_id) || {}).updated_at || lt.updated_at || null) });
  const courante = etapes.findIndex((e) => ACTIVES.has(e.etat));
  return { etapes, courante: courante < 0 ? null : courante, continuer: job ? null : continuerLocal(lt, etapes, courante) };
}

/* « Continuer » hors dépôt : un dossier en échec se recode (lui seul) ; un commit, un push, une MR ou une
   convergence arrêtés reprennent par « Converger » quand la session devait converger — c'est lui qui pousse
   ce qui ne l'est pas, ouvre la MR et boucle ; une question ouvre la session. */
function continuerLocal(lt, etapes, courante) {
  const e = courante >= 0 ? etapes[courante] : null;
  if (!e) return null;
  if (e.etat === 'a_toi' && e.cle === 'code') return { action: 'repondre' };
  if (e.etat === 'echec' && e.cle === 'code') {
    const ids = [...new Set(etapes.filter((x) => x.cle === 'code' && x.etat === 'echec').map((x) => x.dir_id))].filter(Boolean);
    return { action: 'code', targets: ids };
  }
  if ((e.etat === 'echec' || e.etat === 'a_toi') && ['commit', 'push', 'mr', 'review', 'fix', 'converge-fin'].includes(e.cle) && lt.branch && lt.converge_after) {
    return { action: 'converge' };
  }
  return null;
}

module.exports = { frise, friseLocale, etapesConvergence };
