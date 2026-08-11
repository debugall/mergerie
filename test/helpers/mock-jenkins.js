'use strict';
/* Faux serveur Jenkins pour les tests de bout en bout.
 *
 * Même parti pris que le faux GitLab : on remplace le SERVEUR, pas le module. Le vrai
 * `src/jenkins.js` s'exécute — son encodage de chemins, sa lecture de l'arbre, son crumb
 * CSRF et son corps de formulaire —, ce qu'un mock de module ne prouverait jamais.
 *
 * Le faux serveur EXIGE le crumb sur les POST, comme un Jenkins d'entreprise : c'est
 * précisément le détail qu'on oublie et qui donne un 403 incompréhensible en production. */

const http = require('http');

function freshState() {
  return {
    user: 'moi',
    token: 'jeton-test',
    crumbActif: true,             // faux = installation sans protection CSRF (404 sur l'émetteur)
    crumb: 'abc123',
    jobs: [],                     // arbre brut, tel que Jenkins le rend
    details: {},                  // chemin d'URL -> objet du job
    console: {},                  // `${chemin}/${n}` -> texte
    calls: [],                    // { method, path, body, auth, crumb, cookie }
    fail: {},                     // fragment de chemin -> { status, body }
  };
}

const state = freshState();
function reset() { Object.assign(state, freshState()); }

function autorise(req) {
  const h = req.headers.authorization || '';
  const attendu = `Basic ${Buffer.from(`${state.user}:${state.token}`).toString('base64')}`;
  return h === attendu;
}

function start() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const chemin = url.pathname;
      state.calls.push({
        method: req.method, path: chemin + url.search, body,
        auth: req.headers.authorization || null,
        crumb: req.headers['jenkins-crumb'] || null,
        cookie: req.headers.cookie || null,
      });
      const envoi = (status, payload, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };

      for (const [frag, r] of Object.entries(state.fail)) {
        if (chemin.includes(frag)) return envoi(r.status, r.body || '');
      }
      if (!autorise(req)) return envoi(401, '<html>Unauthorized</html>');

      if (chemin === '/crumbIssuer/api/json') {
        if (!state.crumbActif) return envoi(404, '<html>Not Found</html>');
        return envoi(200, { crumbRequestField: 'Jenkins-Crumb', crumb: state.crumb },
          { 'Set-Cookie': 'JSESSIONID=zz1; Path=/; HttpOnly' });
      }
      if (chemin === '/me/api/json') return envoi(200, { id: state.user, fullName: 'Moi Même' });
      if (chemin === '/api/json') return envoi(200, { jobs: state.jobs });

      // /job/a/job/b/... : on retrouve le job par son préfixe d'URL.
      const m = chemin.match(/^((?:\/job\/[^/]+)+)(\/.*)?$/);
      if (m) {
        const cle = m[1];
        const reste = m[2] || '/';
        const job = state.details[cle];
        if (!job) return envoi(404, '<html>Not Found</html>');
        if (reste.startsWith('/api/json')) return envoi(200, job);
        if (req.method === 'POST' && /\/build(WithParameters)?$/.test(reste)) {
          if (state.crumbActif && req.headers['jenkins-crumb'] !== state.crumb) {
            return envoi(403, '<html>No valid crumb was included in the request</html>');
          }
          return envoi(201, '', { Location: 'http://jenkins.test/queue/item/77/' });
        }
        const c = reste.match(/^\/(\d+)\/consoleText$/);
        if (c) {
          const texte = state.console[`${cle}/${c[1]}`];
          if (texte == null) return envoi(404, '<html>Not Found</html>');
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end(texte);
        }
      }
      return envoi(404, '<html>Not Found</html>');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { start, state, reset };
