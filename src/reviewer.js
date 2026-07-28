'use strict';
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { getConfig } = require('./config');
const { REVIEWS_DIR, TMP_DIR, ensureDir, slugify } = require('./paths');
const git = require('./git');
const copilot = require('./copilot');
const agentsession = require('./agentsession');
const { extractNote } = require('./note');
const resolution = require('./resolution');
const glob = require('./glob');
const notify = require('./notify');

/* Instruction de CONSTATS STRUCTURÉS, ajoutée au prompt de review UNIQUEMENT à
   l'exécution — jamais écrite dans le template de l'utilisateur. Elle demande à
   l'IA d'émettre, à la suite du rapport, un bloc parsable qui alimente le suivi
   de résolution d'une passe à l'autre (ideas.md).
   La consigne « titre stable » est ce qui rend l'appariement mécanique fiable :
   un même problème doit garder le même titre pour être reconnu. */
const FINDINGS_INSTRUCTION =
  `\n\nEn PLUS du rapport ci-dessus, ajoute tout à la fin du fichier un bloc de ` +
  `constats structurés, délimité EXACTEMENT par ${resolution.START} et ${resolution.END}. ` +
  `À l'intérieur, une ligne par constat, au format : sévérité | fichier | ligne | titre court. ` +
  `La sévérité vaut blocker, major, minor ou info ; « fichier » est relatif au dépôt ; « ligne » ` +
  `est le numéro concerné (ou vide). Donne à chaque problème un TITRE stable et descriptif : le ` +
  `même problème doit garder le même titre d'une review à l'autre, pour être reconnu comme résolu ` +
  `ou persistant. N'ajoute aucun autre texte dans ce bloc.`;

function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function reviewDirFor(repo, mr) {
  return ensureDir(path.join(REVIEWS_DIR, slugify(repo.project), String(mr.iid)));
}

