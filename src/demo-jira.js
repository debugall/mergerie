'use strict';
/* Données Jira FICTIVES du mode démo (npm run demo) : tickets « affectés », détail +
   commentaires. Séquence FIXE (pas de Date/random) pour rester déterministe. */

const ISSUES = [
  {
    key: 'PROJ-1421', summary: 'Le panier perd les articles après reconnexion', type: 'Bug', typeIcon: '',
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
  return { ...m, url: `https://jira.demo/browse/${i.key}` };
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
function tickets(accountIds, includeDone) {
  const set = (accountIds && accountIds.length) ? new Set(accountIds) : new Set([ME.accountId]);
  const list = (includeDone ? [...ISSUES, ...DONE] : ISSUES).filter((i) => i.assignee && set.has(i.assignee.accountId));
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

module.exports = { assignees, tickets, issue, attachmentFile };
