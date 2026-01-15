/**
 * Player Cards Rendering
 * Renders player cards in the game grid
 */

import { escapeHtml } from '../utils/dom.js';
import { gameState } from '../state/gameState.js';

// ============ SIMILARITY TRANSFORM ============
// Transform raw cosine similarity to more intuitive display values
// Uses sigmoid-like function: t(s) = s^n / (s^n + (c*(1-s))^n) where c = m/(1-m)
const SIMILARITY_TRANSFORM = {
    n: 3,      // Exponent - controls curve steepness
    m: 0.36    // Midpoint - raw value that maps to 50% transformed
};

/**
 * Transform raw cosine similarity to display value
 * @param {number} s - Raw cosine similarity (0-1)
 * @returns {number} - Transformed similarity (0-1)
 */
export function transformSimilarity(s) {
    const { n, m } = SIMILARITY_TRANSFORM;
    const c = m / (1 - m);
    const sn = Math.pow(s, n);
    const cn = Math.pow(c * (1 - s), n);
    return sn / (sn + cn);
}

// Profile click callback
let onProfileClick = null;

/**
 * Set profile click callback
 * @param {Function} callback
 */
export function setProfileCallback(callback) {
    onProfileClick = callback;
}

/**
 * Get CSS classes for player card based on cosmetics
 * @param {Object} cosmetics
 * @returns {string}
 */
export function getPlayerCardClasses(cosmetics) {
    if (!cosmetics) return '';
    const classes = [];
    if (cosmetics.card_border && cosmetics.card_border !== 'classic') {
        classes.push(`border-${cosmetics.card_border}`);
    }
    if (cosmetics.card_background && cosmetics.card_background !== 'default') {
        classes.push(`bg-${cosmetics.card_background}`);
    }
    if (cosmetics.turn_indicator && cosmetics.turn_indicator !== 'classic') {
        classes.push(`turn-${cosmetics.turn_indicator}`);
    }
    return classes.join(' ');
}

/**
 * Get data attributes for player card
 * @param {Object} cosmetics
 * @returns {Object}
 */
export function getPlayerCardDataAttrs(cosmetics) {
    if (!cosmetics) return {};
    const attrs = {};
    if (cosmetics.profile_banner && cosmetics.profile_banner !== 'none') {
        attrs['data-banner'] = cosmetics.profile_banner;
    }
    return attrs;
}

/**
 * Get CSS class for name color
 * @param {Object} cosmetics
 * @returns {string}
 */
export function getNameColorClass(cosmetics) {
    if (!cosmetics || !cosmetics.name_color || cosmetics.name_color === 'default') return '';
    return `name-${cosmetics.name_color}`;
}

/**
 * Get badge HTML
 * @param {Object} cosmetics
 * @returns {string}
 */
export function getBadgeHtml(cosmetics) {
    if (!cosmetics || !cosmetics.badge || cosmetics.badge === 'none') return '';
    const badges = {
        coffee: '☕', diamond: '💎', star: '⭐', rookie: '🔰',
        hunter: '⚔️', assassin: '🗡️', executioner: '☠️', victor: '🎖️',
        champion: '🏆', legend: '👑', veteran: '🎗️', rank_bronze: '🥉',
        rank_silver: '🥈', rank_gold: '🥇', rank_platinum: '💠',
        rank_diamond: '🔷', skull: '💀', ghost: '👻', rocket: '🚀',
        hacker: '💻', ghost_protocol: '🕵️', overlord: '🦅', dragon: '🐉',
        alien: '👽', heart: '❤️', crown: '👑', lightning: '⚡', flame: '🔥'
    };
    return badges[cosmetics.badge] ? `<span class="player-badge">${badges[cosmetics.badge]}</span>` : '';
}

/**
 * Get similarity display class
 * @param {number} sim - TRANSFORMED similarity value (0-1)
 * @returns {string}
 */
export function getSimilarityClass(sim) {
    // Thresholds for TRANSFORMED similarity values
    if (sim >= 0.95) return 'sim-danger';  // Very close to elimination (~88%+ raw)
    if (sim >= 0.75) return 'sim-high';    // High danger zone (~55%+ raw)
    if (sim >= 0.50) return 'sim-medium';  // Moderate similarity (~37%+ raw)
    return 'sim-low';
}

/**
 * Render player cards grid
 * @param {Object} game - Game state from server
 */
export function render(game) {
    const grid = document.getElementById('players-grid');
    if (!grid) return;
    
    const isSpectator = Boolean(gameState.isSpectator);
    const myPlayerId = gameState.playerId;
    const currentPlayerId = game.current_player_id;
    const lastEntry = game.history?.length > 0 ? game.history[game.history.length - 1] : null;
    
    grid.innerHTML = game.players.map(player => {
        const isMe = player.id === myPlayerId;
        const isCurrentTurn = player.id === currentPlayerId && player.is_alive;
        const isAI = player.is_ai;
        const cosmetics = player.cosmetics || {};
        const cosmeticClasses = getPlayerCardClasses(cosmetics);
        const nameColorClass = getNameColorClass(cosmetics);
        const badgeHtml = getBadgeHtml(cosmetics);
        
        // Build data attributes
        const dataAttrs = getPlayerCardDataAttrs(cosmetics);
        let dataAttrStr = '';
        for (const [key, val] of Object.entries(dataAttrs)) {
            dataAttrStr += ` ${key}="${escapeHtml(val)}"`;
        }
        
        // Status and similarity
        let statusHtml = '';
        let simValue = null;
        
        if (!player.is_alive) {
            const revealedWord = player.secret_word || '???';
            statusHtml = `<div class="status eliminated">ELIMINATED</div>
                          <div class="revealed-word">${escapeHtml(revealedWord)}</div>`;
        } else if (lastEntry && lastEntry.similarities && lastEntry.similarities[player.id] !== undefined) {
            simValue = lastEntry.similarities[player.id];
            const transformedSim = transformSimilarity(simValue);
            const simClass = getSimilarityClass(transformedSim);
            const simPercent = Math.round(transformedSim * 100);
            statusHtml = `<div class="status alive">ACTIVE</div>
                          <div class="similarity ${simClass}">${simPercent}%</div>`;
        } else {
            statusHtml = `<div class="status alive">ACTIVE</div>`;
        }
        
        // Click handler for profile
        const clickable = !isAI && !isMe && onProfileClick ? 'clickable-profile' : '';
        const dataName = !isAI ? `data-player-name="${escapeHtml(player.name)}"` : '';
        
        return `
            <div class="player-card ${cosmeticClasses} ${isCurrentTurn ? 'current-turn' : ''} ${!player.is_alive ? 'eliminated' : ''} ${clickable}"
                 data-player-id="${escapeHtml(player.id)}" ${dataName}${dataAttrStr}>
                <div class="name ${nameColorClass}">
                    ${escapeHtml(player.name)}${badgeHtml}
                    ${isMe && !isSpectator ? '<span class="you-badge">(YOU)</span>' : ''}
                    ${isAI ? '<span class="ai-badge">🤖</span>' : ''}
                </div>
                ${statusHtml}
            </div>
        `;
    }).join('');
    
    // Attach profile click handlers
    if (onProfileClick) {
        grid.querySelectorAll('.clickable-profile').forEach(el => {
            el.addEventListener('click', () => {
                const name = el.dataset.playerName;
                if (name) onProfileClick(name);
            });
        });
    }
}

export default {
    setProfileCallback,
    getPlayerCardClasses,
    getPlayerCardDataAttrs,
    getNameColorClass,
    getBadgeHtml,
    getSimilarityClass,
    transformSimilarity,
    render,
};

