'use strict';
/* La dictée vocale : ses réglages dans la configuration.
   Tranche de l'ancien db.js (réorganisation de src/ par couches), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');

/* ---------- Dictée vocale (whisper.md) ----------
   Treize réglages, tous OPT-IN : `off` par défaut, donc aucun micro à l'écran tant qu'on n'a
   rien choisi. Placées APRÈS le `CREATE TABLE config`, comme toutes les migrations de cette
   table — avant, elles lèveraient « no such table » sur une base neuve et le catch vide
   l'avalerait (la colonne n'existerait alors que sur les bases où la table préexistait). */
try { db.exec("ALTER TABLE config ADD COLUMN dictation_provider TEXT DEFAULT 'off'"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_model TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_vad_model TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_command TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_url TEXT DEFAULT 'https://api.openai.com'"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_api_key TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_remote_model TEXT DEFAULT 'gpt-4o-mini-transcribe'"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_language TEXT DEFAULT 'auto'"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_vocabulary TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_replacements TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN dictation_silence_ms INTEGER DEFAULT 700'); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_final_pass TEXT DEFAULT '1'"); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN dictation_idle_minutes INTEGER DEFAULT 15'); } catch { /* déjà présente */ }

try { db.exec('ALTER TABLE config DROP COLUMN health_check'); } catch { /* déjà retirée */ }
try { db.exec('ALTER TABLE config DROP COLUMN health_minutes'); } catch { /* déjà retirée */ }
