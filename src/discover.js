'use strict';
const db = require('./db');
const { getConfig } = require('./config');
const forge = require('./forge');
const jira = require('./jira');
const notify = require('./notify');

/* Récupère le contexte Jira d'une MR nouvelle et le range dans ticket_jira_*.
   Best-effort ABSOLU : toute erreur est capturée et stockée, jamais propagée —
   le discover ne doit jamais être ralenti ni interrompu par Jira. */
async function fetchJiraContext(cfg, mrId, title, branch) {
  const key = jira.ticketKey(title, branch);
  if (!key || !jira.isConfigured(cfg)) return;
  const now = new Date().toISOString();
  try {
    const issue = await jira.fetchIssue(cfg, key);
    const text = jira.issueToContext(issue);
    db.prepare('UPDATE mr SET ticket_jira_text = ?, ticket_jira_key = ?, ticket_jira_at = ?, ticket_jira_error = NULL WHERE id = ?')
      .run(text || null, issue.key, now, mrId);
  } catch (e) {
    // On stocke l'erreur pour que l'UI dise POURQUOI le contexte est vide
    // (ticket introuvable, accès refusé…) plutôt que de laisser croire à un oubli.
    db.prepare('UPDATE mr SET ticket_jira_key = ?, ticket_jira_at = ?, ticket_jira_error = ? WHERE id = ?')
      .run(key, now, String(e.message).slice(0, 300), mrId);
  }
}

// Interroge GitLab pour chaque repo activé, upsert les MR ouvertes filtrées.
// Ne touche pas au statut des MR déjà connues (respecte done / reviewed).
const isDemo = () => process.env.MERGERIE_DEMO === '1';

