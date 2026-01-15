/**
 * Panels UI Component
 * Manages side panels (options, cosmetics, daily) and top bar
 */

import { optionsState, getOptions } from '../state/optionsState.js';
import { saveOptions, loadFromStorage, saveToStorage } from '../utils/storage.js';
import { applyMusicPreference } from '../utils/audio.js';
import * as chat from './chat.js';

// Panel states
let optionsPanelOpen = false;
let topbarCollapsed = false;

/**
 * Initialize panels
 */
export function init() {
    // Top bar toggle (mobile)
    initTopbarToggle();
    
    // Options panel
    document.getElementById('options-btn')?.addEventListener('click', toggleOptions);
    document.getElementById('close-options-btn')?.addEventListener('click', closeOptions);
    
    // Option toggle handlers
    document.getElementById('opt-chat-enabled')?.addEventListener('change', (e) => {
        optionsState.chatEnabled = Boolean(e.target.checked);
        saveOptions(optionsState);
        applyOptions();
    });
    document.getElementById('opt-music-enabled')?.addEventListener('change', (e) => {
        optionsState.musicEnabled = Boolean(e.target.checked);
        saveOptions(optionsState);
        applyOptions();
    });
    document.getElementById('opt-click-sfx-enabled')?.addEventListener('change', (e) => {
        optionsState.clickSfxEnabled = Boolean(e.target.checked);
        saveOptions(optionsState);
        applyOptions();
    });
    document.getElementById('opt-elim-sfx-enabled')?.addEventListener('change', (e) => {
        optionsState.eliminationSfxEnabled = Boolean(e.target.checked);
        saveOptions(optionsState);
        applyOptions();
    });
    document.getElementById('opt-turn-notifications')?.addEventListener('change', (e) => {
        optionsState.turnNotificationsEnabled = Boolean(e.target.checked);
        saveOptions(optionsState);
        applyOptions();
    });
    document.getElementById('opt-nerd-mode')?.addEventListener('change', (e) => {
        optionsState.nerdMode = Boolean(e.target.checked);
        saveOptions(optionsState);
        applyOptions();
    });
    
    // ML Info modal
    document.getElementById('ml-info-btn')?.addEventListener('click', () => {
        const modal = document.getElementById('ml-info-modal');
        if (modal) modal.classList.add('show');
    });
    document.getElementById('close-ml-info-btn')?.addEventListener('click', () => {
        const modal = document.getElementById('ml-info-modal');
        if (modal) modal.classList.remove('show');
    });
}

/**
 * Initialize top bar toggle for mobile
 */
function initTopbarToggle() {
    const toggle = document.getElementById('topbar-toggle');
    const loggedInBox = document.getElementById('logged-in-box');
    
    if (!toggle || !loggedInBox) return;
    
    // Load saved state (default to collapsed on mobile)
    const savedState = loadFromStorage('topbar_collapsed');
    topbarCollapsed = savedState !== null ? savedState : true;
    
    // Apply initial state
    updateTopbarState();
    
    // Add click handler
    toggle.addEventListener('click', () => {
        topbarCollapsed = !topbarCollapsed;
        saveToStorage('topbar_collapsed', topbarCollapsed);
        updateTopbarState();
    });
}

/**
 * Update top bar collapsed/expanded state
 */
function updateTopbarState() {
    const loggedInBox = document.getElementById('logged-in-box');
    const toggle = document.getElementById('topbar-toggle');
    const nameEl = document.getElementById('logged-in-name');
    
    if (!loggedInBox || !toggle) return;
    
    loggedInBox.classList.toggle('collapsed', topbarCollapsed);
    toggle.setAttribute('aria-expanded', String(!topbarCollapsed));
    
    // Update toggle to show username when collapsed
    if (nameEl) {
        toggle.setAttribute('data-username', nameEl.textContent || 'OPERATIVE');
    }
}

/**
 * Update the username displayed in the toggle (call when name changes)
 */
export function updateTopbarUsername(name) {
    const toggle = document.getElementById('topbar-toggle');
    const nameEl = document.getElementById('logged-in-name');
    
    if (nameEl) {
        nameEl.textContent = name;
    }
    if (toggle) {
        toggle.setAttribute('data-username', name);
    }
}

/**
 * Toggle options panel
 */
export function toggleOptions() {
    optionsPanelOpen = !optionsPanelOpen;
    const panel = document.getElementById('options-panel');
    if (panel) {
        panel.classList.toggle('open', optionsPanelOpen);
    }
    if (optionsPanelOpen) {
        applyOptionsToUI();
    }
}

/**
 * Close options panel
 */
export function closeOptions() {
    optionsPanelOpen = false;
    const panel = document.getElementById('options-panel');
    if (panel) panel.classList.remove('open');
}

/**
 * Apply options to UI elements
 */
export function applyOptionsToUI() {
    const chatCb = document.getElementById('opt-chat-enabled');
    const musicCb = document.getElementById('opt-music-enabled');
    const clickCb = document.getElementById('opt-click-sfx-enabled');
    const elimCb = document.getElementById('opt-elim-sfx-enabled');
    const turnNotifCb = document.getElementById('opt-turn-notifications');
    const nerdCb = document.getElementById('opt-nerd-mode');

    if (chatCb) chatCb.checked = Boolean(optionsState.chatEnabled);
    if (musicCb) musicCb.checked = Boolean(optionsState.musicEnabled);
    if (clickCb) clickCb.checked = Boolean(optionsState.clickSfxEnabled);
    if (elimCb) elimCb.checked = Boolean(optionsState.eliminationSfxEnabled);
    if (turnNotifCb) turnNotifCb.checked = Boolean(optionsState.turnNotificationsEnabled);
    if (nerdCb) nerdCb.checked = Boolean(optionsState.nerdMode);
}

/**
 * Apply options (update UI state based on options)
 */
export function applyOptions() {
    // Update chat visibility
    chat.updateVisibility();
    
    // Apply music preference
    applyMusicPreference(optionsState.musicEnabled);
    
    // Render chat if needed
    chat.render();
    
    // Apply nerd mode to body class
    document.body.classList.toggle('nerd-mode', Boolean(optionsState.nerdMode));
}

export default {
    init,
    toggleOptions,
    closeOptions,
    applyOptionsToUI,
    applyOptions,
    updateTopbarUsername,
};

