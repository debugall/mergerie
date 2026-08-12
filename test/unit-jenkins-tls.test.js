'use strict';
/* JENKINS DERRIÈRE UN CERTIFICAT D'ENTREPRISE.
 *
 * Un Jenkins interne est presque toujours servi par un certificat qu'un Node fraîchement
 * installé ne connaît pas. Node dit alors « unable to get local issuer certificate » : exact,
 * et parfaitement inutile — il ne nomme ni la cause (le CA interne), ni le remède.
 *
 * Ce fichier monte un VRAI serveur HTTPS avec un VRAI certificat auto-signé, parce que c'est
 * la seule façon de vérifier les trois chemins qui comptent : le message quand rien n'est
 * fourni, le CA épinglé (la bonne réponse), et la désactivation de la vérification (le
 * dépannage). Un test qui simulerait l'erreur ne prouverait que ma table de traduction.
 *
 * L'agent TLS est calculé UNE FOIS par processus : chaque cas recharge donc les modules, ce
 * qui est aussi la façon dont l'application se comporte — l'environnement se lit au démarrage.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

// Le certificat est fabriqué à l'instant : un PEM figé dans le dépôt finit par expirer, et
// le test se mettrait alors à échouer un matin sans que rien n'ait changé.
let dispo = true;
let dir;
let cert;
let cle;
try {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jk-tls-'));
  cert = path.join(dir, 'cert.pem');
  cle = path.join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', cle, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
} catch { dispo = false; }

describe('Jenkins derrière un certificat auto-signé', { skip: dispo ? false : 'openssl absent' }, () => {
  let server;
  let url;

  before(async () => {
    server = https.createServer({ key: fs.readFileSync(cle), cert: fs.readFileSync(cert) }, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobs: [{ name: 'build', color: 'blue', buildable: true }] }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `https://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* déjà parti */ }
  });

  /* Chaque cas repart d'un module NEUF : l'agent TLS mémorise sa décision au premier appel,
     exactement comme en production où l'environnement est lu au démarrage du serveur. */
  const client = (env) => {
    for (const k of ['JENKINS_CA_CERT', 'JENKINS_INSECURE_TLS']) delete process.env[k];
    Object.assign(process.env, env);
    delete require.cache[require.resolve('../src/jenkins')];
    delete require.cache[require.resolve('../src/httpreq')];
    // eslint-disable-next-line global-require
    return require('../src/jenkins');
  };
  const cfg = () => ({ jenkins_url: url, jenkins_user: 'moi', jenkins_token: 'x' });

  test('sans rien, l’erreur NOMME les deux variables au lieu de citer Node', async () => {
    const jenkins = client({});
    await assert.rejects(() => jenkins.lister(cfg()), (e) => {
      assert.match(e.message, /JENKINS_CA_CERT/, 'la bonne réponse — épingler le CA — doit être nommée');
      assert.match(e.message, /JENKINS_INSECURE_TLS/, 'et le dépannage aussi, sinon on reste bloqué');
      assert.doesNotMatch(e.message, /^unable to get local issuer/i,
        'le message brut de Node ne dit ni la cause ni le geste : c’est tout le problème');
      return true;
    });
  });

  test('avec le CA épinglé, ça marche — et la vérification reste active', async () => {
    const jenkins = client({ JENKINS_CA_CERT: cert });
    const jobs = await jenkins.lister(cfg());
    assert.deepEqual(jobs.map((j) => j.path), ['build']);
  });

  test('avec la vérification désactivée, ça marche aussi (dépannage)', async () => {
    const jenkins = client({ JENKINS_INSECURE_TLS: '1' });
    const jobs = await jenkins.lister(cfg());
    assert.deepEqual(jobs.map((j) => j.path), ['build']);
  });

  /* Un CA épinglé qui ne correspond PAS doit toujours échouer : la variable ne doit pas être
     une façon détournée de tout accepter, sinon elle ne protège plus de rien. */
  test('un CA qui ne correspond pas refuse toujours', async () => {
    const autre = path.join(dir, 'autre.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(dir, 'autre.key'), '-out', autre, '-days', '2',
      '-subj', '/CN=ailleurs'], { stdio: 'ignore' });
    const jenkins = client({ JENKINS_CA_CERT: autre });
    await assert.rejects(() => jenkins.lister(cfg()), /JENKINS_CA_CERT|certificat/);
  });

  after(() => {
    for (const k of ['JENKINS_CA_CERT', 'JENKINS_INSECURE_TLS']) delete process.env[k];
    delete require.cache[require.resolve('../src/jenkins')];
    delete require.cache[require.resolve('../src/httpreq')];
  });
});
