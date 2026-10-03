#!/usr/bin/env node
// teams-post.js — fichier FOURNI (teamsPoster.js), intégré au plugin jenkins-teams-notify.
// npm i playwright && npx playwright install chromium
//
// Usage (CLI, c'est ce que lance le plugin — jamais par un shell) :
//   node teams-post.js --message="🚀 Déploiement en cours…" --channel-url=https://teams.microsoft.com/… \
//        [--channel-name=Deploiements] [--profile-dir=/chemin] [--headless=true|false] \
//        [--cdp-url=http://127.0.0.1:9222] [--dry-run] [--login-timeout-ms=90000]
// Usage (module) :
//   const { postToTeams } = require('./teams-post');
//   await postToTeams('🚀 Déploiement en cours…');
//
// 1ère exécution : la fenêtre s'ouvre, tu te connectes à la main (MFA).
// Les exécutions suivantes réutilisent la session stockée dans PROFILE_DIR.
//
// ─── ADAPTATIONS PAR RAPPORT AU FICHIER FOURNI (toutes nécessaires à l'intégration) ──────────────
//  1. CLI : le plugin passe sa configuration en ARGUMENTS (`--clé=valeur`), jamais en variables
//     d'environnement ni dans une chaîne de commande. Les variables TEAMS_* restent les valeurs par
//     défaut, comme avant. Le message n'est qu'un argument : rien ne l'interprète.
//  2. Codes de sortie : 0 posté · 1 échec · 2 SESSION EXPIRÉE (page de connexion visible alors
//     qu'on ne peut pas se connecter) · 3 prérequis manquant (Playwright ou Chromium absent).
//     L'original sortait en 1 pour tout, et en headless attendait 5 minutes avant d'abandonner :
//     le plugin a besoin de distinguer « reconnecte-toi » d'une panne, et d'un délai borné.
//  3. Session expirée : la page de connexion n'est plus testée UNE fois 5 s après le chargement,
//     mais à chaque tour de l'attente de l'éditeur (Teams redirige après `domcontentloaded`).
//     Hors `--dry-run`, elle lève la sortie 2 tout de suite — personne n'est là pour se connecter.
//  4. `--dry-run` : va jusqu'à l'éditeur SANS rien poster. C'est le mode « Ouvrir Teams pour se
//     connecter » : fenêtre visible, on attend la connexion humaine (jusqu'à --login-timeout-ms),
//     puis on sort 0 quand l'éditeur apparaît — le profil garde la session.
//  5. `--cdp-url` : se rattache à un Chrome déjà ouvert (connectOverCDP) au lieu de lancer un
//     profil Playwright ; on ne ferme que l'onglet ouvert, jamais le navigateur de la personne.
//  6. `--channel-name` : garde-fou — si le titre de la page ne contient pas le nom attendu du
//     canal, on ne poste pas (sortie 1). Vide = pas de contrôle. Le titre est un indice, pas
//     une preuve : voir « sélecteurs » ci-dessous.
//  7. `require('playwright')` est paresseux : l'analyse des arguments, et `--help`, marchent sans.
//  8. Le contenu du message n'est jamais écrit dans la sortie.
// Le reste (profil persistant, éditeur dans une iframe, Entrée pour envoyer, délai de départ)
// est le code fourni, inchangé.
// ──────────────────────────────────────────────────────────────────────────────────────────────

const path = require('path');

const EXIT = { OK: 0, ECHEC: 1, SESSION: 2, PREREQUIS: 3 };

class SessionExpiredError extends Error {}
class PrerequisiteError extends Error {}

const CONFIG = {
    channelUrl: process.env.TEAMS_CHANNEL_URL, // URL du canal (copier le lien du canal dans Teams)
    channelName: process.env.TEAMS_CHANNEL_NAME || '',
    profileDir: path.resolve(process.env.TEAMS_PROFILE_DIR || './teams-profile'),
    headless: process.env.TEAMS_HEADLESS === 'true', // false la 1ère fois pour se logger
    cdpUrl: process.env.TEAMS_CDP_URL || '',
    dryRun: false,
    loginTimeoutMs: 5 * 60 * 1000,
    // ─── SÉLECTEURS : LE SEUL ENDROIT À MODIFIER quand Teams change son DOM ───
    // Non vérifiés contre un Teams réel par le plugin : voir docs/plugins/jenkins-teams-notify.md.
    selectors: {
        editor: 'div[contenteditable="true"][role="textbox"]',
        loginPage: 'input[type="email"], #i0116',
        sendButton: 'button[data-tid="newMessageCommands-send"]',
    },
};

/** Les arguments `--clé=valeur` (et `--drapeau`) → les surcharges de CONFIG. */
function parseArgs(argv) {
    const out = { overrides: {}, message: undefined, help: false };
    const bool = (v) => v === undefined || v === '' || v === 'true' || v === '1';
    for (const a of argv) {
        if (a === '--help' || a === '-h') { out.help = true; continue; }
        const m = /^--([a-z][a-z-]*)(?:=([\s\S]*))?$/.exec(a);
        if (!m) { if (out.message === undefined) out.message = a; continue; } // l'usage d'origine : node teams-post.js "Hello"
        const [, cle, val] = m;
        switch (cle) {
            case 'message': out.message = val === undefined ? '' : val; break;
            case 'channel-url': out.overrides.channelUrl = val; break;
            case 'channel-name': out.overrides.channelName = val || ''; break;
            case 'profile-dir': out.overrides.profileDir = path.resolve(val); break;
            case 'headless': out.overrides.headless = bool(val); break;
            case 'cdp-url': out.overrides.cdpUrl = val || ''; break;
            case 'dry-run': out.overrides.dryRun = bool(val); break;
            case 'login-timeout-ms': out.overrides.loginTimeoutMs = Math.max(1000, Number(val) || CONFIG.loginTimeoutMs); break;
            default: throw new Error(`argument inconnu : --${cle}`);
        }
    }
    return out;
}

