/**
 * Daily State Management
 * Daily quests, wallet, streaks state
 */

// Daily state singleton
const dailyState = {
    panelOpen: false,
    wallet: { credits: 0 },
    quests: [],
    weeklyQuests: [],
    ownedCosmetics: {},
    date: '',
    loading: false,
    streak: {
        streak_count: 0,
        streak_last_date: '',
        longest_streak: 0,
        streak_claimed_today: false,
    },
    streakCreditsEarned: 0,
    streakMilestoneBonus: 0,
    streakBroken: false,
    streakInfo: {
        current_daily_credits: 15,
        next_multiplier_day: null,
        next_multiplier_credits: 15,
        next_milestone_day: null,
        next_milestone_bonus: 0,
    },
};

// Change listeners
const listeners = new Set();

/**
 * Subscribe to daily state changes
 * @param {Function} callback
 * @returns {Function} - Unsubscribe function
 */
export function subscribe(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
}

/**
 * Notify listeners
 */
function notify() {
    listeners.forEach(cb => {
        try {
            cb(dailyState);
        } catch (e) {
            console.error('Daily listener error:', e);
        }
    });
}

/**
 * Get daily state
 * @returns {Object}
 */
export function getState() {
    return { ...dailyState };
}

/**
 * Update daily state from server response
 * @param {Object} data - Server response data
 */
export function updateFromServer(data) {
    dailyState.wallet = data.wallet || { credits: 0 };
    dailyState.quests = data.quests || [];
    dailyState.weeklyQuests = data.weekly_quests || [];
    dailyState.date = data.date || '';
    dailyState.ownedCosmetics = data.owned_cosmetics || {};
    
    dailyState.streak = data.streak || {
        streak_count: 0,
        streak_last_date: '',
        longest_streak: 0,
        streak_claimed_today: false,
    };
    dailyState.streakCreditsEarned = data.streak_credits_earned || 0;
    dailyState.streakMilestoneBonus = data.streak_milestone_bonus || 0;
    dailyState.streakBroken = data.streak_broken || false;
    dailyState.streakInfo = data.streak_info || {
        current_daily_credits: 15,
        next_multiplier_day: null,
        next_multiplier_credits: 15,
        next_milestone_day: null,
        next_milestone_bonus: 0,
    };
    
    notify();
}

/**
 * Update wallet
 * @param {Object} wallet
 */
export function setWallet(wallet) {
    dailyState.wallet = wallet || { credits: 0 };
    notify();
}

/**
 * Update owned cosmetics
 * @param {Object} owned
 */
export function setOwnedCosmetics(owned) {
    dailyState.ownedCosmetics = owned || {};
    notify();
}

/**
 * Mark a quest as claimed
 * @param {string} questId
 * @param {string} questType - 'daily' or 'weekly'
 */
export function markQuestClaimed(questId, questType = 'daily') {
    const questList = questType === 'weekly' ? dailyState.weeklyQuests : dailyState.quests;
    const quest = questList.find(q => q.id === questId);
    if (quest) {
        quest.claimed = true;
        notify();
    }
}

/**
 * Set loading state
 * @param {boolean} loading
 */
export function setLoading(loading) {
    dailyState.loading = loading;
}

/**
 * Check if loading
 * @returns {boolean}
 */
export function isLoading() {
    return dailyState.loading;
}

/**
 * Set panel open state
 * @param {boolean} open
 */
export function setPanelOpen(open) {
    dailyState.panelOpen = open;
}

/**
 * Check if panel is open
 * @returns {boolean}
 */
export function isPanelOpen() {
    return dailyState.panelOpen;
}

/**
 * Get credits
 * @returns {number}
 */
export function getCredits() {
    return dailyState.wallet?.credits || 0;
}

/**
 * Get streak count
 * @returns {number}
 */
export function getStreakCount() {
    return dailyState.streak?.streak_count || 0;
}

/**
 * Check if user owns a cosmetic
 * @param {string} categoryKey
 * @param {string} cosmeticId
 * @returns {boolean}
 */
export function ownsCosmetic(categoryKey, cosmeticId) {
    const owned = dailyState.ownedCosmetics[categoryKey];
    if (!Array.isArray(owned)) return false;
    return owned.includes(cosmeticId);
}

// Export raw state for legacy compatibility
export { dailyState };

// Expose to window for legacy app.js compatibility
if (typeof window !== 'undefined') {
    window.dailyState = dailyState;
}
