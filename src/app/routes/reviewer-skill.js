'use strict';
/* EXPORTER LE REVIEWER EN SKILL : l'archive du skill Claude Code autonome qui refait la review de
   l'application sur la branche courante d'un dépôt. HTTP seulement — l'assemblage vit dans `review/skill-export.js`.
   UN POST, comme la sauvegarde : l'archive porte le gabarit et les règles de l'équipe, elle ne part
   que sur un geste de l'application. */
const { app } = require('../app');
const { getConfig } = require('../../data/config');
const { getLang } = require('../../core/i18n');
const skill = require('../../review/skill-export');
const { wrap } = require('../http');

app.post('/api/reviewer/skill', wrap(async (req, res) => {
  const { nom, buffer, fichiers } = skill.construire(getConfig(), { lang: getLang() });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${nom}"`);
  res.setHeader('X-Mergerie-Skill', fichiers.join(','));
  res.send(buffer);
}));
