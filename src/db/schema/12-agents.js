'use strict';
/* Les agents : profils, dépôts couverts, connaissance versionnée.
   Tranche de l'ancien db.js (réorganisation de src/ par couches), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');

/* ---------- AGENTS : des profils de session ----------
   Un « agent » Mergerie n'est pas un orchestrateur : c'est ce qu'on met AUTOUR d'un lancement
   du CLI — un rôle, un périmètre, des outils, des skills, des sous-agents, une sortie, un
   horaire. Un RUN d'agent est une `task` ordinaire portant `agent_id` : suivis, questions,
   passes archivées, file de jobs et coût viennent sans une ligne de plus.

   `builtin_key` marque les agents LIVRÉS (l'enquêteur, le documentaliste, le cartographe) :
   modifiables comme les autres, restaurables d'un bouton. `knowledge_prompt` non nul marque un
   agent de DOMAINE — pas de colonne de famille, la présence du sujet suffit à le dire. */
db.exec(`CREATE TABLE IF NOT EXISTS agent (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  builtin_key TEXT,
  kind TEXT NOT NULL DEFAULT 'explore' CHECK (kind IN ('explore','code')),
  scope_kind TEXT NOT NULL DEFAULT 'all_repos' CHECK (scope_kind IN ('repos','all_repos')),
  system_prompt TEXT NOT NULL DEFAULT '',
  prompt_template TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  permission_mode TEXT NOT NULL DEFAULT '',
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  disallowed_tools_json TEXT NOT NULL DEFAULT '[]',
  max_turns INTEGER,
  skills_json TEXT NOT NULL DEFAULT '[]',
  subagents_json TEXT NOT NULL DEFAULT '{}',
  output_kind TEXT NOT NULL DEFAULT 'report' CHECK (output_kind IN ('report','note_page','agent')),
  output_ref TEXT,
  knowledge_prompt TEXT,
  schedule TEXT,
  schedule_fired_at TEXT,
  defaults_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS agent_repo (
  agent_id INTEGER NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  branch TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'readonly' CHECK (role IN ('target','readonly')),
  PRIMARY KEY (agent_id, repo_id)
)`);
/* La connaissance d'un agent de domaine : un document Markdown VERSIONNÉ et daté par le SHA
   de chaque dépôt au moment où il a été écrit. C'est ce SHA qui permet de dire, sans IA, que
   la carte a vieilli — `git log <sha>..origin/<défaut> -- <chemins>` compte les commits qui
   ont touché ce qu'elle cite. Une seule version `active` à la fois, garantie par l'index. */
db.exec(`CREATE TABLE IF NOT EXISTS agent_knowledge (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  md_path TEXT NOT NULL,
  repos_json TEXT NOT NULL DEFAULT '[]',
  task_id INTEGER,
  diff_summary TEXT,
  gaps_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','superseded')),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE (agent_id, version)
)`);
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS agent_knowledge_active ON agent_knowledge(agent_id) WHERE status = 'active'");
/* CE QUE LA CARTE COÛTE À LIRE. Une connaissance de domaine est recopiée dans le prompt de
   chaque run de l'agent : sa taille en tokens est donc une dépense RÉCURRENTE, pas une
   curiosité. Comptée à l'écriture et rangée ici — la recalculer à chaque affichage de la
   liste rouvrirait un fichier par version, par agent, à chaque passage sur l'onglet. NULL sur
   les versions écrites avant cette colonne : elles sont comptées à la première relecture.
   Migration APRÈS le `CREATE TABLE agent_knowledge` ci-dessus. */
try { db.exec('ALTER TABLE agent_knowledge ADD COLUMN tokens INTEGER'); } catch { /* déjà présente */ }

/* Un run d'agent EST une session. Trois colonnes suffisent : quel profil, son nom au moment du
   run (la session reste lisible même après suppression du profil), et qui a appuyé — la main
   ou l'horaire. Migrations APRÈS le `CREATE TABLE task`, plus haut dans ce fichier. */
try { db.exec('ALTER TABLE task ADD COLUMN agent_id INTEGER REFERENCES agent(id) ON DELETE SET NULL'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE task ADD COLUMN agent_name TEXT'); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE task ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'manual'"); } catch { /* déjà présente */ }
/* LA DEMANDE TELLE QU'ELLE A ÉTÉ TAPÉE, avant composition. `task.prompt` porte la demande
   COMPOSÉE — gabarit, fichiers d'entrée, consignes, protocoles : c'est ce que l'agent reçoit,
   et c'est illisible pour un humain. Le sujet d'un agent de domaine, le titre du rapport et le
   libellé de la carte viennent tous de la question d'origine ; sans cette colonne, ils
   recopiaient la première ligne du gabarit (« Sujet à cartographier : »). */
try { db.exec('ALTER TABLE task ADD COLUMN agent_question TEXT'); } catch { /* déjà présente */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_task_agent ON task(agent_id)');
// Plafond de runs déclenchés par un horaire, par jour. 0 = illimité.
try { db.exec('ALTER TABLE config ADD COLUMN agent_auto_max INTEGER NOT NULL DEFAULT 10'); } catch { /* déjà présente */ }
/* Les bornes d'un agent (config.js) : tours par session et dépense du jour. */
try { db.exec('ALTER TABLE config ADD COLUMN agent_max_turns INTEGER NOT NULL DEFAULT 200'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN agent_daily_budget_usd REAL NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }

/* QUI HONORE L'HORAIRE D'UN AGENT. Trois instances allumées dans une équipe lanceraient trois
   fois le même agent planifié, chacune persuadée d'être la seule — et paieraient trois fois.
   `runner` porte l'identité git de l'exécutant ; vide = personne, l'agent ne tourne qu'à la
   main. Migration APRÈS le `CREATE TABLE agent` ci-dessus. */
try { db.exec('ALTER TABLE agent ADD COLUMN runner TEXT'); } catch { /* déjà présente */ }

/* Rapatrié depuis l'ancienne tranche 11 (supprimée avec la dictée vocale, qui n'avait rien à
   voir avec ce DROP) : une base qui n'a jamais joué cette tranche ne doit pas garder ces deux
   colonnes de `config`, orphelines depuis longtemps. */
try { db.exec('ALTER TABLE config DROP COLUMN health_check'); } catch { /* déjà retirée */ }
try { db.exec('ALTER TABLE config DROP COLUMN health_minutes'); } catch { /* déjà retirée */ }
