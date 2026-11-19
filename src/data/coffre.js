'use strict';
/* LE COFFRE DES JETONS (Réglages → Sécurité).

   Inactif — le défaut —, rien ne change : les jetons de la forge, de Jira, de Confluence vivent en clair
   dans `local_config`, ceux des plugins dans `plugin_secret`. Actif, ces deux endroits sont VIDÉS et tout
   part dans la table `coffre`, chiffré en AES-256-GCM par une clé que scrypt dérive du mot de passe
   maître. La clé n'est jamais écrite : elle vit dans ce module, de la saisie du mot de passe à l'arrêt
   du processus (ou à « Verrouiller maintenant »). Ce que ça protège : une COPIE du fichier — sauvegarde,
   dossier de données partagé pour un débogage, disque volé. Ce que ça ne protège pas : un programme qui
   tourne sous le même compte pendant que Mergerie est déverrouillé (la section Sécurité du guide le dit).

   Verrouillé, les lectures rendent des jetons VIDES et les écritures sont refusées : rien ne peut écraser
   le contenu du coffre faute de l'avoir lu. Le serveur, lui, ne sert que la page de connexion
   (`app/middleware/coffre.js`) et ne démarre ses tâches de fond qu'au déverrouillage.

   La 2FA est un TOTP (RFC 6238 : HMAC-SHA1, six chiffres, pas de trente secondes) : son secret est DANS le
   contenu chiffré, il ne se lit qu'avec le bon mot de passe. Elle ferme la porte à qui connaît le mot de
   passe sans avoir le téléphone ; elle n'ajoute rien au chiffrement d'une copie du fichier. */
const crypto = require('crypto');
const db = require('../db');
const { t } = require('../core/i18n');

const SECRETS_COEUR = ['access_token', 'github_token', 'jira_token', 'confluence_token'];
const MDP_MIN = 8;
/* N = 2^17 : ~0,3 s et 128 Mio par dérivation — le prix d'un essai pour qui a copié le fichier. */
const KDF = { N: 131072, r: 8, p: 1 };
const PHRASES = ['je confirme', 'i confirm'];

let cle = null;       // Buffer de 32 octets, ou null : verrouillé (ou coffre inactif)
let contenu = null;   // { coeur: {}, plugins: { nom: { cle: valeur } }, totp: '' }
let totpEnAttente = null;   // le secret montré à l'activation de la 2FA, en attente du premier code
let dernierPasTotp = -1;    // un code ne sert qu'une fois
let echecs = 0; let bloqueJusqua = 0;
let ressaisir = false;      // vient d'être réinitialisé : l'écran ouvre les réglages pour ressaisir
const ecouteurs = { deverrouillage: [], verrouillage: [] };

const erreur = (cle_, params, status = 400) => Object.assign(new Error(t(`err.vault.${cle_}`, params)), { status, code: `VAULT_${cle_.toUpperCase().replace(/-/g, '_')}` });
const ligne = () => db.prepare('SELECT * FROM coffre WHERE id = 1').get() || { actif: 0, totp: 0 };
const actif = () => ligne().actif === 1;
const verrouille = () => actif() && !cle;
function etat() {
  const l = ligne();
  return { actif: l.actif === 1, verrouille: l.actif === 1 && !cle, totp: l.actif === 1 && l.totp === 1, ressaisir };
}

/* ---------- Chiffrement ---------- */
function deriver(mdp, sel, kdf) {
  const p = { ...KDF, ...(kdf || {}) };
  return crypto.scryptSync(String(mdp), sel, 32, { N: p.N, r: p.r, p: p.p, maxmem: 256 * 1024 * 1024 });
}
function chiffrer(k, objet) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const donnees = Buffer.concat([c.update(JSON.stringify(objet), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), donnees: donnees.toString('base64') };
}
/** Le contenu, ou null si la clé n'est pas la bonne (l'étiquette GCM ne passe pas). */
function dechiffrer(k, l) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(l.iv, 'base64'));
    d.setAuthTag(Buffer.from(l.tag, 'base64'));
    const brut = Buffer.concat([d.update(Buffer.from(l.donnees, 'base64')), d.final()]).toString('utf8');
    const o = JSON.parse(brut);
    return { coeur: o.coeur || {}, plugins: o.plugins || {}, totp: o.totp || '' };
  } catch { return null; }
}
/** Réécrit le contenu en mémoire, avec un IV neuf. */
function sceller() {
  const c = chiffrer(cle, contenu);
  db.prepare('UPDATE coffre SET iv = @iv, tag = @tag, donnees = @donnees, updated_at = @maintenant WHERE id = 1')
    .run({ ...c, maintenant: new Date().toISOString() });
}
/** Le mot de passe donné est-il celui du coffre ? Comparé par la clé qu'il dérive, à temps constant. */
function bonMotDePasse(mdp) {
  const l = ligne();
  const k = deriver(mdp, Buffer.from(l.sel, 'base64'), JSON.parse(l.kdf || '{}'));
  return cle && k.length === cle.length && crypto.timingSafeEqual(k, cle);
}
/* L'ANCIEN CONTENU EN CLAIR NE DOIT PAS SURVIVRE DANS LE FICHIER. Une ligne réécrite laisse ses anciens
   octets dans les pages libres et dans le WAL : on vide le journal, puis VACUUM reconstruit le fichier. */
