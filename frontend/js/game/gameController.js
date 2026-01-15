/**
 * Game Controller
 * Main game logic coordination
 */

import { escapeHtml } from '../utils/dom.js';
import { games } from '../services/api.js';
import { gameState } from '../state/gameState.js';
import { optionsState } from '../state/optionsState.js';
import { showError, showSuccess, showInfo } from '../ui/toast.js';
import { playTurnNotificationSfx } from '../utils/audio.js';
import * as screens from '../ui/screens.js';
import * as playerCards from './playerCards.js';
import * as history from './history.js';
import * as singleplayer from './singleplayer.js';

// Track previous turn state for notifications
let previousCurrentPlayerId = null;
let notificationPermissionRequested = false;

/**
 * Request notification permission if needed
 */
async function requestNotificationPermission() {
    if (notificationPermissionRequested) return;
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted' || Notification.permission === 'denied') return;
    
    notificationPermissionRequested = true;
    try {
        await Notification.requestPermission();
    } catch (e) {
        console.warn('Notification permission request failed:', e);
    }
}

/**
 * Show turn notification
 */
function showTurnNotification() {
    if (!optionsState.turnNotificationsEnabled) return;
    
    // Play notification sound
    playTurnNotificationSfx();
    
    // Show toast notification (always, for in-tab feedback)
    showInfo("🎯 It's your turn!");
    
    // Show browser notification if tab is not focused
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        try {
            const notification = new Notification('Embeddle', {
                body: "It's your turn to guess!",
                icon: '/favicon-32.png',
                tag: 'turn-notification', // Prevents duplicate notifications
            });
            
            // Auto-close after 5 seconds
            setTimeout(() => notification.close(), 5000);
            
            // Focus window when clicked
            notification.onclick = () => {
                window.focus();
                notification.close();
            };
        } catch (e) {
            console.warn('Browser notification failed:', e);
        }
    }
}

/**
 * Check for turn change and notify if it's now my turn
 * @param {Object} game - Game state
 */
function checkTurnNotification(game) {
    const isSpectator = Boolean(gameState.isSpectator);
    if (isSpectator) return;
    
    const currentPlayerId = game.current_player_id;
    const myPlayerId = gameState.playerId;
    const myPlayer = game.players?.find(p => p.id === myPlayerId);
    
    // Only notify if:
    // 1. Turn changed from someone else to me
    // 2. I'm alive
    // 3. Game is actively playing (not waiting for word change)
    // 4. All words are set
    const turnChangedToMe = previousCurrentPlayerId !== null &&
                            previousCurrentPlayerId !== myPlayerId &&
                            currentPlayerId === myPlayerId;
    
    const shouldNotify = turnChangedToMe &&
                         myPlayer?.is_alive &&
                         !game.waiting_for_word_change &&
                         game.all_words_set &&
                         game.status === 'playing';
    
    if (shouldNotify) {
        showTurnNotification();
    }
    
    // Update previous state
    previousCurrentPlayerId = currentPlayerId;
}

/**
 * Reset turn tracking (call when leaving/joining games)
 */
export function resetTurnTracking() {
    previousCurrentPlayerId = null;
}

/**
 * Update turn indicator
 * @param {Object} game
 */
export function updateTurnIndicator(game) {
    const indicator = document.getElementById('turn-indicator');
    if (!indicator) return;
    
    const isSpectator = Boolean(gameState.isSpectator);
    const myPlayerId = gameState.playerId;
    const currentPlayer = game.players.find(p => p.id === game.current_player_id);
    
    if (!currentPlayer) {
        indicator.innerHTML = '<span>Waiting...</span>';
        return;
    }
    
    const isMyTurn = !isSpectator && currentPlayer.id === myPlayerId;
    const name = currentPlayer.name || 'Unknown';
    
    if (game.waiting_for_word_change) {
        const waitingPlayer = game.players.find(p => p.id === game.waiting_for_word_change);
        const waitingName = waitingPlayer?.name || 'Someone';
        indicator.innerHTML = `<span class="waiting-for-change">Waiting for ${escapeHtml(waitingName)} to change word...</span>`;
    } else if (isMyTurn) {
        indicator.innerHTML = '<span class="your-turn">YOUR TURN - Make a guess!</span>';
    } else {
        indicator.innerHTML = `<span>${escapeHtml(name)}'s turn</span>`;
    }
}

/**
 * Update sidebar meta info
 * @param {Object} game
 */
export function updateSidebarMeta(game) {
    const turnEl = document.getElementById('turn-number');
    const specEl = document.getElementById('spectator-count');
    if (!turnEl || !specEl) return;

    // Calculate round number based on complete rounds where all alive players have guessed
    const history = Array.isArray(game?.history) ? game.history : [];
    const players = Array.isArray(game?.players) ? game.players : [];
    const totalPlayers = players.length || 1;
    
    // Count guesses per round, accounting for eliminations
    let roundNumber = 1;
    let guessesInCurrentRound = 0;
    let aliveCount = totalPlayers;
    
    for (const entry of history) {
        if (entry.type === 'forfeit' || entry.type === 'word_change') {
            continue;
        }
        
        if (entry.word) {
            guessesInCurrentRound++;
            
            const eliminations = entry.eliminations || [];
            aliveCount -= eliminations.length;
            
            const playersBeforeElim = aliveCount + eliminations.length;
            if (guessesInCurrentRound >= playersBeforeElim) {
                roundNumber++;
                guessesInCurrentRound = 0;
            }
        }
    }
    
    turnEl.textContent = String(roundNumber);
    specEl.textContent = String(game.spectator_count || 0);
}

/**
 * Submit a guess
 */
