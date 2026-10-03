'use strict';
/* La palette Ctrl+K (le « lanceur ») : ce que le serveur sait chercher, sa frécence, son flou.
 *
 * Elle sert tous les écrans — merge requests, sessions, notes, vérificateurs, commandes git, agents — et les entrées que
 * les plugins ajoutent (`ctx.ui.registerPaletteProvider`) la rejoignent dans `app/routes/launcher.js`. Les liens de
 * travail, qui en étaient la première source, sont l'affaire du plugin `links`, qui calcule les siens avec la même
 * frécence (`uses / (1 + jours)` : un compteur seul ferait remonter à vie ce qu'on a beaucoup ouvert le mois dernier,
 * une date seule perdrait ce qu'on ouvre chaque jour depuis un an).
 *
 * Ce module ne contient QUE de la logique et des requêtes : pas de route, pas de rendu. */

const db = require('../db');

const JOUR_MS = 24 * 60 * 60 * 1000;
const nowIso = () => new Date().toISOString();

/* ---------------------------------------------------------- frécence ---- */

/* `uses / (1 + jours depuis le dernier usage)`. Assez simple pour se relire, assez juste
   pour que ce qu'on ouvre chaque matin passe devant ce qu'on a ouvert vingt fois en mars. */
function frecence(row, maintenant = Date.now()) {
  if (!row) return 0;
  const jours = Math.max(0, (maintenant - new Date(row.last_used_at).getTime()) / JOUR_MS);
  return (row.uses || 0) / (1 + jours);
}

function noterUsage(kind, ref) {
  const k = String(kind || '').slice(0, 40);
  const r = String(ref == null ? '' : ref).slice(0, 200);
  if (!k || !r) return { ok: false };
  db.prepare(`INSERT INTO launcher_usage (kind, ref, uses, last_used_at) VALUES (?,?,1,?)
    ON CONFLICT(kind, ref) DO UPDATE SET uses = uses + 1, last_used_at = excluded.last_used_at`)
    .run(k, r, nowIso());
  return { ok: true };
}

const usages = () => {
  const m = new Map();
  for (const u of db.prepare('SELECT * FROM launcher_usage').all()) m.set(`${u.kind}:${u.ref}`, u);
  return m;
};

/* ------------------------------------------------------- fuzzy match ---- */

const sansAccent = (s) => String(s == null ? '' : s)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/* LA MÊME FONCTION, CÔTÉ SQL. Le pré-filtre de la palette compare la requête — déjà dénudée
   de ses accents — à des valeurs qui, elles, les ont gardés : sans ça, `LIKE '%generation%'`
   ne trouvait pas « Génération du rapport », et le taper AVEC l'accent échouait tout autant,
   puisque la requête est dénudée avant la comparaison. Dans une application dont les titres
   de merge requests, de notes et de todos sont largement en français, cela revenait à ne plus
   rien trouver. Elle est enregistrée ici, à côté de sa jumelle en JavaScript : les deux côtés
   du `LIKE` doivent normaliser pareil, et une seule définition ne peut pas dériver. */
db.function('sans_accent', { deterministic: true }, (v) => (v == null ? null : sansAccent(v)));

/* Chaque mot de la requête doit se retrouver dans la cible, en SOUS-SÉQUENCE : « kib pre »
   trouve « Kibana · preprod ». On note mieux ce qui commence un mot — taper « api » doit
   remonter « api-core » avant « rapidité », qui contient pourtant les mêmes lettres. */
function scoreFuzzy(texte, requete) {
  const cible = sansAccent(texte);
  const mots = sansAccent(requete).split(/\s+/).filter(Boolean);
  if (!mots.length) return 1;
  let total = 0;
  for (const mot of mots) {
    const exact = cible.indexOf(mot);
    if (exact >= 0) {
      const debutDeMot = exact === 0 || /[^a-z0-9]/.test(cible[exact - 1]);
      total += debutDeMot ? 3 : 2;
      continue;
    }
    /* Sous-séquence : les lettres dans l'ordre, pas forcément contiguës — mais PROCHES.
       Sans contrainte d'étalement, « api » se retrouve dans presque n'importe quelle phrase
       française (formAt, Point, archI) et la palette se remplit de faux positifs qui
       chassent les vrais. On exige que les lettres tiennent dans une fenêtre de quatre fois
       la longueur du mot : « kib » trouve « Kibana », pas « quelque chose bien ». */
    let i = 0;
    let debut = -1;
    let fin = -1;
    for (let k = 0; k < cible.length && i < mot.length; k += 1) {
      if (cible[k] !== mot[i]) continue;
      if (debut < 0) debut = k;
      fin = k;
      i += 1;
    }
    if (i < mot.length) return 0;              // un mot absent = pas de résultat
    if (fin - debut > mot.length * 4) return 0;
    total += 1;
  }
  return total / mots.length;
}

