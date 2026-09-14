'use strict';
/* LE REGISTRE DES TABLES — qui part dans le dépôt de données, qui reste ici.
 *
 * Mergerie devient partageable : le travail accumulé (reviews, règles, agents, notes…) vit dans
 * un dépôt git d'équipe, et SQLite redevient un cache local. La décision de fond n'est pas
 * technique, elle est de classement : CHAQUE TABLE APPARTIENT À UNE SEULE FAMILLE.
 *
 *   P — partagé  : le travail accumulé. Une ligne = un fichier du dépôt (ou une liste dans le
 *                  fichier de son parent). C'est ce qu'une équipe se dit.
 *   L — local    : secret (jetons) ou propre à un poste (chemins absolus, handles de session,
 *                  préférences d'affichage). N'entre JAMAIS dans le dépôt.
 *   C — cache    : relu de la forge, de Jenkins, de Docker ou du disque. Se recrée tout seul,
 *                  donc ne se partage pas — le partager, ce serait partager du périmé.
 *
 * Ce fichier est PUR : aucun `require` vers la base. Il est lisible par `npm run check`, par les
 * tests unitaires et, plus tard, par la couche `store`. Une table de `src/db.js` absente d'ici
 * fait échouer `npm run check` : on ne veut pas qu'une table nouvelle parte dans le dépôt — ou
 * en soit exclue — par oubli, car dans un sens comme dans l'autre l'oubli est silencieux.
 *
 * DEUX TABLES SONT COUPÉES EN DEUX, et c'est assumé :
 *   `config` est P (les réglages d'équipe : gabarits de prompt, seuils, URLs) mais porte les
 *   jetons, qui sont L → `locales` les nomme un par un.
 *   `mr` est C (la forge fait foi de son titre, de sa branche, de son SHA) mais porte l'état du
 *   travail du relecteur, qui est P → `partagees` les nomme un par un.
 * Ces deux listes sont la seule exception à « une table, une famille », et elles sont explicites
 * plutôt que déduites : une liste noire implicite finit toujours par laisser passer un secret.
 *
 * `partageable(row)`, sur une table P, se lit « cette LIGNE-CI part-elle ? ». Une seule table
 * s'en sert (`note_page`) et c'est voulu : le classement reste par table, et la question ne se
 * pose ligne par ligne que là où l'on écrit sans destinataire.
 *
 * `locales` sur une table P se lit « ces colonnes ne sortent jamais dans le fichier » : un chemin
 * absolu (`/Users/amady/…`) ne désigne rien sur le poste d'en face, un handle de session d'agent
 * ne vaut que dans le `~/.claude` qui l'a créé, et `hidden` est un geste de rangement personnel.
 */

/* Les tables de travail des migrations : elles sont créées, remplies, renommées et n'existent
   plus après le démarrage. Les classer n'aurait aucun sens. */
const TRANSITOIRES = ['todo_v2', 'service_url_v2', 'verification_new'];

/* Ce qu'un nom de colonne ne doit jamais porter dans un fichier du dépôt. Le test unitaire du
   registre s'en sert pour relire chaque `locales` : une colonne qui ressemble à un secret ou à un
   chemin de poste et qui N'EST PAS déclarée locale est un échec. */
const INTERDITS = [/token/i, /_key$/i, /password/i, /secret/i, /^path$/i, /_path$/i, /^cwd$/i, /_cwd$/i];

/* Colonnes dont le nom déclenche `INTERDITS` mais qui sont bel et bien d'équipe, avec la raison.
   Une exception se justifie ici, pas dans un coin du code. */
const EXCEPTIONS = {
  'jira_watch.key': 'la clé du ticket Jira (PROJ-1408), l’identité même de la ligne',
  'agent.builtin_key': 'le nom d’un profil livré avec l’outil, pas un secret',
  'config.jira_test_key': 'la clé d’un ticket de test, saisie à la main',
  'config.review_skill': 'le nom d’une compétence (« git-review »)',
  'verifier.report_path': 'un chemin RELATIF dans le dépôt vérifié, le même partout',
  'todo.link_kind': 'le genre d’objet lié (mr, task…)',
  'lot_member.kind': 'le genre de membre',
  'verify_run_test.targets_key': 'l’empreinte des cibles d’un run, calculée, la même partout',
  'repo_jenkins.job_path': 'le chemin d’un job DANS Jenkins (dossier/job), pas un chemin de disque',
  'mr_comment_draft.old_path': 'un chemin DANS le diff, relatif au dépôt : le même partout',
  'mr_comment_draft.new_path': 'un chemin DANS le diff, relatif au dépôt : le même partout',
  'agent_knowledge.tokens': 'un NOMBRE de jetons de modèle — le coût de la connaissance, pas un secret',
};

/* L'extension d'un fichier joint, `.png` à défaut : le dépôt nomme l'image par l'uid de sa
   ligne, mais garde le type — un `.png` renommé `.jpg` ne s'afficherait nulle part. */
const extensionDe = (chemin) => {
  const m = /(\.[A-Za-z0-9]{1,5})$/.exec(String(chemin || ''));
  return m ? m[1].toLowerCase() : '.png';
};

/* CE À QUOI UNE TODO EST ACCROCHÉE, dans les deux sens.
   Trois genres sur sept référencent une ligne par son id entier — et un id entier ne veut rien
   dire sur un autre poste. On les traduit en désignations lisibles. Les quatre autres
   (`ticket`, `build`, `container`, et la référence d'une todo automatique) portent déjà un
   texte qui a le même sens partout : on n'y touche pas. */
function refSortante(kind, ref, ctx) {
  if (!kind || ref === null || ref === undefined || ref === '') return null;
  if (kind === 'mr') return ctx.mrRef(Number(ref));
  if (kind === 'repo') return ctx.repoRef(Number(ref));
  if (kind === 'branch') {
    const i = String(ref).indexOf(':');
    if (i <= 0) return null;
    const r = ctx.repoRef(Number(String(ref).slice(0, i)));
    return r ? `${r}:${String(ref).slice(i + 1)}` : null;
  }
  if (kind === 'verification') return ctx.uid('verification', Number(ref));
  return String(ref);
}

function refEntrante(kind, ref, ctx) {
  if (!kind || !ref) return null;
  if (kind === 'mr') return numOuNull(ctx.mrId(ref));
  if (kind === 'repo') return numOuNull(ctx.repoId(ref));
  if (kind === 'branch') {
    const i = String(ref).lastIndexOf(':');
    if (i <= 0) return null;
    const id = ctx.repoId(String(ref).slice(0, i));
    return id ? `${id}:${String(ref).slice(i + 1)}` : null;
  }
  if (kind === 'verification') return numOuNull(ctx.id('verification', ref));
  return String(ref);
}

const numOuNull = (v) => (v ? String(v) : null);

/* Une entrée par table. Pour une table P :
     cle      — ce qui nomme le fichier : 'uid' (ULID), ou la colonne naturelle qui fait identité
     chemin   — le gabarit du fichier dans le dépôt ({…} = champ de la ligne)
     parent   — pour une liste fille : la table du fichier qui l'héberge
     liste    — le nom de la liste dans le fichier du parent
     fusion   — 'append-only' (nommé par uid, deux postes ne touchent jamais le même fichier :
                aucun conflit possible), 'last-writer' (le plus récent gagne, l'autre est prévenu
                et récupère sa version d'un clic), 'parent' (la règle du parent s'applique)
     locales  — les colonnes qui ne sortent pas
     fichiers — les fichiers de contenu posés à côté, pour mémoire */