export async function submitGuess() {
    const input = document.getElementById('guess-input');
    const word = input?.value?.trim();
    
    if (!word) {
        showError('Enter a word to guess');
        return;
    }
    
    // Validate word format
    if (!/^[a-zA-Z]{2,30}$/.test(word)) {
        showError('Word must be 2-30 letters only');
        return;
    }
    
    // Add pending guess for optimistic update
    history.addPendingGuess(word, gameState.playerName);
    input.value = '';
    
    try {
        const result = await games.guess(gameState.code, gameState.playerId, word);
        history.removePendingGuess();
        
        // Check for eliminations
        if (result.eliminations?.length > 0) {
            const names = result.eliminations.map(e => e.name).join(', ');
            showSuccess(`💀 Eliminated: ${names}`);
        }
        
        // Use the full game state from API response immediately (avoids waiting for next poll)
        if (result.players) {
            updateGame(result);
        }
    } catch (error) {
        history.removePendingGuess();
        showError(error.message);
    }
}

/**
 * Submit word change
 */
export async function submitWordChange() {
    const display = document.getElementById('new-word-display');
    const newWord = display?.dataset?.word;
    
    if (!newWord) {
        showError('Please select a new word');
        return;
    }
    
    try {
        await games.changeWord(gameState.code, gameState.playerId, newWord);
        showSuccess('Word changed!');
    } catch (error) {
        showError(error.message);
    }
}

/**
 * Skip word change (keep current word)
 */
export async function skipWordChange() {
    try {
        // Get current word from display
        const currentWord = document.getElementById('your-secret-word')?.textContent;
        if (currentWord) {
            await games.changeWord(gameState.code, gameState.playerId, currentWord);
        }
    } catch (error) {
        showError(error.message);
    }
}

/**
 * Update full game state
 * @param {Object} game
 */
export function updateGame(game) {
    const isSpectator = Boolean(gameState.isSpectator);
    const myPlayer = game.players?.find(p => p.id === gameState.playerId);

    updateSidebarMeta(game);
    
    // Check for turn notifications before updating UI
    checkTurnNotification(game);
    
    // Check if waiting for word selection
    if (!game.all_words_set) {
        const playersWithWords = game.players.filter(p => p.has_word).length;
        const totalPlayers = game.players.length;
        const waitingFor = game.players.filter(p => !p.has_word).map(p => escapeHtml(p.name));
        
        document.getElementById('turn-indicator').innerHTML = `
            <span class="waiting-for-words">
                WAITING FOR WORD SELECTION (${playersWithWords}/${totalPlayers})
                <br><small>Waiting for: ${waitingFor.join(', ') || 'loading...'}</small>
            </span>
        `;
        
        const guessInput = document.getElementById('guess-input');
        const guessBtn = document.querySelector('#guess-form button');
        if (guessInput) guessInput.disabled = true;
        if (guessBtn) guessBtn.disabled = true;
        
        playerCards.render(game);
        return;
    }
    
    // Update player's secret word display
    if (isSpectator) {
        document.getElementById('your-secret-word').textContent = 'SPECTATING';
        document.getElementById('change-word-container')?.classList.add('hidden');
    } else if (myPlayer) {
        document.getElementById('your-secret-word').textContent = myPlayer.secret_word || '???';
        
        // Handle word change UI
        const changeContainer = document.getElementById('change-word-container');
        if (myPlayer.can_change_word) {
            changeContainer?.classList.remove('hidden');
            // Word change options would be rendered here
        } else {
            changeContainer?.classList.add('hidden');
        }
        
        if (myPlayer.word_pool) {
            gameState.wordPool = myPlayer.word_pool;
        }
    }
    
    // Update theme info
    if (game.theme) {
        document.getElementById('game-theme-name').textContent = game.theme.name || '-';
        gameState.allThemeWords = game.theme.words || [];
    }
    
    // Render components
    history.renderWordList(game);
    playerCards.render(game);
    updateTurnIndicator(game);
    history.render(game);
    
    // Handle guess input state
    const isMyTurn = !isSpectator && 
                     game.current_player_id === gameState.playerId && 
                     myPlayer?.is_alive && 
                     !game.waiting_for_word_change;
    
    const guessInput = document.getElementById('guess-input');
    const guessBtn = document.querySelector('#guess-form button');
    if (guessInput) guessInput.disabled = isSpectator || !isMyTurn;
    if (guessBtn) guessBtn.disabled = isSpectator || !isMyTurn;
    
    if (isMyTurn && !game.waiting_for_word_change) {
        const activeEl = document.activeElement;
        const isTypingElsewhere = activeEl && (
            activeEl.tagName === 'INPUT' ||
            activeEl.tagName === 'TEXTAREA' ||
            activeEl.isContentEditable
        );
        if (!isTypingElsewhere && guessInput) {
            guessInput.focus();
        }
    }
    
    // Handle AI turns in singleplayer
    singleplayer.maybeRunAiTurns(game);
}

/**
 * Initialize game controller
 */
export function init() {
    // Guess form
    document.getElementById('guess-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        await submitGuess();
    });
    
    // Word change
    document.getElementById('change-word-btn')?.addEventListener('click', submitWordChange);
    document.getElementById('skip-word-change-btn')?.addEventListener('click', skipWordChange);
    
    // Request notification permission on first user interaction
    document.addEventListener('click', () => {
        if (optionsState.turnNotificationsEnabled) {
            requestNotificationPermission();
        }
    }, { once: true });
}

export default {
    updateTurnIndicator,
    updateSidebarMeta,
    submitGuess,
    submitWordChange,
    skipWordChange,
    updateGame,
    resetTurnTracking,
    init,
};

