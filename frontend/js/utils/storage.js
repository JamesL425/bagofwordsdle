/**
 * Storage Utilities
 * localStorage helpers with error handling
 */

/**
 * Save game session to localStorage
 * @param {Object} gameState - Current game state
 */
export function saveGameSession(gameState) {
    if (gameState.code && gameState.playerId) {
        const session = {
            code: gameState.code,
            playerId: gameState.playerId,
            playerName: gameState.playerName,
            sessionToken: gameState.sessionToken || null,  // SECURITY: Store session token
            isSingleplayer: gameState.isSingleplayer || false,
        };
        localStorage.setItem('embeddle_session', JSON.stringify(session));
        upsertRecentGame(session);
        // Update URL to include game code
        if (window.location.pathname !== `/game/${gameState.code}`) {
            history.pushState({ gameCode: gameState.code }, '', `/game/${gameState.code}`);
        }
    }
}

/**
 * Clear game session from localStorage
 */
export function clearGameSession() {
    const existing = getSavedSession();
    if (existing) upsertRecentGame(existing);
    localStorage.removeItem('embeddle_session');
    if (window.location.pathname !== '/') {
        history.pushState({}, '', '/');
    }
}

/**
 * Get saved session from localStorage
 * @returns {Object|null}
 */
export function getSavedSession() {
    try {
        const saved = localStorage.getItem('embeddle_session');
        return saved ? JSON.parse(saved) : null;
    } catch (e) {
        localStorage.removeItem('embeddle_session');
        return null;
    }
}

/**
 * Get recent games list
 * @returns {Array}
 */
export function getRecentGames() {
    try {
        const raw = localStorage.getItem('embeddle_recent_games');
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        localStorage.removeItem('embeddle_recent_games');
        return [];
    }
}

/**
 * Add or update a game in recent games list
 * @param {Object} session - Game session data
 */
export function upsertRecentGame(session) {
    if (!session?.code) return;
    const list = getRecentGames();
    const now = Date.now();
    const entry = {
        code: session.code,
        playerId: session.playerId || null,
        playerName: session.playerName || null,
        sessionToken: session.sessionToken || null,  // SECURITY: Store session token
        isSingleplayer: Boolean(session.isSingleplayer),
        lastSeen: now,
    };
    const idx = list.findIndex(x => x.code === entry.code && x.playerName === entry.playerName);
    if (idx >= 0) {
        list[idx] = { ...list[idx], ...entry };
    } else {
        list.unshift(entry);
    }
    localStorage.setItem('embeddle_recent_games', JSON.stringify(list.slice(0, 10)));
}

/**
 * Generate a random 32-character hex ID (128 bits for better security)
 * @returns {string}
 */
export function generateHexId32() {
    const bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @deprecated Use generateHexId32 instead for better security
 * Generate a random 16-character hex ID
 * @returns {string}
 */
export function generateHexId16() {
    const bytes = new Uint8Array(8);
    if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get or create a persistent spectator ID
 * @returns {string}
 */
export function getOrCreateSpectatorId() {
    try {
        const key = 'embeddle_spectator_id';
        const existing = localStorage.getItem(key);
        // Accept both old 16-char and new 32-char IDs
        if (existing && /^[a-f0-9]{16,32}$/i.test(existing)) {
            return existing.toLowerCase();
        }
        const id = generateHexId32();
        localStorage.setItem(key, id);
        return id;
    } catch (e) {
        return generateHexId32();
    }
}

/**
 * Get game code from current URL
 * @returns {string|null}
 */
export function getGameCodeFromURL() {
    const match = window.location.pathname.match(/^\/game\/([A-Z0-9]+)$/i);
    return match ? match[1].toUpperCase() : null;
}

/**
 * Get challenge ID from current URL
 * @returns {string|null}
 */
export function getChallengeIdFromURL() {
    const match = window.location.pathname.match(/^\/challenge\/([A-Z0-9]+)$/i);
    return match ? match[1].toUpperCase() : null;
}

/**
 * Save options to localStorage
 * @param {Object} options - Options object
 */
export function saveOptions(options) {
    try {
        localStorage.setItem('embeddle_options', JSON.stringify(options));
    } catch (e) {
        // ignore
    }
}

/**
 * Load options from localStorage
 * @param {Object} defaults - Default options
 * @returns {Object}
 */
export function loadOptions(defaults) {
    try {
        const raw = localStorage.getItem('embeddle_options');
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object') {
            return { ...defaults, ...parsed };
        }
        return { ...defaults };
    } catch (e) {
        return { ...defaults };
    }
}

/**
 * Get saved auth token
 * @returns {string|null}
 */
export function getAuthToken() {
    return localStorage.getItem('embeddle_auth_token');
}

/**
 * Save auth token
 * @param {string} token
 */
export function setAuthToken(token) {
    localStorage.setItem('embeddle_auth_token', token);
}

/**
 * Remove auth token
 */
export function removeAuthToken() {
    localStorage.removeItem('embeddle_auth_token');
}

/**
 * Get saved player name
 * @returns {string|null}
 */
export function getSavedName() {
    return localStorage.getItem('embeddle_name');
}

/**
 * Save player name
 * @param {string} name
 */
export function setSavedName(name) {
    localStorage.setItem('embeddle_name', name);
}

/**
 * Remove saved player name
 */
export function removeSavedName() {
    localStorage.removeItem('embeddle_name');
}

