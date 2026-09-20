'use strict';
/* Les répertoires locaux (Réglages → Dépôts · Git → Navigation · codage hors dépôt). */
/* ---- Répertoires locaux (Réglages → Dépôts · Git → Navigation · codage hors dépôt) ----
   Un répertoire local = un dossier de la machine contenant un sous-dossier par projet
   git. La liste des projets se relit du DISQUE : on ne la garde en cache que le temps
   d'un écran, sinon un dépôt cloné entre deux visites resterait invisible. */
let localRoots = [];
const localProjectsCache = new Map();

async function loadLocalRoots() {
  try { localRoots = await api('/local-roots'); } catch { localRoots = []; }
  return localRoots;
}
// Le chemin reste visible même quand un nom court est donné : deux dossiers « front »
// dans deux arborescences différentes seraient sinon indiscernables dans la liste.
const rootLabel = (r) => (r.label ? `${r.label} — ${r.path}` : r.path);

async function localProjectsOf(rootId) {
  const key = String(rootId);
  let entry = localProjectsCache.get(key);
  if (!entry) {
    // On mémoïse la PROMESSE (focus puis frappe ouvrent la liste deux fois de suite),
    // puis on lui substitue le résultat : la branche courante d'un projet se lit alors
    // sans attendre, depuis le même cache.
    entry = api(`/local-roots/${rootId}/projects`).then((d) => {
      const list = d.projects || [];
      localProjectsCache.set(key, list);
      return list;
    });
    localProjectsCache.set(key, entry);
  }
  try { return await entry; }
  catch (e) { localProjectsCache.delete(key); throw e; }   // un échec ne se fige pas en cache
}
// Branche courante d'un projet, telle que le dernier listing l'a vue (le cache vient
// d'être rempli par le sélecteur : pas d'appel supplémentaire pour une seule colonne).
function localProjectBranch(rootId, name) {
  const cached = localProjectsCache.get(String(rootId));
  if (!cached || typeof cached.then === 'function') return '';
  const p = cached.find((x) => x.name === name);
  return (p && p.branch) || '';
}

/* La dernière branche de DÉPART retenue par dépôt. Confort pur : perdre ce stockage ne fait
   perdre que la proposition, jamais une session. */
const BASE_MEMO = 'aidevtools_session_base';
const memoBaseSession = () => { try { return JSON.parse(localStorage.getItem(BASE_MEMO) || '{}'); } catch { return {}; } };
function memoriserBaseSession(lignes) {
  try {
    const m = memoBaseSession();
    for (const t of lignes) if (t.repo_id && t.base_branch) m[t.repo_id] = t.base_branch;
    localStorage.setItem(BASE_MEMO, JSON.stringify(m));
  } catch { /* stockage indisponible : on perd le confort, pas la fonction */ }
}