// Prépare le contexte commun (clone/fetch, diff, ticket) et expose une fonction
// generate() qui fait écrire la sortie de l'IA DANS un fichier du clone puis la lit.
// Utilisé aussi bien par la review que par la modification (même comportement).
async function prepareContext(cfg, repo, mr, onLog, opts = {}) {
  onLog(`préparation du dépôt ${repo.project}`);
  const cwd = await git.ensureRepo(cfg, repo, onLog);

  // Re-review incrémentale : ne diffuser que le DELTA depuis le dernier SHA reviewé
  // (best-effort ; en cas d'échec — SHA absent après force-push, etc. — on retombe sur
  // le diff complet pour ne jamais bloquer la review).
  let diff = null;
  let usedIncremental = false;
  const canIncrement = opts.incremental && mr.reviewed_sha && mr.current_sha && mr.reviewed_sha !== mr.current_sha;
  if (canIncrement) {
    try {
      diff = await git.diffRange(cwd, mr.reviewed_sha, mr.current_sha, onLog);
      usedIncremental = true;
    } catch (e) {
      onLog(`⚠ diff incrémental impossible (${String(e.message).split('\n')[0]}) → diff complet`);
      diff = null;
    }
  }
  if (diff == null) {
    onLog(`calcul du diff ${mr.source_branch}...${mr.target_branch}`);
    diff = await git.targetedDiff(cwd, mr.source_branch, mr.target_branch, onLog);
  }

  const outDir = reviewDirFor(repo, mr);
  // IMPORTANT : les fichiers d'échange (diff + sorties) doivent être DANS le clone
  // (cwd de copilot), sinon copilot (bac à sable) ne peut ni les lire ni les écrire.
  const workRel = 'ai-dev-tools-internal';
  ensureDir(path.join(cwd, workRel));
  const diffName = `${workRel}/diff.patch`;
  fs.writeFileSync(path.join(cwd, diffName), diff, 'utf8');
  const diffStorePath = path.join(outDir, 'diff.patch');
  fs.writeFileSync(diffStorePath, diff, 'utf8');

  const baseVars = {
    skill: cfg.review_skill || 'git-review',
    source: mr.source_branch,
    target: mr.target_branch,
    diff_file: diffName,
    project: repo.project,
  };

  // Contexte du ticket. DEUX sources distinctes réunies ici :
  //  - ticket_jira_text : récupéré automatiquement depuis Jira au discover ;
  //  - ticket_text      : le complément saisi à la main par le relecteur.
  // Les deux sont concaténés — l'un n'écrase jamais l'autre (ideas.md « Fetch Jira »).
  let ticketBlock = '';
  if (mr.ticket_jira_text && mr.ticket_jira_text.trim()) {
    ticketBlock += `\n\nContexte du ticket ${mr.ticket_jira_key || ''} (récupéré depuis Jira), à prendre en compte dans l'analyse :\n"""\n${mr.ticket_jira_text.trim()}\n"""`;
  }
  if (mr.ticket_text && mr.ticket_text.trim()) {
    ticketBlock += `\n\nContexte complémentaire fourni par le relecteur (spécification, règle métier, échange…), à prendre en compte dans l'analyse :\n"""\n${mr.ticket_text.trim()}\n"""`;
  }
  if (mr.ticket_image && fs.existsSync(mr.ticket_image)) {
    const ext = path.extname(mr.ticket_image) || '.png';
    const rel = `${workRel}/ticket${ext}`;
    try {
      fs.copyFileSync(mr.ticket_image, path.join(cwd, rel));
      ticketBlock += `\n\nUne capture d'écran jointe au contexte est disponible dans le fichier \`${rel}\` (chemin relatif au dépôt) — ouvre-la et prends son contenu en compte si pertinent.`;
      onLog('contexte : capture jointe');
    } catch (e) { onLog(`⚠ capture de contexte ignorée : ${e.message}`); }
  }
  if (ticketBlock) onLog('contexte pris en compte dans le prompt');

  // Règles de review spécifiques : critères additionnels dont le fragment de nom
  // de branche est contenu dans source_branch. Ajoutées au prompt de REVIEW seulement.
  // Chemins réellement modifiés, extraits du diff (source la plus fiable). On en
  // profite pour les persister : le badge « risque » de la liste s'en sert.
  const changedPaths = [...new Set([...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]).filter((p) => p !== '/dev/null'))];
  try { db.prepare('UPDATE mr SET changed_paths = ? WHERE id = ?').run(changedPaths.join('\n'), mr.id); } catch { /* non bloquant */ }

  /* Règles de review : une règle s'applique si son fragment de BRANCHE est présent
     dans le nom de branche, OU si son motif de CHEMIN matche un fichier du diff.
     Le risque d'une MR vient de ce qu'elle touche, pas de comment elle s'appelle. */
  let rulesBlock = '';
  const rules = db.prepare('SELECT * FROM review_rule WHERE enabled = 1').all().filter((r) => {
    const branchHit = r.branch_match && (mr.source_branch || '').includes(r.branch_match);
    const pathHit = r.path_match && glob.matchingPaths(r.path_match, changedPaths).length > 0;
    return branchHit || pathHit;
  });
  if (rules.length) {
    rulesBlock = '\n\nCritères additionnels spécifiques à vérifier pour cette MR (règles configurées) :';
    for (const r of rules) {
      const why = r.path_match && glob.matchingPaths(r.path_match, changedPaths).length
        ? `chemin « ${r.path_match} »` : `branche « ${r.branch_match} »`;
      rulesBlock += `\n- (règle ${why}) ${r.content}`;
    }
    onLog(`${rules.length} règle(s) de review spécifique(s) appliquée(s)`);
  }

  /* Projets liés : l'IA analyse l'impact des changements de la MR sur d'autres dépôts.
     Choix d'archi retenu : la review tourne dans le clone principal (cwd inchangé,
     le skill n'est pas perturbé) ; les projets liés sont MONTÉS EN LECTURE via un
     symlink sous ai-dev-tools-internal/linked/<projet> (dossier déjà git-excludé).
     Lecture seule garantie : chaque worktree lié est remis à zéro dans le cleanup,
     comme l'exploration. Best-effort : un projet lié en échec n'interrompt pas la review. */
  let linkedBlock = '';
  const linkedDirs = []; // { cwd } des clones liés, à remettre à zéro après
  const linkRoot = path.join(cwd, workRel, 'linked');
  const links = db.prepare('SELECT * FROM mr_link WHERE mr_id = ?').all(mr.id);
  if (links.length) {
    try { fs.rmSync(linkRoot, { recursive: true, force: true }); } catch { /* rien à nettoyer */ }
    ensureDir(linkRoot);
    const mounted = [];
    for (const link of links) {
      const lrepo = db.prepare('SELECT * FROM repo WHERE id = ?').get(link.repo_id);
      if (!lrepo) continue;
      try {
        const lcwd = await git.ensureRepo(cfg, lrepo, onLog);
        await git.ensureCleanWorktree(lcwd, onLog);
        const branch = (link.branch || '').trim() || await git.defaultBranch(lcwd);
        if (await git.refExists(lcwd, `origin/${branch}`)) await git.createBranchFrom(lcwd, branch, `origin/${branch}`, onLog);
        else if (await git.refExists(lcwd, `refs/heads/${branch}`)) await git.checkoutBranch(lcwd, branch, onLog);
        else { onLog(`⚠ projet lié ${lrepo.project} : branche ${branch} introuvable, ignoré`); continue; }
        const slug = slugify(lrepo.project);
        const linkPath = path.join(linkRoot, slug);
        try { fs.symlinkSync(lcwd, linkPath); } catch { fs.rmSync(linkPath, { recursive: true, force: true }); fs.symlinkSync(lcwd, linkPath); }
        linkedDirs.push({ cwd: lcwd });
        mounted.push({ rel: `${workRel}/linked/${slug}`, project: lrepo.project, branch });
        onLog(`projet lié monté : ${lrepo.project} (${branch})`);
      } catch (e) { onLog(`⚠ projet lié ${lrepo.project} : ${e.message.split('\n')[0]}`); }
    }
    if (mounted.length) {
      linkedBlock = `\n\nCette MR modifie le projet **${repo.project}**. D'AUTRES PROJETS en dépendent `
        + `potentiellement et sont disponibles EN LECTURE dans les dossiers suivants (relatifs au dépôt courant) :`;
      for (const m of mounted) linkedBlock += `\n- \`${m.rel}\` — projet ${m.project}, branche ${m.branch}`;
      linkedBlock += `\n\nAnalyse si les changements du diff (signatures de fonctions/API, contrats, schémas `
        + `de données, colonnes, noms de routes, événements, formats…) risquent d'IMPACTER ces projets liés. `
        + `Cherche-y les usages concernés et, pour chaque impact plausible, cite le fichier et la ligne PRÉCIS `
        + `côté projet lié. Si tu ne vois aucun impact plausible, dis-le explicitement. Ne modifie AUCUN fichier `
        + `des projets liés — ils sont fournis en lecture seule.`;
    }
  }
  // Remet à zéro les worktrees des projets liés (garantie lecture seule) et retire les liens.
  async function cleanupLinked() {
    for (const d of linkedDirs) { try { await git.resetWorktree(d.cwd, () => {}); } catch { /* best-effort */ } }
    try { fs.rmSync(linkRoot, { recursive: true, force: true }); } catch { /* déjà parti */ }
    if (linkedDirs.length) onLog('projets liés remis à zéro (analyse en lecture seule)');
  }

  // Lance un prompt en demandant à l'IA d'ÉCRIRE sa sortie dans outRel (dans le clone),
  // puis lit ce fichier (contenu propre). extra = bloc additionnel (ex: modif).
  // Fallback sur stdout si le fichier est absent/vide.
  async function generate(promptTemplate, outRel, kind, extra = '') {
    const outAbs = path.join(cwd, outRel);
    try { fs.rmSync(outAbs, { force: true }); } catch { /* pas de fichier précédent */ }
    const instruction =
      `\n\nIMPORTANT : écris le résultat final en Markdown UNIQUEMENT dans le fichier ` +
      `\`${outRel}\` (chemin relatif au dépôt courant). Écris uniquement le contenu du ` +
      `document dans ce fichier, sans le dupliquer dans la sortie standard.`;
    const rb = (kind === 'review') ? rulesBlock : ''; // règles = prompt de review uniquement
    const fi = (kind === 'review') ? FINDINGS_INSTRUCTION : ''; // constats = review uniquement
    const lb = (kind === 'review') ? linkedBlock : ''; // analyse d'impact = review uniquement
    const prompt = fillTemplate(promptTemplate, { ...baseVars, out_file: outRel }) + ticketBlock + rb + lb + extra + fi + instruction;
    // extraInput : le diff n'est PAS dans le prompt (on ne passe que son chemin),
    // mais l'agent le lit — il doit donc compter dans la consommation.
    // Continuité : la review/modif tourne dans une session reprenable par MR (« Relancer la
    // review » reprend le contexte de la review précédente). Session seulement si un backend
    // reprenable est reconnu et hors dry-run ; sinon appel one-shot (comportement historique).
    const useSession = !copilot.isDryRun() && (kind === 'review' || kind === 'modify') && agentsession.backendName() !== 'unknown';
    let stdout = '';
    if (useSession) {
      const key = `review-mr-${mr.id}`;
      const s = db.prepare('SELECT review_session_key, review_session_cwd FROM mr WHERE id = ?').get(mr.id) || {};
      let doResume = !!s.review_session_key;
      if (doResume && s.review_session_cwd && path.resolve(s.review_session_cwd) !== path.resolve(cwd)) doResume = false;
      let r; let created = !doResume;
      try {
        r = await agentsession.runInSession({ key, handle: doResume ? s.review_session_key : null, prompt, cwd, resume: doResume, onLog });
      } catch (e) {
        if (!doResume) throw e;
        onLog(`⚠ reprise de la session de review impossible (${String(e.message).split('\n')[0]}) → session neuve`);
        r = await agentsession.runInSession({ key, prompt, cwd, resume: false, onLog });
        created = true;
      }
      stdout = r.text || '';
      if (created) {
        db.prepare('UPDATE mr SET review_session_key = ?, review_session_backend = ?, review_session_cwd = ? WHERE id = ?')
          .run(r.handle, r.backend, cwd, mr.id);
      }
    } else {
      stdout = await copilot.runPrompt(prompt, cwd, { ...baseVars, out_file: outRel, kind, extraInput: diff }, onLog);
    }
    let content = '';
    if (fs.existsSync(outAbs)) content = fs.readFileSync(outAbs, 'utf8').trim();
    if (!content) {
      onLog(`(fichier ${outRel} vide/absent → repli sur la sortie standard)`);
      content = (stdout || '').trim();
    } else {
      onLog(`document lu depuis ${outRel} (${content.length} octets)`);
      // le rapport n'a pas transité par stdout : on complète le comptage de l'appel
      if (!useSession) copilot.addOutputToLastUsage(content);
    }
    // Le run en session ne passe pas par copilot.runPrompt : on compte ici l'appel (prompt +
    // diff en entrée, rapport en sortie).
    if (useSession) copilot.recordUsage(kind, prompt, content, diff);
    return content || '_(aucun contenu produit)_';
  }

  // `incremental` = true seulement si le diff delta a réellement été produit (permet à
  // reviewMr d'injecter le rapport précédent en contexte, et de savoir qu'il ne voit
  // qu'une partie de la MR).
  return { cwd, outDir, diffStorePath, generate, cleanupLinked, incremental: usedIncremental };
}

