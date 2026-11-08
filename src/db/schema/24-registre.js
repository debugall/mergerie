'use strict';
/* LE CONTRÔLE AU REGISTRE — « +2 dépendances · 1 inconnue » sur la carte.
 *
 * Pour chaque dépendance AJOUTÉE par une merge request (tranche 22), ce que le registre public de
 * son écosystème en sait : inconnue (le registre répond 404), publiée pour la première fois il y a
 * N jours (récente), ou connue de longue date. C'est le premier appel réseau de Mergerie qui ne va
 * ni à la forge, ni à Jira : décoché par défaut, limité aux noms des paquets ajoutés, plafonné par
 * tour, mis en cache ICI par nom de paquet — `registry_lookup`, clé `(ecosystem, name)`, le nom
 * normalisé par écosystème (PyPI : minuscules, `_`/`.`/`-` → `-` ; NuGet : minuscules).
 *
 * `status` : `known` / `recent` / `unknown` / `unreachable` / `skipped` ; `reason` dit pourquoi
 * (`404`, `timeout`, `http-503`, `cap`…). Un `unknown` ou un `unreachable` est revérifié après 24 h,
 * un `known` / `recent` après 7 jours ; un `skipped · cap` au tour suivant. « Injoignable » n'est
 * JAMAIS traduit en « inconnu » : seul un 404 du registre vaut `unknown`.
 *
 * Famille C du registre de partage : relu du réseau, jamais dans le dépôt de données partagé —
 * chaque poste a son cache ; un cache partagé ferait voyager la liste des paquets de l'équipe. */
const db = require('../connexion');

db.exec(`CREATE TABLE IF NOT EXISTS registry_lookup (
  ecosystem TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  first_published TEXT,
  latest_published TEXT,
  checked_at TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (ecosystem, name)
)`);

/* Les réglages d'équipe (Réglages → Merge Request → Découverte → Contrôle au registre) :
   l'interrupteur, DÉCOCHÉ d'office (le libellé nomme les hôtes contactés), le seuil « récent »
   (30 jours), le plafond d'appels par tour (30 ; 0 = sans limite), et les motifs de paquets privés
   (un glob par ligne, vides) — posés aussi sur un groupe (d'équipe) et un dépôt (de poste), avec la
   même résolution que les motifs de manifestes. */
try { db.exec("ALTER TABLE config ADD COLUMN registry_enabled TEXT DEFAULT '0'"); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN registry_recent_days INTEGER DEFAULT 30'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN registry_max INTEGER DEFAULT 30'); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN private_patterns TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE repo_group ADD COLUMN private_patterns TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE repo ADD COLUMN private_patterns TEXT DEFAULT ''"); } catch { /* déjà présente */ }
/* Les URL des registres sont DE CE POSTE : un miroir ou un proxy d'entreprise ne se partage pas.
   Une ligne `écosystème=url` par registre à surcharger ; vide après le `=` : l'écosystème n'est
   pas contrôlé ; absent : l'URL publique. */
try { db.exec("ALTER TABLE local_config ADD COLUMN registry_urls TEXT DEFAULT ''"); } catch { /* déjà présente */ }
