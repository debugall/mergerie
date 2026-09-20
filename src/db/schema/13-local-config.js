'use strict';
/* Ce qui reste sur ce poste : `local_config`, drainée depuis `config` avec une liste de colonnes gelée.
   Tranche de l'ancien db.js (réorganisation de src/ par couches), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');

/* ---------- CE QUI RESTE SUR CE POSTE : `local_config` ----------
 *
 * `config` est une table d'équipe : gabarits de prompt, seuils, politiques, URL de la forge.
 * Elle porte pourtant sept jetons d'API, le chemin des clones et le moteur de dictée de CETTE
 * machine — autant de choses qui n'ont rien à faire dans un dépôt partagé, et que le lot
 * « base partagée » y enverrait si on ne les sortait pas.
 *
 * Le tri n'est pas fait ici : il est déclaré dans `src/store-registry.js`, où chaque colonne de
 * `config` figure nommément dans `locales` (ce poste) ou dans `partagees` (l'équipe), les deux
 * listes devant couvrir le schéma exactement — un test unitaire s'en assure. Sortir les jetons
 * par une LISTE NOIRE (« tout sauf… ») échouerait en s'ouvrant : la colonne ajoutée l'an
 * prochain partirait par défaut. Ici, une colonne non classée fait rougir les tests.
 *
 * La colonne d'origine n'est pas supprimée, elle est VIDÉE ET GELÉE : `ALTER TABLE … DROP
 * COLUMN` sur une base en service est irréversible, et une lecture oubliée doit trouver du vide
 * plutôt qu'un jeton périmé qu'elle croirait bon. L'assertion qui suit refuse une colonne gelée
 * non vide — après le drain, ce ne peut plus être qu'un bug de ce fichier même.
 *
 * Placé APRÈS tous les `ALTER TABLE config` : le drain lit des colonnes qui doivent exister. */
const REGISTRE_CONFIG = require('../../data/store-registry').pour('config');
/* Les colonnes de poste, avec le défaut de `config` — repris à l'identique, sinon un réglage
   non renseigné changerait de sens en déménageant. `id` est la clé, pas un réglage. */
const COLONNES_LOCALES = [
  ["access_token", "TEXT DEFAULT ''"],
  ["github_token", "TEXT DEFAULT ''"],
  ["jira_email", "TEXT DEFAULT ''"],
  ["jira_token", "TEXT DEFAULT ''"],
  ["jenkins_user", "TEXT DEFAULT ''"],
  ["jenkins_token", "TEXT DEFAULT ''"],
  ["dictation_api_key", "TEXT DEFAULT ''"],
  ["clone_path", "TEXT DEFAULT ''"],
  ["language", "TEXT DEFAULT 'fr'"],
  ['jenkins_refresh_minutes', 'INTEGER DEFAULT 1'],
  ['git_commands_seeded', 'INTEGER DEFAULT 0'],
  ["dictation_provider", "TEXT DEFAULT 'off'"],
  ["dictation_model", "TEXT DEFAULT ''"],
  ["dictation_vad_model", "TEXT DEFAULT ''"],
  ["dictation_command", "TEXT DEFAULT ''"],
  ["dictation_url", "TEXT DEFAULT 'https://api.openai.com'"],
  ["dictation_remote_model", "TEXT DEFAULT 'gpt-4o-mini-transcribe'"],
  ["dictation_language", "TEXT DEFAULT 'auto'"],
  ['dictation_silence_ms', 'INTEGER DEFAULT 700'],
  ["dictation_final_pass", "TEXT DEFAULT '1'"],
  ['dictation_idle_minutes', 'INTEGER DEFAULT 15'],
  /* LE DÉPÔT DE DONNÉES PARTAGÉ. De poste, et non d'équipe : c'est l'adresse par laquelle CE
     poste rejoint l'équipe, et elle doit être renseignée avant que quoi que ce soit soit
     partagé — la mettre dans les réglages d'équipe serait circulaire. Vide = mode mono-poste,
     rien ne change. */
  ["data_repo_url", "TEXT DEFAULT ''"],
  ["data_repo_branch", "TEXT DEFAULT 'main'"],
  ['data_sync_seconds', 'INTEGER DEFAULT 30'],
  /* PARTAGER SA DÉPENSE, ou non. Décoché par défaut, et c'est délibéré : ce que coûte mon
     abonnement ne regarde que moi tant que je n'ai pas décidé le contraire. Coché, il part un
     total PAR JOUR — jamais le détail par appel, qui dirait ce que j'ai demandé et quand. */
  ["usage_share", "TEXT DEFAULT '0'"],
  /* DES HABITUDES, PAS DES POLITIQUES. Le brief du matin qui s'ouvre au lancement, la cadence à
     laquelle CE poste interroge la forge ou Jira, la fermeture des todos à la fusion (la todo
     est devenue personnelle), et les quatre cases cochées d'office d'une nouvelle session : les
     imposer à l'équipe, c'est rendre l'outil désagréable pour cinq personnes afin d'en arranger
     une. Les DÉFAUTS sont repris à l'identique de `config`, sinon un réglage non renseigné
     changerait de sens en déménageant. */
  ["brief_on_open", "TEXT DEFAULT '1'"],
  ['auto_refresh_minutes', 'INTEGER DEFAULT 0'],
  ['jira_watch_minutes', 'INTEGER DEFAULT 5'],
  ["todo_close_on_merge", "TEXT DEFAULT '1'"],
  ['task_default_auto_push', 'INTEGER DEFAULT 0'],
  ['task_default_ask_questions', 'INTEGER DEFAULT 0'],
  ['task_default_notify_jira', 'INTEGER DEFAULT 0'],
  ['task_default_converge', 'INTEGER DEFAULT 0'],
  /* LES BORNES D'UN AGENT SONT CELLES DE CE POSTE. La dépense du jour se compte ici, et un réglage
     d'équipe aurait permis à un seul push de retirer les deux bornes chez tout le monde, sans porte. */
  ['agent_max_turns', 'INTEGER NOT NULL DEFAULT 200'],
  ['agent_daily_budget_usd', 'REAL NOT NULL DEFAULT 0'],
  /* LA SANDBOX SÉCURISÉE EST UN CHOIX DE CE POSTE : bubblewrap est Linux uniquement, et
     l'exiger par défaut casserait tout lancement d'agent sur un poste macOS/Windows, ou un
     Linux sans bubblewrap. `'off'` (le comportement d'avant ce lot) reste le défaut ; `agent
     policy` refuse de démarrer un job sensible si l'admin est passé sur `'required'` et que le
     poste ne peut pas tenir la promesse (voir `sandbox/runner.js`, jamais un repli silencieux). */
  ['agent_sandbox', "TEXT NOT NULL DEFAULT 'off'"],
];
db.exec(`CREATE TABLE IF NOT EXISTS local_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ${COLONNES_LOCALES.map(([n, d]) => `${n} ${d}`).join(',\n  ')}
)`);
if (!db.prepare('SELECT 1 FROM local_config WHERE id = 1').get()) {
  db.prepare('INSERT INTO local_config (id) VALUES (1)').run();
}
/* Une colonne de poste ajoutée après coup : même migration idempotente que partout ailleurs,
   APRÈS le CREATE TABLE ci-dessus. */
