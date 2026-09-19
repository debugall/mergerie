'use strict';
/* Ce qui n’appartient qu’à cette machine : `local_state`, `local_pref`, `local_dir_map`, `local_session`.
   Tranche de l'ancien db.js (refacto.md, étape 3), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');

/* ---------- CE QUI N'APPARTIENT QU'À CETTE MACHINE : `local_state` et `local_pref` ----------
 *
 * Deux tables de même forme, aux durées de vie différentes (voir `src/localstate.js`) :
 * `local_state` porte de l'état DÉRIVÉ (quand cet agent planifié a tourné ici, quand ce ticket
 * Jira a été relu ici) et se recalcule ; `local_pref` porte une PRÉFÉRENCE (une session rangée)
 * et ne se recalcule pas.
 *
 * Elles reprennent des colonnes qui vivaient dans des tables PARTAGÉES, où elles n'avaient rien
 * à faire : `agent.schedule_fired_at` dirait au collègue que SON agent a tourné, `jira_watch`
 * lui montrerait MON erreur réseau, et `task.hidden` rangerait chez lui la session qu'on a
 * rangée chez soi. Les colonnes d'origine sont vidées et gelées, comme celles de `config`.
 *
 * `ref` est l'`uid` du parent, jamais son `id` entier : après une réhydratation venue d'un autre
 * poste, les id se renumérotent et la ligne d'ici se retrouverait accrochée au mauvais parent. */
db.exec(`CREATE TABLE IF NOT EXISTS local_state (
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT,
  PRIMARY KEY (kind, ref, key)
)`);
/* OÙ SE TROUVE, SUR CETTE MACHINE, LE DOSSIER QU'UNE SESSION HORS DÉPÔT DÉSIGNE.
 *
 * `local_task_dir.path` était un chemin absolu — `/Users/amady/lin/monprojet`. Sur le Linux du
 * collègue, il ne désigne rien. La session, elle, se partage : ses passes se relisent, son
 * verdict compte. Le fichier du dépôt porte donc `dir_hash` (l'empreinte du chemin normalisé),
 * `dir_label` (le dernier segment, pour l'affichage) et `owner` ; chaque poste résout le chemin
 * CHEZ LUI, dans cette table. Ailleurs, la session s'affiche avec son libellé et son
 * propriétaire, et « Relancer » est refusé plutôt que de lancer l'agent dans le vide.
 *
 * Un autre poste peut RATTACHER son propre dossier au même `dir_hash` : il n'écrit alors que
 * dans sa table à lui. */
db.exec(`CREATE TABLE IF NOT EXISTS local_dir_map (
  dir_hash TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  updated_at TEXT
)`);

/* LE HANDLE D'UNE SESSION D'AGENT — et pourquoi il ne peut pas voyager.
 *
 * `claude` et `copilot` gardent leurs sessions dans le `~/.claude` de la MACHINE qui les a
 * créées. Un handle venu d'un collègue ne désigne rien ici : le reprendre échouerait, ou pire,
 * tomberait sur une session homonyme. Le repli existe déjà — on repart sur une session neuve
 * avec le contexte réinjecté — et il devient simplement le cas normal entre deux postes.
 *
 * `scope` dit de quoi c'est le handle (le projet d'une session, un dossier hors dépôt, une
 * question libre, la review d'une merge request), `ref` est l'`uid` du parent : jamais son id
 * entier, que SQLite recycle après une suppression — une MR redécouverte hériterait alors de la
 * session d'une autre. */
db.exec(`CREATE TABLE IF NOT EXISTS local_session (
  scope TEXT NOT NULL,
  ref TEXT NOT NULL,
  session_key TEXT,
  session_backend TEXT,
  session_cwd TEXT,
  updated_at TEXT,
  PRIMARY KEY (scope, ref)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS local_pref (
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT,
  PRIMARY KEY (kind, ref, key)
)`);