async function discoverAll() {
  const cfg = getConfig();
  // `fetch_mrs = 0` : dépôt toujours actif (git, sessions), mais on ne ramène plus ses MR.
  // COALESCE : les lignes antérieures à la migration ont la colonne à NULL.
  const repos = db.prepare('SELECT * FROM repo WHERE enabled = 1 AND COALESCE(fetch_mrs, 1) = 1').all();
  const now = new Date().toISOString();
  /* `new_mr_ids` : les MR VRAIMENT nouvelles de ce tour. C'est la seule information qui
     permette de ne déclencher les vérifications automatiques que sur elles — une MR déjà
     connue est revue à chaque découverte, et la relancer à chaque fois ferait tourner la
     batterie sur tout le monde en permanence. */
  /* `stale_mr_ids` : les MR CONNUES dont le SHA vient de changer. C'est le seul moment où
     l'outil apprend qu'un verdict rendu ne vaut plus rien — la péremption, elle, se CALCULE à
     l'affichage et ne déclenche donc rien. Séparé de `new_mr_ids` : arriver et bouger sont deux
     événements, et un vérificateur peut vouloir l'un sans l'autre. */
  const result = { repos: repos.length, found: 0, created: 0, updated: 0, errors: [], new_mr_ids: [], stale_mr_ids: [] };

  /* En démo, la forge n'existe pas : interroger GitLab rendait une erreur par dépôt, sur un
     bouton mis en avant de la page d'accueil. Un scan y trouve légitimement ce qui est déjà
     là — on rend ce compte, sans rien créer ni modifier. */
  if (isDemo()) {
    result.found = db.prepare("SELECT COUNT(*) n FROM mr WHERE closed_seen = 0").get().n;
    return result;
  }

  const selectMr = db.prepare('SELECT * FROM mr WHERE repo_id = ? AND iid = ?');
  const insertMr = db.prepare(`INSERT INTO mr
    (repo_id, iid, title, source_branch, target_branch, web_url, current_sha, gitlab_created_at, author, status, updated_at)
    VALUES (@repo_id, @iid, @title, @source_branch, @target_branch, @web_url, @current_sha, @gitlab_created_at, @author, 'to_review', @updated_at)`);
  const updateMr = db.prepare(`UPDATE mr SET
    title = @title, source_branch = @source_branch, target_branch = @target_branch,
    web_url = @web_url, current_sha = @current_sha, gitlab_created_at = @gitlab_created_at, author = @author, updated_at = @updated_at,
    closed_seen = 0
    WHERE id = @id`);
  const insertFeed = db.prepare('INSERT INTO feed (type, mr_iid, project, author, title, at) VALUES (?,?,?,?,?,?)');
  const markClosed = db.prepare('UPDATE mr SET closed_seen = 1 WHERE id = ?');
  // On ne signale « mergée » que si la MR a été vue ouverte récemment (évite un burst
  // d'événements pour de vieilles MR fantômes au 1er passage). Fenêtre : 7 jours.
  const FRESH_MS = 7 * 24 * 3600 * 1000;
  const newMrs = []; // MR nouvelles : fetch Jira APRÈS la boucle, hors du chemin critique

  for (const repo of repos) {
    try {
      const mrs = await forge.clientFor(repo).listOpenMRs(cfg, repo.project, repo.branch_pattern);
      result.found += mrs.length;
      const openIids = new Set(mrs.map((m) => m.iid));
      for (const m of mrs) {
        const existing = selectMr.get(repo.id, m.iid);
        const base = {
          repo_id: repo.id, iid: m.iid, title: m.title,
          source_branch: m.source_branch, target_branch: m.target_branch,
          web_url: m.web_url, current_sha: m.sha, gitlab_created_at: m.created_at || null,
          author: m.author || '', updated_at: now,
        };
        if (existing) {
          // Le SHA a bougé → tout verdict déjà rendu sur cette MR est périmé.
          if (m.sha && existing.current_sha && m.sha !== existing.current_sha) result.stale_mr_ids.push(existing.id);
          updateMr.run({ ...base, id: existing.id }); // reset closed_seen si réapparue
          result.updated += 1;
        } else {
          const info = insertMr.run(base);
          insertFeed.run('mr_opened', m.iid, repo.project, m.author || '', m.title || '', now); // 🆕 vient d'arriver
          notify.push('mr_new', { mr_id: info.lastInsertRowid, iid: m.iid, project: repo.project, title: m.title || '' });
          // Projets liés par défaut du dépôt → copiés sur la nouvelle MR (zéro clic).
          const defaults = db.prepare('SELECT linked_repo_id, branch FROM repo_link WHERE repo_id = ?').all(repo.id);
          if (defaults.length) {
            const insLink = db.prepare('INSERT INTO mr_link (mr_id, repo_id, branch) VALUES (?, ?, ?)');
            for (const d of defaults) insLink.run(info.lastInsertRowid, d.linked_repo_id, d.branch || null);
          }
          newMrs.push({ id: info.lastInsertRowid, title: m.title, branch: m.source_branch });
          result.created += 1;
        }
      }
      // MR connues, jamais signalées closes, absentes du set ouvert → mergées/fermées.
      const gone = db.prepare('SELECT id, iid, title, author, updated_at FROM mr WHERE repo_id = ? AND (closed_seen IS NULL OR closed_seen = 0)').all(repo.id)
        .filter((g) => !openIids.has(g.iid));
      for (const g of gone) {
        const recent = g.updated_at && (Date.parse(now) - Date.parse(g.updated_at)) < FRESH_MS;
        if (recent) { insertFeed.run('mr_merged', g.iid, repo.project, g.author || '', g.title || '', now); notify.push('mr_merged', { iid: g.iid, project: repo.project, title: g.title || '' }); } // 🔀 vient d'être mergée
        markClosed.run(g.id); // dans tous les cas : ne pas re-signaler
      }
    } catch (e) {
      // fetch en échec : NE PAS considérer les MR de ce repo comme disparues.
      result.errors.push({ repo: repo.project, error: e.message });
    }
  }
  // Contexte Jira des MR nouvelles (zéro clic). Séquentiel et best-effort : chaque
  // échec est déjà capturé dans fetchJiraContext, il n'interrompt jamais le reste.
  if (jira.isConfigured(cfg) && newMrs.length) {
    for (const mr of newMrs) await fetchJiraContext(cfg, mr.id, mr.title, mr.branch);
  }

  /* Chemins modifiés (pour le badge « risque » et les règles par chemin). On les
     récupère pour les MR ouvertes qui ne les ont pas encore — nouvelles incluses,
     et rétro-remplissage des existantes, PLAFONNÉ pour ne pas cogner l'API. Chaque
     échec est ignoré (best-effort) : le badge sera juste absent pour cette MR. */
  const MAX_PATH_FETCHES = 25;
  const needPaths = db.prepare(`SELECT mr.id, mr.iid, repo.project, repo.forge
      FROM mr JOIN repo ON repo.id = mr.repo_id
      WHERE mr.changed_paths IS NULL AND (mr.closed_seen IS NULL OR mr.closed_seen = 0)
      ORDER BY mr.updated_at DESC LIMIT ?`).all(MAX_PATH_FETCHES);
  for (const m of needPaths) {
    try {
      const paths = await forge.clientFor(m).listMrChangedPaths(cfg, m.project, m.iid);
      db.prepare('UPDATE mr SET changed_paths = ? WHERE id = ?').run(paths.join('\n'), m.id);
    } catch { /* best-effort : pas de badge pour cette MR, on continue */ }
  }

  // État réel des MR issues des Dev sessions : elles peuvent avoir été mergées
  // directement sur GitLab. Vérification CIBLÉE (uniquement les tâches dont la MR n'est
  // pas encore marquée mergée) et PLAFONNÉE, pour ménager les rate limits.
  const MAX_TASK_CHECKS = 10;
  const pendingTasks = db.prepare(`SELECT tt.id, tt.mr_iid, tt.branch, repo.project, repo.forge
      FROM task_target tt JOIN repo ON repo.id = tt.repo_id
      WHERE tt.mr_iid IS NOT NULL AND (tt.mr_merged IS NULL OR tt.mr_merged = 0)
      ORDER BY tt.updated_at DESC LIMIT ?`).all(MAX_TASK_CHECKS);
  result.tasksMerged = 0;
  for (const t of pendingTasks) {
    try {
      const m = await forge.clientFor(t).getMergeRequest(cfg, t.project, t.mr_iid);
      if (m && m.state === 'merged') {
        db.prepare('UPDATE task_target SET mr_merged = 1, updated_at = ? WHERE id = ?').run(now, t.id);
        insertFeed.run('mr_merged', t.mr_iid, t.project, '', t.branch || '', now);
        result.tasksMerged += 1;
      } else if (m) {
        /* CONFLITS : l'appel est DÉJÀ fait ci-dessus pour savoir si la MR est mergée — on lit
           la réponse au passage. Le bouton « Mettre à jour avec … » ne coûte ainsi aucun appel
           d'API supplémentaire. `null` = pas encore su (GitHub calcule `mergeable` de façon
           asynchrone) : on l'écrit tel quel, pour ne pas confondre avec « pas de conflit ». */
        const enConflit = m.has_conflicts === true ? 1 : (m.has_conflicts === false ? 0 : null);
        db.prepare('UPDATE task_target SET mr_conflicts = ? WHERE id = ?').run(enConflit, t.id);
        if (enConflit) result.mrConflicts = (result.mrConflicts || 0) + 1;
      }
    } catch (e) {
      // une MR inaccessible/supprimée ne doit pas casser la découverte
      result.errors.push({ repo: t.project, error: `MR !${t.mr_iid} : ${e.message}` });
    }
  }

  // borne la taille du journal (on garde les 200 plus récents)
  db.prepare('DELETE FROM feed WHERE id NOT IN (SELECT id FROM feed ORDER BY at DESC LIMIT 200)').run();
  result.new_mr_ids = newMrs.map((m) => m.id);
  return result;
}

