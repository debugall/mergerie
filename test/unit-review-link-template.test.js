'use strict';
/* LE TEXTE QUI PART SUR LA MERGE REQUEST DE QUELQU'UN D'AUTRE.
 *
 * Publier le LIEN du rapport poste un commentaire sous le nom de l'utilisateur, sur la merge
 * request d'un collègue, et l'équipe peut en écrire elle-même le texte. Deux choses s'y jouent,
 * et elles tiennent dans une fonction courte que les tests de bout en bout ne peuvent pas
 * couvrir sous tous ses angles — il leur faudrait une review par cas :
 *
 *   1. LE GABARIT VIDE NE CHANGE RIEN. C'est l'état de tout le monde au premier jour : le
 *      message livré part, dans la langue de l'écran, avec ou sans note selon la passe.
 *   2. UN GABARIT REMPLI EST PRIS AU MOT. Ses variables sont remplacées ; celles qu'on ne
 *      connaît pas restent telles quelles — une accolade dans un texte est plus souvent une
 *      accolade qu'une faute de frappe, et l'effacer en silence serait pire que la laisser.
 *
 * Et la troisième, à l'enregistrement : un gabarit sans `{url}` est REFUSÉ. Il annoncerait un
 * rapport sans dire où il est, sur les merge requests de toute l'équipe, et personne ne s'en
 * apercevrait avant d'aller le lire.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* `src/reviewer` tire `src/db` avec lui, qui OUVRE une base dès le chargement : sans ce dossier
   posé AVANT le require, le test écrirait dans la base réelle de l'utilisateur. */
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lien-gabarit-'));
const { messageLien } = require('../src/reviewer');
const { updateConfig, getConfig } = require('../src/config');

const MR = { iid: 217, project: 'grp/app', title: 'Paiement 3× : intégration du partenaire' };
const rendre = (gabarit, note = '8,4') => messageLien({ review_link_template: gabarit },
  { url: 'https://gitlab.test/eq/data/-/blob/main/reviews/x.md', version: 3, note, mr: MR });

describe('Le commentaire qui porte le lien du rapport', () => {
  test('gabarit vide : le message livré, avec ou sans note', () => {
    const avec = rendre('', '8,4');
    assert.match(avec, /https:\/\/gitlab\.test\/eq\/data\/-\/blob\/main\/reviews\/x\.md/, 'l’adresse y est');
    assert.match(avec, /8,4/, 'et la note de la passe');
    assert.match(avec, /v3/, 'et le numéro de passe : republier ne remplace pas, ça ajoute');

    const sans = rendre('', null);
    assert.match(sans, /https:\/\/gitlab\.test/, 'l’adresse y est toujours');
    assert.doesNotMatch(sans, /\/10/, 'une passe sans note ne parle pas de note');
  });

  test('gabarit rempli : ses variables sont remplacées, les inconnues restent', () => {
    const texte = rendre('Review de !{iid} sur {project} — {title}\n{url} · {note}/10 · v{v}\nÀ relire avant vendredi. {inconnu} {}');
    assert.equal(texte,
      'Review de !217 sur grp/app — Paiement 3× : intégration du partenaire\n'
      + 'https://gitlab.test/eq/data/-/blob/main/reviews/x.md · 8,4/10 · v3\n'
      + 'À relire avant vendredi. {inconnu} {}');
  });

  test('gabarit rempli, passe sans note : la variable s’efface, le texte reste celui de l’équipe', () => {
    const texte = rendre('Rapport : {url} (note « {note} »)', null);
    assert.equal(texte, 'Rapport : https://gitlab.test/eq/data/-/blob/main/reviews/x.md (note «  »)',
      'c’est à l’équipe de décider si sa phrase supporte une note absente — on ne réécrit pas son texte');
  });

  test('un gabarit sans {url} est refusé À L’ENREGISTREMENT, pas à la publication', () => {
    assert.throws(() => updateConfig({ review_link_template: 'Le rapport est prêt, allez le lire.' }),
      /url/, 'l’écran peut encore le dire ; au moment de publier, il serait trop tard');
    assert.equal(getConfig().review_link_template || '', '', 'et rien n’a été enregistré au passage');

    updateConfig({ review_link_template: 'Rapport : {url}' });
    assert.equal(getConfig().review_link_template, 'Rapport : {url}', 'un gabarit qui porte l’adresse passe');
    updateConfig({ review_link_template: '' });
    assert.equal(getConfig().review_link_template, '', 'et on peut revenir au message livré en vidant le champ');
  });
});
