'use strict';
/* Horaires d'agent (spec agents §8.9 et §12).
 *
 * Une grammaire de trois formes, pas cron. `cron` sait tout faire, y compris « toutes les
 * minutes » et « le 31 février » ; ici on veut trois cas — chaque jour, chaque semaine,
 * chaque mois — écrits d'une façon qu'on relise sans manuel, et affichés en toutes lettres.
 *
 *   daily HH:MM
 *   weekly (mon|tue|wed|thu|fri|sat|sun) HH:MM
 *   monthly (1..28) HH:MM
 *
 * Le 28 est le plafond du mensuel à dessein : un « monthly 31 » ne se déclencherait pas en
 * février, et un horaire qui saute un mois sur deux sans rien dire est pire que pas d'horaire.
 * Heure LOCALE du serveur — c'est la machine de l'utilisateur, et « 7:00 » veut dire 7:00.
 */

const db = require('./db');
const { getConfig } = require('./config');
const { t } = require('../public/i18n-runtime.js');

const JOURS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parse(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^daily\s+(\d{1,2}):(\d{2})$/);
  if (m) return heure({ kind: 'daily' }, m[1], m[2]);
  m = s.match(/^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):(\d{2})$/);
  if (m) return heure({ kind: 'weekly', dow: JOURS.indexOf(m[1]) }, m[2], m[3]);
  m = s.match(/^monthly\s+(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const dom = Number(m[1]);
    if (dom < 1 || dom > 28) return null;
    return heure({ kind: 'monthly', dom }, m[2], m[3]);
  }
  return null;
}

function heure(base, hh, mm) {
  const h = Number(hh); const mi = Number(mm);
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
  return { ...base, hh: h, mm: mi };
}

// La forme canonique : ce qu'on stocke, quel que soit ce qui a été tapé.
function canonique(spec) {
  if (!spec) return null;
  const hhmm = `${String(spec.hh).padStart(2, '0')}:${String(spec.mm).padStart(2, '0')}`;
  if (spec.kind === 'daily') return `daily ${hhmm}`;
  if (spec.kind === 'weekly') return `weekly ${JOURS[spec.dow]} ${hhmm}`;
  return `monthly ${spec.dom} ${hhmm}`;
}

/* Le DERNIER créneau passé, à `now` compris. On raisonne sur le passé et non sur le futur :
   « est-ce que le créneau de ce matin a déjà été honoré ? » se répond en comparant ce créneau
   à `schedule_fired_at`, et un serveur éteint à 7:00 rattrape son run à 9:00 au lieu de le
   perdre. Un « prochain créneau » aurait sauté la journée. */
function prochainCreneau(spec, now = new Date()) {
  if (!spec) return null;
  const d = new Date(now.getTime());
  d.setSeconds(0, 0);
  const poser = (jour) => { const x = new Date(jour.getTime()); x.setHours(spec.hh, spec.mm, 0, 0); return x; };
  if (spec.kind === 'daily') {
    const aujourdhui = poser(d);
    if (aujourdhui <= d) return aujourdhui;
    return new Date(aujourdhui.getTime() - 86400000);
  }
  if (spec.kind === 'weekly') {
    const cible = poser(d);
    // Recule jour par jour jusqu'au bon jour de semaine, à l'heure dite, sans dépasser `now`.
    for (let i = 0; i < 8; i += 1) {
      const c = new Date(cible.getTime() - i * 86400000);
      if (c.getDay() === spec.dow && c <= d) return c;
    }
    return null;
  }
  // Mensuel : ce mois-ci si le jour est passé, sinon le mois précédent.
  const ceMois = new Date(d.getFullYear(), d.getMonth(), spec.dom, spec.hh, spec.mm, 0, 0);
  if (ceMois <= d) return ceMois;
  return new Date(d.getFullYear(), d.getMonth() - 1, spec.dom, spec.hh, spec.mm, 0, 0);
}

/* Les agents DUS : un horaire, une borne de tours (sans elle la sauvegarde a refusé, mais une
   base héritée pourrait en porter un), et un créneau passé plus récent que le dernier tir. */