function compacter() {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); db.exec('VACUUM'); db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { console.log(`[coffre] compactage : ${e.message}`); }
}
function verifierNouveau(mdp, confirmation) {
  if (String(mdp || '').length < MDP_MIN) throw erreur('password-short', { n: MDP_MIN });
  if (confirmation != null && String(mdp) !== String(confirmation)) throw erreur('password-mismatch');
}
function exigerOuvert() {
  if (!actif()) throw erreur('off');
  if (!cle) throw erreur('locked', null, 423);
}

/* ---------- Les jetons du cœur et les secrets des plugins ---------- */
/** Les jetons du cœur quand le coffre est actif (vides s'il est verrouillé), ou null : lire `local_config`. */
function jetonsCoeur() {
  if (!actif()) return null;
  const out = {};
  for (const k of SECRETS_COEUR) out[k] = cle ? String((contenu.coeur || {})[k] || '') : '';
  return out;
}
/** Écrit les jetons du cœur dans le coffre (seulement ceux qui changent). */
function ecrireJetonsCoeur(valeurs) {
  exigerOuvert();
  let change = false;
  for (const k of SECRETS_COEUR) {
    if (!(k in valeurs)) continue;
    const v = String(valeurs[k] || '');
    if (String(contenu.coeur[k] || '') !== v) { contenu.coeur[k] = v; change = true; }
  }
  if (change) sceller();
}
/* LE MAGASIN DES SECRETS DE PLUGIN, donné au contexte des plugins (`sdk/lib/contexte.js`, `f.secrets`)
   et au chargeur : la table `plugin_secret` quand le coffre est inactif, la mémoire (et le coffre)
   quand il est actif. Verrouillé, un plugin lit des secrets vides et ne peut rien écrire. */
const magasinPlugins = {
  get(nom, k) {
    if (!actif()) { const r = db.prepare('SELECT value FROM plugin_secret WHERE plugin = ? AND key = ?').get(nom, String(k)); return r ? String(r.value) : ''; }
    return cle ? String(((contenu.plugins || {})[nom] || {})[k] || '') : '';
  },
  has(nom, k) { return magasinPlugins.get(nom, k) !== ''; },
  set(nom, k, v) {
    if (!actif()) {
      db.prepare('INSERT OR REPLACE INTO plugin_secret (plugin, key, value, updated_at) VALUES (?, ?, ?, ?)').run(nom, String(k), String(v), new Date().toISOString());
      return;
    }
    exigerOuvert();
    (contenu.plugins[nom] = contenu.plugins[nom] || {})[k] = String(v);
    sceller();
  },
  del(nom, k) {
    if (!actif()) { db.prepare('DELETE FROM plugin_secret WHERE plugin = ? AND key = ?').run(nom, String(k)); return; }
    exigerOuvert();
    if (contenu.plugins[nom] && k in contenu.plugins[nom]) { delete contenu.plugins[nom][k]; sceller(); }
  },
  delPlugin(nom) {
    if (!actif()) { db.prepare('DELETE FROM plugin_secret WHERE plugin = ?').run(nom); return; }
    exigerOuvert();
    if (contenu.plugins[nom]) { delete contenu.plugins[nom]; sceller(); }
  },
};

