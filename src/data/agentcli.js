'use strict';
/* LES AUTRES BINAIRES D'AGENT DE CE POSTE (`agent_cli`) — voir la tranche de schéma 13.
   Le DÉFAUT vit dans `local_config` (`agent_bin`, `agent_args`, `agent_env`, `agent_timeout_ms`,
   `agent_backend`, `agent_name`) ; une ligne d'ici est un profil COMPLET, qui le remplace en bloc
   pour la session qui l'a choisi. `utiliserParDefaut` échange une ligne avec le défaut : le
   défaut d'hier devient un profil nommé, le profil choisi devient le défaut — et la preuve de
   sandbox tombe avec le changement de binaire, comme pour toute modification d'`agent_bin`. */
const db = require('../db');
const { t } = require('../core/i18n');
const config = require('./config');

const COLONNES = 'id, name, bin, args, env, timeout_ms, backend, created_at, updated_at';

function lister() {
  return db.prepare(`SELECT ${COLONNES} FROM agent_cli ORDER BY name COLLATE NOCASE`).all();
}
function parId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return db.prepare(`SELECT ${COLONNES} FROM agent_cli WHERE id = ?`).get(n) || null;
}

/* Ce qu'une ligne accepte, avec les MÊMES règles que le défaut : le nom et le binaire sont
   requis, les variables suivent `NOM=valeur` sans `MERGERIE_*`, le délai est borné, le backend
   est un identifiant connu. `courant` : la ligne éditée, dont on garde ce que le corps tait. */
function lire(body, courant) {
  const b = body || {};
  const champ = (k) => (b[k] != null ? String(b[k]) : ((courant && courant[k]) || ''));
  const name = champ('name').trim().slice(0, 60);
  if (!name) throw new Error(t('err.cli.name-required'));
  const bin = champ('bin').trim();
  if (!bin) throw new Error(t('err.cli.bin-required'));
  const backend = champ('backend').trim() || 'auto';
  if (!config.BACKENDS_AGENT.includes(backend)) throw new Error(t('err.cli.backend', { backend }));
  return {
    name, bin,
    args: champ('args').trim(),
    env: config.normaliserEnvAgent(champ('env')),
    timeout_ms: config.normaliserDelaiAgent(b.timeout_ms != null ? b.timeout_ms : (courant ? courant.timeout_ms : 0)),
    backend,
  };
}
function nomPris(name, saufId) {
  const r = db.prepare('SELECT id FROM agent_cli WHERE name = ? COLLATE NOCASE').get(name);
  return r && r.id !== saufId;
}
function creer(body) {
  const v = lire(body, null);
  if (nomPris(v.name, null)) throw new Error(t('err.cli.name-taken', { name: v.name }));
  const now = new Date().toISOString();
  const id = db.prepare(`INSERT INTO agent_cli (name, bin, args, env, timeout_ms, backend, created_at, updated_at)
    VALUES (@name, @bin, @args, @env, @timeout_ms, @backend, @now, @now)`).run({ ...v, now }).lastInsertRowid;
  return parId(id);
}
function modifier(id, body) {
  const courant = parId(id);
  if (!courant) throw new Error(t('err.cli.not-found'));
  const v = lire(body, courant);
  if (nomPris(v.name, courant.id)) throw new Error(t('err.cli.name-taken', { name: v.name }));
  db.prepare(`UPDATE agent_cli SET name = @name, bin = @bin, args = @args, env = @env, timeout_ms = @timeout_ms,
    backend = @backend, updated_at = @now WHERE id = @id`).run({ ...v, now: new Date().toISOString(), id: courant.id });
  /* Le nom d'hier reste sur les sessions qui l'ont choisi (`cli_name` est une photo) ; celles
     qui pointent encore la ligne prennent le nouveau — c'est le même profil. */
  db.prepare('UPDATE task SET cli_name = ? WHERE cli_id = ?').run(v.name, courant.id);
  db.prepare('UPDATE local_task SET cli_name = ? WHERE cli_id = ?').run(v.name, courant.id);
  return parId(courant.id);
}
function supprimer(id) {
  const courant = parId(id);
  if (!courant) throw new Error(t('err.cli.not-found'));
  // `ON DELETE SET NULL` : une session qui l'avait choisi retombe sur le défaut, son nom reste.
  db.prepare('DELETE FROM agent_cli WHERE id = ?').run(courant.id);
}

/* LE DÉFAUT, vu comme un profil : ce que le sélecteur d'une session affiche en première ligne. */
function defaut() {
  const c = config.getConfig();
  const bin = String(c.agent_bin || '').trim() || String(process.env.AGENT_BIN || process.env.COPILOT_BIN || '').trim();
  const name = String(c.agent_name || '').trim() || (bin ? bin.split(/[\\/]/).pop() : 'copilot');
  return { id: null, name, bin, args: String(c.agent_args || ''), env: String(c.agent_env || ''), timeout_ms: Number(c.agent_timeout_ms) || 0, backend: String(c.agent_backend || 'auto') };
}

/* « UTILISER PAR DÉFAUT » : l'échange. La ligne prend les valeurs du défaut (et son nom, ou le
   nom de son binaire s'il n'en avait pas), le défaut prend celles de la ligne. Les sessions qui
   pointaient la ligne pointent donc maintenant l'ANCIEN défaut — c'est voulu : un choix explicite
   reste un choix explicite, seul le sans-choix change de binaire. */
function utiliserParDefaut(id) {
  const ligne = parId(id);
  if (!ligne) throw new Error(t('err.cli.not-found'));
  const ancien = defaut();
  let nom = String(config.getConfig().agent_name || '').trim() || ancien.name;
  if (nomPris(nom, ligne.id)) nom = `${nom} (${t('settings.cli.former-default')})`;
  db.transaction(() => {
    db.prepare(`UPDATE agent_cli SET name = ?, bin = ?, args = ?, env = ?, timeout_ms = ?, backend = ?, updated_at = ? WHERE id = ?`)
      .run(nom, ancien.bin, ancien.args, ancien.env, ancien.timeout_ms, ancien.backend, new Date().toISOString(), ligne.id);
    db.prepare('UPDATE task SET cli_name = ? WHERE cli_id = ?').run(nom, ligne.id);
    db.prepare('UPDATE local_task SET cli_name = ? WHERE cli_id = ?').run(nom, ligne.id);
    config.updateConfig({
      agent_bin: ligne.bin, agent_args: ligne.args, agent_env: ligne.env, agent_timeout_ms: ligne.timeout_ms,
      agent_backend: ligne.backend, agent_name: ligne.name,
    });
  })();
  return { defaut: defaut(), profil: parId(ligne.id) };
}

module.exports = { lister, parId, creer, modifier, supprimer, defaut, utiliserParDefaut };