// Enregistre une NOUVELLE version de la review au lieu d'écraser la précédente.
// La table `review` continue de pointer la version la plus récente : le reste de
// l'application (rapports, dashboard, footer) n'a rien à changer.
function saveReviewVersion(mr, outDir, { reviewContent, explainContent, diffStorePath, kind, noExplain, instruction }) {
  const now = new Date().toISOString();
  const last = db.prepare('SELECT MAX(version) v FROM review_version WHERE mr_id = ?').get(mr.id);
  const version = (last && last.v ? last.v : 0) + 1;

  const mdPath = path.join(outDir, `review-v${version}.md`);
  fs.writeFileSync(mdPath, reviewContent, 'utf8');
  let explPath = null;
  if (explainContent != null) {
    explPath = path.join(outDir, `explanation-v${version}.md`);
    fs.writeFileSync(explPath, explainContent, 'utf8');
  } else if (!noExplain) {
    // régénération du seul rapport (modify) : on conserve l'explication précédente.
    const prev = db.prepare('SELECT explanation_path FROM review WHERE mr_id = ?').get(mr.id);
    explPath = prev ? prev.explanation_path : null;
  }
  // noExplain (review seule) : explPath reste null — l'explication se génère à la demande.

  const note = extractNote(reviewContent);
  const noteValue = note ? note.value : null;

  db.prepare(`INSERT INTO review_version
    (mr_id, version, md_path, explanation_path, note_value, reviewed_sha, kind, created_at, instruction)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(mr.id, version, mdPath, explPath, noteValue, mr.current_sha || null, kind || 'review', now,
      instruction ? String(instruction) : null);

  const existing = db.prepare('SELECT id FROM review WHERE mr_id = ?').get(mr.id);
  if (existing) {
    db.prepare('UPDATE review SET md_path = ?, explanation_path = ?, diff_path = ?, note_value = ?, updated_at = ? WHERE mr_id = ?')
      .run(mdPath, explPath, diffStorePath, noteValue, now, mr.id);
  } else {
    db.prepare('INSERT INTO review (mr_id, md_path, explanation_path, diff_path, note_value, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(mr.id, mdPath, explPath, diffStorePath, noteValue, now, now);
  }
  return { version, mdPath, explPath, noteValue, now };
}

// Produit (ou reproduit) la review pour une MR. L'explication pédagogique (2e appel IA)
// est optionnelle : `opts.explain` la force (true/false) ; sinon on suit le réglage global
// `review_explain`. En review seule, l'explication reste disponible à la demande (explainMr).
// `opts.incremental` : ne diffuser que le delta depuis le dernier SHA reviewé et fournir
// le rapport précédent en contexte, pour un rapport COMPLET mis à jour à moindre coût.
async function reviewMr(repo, mr, onLog = () => {}, opts = {}) {
  const cfg = getConfig();
  const explain = opts.explain != null ? !!opts.explain : cfg.review_explain !== '0';
  const { cwd, outDir, diffStorePath, generate, cleanupLinked, incremental } = await prepareContext(cfg, repo, mr, onLog, { incremental: opts.incremental });

  try {
    // En incrémental, l'IA ne voit QUE le delta : on lui donne le rapport précédent en
    // contexte et on lui demande un rapport complet à jour (mêmes exigences et format).
    let extra = '';
    if (incremental) {
      const prev = db.prepare('SELECT md_path FROM review WHERE mr_id = ?').get(mr.id);
      const previous = (prev && prev.md_path && fs.existsSync(prev.md_path)) ? fs.readFileSync(prev.md_path, 'utf8') : '';
      extra = `\n\nRE-REVIEW INCRÉMENTALE. Un rapport de revue existe déjà pour cette MR :\n"""\n${previous || '(aucun)'}\n"""\n`
        + `Le diff fourni ne contient QUE les changements APPARUS DEPUIS cette review (le reste de la MR est inchangé). `
        + `Produis un rapport de revue COMPLET et À JOUR de la MR : pars du rapport précédent, tiens compte de l'effet des nouveaux changements `
        + `(problèmes désormais corrigés → à retirer, nouveaux problèmes introduits → à ajouter), et rends-le dans le MÊME format et avec les MÊMES exigences qu'une revue complète (note incluse).`;
      onLog('re-review incrémentale : delta + rapport précédent en contexte');
    }

    onLog(`review IA (${copilot.isDryRun() ? 'dry-run' : 'copilot'})${incremental ? ' — incrémentale' : ''}`);
    const rawReview = await generate(cfg.prompt_review, 'ai-dev-tools-internal/review.md', 'review', extra);
    // On retire le bloc de constats du rapport affiché : il ne doit pas polluer la
    // lecture. Ce qui est enregistré et montré est le Markdown SANS le bloc.
    const { markdown: reviewContent, block } = resolution.splitFindings(rawReview);
    const findings = resolution.parseFindings(block);

    let explainContent = null;
    if (explain) {
      onLog('explication pédagogique');
      explainContent = await generate(cfg.prompt_explain, 'ai-dev-tools-internal/explanation.md', 'explain');
    } else {
      onLog('explication ignorée (review seule)');
    }

    const { version, mdPath, explPath, now, noteValue } = saveReviewVersion(mr, outDir, {
      reviewContent, explainContent, diffStorePath, kind: 'review', noExplain: !explain,
    });
    onLog(`rapport enregistré (version ${version})`);
    // Note pour la notif « review sous un seuil » (le client décide selon SON seuil).
    notify.push('review_done', { mr_id: mr.id, iid: mr.iid, note10: noteValue == null ? null : Math.round(noteValue * 1000) / 100 });

    // Suivi de résolution : compare aux constats de la passe précédente.
    await trackResolution({ cwd, mr, version, findings, newSha: mr.current_sha, onLog });

    db.prepare(`UPDATE mr SET reviewed_sha = current_sha, status = 'reviewed', last_error = NULL, updated_at = ? WHERE id = ?`)
      .run(now, mr.id);

    return { mdPath, explPath, version };
  } finally {
    // Garantie lecture seule des projets liés, quoi qu'il arrive.
    await cleanupLinked();
  }
}

