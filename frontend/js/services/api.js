/**
 * API Client Service
 * Centralized API communication with error handling
 */

import { gameState } from '../state/gameState.js';

// API base URL - uses current origin
const API_BASE = window.location.origin;

/**
 * Make an API call with proper error handling
 * @param {string} endpoint - API endpoint (e.g., '/api/games')
 * @param {string} method - HTTP method
 * @param {Object|null} body - Request body
 * @param {Object} options - Additional options
 * @returns {Promise<Object>}
 */
export async function apiCall(endpoint, method = 'GET', body = null, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    
    // Send auth token when available
    const authToken = options.authToken ?? gameState.authToken;
    if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
    }
    
    const fetchOptions = {
        method,
        headers,
    };
    
    if (body !== null) {
        fetchOptions.body = JSON.stringify(body);
    }
    
    let response;
    try {
        response = await fetch(`${API_BASE}${endpoint}`, fetchOptions);
    } catch (e) {
        throw new Error('Network error - please try again');
    }

    // Try to parse JSON regardless of Content-Type
    const rawText = await response.text();
    let data = null;
    if (rawText) {
        try {
            data = JSON.parse(rawText);
        } catch (e) {
            data = null;
        }
    }

    if (data === null) {
        console.error('Non-JSON API response', {
            endpoint,
            method,
            status: response.status,
            statusText: response.statusText,
            contentType: response.headers.get('content-type'),
            body: rawText?.slice?.(0, 1000) ?? rawText,
        });
        throw new Error(`Server error (${response.status || 'unknown'}) - please try again`);
    }

    if (!response.ok) {
        let msg = data.detail || data.error || data.message || 'An error occurred';
        if (data.error_code) msg += ` [${data.error_code}]`;
        if (data.error_id) msg += ` (ref: ${data.error_id})`;
        if (data.debug && typeof data.debug === 'object') {
            const where = data.debug.where ? String(data.debug.where) : 'debug';
            const typ = data.debug.type ? String(data.debug.type) : '';
            const err = data.debug.error ? String(data.debug.error) : '';
            const trace = data.debug.trace ? String(data.debug.trace) : '';
            msg += `\n\n${where}${typ ? `: ${typ}` : ''}${err ? `: ${err}` : ''}${trace ? `\n${trace}` : ''}`;
        }
        const error = new Error(msg);
        error.status = response.status;
        error.endpoint = endpoint;
        error.method = method;
        error.response = data;
        console.error('API error', { endpoint, method, status: response.status, data });
        throw error;
    }

    return data;
}

/**
 * Load client configuration from server
 * @returns {Promise<Object>}
 */
export async function loadClientConfig() {
    try {
        return await apiCall('/api/client-config');
    } catch (e) {
        console.warn('Failed to load client config:', e);
        return null;
    }
}

/**
 * Get API base URL
 * @returns {string}
 */
export function getApiBase() {
    return API_BASE;
}

