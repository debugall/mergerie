'use strict';
/* Les notes, les images de note, les todos et le brief.
   Tranche de l'ancien db.js (réorganisation de src/ par couches), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');

/* ---------- Notes, todos et rappels (plan_add_notes.md) ----------
   Des notes de POSTE DE TRAVAIL, pas une base de connaissances : des pages plates (ni
   dossiers ni hiérarchie), une liste de todos et des rappels datés. Tout vit dans cette
   base, donc dans la sauvegarde existante — c'est la raison pour laquelle ces post-it
   valent mieux qu'un fichier texte à côté. */
db.exec(`CREATE TABLE IF NOT EXISTS note_page (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_note_page_ordre ON note_page(pinned DESC, updated_at DESC)');
/* LES SOUS-PAGES. Une documentation tient rarement en une page : un texte général, et le
   détail de chaque point à côté. Tout mettre dans une seule page la rend illisible ; en faire
   vingt pages sœurs perd le lien entre elles. Un seul niveau, volontairement — une
   arborescence profonde se navigue mal dans une colonne de 300 pixels, et « le détail du
   détail » est le signe qu'il fallait une page de plus, pas un étage de plus. Le parent
   emporte ses sous-pages (cascade, `foreign_keys = ON` en tête de ce fichier).
   Migration APRÈS le `CREATE TABLE note_page` ci-dessus. */
try { db.exec('ALTER TABLE note_page ADD COLUMN parent_id INTEGER REFERENCES note_page(id) ON DELETE CASCADE'); } catch { /* déjà présente */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_note_page_parent ON note_page(parent_id)');
/* UNE PAGE DE NOTES SE PARTAGE UNE PAR UNE, ET PAR DÉFAUT NON. Les notes sont le seul endroit
   de l'outil où l'on écrit sans destinataire : un brouillon, un mot de passe temporaire collé
   le temps d'un test, ce qu'on pense d'une architecture avant de savoir le dire. Tout le reste
   du travail accumulé est un produit — une review, une règle, une carte du code — et se partage
   donc en bloc. Les notes, non : elles montent dans le dépôt d'équipe QUAND ON LE DIT.
   `DEFAULT 0` et non `1` : le défaut d'une case qui publie doit être « non ». Une page déjà
   écrite avant cette colonne reste donc à soi, ce qui est aussi le seul défaut rattrapable —
   l'inverse aurait poussé des brouillons chez tout le monde au premier démarrage.
   Migration APRÈS le `CREATE TABLE note_page` ci-dessus. */
try { db.exec('ALTER TABLE note_page ADD COLUMN shared INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }

/* Captures collées DANS une page de notes. Le fichier vit sur disque, la page ne garde qu'un
   lien Markdown : mettre l'image en base64 dans `content` ferait grossir la ligne de plusieurs
   mégaoctets et la renverrait en entier à chaque sauvegarde automatique — c'est-à-dire toutes
   les secondes pendant qu'on écrit. La suppression de la page emporte les lignes (cascade) ;
   les fichiers, eux, sont retirés explicitement (voir la route DELETE). */
db.exec(`CREATE TABLE IF NOT EXISTS note_image (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES note_page(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_note_image_page ON note_image(page_id)');

/* `due_at` porte À LA FOIS l'échéance et le rappel — une seule vérité plutôt qu'une entité
   `reminder` séparée qu'il faudrait réconcilier. `reminded_at` empêche la re-notification,
   et tout changement de `due_at` le remet à NULL (voir src/notes.js). `archived_at` sort des
   listes une todo faite depuis plus de sept jours, sans jamais la supprimer. */
db.exec(`CREATE TABLE IF NOT EXISTS todo (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  note TEXT,
  link_kind TEXT CHECK (link_kind IN ('mr','ticket','repo','branch','verification','build','container')),  -- cf. B16 plus bas
  link_ref TEXT,
  due_at TEXT,
  reminded_at TEXT,
  done_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_todo_due ON todo(status, archived_at, due_at)');

/* UN ORDRE À SOI. Le tri automatique (priorité, puis échéance) répond à « qu'est-ce qui
   presse » ; il ne répond pas à « dans quel ordre je vais m'y prendre ce matin ». Les deux
   coexistent : la liste « à faire » suit désormais l'ordre qu'on lui donne, pendant que la
   priorité et l'échéance continuent d'alimenter le brief et les pastilles du menu.

   APRÈS la création de la table, comme toute migration ici. Le remplissage reprend EXACTEMENT
   l'ordre affiché jusqu'ici : le premier jour, personne ne voit sa liste changer — on ne
   réordonne pas les todos de quelqu'un pour lui annoncer qu'il peut les réordonner. */
try {
  db.exec('ALTER TABLE todo ADD COLUMN position INTEGER');
  db.exec(`UPDATE todo SET position = (SELECT n FROM (
      SELECT id, ROW_NUMBER() OVER (ORDER BY
        CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, id DESC) AS n
      FROM todo) x WHERE x.id = todo.id)`);
} catch { /* déjà présente */ }
/* Une todo arrivée après la migration n'a pas de position : elle se range en TÊTE (position
   NULL triée en premier), là où on vient de la taper — la chercher en bas d'une liste de
   trente serait absurde. */
db.exec('CREATE INDEX IF NOT EXISTS idx_todo_position ON todo(status, archived_at, position)');

/* LES TODOS QUE L'OUTIL POSE LUI-MÊME. Une session de dev qui s'arrête sur une question attend
   — parfois des heures, parce qu'on est passé à autre chose et que rien ne le rappelle. Elle
   pose donc sa propre todo, et la referme quand on a répondu.

   Une colonne à part plutôt que `link_kind` : celui-ci est contraint par un CHECK (mr/ticket/
   repo) et sert le lien que l'UTILISATEUR choisit. Mélanger les deux obligerait à reconstruire
   la table pour ajouter un type, et brouillerait « ce que j'ai lié » avec « ce que l'outil a
   posé ». `auto_ref` porte de quoi la retrouver pour la fermer. */
try { db.exec('ALTER TABLE todo ADD COLUMN auto_kind TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE todo ADD COLUMN auto_ref TEXT'); } catch { /* déjà présente */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_todo_auto ON todo(auto_kind, auto_ref)');

/* B16 — CE À QUOI UNE TODO PEUT SE LIER. Le `CHECK` d'origine ne connaissait que trois objets
   (`mr`, `ticket`, `repo`), et le bouton « Ajouter aux todos » n'existait donc que là où ils
   vivent — la fiche de review et la carte Jira. Or « rebaser cette branche avant lundi »,
   « ce vérificateur est rouge depuis mardi », « ce build casse une fois sur trois », « ce
   conteneur retombe » sont exactement les choses qu'on se note, et elles n'avaient nulle part
   où s'accrocher : on les écrivait en texte libre, sans lien pour y retourner.

   SQLite ne sait pas modifier une contrainte : on RECONSTRUIT la table (deuxième et dernière
   migration de ce fichier à le faire, cf. `service_url`). Tout est recopié tel quel — une todo
   n'est jamais perdue par une migration —, et la table repart avec les mêmes index. */
{
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'todo'").get() || {}).sql || '';
  if (sql.includes("link_kind IN ('mr','ticket','repo')")) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`CREATE TABLE todo_v2 (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
        note TEXT,
        link_kind TEXT CHECK (link_kind IN ('mr','ticket','repo','branch','verification','build','container')),
        link_ref TEXT,
        due_at TEXT,
        reminded_at TEXT,
        done_at TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        position INTEGER,
        auto_kind TEXT,
        auto_ref TEXT
      )`);
      db.exec(`INSERT INTO todo_v2 (id, title, priority, status, note, link_kind, link_ref, due_at,
          reminded_at, done_at, archived_at, created_at, updated_at, position, auto_kind, auto_ref)
        SELECT id, title, priority, status, note, link_kind, link_ref, due_at,
          reminded_at, done_at, archived_at, created_at, updated_at, position, auto_kind, auto_ref
        FROM todo`);
      db.exec('DROP TABLE todo');
      db.exec('ALTER TABLE todo_v2 RENAME TO todo');
      db.exec('CREATE INDEX IF NOT EXISTS idx_todo_due ON todo(status, archived_at, due_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_todo_position ON todo(status, archived_at, position)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_todo_auto ON todo(auto_kind, auto_ref)');
    })();
    db.pragma('foreign_keys = ON');
  }
}

/* UNE TODO EST PERSONNELLE PAR NATURE — elle se partage donc une par une, comme une session.
 *
 * Deux indices le disaient déjà : `reminded_at` est local (« un rappel est personnel »), et les
 * todos AUTOMATIQUES naissent de sources classées locales — la veille Jira, la question posée
 * par un agent au milieu d'une session. Partagées en bloc, la veille d'un collègue remplissait
 * la liste de tout le monde. Une todo d'équipe existe (« relire le lot X avant vendredi »),
 * mais c'est la case à cocher, pas le défaut.
 * Migration APRÈS le `CREATE TABLE todo` — y compris la variante `todo_v2` renommée ci-dessus,
 * d'où la place de cette ligne. */
try { db.exec('ALTER TABLE todo ADD COLUMN shared INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }

/* CE QU'ON A ÉCARTÉ DU BRIEF. Le brief recalcule tout à chaque ouverture : un fait qui reste
   vrai reparaît tous les matins, même traité ailleurs — une vérification rouge dont on a déjà
   fait le tour revient indéfiniment et finit par apprendre à ne plus lire la section.

   On écarte donc la LIGNE, pas le sujet : la clé est l'identifiant de l'objet vu (ce verdict-ci,
   cette MR-là). Une nouvelle vérification du même lot porte un autre identifiant et reparaît —
   c'est voulu : on a écarté un constat, pas éteint une alarme. Rien n'est supprimé, et tout se
   réaffiche d'un bouton. */
db.exec(`CREATE TABLE IF NOT EXISTS brief_hidden (
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
)`);

/* Atterrissage sur le brief à la première ouverture de la journée. En base et non en
   localStorage : c'est un RÉGLAGE (comme la langue), et il doit valoir pour l'outil, pas
   pour un navigateur. La date du dernier affichage, elle, reste locale — deux navigateurs
   ouverts n'ont pas à se voler le brief l'un l'autre. */
try { db.exec("ALTER TABLE config ADD COLUMN brief_on_open TEXT DEFAULT '1'"); } catch { /* déjà présente */ }
