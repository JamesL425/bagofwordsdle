/**
 * Leaderboard UI Component
 * Renders leaderboard tables
 */

import { escapeHtml } from '../utils/dom.js';
import { leaderboard as leaderboardApi, profile as profileApi } from '../services/api.js';

// Leaderboard state
let leaderboardState = {
    mode: 'casual',
    casualType: 'alltime'
};

// Profile modal callback
let onProfileClick = null;

/**
 * Set profile click callback
 * @param {Function} callback
 */
export function setProfileCallback(callback) {
    onProfileClick = callback;
}

/**
 * Get rank tier from MMR
 * @param {number} mmr
 * @returns {Object}
 */
export function getRankTier(mmr) {
    const v = Number(mmr || 0);
    if (v >= 2000) return { key: 'master', name: 'MASTER' };
    if (v >= 1800) return { key: 'diamond', name: 'DIAMOND' };
    if (v >= 1600) return { key: 'platinum', name: 'PLATINUM' };
    if (v >= 1400) return { key: 'gold', name: 'GOLD' };
    if (v >= 1200) return { key: 'silver', name: 'SILVER' };
    if (v >= 1000) return { key: 'bronze', name: 'BRONZE' };
    return { key: 'unranked', name: 'UNRANKED' };
}

/**
 * Render rank badge HTML
 * @param {Object} tier
 * @returns {string}
 */
export function renderRankBadge(tier) {
    if (!tier) return '';
    const key = String(tier.key || 'unranked').toLowerCase();
    const name = String(tier.name || 'UNRANKED');
    return `<span class="rank-badge rank-${escapeHtml(key)}">${escapeHtml(name)}</span>`;
}

/**
 * Set leaderboard mode
 * @param {string} mode - 'casual' or 'ranked'
 */
export function setMode(mode) {
    leaderboardState.mode = mode;
    document.getElementById('lb-casual-panel')?.classList.toggle('hidden', mode !== 'casual');
    document.getElementById('lb-ranked-panel')?.classList.toggle('hidden', mode !== 'ranked');

    const casualBtn = document.getElementById('lb-tab-casual');
    const rankedBtn = document.getElementById('lb-tab-ranked');
    if (casualBtn) {
        casualBtn.classList.toggle('btn-primary', mode === 'casual');
        casualBtn.classList.toggle('btn-secondary', mode !== 'casual');
    }
    if (rankedBtn) {
        rankedBtn.classList.toggle('btn-primary', mode === 'ranked');
        rankedBtn.classList.toggle('btn-secondary', mode !== 'ranked');
    }

    if (mode === 'casual') {
        loadCasual(leaderboardState.casualType);
    } else {
        loadRanked();
    }
}

/**
 * Set casual leaderboard type
 * @param {string} type - 'alltime' or 'weekly'
 */
export function setCasualType(type) {
    leaderboardState.casualType = type;
    const allBtn = document.getElementById('lb-casual-alltime');
    const wkBtn = document.getElementById('lb-casual-weekly');
    if (allBtn) {
        allBtn.classList.toggle('btn-primary', type === 'alltime');
        allBtn.classList.toggle('btn-ghost', type !== 'alltime');
    }
    if (wkBtn) {
        wkBtn.classList.toggle('btn-primary', type === 'weekly');
        wkBtn.classList.toggle('btn-ghost', type !== 'weekly');
    }
    loadCasual(type);
}

/**
 * Render leaderboard table
 * @param {string} containerId
 * @param {Array} headers
 * @param {string} rowsHtml
 */
function renderTable(containerId, headers, rowsHtml) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!rowsHtml) {
        container.innerHTML = '<div class="leaderboard-empty">No data yet.</div>';
        return;
    }
    container.innerHTML = `
        <table class="leaderboard-table">
            <thead>
                <tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
        </table>
    `;
}

/**
 * Add click handlers for profile viewing
 * @param {HTMLElement} container
 */
function attachProfileHandlers(container) {
    if (!container || !onProfileClick) return;
    container.querySelectorAll('.clickable-profile').forEach(el => {
        el.addEventListener('click', () => {
            const name = el.dataset.playerName;
            if (name) onProfileClick(name);
        });
    });
}

/**
 * Load casual leaderboard
 * @param {string} type
 */
export async function loadCasual(type = 'alltime') {
    const container = document.getElementById('casual-leaderboard-table');
    if (container) container.innerHTML = '<div class="leaderboard-empty">Loading...</div>';
    
    try {
        const data = await leaderboardApi.casual(type);
        const players = Array.isArray(data?.players) ? data.players : [];
        const headers = type === 'weekly'
            ? ['Rank', 'Player', 'Weekly wins', 'All-time wins', 'Games', 'Win%']
            : ['Rank', 'Player', 'Wins', 'Games', 'Win%'];

        const rows = players.map((p, idx) => {
            const wins = Number(p?.wins || 0);
            const games = Number(p?.games_played || 0);
            const winRate = games > 0 ? Math.round((wins / games) * 100) : 0;
            const weeklyWins = Number(p?.weekly_wins || 0);
            const rankClass = idx === 0 ? 'rank-1' : idx === 1 ? 'rank-2' : idx === 2 ? 'rank-3' : '';
            const playerName = p?.name || '';

            if (type === 'weekly') {
                return `<tr class="clickable-profile" data-player-name="${escapeHtml(playerName)}">
                    <td class="rank ${rankClass}">${escapeHtml(idx + 1)}</td>
                    <td class="player-name">${escapeHtml(playerName)}</td>
                    <td class="stat">${escapeHtml(weeklyWins)}</td>
                    <td class="stat">${escapeHtml(wins)}</td>
                    <td class="stat">${escapeHtml(games)}</td>
                    <td class="win-rate">${escapeHtml(winRate)}%</td>
                </tr>`;
            }
            return `<tr class="clickable-profile" data-player-name="${escapeHtml(playerName)}">
                <td class="rank ${rankClass}">${escapeHtml(idx + 1)}</td>
                <td class="player-name">${escapeHtml(playerName)}</td>
                <td class="stat">${escapeHtml(wins)}</td>
                <td class="stat">${escapeHtml(games)}</td>
                <td class="win-rate">${escapeHtml(winRate)}%</td>
            </tr>`;
        }).join('');

        renderTable('casual-leaderboard-table', headers, rows);
        attachProfileHandlers(container);
    } catch (e) {
        renderTable('casual-leaderboard-table', ['Rank', 'Player', 'Wins'], '');
    }
}

