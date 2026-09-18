'use strict';
/* UN DÉPÔT SERVI EN HTTP, AVEC AUTHENTIFICATION — pour éprouver que le jeton de la forge voyage
   par en-tête et jamais par l'URL du clone.

   `git http-backend` fait tout le protocole « smart HTTP » ; ce serveur ne fait que vérifier
   l'en-tête `Authorization` et relayer la requête en CGI. Il retient les en-têtes reçus : un test
   peut ainsi vérifier ce que git a réellement envoyé, et pas seulement que ça a marché. */
const http = require('node:http');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

function serveurGitHttp({ racine, utilisateur, jeton }) {
  const attendu = `Basic ${Buffer.from(`${utilisateur}:${jeton}`).toString('base64')}`;
  const recus = [];
  const backend = path.join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git-http-backend');

  const server = http.createServer((req, res) => {
    recus.push(req.headers.authorization || null);
    if (req.headers.authorization !== attendu) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      res.end();
      return;
    }
    const u = new URL(req.url, 'http://local');
    const child = spawn(backend, [], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: racine,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: u.pathname,
        QUERY_STRING: u.search.slice(1),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers['content-type'] || '',
        REMOTE_USER: utilisateur,          // le push est admis pour un utilisateur authentifié
        REMOTE_ADDR: '127.0.0.1',
      },
    });
    req.pipe(child.stdin);
    let tete = Buffer.alloc(0);
    let enCorps = false;
    child.stdout.on('data', (d) => {
      if (enCorps) { res.write(d); return; }
      tete = Buffer.concat([tete, d]);
      let fin = tete.indexOf('\r\n\r\n');
      let saut = 4;
      if (fin === -1) { fin = tete.indexOf('\n\n'); saut = 2; }
      if (fin === -1) return;
      let status = 200;
      const headers = {};
      for (const ligne of tete.slice(0, fin).toString().split(/\r?\n/)) {
        const i = ligne.indexOf(':');
        if (i === -1) continue;
        const cle = ligne.slice(0, i).trim();
        const val = ligne.slice(i + 1).trim();
        if (cle.toLowerCase() === 'status') status = parseInt(val, 10) || 200;
        else headers[cle] = val;
      }
      res.writeHead(status, headers);
      enCorps = true;
      res.write(tete.slice(fin + saut));
    });
    child.stdout.on('end', () => res.end());
    child.on('error', () => { try { res.writeHead(500); res.end(); } catch { /* déjà parti */ } });
  });

  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => ok({
      url: `http://127.0.0.1:${server.address().port}`,
      recus,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

module.exports = { serveurGitHttp };
