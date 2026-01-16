/**
 * Polling Service
 * Manages game, lobby, and chat polling intervals
 */

import { games, lobbies, chat } from './api.js';
import { gameState } from '../state/gameState.js';
import * as chatState from '../state/chatState.js';
import { optionsState } from '../state/optionsState.js';

// Polling intervals
let lobbyRefreshInterval = null;
let spectateRefreshInterval = null;
let gamePollingInterval = null;
let wordSelectPollingInterval = null;
let singleplayerLobbyPollingInterval = null;

// Polling state - prevent overlapping requests
let chatPollInFlight = false;
let gamePollInFlight = false;

// Callbacks for UI updates
let onLobbyUpdate = null;
let onSpectateUpdate = null;
let onGameUpdate = null;
let onWordSelectUpdate = null;
let onSingleplayerLobbyUpdate = null;
let onChatUpdate = null;

/**
 * Set callback for lobby updates
 * @param {Function} callback
 */
export function setLobbyCallback(callback) {
    onLobbyUpdate = callback;
}

/**
 * Set callback for spectate list updates
 * @param {Function} callback
 */
export function setSpectateCallback(callback) {
    onSpectateUpdate = callback;
}

/**
 * Set callback for game updates
 * @param {Function} callback
 */
export function setGameCallback(callback) {
    onGameUpdate = callback;
}

/**
 * Set callback for word selection updates
 * @param {Function} callback
 */
export function setWordSelectCallback(callback) {
    onWordSelectUpdate = callback;
}

/**
 * Set callback for singleplayer lobby updates
 * @param {Function} callback
 */
export function setSingleplayerLobbyCallback(callback) {
    onSingleplayerLobbyUpdate = callback;
}

/**
 * Set callback for chat updates
 * @param {Function} callback
 */
export function setChatCallback(callback) {
    onChatUpdate = callback;
}

// ============ LOBBY POLLING ============

/**
 * Start lobby refresh polling
 * @param {number} interval - Interval in ms
 */
export function startLobbyRefresh(interval = 3000) {
    stopLobbyRefresh();
    pollLobbiesOnce();
    lobbyRefreshInterval = setInterval(pollLobbiesOnce, interval);
}

/**
 * Stop lobby refresh polling
 */
export function stopLobbyRefresh() {
    if (lobbyRefreshInterval) {
        clearInterval(lobbyRefreshInterval);
        lobbyRefreshInterval = null;
    }
}

/**
 * Poll lobbies once
 */
async function pollLobbiesOnce() {
    try {
        const data = await lobbies.list();
        if (onLobbyUpdate) onLobbyUpdate(data);
    } catch (e) {
        console.error('Lobby poll error:', e);
    }
}

// ============ SPECTATE LIST POLLING ============

/**
 * Start spectate games refresh polling
 * @param {number} interval
 */
export function startSpectateRefresh(interval = 3000) {
    stopSpectateRefresh();
    pollSpectateOnce();
    spectateRefreshInterval = setInterval(pollSpectateOnce, interval);
}

/**
 * Stop spectate refresh polling
 */
export function stopSpectateRefresh() {
    if (spectateRefreshInterval) {
        clearInterval(spectateRefreshInterval);
        spectateRefreshInterval = null;
    }
}

/**
 * Poll spectateable games once
 */
async function pollSpectateOnce() {
    try {
        const data = await lobbies.spectateable();
        if (onSpectateUpdate) onSpectateUpdate(data);
    } catch (e) {
        console.error('Spectate poll error:', e);
    }
}

// ============ GAME POLLING ============

/**
 * Start game state polling
 * @param {number} interval
 */
export function startGamePolling(interval = 2000) {
    stopGamePolling();
    pollGameOnce();
    gamePollingInterval = setInterval(pollGameOnce, interval);
}

/**
 * Stop game polling
 */
export function stopGamePolling() {
    if (gamePollingInterval) {
        clearInterval(gamePollingInterval);
        gamePollingInterval = null;
    }
}

/**
 * Poll game state once
 */
