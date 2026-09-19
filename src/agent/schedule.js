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

const db = require('../db');
const { etat } = require('../data/localstate');
const identite = require('../core/identite');
const { getConfig } = require('../data/config');
const { t } = require('../core/i18n');

const { JOURS, parse, canonique, prochainCreneau, creneauSuivant, phrase } = require('./horaire');

/* CET AGENT EST-IL LE MIEN ? En mono-poste, `runner` est vide et tout ce qui est planifié
   tourne ici, comme avant. Dès qu'un dépôt de données est configuré, un agent sans exécutant
   ne tourne NULLE PART tout seul : il faut avoir désigné quelqu'un. */
function estMonAgent(a) {
  const partage = String(getConfig().data_repo_url || '').trim();
  const exécutant = String(a.runner || '').trim();
  if (!partage) return !exécutant || exécutant === identite.nom();
  return Boolean(exécutant) && exécutant === identite.nom();
}

/* Les agents DUS : un horaire, une borne de tours (sans elle la sauvegarde a refusé, mais une
   base héritée pourrait en porter un), et un créneau passé plus récent que le dernier tir. */
function dus(now = new Date()) {
  const out = [];
  for (const a of db.prepare('SELECT * FROM agent WHERE schedule IS NOT NULL AND schedule <> \'\'').all()) {
    if (!(Number(a.max_turns) > 0)) continue;
    /* L'EXÉCUTANT. À plusieurs, trois instances allumées lanceraient trois fois le même agent
       planifié — chacune persuadée d'être la seule, et l'équipe paierait trois fois. `runner`
       porte l'identité git de celui qui l'honore ; VIDE = personne, l'agent ne tourne qu'à la
       main. C'est le défaut, et c'est le bon : un agent qui se met à tourner tout seul chez un
       collègue parce qu'on a coché une case chez soi serait une mauvaise surprise. */
    if (!estMonAgent(a)) continue;
    const spec = parse(a.schedule);
    if (!spec) continue;
    const creneau = prochainCreneau(spec, now);
    if (!creneau) continue;
    /* La DERNIÈRE FOIS QUE CET AGENT A TOURNÉ ICI. L'information est de poste, pas d'équipe :
       trois instances allumées lanceraient sinon trois fois le même agent, chacune persuadée
       que le tir de la voisine était le sien. Elle vit donc dans `local_state`. */
    const tire = etat.lire('agent', a.uid, 'schedule_fired_at');
    if (tire && new Date(tire) >= creneau) continue;
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
  const agentprofile = require('./profile');
  const cfg = getConfig();
  const plafond = Number(cfg.agent_auto_max);
  const lances = [];
  for (const { agent, creneau } of dus(now)) {
    /* Le plafond atteint N'EMPÊCHE PAS d'écrire l'heure de tir : sans ça, l'agent serait
       « dû » à chaque minute jusqu'à minuit, et le journal se remplirait de refus. */
    const marquer = () => etat.ecrire('agent', agent.uid, 'schedule_fired_at', creneau.toISOString());
    if (plafond > 0 && lancesAujourdhui(now) >= plafond) {
      onLog(t('agents.log.auto-max', { n: plafond, name: agent.name }));
      marquer();
      continue;
    }
    /* PAS D'HORAIRE HONORÉ POUR UN AGENT DONT LES PERMISSIONS ONT CHANGÉ SANS ÊTRE VUES ICI.
       On marque le créneau : sinon il redeviendrait « dû » chaque minute jusqu'à minuit. */
    // eslint-disable-next-line global-require
    if (!require('../data/approbation').agentApprouve(agent.id)) {
      onLog(t('agents.log.schedule-not-approved', { name: agent.name }));
      marquer();
      continue;
    }
    try {
      /* Un agent de DOMAINE planifié ne relance pas sa propre exploration : il fait vieillir
         sa connaissance, donc c'est une MISE À JOUR qu'on programme. */
      if (agent.knowledge_prompt) {
        // eslint-disable-next-line global-require
        lances.push(require('./knowledge').refresh(agentprofile.lire(agent.id), 'schedule'));
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

/* La grammaire (`horaire.js`) reste exportée d'ici : ce que l'écran et les tests appellent
   n'a pas changé de nom. */
module.exports = {
  creneauSuivant, parse, canonique, prochainCreneau, dus, tick, demarrer, arreter, phrase, lancesAujourdhui, JOURS };
