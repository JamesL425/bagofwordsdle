/**
 * DOM Utilities
 * Common DOM manipulation and sanitization functions
 */

/**
 * Escape HTML to prevent XSS attacks.
 * @param {string} text - The text to escape
 * @returns {string} - HTML-escaped text
 */
export function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

/**
 * Normalize game code input (uppercase, alphanumeric only, max 6 chars)
 * @param {string} raw - Raw input string
 * @returns {string} - Normalized game code
 */
export function normalizeGameCodeInput(raw) {
    return String(raw || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 6);
}

/**
 * Move an element to a new parent container
 * @param {HTMLElement} el - Element to move
 * @param {HTMLElement} newParent - New parent container
 */
export function moveElementTo(el, newParent) {
    if (!el || !newParent) return;
    if (el.parentElement === newParent) return;
    newParent.appendChild(el);
}

/**
 * Check if we're in mobile game layout
 * @param {number} breakpoint - Breakpoint in pixels
 * @returns {boolean}
 */
export function isGameMobileLayout(breakpoint = 900) {
    try {
        return window.matchMedia(`(max-width: ${breakpoint}px)`).matches;
    } catch (e) {
        return window.innerWidth <= breakpoint;
    }
}

