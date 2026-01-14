/**
 * Options State Management
 * User preferences and settings
 */

import { saveOptions as persistOptions, loadOptions as loadPersistedOptions } from '../utils/storage.js';

// Default options
const DEFAULT_OPTIONS = {
    chatEnabled: true,
    musicEnabled: true,
    clickSfxEnabled: false,
    eliminationSfxEnabled: true,
    nerdMode: false,
};

// Options state singleton
let optionsState = { ...DEFAULT_OPTIONS };

// Change listeners
const listeners = new Set();

/**
 * Subscribe to options changes
 * @param {Function} callback
 * @returns {Function} - Unsubscribe function
 */
export function subscribe(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
}

/**
 * Notify listeners of change
 */
function notify() {
    listeners.forEach(cb => {
        try {
            cb(optionsState);
        } catch (e) {
            console.error('Options listener error:', e);
        }
    });
}

/**
 * Get all options
 * @returns {Object}
 */
export function getOptions() {
    return { ...optionsState };
}

/**
 * Get a specific option
 * @param {string} key
 * @returns {*}
 */
export function get(key) {
    return optionsState[key];
}

/**
 * Set a specific option
 * @param {string} key
 * @param {*} value
 */
export function set(key, value) {
    if (optionsState[key] !== value) {
        optionsState[key] = value;
        persistOptions(optionsState);
        notify();
    }
}

/**
 * Update multiple options
 * @param {Object} updates
 */
export function update(updates) {
    let changed = false;
    Object.entries(updates).forEach(([key, value]) => {
        if (optionsState[key] !== value) {
            optionsState[key] = value;
            changed = true;
        }
    });
    if (changed) {
        persistOptions(optionsState);
        notify();
    }
}

/**
 * Load options from localStorage
 */
export function load() {
    optionsState = loadPersistedOptions(DEFAULT_OPTIONS);
}

/**
 * Reset to defaults
 */
export function reset() {
    optionsState = { ...DEFAULT_OPTIONS };
    persistOptions(optionsState);
    notify();
}

/**
 * Get default options
 * @returns {Object}
 */
export function getDefaults() {
    return { ...DEFAULT_OPTIONS };
}

// Export raw state for legacy compatibility
export { optionsState };