/* LE DRAIN, et le gel qui suit. Rejouable : la seconde exécution ne trouve plus rien à déplacer.
   Placé APRÈS les déclencheurs d'`uid` ci-dessus — il lit la colonne `uid` des parents, qui
   vient d'être remplie sur les lignes existantes. */
{
  const deplacer = (table, cleParent, colonnes, cible, kind) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const aDeplacer = colonnes.filter((c) => cols.includes(c));
    if (!aDeplacer.length) return;
    const poser = db.prepare(`INSERT INTO ${cible} (kind, ref, key, value, updated_at)
                              VALUES (?, ?, ?, ?, ?)
                              ON CONFLICT (kind, ref, key) DO NOTHING`);
    const maintenant = new Date().toISOString();
    /* « REMPLIE » veut dire « porte autre chose que sa valeur neutre ». `task.hidden` a un
       DEFAULT 0 : le traiter comme rempli ferait réécrire toutes les sessions à chaque
       démarrage, et l'assertion du bas se déclencherait dès la première session créée. */
    const remplie = (c) => `${c} IS NOT NULL AND ${c} <> '' AND ${c} <> 0`;
    const lignes = db.prepare(
      `SELECT ${cleParent} AS ref, ${aDeplacer.join(', ')} FROM ${table}
       WHERE ${cleParent} IS NOT NULL AND (${aDeplacer.map(remplie).join(' OR ')})`,
    ).all();
    db.transaction(() => {
      for (const ligne of lignes) {
        for (const col of aDeplacer) {
          if (ligne[col] === null || ligne[col] === undefined || ligne[col] === '') continue;
          poser.run(kind, String(ligne.ref), col, String(ligne[col]), maintenant);
        }
      }
      for (const col of aDeplacer) db.exec(`UPDATE ${table} SET ${col} = NULL WHERE ${remplie(col)}`);
    })();
    /* L'ASSERTION. Après le drain, une colonne gelée encore remplie ne peut plus venir que d'un
       bug de ce fichier — on préfère un serveur qui refuse de démarrer à une donnée de poste
       qui repart un jour dans le dépôt d'équipe. */
    const reste = db.prepare(
      `SELECT COUNT(*) n FROM ${table} WHERE ${aDeplacer.map(remplie).join(' OR ')}`,
    ).get().n;
    if (reste) throw new Error(`${table} : ${aDeplacer.join(', ')} encore rempli(s) après le drain vers ${cible}`);
  };

  /* LE DOSSIER D'UNE SESSION HORS DÉPÔT. Trois colonnes partageables remplacent le chemin
     absolu : l'empreinte (qui permet à chacun de rattacher SON dossier), le libellé (pour que
     la carte dise quelque chose chez le voisin) et le propriétaire. Migration APRÈS le
     `CREATE TABLE local_task_dir`, plus haut. */
  for (const [col, decl] of [['dir_hash', 'TEXT'], ['dir_label', 'TEXT'], ['owner', 'TEXT']]) {
    try { db.exec(`ALTER TABLE local_task_dir ADD COLUMN ${col} ${decl}`); } catch { /* déjà présente */ }
  }
  {
    const aFaire = db.prepare(
      "SELECT id, path FROM local_task_dir WHERE path IS NOT NULL AND path <> ''",
    ).all();
    if (aFaire.length) {
      const { empreinte, libelle } = require('../../core/dirhash');
      const moi = require('../../core/identite').nom() || null;
      /* `path` est `NOT NULL` depuis l'origine : on le gèle à la chaîne vide plutôt qu'à NULL,
         qui serait refusé. Vide veut dire « ce n'est plus ici qu'on lit le chemin ». */
      const poser = db.prepare("UPDATE local_task_dir SET dir_hash = ?, dir_label = ?, owner = COALESCE(owner, ?), path = '' WHERE id = ?");
      const carte = db.prepare(`INSERT INTO local_dir_map (dir_hash, path, updated_at) VALUES (?, ?, ?)
                                ON CONFLICT (dir_hash) DO UPDATE SET path = excluded.path`);
      const maintenant = new Date().toISOString();
      db.transaction(() => {
        for (const d of aFaire) {
          const h = empreinte(d.path);
          carte.run(h, d.path, maintenant);
          poser.run(h, libelle(d.path), moi, d.id);
        }
      })();
    }
    const reste = db.prepare("SELECT COUNT(*) n FROM local_task_dir WHERE path IS NOT NULL AND path <> ''").get().n;
    if (reste) throw new Error('local_task_dir.path encore rempli après le drain vers local_dir_map');
  }

  /* LES HANDLES DE SESSION quittent les tables partagées pour `local_session`. Trois colonnes
     qui voyagent ensemble : les déplacer une par une dans `local_state` les séparerait, alors
     qu'un handle sans son `cwd` perd le garde-fou qui empêche de reprendre une session dans un
     autre dossier. Rejouable : la seconde exécution ne trouve plus rien. */
  {
    const poser = db.prepare(`INSERT INTO local_session (scope, ref, session_key, session_backend, session_cwd, updated_at)
                              VALUES (?, ?, ?, ?, ?, ?)
                              ON CONFLICT (scope, ref) DO NOTHING`);
    const maintenant = new Date().toISOString();
    const sources = [
      ['task_target', 'task_target', ['session_key', 'session_backend', 'session_cwd']],
      ['local_task_dir', 'local_task_dir', ['session_key', 'session_backend', 'session_cwd']],
      ['question', 'question', ['session_key', 'session_backend', 'session_cwd']],
      ['mr', 'mr', ['review_session_key', 'review_session_backend', 'review_session_cwd']],
    ];
    for (const [scope, table, cols] of sources) {
      const presentes = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.every((c) => presentes.includes(c))) continue;
      const lignes = db.prepare(
        `SELECT uid, ${cols.join(', ')} FROM ${table} WHERE uid IS NOT NULL AND ${cols[0]} IS NOT NULL AND ${cols[0]} <> ''`,
      ).all();
      db.transaction(() => {
        for (const l of lignes) poser.run(scope, l.uid, l[cols[0]], l[cols[1]] || null, l[cols[2]] || null, maintenant);
        for (const c of cols) db.exec(`UPDATE ${table} SET ${c} = NULL WHERE ${c} IS NOT NULL AND ${c} <> ''`);
      })();
      const reste = db.prepare(
        `SELECT COUNT(*) n FROM ${table} WHERE ${cols.map((c) => `(${c} IS NOT NULL AND ${c} <> '')`).join(' OR ')}`,
      ).get().n;
      if (reste) throw new Error(`${table} : handles de session encore remplis après le drain vers local_session`);
    }
  }

  deplacer('agent', 'uid', ['schedule_fired_at'], 'local_state', 'agent');
  deplacer('jira_watch', 'key', ['checked_at', 'error'], 'local_state', 'jira_watch');
  deplacer('task', 'uid', ['hidden'], 'local_pref', 'task');
  deplacer('local_task', 'uid', ['hidden'], 'local_pref', 'local_task');
  deplacer('question', 'uid', ['hidden'], 'local_pref', 'question');

  /* LES VALEURS D'ENVIRONNEMENT D'UN VÉRIFICATEUR. Elles partaient dans le dépôt : un
     `DATABASE_URL`, un `NPM_TOKEN`, la clé d'un bac à sable — et un secret commité dans git est
     définitif. On garde les NOMS côté équipe (`env_keys`, pour que le collègue sache quoi
     renseigner) et on déplace les VALEURS ici, une ligne par variable. Le drain générique ne
     convient pas : une seule colonne porte un objet entier, qu'il faut éclater. */
  {
    const aEclater = db.prepare(
      "SELECT uid, env_json FROM verifier WHERE uid IS NOT NULL AND env_json IS NOT NULL AND env_json <> ''",
    ).all();
    if (aEclater.length) {
      const poser = db.prepare(`INSERT INTO local_state (kind, ref, key, value, updated_at)
        VALUES ('verifier_env', ?, ?, ?, ?) ON CONFLICT (kind, ref, key) DO NOTHING`);
      const noms = db.prepare('UPDATE verifier SET env_keys = ?, env_json = NULL WHERE uid = ?');
      const maintenant = new Date().toISOString();
      db.transaction(() => {
        for (const v of aEclater) {
          let obj = {};
          try { obj = JSON.parse(v.env_json) || {}; } catch { obj = {}; }
          const cles = Object.keys(obj).filter(Boolean);
          for (const k of cles) poser.run(v.uid, k, String(obj[k] == null ? '' : obj[k]), maintenant);
          noms.run(JSON.stringify(cles), v.uid);
        }
      })();
    }
    /* L'ASSERTION, comme pour les jetons : une valeur encore là ne peut plus venir que d'un bug
       de ce fichier, et on préfère un serveur qui refuse de démarrer à un secret qui repart. */
    const reste = db.prepare("SELECT COUNT(*) n FROM verifier WHERE env_json IS NOT NULL AND env_json <> ''").get().n;
    if (reste) throw new Error('verifier : env_json encore rempli après le déplacement vers local_state');
  }
}
