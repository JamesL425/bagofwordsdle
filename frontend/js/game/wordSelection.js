/**
 * Word Selection Screen
 * Handles the word selection phase of the game
 */

import { escapeHtml } from '../utils/dom.js';
import { games } from '../services/api.js';
import { gameState } from '../state/gameState.js';
import { showError } from '../ui/toast.js';
import * as screens from '../ui/screens.js';
import * as singleplayer from './singleplayer.js';

// Selected word state
let selectedWord = null;

/**
 * Show word selection screen
 * @param {Object} game - Game state from server
 */
export function show(game) {
    const myPlayer = game.players.find(p => p.id === gameState.playerId);
    if (!myPlayer) return;
    
    // Store word pool
    gameState.wordPool = myPlayer.word_pool || [];
    gameState.theme = game.theme;
    
    // Update theme display
    document.getElementById('wordselect-theme-name').textContent = game.theme?.name || 'Unknown Theme';
    
    // Render word options
    renderWordOptions(myPlayer.word_pool || []);
    
    // Reset selection state
    selectedWord = null;
    document.getElementById('selected-word-display').textContent = 'Click a word above';
    document.getElementById('selected-word-display').dataset.word = '';
    
    // Show controls, hide locked notice
    document.getElementById('word-select-controls').classList.remove('hidden');
    document.getElementById('word-locked-notice').classList.add('hidden');
    
    // Show screen
    screens.show('wordselect');
}

/**
 * Render word options grid
 * @param {Array} words
 */
function renderWordOptions(words) {
    const container = document.getElementById('word-options');
    if (!container) return;
    
    const sortedWords = [...words].sort((a, b) => a.localeCompare(b));
    
    container.innerHTML = sortedWords.map(word => `
        <div class="word-option" data-word="${escapeHtml(word)}">
            ${escapeHtml(word)}
        </div>
    `).join('');
    
    // Add click handlers
    container.querySelectorAll('.word-option').forEach(el => {
        el.addEventListener('click', () => selectWord(el.dataset.word));
        el.addEventListener('dblclick', () => {
            selectWord(el.dataset.word);
            lockWord();
        });
    });
}

/**
 * Select a word
 * @param {string} word
 */
function selectWord(word) {
    selectedWord = word;
    
    // Update display
    const display = document.getElementById('selected-word-display');
    if (display) {
        display.textContent = word.toUpperCase();
        display.dataset.word = word;
    }
    
    // Update visual selection
    document.querySelectorAll('.word-option').forEach(el => {
        el.classList.toggle('selected', el.dataset.word === word);
    });
}

/**
 * Lock in the selected word
 */
export async function lockWord() {
    const display = document.getElementById('selected-word-display');
    const word = display?.dataset?.word;
    
    if (!word) {
        showError('Please select a word');
        return;
    }
    
    // Optimistic UI update - show locked state immediately before API call
    const wordSelectControls = document.getElementById('word-select-controls');
    const wordLockedNotice = document.getElementById('word-locked-notice');
    const lockedWordDisplay = document.getElementById('locked-word-display');
    const wordOptions = document.querySelectorAll('.word-option');
    
    // Store original state for rollback
    const wasControlsHidden = wordSelectControls?.classList.contains('hidden');
    const wasNoticeHidden = wordLockedNotice?.classList.contains('hidden');
    const originalStyles = Array.from(wordOptions).map(el => ({
        pointerEvents: el.style.pointerEvents,
        opacity: el.style.opacity
    }));
    
    // Apply optimistic update
    wordSelectControls?.classList.add('hidden');
    wordLockedNotice?.classList.remove('hidden');
    if (lockedWordDisplay) lockedWordDisplay.textContent = word.toUpperCase();
    
    wordOptions.forEach(el => {
        el.style.pointerEvents = 'none';
        if (el.dataset.word.toLowerCase() !== word.toLowerCase()) {
            el.style.opacity = '0.3';
        }
    });
    
    try {
        const result = await games.setWord(gameState.code, gameState.playerId, word);
        
        // Use returned game state for immediate UI update (no waiting for poll)
        if (result.players) {
            updateStatus(result);
        }
    } catch (error) {
        // Rollback optimistic update on error
        if (!wasControlsHidden) wordSelectControls?.classList.remove('hidden');
        if (wasNoticeHidden) wordLockedNotice?.classList.add('hidden');
        
        wordOptions.forEach((el, i) => {
            el.style.pointerEvents = originalStyles[i].pointerEvents;
            el.style.opacity = originalStyles[i].opacity;
        });
        
        showError(error.message);
    }
}

/**
 * Update word selection status display
 * @param {Object} game - Game state from server
 */
export function updateStatus(game) {
    const statusList = document.getElementById('wordselect-status-list');
    if (!statusList) return;
    
    const lockedCount = game.players.filter(p => p.has_word).length;
    
    statusList.innerHTML = game.players.map(player => {
        const isLocked = player.has_word;
        const isMe = player.id === gameState.playerId;
        return `
            <div class="status-item ${isLocked ? 'locked' : 'waiting'}">
                <span class="status-name">${escapeHtml(player.name)}${isMe ? ' (you)' : ''}</span>
                <span class="status-indicator">${isLocked ? '✓ LOCKED' : '⏳ SELECTING'}</span>
            </div>
        `;
    }).join('');
    
    // Update host controls
    if (gameState.isHost) {
        document.getElementById('host-begin-controls')?.classList.remove('hidden');
        const beginBtn = document.getElementById('begin-game-btn');
        if (beginBtn) {
            beginBtn.disabled = lockedCount < game.players.length;
        }
    }
    
    // Trigger AI word picks if needed (singleplayer)
    singleplayer.maybeTriggerAiWordPick(game);
}

/**
 * Initialize word selection event handlers
 */
export function init() {
    // Lock word button
    document.getElementById('lock-word-btn')?.addEventListener('click', lockWord);
    
    // Begin game button (host only)
    document.getElementById('begin-game-btn')?.addEventListener('click', async () => {
        try {
            const result = await games.begin(gameState.code, gameState.playerId);
            // Game state returned will trigger screen transition via main.js handleGameUpdate
        } catch (error) {
            showError(error.message);
        }
    });
}

/**
 * Get selected word
 * @returns {string|null}
 */
export function getSelectedWord() {
    return selectedWord;
}

export default {
    show,
    lockWord,
    updateStatus,
    init,
    getSelectedWord,
};

