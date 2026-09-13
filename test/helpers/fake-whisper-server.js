'use strict';
/* Un faux `whisper-server`, pour éprouver le CYCLE DE VIE du moteur sans modèle de 1,6 Go.
 *
 * Il imite ce dont Mergerie dépend vraiment, et rien d'autre : il accepte les drapeaux qu'on
 * lui passe (il les ignore, sauf `--port`), il répond sur `/` dès qu'il est prêt — c'est ce
 * que le serveur attend pour dire « démarré » — et il répond du JSON à la forme d'OpenAI sur
 * `/v1/audio/transcriptions`.
 *
 * `--help` DORT au lieu de répondre : c'est le comportement du vrai binaire quand un autre
 * whisper-server tourne déjà (mesuré : 71 ms seul, dix secondes de délai dépassé avec un
 * serveur en fond), et c'est précisément ce que le diagnostic ne doit plus provoquer. */
const http = require('node:http');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  // Personne ne doit m'appeler ainsi pendant qu'un moteur tourne : je ne rends jamais la main.
  setInterval(() => {}, 1000);
  return;
}

const port = Number(args[args.indexOf('--port') + 1]) || 0;
const hote = args[args.indexOf('--host') + 1] || '127.0.0.1';

const serveur = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/audio/transcriptions')) {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'Mergerie, test de la dictée : merge request 214 sur webapp-front.' }));
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('whisper.cpp (simulé)');
});

serveur.listen(port, hote, () => {
  // Le vrai binaire écrit son journal sur la sortie : Mergerie y lit l'accélération détectée.
  console.log(`ggml_metal_device_init: simulé, écoute sur ${hote}:${serveur.address().port}`);
});