/* ---------- Activer, désactiver, changer le mot de passe ---------- */
function activer(mdp, confirmation) {
  if (actif()) throw erreur('already-on');
  verifierNouveau(mdp, confirmation);
  const local = db.prepare('SELECT * FROM local_config WHERE id = 1').get() || {};
  const coeur = {};
  for (const k of SECRETS_COEUR) coeur[k] = String(local[k] || '');
  const plugins = {};
  for (const r of db.prepare('SELECT plugin, key, value FROM plugin_secret').all()) (plugins[r.plugin] = plugins[r.plugin] || {})[r.key] = String(r.value);
  const sel = crypto.randomBytes(16);
  const k = deriver(mdp, sel, KDF);
  const neuf = { coeur, plugins, totp: '' };
  const c = chiffrer(k, neuf);
  db.transaction(() => {
    db.prepare(`UPDATE coffre SET actif = 1, kdf = @kdf, sel = @sel, iv = @iv, tag = @tag, donnees = @donnees, totp = 0, updated_at = @maintenant WHERE id = 1`)
      .run({ ...c, kdf: JSON.stringify(KDF), sel: sel.toString('base64'), maintenant: new Date().toISOString() });
    db.prepare(`UPDATE local_config SET ${SECRETS_COEUR.map((x) => `${x} = ''`).join(', ')} WHERE id = 1`).run();
    db.prepare('DELETE FROM plugin_secret').run();
  })();
  cle = k; contenu = neuf; ressaisir = false;
  compacter();
  return etat();
}
/** Remet les jetons en clair, là où ils étaient avant le coffre. */
function desactiver(mdp) {
  exigerOuvert();
  if (!bonMotDePasse(mdp)) throw erreur('bad-password', null, 403);
  const { coeur, plugins } = contenu;
  db.transaction(() => {
    db.prepare(`UPDATE local_config SET ${SECRETS_COEUR.map((x) => `${x} = @${x}`).join(', ')} WHERE id = 1`)
      .run(Object.fromEntries(SECRETS_COEUR.map((x) => [x, String(coeur[x] || '')])));
    const poser = db.prepare('INSERT OR REPLACE INTO plugin_secret (plugin, key, value, updated_at) VALUES (?, ?, ?, ?)');
    const maintenant = new Date().toISOString();
    for (const [nom, cles] of Object.entries(plugins || {})) for (const [k, v] of Object.entries(cles)) if (v !== '') poser.run(nom, k, String(v), maintenant);
    db.prepare(`UPDATE coffre SET actif = 0, kdf = '', sel = '', iv = '', tag = '', donnees = '', totp = 0, updated_at = ? WHERE id = 1`).run(maintenant);
  })();
  cle = null; contenu = null; totpEnAttente = null;
  return etat();
}
function changerMotDePasse(ancien, nouveau, confirmation) {
  exigerOuvert();
  if (!bonMotDePasse(ancien)) throw erreur('bad-password', null, 403);
  verifierNouveau(nouveau, confirmation);
  const sel = crypto.randomBytes(16);
  const k = deriver(nouveau, sel, KDF);
  cle = k;
  db.prepare('UPDATE coffre SET kdf = ?, sel = ? WHERE id = 1').run(JSON.stringify(KDF), sel.toString('base64'));
  sceller();
  compacter();
  return etat();
}

/* ---------- Déverrouiller, verrouiller, réinitialiser ---------- */
/* TROP D'ESSAIS : cinq échecs de suite, puis une attente qui double (30 s, 1 min… plafonnée à 15 min).
   En mémoire : un redémarrage la remet à zéro, mais chaque essai coûte de toute façon une dérivation. */
function attenteRestante() { return Math.max(0, Math.ceil((bloqueJusqua - Date.now()) / 1000)); }
function noterEchec() {
  echecs += 1;
  if (echecs >= 5) bloqueJusqua = Date.now() + Math.min(15 * 60, 30 * 2 ** (echecs - 5)) * 1000;
}
function deverrouiller(mdp, code = '') {
  if (!actif()) throw erreur('off');
  if (cle) return etat();
  const reste = attenteRestante();
  if (reste) throw erreur('too-many', { s: reste }, 429);
  const l = ligne();
  const k = deriver(mdp, Buffer.from(l.sel, 'base64'), JSON.parse(l.kdf || '{}'));
  const c = dechiffrer(k, l);
  if (!c || (l.totp === 1 && !verifierTotp(c.totp, code))) { noterEchec(); throw erreur('bad-credentials', null, 403); }
  echecs = 0; bloqueJusqua = 0;
  cle = k; contenu = c;
  for (const fn of ecouteurs.deverrouillage) { try { fn(); } catch (e) { console.log(`[coffre] ${e.message}`); } }
  return etat();
}
function verrouiller() {
  if (!actif() || !cle) return etat();
  cle = null; contenu = null; totpEnAttente = null;
  for (const fn of ecouteurs.verrouillage) { try { fn(); } catch (e) { console.log(`[coffre] ${e.message}`); } }
  return etat();
}
/* MOT DE PASSE OUBLIÉ, TÉLÉPHONE PERDU : on repart sans jetons. Le contenu chiffré est détruit, le coffre
   et la 2FA s'éteignent ; `local_config` et `plugin_secret` sont déjà vides — c'est à l'utilisateur de
   ressaisir ses jetons. Irréversible : la phrase tapée en est la preuve. */
