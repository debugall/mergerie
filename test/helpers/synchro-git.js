'use strict';
/* LES PANNES D'UN DÉPÔT DE DONNÉES, fabriquées pour de vrai — pour les tests de synchronisation.
 *
 * Trois outils, tous au niveau de git lui-même : l'application n'est ni simulée ni contournée,
 * elle parle à un vrai dépôt, par un vrai transport, et c'est le TRANSPORT qui tombe en panne.
 *
 *   — `fauxSsh` : un `ssh` de remplacement (posé dans `GIT_SSH_COMMAND`). Une adresse
 *     `git@equipe.test:donnees.git` atteint alors un dépôt nu local, comme sur une forge. Un
 *     interrupteur sur le disque fait répondre ce transport comme un serveur qui REFUSE LA CLÉ
 *     (`Permission denied (publickey)`) ou comme une machine INJOIGNABLE (`Connection refused`),
 *     exactement les deux messages qu'un utilisateur voit en vrai ;
 *   — `crochetCourse` : un `pre-receive` qui, au premier push, fait passer le commit d'un
 *     collègue AVANT le nôtre, puis refuse ce push-là. C'est la course « quelqu'un a poussé entre
 *     mon fetch et mon push », rendue déterministe : aucune attente, aucun pari sur l'horloge ;
 *   — `crochetRefus` : un `pre-receive` qui refuse TOUT push, comme une branche protégée ou un
 *     accès en lecture seule.
 *
 * Rien de `src/` n'est chargé ici. */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Crée le faux `ssh`. `nu` est le dépôt nu servi. Rend `{ commande, mode(m) }` :
 * `commande` va dans `GIT_SSH_COMMAND`, `mode('ok' | 'refus' | 'injoignable')` bascule le
 * comportement du transport pour les connexions SUIVANTES.
 */
function fauxSsh(dir, nu) {
  const script = path.join(dir, 'faux-ssh.js');
  const interrupteur = path.join(dir, 'faux-ssh.mode');
  fs.writeFileSync(interrupteur, 'ok');
  fs.writeFileSync(script, [
    "'use strict';",
    "const fs = require('fs');",
    "const { spawn } = require('child_process');",
    `const mode = fs.readFileSync(${JSON.stringify(interrupteur)}, 'utf8').trim();`,
    "if (mode === 'refus') {",
    "  process.stderr.write('git@equipe.test: Permission denied (publickey).\\n');",
    '  process.exit(255);',
    '}',
    "if (mode === 'injoignable') {",
    "  process.stderr.write('ssh: connect to host equipe.test port 22: Connection refused\\n');",
    '  process.exit(255);',
    '}',
    // Le dernier argument est la commande distante : « git-upload-pack 'donnees.git' ».
    'const commande = process.argv[process.argv.length - 1];',
    "const m = /^git[- ](upload-pack|receive-pack)\\b/.exec(commande);",
    "if (!m) { process.stderr.write(`faux ssh : commande inattendue ${commande}\\n`); process.exit(128); }",
    `const enfant = spawn('git', [m[1], ${JSON.stringify(nu)}], { stdio: 'inherit' });`,
    "enfant.on('exit', (code) => process.exit(code === null ? 1 : code));",
    '',
  ].join('\n'));
  return {
    commande: `"${process.execPath}" "${script}"`,
    mode: (m) => fs.writeFileSync(interrupteur, m),
  };
}

const HOOK = (nu) => path.join(nu, 'hooks', 'pre-receive');

/**
 * La course : au PREMIER push reçu, `refs/heads/main` avance d'abord jusqu'à `refCollegue` (un
 * commit déjà présent dans le dépôt nu, poussé sous un autre nom), puis ce push est refusé —
 * c'est ce que git répond quand la branche a bougé sous nos pieds. Les pushes suivants passent.
 */
function crochetCourse(nu, refCollegue) {
  const drapeau = path.join(nu, 'course-jouee');
  fs.writeFileSync(HOOK(nu), [
    '#!/bin/sh',
    `if [ -f "${drapeau}" ]; then exit 0; fi`,
    `touch "${drapeau}"`,
    // La quarantaine des objets reçus interdit de toucher aux références : on en sort.
    'unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES',
    `git --git-dir="${nu}" update-ref refs/heads/main "${refCollegue}"`,
    'echo "main a bougé pendant ce push (non-fast-forward)" >&2',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });
  return { jouee: () => fs.existsSync(drapeau) };
}

/** Tout push est refusé : branche protégée, accès en lecture seule. */
function crochetRefus(nu, message = 'GitLab: You are not allowed to push code to protected branches on this project.') {
  fs.writeFileSync(HOOK(nu), ['#!/bin/sh', `echo "${message}" >&2`, 'exit 1', ''].join('\n'), { mode: 0o755 });
}

/** Retire le crochet : les pushes repassent. */
function retirerCrochet(nu) {
  fs.rmSync(HOOK(nu), { force: true });
}

/* ---------- Une collègue « à la main » : un clone git, et des fichiers au format du store ----------
   Quand un second serveur serait de trop (une panne de transport ne se joue qu'entre deux
   commits), la collègue est un simple clone du dépôt nu, qui écrit une page de notes EXACTEMENT
   comme le store l'écrit : `notes/<slug>.md` porte le corps, `notes/<slug>.json` le reste. */

const { execFileSync } = require('node:child_process');

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Un ULID valide : 10 caractères de temps, 16 de hasard — la forme des `uid` du store. */
function ulid() {
  let t = Date.now();
  let temps = '';
  for (let i = 0; i < 10; i += 1) { temps = CROCKFORD[t % 32] + temps; t = Math.floor(t / 32); }
  let alea = '';
  for (let i = 0; i < 16; i += 1) alea += CROCKFORD[Math.floor(Math.random() * 32)];
  return temps + alea;
}

const gitC = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Clone le dépôt nu dans `dossier` (ou le met à jour s'il existe), écrit une page de notes signée
 * `auteur`, commite, et pousse vers `ref` (`main` par défaut ; une autre branche pour préparer
 * une course sans toucher `main`). Rend l'uid de la page.
 */
function pousserNoteCollegue({ nu, dossier, slug, titre, contenu, auteur = 'Claire', ref = 'main' }) {
  if (!fs.existsSync(path.join(dossier, '.git'))) execFileSync('git', ['clone', '-q', nu, dossier], { stdio: 'ignore' });
  gitC(dossier, ['fetch', '-q', 'origin', 'main']);
  gitC(dossier, ['checkout', '-q', '-B', 'travail', 'origin/main']);
  const uid = ulid();
  const maintenant = new Date().toISOString();
  fs.mkdirSync(path.join(dossier, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dossier, 'notes', `${slug}.md`), contenu);
  fs.writeFileSync(path.join(dossier, 'notes', `${slug}.json`), `${JSON.stringify({
    created_at: maintenant, images: [], pinned: 0, slug, title: titre, uid, updated_at: maintenant,
  }, null, 2)}\n`);
  gitC(dossier, ['add', '-A']);
  const email = `${auteur.toLowerCase()}@exemple.test`;
  gitC(dossier, ['-c', `user.name=${auteur}`, '-c', `user.email=${email}`, 'commit', '-q',
    '-m', `note "${titre}"`, `--author=${auteur} <${email}>`]);
  gitC(dossier, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
  return uid;
}

module.exports = { fauxSsh, crochetCourse, crochetRefus, retirerCrochet, pousserNoteCollegue, ulid };
