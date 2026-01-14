/**
 * Screen Management
 * Handles screen transitions and visibility
 */

// Screen element references (populated on init)
let screens = {};

// Current screen
let currentScreen = 'home';

// Screen change listeners
const listeners = new Set();

/**
 * Initialize screen management
 */
export function init() {
    screens = {
        home: document.getElementById('home-screen'),
        leaderboard: document.getElementById('leaderboard-screen'),
        join: document.getElementById('join-screen'),
        lobby: document.getElementById('lobby-screen'),
        singleplayerLobby: document.getElementById('singleplayer-lobby-screen'),
        wordselect: document.getElementById('wordselect-screen'),
        game: document.getElementById('game-screen'),
        gameover: document.getElementById('gameover-screen'),
    };
}

/**
 * Subscribe to screen changes
 * @param {Function} callback - Called with (newScreen, oldScreen)
 * @returns {Function} - Unsubscribe function
 */
export function subscribe(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
}

/**
 * Show a specific screen
 * @param {string} screenName
 */
export function show(screenName) {
    const oldScreen = currentScreen;
    
    // Hide all screens
    Object.values(screens).forEach(screen => {
        if (screen) screen.classList.remove('active');
    });
    
    // Show target screen
    if (screens[screenName]) {
        screens[screenName].classList.add('active');
    }
    
    currentScreen = screenName;
    
    // Update body class for in-game state
    document.body.classList.toggle('in-game', screenName === 'game');
    
    // Notify listeners
    listeners.forEach(cb => {
        try {
            cb(screenName, oldScreen);
        } catch (e) {
            console.error('Screen listener error:', e);
        }
    });
}

/**
 * Get current screen name
 * @returns {string}
 */
export function getCurrent() {
    return currentScreen;
}

/**
 * Check if a specific screen is active
 * @param {string} screenName
 * @returns {boolean}
 */
export function isActive(screenName) {
    return currentScreen === screenName;
}

/**
 * Get screen element by name
 * @param {string} screenName
 * @returns {HTMLElement|null}
 */
export function getElement(screenName) {
    return screens[screenName] || null;
}

export default {
    init,
    subscribe,
    show,
    getCurrent,
    isActive,
    getElement,
};

