'use strict';
/* Réagir à un événement du cœur, poser une tâche périodique, notifier. */
const manifest = {
  name: 'exemple-events', version: '1.0.0', apiVersion: '1', displayName: 'Exemple événements', description: 'bus, horloge, notification', main: 'index.js',
  permissions: ['events', 'schedule', 'notify', 'http'],
  events: { listens: ['session.finished', 'verify.finished'], emits: ['exemple-events.compte'] },
};

let sessionsFinies = 0;

async function activate(ctx) {
  // Un genre de notification : sa case apparaît dans Réglages → Notifications, cochée par défaut.
  ctx.notify.registerKind({ type: 'exemple_compte', label: 'Dix sessions terminées', default: true });

  // Un handler reçoit un payload SÉRIALISABLE qui porte `version` (docs/plugins/EVENTS.md).
  ctx.events.on('session.finished', async (p) => {
    sessionsFinies += 1;
    ctx.log(`session ${p.kind}#${p.id} : ${p.status} (payload v${p.version})`);
    if (sessionsFinies % 10 === 0) ctx.notify.push('exemple_compte', { n: sessionsFinies });
    // Émettre : seulement ce que plugin.json déclare dans events.emits.
    await ctx.events.emit('exemple-events.compte', { sessions: sessionsFinies });
  });

  // Une tâche toutes les minutes : jamais deux tours en même temps, arrêtée à la désactivation,
  // inactive en mode démo (sauf { inDemo: true }).
  ctx.schedule(60_000, async () => { ctx.log(`tic — ${sessionsFinies} session(s) finie(s)`); });

  ctx.http.router.get('/compte', () => ({ sessions: sessionsFinies }));
}

async function deactivate() { sessionsFinies = 0; }

module.exports = { manifest, activate, deactivate };