function chargerPlaywright() {
    try { return require('playwright'); }
    catch (e) {
        throw new PrerequisiteError('Playwright introuvable : npm i playwright && npx playwright install chromium');
    }
}

async function postToTeams(message, overrides = {}) {
    const cfg = { ...CONFIG, ...overrides };
    if (!cfg.channelUrl) throw new Error('TEAMS_CHANNEL_URL manquant');
    if (!cfg.dryRun && !message) throw new Error('message vide');
    const { chromium } = chargerPlaywright();

    let context; let browser; let page;
    try {
        if (cfg.cdpUrl) {
            // Chrome déjà ouvert : on ne lance rien, on ne fermera que NOTRE onglet.
            browser = await chromium.connectOverCDP(cfg.cdpUrl);
            context = browser.contexts()[0] || (await browser.newContext());
            page = await context.newPage();
        } else {
            context = await chromium.launchPersistentContext(cfg.profileDir, {
                headless: cfg.headless,
                viewport: { width: 1400, height: 900 },
                args: ['--disable-blink-features=AutomationControlled'],
            });
            page = context.pages()[0] || (await context.newPage());
        }
    } catch (e) {
        if (/Executable doesn't exist|browserType\.launch/.test(String(e && e.message))) throw new PrerequisiteError('Chromium introuvable : npx playwright install chromium');
        throw e;
    }

    try {
        await page.goto(cfg.channelUrl, { waitUntil: 'domcontentloaded' });

        // Session expirée ? On ne laisse le temps de se reconnecter qu'en --dry-run (connexion humaine)
        const loginVisible = await isLoginVisible(page, cfg, 5000);

        if (loginVisible) {
            if (!cfg.dryRun) throw new SessionExpiredError('Session Teams expirée : « Ouvrir Teams pour se connecter » dans Réglages');
            console.log('Connexion requise, en attente…');
        }

        // Attend l'éditeur de message (gère aussi le cas iframe)
        const editor = await waitForEditor(page, cfg);

        if (cfg.channelName) {
            const titre = await page.title().catch(() => '');
            if (!titre.toLowerCase().includes(cfg.channelName.toLowerCase())) {
                throw new Error(`canal attendu « ${cfg.channelName} » absent du titre de la page (« ${titre.slice(0, 80)} ») : lien du canal à vérifier`);
            }
        }

        if (cfg.dryRun) { console.log('Session valide (dry-run) : rien posté'); return; }

        await editor.click();
        await editor.fill(message);
        await page.keyboard.press('Enter');

        // Petit délai pour laisser partir le message avant fermeture
        await page.waitForTimeout(1500);
        console.log('Message posté');
    } finally {
        if (cfg.cdpUrl) { await page.close().catch(() => {}); await browser.close().catch(() => {}); } // détache, ne tue pas Chrome
        else await context.close();
    }
}

async function isLoginVisible(page, cfg, timeout) {
    return page
        .locator(cfg.selectors.loginPage)
        .first()
        .isVisible({ timeout })
        .catch(() => false);
}

async function waitForEditor(page, cfg) {
    const deadline = Date.now() + cfg.loginTimeoutMs;
    while (Date.now() < deadline) {
        // Cherche dans la page principale puis dans chaque iframe
        for (const frame of page.frames()) {
            const loc = frame.locator(cfg.selectors.editor).first();
            if (await loc.isVisible().catch(() => false)) return loc;
        }
        // Teams redirige APRÈS le chargement : la page de connexion peut n'apparaître qu'ici.
        if (!cfg.dryRun && await isLoginVisible(page, cfg, 1)) throw new SessionExpiredError('Session Teams expirée : « Ouvrir Teams pour se connecter » dans Réglages');
        await page.waitForTimeout(1000);
    }
    throw new Error("Éditeur de message introuvable (sélecteur à mettre à jour ?)");
}

module.exports = { postToTeams, parseArgs, EXIT, SessionExpiredError, PrerequisiteError, CONFIG };

// CLI : node teams-post.js --message="Hello" --channel-url=…
if (require.main === module) {
    let args;
    try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(EXIT.ECHEC); }
    if (args.help) { console.log('usage : node teams-post.js --message=… --channel-url=… [--channel-name=… --profile-dir=… --headless=true|false --cdp-url=… --dry-run --login-timeout-ms=…]'); process.exit(EXIT.OK); }
    postToTeams(args.message === undefined ? (args.overrides.dryRun ? '' : 'Test depuis Playwright') : args.message, args.overrides).then(() => process.exit(EXIT.OK)).catch((e) => {
        console.error(String(e && e.message).split('\n')[0]);
        process.exit(e instanceof SessionExpiredError ? EXIT.SESSION : e instanceof PrerequisiteError ? EXIT.PREREQUIS : EXIT.ECHEC);
    });
}