/* Upsert CIBLÉ d'une seule MR (objet API GitLab) dans la table `mr`, sans balayer
   tout GitLab. Utilisé quand une session de dev vient de créer sa MR et qu'on veut
   immédiatement une ligne `mr` pour la convergence. Renvoie l'id local de la MR.
   À l'INSERT, on reproduit l'enrichissement de discoverAll (projets liés par défaut,
   contexte Jira, journal) : sans lui, la MR de la session serait reviewée avec MOINS
   de contexte qu'une MR découverte — or ce sont ces notes qui pilotent la convergence. */
async function upsertMrFromApi(repoId, m) {
  const now = new Date().toISOString();
  const author = (m.author && (m.author.name || m.author.username)) || (typeof m.author === 'string' ? m.author : '') || '';
  const existing = db.prepare('SELECT id FROM mr WHERE repo_id = ? AND iid = ?').get(repoId, m.iid);
  if (existing) {
    db.prepare(`UPDATE mr SET title = ?, source_branch = ?, target_branch = ?, web_url = ?,
        current_sha = ?, gitlab_created_at = ?, author = ?, updated_at = ?, closed_seen = 0 WHERE id = ?`)
      .run(m.title, m.source_branch, m.target_branch, m.web_url, m.sha, m.created_at || null, author, now, existing.id);
    return existing.id;
  }
  const info = db.prepare(`INSERT INTO mr
    (repo_id, iid, title, source_branch, target_branch, web_url, current_sha, gitlab_created_at, author, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'to_review', ?)`)
    .run(repoId, m.iid, m.title, m.source_branch, m.target_branch, m.web_url, m.sha, m.created_at || null, author, now);
  const id = info.lastInsertRowid;

  const repo = db.prepare('SELECT project FROM repo WHERE id = ?').get(repoId);
  db.prepare('INSERT INTO feed (type, mr_iid, project, author, title, at) VALUES (?,?,?,?,?,?)')
    .run('mr_opened', m.iid, (repo && repo.project) || '', author, m.title || '', now);
  notify.push('mr_new', { mr_id: id, iid: m.iid, project: (repo && repo.project) || '', title: m.title || '' });

  // Projets liés par défaut du dépôt → copiés sur la nouvelle MR (le reviewer les lit).
  const defaults = db.prepare('SELECT linked_repo_id, branch FROM repo_link WHERE repo_id = ?').all(repoId);
  if (defaults.length) {
    const insLink = db.prepare('INSERT INTO mr_link (mr_id, repo_id, branch) VALUES (?, ?, ?)');
    for (const d of defaults) insLink.run(id, d.linked_repo_id, d.branch || null);
  }
  // Contexte Jira : best-effort ABSOLU, fetchJiraContext capture déjà toute erreur.
  await fetchJiraContext(getConfig(), id, m.title, m.source_branch);
  return id;
}

module.exports = { discoverAll, upsertMrFromApi };