function dus(now = new Date()) {
  const out = [];
  for (const a of db.prepare('SELECT * FROM agent WHERE schedule IS NOT NULL AND schedule <> \'\'').all()) {
    if (!(Number(a.max_turns) > 0)) continue;
    const spec = parse(a.schedule);
    if (!spec) continue;
    const creneau = prochainCreneau(spec, now);
    if (!creneau) continue;
    if (a.schedule_fired_at && new Date(a.schedule_fired_at) >= creneau) continue;
    out.push({ agent: a, creneau });
  }
  return out;
}

// Combien de runs l'horaire a déclenchés depuis minuit (heure locale).
function lancesAujourdhui(now = new Date()) {
  const minuit = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString();
  return db.prepare("SELECT COUNT(*) n FROM task WHERE triggered_by = 'schedule' AND created_at >= ?")
    .get(minuit).n;
}

/* Un tick. Isolé de `demarrer` pour qu'un test puisse le déclencher sans attendre la minute —
   attendre soixante secondes dans un test, c'est parier sur l'horloge d'une machine chargée. */
function tick(now = new Date(), onLog = () => {}) {
  // eslint-disable-next-line global-require
  const agentprofile = require('./agentprofile');
  const cfg = getConfig();
  const plafond = Number(cfg.agent_auto_max);
  const lances = [];
  for (const { agent, creneau } of dus(now)) {
    /* Le plafond atteint N'EMPÊCHE PAS d'écrire l'heure de tir : sans ça, l'agent serait
       « dû » à chaque minute jusqu'à minuit, et le journal se remplirait de refus. */
    const marquer = () => db.prepare('UPDATE agent SET schedule_fired_at = ? WHERE id = ?')
      .run(creneau.toISOString(), agent.id);
    if (plafond > 0 && lancesAujourdhui(now) >= plafond) {
      onLog(t('agents.log.auto-max', { n: plafond, name: agent.name }));
      marquer();
      continue;
    }
    try {
      /* Un agent de DOMAINE planifié ne relance pas sa propre exploration : il fait vieillir
         sa connaissance, donc c'est une MISE À JOUR qu'on programme. */
      if (agent.knowledge_prompt) {
        // eslint-disable-next-line global-require
        lances.push(require('./agentknowledge').refresh(agentprofile.lire(agent.id), 'schedule'));
      } else {
        lances.push(agentprofile.lancer(agentprofile.lire(agent.id), {
          mode: 'ask', question: '', triggeredBy: 'schedule',
        }));
      }
      onLog(t('agents.log.scheduled', { name: agent.name }));
    } catch (e) {
      onLog(t('agents.log.schedule-failed', { name: agent.name, message: e.message }));
    }
    marquer();
  }
  return lances;
}

let minuterie = null;
function demarrer(onLog = () => {}) {
  arreter();
  // Une minute : la granularité de la grammaire. Plus fin ne servirait à rien, plus large
  // ferait manquer un créneau à qui redémarre l'outil au mauvais moment.
  minuterie = setInterval(() => { try { tick(new Date(), onLog); } catch { /* tick best-effort */ } }, 60000);
  if (minuterie.unref) minuterie.unref();
  return minuterie;
}
function arreter() { if (minuterie) { clearInterval(minuterie); minuterie = null; } }

// La phrase affichée : « chaque lundi à 07:00 ». Le stockage reste la forme canonique.
function phrase(text) {
  const spec = parse(text);
  if (!spec) return '';
  const hhmm = `${String(spec.hh).padStart(2, '0')}:${String(spec.mm).padStart(2, '0')}`;
  if (spec.kind === 'daily') return t('agents.schedule.said-daily', { time: hhmm });
  if (spec.kind === 'weekly') return t('agents.schedule.said-weekly', { day: t(`agents.schedule.dow.${JOURS[spec.dow]}`), time: hhmm });
  return t('agents.schedule.said-monthly', { day: spec.dom, time: hhmm });
}

module.exports = { parse, canonique, prochainCreneau, dus, tick, demarrer, arreter, phrase, lancesAujourdhui, JOURS };