async function pollGameOnce() {
    const code = gameState.code;
    const playerId = gameState.playerId;
    
    if (!code) return;
    if (gamePollInFlight) return;  // Prevent overlapping requests
    
    gamePollInFlight = true;
    
    try {
        let game;
        if (gameState.isSpectator) {
            game = await games.spectate(code);
        } else if (playerId) {
            game = await games.get(code, playerId);
        } else {
            return;
        }
        
        if (onGameUpdate) onGameUpdate(game);
        
        // Also poll chat
        pollChatOnce();
    } catch (e) {
        console.error('Game poll error:', e);
    } finally {
        gamePollInFlight = false;
    }
}

// ============ WORD SELECT POLLING ============

/**
 * Start word selection polling
 * @param {number} interval
 */
export function startWordSelectPolling(interval = 2000) {
    stopWordSelectPolling();
    wordSelectPollingInterval = setInterval(pollWordSelectOnce, interval);
}

/**
 * Stop word selection polling
 */
export function stopWordSelectPolling() {
    if (wordSelectPollingInterval) {
        clearInterval(wordSelectPollingInterval);
        wordSelectPollingInterval = null;
    }
}

/**
 * Poll word selection state once
 */
async function pollWordSelectOnce() {
    const code = gameState.code;
    const playerId = gameState.playerId;
    
    if (!code || !playerId) return;
    
    try {
        const game = await games.get(code, playerId);
        if (onWordSelectUpdate) onWordSelectUpdate(game);
    } catch (e) {
        console.error('Word select poll error:', e);
    }
}

// ============ SINGLEPLAYER LOBBY POLLING ============

/**
 * Start singleplayer lobby polling
 * @param {number} interval
 */
export function startSingleplayerLobbyPolling(interval = 2000) {
    stopSingleplayerLobbyPolling();
    singleplayerLobbyPollingInterval = setInterval(pollSingleplayerLobbyOnce, interval);
}

/**
 * Stop singleplayer lobby polling
 */
export function stopSingleplayerLobbyPolling() {
    if (singleplayerLobbyPollingInterval) {
        clearInterval(singleplayerLobbyPollingInterval);
        singleplayerLobbyPollingInterval = null;
    }
}

/**
 * Poll singleplayer lobby state once
 */
async function pollSingleplayerLobbyOnce() {
    const code = gameState.code;
    const playerId = gameState.playerId;
    
    if (!code || !playerId) return;
    
    try {
        const data = await games.get(code, playerId);
        if (onSingleplayerLobbyUpdate) onSingleplayerLobbyUpdate(data);
    } catch (e) {
        console.error('Singleplayer lobby poll error:', e);
    }
}

// ============ CHAT POLLING ============

/**
 * Poll chat messages once
 */
export async function pollChatOnce() {
    if (!optionsState.chatEnabled) return;
    if (!gameState.code) return;
    if (chatPollInFlight) return;
    
    chatPollInFlight = true;
    
    try {
        chatState.resetIfNeeded(gameState.code);
        const res = await chat.get(gameState.code, chatState.getLastId(), 50);
        const msgs = Array.isArray(res?.messages) ? res.messages : [];
        
        if (msgs.length) {
            chatState.addMessages(msgs, res?.last_id);
            if (onChatUpdate) onChatUpdate(chatState.getState());
        }
    } catch (e) {
        // Ignore chat polling failures
    } finally {
        chatPollInFlight = false;
    }
}

// ============ STOP ALL ============

/**
 * Stop all polling
 */
export function stopAllPolling() {
    stopLobbyRefresh();
    stopSpectateRefresh();
    stopGamePolling();
    stopWordSelectPolling();
    stopSingleplayerLobbyPolling();
}

export default {
    setLobbyCallback,
    setSpectateCallback,
    setGameCallback,
    setWordSelectCallback,
    setSingleplayerLobbyCallback,
    setChatCallback,
    startLobbyRefresh,
    stopLobbyRefresh,
    startSpectateRefresh,
    stopSpectateRefresh,
    startGamePolling,
    stopGamePolling,
    startWordSelectPolling,
    stopWordSelectPolling,
    startSingleplayerLobbyPolling,
    stopSingleplayerLobbyPolling,
    pollChatOnce,
    stopAllPolling,
};

