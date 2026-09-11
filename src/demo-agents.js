'use strict';
/* Le mode démo des agents : ce qu'un agent RÉPOND quand aucun binaire d'IA n'est là.
 *
 * Les autres modules de démo (`demo-jira`, `demo-docker`) fabriquent des données ; celui-ci
 * fabrique des SORTIES D'AGENT — c'est ce qui permet de montrer, sans clé d'API, que le
 * cartographe crée un agent, que l'enquêteur nomme un dépôt, et qu'un agent de domaine
 * signale un écart. Les blocs de protocole y sont donc VRAIS : ils sont parsés par le même
 * code qu'en production, et c'est précisément ce que les tests de bout en bout exercent.
 *
 * Séquence fixe, aucun aléa : une démo qui change à chaque lancement ne se raconte pas.
 */

const db = require('./db');

const isDemo = () => process.env.MERGERIE_DEMO === '1';

/* Les skills et sous-agents du décor. Le scan du disque ne trouverait rien dans une démo :
   les dépôts fictifs ne sont pas clonés. */
function scan() {
  const projets = db.prepare('SELECT id, project FROM repo ORDER BY id LIMIT 2').all();
  const p0 = projets[0] || { id: 1, project: 'groupe/api-core' };
  const p1 = projets[1] || { id: 2, project: 'groupe/webapp-front' };
  const items = [
    { name: 'revue-de-code', description: 'Relit un diff avec les conventions du dépôt.', source: 'repo', repo_id: p0.id, project: p0.project, path: `${p0.project}/.claude/skills/revue-de-code/SKILL.md`, kind: 'skill', userInvocable: true, modelInvocable: true, tools: ['Read', 'Grep'] },
    { name: 'migration-sql', description: 'Écrit une migration et son rollback, avec le style du dépôt.', source: 'repo', repo_id: p0.id, project: p0.project, path: `${p0.project}/.claude/skills/migration-sql/SKILL.md`, kind: 'skill', userInvocable: true, modelInvocable: true, tools: ['Read', 'Write'] },
    { name: 'a11y', description: 'Vérifie l’accessibilité d’un composant.', source: 'repo', repo_id: p1.id, project: p1.project, path: `${p1.project}/.claude/skills/a11y/SKILL.md`, kind: 'skill', userInvocable: true, modelInvocable: true, tools: ['Read'] },
    { name: 'interne-tri', description: 'Réservé au modèle : trie des constats.', source: 'repo', repo_id: p1.id, project: p1.project, path: `${p1.project}/.claude/skills/interne-tri/SKILL.md`, kind: 'skill', userInvocable: false, modelInvocable: true, tools: [] },
    { name: 'commit-propre', description: 'Écrit un message de commit selon la convention de l’équipe.', source: 'user', repo_id: null, project: null, path: '~/.claude/skills/commit-propre/SKILL.md', kind: 'skill', userInvocable: true, modelInvocable: true, tools: [] },
    { name: 'notes-de-version', description: 'Rédige les notes de version depuis les commits.', source: 'user', repo_id: null, project: null, path: '~/.claude/skills/notes-de-version/SKILL.md', kind: 'skill', userInvocable: true, modelInvocable: true, tools: ['Read'] },
    { name: 'relecteur', description: 'Sous-agent de fichier : relit un fichier et rend trois remarques.', source: 'repo', repo_id: p0.id, project: p0.project, path: `${p0.project}/.claude/agents/relecteur.md`, kind: 'agent', userInvocable: true, modelInvocable: true, tools: ['Read', 'Grep'] },
  ];
  return { items, uncloned: [] };
}

// L'âge d'une connaissance, en valeurs fixes : la démo n'a pas de clone à interroger.
function age(agent) {
  const repos = db.prepare(`SELECT repo.project FROM agent_repo ar JOIN repo ON repo.id = ar.repo_id
    WHERE ar.agent_id = ? ORDER BY repo.project`).all(agent.id);
  return repos.map((r, i) => ({
    project: r.project,
    commits: [7, 0, 3][i % 3],
    last_at: [7, 0, 3][i % 3] ? new Date(Date.now() - (i + 2) * 86400000).toISOString() : null,
  }));
}

const projets = () => db.prepare('SELECT project FROM repo ORDER BY id').all().map((r) => r.project);

/* Le rapport rendu en dry-run, par famille d'agent. Chacun porte son bloc de protocole, VRAI :
   c'est le même parseur qui le lira. Sans cela, la démo montrerait l'écran mais jamais le
   mécanisme — et les tests de bout en bout n'auraient rien à exercer. */