// Game API calls
export const games = {
    /**
     * Create a new game
     * @param {Object} options
     * @returns {Promise<Object>}
     */
    create: (options = {}) => apiCall('/api/games', 'POST', {
        visibility: options.visibility || 'private',
        is_ranked: Boolean(options.isRanked),
    }),

    /**
     * Get game state
     * @param {string} code
     * @param {string} playerId
     * @returns {Promise<Object>}
     */
    get: (code, playerId) => apiCall(`/api/games/${code}?player_id=${playerId}`),

    /**
     * Get game for spectating
     * @param {string} code
     * @returns {Promise<Object>}
     */
    spectate: (code) => apiCall(`/api/games/${code}/spectate`),

    /**
     * Join a game
     * @param {string} code
     * @param {string} name
     * @returns {Promise<Object>}
     */
    join: (code, name) => apiCall(`/api/games/${code}/join`, 'POST', { name }),

    /**
     * Leave a game
     * @param {string} code
     * @param {string} playerId
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    leave: (code, playerId, sessionToken) => apiCall(`/api/games/${code}/leave`, 'POST', { 
        player_id: playerId,
        session_token: sessionToken || gameState.sessionToken,
    }),

    /**
     * Start a game (host only)
     * @param {string} code
     * @param {string} playerId
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    start: (code, playerId, sessionToken) => apiCall(`/api/games/${code}/start`, 'POST', { 
        player_id: playerId,
        session_token: sessionToken || gameState.sessionToken,
    }),

    /**
     * Begin game after word selection (host only)
     * @param {string} code
     * @param {string} playerId
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    begin: (code, playerId, sessionToken) => apiCall(`/api/games/${code}/begin`, 'POST', { 
        player_id: playerId,
        session_token: sessionToken || gameState.sessionToken,
    }),

    /**
     * Set secret word
     * @param {string} code
     * @param {string} playerId
     * @param {string} word
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    setWord: (code, playerId, word, sessionToken) => apiCall(`/api/games/${code}/set-word`, 'POST', {
        player_id: playerId,
        secret_word: word,
        session_token: sessionToken || gameState.sessionToken,
    }),

    /**
     * Change secret word
     * @param {string} code
     * @param {string} playerId
     * @param {string} newWord
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    changeWord: (code, playerId, newWord, sessionToken) => apiCall(`/api/games/${code}/change-word`, 'POST', {
        player_id: playerId,
        new_word: newWord,
        session_token: sessionToken || gameState.sessionToken,
    }),

    /**
     * Submit a guess
     * @param {string} code
     * @param {string} playerId
     * @param {string} word
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    guess: (code, playerId, word, sessionToken) => apiCall(`/api/games/${code}/guess`, 'POST', {
        player_id: playerId,
        word,
        session_token: sessionToken || gameState.sessionToken,
    }),

    /**
     * Vote for a theme
     * @param {string} code
     * @param {string} playerId
     * @param {string} theme
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    vote: (code, playerId, theme, sessionToken) => apiCall(`/api/games/${code}/vote`, 'POST', {
        player_id: playerId,
        theme,
        session_token: sessionToken || gameState.sessionToken,
    }),

    /**
     * Toggle ready status
     * @param {string} code
     * @param {string} playerId
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    ready: (code, playerId, sessionToken) => apiCall(`/api/games/${code}/ready`, 'POST', {
        player_id: playerId,
        session_token: sessionToken || gameState.sessionToken,
    }),

    /**
     * Skip word change
     * @param {string} code
     * @param {string} playerId
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    skipWordChange: (code, playerId, sessionToken) => apiCall(`/api/games/${code}/skip-word-change`, 'POST', {
        player_id: playerId,
        session_token: sessionToken || gameState.sessionToken,
    }),

    /**
     * Forfeit and leave game
     * @param {string} code
     * @param {string} playerId
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    forfeit: (code, playerId, sessionToken) => apiCall(`/api/games/${code}/forfeit`, 'POST', { 
        player_id: playerId,
        session_token: sessionToken || gameState.sessionToken,
    }),

    /**
     * Record spectator presence
     * @param {string} code
     * @param {string} spectatorId
     * @returns {Promise<Object>}
     */
    recordSpectator: (code, spectatorId) => apiCall(`/api/games/${code}/spectate`, 'POST', { spectator_id: spectatorId }),
};

// Lobby API calls
export const lobbies = {
    /**
     * Get open lobbies
     * @param {string} mode - 'ranked' or 'unranked'
     * @returns {Promise<Object>}
     */
    list: (mode) => apiCall(`/api/lobbies${mode ? `?mode=${mode}` : ''}`),

    /**
     * Get spectateable games
     * @returns {Promise<Object>}
     */
    spectateable: () => apiCall('/api/spectateable'),
};