for (const [nom, decl] of COLONNES_LOCALES) {
  try { db.exec(`ALTER TABLE local_config ADD COLUMN ${nom} ${decl}`); } catch { /* déjà présente */ }
}

/* LE DRAIN. Rejouable : la seconde exécution ne trouve plus rien à déplacer. On ne recopie que
   si la colonne de `config` porte encore quelque chose — sinon on écraserait ce que
   l'utilisateur vient de saisir dans `local_config` par le vide laissé au passage précédent. */
{
  const gelees = REGISTRE_CONFIG.locales.filter((c) => c !== 'id');
  const avant = db.prepare('SELECT * FROM config WHERE id = 1').get() || {};
  const deplacees = [];
  for (const col of gelees) {
    const v = avant[col];
    if (v === null || v === undefined || v === '') continue;
    db.prepare(`UPDATE local_config SET ${col} = ? WHERE id = 1`).run(v);
    db.prepare(`UPDATE config SET ${col} = '' WHERE id = 1`).run();
    deplacees.push(col);
  }
  /* L'ASSERTION. Après le drain, une colonne gelée non vide ne peut plus venir que d'un bug de
     ce fichier — une faute de frappe dans un nom de colonne, avalée par un `catch {}` voisin.
     On préfère que le serveur refuse de démarrer plutôt que de laisser un jeton là où
     l'exportateur du dépôt partagé pourrait un jour le lire. */
  const apres = db.prepare('SELECT * FROM config WHERE id = 1').get() || {};
  const restantes = gelees.filter((c) => apres[c] !== null && apres[c] !== undefined && apres[c] !== '');
  if (restantes.length) {
    throw new Error(`config : colonnes gelées encore remplies après le drain vers local_config — ${restantes.join(', ')}`);
  }
  if (deplacees.length) {
    console.log(`[db] ${deplacees.length} réglage(s) de poste déplacé(s) de config vers local_config`);
  }
}

/* Amorçage des commandes git — UNE SEULE FOIS par poste. Supprimer toutes les entrées ne les
   réintroduit donc pas : c'est un choix de l'utilisateur. Le drapeau vit dans `local_config`
   parce qu'il décrit CETTE installation, et non ce que l'équipe a décidé ; sans quoi le
   deuxième poste d'une équipe n'aurait jamais ses commandes de départ. */
{
  const seeded = db.prepare('SELECT git_commands_seeded AS s FROM local_config WHERE id = 1').get();
  if (seeded && !seeded.s) {
    const ins = db.prepare('INSERT INTO git_command (label, command, sort_order, created_at) VALUES (?, ?, ?, ?)');
    const now = new Date().toISOString();
    [
      ['Récupérer tout (fetch)', 'fetch --all --prune'],
      ['Statut court', 'status --short --branch'],
      ['Tirer (fast-forward only)', 'pull --ff-only'],
      ['Élaguer les branches distantes disparues', 'remote prune origin'],
      ['10 derniers commits', 'log --oneline -10'],
    ].forEach(([label, command], i) => ins.run(label, command, i, now));
    db.prepare('UPDATE local_config SET git_commands_seeded = 1 WHERE id = 1').run();
  }
}