/* ------------------------------------------------- palette (launcher) ---- */

/* Toutes les sources en SQL, à la demande — aucun index en mémoire à tenir à jour, donc rien
   à réconcilier quand une MR arrive ou qu'une note change.

   LE PRÉ-FILTRE EST EN SQL, ET C'EST LE POINT. Chaque source est plafonnée pour qu'un dépôt à
   mille merge requests ne noie pas les liens que la palette existe pour retrouver. Mais tant
   que ce plafond s'appliquait AVANT la recherche, il ne rendait que les lignes les plus
   récentes et le flou ne voyait jamais les autres : taper `!214` sur une merge request un peu
   ancienne ne rendait RIEN, sans un mot — de quoi conclure que la palette est cassée.

   D'où un `LIKE` par mot, en SQL : grossier, mais il ne laisse rien de côté. Le flou affine
   ensuite sur ce qui reste, et le plafond redevient ce qu'il aurait toujours dû être — un
   garde-fou contre une réponse démesurée, pas un filtre sur ce qui est cherchable. */
const PAR_SOURCE = 30;
const TOTAL = 12;

/* Une condition SQL par mot de la requête, chacun pouvant tomber dans n'importe laquelle des
   colonnes citées. Rend `{ cond, args }` — `cond` vide quand il n'y a pas de requête, la
   palette s'ouvrant alors sur les entrées les plus récentes.
   Le `%` et le `_` d'une saisie sont ÉCHAPPÉS : sans cela, taper « % » ramènerait tout.
   CONTIGU PAR MOT, ET C'EST DÉLIBÉRÉ. Le flou accepte les lettres d'un mot à trous (« kbana »
   pour « Kibana ») ; le pré-filtre, non — il exige le fragment entier. Le traduire fidèlement
   donnerait `%k%b%a%n%a%` ; mesuré sur mille titres de merge requests en français, « pre »
   toucherait alors 622 lignes au lieu de 190, et le plafond par source recouperait AVANT que
   la contrainte d'étalement du flou n'ait pu trier — soit exactement le défaut que ce
   pré-filtre existe pour corriger. On abrège donc par MOTS (« kib pre » trouve
   « Kibana · preprod », chaque mot étant un fragment), pas en sautant des lettres. */
