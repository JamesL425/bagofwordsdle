/**
 * Singleplayer Logic
 * Handles AI turns and singleplayer-specific functionality
 */

import { singleplayer } from '../services/api.js';
import { gameState } from '../state/gameState.js';

// AI turn state
let aiTurnInFlight = false;
let aiWordPickInFlight = false;

/**
 * Check if it's an AI's turn
 * @param {Object} game
 * @returns {boolean}
 */
export function isAiTurn(game) {
    if (!game || game.status !== 'playing') return false;
    if (!game.all_words_set) return false;
    const currentPlayer = game.players?.find(p => p.id === game.current_player_id);
    return currentPlayer?.is_ai === true;
}

/**
 * Check if any AI needs to pick a word
 * @param {Object} game
 * @returns {boolean}
 */
export function hasAiNeedingWordPick(game) {
    if (!game) return false;
    // AI word picks happen during word_selection status
    if (game.status !== 'word_selection') return false;
    return game.players?.some(p => p.is_ai && !p.has_word);
}

/**
 * Check if any AI needs to change word
 * @param {Object} game
 * @returns {boolean}
 */
export function hasAiNeedingWordChange(game) {
    if (!game || game.status !== 'playing') return false;
    if (!game.waiting_for_word_change) return false;
    const waitingPlayer = game.players?.find(p => p.id === game.waiting_for_word_change);
    return waitingPlayer?.is_ai === true;
}

/**
 * Trigger AI word pick if needed
 * @param {Object} game
 */
export async function maybeTriggerAiWordPick(game) {
    if (!gameState.isSingleplayer) return;
    if (aiWordPickInFlight) return;
    if (!hasAiNeedingWordPick(game)) return;
    
    aiWordPickInFlight = true;
    try {
        await singleplayer.aiWordPick(gameState.code, gameState.playerId);
    } catch (e) {
        console.error('AI word pick error:', e);
    } finally {
        aiWordPickInFlight = false;
    }
}

/**
 * Run AI turns if needed
 * @param {Object} game
 */
export async function maybeRunAiTurns(game) {
    if (!gameState.isSingleplayer) return;
    if (aiTurnInFlight) return;
    if (game.status !== 'playing') return;
    if (!game.all_words_set) return;
    
    // Handle AI word change
    if (hasAiNeedingWordChange(game)) {
        aiTurnInFlight = true;
        try {
            await singleplayer.aiWordChange(gameState.code, gameState.playerId);
        } catch (e) {
            console.error('AI word change error:', e);
        } finally {
            aiTurnInFlight = false;
        }
        return;
    }
    
    // Handle AI turn
    if (isAiTurn(game)) {
        aiTurnInFlight = true;
        try {
            // Minimal delay for UI responsiveness (reduced from 500-1500ms)
            await sleep(100);
            await singleplayer.aiTurn(gameState.code, gameState.playerId);
        } catch (e) {
            console.error('AI turn error:', e);
        } finally {
            aiTurnInFlight = false;
        }
    }
}

/**
 * Sleep helper
 * @param {number} ms
 * @returns {Promise}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get AI difficulty info
 * @param {string} key
 * @returns {Object}
 */
export function getAiDifficultyInfo(key) {
    const difficulties = {
        rookie: { 
            name: 'Rookie', 
            desc: 'Friendly newcomer who makes obvious mistakes and thinks slowly', 
            color: '#4CAF50' 
        },
        analyst: { 
            name: 'Analyst', 
            desc: 'Thoughtful player who occasionally overthinks decisions', 
            color: '#2196F3' 
        },
        'field-agent': { 
            name: 'Field Agent', 
            desc: 'Experienced player with good instincts and occasional clutch plays', 
            color: '#FF9800' 
        },
        spymaster: { 
            name: 'Spymaster', 
            desc: 'Veteran player who makes calculated moves and rarely errors', 
            color: '#9C27B0' 
        },
        ghost: { 
            name: 'Ghost', 
            desc: 'Expert player with intimidating reads - almost psychic', 
            color: '#F44336' 
        },
    };
    return difficulties[key] || difficulties.rookie;
}

export default {
    isAiTurn,
    hasAiNeedingWordPick,
    hasAiNeedingWordChange,
    maybeTriggerAiWordPick,
    maybeRunAiTurns,
    getAiDifficultyInfo,
};