/**
 * Load ranked leaderboard
 */
export async function loadRanked() {
    const container = document.getElementById('ranked-leaderboard-table');
    if (container) container.innerHTML = '<div class="leaderboard-empty">Loading...</div>';
    
    try {
        const data = await leaderboardApi.ranked();
        const players = Array.isArray(data?.players) ? data.players : [];
        const headers = ['Rank', 'Player', 'Tier', 'MMR', 'Peak', 'Games', 'W-L'];

        const rows = players.map((p, idx) => {
            const mmr = Number(p?.mmr || 0);
            const peak = Number(p?.peak_mmr || 0);
            const games = Number(p?.ranked_games || 0);
            const wins = Number(p?.ranked_wins || 0);
            const losses = Number(p?.ranked_losses || 0);
            const tier = getRankTier(mmr);
            const rankClass = idx === 0 ? 'rank-1' : idx === 1 ? 'rank-2' : idx === 2 ? 'rank-3' : '';
            const playerName = p?.name || '';
            return `<tr class="clickable-profile" data-player-name="${escapeHtml(playerName)}">
                <td class="rank ${rankClass}">${escapeHtml(idx + 1)}</td>
                <td class="player-name">${escapeHtml(playerName)}</td>
                <td class="stat">${renderRankBadge(tier)}</td>
                <td class="stat">${escapeHtml(mmr)}</td>
                <td class="stat">${escapeHtml(peak)}</td>
                <td class="stat">${escapeHtml(games)}</td>
                <td class="stat">${escapeHtml(wins)}-${escapeHtml(losses)}</td>
            </tr>`;
        }).join('');

        renderTable('ranked-leaderboard-table', headers, rows);
        attachProfileHandlers(container);
    } catch (e) {
        renderTable('ranked-leaderboard-table', ['Rank', 'Player', 'MMR'], '');
    }
}

/**
 * Load mini leaderboard for home screen
 * Shows ranked (by ELO) first, then casual (by wins) below
 */
export async function loadMini() {
    const container = document.getElementById('mini-leaderboard');
    if (!container) return;
    
    try {
        // Fetch both ranked and casual leaderboards in parallel
        const [rankedData, casualData] = await Promise.all([
            leaderboardApi.ranked().catch(() => ({ players: [] })),
            leaderboardApi.casual('alltime').catch(() => ({ players: [] }))
        ]);
        
        const rankedPlayers = Array.isArray(rankedData?.players) ? rankedData.players.slice(0, 5) : [];
        const casualPlayers = Array.isArray(casualData?.players) ? casualData.players.slice(0, 5) : [];
        
        if (rankedPlayers.length === 0 && casualPlayers.length === 0) {
            container.innerHTML = '<p class="loading-lobbies">No data yet.</p>';
            return;
        }
        
        let html = '';
        
        // Ranked section (by ELO/MMR)
        if (rankedPlayers.length > 0) {
            html += '<div class="mini-lb-section">';
            html += '<div class="mini-lb-section-header">RANKED</div>';
            rankedPlayers.forEach((p, idx) => {
                const mmr = Number(p?.mmr || 0);
                const isTop3 = idx < 3;
                const playerName = p?.name || 'Unknown';
                const tier = getRankTier(mmr);
                html += `<div class="mini-lb-entry mini-lb-ranked ${isTop3 ? 'top-3' : ''} clickable-profile" data-player-name="${escapeHtml(playerName)}">
                    <span class="mini-lb-rank">#${idx + 1}</span>
                    <span class="mini-lb-name">${escapeHtml(playerName)}</span>
                    <span class="mini-lb-mmr rank-${tier.key}">${mmr}</span>
                </div>`;
            });
            html += '</div>';
        }
        
        // Casual section (by wins)
        if (casualPlayers.length > 0) {
            html += '<div class="mini-lb-section">';
            html += '<div class="mini-lb-section-header">CASUAL</div>';
            casualPlayers.forEach((p, idx) => {
                const wins = Number(p?.wins || 0);
                const isTop3 = idx < 3;
                const playerName = p?.name || 'Unknown';
                html += `<div class="mini-lb-entry mini-lb-casual ${isTop3 ? 'top-3' : ''} clickable-profile" data-player-name="${escapeHtml(playerName)}">
                    <span class="mini-lb-rank">#${idx + 1}</span>
                    <span class="mini-lb-name">${escapeHtml(playerName)}</span>
                    <span class="mini-lb-wins">${wins} wins</span>
                </div>`;
            });
            html += '</div>';
        }
        
        container.innerHTML = html;
        attachProfileHandlers(container);
    } catch (e) {
        container.innerHTML = '<p class="loading-lobbies">Failed to load.</p>';
    }
}

/**
 * Get current state
 * @returns {Object}
 */
export function getState() {
    return { ...leaderboardState };
}

export default {
    setProfileCallback,
    getRankTier,
    renderRankBadge,
    setMode,
    setCasualType,
    loadCasual,
    loadRanked,
    loadMini,
    getState,
};

