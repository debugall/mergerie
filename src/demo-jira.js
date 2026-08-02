'use strict';
/* Données Jira FICTIVES du mode démo (npm run demo) : tickets « affectés », détail +
   commentaires. Séquence FIXE (pas de Date/random) pour rester déterministe. */

const ISSUES = [
  {
    key: 'PROJ-1421', summary: 'Le panier perd les articles après reconnexion', type: 'Bug', typeIcon: '',
    sprints: [{ v: '42', l: 'Sprint 42' }],
    epic: { key: 'PROJ-1100', summary: 'Fiabiliser le tunnel de commande', color: 'purple' },
    status: 'En cours', statusCategory: 'indeterminate', priority: 'Haute',
    assignee: { accountId: 'me-001', name: 'Toi (démo)', email: 'toi@demo', avatar: '' },
    reporter: { name: 'Support N2', email: 'support@demo', avatar: '' },
    project: 'PROJ — Boutique en ligne', labels: ['panier', 'régression'],
    created: '2026-07-18T09:12:00.000+0000', updated: '2026-07-24T16:40:00.000+0000',
    duedate: '2026-07-30', components: ['api', 'web'], fixVersions: ['2.4.0'],
    descriptionMd: "## Contexte\nAprès une reconnexion, le panier est **vidé** alors qu'il devrait être restauré.\n\n### Étapes\n1. Ajouter 3 articles\n2. Se déconnecter puis se reconnecter\n3. Le panier est vide\n\n> Attendu : le panier persiste (cookie + table `cart`).",
    attachments: [
      { id: '90001', filename: 'capture-panier-vide.png', size: 184320, mimeType: 'image/png', created: '2026-07-19T08:05:00.000+0000', author: 'Support N2' },
      { id: '90002', filename: 'logs-session.txt', size: 5120, mimeType: 'text/plain', created: '2026-07-19T08:06:00.000+0000', author: 'Support N2' },
    ],
    comments: [
      { author: 'Support N2', created: '2026-07-19T08:00:00.000+0000', bodyMd: 'Reproduit sur la préprod, uniquement quand la session dépasse 30 min.' },
      { author: 'Toi (démo)', created: '2026-07-24T16:40:00.000+0000', bodyMd: "Le TTL du cookie de panier est plus court que la session. Voici la capture du problème :\n\n![capture-panier-vide.png](/api/jira/attachment/90001)\n\nFix en cours sur la branche `fix/PROJ-1421`." },
    ],
  },
  {
    key: 'PROJ-1408', summary: 'Ajouter le paiement en 3× sans frais', type: 'Story', typeIcon: '',
    sprints: [{ v: '42', l: 'Sprint 42' }],
    epic: { key: 'PROJ-1100', summary: 'Fiabiliser le tunnel de commande', color: 'purple' },
    status: 'À faire', statusCategory: 'new', priority: 'Moyenne',
    assignee: { accountId: 'me-001', name: 'Toi (démo)', email: 'toi@demo', avatar: '' },
    reporter: { name: 'Product Owner', email: 'po@demo', avatar: '' },
    project: 'PROJ — Boutique en ligne', labels: ['paiement'],
    created: '2026-07-10T10:00:00.000+0000', updated: '2026-07-22T11:20:00.000+0000',
    duedate: '', components: ['api'], fixVersions: ['2.5.0'],
    descriptionMd: "En tant que **client**, je veux payer en **3× sans frais** pour les commandes > 100 €.\n\n- Intégrer le partenaire de paiement\n- Afficher l'échéancier avant validation",
    comments: [
      { author: 'Product Owner', created: '2026-07-22T11:20:00.000+0000', bodyMd: 'Priorité confirmée pour le sprint prochain.' },
    ],
  },
  {
    key: 'PROJ-1390', summary: 'Migrer les logs vers le nouveau format JSON', type: 'Tâche', typeIcon: '',
    sprints: [{ v: '43', l: 'Sprint 43' }],
    epic: { key: 'PROJ-1050', summary: 'Observabilité : logs et métriques', color: 'blue' },
    status: 'En revue', statusCategory: 'indeterminate', priority: 'Basse',
    assignee: { accountId: 'usr-002', name: 'Alex Martin', email: 'alex@demo', avatar: '' },
    reporter: { name: 'Toi (démo)', email: 'toi@demo', avatar: '' },
    project: 'PROJ — Plateforme', labels: ['observabilité', 'dette-technique'],
    created: '2026-07-02T14:00:00.000+0000', updated: '2026-07-20T09:00:00.000+0000',
    duedate: '', components: [], fixVersions: [],
    descriptionMd: 'Uniformiser tous les logs applicatifs au format JSON structuré (clé `level`, `msg`, `ts`).',
    comments: [],
  },
];

const DONE = [
  {
    key: 'PROJ-1375', summary: 'Corriger le tri des commandes par date', type: 'Bug', typeIcon: '',
    status: 'Terminé', statusCategory: 'done', priority: 'Moyenne',
    assignee: { accountId: 'usr-003', name: 'Sam Durand', email: 'sam@demo', avatar: '' },
    reporter: { name: 'QA', email: 'qa@demo', avatar: '' },
    project: 'PROJ — Boutique en ligne', labels: ['commandes'],
    created: '2026-06-20T09:00:00.000+0000', updated: '2026-07-01T15:30:00.000+0000',
    duedate: '', components: ['web'], fixVersions: ['2.3.1'],
    descriptionMd: 'Le tri par date utilisait le format texte au lieu de la date réelle.',
    comments: [{ author: 'QA', created: '2026-07-01T15:30:00.000+0000', bodyMd: 'Vérifié, tri correct. Je ferme.' }],
  },
];

