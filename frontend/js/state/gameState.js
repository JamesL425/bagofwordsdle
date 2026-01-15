/**
 * Game State Management
 * Centralized game state with reactive updates
 */

import { saveGameSession, clearGameSession } from '../utils/storage.js';

// Game state singleton
const gameState = {
    code: null,
    playerId: null,
    playerName: null,
    sessionToken: null,  // SECURITY: Session token for authenticated game actions
    isHost: false,
    pollingInterval: null,
    theme: null,
    wordPool: null,
    allThemeWords: null,
    myVote: null,
    authToken: null,
    authUser: null,
    isSpectator: false,
    spectatorId: null,
    isSingleplayer: false,
    pendingChallenge: null,
    userData: null,
};

// State change listeners
const listeners = new Set();

/**
 * Subscribe to state changes
 * @param {Function} callback - Called when state changes
 * @returns {Function} - Unsubscribe function
 */
export function subscribe(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
}

/**
 * Notify all listeners of state change
 * @param {string} key - Changed key
 * @param {*} value - New value
 */
function notify(key, value) {
    listeners.forEach(cb => {
        try {
            cb(key, value, gameState);
        } catch (e) {
            console.error('State listener error:', e);
        }
    });
}

/**
 * Get entire game state (read-only copy)
 * @returns {Object}
 */
export function getState() {
    return { ...gameState };
}

/**
 * Get a specific state value
 * @param {string} key
 * @returns {*}
 */
export function get(key) {
    return gameState[key];
}

/**
 * Set a state value
 * @param {string} key
 * @param {*} value
 */
export function set(key, value) {
    const oldValue = gameState[key];
    if (oldValue !== value) {
        gameState[key] = value;
        notify(key, value);
    }
}

/**
 * Update multiple state values at once
 * @param {Object} updates
 */
export function update(updates) {
    Object.entries(updates).forEach(([key, value]) => {
        if (gameState[key] !== value) {
            gameState[key] = value;
            notify(key, value);
        }
    });
}

/**
 * Reset game-specific state (keeps auth)
 */
export function resetGame() {
    gameState.code = null;
    gameState.playerId = null;
    gameState.sessionToken = null;  // SECURITY: Clear session token
    gameState.isHost = false;
    gameState.pollingInterval = null;
    gameState.theme = null;
    gameState.wordPool = null;
    gameState.allThemeWords = null;
    gameState.myVote = null;
    gameState.isSpectator = false;
    gameState.spectatorId = null;
    gameState.isSingleplayer = false;
    gameState.pendingChallenge = null;
    clearGameSession();
    notify('reset', null);
}

/**
 * Clear all state (full logout)
 */
export function clearAll() {
    Object.keys(gameState).forEach(key => {
        gameState[key] = null;
    });
    gameState.isHost = false;
    gameState.isSpectator = false;
    gameState.isSingleplayer = false;
    clearGameSession();
    notify('clearAll', null);
}

/**
 * Save current game session to localStorage
 */
export function persistSession() {
    saveGameSession(gameState);
}

/**
 * Set auth data
 * @param {string} token
 * @param {Object} user
 */
export function setAuth(token, user) {
    gameState.authToken = token;
    gameState.authUser = user;
    if (user?.name) {
        gameState.playerName = user.name;
    }
    notify('auth', { token, user });
}

/**
 * Clear auth data
 */
export function clearAuth() {
    gameState.authToken = null;
    gameState.authUser = null;
    notify('auth', null);
}

/**
 * Check if user is authenticated
 * @returns {boolean}
 */
export function isAuthenticated() {
    return Boolean(gameState.authToken);
}

/**
 * Check if user has admin privileges (email-based only now)
 * @returns {boolean}
 */
export function isAdmin() {
    return gameState.authUser?.is_admin;
}

// Export the raw state for legacy compatibility (read-only access recommended)
export { gameState };

