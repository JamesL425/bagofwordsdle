/**
 * Game History Rendering
 * Renders the game history log
 */

import { escapeHtml } from '../utils/dom.js';
import { gameState } from '../state/gameState.js';
import { getSimilarityClass } from './playerCards.js';

// Pending guess state
let pendingGuess = null;

/**
 * Add a pending guess to history (optimistic update)
 * @param {string} word
 * @param {string} playerName
 */
export function addPendingGuess(word, playerName) {
    pendingGuess = { word, playerName };
}

/**
 * Remove pending guess
 */
export function removePendingGuess() {
    pendingGuess = null;
}

/**
 * Render game history
 * @param {Object} game - Game state from server
 */
export function render(game) {
    const historyContainer = document.getElementById('history-list');
    if (!historyContainer) return;
    
    const history = game.history || [];
    const myPlayerId = gameState.playerId;
    const isSpectator = Boolean(gameState.isSpectator);
    
    // Build player map for name lookups
    const playerMap = {};
    game.players.forEach(p => {
        playerMap[p.id] = p;
    });
    
    // Track word changes per player
    const lastWordChangeIndex = {};
    history.forEach((entry, idx) => {
        if (entry.type === 'word_change' && entry.player_id) {
            lastWordChangeIndex[entry.player_id] = idx;
        }
    });
    
    let html = '';
    
    // Add pending guess if exists
    if (pendingGuess) {
        html += `
            <div class="history-entry pending">
                <div class="history-word">${escapeHtml(pendingGuess.word.toUpperCase())}</div>
                <div class="history-guesser">by ${escapeHtml(pendingGuess.playerName)}</div>
                <div class="history-pending">Processing...</div>
            </div>
        `;
    }
    
    // Render history in reverse order (newest first)
    for (let i = history.length - 1; i >= 0; i--) {
        const entry = history[i];
        
        if (entry.type === 'word_change') {
            // Word change entry
            const player = playerMap[entry.player_id];
            const playerName = player?.name || 'Unknown';
            html += `
                <div class="history-entry word-change">
                    <div class="history-word">🔄 WORD CHANGED</div>
                    <div class="history-guesser">${escapeHtml(playerName)} changed their word</div>
                </div>
            `;
            continue;
        }
        
        if (entry.type === 'forfeit') {
            // Forfeit entry
            const player = playerMap[entry.player_id];
            const playerName = player?.name || 'Unknown';
            const revealedWord = entry.word || '???';
            html += `
                <div class="history-entry forfeit">
                    <div class="history-word">🏳️ FORFEIT</div>
                    <div class="history-guesser">${escapeHtml(playerName)} revealed: ${escapeHtml(revealedWord.toUpperCase())}</div>
                </div>
            `;
            continue;
        }
        
        // Regular guess entry
        const guesser = playerMap[entry.guesser_id];
        const guesserName = guesser?.name || 'Unknown';
        const word = entry.word || '???';
        const similarities = entry.similarities || {};
        const eliminations = entry.eliminations || [];
        
        // Build similarity breakdown
        let simHtml = '<div class="history-similarities">';
        for (const player of game.players) {
            const sim = similarities[player.id];
            if (sim === undefined) continue;
            
            // Check if this entry is before player's last word change
            const playerLastChange = lastWordChangeIndex[player.id];
            const isStale = playerLastChange !== undefined && i < playerLastChange;
            
            const simPercent = Math.round(sim * 100);
            const simClass = getSimilarityClass(sim);
            const isEliminated = eliminations.includes(player.id);
            const isMe = player.id === myPlayerId && !isSpectator;
            
            simHtml += `
                <span class="history-sim ${simClass} ${isEliminated ? 'eliminated' : ''} ${isStale ? 'stale' : ''} ${isMe ? 'is-me' : ''}">
                    ${escapeHtml(player.name)}: ${simPercent}%
                    ${isEliminated ? ' 💀' : ''}
                    ${isStale ? ' (old)' : ''}
                </span>
            `;
        }
        simHtml += '</div>';
        
        // Elimination notice
        let elimHtml = '';
        if (eliminations.length > 0) {
            const elimNames = eliminations.map(id => playerMap[id]?.name || 'Unknown').join(', ');
            elimHtml = `<div class="history-elimination">💀 Eliminated: ${escapeHtml(elimNames)}</div>`;
        }
        
        html += `
            <div class="history-entry ${eliminations.length > 0 ? 'has-elimination' : ''}">
                <div class="history-word">${escapeHtml(word.toUpperCase())}</div>
                <div class="history-guesser">by ${escapeHtml(guesserName)}</div>
                ${simHtml}
                ${elimHtml}
            </div>
        `;
    }
    
    if (html === '') {
        html = '<div class="history-empty">No guesses yet. Make the first move!</div>';
    }
    
    historyContainer.innerHTML = html;
}

/**
 * Update sidebar word list with highlights
 * @param {Object} game - Game state from server
 */
export function renderWordList(game) {
    const wordlist = document.getElementById('game-wordlist');
    if (!wordlist) return;
    
    const allWords = game.theme?.words || gameState.allThemeWords || [];
    if (allWords.length === 0) return;
    
    // Get guessed words
    const guessedWords = new Set();
    game.history.forEach(entry => {
        if (entry.word) {
            guessedWords.add(entry.word.toLowerCase());
        }
    });
    
    // Get eliminated words (words that caused eliminations)
    const eliminatedWords = new Set();
    game.history.forEach(entry => {
        if (entry.eliminations && entry.eliminations.length > 0 && entry.word) {
            eliminatedWords.add(entry.word.toLowerCase());
        }
    });
    
    // Sort words alphabetically
    const sortedWords = [...allWords].sort((a, b) => a.localeCompare(b));
    
    wordlist.innerHTML = sortedWords.map(word => {
        const lower = word.toLowerCase();
        const isGuessed = guessedWords.has(lower);
        const isEliminated = eliminatedWords.has(lower);
        
        let classes = 'sidebar-word';
        if (isGuessed) classes += ' guessed';
        if (isEliminated) classes += ' eliminated';
        
        return `<span class="${classes}">${escapeHtml(word)}</span>`;
    }).join('');
}

export default {
    addPendingGuess,
    removePendingGuess,
    render,
    renderWordList,
};