/* Persiste les constats de la passe `version` avec leur statut relatif à la passe
   précédente, et stocke les agrégats sur la ligne review_version. Best-effort :
   une défaillance du suivi ne doit pas faire échouer la review elle-même. */
async function trackResolution({ cwd, mr, version, findings, newSha, onLog }) {
  try {
    const prevV = db.prepare(
      'SELECT version, reviewed_sha FROM review_version WHERE mr_id = ? AND version < ? ORDER BY version DESC LIMIT 1',
    ).get(mr.id, version);
    const previous = prevV
      ? db.prepare('SELECT fingerprint, file, line, severity, title FROM finding WHERE mr_id = ? AND version = ?').all(mr.id, prevV.version)
      : [];

    const { rows, counts } = await resolution.diffFindings({
      cwd, current: findings, previous,
      oldSha: prevV ? prevV.reviewed_sha : null, newSha, onLog,
    });

    const now = new Date().toISOString();
    const ins = db.prepare(`INSERT INTO finding
      (mr_id, version, fingerprint, file, line, severity, title, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const tx = db.transaction(() => {
      for (const r of rows) ins.run(mr.id, version, r.fingerprint, r.file, r.line, r.severity, r.title, r.status, now);
      // Les agrégats ne valent que dès la 2e passe (avant, tout est « nouveau »).
      if (prevV) {
        db.prepare('UPDATE review_version SET n_new=?, n_persistent=?, n_resolved=?, n_disappeared=? WHERE mr_id=? AND version=?')
          .run(counts.n_new, counts.n_persistent, counts.n_resolved, counts.n_disappeared, mr.id, version);
      }
    });
    tx();
  } catch (e) {
    onLog(`⚠ suivi de résolution ignoré : ${e.message.split('\n')[0]}`);
  }
}

// Modification : MÊME pipeline que la review (skill + diff + contexte, sortie fichier),
// en ajoutant l'ancien rapport + la demande du relecteur. Écrase review.md.
async function modifyReview(repo, mr, instruction, onLog = () => {}) {
  const cfg = getConfig();
  const rev = db.prepare('SELECT * FROM review WHERE mr_id = ?').get(mr.id);
  const previous = (rev && rev.md_path && fs.existsSync(rev.md_path))
    ? fs.readFileSync(rev.md_path, 'utf8') : '';

  const { outDir, diffStorePath, generate, cleanupLinked } = await prepareContext(cfg, repo, mr, onLog);

  try {
    const extra =
      `\n\nUn rapport de revue existe déjà pour cette MR :\n"""\n${previous || '(aucun)'}\n"""\n` +
      `Demande de modification du relecteur, à appliquer : ${instruction}\n` +
      `Produis le rapport de revue MIS À JOUR (même style et exigences qu'une revue complète).`;

    onLog(`modification IA (${copilot.isDryRun() ? 'dry-run' : 'copilot'})`);
    const content = await generate(cfg.prompt_review, 'ai-dev-tools-internal/review.md', 'review', extra);

    // une régénération est une nouvelle version : l'ancienne reste consultable
    const { version, mdPath } = saveReviewVersion(mr, outDir, {
      reviewContent: content, explainContent: null, diffStorePath, kind: 'modify', instruction,
    });
    onLog(`rapport enregistré (version ${version})`);
    return { mdPath, version };
  } finally {
    await cleanupLinked();
  }
}

// Génère la SEULE explication pédagogique pour la version courante d'une MR déjà
// reviewée (1 appel IA), sans retoucher au rapport. Sert au bouton « Générer
// l'explication » quand la review a été lancée en mode « review seule ».
async function explainMr(repo, mr, onLog = () => {}) {
  const cfg = getConfig();
  const { outDir, generate, cleanupLinked } = await prepareContext(cfg, repo, mr, onLog);

  try {
    onLog(`explication IA (${copilot.isDryRun() ? 'dry-run' : 'copilot'})`);
    const explainContent = await generate(cfg.prompt_explain, 'ai-dev-tools-internal/explanation.md', 'explain');

    // On rattache l'explication à la version courante, sans créer de nouvelle version.
    const last = db.prepare('SELECT MAX(version) v FROM review_version WHERE mr_id = ?').get(mr.id);
    const version = last && last.v ? last.v : 1;
    const explPath = path.join(outDir, `explanation-v${version}.md`);
    fs.writeFileSync(explPath, explainContent, 'utf8');

    const now = new Date().toISOString();
    db.prepare('UPDATE review_version SET explanation_path = ? WHERE mr_id = ? AND version = ?').run(explPath, mr.id, version);
    db.prepare('UPDATE review SET explanation_path = ?, updated_at = ? WHERE mr_id = ?').run(explPath, now, mr.id);
    onLog(`explication enregistrée (version ${version})`);
    return { explPath, version };
  } finally {
    await cleanupLinked();
  }
}

module.exports = { reviewMr, modifyReview, explainMr, fillTemplate };
