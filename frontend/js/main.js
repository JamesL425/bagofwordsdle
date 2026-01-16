/**
 * Main Entry Point
 * Initializes all modules and starts the application
 */

// State imports
import * as gameState from './state/gameState.js';
import * as optionsState from './state/optionsState.js';
import * as chatState from './state/chatState.js';

// Service imports
import { apiCall, loadClientConfig } from './services/api.js';
import * as auth from './services/auth.js';
import * as polling from './services/polling.js';

// UI imports
import * as screens from './ui/screens.js';
import * as toast from './ui/toast.js';
import * as modals from './ui/modals.js';
import * as chat from './ui/chat.js';
import * as leaderboard from './ui/leaderboard.js';
import * as panels from './ui/panels.js';

// Game imports
import * as gameController from './game/gameController.js';
import * as wordSelection from './game/wordSelection.js';

// Utils imports
import { startBackgroundMusic, setBgmConfig } from './utils/audio.js';

/**
 * Initialize the application
 */
async function init() {
    console.log('[INIT] Starting Embeddle...');
    
    // Load saved options
    optionsState.load();
    
    // Initialize UI modules
    screens.init();
    modals.init();
    chat.init();
    panels.init();
    gameController.init();
    wordSelection.init();
    
    // Set up callbacks
    leaderboard.setProfileCallback(showPlayerProfile);
    polling.setGameCallback(handleGameUpdate);
    polling.setChatCallback(handleChatUpdate);
    
    // Load client config
    try {
        const config = await loadClientConfig();
        if (config?.bgm) {
            setBgmConfig(config.bgm);
        }
    } catch (e) {
        console.warn('[INIT] Failed to load client config:', e);
    }
    
    // Try to restore auth
    try {
        const user = await auth.initAuth();
        if (user) {
            updateLoginUI(user);
        }
    } catch (e) {
        console.error('[INIT] Auth init error:', e);
        toast.error(e.message);
    }
    
    // Apply options
    panels.applyOptions();
    
    // Start background music on first interaction
    document.addEventListener('click', () => {
        startBackgroundMusic(optionsState.get('musicEnabled'));
    }, { once: true });
    
    // Show home screen
    screens.show('home');
    
    // Load mini leaderboard
    leaderboard.loadMini();
    
    console.log('[INIT] Embeddle ready!');
}

/**
 * Update login UI based on auth state
 */
function updateLoginUI(user) {
    const loginBox = document.getElementById('login-box');
    const loggedInBox = document.getElementById('logged-in-box');
    const nameDisplay = document.getElementById('logged-in-name');
    const avatarImg = document.getElementById('logged-in-avatar');
    
    if (user && !user.isGuest) {
        loginBox?.classList.add('hidden');
        loggedInBox?.classList.remove('hidden');
        if (nameDisplay) nameDisplay.textContent = user.name;
        if (avatarImg && user.avatar) {
            avatarImg.src = user.avatar;
            avatarImg.classList.remove('hidden');
        }
    } else if (user?.isGuest) {
        loginBox?.classList.add('hidden');
        loggedInBox?.classList.remove('hidden');
        if (nameDisplay) nameDisplay.textContent = user.name;
        if (avatarImg) avatarImg.classList.add('hidden');
    }
}

/**
 * Show player profile modal
 */
async function showPlayerProfile(name) {
    // Implementation would load profile data and show modal
    console.log('[UI] Show profile:', name);
}

/**
 * Handle game state updates from polling
 */
function handleGameUpdate(game) {
    if (!game) return;
    
    const currentScreen = screens.getCurrent();
    
    // Route to appropriate handler based on game status
    if (game.status === 'lobby') {
        if (currentScreen !== 'lobby') {
            screens.show('lobby');
        }
        // Update lobby UI
    } else if (game.status === 'word_selection') {
        // Word selection phase (distinct backend status)
        if (currentScreen !== 'wordselect') {
            wordSelection.show(game);
        }
        wordSelection.updateStatus(game);
    } else if (game.status === 'playing') {
        // Active game - all words should be set at this point
        if (currentScreen !== 'game') {
            screens.show('game');
        }
        gameController.updateGame(game);
    } else if (game.status === 'finished') {
        if (currentScreen !== 'gameover') {
            screens.show('gameover');
        }
        // Update game over UI
    }
}

/**
 * Handle chat updates from polling
 */
function handleChatUpdate(state) {
    chat.render();
    chat.updateUnreadDot();
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Export for global access (legacy compatibility)
window.Embeddle = {
    gameState,
    optionsState,
    auth,
    screens,
    toast,
    polling,
    apiCall,
};

