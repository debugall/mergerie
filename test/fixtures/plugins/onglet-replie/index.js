'use strict';
async function activate(ctx) {
  ctx.ui.registerTab({ id: 'replie', label: 'Replié', title: 'Un onglet replié d’office', icon: 'i-plug', foldedByDefault: true, onboarding: { label: 'Replié' } });
  ctx.ui.registerSettingsTab({ id: 'repliecfg', label: 'Replié', title: 'Réglages de l’onglet replié', followsTab: 'replie', schemaForm: false });
}
async function deactivate() { /* rien */ }
module.exports = { activate, deactivate };
