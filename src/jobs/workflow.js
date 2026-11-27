'use strict';
/* LA FRISE D'UNE SESSION DE CODAGE, pour le cockpit : toutes les étapes de son déroulé, dans l'ordre, chacune
   avec son état — ce qui est fait, ce qui tourne, ce qui attend, ce qui viendra. Une lecture, aucun appel :
   l'état des projets, du job, des boucles de convergence, de la chaîne de validation et de son scénario.

     codage → push → [review, puis correction + review par passe] → [vérificateur : base, branche, diagnostic]…
            → [scénario : écrire, pousser, lancer] → validée

   Une étape porte `cle` (l'écran la nomme), `etat` (fait · en_cours · en_file · a_toi · echec · a_venir ·
   saute) et ce qui la précise : `n` (la passe), `nom` (le vérificateur), `projet`, `note`, `essai`, `detail`,
   `verification_id`. `si` marque une étape qui n'aura lieu que si la précédente ne suffit pas (une passe de
   convergence de plus, tant que la note reste sous le seuil). `courante` : l'index de la première étape qui
   tourne, attend ou a échoué. */
const db = require('../db');
const { getConfig } = require('../data/config');
const groupes = require('../data/groupes');
const scenarioMod = require('./chaine-scenario');

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
  if (!run) {
    out.push({ cle: 'review', n: 0, etat: 'a_venir', projet });
    for (let k = 1; k <= maxDefaut; k += 1) {
      out.push({ cle: 'fix', n: k, etat: 'a_venir', projet, si: true }, { cle: 'review', n: k, etat: 'a_venir', projet, si: true });
    }
    return out;
  }
  const notesLues = lire(run.notes_json, null);
  const notes = notesLues || [run.start_note];
  const p = run.passes_done || 0;
  const tourne = run.status === 'running';
  // Coupée (erreur, arrêt, serveur arrêté) : l'étape où elle en était porte l'échec.
  const coupe = run.status === 'error' || run.status === 'stopped';
  // Pas encore de note de départ : la première review tourne (la MR n'en avait pas, ou une périmée).
  const initialeEnCours = tourne && run.phase === 'review' && p === 0 && !notesLues;
  out.push({ cle: 'review', n: 0, etat: initialeEnCours ? 'en_cours' : (coupe && p === 0 && run.phase === 'review' && !notesLues ? 'echec' : 'fait'), projet, note: notes[0] == null ? null : notes[0] });
  for (let k = 1; k <= run.max_passes; k += 1) {
    if (k <= p) {
      out.push({ cle: 'fix', n: k, etat: 'fait', projet });
      let etat = 'fait';
      if (k === p && tourne && run.phase === 'review') etat = 'en_cours';
      else if (k === p && coupe && run.phase === 'review') etat = 'echec';
      out.push({ cle: 'review', n: k, etat, projet, note: notes[k] == null ? null : notes[k] });
      continue;
    }
    if (k === p + 1 && run.status === 'needs_input') { out.push({ cle: 'fix', n: k, etat: 'a_toi', projet }); break; }
    if (k === p + 1 && coupe && run.phase === 'fix') { out.push({ cle: 'fix', n: k, etat: 'echec', projet, detail: run.message || '' }); break; }
    if (!tourne) break;   // finie : les passes qui n'ont pas eu lieu n'auront pas lieu
    const enCours = k === p + 1 && run.phase === 'fix';
    out.push({ cle: 'fix', n: k, etat: enCours ? 'en_cours' : 'a_venir', projet, si: !enCours },
      { cle: 'review', n: k, etat: 'a_venir', projet, si: !enCours });
  }
  if (!tourne && run.status !== 'needs_input' && !(coupe && run.phase)) {
    out.push({ cle: 'converge-fin', etat: coupe ? 'echec' : 'fait', projet, detail: run.status, note: run.best_note == null ? null : run.best_note });
  }
  return out;
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
  return { cle: 'verif', nom: v.name, etat, verification_id: run ? run.id : null };
}

