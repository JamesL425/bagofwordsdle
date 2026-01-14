/**
 * Cosmetics State Management
 * Cosmetic catalog and user cosmetics state
 */

// Cosmetics state singleton
const cosmeticsState = {
    catalog: null,
    userCosmetics: null,
    ownedCosmetics: {},
    isDonor: false,
    isAdmin: false,
    paywallEnabled: false,
    unlockAll: false,
    panelOpen: false,
};

// Change listeners
const listeners = new Set();

/**
 * Subscribe to cosmetics state changes
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
            cb(cosmeticsState);
        } catch (e) {
            console.error('Cosmetics listener error:', e);
        }
    });
}

/**
 * Get cosmetics state
 * @returns {Object}
 */
export function getState() {
    return { ...cosmeticsState };
}

/**
 * Set catalog from server
 * @param {Object} catalog
 * @param {boolean} paywallEnabled
 * @param {boolean} unlockAll
 */
export function setCatalog(catalog, paywallEnabled, unlockAll) {
    cosmeticsState.catalog = catalog;
    cosmeticsState.paywallEnabled = Boolean(paywallEnabled);
    cosmeticsState.unlockAll = Boolean(unlockAll);
    notify();
}

/**
 * Update user cosmetics from server
 * @param {Object} data - Server response
 */
export function updateUserCosmetics(data) {
    cosmeticsState.userCosmetics = data.cosmetics;
    cosmeticsState.isDonor = data.is_donor;
    cosmeticsState.isAdmin = data.is_admin;
    cosmeticsState.ownedCosmetics = data.owned_cosmetics || {};
    if (typeof data.paywall_enabled === 'boolean') {
        cosmeticsState.paywallEnabled = data.paywall_enabled;
    }
    if (typeof data.unlock_all === 'boolean') {
        cosmeticsState.unlockAll = data.unlock_all;
    }
    notify();
}

/**
 * Set equipped cosmetics
 * @param {Object} cosmetics
 */
export function setEquipped(cosmetics) {
    cosmeticsState.userCosmetics = cosmetics;
    notify();
}

/**
 * Set panel open state
 * @param {boolean} open
 */
export function setPanelOpen(open) {
    cosmeticsState.panelOpen = open;
}

/**
 * Check if panel is open
 * @returns {boolean}
 */
export function isPanelOpen() {
    return cosmeticsState.panelOpen;
}

/**
 * Get catalog
 * @returns {Object|null}
 */
export function getCatalog() {
    return cosmeticsState.catalog;
}

/**
 * Get user's equipped cosmetics
 * @returns {Object|null}
 */
export function getEquipped() {
    return cosmeticsState.userCosmetics;
}

/**
 * Check if user has full access (donor/admin/unlock_all)
 * @returns {boolean}
 */
export function hasFullAccess() {
    return cosmeticsState.unlockAll || 
           !cosmeticsState.paywallEnabled || 
           cosmeticsState.isDonor || 
           cosmeticsState.isAdmin;
}

/**
 * Check if user is donor
 * @returns {boolean}
 */
export function isDonor() {
    return cosmeticsState.isDonor;
}

/**
 * Check if user is admin
 * @returns {boolean}
 */
export function isAdmin() {
    return cosmeticsState.isAdmin;
}

/**
 * Check if paywall is enabled
 * @returns {boolean}
 */
export function isPaywallEnabled() {
    return cosmeticsState.paywallEnabled;
}

/**
 * Check if all cosmetics are unlocked
 * @returns {boolean}
 */
export function isUnlockAll() {
    return cosmeticsState.unlockAll;
}

/**
 * Get owned cosmetics
 * @returns {Object}
 */
export function getOwned() {
    return cosmeticsState.ownedCosmetics;
}

/**
 * Check if user owns a specific cosmetic
 * @param {string} categoryKey
 * @param {string} cosmeticId
 * @returns {boolean}
 */
export function ownsCosmetic(categoryKey, cosmeticId) {
    const owned = cosmeticsState.ownedCosmetics[categoryKey];
    if (!Array.isArray(owned)) return false;
    return owned.includes(cosmeticId);
}

// Export raw state for legacy compatibility
export { cosmeticsState };

