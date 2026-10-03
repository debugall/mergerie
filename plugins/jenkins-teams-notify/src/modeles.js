'use strict';
/* Ce qui est PUR dans jenkins-teams-notify : les modèles de message, le filtre de jobs, le classement d'un
   événement Jenkins. Rien ici ne touche le ctx, le réseau ni le disque — c'est ce qui se teste
   sans rien lancer. */

/* Les variables d'un modèle. Elles viennent TOUTES du payload d'un événement `jenkins.job.*` —
   jamais d'une session, d'une merge request ou d'un dépôt : c'est la garantie de confidentialité
   du plugin, et `variablesDe` est le seul endroit où elle se tient. */
const VARIABLES = ['job', 'number', 'url', 'result', 'duration', 'startedBy'];
const LONGUEUR_MAX = 2000;

/** « 83000 » → « 1 min 23 s ». Vide quand la durée est inconnue ou nulle (un build qui vient de partir). */
function formaterDuree(ms) {
  const total = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(total) || total <= 0) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  if (m) return s ? `${m} min ${s} s` : `${m} min`;
  return `${s} s`;
}

/** Remplace {{variable}}. Une variable inconnue ou absente rend une chaîne vide — jamais une erreur, jamais « undefined ».
    Le message tient sur UNE ligne : Entrée envoie le message dans l'éditeur de Teams. */
function rendre(modele, variables) {
  const vars = variables || {};
  return String(modele == null ? '' : modele)
    .replace(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g, (_, nom) => (Object.prototype.hasOwnProperty.call(vars, nom) && vars[nom] != null ? String(vars[nom]) : ''))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, LONGUEUR_MAX);
}

/** Un motif glob → expression régulière, ancrée sur le nom COMPLET du job (`dossier/sous/job`).
    `*` : n'importe quoi SAUF « / » · `**` : n'importe quoi, « / » compris · `?` : un caractère hors « / ». */
function globVersRegExp(motif) {
  let re = '';
  const m = String(motif);
  for (let i = 0; i < m.length; i += 1) {
    const c = m[i];
    if (c === '*') {
      if (m[i + 1] === '*') { re += '.*'; i += 1; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** La liste de motifs saisie dans les réglages : un par ligne (la virgule sépare aussi). */
function lireMotifs(texte) {
  return String(texte == null ? '' : texte).split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
}

/** Vide = tous les jobs. */
function filtreAccepte(motifs, job) {
  const liste = Array.isArray(motifs) ? motifs : lireMotifs(motifs);
  if (!liste.length) return true;
  const nom = String(job || '');
  return liste.some((m) => globVersRegExp(m).test(nom));
}

/** Le type de message d'un événement Jenkins, et SES variables.
    SUCCESS → success · ABORTED → aborted · tout le reste (FAILURE, UNSTABLE, NOT_BUILT…) → failure. */
function classer(evenement, payload) {
  const p = payload || {};
  if (evenement === 'jenkins.job.started') {
    return { type: 'started', variables: variablesDe({ job: p.path, number: '', url: p.url, result: '', duration: '', startedBy: p.startedBy }) };
  }
  if (evenement === 'jenkins.job.finished') {
    const resultat = String(p.result || '').toUpperCase();
    const type = resultat === 'SUCCESS' ? 'success' : (resultat === 'ABORTED' ? 'aborted' : 'failure');
    return { type, variables: variablesDe({ job: p.path, number: p.number, url: p.url, result: p.result, duration: formaterDuree(p.duration), startedBy: p.startedBy }) };
  }
  return null;
}

/** On ne garde que les variables connues, en chaînes : rien d'autre ne peut entrer dans un message. */
function variablesDe(brut) {
  const out = {};
  for (const k of VARIABLES) out[k] = brut[k] == null ? '' : String(brut[k]);
  return out;
}

/** Le modèle d'un type : celui des réglages, ou — vide — celui de la langue (dictionnaire du plugin). */
function modeleDe(reglages, type, parDefaut) {
  const propre = String((reglages && reglages[`template_${type}`]) || '').trim();
  return propre || parDefaut(type);
}

module.exports = { VARIABLES, formaterDuree, rendre, globVersRegExp, lireMotifs, filtreAccepte, classer, variablesDe, modeleDe };