/* La chaîne : chaque vérificateur sur la base puis la branche (et son diagnostic), puis le scénario. */
function etapesChaine(task, chaine) {
  const out = [];
  const attention = !!(chaine && chaine.status === 'attention');
  if (chaine && chaine.steps) {
    for (const s of chaine.steps) {
      const base = { cle: 'verif', cote: 'base', nom: s.verifier_name, etat: etatCote(s.base, attention), essai: s.base.essai || 0, verification_id: s.base.verification_id || null };
      const head = { cle: 'verif', cote: 'head', nom: s.verifier_name, etat: base.etat === 'fait' ? etatCote(s.head, attention) : 'a_venir', essai: (s.head && s.head.essai) || 0, verification_id: (s.head && s.head.verification_id) || null };
      if (s.erreur) (base.etat === 'fait' ? head : base).etat = attention ? 'a_toi' : 'echec';
      if (s.erreur) (base.etat === 'fait' ? head : base).detail = s.erreur;
      out.push(base, head);
      if (s.diag) {
        let etat = 'fait';
        if (s.diag.en_cours) etat = 'en_cours';
        else if (s.diag.cause && s.diag.cause !== 'branche') etat = 'a_toi';
        out.push({ cle: 'diag', nom: s.verifier_name, etat, n: s.diag.rounds, detail: s.diag.cause || '' });
      }
    }
  } else {
    for (const id of lire(task.verify_chain, [])) {
      const v = db.prepare('SELECT name FROM verifier WHERE id = ?').get(Number(id));
      if (!v) continue;
      out.push({ cle: 'verif', cote: 'base', nom: v.name, etat: 'a_venir' }, { cle: 'verif', cote: 'head', nom: v.name, etat: 'a_venir' });
    }
  }
  const cfgScen = lire(scenarioMod.normaliserScenario(task.verify_chain_scenario), null);   // rendue en JSON
  if (cfgScen) {
    const projets = db.prepare('SELECT repo_id FROM task_target WHERE task_id = ?').all(task.id);
    const tests = scenarioMod.depotTests(cfgScen.verifier_id, projets, groupes.couvertureVerifier).repo;
    const projet = tests ? tests.project : null;
    const sc = (chaine && chaine.scenario) || null;
    const fichiers = (sc && sc.fichiers) || [];
    if (sc && sc.couvert) {
      out.push({ cle: 'scen-ecrire', etat: 'fait', projet, detail: sc.couvert.par || '' },
        { cle: 'scen-pousser', etat: 'saute', projet }, { cle: 'scen-lancer', etat: 'saute', projet });
    } else {
      let ecrire = 'a_venir';
      if (sc && sc.en_cours === 'ecrire') ecrire = 'en_cours';
      else if (fichiers.length) ecrire = 'fait';
      else if (sc && sc.erreur) ecrire = attention ? 'a_toi' : 'echec';
      out.push({ cle: 'scen-ecrire', etat: ecrire, projet, detail: ecrire === 'a_toi' || ecrire === 'echec' ? sc.erreur : fichiers.join(' ') });
      out.push({ cle: 'scen-pousser', etat: fichiers.length ? 'fait' : 'a_venir', projet, detail: sc && sc.branche ? sc.branche : '' });
      let lancer = fichiers.length ? etatCote(sc.run, attention) : 'a_venir';
      if (sc && sc.en_cours === 'corriger') lancer = 'echec';
      if (fichiers.length && sc.erreur && lancer !== 'echec') lancer = attention ? 'a_toi' : 'echec';
      out.push({ cle: 'scen-lancer', etat: lancer, projet, essai: sc && sc.run ? sc.run.essai || 0 : 0, verification_id: sc && sc.run ? sc.run.verification_id || null : null,
        detail: sc && sc.erreur && fichiers.length ? sc.erreur : '' });
      if (sc && (sc.en_cours === 'corriger' || sc.corrections)) {
        out.push({ cle: 'scen-corriger', etat: sc.en_cours === 'corriger' ? 'en_cours' : 'fait', n: sc.corrections || 0 });
      }
    }
  }
  const valide = chaine && ['validated', 'passed'].includes(chaine.status);
  out.push({ cle: 'validee', etat: valide ? 'fait' : 'a_venir' });
  return out;
}

function frise(task, { chaine = null, job = null } = {}) {
  const cibles = db.prepare(`SELECT tt.id, tt.repo_id, tt.status, tt.commit_sha, tt.mr_iid, r.project FROM task_target tt
    JOIN repo r ON r.id = tt.repo_id WHERE tt.task_id = ? ORDER BY tt.id`).all(task.id);
  const plusieurs = cibles.length > 1;
  const jobKind = job ? (db.prepare('SELECT kind FROM job WHERE id = ?').get(job.jobId) || {}).kind : null;
  const etapes = [];

  const codeFait = cibles.length > 0 && cibles.every((c) => c.commit_sha || ['committed', 'pushed', 'done'].includes(c.status));
  let codage = 'a_venir';
  if (codeFait) codage = 'fait';
  else if (task.status === 'needs_input' || task.status === 'planned') codage = 'a_toi';
  else if (job) codage = job.enFile ? 'en_file' : 'en_cours';
  else if (task.status === 'running') codage = 'en_cours';
  else if (task.status === 'error') codage = 'echec';
  etapes.push({ cle: 'code', etat: codage, detail: codage === 'echec' ? String(task.last_error || '').split('\n')[0].slice(0, 200) : '' });

  // Le push : tout projet poussé (une MR ouverte l'a été) — en cours tant que le job tourne sur du code fait.
  if (task.auto_push || task.verify_chain || jobKind === 'converge-session') {
    const pousse = cibles.length > 0 && cibles.every((c) => c.status === 'pushed' || c.mr_iid);
    etapes.push({ cle: 'push', etat: pousse ? 'fait' : (codeFait && job ? 'en_cours' : 'a_venir') });
  }

  // La convergence : une boucle par projet, lancée pour cette session (après sa création).
  const maxDefaut = Number(getConfig().converge_max_passes) || 3;
  for (const c of cibles) {
    const mr = c.mr_iid ? db.prepare('SELECT id FROM mr WHERE repo_id = ? AND iid = ?').get(c.repo_id, c.mr_iid) : null;
    const run = mr ? db.prepare('SELECT * FROM convergence_run WHERE mr_id = ? AND started_at >= ? ORDER BY id DESC LIMIT 1').get(mr.id, task.created_at || '') : null;
    if (!run && jobKind !== 'converge-session') continue;
    etapes.push(...etapesConvergence(run, plusieurs ? c.project : null, maxDefaut));
  }

  if (task.verify_chain) etapes.push(...etapesChaine(task, chaine));
  else if (task.verifier_id) { const v = etapeVerificateur(task); if (v) etapes.push(v); }

  /* Rien d'actif alors que la session attend ou a échoué : une question posée par un suivi après le codage,
     un push refusé. L'attente se pose sur le codage, l'échec sur la dernière étape faite de la session. */
  if (!etapes.some((e) => ACTIVES.has(e.etat)) && !job) {
    if (task.status === 'needs_input' || task.status === 'planned') etapes[0].etat = 'a_toi';
    else if (task.status === 'error') {
      const i = etapes[1] && etapes[1].cle === 'push' && etapes[0].etat === 'fait' ? 1 : 0;
      etapes[i].etat = 'echec';
      etapes[i].detail = String(task.last_error || '').split('\n')[0].slice(0, 200);
    }
  }
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

module.exports = { frise, etapesConvergence };
