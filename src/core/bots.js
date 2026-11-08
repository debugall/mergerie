'use strict';
/* QUI EST UN ROBOT. Dependabot, Renovate, les actions GitHub, Mergify : leurs commits et leurs
   merge requests ne racontent pas la vie d'une équipe. Les Stats les écartent du compte
   d'activité (un dépôt tenu par un robot n'est pas un dépôt vivant) et le rattrapage d'une
   période les masque par défaut (un push de Renovate n'est pas un contournement du processus).
   Un seul motif, ici, pour que les deux écrans jugent pareil.
   `noreply@github.com` n'est PAS un motif : les commits faits depuis l'interface web de GitHub
   par de vrais humains le portent aussi. */
const MOTIFS_BOT = [/\[bot\]/i, /\bdependabot\b/i, /\brenovate\b/i, /\bgithub-actions\b/i, /\bmergify\b/i];
const estBot = (auteur) => MOTIFS_BOT.some((re) => re.test(String(auteur || '')));

module.exports = { MOTIFS_BOT, estBot };