const REGISTRE = [
  /* ── Dépôts, merge requests, reviews ─────────────────────────────────────────────────── */
  {
    table: 'repo', famille: 'P', uidPropre: true, cle: 'project', chemin: 'repos/{forge}/{project}.json',
    fusion: 'last-writer',
    note: 'l’URL, le motif de branche et les bascules sont d’équipe ; le chemin de clone est dans config',
    commitMessage: (r) => `repo ${r.forge || 'gitlab'}/${r.project}`,
    toFile: (r, ctx) => ({
      uid: r.uid,
      forge: r.forge || 'gitlab',
      project: r.project,
      url: r.url,
      branch_pattern: r.branch_pattern || null,
      enabled: r.enabled ? 1 : 0,
      fetch_mrs: r.fetch_mrs ? 1 : 0,
      created_at: r.created_at,
      /* Les projets liés PAR DÉFAUT et les jobs Jenkins d'un dépôt vivent dans SON fichier : ils
         ne se modifient qu'avec lui, et un conflit sur eux est un conflit sur le dépôt. */
      linked: ctx.enfants('repo_link', 'repo_id', r.id)
        .map((l) => ({ repo: ctx.repoRef(l.linked_repo_id), branch: l.branch || null }))
        .filter((l) => l.repo),
      jenkins: ctx.enfants('repo_jenkins', 'repo_id', r.id)
        .map((j) => ({ job_path: j.job_path, param: j.param || null })),
    }),
    fromFile: (doc) => ({
      uid: doc.uid,
      forge: doc.forge || 'gitlab',
      project: doc.project,
      url: doc.url,
      branch_pattern: doc.branch_pattern || '',
      enabled: doc.enabled ? 1 : 0,
      fetch_mrs: doc.fetch_mrs ? 1 : 0,
      created_at: doc.created_at,
    }),
    listes: [
      {
        table: 'repo_link',
        liste: 'linked',
        colonneParent: 'repo_id',
        remplace: (db2, parent, items, ctx, signaler) => {
          db2.prepare('DELETE FROM repo_link WHERE repo_id = ?').run(parent.id);
          const ins = db2.prepare('INSERT INTO repo_link (repo_id, linked_repo_id, branch) VALUES (?,?,?)');
          for (const l of items) {
            const id = ctx.repoId(l.repo);
            if (!id) { signaler(`projet lié « ${l.repo} », dépôt inconnu sur ce poste`); continue; }
            ins.run(parent.id, id, l.branch || '');
          }
        },
      },
      {
        table: 'repo_jenkins',
        liste: 'jenkins',
        colonneParent: 'repo_id',
        remplace: (db2, parent, items) => {
          db2.prepare('DELETE FROM repo_jenkins WHERE repo_id = ?').run(parent.id);
          const ins = db2.prepare('INSERT INTO repo_jenkins (repo_id, job_path, param) VALUES (?,?,?)');
          for (const j of items) ins.run(parent.id, j.job_path, j.param || null);
        },
      },
    ],
  },
  { table: 'repo_link', famille: 'P', uidPropre: true, parent: 'repo', liste: 'linked', fusion: 'parent' },
  { table: 'repo_jenkins', famille: 'P', uidPropre: true, parent: 'repo', liste: 'jenkins', fusion: 'parent' },
  {
    /* `uidPropre` alors que le FICHIER est nommé par la clé naturelle : les deux ne servent pas
       à la même chose. Le fichier se nomme `forge/projet/iid`, qui désigne la même merge request
       partout. L'uid, lui, est une identité LOCALE stable : c'est lui qui rattache le handle de
       session de review dans `local_session`, et un `id` entier ne conviendrait pas — SQLite les
       recycle, et une MR supprimée puis redécouverte hériterait de la session d'une autre. */
    table: 'mr', famille: 'C', uidPropre: true, chemin: 'mrs/{forge}/{project}/{iid}.json',
    fusion: 'last-writer',
    partagees: ['status', 'reviewed_sha', 'ticket_text', 'ticket_image', 'squash',
      'remove_source_branch', 'closed_seen'],
    fichiers: ['mrs/{forge}/{project}/{iid}.{ext} (image du ticket)'],
    note: 'la forge fait foi du reste : titre, branches, SHA, auteur, fichiers changés, Jira',
    commitMessage: (r, ctx) => `mr ${ctx ? ctx.mrRef(r.id) || r.iid : r.iid}`,
    /* LE FICHIER NE PORTE QUE LE TRAVAIL DU RELECTEUR. Titre, branches, SHA, auteur, fichiers
       changés : la forge fait foi, chaque poste les relit lui-même, et les écrire ici ferait
       voyager du périmé. Ce qui se partage, c'est ce qu'un humain a décidé — l'état de
       relecture, le contexte qu'il a saisi, les options de merge choisies. */
    toFile: (r, ctx) => {
      const m = ctx.mrChemin(r.id) || {};
      return {
        uid: r.uid,
        repo: ctx.repoRef(r.repo_id),
        iid: r.iid,
        forge: m.forge,
        project: m.project,
        status: r.status,
        reviewed_sha: r.reviewed_sha || null,
        ticket_text: r.ticket_text || null,
        squash: r.squash == null ? null : (r.squash ? 1 : 0),
        remove_source_branch: r.remove_source_branch == null ? null : (r.remove_source_branch ? 1 : 0),
        closed_seen: r.closed_seen ? 1 : 0,
        updated_at: r.updated_at,
        links: ctx.enfants('mr_link', 'mr_id', r.id)
          .map((l) => ({ repo: ctx.repoRef(l.repo_id), branch: l.branch || null }))
          .filter((l) => l.repo),
        drafts: ctx.enfants('mr_comment_draft', 'mr_id', r.id).map((d) => ({
          uid: d.uid, old_path: d.old_path || null, new_path: d.new_path || null,
          old_line: d.old_line, new_line: d.new_line, body: d.body,
          created_at: d.created_at, updated_at: d.updated_at,
        })),
        comment_log: ctx.enfants('comment_log', 'mr_id', r.id).map((c) => ({
          uid: c.uid, body: c.body, note_id: c.gitlab_note_id || null, sent_at: c.sent_at,
        })),
      };
    },
    /* HYDRATER une MR ne CRÉE pas la ligne de cache : la découverte s'en charge, avec le titre et
       les branches que la forge donne. On n'écrit donc que les colonnes partagées — et si la MR
       n'existe pas encore ici, on la crée en `closed_seen` avec le minimum, pour que ses reviews
       restent lisibles même quand elle a été fermée depuis. */
    fromFile: (doc, ctx) => ({
      uid: doc.uid,
      repo_id: ctx.repoId(doc.repo),
      iid: doc.iid,
      status: doc.status || 'to_review',
      reviewed_sha: doc.reviewed_sha || null,
      ticket_text: doc.ticket_text || null,
      squash: doc.squash == null ? null : (doc.squash ? 1 : 0),
      remove_source_branch: doc.remove_source_branch == null ? null : (doc.remove_source_branch ? 1 : 0),
      closed_seen: doc.closed_seen ? 1 : 0,
      updated_at: doc.updated_at,
    }),
    referencesDifferees: ['repo_id'],
    refSource: { repo_id: 'repo' },
    listes: [
      {
        table: 'mr_link',
        liste: 'links',
        colonneParent: 'mr_id',
        remplace: (db2, parent, items, ctx, signaler) => {
          db2.prepare('DELETE FROM mr_link WHERE mr_id = ?').run(parent.id);
          const ins = db2.prepare('INSERT INTO mr_link (mr_id, repo_id, branch) VALUES (?,?,?)');
          for (const l of items) {
            const id = ctx.repoId(l.repo);
            if (!id) { signaler(`projet lié « ${l.repo} », dépôt inconnu sur ce poste`); continue; }
            ins.run(parent.id, id, l.branch || '');
          }
        },
      },
      {
        table: 'mr_comment_draft',
        liste: 'drafts',
        colonneParent: 'mr_id',
        fromItem: (item, ctx, mr) => (item && item.uid ? {
          uid: item.uid, mr_id: mr.id, old_path: item.old_path || null, new_path: item.new_path || null,
          old_line: item.old_line == null ? null : item.old_line,
          new_line: item.new_line == null ? null : item.new_line,
          body: item.body || '', created_at: item.created_at, updated_at: item.updated_at,
        } : null),
      },
      {
        table: 'comment_log',
        liste: 'comment_log',
        colonneParent: 'mr_id',
        fromItem: (item, ctx, mr) => (item && item.uid ? {
          uid: item.uid, mr_id: mr.id, body: item.body || '',
          gitlab_note_id: item.note_id || null, sent_at: item.sent_at,
        } : null),
      },
    ],
  },
  { table: 'mr_link', famille: 'P', uidPropre: true, parent: 'mr', liste: 'links', fusion: 'parent' },
  { table: 'mr_comment_draft', famille: 'P', uidPropre: true, parent: 'mr', liste: 'drafts', fusion: 'parent' },
  { table: 'comment_log', famille: 'P', uidPropre: true, parent: 'mr', liste: 'comment_log', fusion: 'parent' },
  {
    table: 'review', famille: 'P', uidPropre: true, cle: 'uid', chemin: 'reviews/{forge}/{project}/{iid}/review.json',
    fusion: 'last-writer', locales: ['md_path', 'explanation_path', 'diff_path'],
    note: 'la review courante d’une MR : les chemins pointent les fichiers de la version, recalculés ici',
    commitMessage: (r, ctx) => `review ${ctx ? ctx.mrRef(r.mr_id) || '' : ''}`.trim(),
    toFile: (r, ctx) => {
      const m = ctx.mrChemin(r.mr_id) || {};
      return {
        uid: r.uid,
        mr: ctx.mrRef(r.mr_id),
        forge: m.forge,
        project: m.project,
        iid: m.iid,
        note_value: r.note_value,
        comment_posted_at: r.comment_posted_at || null,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    },
    /* Les trois chemins de fichiers sont RECALCULÉS à l'hydratation, à partir de la version la
       plus récente : ils désignent des fichiers du disque local, et `/Users/amady/…` ne veut
       rien dire chez le voisin. `apresHydratation` s'en charge, une fois les versions posées. */
    fromFile: (doc, ctx) => ({
      uid: doc.uid,
      mr_id: ctx.mrId(doc.mr),
      note_value: doc.note_value == null ? null : doc.note_value,
      comment_posted_at: doc.comment_posted_at || null,
      md_path: '',
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    }),
    referencesDifferees: ['mr_id'],
    refSource: { mr_id: 'mr' },
    apresHydratation: (db2) => {
      /* La review pointe la version la plus récente — c'est déjà ce que fait le pipeline. On la
         recalcule ici plutôt que de transporter des chemins absolus qui ne mènent nulle part. */
      const maj = db2.prepare('UPDATE review SET md_path = ?, explanation_path = ?, diff_path = ? WHERE id = ?');
      for (const r of db2.prepare('SELECT id, mr_id FROM review').all()) {
        const v = db2.prepare(
          'SELECT md_path, explanation_path FROM review_version WHERE mr_id = ? ORDER BY uid DESC LIMIT 1',
        ).get(r.mr_id);
        if (v) maj.run(v.md_path || '', v.explanation_path || null, null, r.id);
      }
    },
  },
  {
    table: 'review_version', famille: 'P', uidPropre: true, cle: 'uid',
    chemin: 'reviews/{forge}/{project}/{iid}/{uid}.md', fusion: 'append-only',
    locales: ['md_path', 'explanation_path', 'version'],
    fichiers: ['{uid}.md', '{uid}.json (note, sha, constats)'],
    note: '`version` est DÉRIVÉE : le fichier porte l’uid et la date, l’hydratation numérote dans l’ordre. '
      + 'AJOUT SEUL — le fichier est nommé par un ULID, deux postes ne touchent jamais le même : '
      + 'deux reviews simultanées de la même MR donnent v2 et v3, jamais deux v2.',
    commitMessage: (r, ctx) => `review ${ctx ? ctx.mrRef(r.mr_id) || '' : ''} v${r.version}`.replace(/\s+/g, ' ').trim(),
    corps: 'content',
    toFile: (r, ctx) => {
      const m = ctx.mrChemin(r.mr_id) || {};
      return {
        uid: r.uid,
        mr: ctx.mrRef(r.mr_id),
        forge: m.forge,
        project: m.project,
        iid: m.iid,
        /* LE RAPPORT LUI-MÊME. C'est ce qui a de la valeur, et c'est du Markdown : il se relit
           tel quel dans la forge, dans un éditeur, dans un navigateur de dépôt. */
        content: ctx.lireDisque(r.md_path),
        explanation: r.explanation_path ? ctx.lireDisque(r.explanation_path) : null,
        note_value: r.note_value == null ? null : r.note_value,
        reviewed_sha: r.reviewed_sha || null,
        kind: r.kind,
        instruction: r.instruction || null,
        n_new: r.n_new, n_persistent: r.n_persistent, n_resolved: r.n_resolved, n_disappeared: r.n_disappeared,
        created_at: r.created_at,
        /* LES CONSTATS vivent dans le fichier de LEUR passe : ils la décrivent, ne changent
           jamais après elle, et un conflit sur eux serait un conflit sur la passe. */
        findings: ctx.enfants('finding', 'mr_id', r.mr_id)
          .filter((f) => f.version === r.version)
          .map((f) => ({
            uid: f.uid, fingerprint: f.fingerprint, file: f.file, line: f.line,
            severity: f.severity, title: f.title, status: f.status, created_at: f.created_at,
          })),
      };
    },
    fromFile: (doc, ctx) => ({
      uid: doc.uid,
      mr_id: ctx.mrId(doc.mr),
      version: ctx.sequence(),        // provisoire ; renumérotée dans l'ordre des uid
      md_path: ctx.ecrireDisque(
        `reviews/${String(doc.project || 'inconnu').replace(/\//g, '__')}/${doc.iid || 0}`,
        `review-${doc.uid}.md`, doc.content || '',
      ),
      explanation_path: doc.explanation
        ? ctx.ecrireDisque(
          `reviews/${String(doc.project || 'inconnu').replace(/\//g, '__')}/${doc.iid || 0}`,
          `explain-${doc.uid}.md`, doc.explanation,
        ) : null,
      note_value: doc.note_value == null ? null : doc.note_value,
      reviewed_sha: doc.reviewed_sha || null,
      kind: doc.kind || 'review',
      instruction: doc.instruction || null,
      n_new: doc.n_new == null ? null : doc.n_new,
      n_persistent: doc.n_persistent == null ? null : doc.n_persistent,
      n_resolved: doc.n_resolved == null ? null : doc.n_resolved,
      n_disappeared: doc.n_disappeared == null ? null : doc.n_disappeared,
      created_at: doc.created_at,
    }),
    referencesDifferees: ['mr_id'],
    refSource: { mr_id: 'mr' },
    listes: [{
      table: 'finding',
      liste: 'findings',
      colonneParent: 'mr_id',
      /* Les constats sont posés PAR LEUR PASSE : on les remplace pour cette version-là, sans
         toucher à ceux des autres passes de la même merge request. */
      remplace: (db2, parent, items) => {
        db2.prepare('DELETE FROM finding WHERE mr_id = ? AND version = ?').run(parent.mr_id, parent.version);
        const ins = db2.prepare(`INSERT INTO finding (uid, mr_id, version, fingerprint, file, line, severity, title, status, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT (uid) DO UPDATE SET version = excluded.version, status = excluded.status`);
        for (const f of items) {
          if (!f || !f.uid) continue;
          ins.run(f.uid, parent.mr_id, parent.version, f.fingerprint, f.file, f.line,
            f.severity, f.title, f.status, f.created_at);
        }
      },
    }],
    apresHydratation: (db2) => {
      /* `version` est un COMPTEUR PAR MERGE REQUEST : local par nature. On renumérote dans
         l'ordre des uid — l'ordre de création, le même partout —, en deux passes pour ne pas
         croiser l'unicité (mr, version) en cours de route. Les constats suivent. */
      for (const m of db2.prepare('SELECT DISTINCT mr_id FROM review_version WHERE mr_id IS NOT NULL').all()) {
        const lignes = db2.prepare('SELECT id, version FROM review_version WHERE mr_id = ? ORDER BY uid').all(m.mr_id);
        const majV = db2.prepare('UPDATE review_version SET version = ? WHERE id = ?');
        const majF = db2.prepare('UPDATE finding SET version = ? WHERE mr_id = ? AND version = ?');
        /* Le palier à -1 000 000 n'est pas décoratif : les versions provisoires posées par
           `ctx.sequence()` sont de petits négatifs (-1, -2…), et renuméroter directement dans
           cette plage écraserait une ligne qui n'a pas encore été traitée. */
        const PALIER = -1000000;
        lignes.forEach((l, i) => { majF.run(PALIER - i, m.mr_id, l.version); majV.run(PALIER - i, l.id); });
        lignes.forEach((l, i) => { majF.run(i + 1, m.mr_id, PALIER - i); majV.run(i + 1, l.id); });
      }
    },
  },
  { table: 'finding', famille: 'P', uidPropre: true, parent: 'review_version', liste: 'findings', fusion: 'parent' },
  {
    table: 'convergence_run', famille: 'P', uidPropre: true, cle: 'uid', chemin: 'convergences/{uid}.json',
    fusion: 'last-writer',
    commitMessage: (r, ctx) => `convergence ${ctx ? ctx.mrRef(r.mr_id) || '' : ''} ${r.status}`.replace(/\s+/g, ' ').trim(),
    toFile: (r, ctx) => ({
      uid: r.uid,
      mr: ctx.mrRef(r.mr_id),
      status: r.status,
      threshold: r.threshold,
      max_passes: r.max_passes,
      passes_done: r.passes_done,
      start_note: r.start_note == null ? null : r.start_note,
      best_note: r.best_note == null ? null : r.best_note,
      /* La meilleure version par son UID, pas par son numéro : les numéros se renumérotent. */
      best_version: r.best_version ? ctx.uid('review_version', r.best_version) : null,
      message: r.message || null,
      started_at: r.started_at,
      finished_at: r.finished_at || null,
    }),
    fromFile: (doc, ctx) => ({
      uid: doc.uid,
      mr_id: ctx.mrId(doc.mr),
      status: doc.status,
      threshold: doc.threshold,
      max_passes: doc.max_passes,
      passes_done: doc.passes_done || 0,
      start_note: doc.start_note == null ? null : doc.start_note,
      best_note: doc.best_note == null ? null : doc.best_note,
      best_version: doc.best_version ? ctx.id('review_version', doc.best_version) : null,
      message: doc.message || null,
      started_at: doc.started_at,
      finished_at: doc.finished_at || null,
    }),
    referencesDifferees: ['mr_id'],
    refSource: { mr_id: 'mr' },
  },
  {
    table: 'review_rule', famille: 'P', uidPropre: true, cle: 'uid', chemin: 'rules/{uid}.json',
    fusion: 'last-writer',
    note: 'ce qu’une équipe a décidé de regarder dans ses reviews : l’exemple même de ce qui gagne à être commun',
    commitMessage: (r) => `review rule ${String(r.label || r.branch_match || r.path_match || '').slice(0, 50)}`,
    toFile: (r, ctx) => ({
      uid: r.uid,
      label: r.label || null,
      branch_match: r.branch_match || null,
      path_match: r.path_match || null,
      content: r.content,
      enabled: r.enabled ? 1 : 0,
      /* Une règle peut être LIMITÉE à un dépôt : par sa clé naturelle, jamais par son id. */
      repo: r.repo_id ? ctx.repoRef(r.repo_id) : null,
      created_at: r.created_at,
    }),
    fromFile: (doc, ctx) => ({
      uid: doc.uid,
      label: doc.label || null,
      branch_match: doc.branch_match || null,
      path_match: doc.path_match || null,
      content: doc.content || '',
      enabled: doc.enabled ? 1 : 0,
      repo_id: doc.repo ? ctx.repoId(doc.repo) : null,
      created_at: doc.created_at,
    }),
    /* Une règle limitée à un dépôt que ce poste ne connaît pas devient une règle GÉNÉRALE si on
       laisse faire — elle s'appliquerait partout. On signale donc, et on la laisse désactivée
       de fait (sans dépôt, `repo_id` nul = générale)… ce qui serait faux. D'où le report : la
       seconde passe retente après que les dépôts sont hydratés. */
    referencesDifferees: ['repo_id'],
    refSource: { repo_id: 'repo' },
  },

  /* ── Vérificateurs ───────────────────────────────────────────────────────────────────── */
  {
    table: 'verifier', famille: 'P', uidPropre: true, cle: 'uid', chemin: 'verifiers/{uid}.json',
    fusion: 'last-writer',
    commitMessage: (r) => `verifier ${String(r.name || '').slice(0, 50)}`,
    toFile: (r, ctx) => ({
      uid: r.uid,
      name: r.name,
      kind: r.kind,
      command: r.command || null,
      timeout_s: r.timeout_s,
      run_base: r.run_base ? 1 : 0,
      comment_on_forge: r.comment_on_forge ? 1 : 0,
      auto_on_mr: r.auto_on_mr ? 1 : 0,
      auto_on_stale: r.auto_on_stale ? 1 : 0,
      comment_template: r.comment_template || null,
      mentions: r.mentions || null,
      env_json: r.env_json || null,
      report_path: r.report_path || null,
      parse_tap: r.parse_tap ? 1 : 0,
      created_at: r.created_at,
      /* L'ORDRE DES COMMANDES PORTE DU SENS : `npm ci` avant `npm test`. Le tableau le garde,
         et la sérialisation ne trie jamais un tableau. */
      commands: ctx.enfants('verifier_command', 'verifier_id', r.id)
        .sort((a, b) => a.position - b.position)
        .map((c) => c.command),
      /* La couverture : quels dépôts ce script sait tester, par clé naturelle. Un dépôt inconnu
         ici est SIGNALÉ et sa ligne sautée — déclarer une couverture sur un dépôt qu'on n'a pas
         ferait échouer la vérification au lancement, bien plus tard. */
      repos: ctx.enfants('verifier_repo', 'verifier_id', r.id).map((vr) => ({
        repo: ctx.repoRef(vr.repo_id),
        mode: vr.mode,
        workdir: vr.workdir || null,
        checkout_allowed: vr.checkout_allowed ? 1 : 0,
      })).filter((vr) => vr.repo),
    }),
    fromFile: (doc) => ({
      uid: doc.uid,
      name: doc.name,
      kind: doc.kind || 'commands',
      command: doc.command || '',       // `NOT NULL` : une commande absente est vide, pas nulle
      timeout_s: doc.timeout_s || null,
      run_base: doc.run_base ? 1 : 0,
      comment_on_forge: doc.comment_on_forge ? 1 : 0,
      auto_on_mr: doc.auto_on_mr ? 1 : 0,
      auto_on_stale: doc.auto_on_stale ? 1 : 0,
      comment_template: doc.comment_template || null,
      mentions: doc.mentions || null,
      env_json: doc.env_json || null,
      report_path: doc.report_path || null,
      parse_tap: doc.parse_tap ? 1 : 0,
      created_at: doc.created_at,
    }),
    listes: [
      {
        table: 'verifier_command',
        liste: 'commands',
        colonneParent: 'verifier_id',
        /* Pas d'`uid` sur cette table : (vérificateur, position) la décrit entièrement. La liste
           est donc remplacée en bloc — voir `remplacerListe` dans le store. */
        remplace: (db2, parent, items) => {
          db2.prepare('DELETE FROM verifier_command WHERE verifier_id = ?').run(parent.id);
          const ins = db2.prepare('INSERT INTO verifier_command (verifier_id, position, command) VALUES (?,?,?)');
          items.forEach((cmd, i) => ins.run(parent.id, i, String(cmd)));
        },
      },
      {
        table: 'verifier_repo',
        liste: 'repos',
        colonneParent: 'verifier_id',
        remplace: (db2, parent, items, ctx, signaler) => {
          db2.prepare('DELETE FROM verifier_repo WHERE verifier_id = ?').run(parent.id);
          const ins = db2.prepare(`INSERT INTO verifier_repo (verifier_id, repo_id, mode, workdir, checkout_allowed)
                                   VALUES (?,?,?,?,?)`);
          for (const vr of items) {
            const id = ctx.repoId(vr.repo);
            /* Dépôt inconnu ici : on SIGNALE et on saute. Déclarer la couverture sans le dépôt
               ferait échouer la vérification au lancement, beaucoup plus tard et loin d'ici. */
            if (!id) { signaler(`couverture sur « ${vr.repo} », dépôt inconnu sur ce poste`); continue; }
            ins.run(parent.id, id, vr.mode || 'worktree', vr.workdir || null, vr.checkout_allowed ? 1 : 0);
          }
        },
      },
    ],
  },
  { table: 'verifier_command', famille: 'P', uidPropre: false /* pas de clé primaire propre : (vérificateur, position) la décrit entièrement */, parent: 'verifier', liste: 'commands', fusion: 'parent' },
  { table: 'verifier_repo', famille: 'P', uidPropre: false /* pas de clé primaire propre : (vérificateur, dépôt) la décrit entièrement */, parent: 'verifier', liste: 'repos', fusion: 'parent' },
  {
    table: 'verification', famille: 'P', uidPropre: true, cle: 'uid', chemin: 'verifications/{uid}.json',
    fusion: 'append-only',
    note: 'une archive : elle recopie déjà `verifier_name` et `lot_name`, donc elle survit à la '
      + 'suppression du vérificateur. Un VERDICT est ce qu’une équipe a le plus intérêt à ne pas '
      + 'recalculer six fois.',
    commitMessage: (r) => `verification ${r.verifier_name || ''} ${r.verdict || r.status}`.replace(/\s+/g, ' ').trim(),
    toFile: (r, ctx) => ({
      uid: r.uid,
      verifier: r.verifier_id ? ctx.uid('verifier', r.verifier_id) : null,
      verifier_name: r.verifier_name || null,
      lot: r.lot_id ? ctx.uid('lot', r.lot_id) : null,
      lot_name: r.lot_name || null,
      status: r.status,
      verdict: r.verdict || null,
      targets_json: r.targets_json || null,
      context_json: r.context_json || null,
      base_run_json: r.base_run_json || null,
      head_run_json: r.head_run_json || null,
      imputable_json: r.imputable_json || null,
      /* L'EXTRAIT DE JOURNAL, pas le journal. Le `.log` complet est ce qui fait grossir une base
         sans rien apprendre à qui n'a pas lancé la vérification : c'est le VERDICT qui voyage. */
      log_excerpt: r.log_excerpt || null,
      restore_error: r.restore_error || null,
      comment_posted_at: r.comment_posted_at || null,
      comment_targets: r.comment_targets || null,
      started_at: r.started_at,
      finished_at: r.finished_at || null,
      created_at: r.created_at,
      /* Les tests rouges d'un run : un test n'est « instable » qu'à partir de DEUX runs sur la
         même empreinte de cibles — et à plusieurs postes, ces deux runs viennent de personnes
         différentes. Seule la version partagée voit donc quelque chose. */
      tests: ctx.enfants('verify_run_test', 'verification_id', r.id).map((t2) => ({
        uid: t2.uid, targets_key: t2.targets_key, test: t2.test || null, created_at: t2.created_at,
      })),
    }),
    fromFile: (doc, ctx) => ({
      uid: doc.uid,
      verifier_id: doc.verifier ? ctx.id('verifier', doc.verifier) : null,
      verifier_name: doc.verifier_name || null,
      lot_id: doc.lot ? ctx.id('lot', doc.lot) : null,
      lot_name: doc.lot_name || null,
      status: doc.status,
      verdict: doc.verdict || null,
      targets_json: doc.targets_json || null,
      context_json: doc.context_json || null,
      base_run_json: doc.base_run_json || null,
      head_run_json: doc.head_run_json || null,
      imputable_json: doc.imputable_json || null,
      log_excerpt: doc.log_excerpt || null,
      restore_error: doc.restore_error || null,
      comment_posted_at: doc.comment_posted_at || null,
      comment_targets: doc.comment_targets || null,
      started_at: doc.started_at,
      finished_at: doc.finished_at || null,
      created_at: doc.created_at,
    }),
    listes: [{
      table: 'verify_run_test',
      liste: 'tests',
      colonneParent: 'verification_id',
      fromItem: (item, ctx, v) => (item && item.uid ? {
        uid: item.uid, verification_id: v.id, verifier_id: v.verifier_id,
        targets_key: item.targets_key, test: item.test || null, created_at: item.created_at,
      } : null),
    }],
  },
  {
    table: 'verify_run_test', famille: 'P', uidPropre: true, parent: 'verification', liste: 'tests', fusion: 'parent',
    note: 'un test n’est « instable » qu’à partir de deux runs sur la même empreinte de cibles — '
      + 'à plusieurs postes ces runs viennent de personnes différentes, donc seule la version partagée voit quelque chose',
  },

  /* ── Agents ──────────────────────────────────────────────────────────────────────────── */
  {
    table: 'agent', famille: 'P', uidPropre: true, cle: 'slug', chemin: 'agents/{slug}/agent.json',
    fusion: 'last-writer', locales: ['schedule_fired_at'],
    note: 'le slug est figé à la création : renommer l’agent ne déplace pas son dossier',
    commitMessage: (r) => `agent ${String(r.slug || r.name || '').slice(0, 50)}`,
    toFile: (r, ctx) => ({
      uid: r.uid,
      slug: r.slug,
      name: r.name,
      description: r.description || null,
      builtin_key: r.builtin_key || null,
      kind: r.kind,
      scope_kind: r.scope_kind,
      system_prompt: r.system_prompt || null,
      prompt_template: r.prompt_template || null,
      model: r.model || null,
      permission_mode: r.permission_mode || null,
      allowed_tools_json: r.allowed_tools_json,
      disallowed_tools_json: r.disallowed_tools_json,
      max_turns: r.max_turns,
      skills_json: r.skills_json,
      subagents_json: r.subagents_json,
      output_kind: r.output_kind,
      /* La sortie d'un agent peut viser une PAGE DE NOTES : par son slug, pas par son id. */
      output_ref: r.output_kind === 'note_page' && r.output_ref
        ? ctx.slug('note_page', Number(r.output_ref)) : (r.output_ref || null),
      knowledge_prompt: r.knowledge_prompt || null,
      schedule: r.schedule || null,
      /* `runner` : QUI, dans l'équipe, honore l'horaire. Sans lui, trois instances allumées
         lanceraient trois fois le même agent — chacune croyant être la seule. */
      runner: r.runner || null,
      defaults_json: r.defaults_json,
      created_at: r.created_at,
      updated_at: r.updated_at,
      repos: ctx.enfants('agent_repo', 'agent_id', r.id).map((ar) => ({
        repo: ctx.repoRef(ar.repo_id), branch: ar.branch || null, role: ar.role,
      })).filter((ar) => ar.repo),
    }),
    fromFile: (doc, ctx) => ({
      uid: doc.uid,
      slug: doc.slug,
      name: doc.name,
      description: doc.description || '',
      builtin_key: doc.builtin_key || null,
      kind: doc.kind || 'explore',
      scope_kind: doc.scope_kind || 'all_repos',
      system_prompt: doc.system_prompt || '',
      prompt_template: doc.prompt_template || '',
      model: doc.model || '',
      permission_mode: doc.permission_mode || '',
      allowed_tools_json: doc.allowed_tools_json || '[]',
      disallowed_tools_json: doc.disallowed_tools_json || '[]',
      max_turns: doc.max_turns || null,
      skills_json: doc.skills_json || '[]',
      subagents_json: doc.subagents_json || '{}',
      output_kind: doc.output_kind || 'report',
      output_ref: doc.output_kind === 'note_page' && doc.output_ref
        ? numOuNull(ctx.idParSlug('note_page', doc.output_ref)) : (doc.output_ref || null),
      knowledge_prompt: doc.knowledge_prompt || null,
      schedule: doc.schedule || null,
      runner: doc.runner || null,
      defaults_json: doc.defaults_json || '{}',
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    }),
    listes: [{
      table: 'agent_repo',
      liste: 'repos',
      colonneParent: 'agent_id',
      remplace: (db2, parent, items, ctx, signaler) => {
        db2.prepare('DELETE FROM agent_repo WHERE agent_id = ?').run(parent.id);
        const ins = db2.prepare('INSERT OR IGNORE INTO agent_repo (agent_id, repo_id, branch, role) VALUES (?,?,?,?)');
        for (const ar of items) {
          const id = ctx.repoId(ar.repo);
          /* Un périmètre AMPUTÉ est plus dangereux qu'un périmètre absent : l'agent tournerait
             sur les dépôts restants en ayant l'air complet. On le dit. */
          if (!id) { signaler(`périmètre sur « ${ar.repo} », dépôt inconnu sur ce poste`); continue; }
          ins.run(parent.id, id, ar.branch || '', ar.role || 'readonly');
        }
      },
    }],
  },
  { table: 'agent_repo', famille: 'P', uidPropre: false /* pas de clé primaire propre : (agent, dépôt) la décrit entièrement */, parent: 'agent', liste: 'repos', fusion: 'parent' },
  {
    table: 'agent_knowledge', famille: 'P', uidPropre: true, cle: 'uid', chemin: 'agents/{agent}/knowledge-{uid}.md',
    fusion: 'append-only', locales: ['md_path', 'version'],
    fichiers: ['agents/{agent}/knowledge-{uid}.json (repos, gaps, statut)'],
    note: 'la carte du code d’un agent de domaine : le document coûte des heures d’agent à '
      + 'produire, et c’est exactement ce qu’une équipe a intérêt à écrire une seule fois. '
      + '`version` est DÉRIVÉE — l’hydratation renumérote dans l’ordre des uid.',
    /* Le corps n'est pas une colonne : c'est un fichier sur le disque, que `md_path` désigne.
       Le store le lit à l'export et le réécrit à l'hydratation. */
    corps: 'content',
    commitMessage: (r, ctx) => `agent knowledge ${ctx ? ctx.slug('agent', r.agent_id) : ''} ${r.status}`.replace(/\s+/g, ' ').trim(),
    toFile: (r, ctx) => ({
      uid: r.uid,
      agent: ctx.slug('agent', r.agent_id),
      content: ctx.lireDisque(r.md_path),
      repos_json: r.repos_json,
      gaps_json: r.gaps_json,
      diff_summary: r.diff_summary || null,
      status: r.status,
      /* La session qui l'a produite, par son uid — nulle si c'est une édition à la main, ou si
         les sessions ne sont pas partagées sur ce dépôt. */
      task: r.task_id ? ctx.uid('task', r.task_id) : null,
      tokens: r.tokens,
      created_at: r.created_at,
      activated_at: r.activated_at || null,
    }),
    fromFile: (doc, ctx) => ({
      uid: doc.uid,
      agent_id: ctx.idParSlug('agent', doc.agent),
      version: ctx.sequence(),          // provisoire et unique ; renumérotée dans l'ordre des uid
      md_path: ctx.ecrireDisque(`agents/${doc.agent}`, `knowledge-${doc.uid}.md`, doc.content || ''),
      repos_json: doc.repos_json || '[]',
      gaps_json: doc.gaps_json || '[]',
      diff_summary: doc.diff_summary || null,
      status: doc.status || 'pending',
      task_id: doc.task ? ctx.id('task', doc.task) : null,
      tokens: doc.tokens || null,
      created_at: doc.created_at,
      activated_at: doc.activated_at || null,
    }),
    referencesDifferees: ['agent_id'],
    refSource: { agent_id: 'agent' },
    /* `version` est un COMPTEUR PAR AGENT : local par nature. Après hydratation, on renumérote
       dans l'ordre des uid — qui est l'ordre de création, partout pareil. Deux postes qui
       produisent chacun une carte donnent v4 et v5, jamais deux v4. */
    apresHydratation: (db2) => {
      for (const a of db2.prepare('SELECT DISTINCT agent_id FROM agent_knowledge WHERE agent_id IS NOT NULL').all()) {
        const lignes = db2.prepare('SELECT id FROM agent_knowledge WHERE agent_id = ? ORDER BY uid').all(a.agent_id);
        const maj = db2.prepare('UPDATE agent_knowledge SET version = ? WHERE id = ?');
        /* Deux passes, avec un palier très bas : l'unicité (agent, version) refuserait un
           croisement en cours de route, et les versions provisoires posées par `ctx.sequence()`
           sont de petits négatifs — renuméroter dans cette plage écraserait une ligne qui
           n'a pas encore été traitée. */
        const PALIER = -1000000;
        lignes.forEach((l, i) => maj.run(PALIER - i, l.id));
        lignes.forEach((l, i) => maj.run(i + 1, l.id));
      }
    },
  },

  /* ── Sessions de codage, questions, passes ───────────────────────────────────────────── */
  {
    table: 'task', famille: 'P', uidPropre: true, cle: 'uid', chemin: 'sessions/{uid}/session.json',
    fusion: 'last-writer', locales: ['md_path', 'diff_path', 'hidden'],
    note: 'une session de codage ou d’exploration. Son PROMPT et son RÉSULTAT se partagent ; les '
      + 'diffs et les handles d’agent, non — ils ne valent que sur la machine qui a cloné.',
    commitMessage: (r) => `session ${String(r.label || r.agent_question || r.prompt || '').replace(/\s+/g, ' ').slice(0, 50)}`,
    toFile: (r, ctx) => ({
      uid: r.uid,
      flavour: 'task',
      kind: r.kind,
      prompt: r.prompt,
      agent_question: r.agent_question || null,
      label: r.label || null,
      commit_message: r.commit_message || null,
      auto_push: r.auto_push ? 1 : 0,
      ask_questions: r.ask_questions ? 1 : 0,
      notify_jira: r.notify_jira ? 1 : 0,
      review_after: r.review_after ? 1 : 0,
      status: r.status,
      /* La RÉPONSE d'une exploration est ce qui a de la valeur : elle part en texte, pas en
         chemin — `/Users/amady/…` ne désigne rien chez le voisin. */
      answer: r.md_path ? ctx.lireDisque(r.md_path) : null,
      last_error: r.last_error || null,
      agent: r.agent_id ? ctx.slug('agent', r.agent_id) : null,
      agent_name: r.agent_name || null,
      agent_draft_json: r.agent_draft_json || null,
      triggered_by: r.triggered_by || 'manual',
      verifier: r.verifier_id ? ctx.uid('verifier', r.verifier_id) : null,
      followup_draft: r.followup_draft || null,
      followup_auto: r.followup_auto ? 1 : 0,
      created_at: r.created_at,
      updated_at: r.updated_at,
      finished_at: r.finished_at || null,
      targets: ctx.enfants('task_target', 'task_id', r.id).map((tg) => ({
        uid: tg.uid,
        repo: ctx.repoRef(tg.repo_id),
        branch: tg.branch,
        base_branch: tg.base_branch || null,
        status: tg.status,
        commit_sha: tg.commit_sha || null,
        push_command: tg.push_command || null,
        mr_iid: tg.mr_iid == null ? null : tg.mr_iid,
        mr_url: tg.mr_url || null,
        mr_target: tg.mr_target || null,
        mr_merged: tg.mr_merged ? 1 : 0,
        mr_conflicts: tg.mr_conflicts ? 1 : 0,
        force_push: tg.force_push ? 1 : 0,
        last_error: tg.last_error || null,
        questions_json: tg.questions_json || null,
        updated_at: tg.updated_at,
      })).filter((tg) => tg.repo),
    }),
    fromFile: (doc, ctx) => ({
      uid: doc.uid,
      /* `repo_id` est `NOT NULL` sur `task` : c'est un vestige mono-projet, l'état réel vit sur
         les cibles. On y met le dépôt de la première cible connue — et si aucune ne se résout,
         la session n'est pas hydratable ici, ce que la seconde passe signale. */
      repo_id: ctx.repoId((doc.targets || [])[0] && doc.targets[0].repo),
      kind: doc.kind || 'code',
      prompt: doc.prompt || '',
      agent_question: doc.agent_question || null,
      label: doc.label || null,
      branch: ((doc.targets || [])[0] || {}).branch || '',
      base_branch: ((doc.targets || [])[0] || {}).base_branch || null,
      commit_message: doc.commit_message || null,
      auto_push: doc.auto_push ? 1 : 0,
      ask_questions: doc.ask_questions ? 1 : 0,
      notify_jira: doc.notify_jira ? 1 : 0,
      review_after: doc.review_after ? 1 : 0,
      status: doc.status || 'new',
      md_path: doc.answer ? ctx.ecrireDisque(`tasks/${doc.uid}`, 'answer.md', doc.answer) : null,
      last_error: doc.last_error || null,
      agent_id: doc.agent ? ctx.idParSlug('agent', doc.agent) : null,
      agent_name: doc.agent_name || null,
      agent_draft_json: doc.agent_draft_json || null,
      triggered_by: doc.triggered_by || 'manual',
      verifier_id: doc.verifier ? ctx.id('verifier', doc.verifier) : null,
      followup_draft: doc.followup_draft || null,
      followup_auto: doc.followup_auto ? 1 : 0,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      finished_at: doc.finished_at || null,
    }),
    referencesDifferees: ['repo_id'],
    refSource: { repo_id: 'targets' },
    listes: [{
      table: 'task_target',
      liste: 'targets',
      colonneParent: 'task_id',
      fromItem: (item, ctx, task) => {
        if (!item || !item.uid) return null;
        const repoId = ctx.repoId(item.repo);
        if (!repoId) return null;         // dépôt inconnu ici : la cible n'a pas de sens
        return {
          uid: item.uid, task_id: task.id, repo_id: repoId, branch: item.branch,
          base_branch: item.base_branch || null, status: item.status || 'new',
          commit_sha: item.commit_sha || null, push_command: item.push_command || null,
          mr_iid: item.mr_iid == null ? null : item.mr_iid, mr_url: item.mr_url || null,
          mr_target: item.mr_target || null, mr_merged: item.mr_merged ? 1 : 0,
          mr_conflicts: item.mr_conflicts ? 1 : 0, force_push: item.force_push ? 1 : 0,
          last_error: item.last_error || null, questions_json: item.questions_json || null,
          updated_at: item.updated_at,
        };
      },
    }],
  },
  {
    table: 'task_target', famille: 'P', uidPropre: true, parent: 'task', liste: 'targets', fusion: 'parent',
    locales: ['session_key', 'session_backend', 'session_cwd', 'diff_path', 'output_path'],
    note: '`session_*` a déménagé dans `local_session` ; `diff_path` et `output_path` désignent '
      + 'des fichiers du clone local, que chaque poste refait lui-même',
  },
  {
    table: 'question', famille: 'P', uidPropre: true, cle: 'uid', chemin: 'sessions/{uid}/question.json',
    fusion: 'last-writer',
    locales: ['md_path', 'session_key', 'session_backend', 'session_cwd', 'hidden'],
    note: 'une question libre et sa réponse — ni dépôt, ni dossier : rien à résoudre chez le voisin',
    commitMessage: (r) => `question ${String(r.label || r.prompt || '').replace(/\s+/g, ' ').slice(0, 50)}`,
    toFile: (r, ctx) => ({
      uid: r.uid,
      flavour: 'ask',
      prompt: r.prompt,
      label: r.label || null,
      status: r.status,
      answer: r.md_path ? ctx.lireDisque(r.md_path) : null,
      last_error: r.last_error || null,
      followup_draft: r.followup_draft || null,
      followup_auto: r.followup_auto ? 1 : 0,
      created_at: r.created_at,
      updated_at: r.updated_at,
      finished_at: r.finished_at || null,
    }),
    fromFile: (doc, ctx) => ({
      uid: doc.uid,
      prompt: doc.prompt || '',
      label: doc.label || null,
      status: doc.status || 'new',
      md_path: doc.answer ? ctx.ecrireDisque(`tasks/ask/${doc.uid}`, 'answer.md', doc.answer) : null,
      last_error: doc.last_error || null,
      followup_draft: doc.followup_draft || null,
      followup_auto: doc.followup_auto ? 1 : 0,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      finished_at: doc.finished_at || null,
    }),
  },
  {
    table: 'local_task', famille: 'P', uidPropre: true, cle: 'uid', chemin: 'sessions/{uid}/local.json',
    fusion: 'last-writer', locales: ['hidden'],
    note: 'du codage hors dépôt : la session se PARTAGE (ses passes se relisent), le dossier non',
    commitMessage: (r) => `local session ${String(r.label || r.prompt || '').replace(/\s+/g, ' ').slice(0, 50)}`,
    toFile: (r, ctx) => ({
      uid: r.uid,
      flavour: 'local',
      prompt: r.prompt,
      label: r.label || null,
      status: r.status,
      ask_questions: r.ask_questions ? 1 : 0,
      last_error: r.last_error || null,
      followup_draft: r.followup_draft || null,
      followup_auto: r.followup_auto ? 1 : 0,
      created_at: r.created_at,
      updated_at: r.updated_at,
      finished_at: r.finished_at || null,
      /* LE DOSSIER NE VOYAGE PAS, SON NOM SI. `dir_hash` permet à un autre poste de RATTACHER
         son propre dossier au même objet ; `dir_label` et `owner` font que sa carte dit quelque
         chose plutôt que d'afficher une ligne vide. */
      dirs: ctx.enfants('local_task_dir', 'task_id', r.id).map((d) => ({
        uid: d.uid, dir_hash: d.dir_hash, dir_label: d.dir_label, owner: d.owner || null,
        status: d.status, last_error: d.last_error || null,
        questions_json: d.questions_json || null, updated_at: d.updated_at,
      })),
    }),
    fromFile: (doc) => ({
      uid: doc.uid,
      prompt: doc.prompt || '',
      label: doc.label || null,
      status: doc.status || 'new',
      ask_questions: doc.ask_questions ? 1 : 0,
      last_error: doc.last_error || null,
      followup_draft: doc.followup_draft || null,
      followup_auto: doc.followup_auto ? 1 : 0,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      finished_at: doc.finished_at || null,
    }),
    listes: [{
      table: 'local_task_dir',
      liste: 'dirs',
      colonneParent: 'task_id',
      fromItem: (item, ctx, lt) => (item && item.uid ? {
        uid: item.uid, task_id: lt.id, path: '', dir_hash: item.dir_hash,
        dir_label: item.dir_label || null, owner: item.owner || null,
        status: item.status || 'new', last_error: item.last_error || null,
        questions_json: item.questions_json || null, updated_at: item.updated_at,
      } : null),
    }],
  },
  {
    table: 'local_task_dir', famille: 'P', uidPropre: true, parent: 'local_task', liste: 'dirs', fusion: 'parent',
    locales: ['path', 'session_key', 'session_backend', 'session_cwd', 'output_path'],
    note: '`path` est vidé et gelé : le chemin vit dans `local_dir_map`, sur le poste qui le '
      + 'connaît. La ligne porte `dir_hash`, `dir_label` et `owner`, qui eux voyagent — chez le '
      + 'voisin la session se relit avec son libellé, et « Relancer » est refusé plutôt que de '
      + 'faire travailler l’agent dans un homonyme.',
  },
  {
    table: 'agent_pass', famille: 'P', uidPropre: true, cle: 'uid', chemin: 'sessions/{session}/pass-{uid}.md',
    fusion: 'append-only', locales: ['output_path', 'diff_path', 'n'],
    fichiers: ['pass-{uid}.json (demande, genre, coût)'],
    note: '`favori` et `titre` sont PARTAGÉS — ranger une passe utile sert à toute l’équipe ; `n` est dérivé. '
      + 'AJOUT SEUL : le fichier est nommé par un ULID, deux postes ne touchent jamais le même.',
    commitMessage: (r) => `pass ${r.kind} #${r.n}`,
    corps: 'content',
    toFile: (r, ctx) => ({
      uid: r.uid,
      session: ctx.sessionUid(r.scope, r.task_id),
      scope: r.scope,
      /* L'unité (projet ou dossier) par son uid : son id entier ne veut rien dire ailleurs.
         `0` marque les scopes qui n'ont pas d'unité — une question, une review. */
      unit: r.unit_id
        ? (r.scope === 'task' ? ctx.uid('task_target', r.unit_id) : ctx.uid('local_task_dir', r.unit_id))
        : null,
      kind: r.kind,
      prompt: r.prompt,
      /* CE QUE L'AGENT A RÉPONDU — le contenu du `.md`. C'est ce qu'on relit trois semaines
         plus tard pour comprendre ce qui a été demandé et ce qui a été fait. */
      content: r.output_path ? ctx.lireDisque(r.output_path) : '',
      favori: r.favori ? 1 : 0,
      titre: r.titre || null,
      cost_usd: r.cost_usd == null ? null : r.cost_usd,
      base_sha: r.base_sha || null,
      head_sha: r.head_sha || null,
      created_at: r.created_at,
    }),
    fromFile: (doc, ctx) => ({
      uid: doc.uid,
      scope: doc.scope,
      task_id: ctx.sessionId(doc.scope, doc.session),
      unit_id: doc.unit
        ? (doc.scope === 'task' ? ctx.id('task_target', doc.unit) : ctx.id('local_task_dir', doc.unit)) || 0
        : 0,
      n: ctx.sequence(),               // provisoire ; renumérotée dans l'ordre des uid
      kind: doc.kind,
      prompt: doc.prompt || '',
      output_path: ctx.ecrireDisque(`tasks/passes/${doc.session || 'orphelines'}`, `pass-${doc.uid}.md`, doc.content || ''),
      favori: doc.favori ? 1 : 0,
      titre: doc.titre || null,
      cost_usd: doc.cost_usd == null ? null : doc.cost_usd,
      base_sha: doc.base_sha || null,
      head_sha: doc.head_sha || null,
      created_at: doc.created_at,
    }),
    referencesDifferees: ['task_id'],
    refSource: { task_id: 'session' },
    apresHydratation: (db2) => {
      /* `n` est un compteur PAR UNITÉ : local par nature. On renumérote dans l'ordre des uid —
         l'ordre de création, le même partout. Aucune contrainte d'unicité ici, donc une seule
         passe suffit. */
      const groupes = db2.prepare('SELECT DISTINCT scope, task_id, unit_id FROM agent_pass WHERE task_id IS NOT NULL').all();
      const maj = db2.prepare('UPDATE agent_pass SET n = ? WHERE id = ?');
      for (const g of groupes) {
        const lignes = db2.prepare(
          'SELECT id FROM agent_pass WHERE scope = ? AND task_id = ? AND unit_id = ? ORDER BY uid',
        ).all(g.scope, g.task_id, g.unit_id);
        lignes.forEach((l, i) => maj.run(i + 1, l.id));
      }
    },
  },
  {
    table: 'piece_jointe', famille: 'P', uidPropre: true, cle: 'uid', chemin: 'sessions/{session}/attachments/{uid}.json',
    fusion: 'append-only', locales: ['path'],
    fichiers: ['sessions/{session}/attachments/{uid}.{ext}'],
    note: 'la capture ou le document joint à une demande : le binaire part tel quel, jamais en base64',
    commitMessage: (r) => `attachment ${String(r.name || '').slice(0, 40)}`,
    toFile: (r, ctx) => ({
      uid: r.uid,
      session: ctx.sessionUid(r.scope, r.owner_id),
      scope: r.scope,
      name: r.name,
      mime: r.mime || null,
      file: `${r.uid}${extensionDe(r.path)}`,
      followup: r.followup ? 1 : 0,
      created_at: r.created_at,
    }),
    fromFile: (doc, ctx) => {
      const local = ctx.copierDepuisDepot(
        doc.file ? `sessions/${doc.session}/attachments/${doc.file}` : null,
        `tasks/pieces/${doc.session || 'orphelines'}`,
        `${doc.uid}${extensionDe(doc.file)}`,
      );
      return local ? {
        uid: doc.uid,
        scope: doc.scope,
        owner_id: ctx.sessionId(doc.scope, doc.session) || 0,
        path: local,
        name: doc.name,
        mime: doc.mime || null,
        followup: doc.followup ? 1 : 0,
        created_at: doc.created_at,
      } : null;
    },
    binaires: (r, ctx) => {
      const session = ctx.sessionUid(r.scope, r.owner_id);
      return session ? [{ chemin: `sessions/${session}/attachments/${r.uid}${extensionDe(r.path)}`, source: r.path }] : [];
    },
  },

  /* ── Notes, todos, liens, Jira ───────────────────────────────────────────────────────── */
  {
    table: 'note_page', famille: 'P', uidPropre: true, cle: 'slug', chemin: 'notes/{slug}.md', fusion: 'last-writer',
    fichiers: ['notes/{slug}.json (uid, parent, épinglage, dates)', 'notes/{slug}/{uid}.png'],
    note: 'le corps du .md EST le contenu de la page ; PAGE PAR PAGE : `shared` décide, et vaut 0 par défaut',
    corps: 'content',
    /* LA SEULE TABLE QUI SE PARTAGE LIGNE PAR LIGNE. Ailleurs la famille suffit : une review,
       une règle, une carte du code sont des produits, et les produire pour soi seul n'aurait
       pas de sens. Une page de notes, si — c'est le brouillon de l'outil. On demande donc,
       page par page, et la réponse par défaut est non.
       `shared` ne part PAS dans le fichier : un fichier qui est là EST partagé, la colonne
       serait une seconde vérité, et un `shared: 0` dans le dépôt voudrait dire quoi ? */
    partageable: (r) => Boolean(r.shared),
    commitMessage: (r) => `note "${String(r.title || r.slug).slice(0, 50)}"`,
    toFile: (r, ctx) => ({
      uid: r.uid,
      slug: r.slug,
      title: r.title,
      content: r.content || '',
      pinned: r.pinned ? 1 : 0,
      /* Le parent par son SLUG, jamais par son id : deux postes numérotent leurs pages
         différemment, et une sous-page rattachée au mauvais parent serait pire qu'orpheline. */
      parent: r.parent_id ? ctx.slug('note_page', r.parent_id) : null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      /* Les captures vivent dans le fichier de LEUR PAGE : elles ne changent qu'avec elle, et un
         conflit sur une image est un conflit sur la page. Le binaire est copié à côté. */
      images: ctx.enfants('note_image', 'page_id', r.id).map((i) => ({
        uid: i.uid, file: `${r.slug}/${i.uid}${extensionDe(i.path)}`, created_at: i.created_at,
      })),
    }),
    fromFile: (doc, ctx) => ({
      uid: doc.uid,
      slug: doc.slug,
      title: doc.title,
      content: doc.content || '',
      pinned: doc.pinned ? 1 : 0,
      parent_id: doc.parent ? ctx.idParSlug('note_page', doc.parent) : null,
      /* ELLE EST DANS LE DÉPÔT, DONC ELLE EST PARTAGÉE. Arriver avec `shared = 0` ferait
         retirer le fichier au premier écoulement : le poste qui reçoit effacerait chez tout le
         monde la page qu'on vient de lui envoyer. */
      shared: 1,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    }),
    binaires: (r, ctx) => ctx.enfants('note_image', 'page_id', r.id).map((i) => ({
      chemin: `notes/${r.slug}/${i.uid}${extensionDe(i.path)}`, source: i.path,
    })),
    /* Une sous-page peut arriver AVANT sa page parente : rien ne dit dans quel ordre git rend
       ses fichiers. On pose la ligne sans parent, et on repasse en fin de hydratation. */
    referencesDifferees: ['parent_id'],
    refSource: { parent_id: 'parent' },
    listes: [{
      table: 'note_image',
      liste: 'images',
      colonneParent: 'page_id',
      fromItem: (item, ctx, page) => {
        if (!item || !item.uid) return null;
        /* Le binaire sort du dépôt vers `data/notes/<id>/`, d'où l'application le sert. Absent
           — un dépôt cloné sans LFS, par exemple —, la ligne n'est pas créée : une vignette
           cassée apprendrait à se méfier de tout ce qu'on voit. */
        const local = ctx.copierDepuisDepot(
          item.file ? `notes/${item.file}` : null,
          `notes/${page.id}`,
          `${item.uid}${extensionDe(item.file)}`,
        );
        return local ? { uid: item.uid, page_id: page.id, path: local, created_at: item.created_at } : null;
      },
    }],
  },
  {
    table: 'note_image', famille: 'P', uidPropre: true, parent: 'note_page', liste: 'images', fusion: 'parent',
    locales: ['path'], fichiers: ['notes/{slug}/{uid}.png'],
    note: '`path` est le fichier SUR CE POSTE ; le dépôt porte le binaire sous le dossier de la page',
  },
  {
    table: 'todo', famille: 'P', uidPropre: true, cle: 'uid', chemin: 'todos/{uid}.json', fusion: 'last-writer',
    /* UN RAPPEL EST PERSONNEL. `reminded_at` dit « cette machine a affiché la notification » :
       partagé, il éteindrait le rappel du collègue qui, lui, ne l'a jamais vu. La todo se
       partage ; le fait d'avoir été prévenu, non. */
    locales: ['reminded_at'],
    commitMessage: (r) => `todo ${r.status === 'done' ? 'done' : (r.archived_at ? 'archived' : 'set')}: ${String(r.title || '').slice(0, 50)}`,
    toFile: (r, ctx) => ({
      uid: r.uid,
      title: r.title,
      priority: r.priority,
      status: r.status,
      note: r.note || null,
      /* CE À QUOI LA TODO EST ACCROCHÉE. La référence est un id entier pour trois des sept
         genres — et un id entier ne survit pas au partage. On le traduit en désignation
         (`gitlab/acme/web!218`) ; à la relecture, une désignation que ce poste ne connaît pas
         fait perdre le LIEN, jamais la todo. Mieux vaut un bouton en moins qu'un bouton qui
         mène à la mauvaise merge request. */
      link_kind: r.link_kind || null,
      link_ref: refSortante(r.link_kind, r.link_ref, ctx),
      auto_kind: r.auto_kind || null,
      auto_ref: r.auto_ref || null,
      due_at: r.due_at,
      done_at: r.done_at,
      archived_at: r.archived_at,
      position: r.position,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }),
    fromFile: (doc, ctx) => {
      const ref = refEntrante(doc.link_kind, doc.link_ref, ctx);
      return {
        uid: doc.uid,
        title: doc.title,
        priority: doc.priority,
        status: doc.status,
        note: doc.note || null,
        link_kind: ref === null ? null : doc.link_kind || null,
        link_ref: ref,
        auto_kind: doc.auto_kind || null,
        auto_ref: doc.auto_ref || null,
        due_at: doc.due_at || null,
        done_at: doc.done_at || null,
        archived_at: doc.archived_at || null,
        position: doc.position || 0,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
      };
    },
  },
  {
    table: 'jira_watch', famille: 'P', uidPropre: false /* identifiée par la clé du ticket (PROJ-1408), qui est déjà sa clé primaire */, cle: 'key', chemin: 'jira/{key}.json', fusion: 'last-writer',
    locales: ['checked_at', 'error'],
    note: 'ce qu’on surveille est d’équipe ; QUAND ce poste a regardé, et son erreur réseau, non',
    commitMessage: (r) => `jira watch ${r.key}`,
    toFile: (r) => ({
      key: r.key,
      summary: r.summary || null,
      status: r.status || null,
      status_category: r.status_category || null,
      /* LE MOTIF de la surveillance : c'est lui qui dit quoi faire trois semaines plus tard, et
         c'est la seule chose ici qu'un humain ait écrite. */
      note: r.note || null,
      todo_on_change: r.todo_on_change ? 1 : 0,
      added_at: r.added_at,
      changed_at: r.changed_at || null,
    }),
    fromFile: (doc) => ({
      key: doc.key,
      summary: doc.summary || null,
      status: doc.status || null,
      status_category: doc.status_category || null,
      note: doc.note || null,
      todo_on_change: doc.todo_on_change ? 1 : 0,
      added_at: doc.added_at,
      changed_at: doc.changed_at || null,
    }),
  },

  /* ── Lots, environnements, services ──────────────────────────────────────────────────── */
  {
    table: 'lot', famille: 'P', uidPropre: true, cle: 'uid', chemin: 'lots/{uid}.json', fusion: 'last-writer',
    note: 'des merge requests qui ne valent qu’ENSEMBLE — exactement le genre de chose qu’on se dit à plusieurs',
    commitMessage: (r) => `lot ${String(r.name || '').slice(0, 50)}`,
    toFile: (r, ctx) => ({
      uid: r.uid,
      name: r.name,
      kind: r.kind,
      created_at: r.created_at,
      /* Les membres sont désignés par ce qu'ils SONT : une merge request par sa clé naturelle,
         un dépôt par la sienne. Un id entier désignerait autre chose chez le voisin. */
      members: ctx.enfants('lot_member', 'lot_id', r.id).map((m) => ({
        kind: m.kind,
        ref: m.kind === 'mr' ? ctx.mrRef(m.ref_id) : (m.kind === 'repo' ? ctx.repoRef(m.ref_id) : String(m.ref_id)),
      })).filter((m) => m.ref),
    }),
    fromFile: (doc) => ({
      uid: doc.uid, name: doc.name, kind: doc.kind, created_at: doc.created_at,
    }),
    listes: [{
      table: 'lot_member',
      liste: 'members',
      colonneParent: 'lot_id',
      remplace: (db2, parent, items, ctx, signaler) => {
        db2.prepare('DELETE FROM lot_member WHERE lot_id = ?').run(parent.id);
        const ins = db2.prepare('INSERT INTO lot_member (lot_id, kind, ref_id) VALUES (?,?,?)');
        for (const m of items) {
          const id = m.kind === 'mr' ? ctx.mrId(m.ref) : (m.kind === 'repo' ? ctx.repoId(m.ref) : Number(m.ref));
          if (!id) { signaler(`membre de lot « ${m.ref} » inconnu sur ce poste`); continue; }
          ins.run(parent.id, m.kind, id);
        }
      },
    }],
  },
  { table: 'lot_member', famille: 'P', uidPropre: false /* pas de clé primaire propre : (lot, genre, référence) la décrit entièrement */, parent: 'lot', liste: 'members', fusion: 'parent' },

  /* ── Git ─────────────────────────────────────────────────────────────────────────────── */
  {
    table: 'git_command', famille: 'P', uidPropre: true, cle: 'uid', chemin: 'git-commands/{uid}.json',
    fusion: 'last-writer',
    commitMessage: (r) => `git command ${String(r.label || '').slice(0, 50)}`,
    toFile: (r) => ({
      uid: r.uid, label: r.label, command: r.command, sort_order: r.sort_order || 0, created_at: r.created_at,
    }),
    fromFile: (doc) => ({
      uid: doc.uid, label: doc.label, command: doc.command,
      sort_order: doc.sort_order || 0, created_at: doc.created_at,
    }),
  },
  {
    table: 'git_op', famille: 'P', uidPropre: true, cle: 'uid', chemin: 'git-ops/{uid}.json',
    fusion: 'append-only',
    locales: ['restored_at'],
    note: 'journal ET restauration : le SHA d’une ref supprimée doit survivre au poste qui l’a '
      + 'supprimée — c’est précisément le cas où la personne qui répare n’est pas celle qui a '
      + 'effacé. `restored_at` reste local : restaurer se fait dans SON clone.',
    commitMessage: (r) => `git ${r.action} ${r.ref_name || ''}`.replace(/\s+/g, ' ').trim(),
    toFile: (r, ctx) => ({
      uid: r.uid,
      batch_id: r.batch_id,
      action: r.action,
      repo: r.repo_id ? ctx.repoRef(r.repo_id) : null,
      project: r.project || null,
      ref_name: r.ref_name || null,
      ref_sha: r.ref_sha || null,
      tag_sha: r.tag_sha || null,
      tag_message: r.tag_message || null,
      source_ref: r.source_ref || null,
      status: r.status,
      error: r.error || null,
      fetched: r.fetched ? 1 : 0,
      created_at: r.created_at,
    }),
    fromFile: (doc, ctx) => ({
      uid: doc.uid,
      batch_id: doc.batch_id,
      action: doc.action,
      repo_id: doc.repo ? ctx.repoId(doc.repo) : null,
      project: doc.project || null,
      ref_name: doc.ref_name || null,
      ref_sha: doc.ref_sha || null,
      tag_sha: doc.tag_sha || null,
      tag_message: doc.tag_message || null,
      source_ref: doc.source_ref || null,
      status: doc.status,
      error: doc.error || null,
      fetched: doc.fetched ? 1 : 0,
      created_at: doc.created_at,
    }),
  },
  {
    table: 'docker_backup', famille: 'P', uidPropre: true, cle: 'uid', chemin: 'docker-backups/{uid}.json',
    fusion: 'last-writer',
    note: 'les métadonnées d’un conteneur, jamais son archive : celle-ci pèse des centaines de Mo '
      + 'et se refabrique — la commande qui l’a lancé, elle, ne se retrouve pas',
    commitMessage: (r) => `docker backup ${String(r.name || '').slice(0, 50)}`,
    toFile: (r) => ({
      uid: r.uid, container_id: r.container_id || null, name: r.name, image: r.image || null,
      inspect_json: r.inspect_json || null, run_command: r.run_command || null, created_at: r.created_at,
    }),
    fromFile: (doc) => ({
      uid: doc.uid, container_id: doc.container_id || null, name: doc.name, image: doc.image || null,
      inspect_json: doc.inspect_json || null, run_command: doc.run_command || null, created_at: doc.created_at,
    }),
  },

  /* ── Réglages ────────────────────────────────────────────────────────────────────────── */
  /* `config` est la seule table dont CHAQUE colonne est classée nommément, et dont les deux
     listes doivent couvrir le schéma exactement (test unitaire). Ailleurs, une colonne nouvelle
     est partagée par défaut et c'est le bon défaut — une colonne nouvelle de `todo` est une
     donnée de todo. Ici le défaut serait catastrophique : cette table est un fourre-tout où
     voisinent des gabarits de prompt et sept jetons d'API. */
  {
    table: 'config', famille: 'P', uidPropre: false /* une seule ligne, qui EST le fichier settings.json : elle n'a pas d'identité à porter */, cle: 'id', chemin: 'settings.json', fusion: 'last-writer',
    locales: ['id',
      // Secrets. Un secret commité dans git est définitif : l'historique est immuable, chaque
      // clone le garde, la forge le garde. Il ne suffit pas de les retirer, il faut révoquer.
      'access_token', 'github_token', 'jira_email', 'jira_token', 'jenkins_user', 'jenkins_token',
      'dictation_api_key',
      // Propre au poste : où sont les clones, dans quelle langue on lit, à quelle cadence CE
      // poste interroge Jenkins, quel moteur de dictée tourne sur CETTE machine.
      'clone_path', 'language', 'jenkins_refresh_minutes', 'git_commands_seeded',
      'dictation_provider', 'dictation_model', 'dictation_vad_model', 'dictation_command',
      'dictation_url', 'dictation_remote_model', 'dictation_language', 'dictation_silence_ms',
      'dictation_final_pass', 'dictation_idle_minutes',
      // L'adresse par laquelle CE poste rejoint l'équipe. Vide = mono-poste.
      'data_repo_url', 'data_repo_branch', 'data_sync_seconds', 'usage_share'],
    partagees: [
      // Où est la forge, Jira, Jenkins : une équipe en a UNE. Le jeton, lui, reste de poste.
      'gitlab_url', 'github_url', 'jira_url', 'jenkins_url',
      // Ce qu'on demande à l'IA. D'équipe, et c'est le point : deux reviews de la même MR
      // faites avec des consignes différentes ne sont pas comparables.
      'prompt_review', 'prompt_explain', 'prompt_modify', 'prompt_fix', 'review_skill',
      'ai_extra_instructions',
      // Le glossaire de dictée : les noms propres du métier, pas la machine qui les entend.
      'dictation_vocabulary', 'dictation_replacements',
      // Politiques : ce qui part tout seul, à quelle cadence, jusqu'où, et ce qu'on garde.
      'auto_review_new', 'auto_rereview_stale', 'auto_post_review', 'auto_post_blocking_only',
      'review_auto_max', 'verif_auto_max', 'agent_auto_max', 'auto_refresh_minutes',
      'jira_watch_minutes', 'retention_days', 'review_explain', 'verify_jira_comment',
      'converge_threshold', 'converge_max_passes', 'stale_mr_days', 'todo_close_on_merge',
      'brief_on_open', 'jira_test_key',
      'task_default_auto_push', 'task_default_ask_questions', 'task_default_notify_jira',
      'task_default_converge'],
    commitMessage: () => 'settings',
    /* UNE SEULE LIGNE, UN SEUL FICHIER. On n'énumère pas les colonnes ici : c'est `partagees`
       qui fait foi, et la dupliquer serait la garantie qu'un jour les deux divergent — et que
       le jour où elles divergent, c'est un jeton qui passe du mauvais côté. */
    toFile: (r, ctx) => {
      const doc = { uid: 'settings' };
      for (const champ of ctx.champsPartages('config')) {
        if (r[champ] !== null && r[champ] !== undefined && r[champ] !== '') doc[champ] = r[champ];
      }
      return doc;
    },
    fromFile: (doc, ctx) => {
      const row = { id: 1 };
      for (const champ of ctx.champsPartages('config')) {
        row[champ] = doc[champ] === undefined ? null : doc[champ];
      }
      return row;
    },
  },

  /* ── Famille L : secret, ou propre à ce poste ────────────────────────────────────────── */
  /* L'ONGLET LIENS RESTE À SOI. La grille « services × environnements », les gabarits d'URL de
     contexte et les liens libres décrivent où l'on va travailler, pas ce qu'on a produit : des
     signets, des tableaux de bord internes, des adresses de recette qui n'ont de sens que pour
     celui qui les a rangées ainsi. Les partager imposerait à toute l'équipe la façon dont une
     personne classe ses raccourcis — et ferait entrer dans un dépôt d'URL d'infrastructure que
     rien n'oblige à écrire quelque part. Décision de l'auteur, 14 septembre 2026. */
  { table: 'environment', famille: 'L', note: 'les colonnes de la grille de liens (dev, recette, prod) de CE poste' },
  { table: 'service', famille: 'L', note: 'les lignes de la grille de liens' },
  { table: 'service_url', famille: 'L', note: 'les cases de la grille : une URL par service et par environnement' },
  { table: 'context_link', famille: 'L', note: 'les gabarits d’URL de contexte d’un service' },
  { table: 'free_link', famille: 'L', note: 'les liens libres, avec leurs étiquettes et leurs dossiers' },
  {
    table: 'local_config', famille: 'L',
    note: 'les réglages de CE poste : les sept jetons, le chemin des clones, la langue, le moteur '
      + 'de dictée. Jumelle de `config`, dont elle reçoit les colonnes `locales` — qui y sont '
      + 'ensuite vidées et gelées, avec une assertion au démarrage.',
  },
  {
    table: 'local_state', famille: 'L',
    note: 'de l’état DÉRIVÉ propre à ce poste : quand cet agent planifié a tourné ICI, quand ce '
      + 'ticket Jira a été relu ICI et avec quelle erreur réseau. Effaçable sans rien perdre.',
  },
  {
    table: 'local_pref', famille: 'L',
    note: 'une PRÉFÉRENCE d’affichage propre à ce poste : une session rangée l’est chez soi. '
      + 'La supprimer, en revanche, la supprimerait pour tout le monde.',
  },
  {
    table: 'local_dir_map', famille: 'L',
    note: 'où se trouve, SUR CETTE MACHINE, le dossier qu’une session hors dépôt désigne. La '
      + 'ligne partagée ne porte que l’empreinte du chemin, son libellé et son propriétaire.',
  },
  {
    table: 'local_session', famille: 'L',
    note: 'le handle d’une session d’agent — il ne vaut que dans le `~/.claude` du poste qui l’a '
      + 'créé. Un handle venu d’un collègue ne désigne rien ici : le repli « session neuve avec '
      + 'le contexte réinjecté » devient simplement le cas normal entre deux postes.',
  },
  {
    table: 'store_sale', famille: 'L',
    note: 'les lignes partagées touchées et pas encore écrites dans le dépôt. Remplie par des '
      + 'déclencheurs, DANS la transaction de l’écriture : c’est ce qui rend l’ensemble sûr à la '
      + 'coupure — rien ne se perd, tout au plus se retarde.',
  },
  {
    table: 'store_menage', famille: 'L',
    note: 'les tables où quelque chose a été supprimé. Une suppression ne peut pas dire QUEL '
      + 'fichier retirer (le chemin se calcule en JavaScript) : on balaie, en comparant le '
      + 'dossier aux lignes restantes.',
  },
  { table: 'local_root', famille: 'L', note: 'les racines de clone de CE poste' },
  { table: 'brief_hidden', famille: 'L', note: 'ce que ce poste a écarté de son brief du matin' },
  { table: 'usage', famille: 'L', note: 'la dépense d’un abonnement personnel (§ 9.4 : export agrégé optionnel)' },
  { table: 'launcher_usage', famille: 'L', note: 'l’ordre du lanceur, appris des gestes de ce poste' },

  /* ── Famille C : se recrée tout seul ─────────────────────────────────────────────────── */
  { table: 'commit_activity', famille: 'C', note: 'relu de la forge' },
  { table: 'feed', famille: 'C', note: 'relu de la forge' },
  { table: 'job', famille: 'C', note: 'la file de CE poste' },
  { table: 'job_log', famille: 'C', note: 'la console des jobs de ce poste — 58 % du poids de la base' },
  { table: 'make_run', famille: 'C', note: 'relu du disque' },
  { table: 'conn_test', famille: 'C', note: 'le dernier test de connexion de ce poste' },
  { table: 'git_merge', famille: 'C', note: 'un worktree en cours sur CE poste ; git fait foi du reste' },
];

const PAR_TABLE = new Map(REGISTRE.map((e) => [e.table, e]));

/** L'entrée du registre pour une table, ou `undefined`. */
const pour = (table) => PAR_TABLE.get(table);

/** Les tables d'une famille. */
const famille = (f) => REGISTRE.filter((e) => e.famille === f).map((e) => e.table);

/** Une table dont les lignes partent dans le dépôt (P, ou C avec des colonnes partagées). */
const partage = (table) => {
  const e = PAR_TABLE.get(table);
  return !!e && (e.famille === 'P' || (e.partagees || []).length > 0);
};

/** Les colonnes de `table` qui ne sortent jamais dans un fichier du dépôt. */
const localesDe = (table) => (PAR_TABLE.get(table) || {}).locales || [];

/** Résout un gabarit `chemin` avec les champs d'une ligne. */
const cheminDe = (table, champs) => {
  const e = PAR_TABLE.get(table);
  if (!e || !e.chemin) return null;
  return e.chemin.replace(/\{(\w+)\}/g, (_, k) => {
    if (champs[k] === undefined || champs[k] === null || champs[k] === '') {
      throw new Error(`store-registry: champ « ${k} » manquant pour le chemin de ${table}`);
    }
    return String(champs[k]);
  });
};

module.exports = {
  REGISTRE, TRANSITOIRES, INTERDITS, EXCEPTIONS,
  pour, famille, partage, localesDe, cheminDe,
};