// Singleplayer API calls
export const singleplayer = {
    /**
     * Create singleplayer game
     * @param {string} difficulty
     * @returns {Promise<Object>}
     */
    create: (difficulty = 'rookie') => apiCall('/api/singleplayer', 'POST', { difficulty }),

    /**
     * Get singleplayer lobby state
     * @param {string} code
     * @param {string} playerId
     * @returns {Promise<Object>}
     */
    get: (code, playerId) => apiCall(`/api/singleplayer/${code}?player_id=${playerId}`),

    /**
     * Add AI player
     * @param {string} code
     * @param {string} playerId
     * @param {string} difficulty
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    addAi: (code, playerId, difficulty, sessionToken) => apiCall(`/api/singleplayer/${code}/add-ai`, 'POST', {
        player_id: playerId,
        difficulty,
        session_token: sessionToken || gameState.sessionToken,
    }),

    /**
     * Remove AI player
     * @param {string} code
     * @param {string} playerId
     * @param {string} aiId
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    removeAi: (code, playerId, aiId, sessionToken) => apiCall(`/api/singleplayer/${code}/remove-ai`, 'POST', {
        player_id: playerId,
        ai_id: aiId,
        session_token: sessionToken || gameState.sessionToken,
    }),

    /**
     * Start singleplayer game
     * @param {string} code
     * @param {string} playerId
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    start: (code, playerId, sessionToken) => apiCall(`/api/singleplayer/${code}/start`, 'POST', { 
        player_id: playerId,
        session_token: sessionToken || gameState.sessionToken,
    }),

    /**
     * Process AI turn
     * @param {string} code
     * @param {string} playerId
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    aiTurn: (code, playerId, sessionToken) => apiCall(`/api/singleplayer/${code}/ai-turn`, 'POST', { 
        player_id: playerId,
        session_token: sessionToken || gameState.sessionToken,
    }),

    /**
     * Process AI word selection
     * @param {string} code
     * @param {string} playerId
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    aiWordPick: (code, playerId, sessionToken) => apiCall(`/api/singleplayer/${code}/ai-word-pick`, 'POST', { 
        player_id: playerId,
        session_token: sessionToken || gameState.sessionToken,
    }),

    /**
     * Process AI word change
     * @param {string} code
     * @param {string} playerId
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    aiWordChange: (code, playerId, sessionToken) => apiCall(`/api/singleplayer/${code}/ai-word-change`, 'POST', { 
        player_id: playerId,
        session_token: sessionToken || gameState.sessionToken,
    }),
};

// Chat API calls
export const chat = {
    /**
     * Get chat messages
     * @param {string} code
     * @param {number} afterId
     * @param {number} limit
     * @returns {Promise<Object>}
     */
    get: (code, afterId = 0, limit = 50) => 
        apiCall(`/api/games/${code}/chat?after=${afterId}&limit=${limit}`),

    /**
     * Send chat message
     * @param {string} code
     * @param {string} playerId
     * @param {string} message
     * @param {string} sessionToken
     * @returns {Promise<Object>}
     */
    send: (code, playerId, message, sessionToken) => apiCall(`/api/games/${code}/chat`, 'POST', {
        player_id: playerId,
        message,
        session_token: sessionToken || gameState.sessionToken,
    }),
};

// Leaderboard API calls
export const leaderboard = {
    /**
     * Get casual leaderboard
     * @param {string} type - 'alltime' or 'weekly'
     * @returns {Promise<Object>}
     */
    casual: (type = 'alltime') => apiCall(`/api/leaderboard?type=${encodeURIComponent(type)}`),

    /**
     * Get ranked leaderboard
     * @returns {Promise<Object>}
     */
    ranked: () => apiCall('/api/leaderboard/ranked'),
};

// Profile API calls
export const profile = {
    /**
     * Get player profile
     * @param {string} name
     * @returns {Promise<Object>}
     */
    get: (name) => apiCall(`/api/profile/${encodeURIComponent(name)}`),
};

// Challenge API calls
export const challenges = {
    /**
     * Get challenge details
     * @param {string} id
     * @returns {Promise<Object>}
     */
    get: (id) => apiCall(`/api/challenge/${id}`),

    /**
     * Accept a challenge
     * @param {string} id
     * @returns {Promise<Object>}
     */
    accept: (id) => apiCall(`/api/challenge/${id}/accept`, 'POST'),
};

export default {
    apiCall,
    loadClientConfig,
    getApiBase,
    games,
    lobbies,
    singleplayer,
    chat,
    leaderboard,
    profile,
    challenges,
};

