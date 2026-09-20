'use strict';
/* FAUX AGENT MALVEILLANT — lancé À L'INTÉRIEUR d'un job de sandbox par
 * test/unit-sandbox-linux.test.js, jamais directement. Tente les 10 attaques du §9.2 du plan et
 * rapporte, sur stdout, ce qui a été bloqué ou non — jamais une vraie fuite : chaque tentative
 * est enveloppée, seul son résultat compte pour le test qui l'a lancé.
 */
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

/* Chaque essai s'écrit sur stdout IMMÉDIATEMENT, pas dans un objet accumulé rendu à la fin : le
 * dernier essai (`trop_de_fichiers`) peut se faire tuer en plein milieu par la limite qu'il
 * teste — un rapport final unique perdrait alors TOUS les essais précédents avec lui. */
const essai = (nom, fn) => {
  let ligne;
  try { ligne = { nom, bloque: false, detail: String(fn()).slice(0, 200) }; }
  catch (e) { ligne = { nom, bloque: true, detail: String((e && e.message) || e).slice(0, 200) }; }
  process.stdout.write(`ESSAI:${JSON.stringify(ligne)}\n`);
};

essai('ecrire_workspace', () => { fs.writeFileSync('/workspace/should-not-change.txt', 'compromis'); return 'écrit'; });
essai('ecrire_tmp', () => { fs.writeFileSync('/tmp/preuve.txt', 'ok'); return 'écrit'; });
essai('lire_secret_hors_job', () => fs.readFileSync(process.env.MERGERIE_TEST_SECRET, 'utf8'));
essai('lire_second_clone', () => fs.readdirSync(process.env.MERGERIE_TEST_CLONE_DIR).join(','));
essai('symlink_passwd', () => {
  fs.symlinkSync('/etc/passwd', '/tmp/lien-passwd');
  return fs.readFileSync('/tmp/lien-passwd', 'utf8').slice(0, 10);
});
essai('reseau_loopback', () => {
  net.connect({ host: '127.0.0.1', port: 9999, timeout: 500 }).on('error', () => {}).on('timeout', function () { this.destroy(); });
  return 'tenté';
});
essai('reseau_externe', () => {
  net.connect({ host: '93.184.216.34', port: 80, timeout: 800 }).on('error', () => {}).on('timeout', function () { this.destroy(); });
  return 'tenté';
});
essai('enfant_survivant', () => {
  const c = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
  c.unref();
  return String(c.pid);
});
essai('ssh_agent_socket', () => process.env.SSH_AUTH_SOCK || 'absent');
essai('docker_socket', () => (fs.existsSync('/var/run/docker.sock') ? 'présent' : 'absent'));
essai('trop_de_fichiers', () => {
  for (let i = 0; i < 50000; i += 1) fs.writeFileSync(`/tmp/f${i}`, 'x');
  return 'boucle terminée';
});

process.stdout.write('FIN\n');
setTimeout(() => process.exit(0), 800); // ne pas dépendre des sockets/poignées ci-dessus pour sortir