function preFiltre(requete, colonnes) {
  const mots = sansAccent(requete).split(/\s+/).filter(Boolean);
  if (!mots.length) return { cond: '', args: [] };
  const args = [];
  const groupes = mots.map((mot) => {
    const like = `%${mot.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const ors = colonnes.map((c) => { args.push(like); return `sans_accent(${c}) LIKE ? ESCAPE '\\'`; });
    return `(${ors.join(' OR ')})`;
  });
  return { cond: groupes.join(' AND '), args };
}

/* `agentsMsgs` : les deux libellés d'agent, déjà traduits par l'appelant. Ce module ne charge
   PAS `i18n-runtime` — il utilise `t` comme nom de variable locale à trois endroits, et le
   garde-fou de `check-server` refuse (à raison) qu'un fichier qui traduit masque `t`. */
function launcher(q, { jiraConfigure = false, actions = [], agentsMsgs = null, msgs = {} } = {}) {
  const requete = String(q || '').trim();
  const use = usages();
  const out = [];
  const pousser = (o) => out.push(o);

  /* 2. Merge requests — par NUMÉRO ou par mots du titre. Le numéro passe par une égalité et
     non par un `LIKE` : `!214` ne se retrouve ni dans un titre ni dans un nom de projet, et
     c'est pourtant la façon la plus courante de désigner une merge request. */
  /* B13 — …ET PAR SA CLÉ DE TICKET. « PROJ-1408 » est la façon dont la moitié d'une équipe
     désigne un travail : elle ne trouvait rien ici alors que la colonne est remplie par la
     découverte depuis longtemps. */
  const fMr = preFiltre(requete, ['m.title', 'p.project', 'm.ticket_jira_key']);
  const iid = parseInt(String(requete).replace(/^!/, ''), 10);
  const parNum = Number.isFinite(iid);
  const condMr = fMr.cond
    ? (parNum ? `WHERE (m.iid = ? OR (${fMr.cond}))` : `WHERE ${fMr.cond}`)
    : '';
  const argsMr = condMr ? (parNum ? [iid, ...fMr.args] : fMr.args) : [];
  for (const r of db.prepare(`SELECT m.id, m.iid, m.title, m.status, m.ticket_jira_key, p.project FROM mr m
      JOIN repo p ON p.id = m.repo_id ${condMr} ORDER BY m.id DESC LIMIT ?`)
    .all(...argsMr, PAR_SOURCE * 3)) {
    pousser({
      kind: 'mr', ref: String(r.id), group: 'mrs',
      label: `!${r.iid} — ${r.title || ''}`, detail: r.project,
      // `mr_iid` : le NUMÉRO tel qu'on le tape — la palette y saute directement (« !217 »).
      nav: { tab: 'review', mr_id: r.id, mr_iid: r.iid, status: r.status },
      texte: `!${r.iid} ${r.iid} ${r.title || ''} ${r.project} ${r.ticket_jira_key || ''}`,
    });
  }

  // 3. Tickets surveillés — la seule liste de tickets que le serveur connaisse hors ligne.
  if (jiraConfigure) {
    const fTicket = preFiltre(requete, ['key', 'summary']);
    for (const r of db.prepare(`SELECT * FROM jira_watch ${fTicket.cond ? `WHERE ${fTicket.cond}` : ''}
        ORDER BY key LIMIT ?`).all(...fTicket.args, PAR_SOURCE)) {
      pousser({
        kind: 'ticket', ref: r.key, group: 'tickets',
        label: `${r.key} — ${r.summary || ''}`, detail: r.status || '',
        nav: { tab: 'jira', ticket: r.key },
        texte: `${r.key} ${r.summary || ''}`,
      });
    }
  }

  // 4. Pages de notes et todos ouvertes.
  const fNote = preFiltre(requete, ['title']);
  for (const r of db.prepare(`SELECT id, title FROM note_page ${fNote.cond ? `WHERE ${fNote.cond}` : ''}
      ORDER BY updated_at DESC LIMIT ?`).all(...fNote.args, PAR_SOURCE)) {
    pousser({
      kind: 'note', ref: String(r.id), group: 'notes',
      label: r.title, detail: '', nav: { tab: 'notes', page_id: r.id }, texte: r.title,
    });
  }
  const fTodo = preFiltre(requete, ['title']);
  for (const r of db.prepare(`SELECT id, title FROM todo
      WHERE status = 'open' AND archived_at IS NULL ${fTodo.cond ? `AND (${fTodo.cond})` : ''}
      ORDER BY id DESC LIMIT ?`).all(...fTodo.args, PAR_SOURCE)) {
    pousser({
      kind: 'todo', ref: String(r.id), group: 'notes',
      label: r.title, detail: '', nav: { tab: 'notes', todo_id: r.id }, texte: r.title,
    });
  }

  // 5. Sessions de dev — retrouvées par leur libellé, leur prompt ou leur branche.
  const fTask = preFiltre(requete, ['label', 'prompt', 'branch']);
  for (const r of db.prepare(`SELECT id, kind, label, prompt, branch FROM task
      ${fTask.cond ? `WHERE ${fTask.cond}` : ''} ORDER BY id DESC LIMIT ?`).all(...fTask.args, PAR_SOURCE)) {
    const titre = (r.label || r.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 70);
    pousser({
      kind: 'task', ref: String(r.id), group: 'tasks',
      label: titre || r.branch, detail: r.branch || '',
      nav: { tab: 'task', task_id: r.id, task_kind: r.kind || 'code' },
      texte: `${r.label || ''} ${r.prompt || ''} ${r.branch || ''}`,
    });
  }

  /* B13/TOP 12 — LA PALETTE AGIT, elle ne fait plus seulement naviguer. Quatre objets du
     quotidien n'y étaient pas, et chacun se cherchait à la souris : un vérificateur, un job
     de CI (par son plugin), un projet compose, une commande git enregistrée. Le principe ne change pas — la
     palette ne sait rien faire que l'écran ne sache déjà faire, elle emmène au bon endroit et
     clique le vrai bouton. */
  const fVerif = preFiltre(requete, ['name']);
  for (const r of db.prepare(`SELECT id, name FROM verifier
      ${fVerif.cond ? `WHERE ${fVerif.cond}` : ''} ORDER BY name LIMIT ?`).all(...fVerif.args, PAR_SOURCE)) {
    pousser({
      kind: 'verifier', ref: String(r.id), group: 'actions',
      label: String(msgs.verify || '{name}').replace('{name}', r.name), detail: '',
      nav: { verifier_id: r.id },
      texte: `${r.name} verifier verification`,
    });
  }
  const fCmd = preFiltre(requete, ['label', 'command']);
  for (const r of db.prepare(`SELECT id, label, command FROM git_command
      ${fCmd.cond ? `WHERE ${fCmd.cond}` : ''} ORDER BY sort_order, id LIMIT ?`).all(...fCmd.args, PAR_SOURCE)) {
    pousser({
      kind: 'gitcmd', ref: String(r.id), group: 'actions',
      label: String(msgs.gitcmd || '{label}').replace('{label}', r.label), detail: `git ${r.command}`,
      nav: { git_command: r.command },
      texte: `${r.label} git ${r.command}`,
    });
  }

  // 6. Navigation et actions — fournies par le client, qui seul sait ce qu'il sait faire.
  for (const a of actions) {
    pousser({ kind: 'nav', ref: a.id, group: 'nav', label: a.label, detail: '', action: a.id, texte: a.label });
  }

  /* 7. Les AGENTS. « Demander à l'enquêteur » se tapait en trois gestes : onglet Agents, la
     bonne carte, le bouton. La palette est l'endroit où l'on va quand on sait ce qu'on veut. */
  const fAg = preFiltre(requete, ['name', 'description']);
  if (agentsMsgs) {
    for (const a of db.prepare(`SELECT id, name, description, builtin_key FROM agent
        ${fAg.cond ? `WHERE ${fAg.cond}` : ''} ORDER BY name LIMIT ?`).all(...fAg.args, PAR_SOURCE)) {
      pousser({
        kind: 'agent', ref: String(a.id), group: 'agents',
        label: String(agentsMsgs.ask || '{name}').replace('{name}', a.name), detail: a.description || '', id: a.id,
        texte: `${a.name} ${a.description || ''}`,
      });
      /* L'enquêteur a une SECONDE entrée : « enquêter sur une trace » est le geste, pas le nom
         de l'agent — et c'est sous ce mot qu'on le cherche quand une trace vient d'arriver. */
      if (a.builtin_key === 'investigator') {
        pousser({
          kind: 'agent-investigate', ref: String(a.id), group: 'agents',
          label: agentsMsgs.investigate || '', detail: a.name, id: a.id,
          texte: `${agentsMsgs.investigate || ''} ${a.name} trace erreur incident stack`,
        });
      }
    }
  }

  /* PALETTE OUVERTE, RIEN DE TAPÉ : on ne rend pas « les douze premiers de tout ». Sans
     requête, le score de correspondance est le même partout et c'est la source la plus
     nombreuse — les liens de la grille — qui prend les douze places : on ouvrait la palette
     sur huit URL Kibana, aucune merge request, aucune session, alors que tout cela se trouve
     dès qu'on tape une lettre. On propose donc un ÉCHANTILLON des trois choses qu'on vient
     y chercher, trois de chaque, dans un ordre fixe. */
  if (!requete) {
    const parGroupe = (g, n) => out.filter((o) => o.group === g)
      .sort((a, b) => frecence(use.get(`${b.kind}:${b.ref}`)) - frecence(use.get(`${a.kind}:${a.ref}`)))
      .slice(0, n);
    return [...parGroupe('nav', 3), ...parGroupe('mrs', 3), ...parGroupe('tasks', 3)]
      .map(({ texte, ...reste }) => reste);
  }

  const notes = out.map((o) => {
    const s = scoreFuzzy(o.texte, requete);
    return { o, s, f: frecence(use.get(`${o.kind}:${o.ref}`)) };
  }).filter((x) => x.s > 0);

  /* Score de match MULTIPLIÉ par la frécence : un résultat qu'on n'a jamais ouvert reste
     accessible (facteur 1), et celui qu'on ouvre tous les jours passe devant à match égal. */
  notes.sort((a, b) => (b.s * (1 + b.f)) - (a.s * (1 + a.f)));
  return notes.slice(0, TOTAL).map((x) => {
    const { texte, ...reste } = x.o;
    return reste;
  });
}

module.exports = { frecence, noterUsage, scoreFuzzy, launcher };