function rapport(agent, mode, question, promptComplet) {
  const p = projets();
  const p0 = p[0] || 'groupe/api-core';
  const p1 = p[1] || p0;
  /* QUEL RÔLE JOUER : ce que la DEMANDE réclame, pas ce que le profil s'appelle. Une mise à
     jour de connaissance est portée par l'agent de domaine (c'est sa carte qu'on refait) mais
     exécutée par le cartographe : c'est le prompt qui dit lequel des deux répond, et le décor
     doit suivre la même règle que la production, sinon il valide un chemin que personne
     n'emprunte. Le profil ne sert que de repli, quand la demande ne demande rien. */
  const demande = String(promptComplet || '');
  const veut = (bloc) => demande.includes(`<<<${bloc}`);
  const role = veut('AGENT') ? 'cartographer'
    : (veut('REPO') ? 'investigator'
      : (veut('STALE') ? 'domain' : (agent.builtin_key || (agent.knowledge_prompt ? 'domain' : 'librarian'))));
  if (role === 'investigator') {
    return [
      '# Où est ce code',
      '',
      `## Dépôt et fichier`,
      `**${p0}** — \`src/cart/session.js:118\``,
      '',
      '## Ce que fait ce code',
      'Il relit le panier depuis le cookie de session, et le vide si le TTL est dépassé.',
      '',
      '## Hypothèse de cause',
      'Le TTL du cookie de panier est plus court que celui de la session : après trente minutes, le panier est purgé alors que la session, elle, tient encore.',
      '',
      '## Changements récents',
      '- `a1b2c3d` refactor: extrait la lecture du panier (il y a 6 jours)',
      '',
      '## Ce que je n’ai pas trouvé',
      'Aucun test ne couvre la reconnexion après expiration du cookie.',
      '',
      '<<<REPO',
      `${p0} | src/cart/session.js | 118`,
      'REPO>>>',
    ].join('\n');
  }
  if (role === 'librarian') {
    return [
      '# Carte des services',
      '',
      ...p.flatMap((x) => [
        `## ${x}`,
        `- **Rôle** : ${x.includes('front') ? 'l’interface web' : (x.includes('batch') ? 'les traitements par lots' : 'l’API métier')}.`,
        '- **Expose** : une API HTTP et des événements sur le bus.',
        '- **Consomme** : la base principale et le service d’authentification.',
        '- **En local** : `npm ci && npm start`.',
        '- **Configuration** : `.env`, lu par `src/config.js`.',
        '',
      ]),
      '## Qui appelle qui',
      `- ${p1} → ${p0} (HTTP)`,
      `- ${p0} → le bus d’événements`,
    ].join('\n');
  }
  if (role === 'cartographer') {
    /* Le NOM de l'agent créé : tiré du sujet, avec un repli fixe. Un décor doit se raconter —
       « Notifications » se lit, « Sujet à cartographier » se subit. */
    const sujet = String(question || '').split('\n').map((x) => x.trim()).find(Boolean) || 'Les notifications';
    const nom = sujet.replace(/^les\s+/i, '').replace(/\s*:.*$/, '').trim().slice(0, 40) || 'Notifications';
    return [
      '<<<AGENT',
      `name: ${nom.charAt(0).toUpperCase()}${nom.slice(1)}`,
      `repo: ${p0} | émet et route les notifications`,
      `repo: ${p1} | les affiche`,
      `path: ${p0} | src/notify.js`,
      `path: ${p0} | src/templates/notifications`,
      `path: ${p1} | src/components/Toast.jsx`,
      `path: ${p0} | src/notify-inexistant.js`,
      'AGENT>>>',
      '',
      `# ${sujet.slice(0, 120)}`,
      '## Périmètre',
      'Ce que le sujet couvre : l’émission, le routage et l’affichage des notifications. Ce qu’il ne couvre pas : les e-mails transactionnels.',
      '## Dépôts concernés',
      `- **${p0}** — émission et routage — chemins clés : \`src/notify.js\`, \`src/templates/notifications\``,
      `- **${p1}** — affichage — chemins clés : \`src/components/Toast.jsx\``,
      '## Points d’entrée',
      `- \`src/notify.js\` : la fonction \`push(kind, payload)\`.`,
      '## Mécanismes',
      '- Un bus interne, écouté par un worker qui appelle le canal choisi.',
      '## Types / variantes',
      '- `queue_done`, `review_done`, `job_failed`, `session_done`.',
      '## Configuration',
      '- Les canaux actifs vivent dans la table `config`.',
      '## Tests',
      '- `test/unit-notify.test.js` couvre le routage, pas l’affichage.',
      '## Pièges',
      '- Le worker avale les erreurs de canal : un canal cassé ne se voit nulle part.',
      '## Non trouvé',
      `- \`src/notify-inexistant.js\` : cité par un commentaire, absent du dépôt.`,
      '## Notes de l’équipe',
      '',
    ].join('\n');
  }
  // Un agent de DOMAINE : il répond, et signale au passage ce qu'il a vu de faux.
  return [
    `# ${String(question || '').split('\n')[0].slice(0, 80) || 'Réponse'}`,
    '',
    'Les notifications partent de `src/notify.js`, via un bus interne. Le worker choisit le canal selon la table `config`.',
    '',
    'Attention : le chemin des gabarits a changé depuis la dernière cartographie.',
    '',
    '<<<STALE',
    `${p0} | src/templates/notifications | le dossier a été renommé en src/notifications/templates`,
    'STALE>>>',
  ].join('\n');
}

module.exports = { isDemo, scan, age, rapport };