const meta = (i) => {
  const { descriptionMd, comments, attachments, ...m } = i; // la liste ne porte pas ces 3-là
  // L'epic porte SA propre URL, comme en réel : c'est ce qui le rend cliquable.
  const epic = m.epic ? { ...m.epic, url: `https://jira.demo/browse/${m.epic.key}` } : null;
  // Même forme qu'en réel : la CLÉ du projet à part, c'est elle qui sert de valeur de filtre.
  const projectKey = String(m.project || '').split(' ')[0];
  return { ...m, epic, projectKey, url: `https://jira.demo/browse/${i.key}` };
};

const ME = { accountId: 'me-001', name: 'Toi (démo)', email: 'toi@demo', avatar: '' };
const PEOPLE = [
  ME,
  { accountId: 'usr-002', name: 'Alex Martin', email: 'alex@demo', avatar: '' },
  { accountId: 'usr-003', name: 'Sam Durand', email: 'sam@demo', avatar: '' },
];

// Filtre par assigné : « moi » + les collègues (démo).
function assignees() { return { me: ME, people: PEOPLE }; }

// Tickets des personnes cochées (accountIds) ; vide → mes tickets.
function tickets(accountIds, includeDone, projects = [], sprints = []) {
  // Vide = aucune contrainte d'assigné (même règle qu'en réel), pas « mes tickets ».
  const set = (accountIds && accountIds.length) ? new Set(accountIds) : null;
  const tous = includeDone ? [...ISSUES, ...DONE] : ISSUES;
  let list = set ? tous.filter((i) => i.assignee && set.has(i.assignee.accountId)) : tous;
  // Même règle qu'en réel : les projets choisis filtrent la requête, pas son résultat.
  if (projects && projects.length) {
    const cles = new Set(projects);
    list = list.filter((i) => cles.has(String(i.project || '').split(' ')[0]));
  }
  if (sprints && sprints.length) {
    const ids = new Set(sprints.map(String));
    list = list.filter((i) => (i.sprints || []).some((sp) => ids.has(String(sp.v))));
  }
  return { issues: list.map(meta), total: list.length };
}

// Transitions (changements d'état) proposées en démo.
const DEMO_TRANSITIONS = [
  { id: '11', name: 'À faire', to: { name: 'À faire', statusCategory: 'new' } },
  { id: '21', name: 'En cours', to: { name: 'En cours', statusCategory: 'indeterminate' } },
  { id: '31', name: 'En revue', to: { name: 'En revue', statusCategory: 'indeterminate' } },
  { id: '41', name: 'Terminé', to: { name: 'Terminé', statusCategory: 'done' } },
];

function issue(key) {
  const found = [...ISSUES, ...DONE].find((i) => i.key === key) || ISSUES[0];
  return { ...meta(found), descriptionMd: found.descriptionMd, comments: found.comments, attachments: found.attachments || [], transitions: DEMO_TRANSITIONS };
}

/* Appliquer une transition en démo : on modifie l'état EN MÉMOIRE. Sans ça, changer le statut
   d'un ticket ne tenait pas — la liste se rechargeait sur l'ancien état, et le compteur du menu
   ne bougeait jamais. Une démo qui accepte une action sans la refléter enseigne le contraire de
   ce que fait l'outil. L'effet dure le temps du processus, ce qui suffit à une démonstration. */
function applyTransition(key, transitionId) {
  const cible = DEMO_TRANSITIONS.find((tr) => String(tr.id) === String(transitionId));
  const found = [...ISSUES, ...DONE].find((i) => i.key === key);
  if (!cible || !found) return { ok: false };
  found.status = cible.to.name;
  found.statusCategory = cible.to.statusCategory;
  return { ok: true, status: found.status };
}

// Contenu FICTIF d'une pièce jointe (démo) : le vrai viendrait de Jira via le proxy. Pour une
// image, on renvoie une SVG placeholder → l'aperçu inline s'affiche vraiment en démo.
function attachmentFile(id) {
  const meta = [...ISSUES, ...DONE].flatMap((i) => i.attachments || []).find((a) => String(a.id) === String(id));
  if (meta && /^image\//.test(meta.mimeType || '')) {
    const name = String(meta.filename || 'image').replace(/[<>&]/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="100%" height="100%" fill="#cfe0f2"/><text x="50%" y="46%" font-family="sans-serif" font-size="18" fill="#3a5a80" text-anchor="middle">${name}</text><text x="50%" y="60%" font-family="sans-serif" font-size="13" fill="#6a86a8" text-anchor="middle">(aperçu démo)</text></svg>`;
    return { filename: meta.filename, mimeType: 'image/svg+xml', buffer: Buffer.from(svg) };
  }
  return { filename: (meta && meta.filename) || `piece-jointe-demo-${id}.txt`, mimeType: 'text/plain', buffer: Buffer.from('(démo) contenu factice — en réel, le fichier est récupéré depuis Jira avec le token.') };
}

/* Compteur du menu en démo : les tickets qui me sont affectés ET en cours. Calculé sur le
   jeu fictif plutôt qu'écrit en dur, pour qu'il reste juste si on retouche les tickets. */
function inProgressMine() {
  return ISSUES.filter((i) => i.statusCategory === 'indeterminate'
    && i.assignee && i.assignee.accountId === 'me-001').length;
}

const issueUrl = (key) => `https://jira.demo/browse/${key}`;

module.exports = { assignees, tickets, issue, attachmentFile, inProgressMine, applyTransition, issueUrl };
