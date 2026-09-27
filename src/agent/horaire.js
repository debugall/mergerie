'use strict';
/* LA GRAMMAIRE D'UN HORAIRE D'AGENT — `daily 07:00`, `weekly mon 07:00`, `monthly 15 07:00` :
   la lire, l'écrire sous forme canonique, dire quand elle est passée et quand elle repasse, la
   dire en toutes lettres. Rien d'autre : ce module ne connaît ni la base ni les agents, et
   c'est ce qui permet au profil d'un agent de valider son horaire sans dépendre du ticker qui
   le lance (`schedule.js`), lequel dépend du profil. */
const { t } = require('../core/i18n');

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

/* LE PROCHAIN CRÉNEAU À VENIR — l'autre question, celle de l'écran. `prochainCreneau` (malgré
   son nom, gardé pour ne pas casser ce qui l'appelle) rend le DERNIER créneau PASSÉ : c'est ce
   qu'il faut pour rattraper un run manqué, et c'est inutilisable pour dire « il repasse à
   7:00 demain ». Un agent planifié était donc invisible entre deux runs : sa carte ne disait
   ni quand il avait tourné, ni quand il repasserait. */
function creneauSuivant(spec, now = new Date()) {
  if (!spec) return null;
  const d = new Date(now.getTime());
  d.setSeconds(0, 0);
  const poser = (jour) => { const x = new Date(jour.getTime()); x.setHours(spec.hh, spec.mm, 0, 0); return x; };
  if (spec.kind === 'daily') {
    const aujourdhui = poser(d);
    return aujourdhui > d ? aujourdhui : new Date(aujourdhui.getTime() + 86400000);
  }
  if (spec.kind === 'weekly') {
    const cible = poser(d);
    for (let i = 0; i < 8; i += 1) {
      const c = new Date(cible.getTime() + i * 86400000);
      if (c.getDay() === spec.dow && c > d) return c;
    }
    return null;
  }
  const ceMois = new Date(d.getFullYear(), d.getMonth(), spec.dom, spec.hh, spec.mm, 0, 0);
  if (ceMois > d) return ceMois;
  return new Date(d.getFullYear(), d.getMonth() + 1, spec.dom, spec.hh, spec.mm, 0, 0);
}

// La phrase affichée : « chaque lundi à 07:00 ». Le stockage reste la forme canonique.
function phrase(text) {
  const spec = parse(text);
  if (!spec) return '';
  const hhmm = `${String(spec.hh).padStart(2, '0')}:${String(spec.mm).padStart(2, '0')}`;
  if (spec.kind === 'daily') return t('agents.schedule.said-daily', { time: hhmm });
  if (spec.kind === 'weekly') return t('agents.schedule.said-weekly', { day: t(`agents.schedule.dow.${JOURS[spec.dow]}`), time: hhmm });
  return t('agents.schedule.said-monthly', { day: spec.dom, time: hhmm });
}

module.exports = { JOURS, parse, canonique, prochainCreneau, creneauSuivant, phrase };
