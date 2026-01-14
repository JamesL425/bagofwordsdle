/**
 * Game Controller
 * Main game logic coordination
 */

import { escapeHtml } from '../utils/dom.js';
import { games } from '../services/api.js';
import { gameState } from '../state/gameState.js';
import { showError, showSuccess } from '../ui/toast.js';
import * as screens from '../ui/screens.js';
import * as playerCards from './playerCards.js';
import * as history from './history.js';
import * as singleplayer from './singleplayer.js';

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
}

export default {
    updateTurnIndicator,
    updateSidebarMeta,
    submitGuess,
    submitWordChange,
    skipWordChange,
    updateGame,
    init,
};