function reinitialiser(phrase) {
  if (!actif()) throw erreur('off');
  if (!PHRASES.includes(String(phrase || '').trim().toLowerCase())) throw erreur('confirm-phrase', { phrase: t('settings.security.reset-phrase') });
  db.prepare(`UPDATE coffre SET actif = 0, kdf = '', sel = '', iv = '', tag = '', donnees = '', totp = 0, updated_at = ? WHERE id = 1`).run(new Date().toISOString());
  const etaitOuvert = !!cle;
  cle = null; contenu = null; totpEnAttente = null; echecs = 0; bloqueJusqua = 0;
  ressaisir = true;
  compacter();
  if (!etaitOuvert) for (const fn of ecouteurs.deverrouillage) { try { fn(); } catch (e) { console.log(`[coffre] ${e.message}`); } }
  return etat();
}
/** Après une réinitialisation, l'écran ouvre les réglages au chargement, puis l'acquitte. */
function acquitterRessaisir() { ressaisir = false; }

/* ---------- TOTP ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0; let v = 0; let out = '';
  for (const o of buf) { v = (v << 8) | o; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(v << (5 - bits)) & 31];
  return out;
}
function deBase32(s) {
  const propre = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let v = 0; const out = [];
  for (const ch of propre) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function codeTotp(secret, pas) {
  const compteur = Buffer.alloc(8);
  compteur.writeBigUInt64BE(BigInt(pas));
  const h = crypto.createHmac('sha1', deBase32(secret)).update(compteur).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, '0');
}
/* Un pas de trente secondes de tolérance de chaque côté : l'horloge du téléphone n'est jamais exacte.
   À la connexion, un code ne sert qu'une fois (`unique`) ; celui de l'activation ne compte pas. */
function verifierTotp(secret, code, { maintenant = Date.now(), unique = true } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!secret || !/^\d{6}$/.test(c)) return false;
  const pas = Math.floor(maintenant / 30000);
  for (const d of [0, -1, 1]) {
    const p = pas + d;
    if (unique && p <= dernierPasTotp) continue;
    if (crypto.timingSafeEqual(Buffer.from(codeTotp(secret, p)), Buffer.from(c))) { if (unique) dernierPasTotp = p; return true; }
  }
  return false;
}
/** Prépare l'activation de la 2FA : un secret neuf, son adresse `otpauth://` et le QR code qui la porte. */
function preparerTotp() {
  exigerOuvert();
  if (ligne().totp === 1) throw erreur('totp-already-on');
  totpEnAttente = base32(crypto.randomBytes(20));
  const uri = `otpauth://totp/Mergerie?secret=${totpEnAttente}&issuer=Mergerie&algorithm=SHA1&digits=6&period=30`;
  // eslint-disable-next-line global-require
  const qrcode = require('qrcode-generator');
  const qr = (qrcode.default || qrcode)(0, 'M');
  qr.addData(uri); qr.make();
  return { secret: totpEnAttente, uri, svg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) };
}
function activerTotp(code) {
  exigerOuvert();
  if (!totpEnAttente) throw erreur('totp-not-prepared');
  if (!verifierTotp(totpEnAttente, code, { unique: false })) throw erreur('bad-code', null, 403);
  contenu.totp = totpEnAttente; totpEnAttente = null;
  sceller();
  db.prepare('UPDATE coffre SET totp = 1 WHERE id = 1').run();
  return etat();
}
function desactiverTotp(mdp) {
  exigerOuvert();
  if (!bonMotDePasse(mdp)) throw erreur('bad-password', null, 403);
  contenu.totp = '';
  sceller();
  db.prepare('UPDATE coffre SET totp = 0 WHERE id = 1').run();
  return etat();
}

function surDeverrouillage(fn) { ecouteurs.deverrouillage.push(fn); }
function surVerrouillage(fn) { ecouteurs.verrouillage.push(fn); }

module.exports = {
  SECRETS_COEUR, MDP_MIN, etat, actif, verrouille,
  jetonsCoeur, ecrireJetonsCoeur, magasinPlugins,
  activer, desactiver, changerMotDePasse, deverrouiller, verrouiller, reinitialiser, acquitterRessaisir,
  preparerTotp, activerTotp, desactiverTotp, codeTotp, verifierTotp, base32, deBase32,
  surDeverrouillage, surVerrouillage,
};
