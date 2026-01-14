/**
 * Panels UI Component
 * Manages side panels (options, cosmetics, daily)
 */

import { optionsState, getOptions } from '../state/optionsState.js';
import { saveOptions } from '../utils/storage.js';
import { applyMusicPreference } from '../utils/audio.js';
import * as chat from './chat.js';

// Panel states
let optionsPanelOpen = false;

/**
 * Initialize panels
 */
export function init() {
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
    const nerdCb = document.getElementById('opt-nerd-mode');

    if (chatCb) chatCb.checked = Boolean(optionsState.chatEnabled);
    if (musicCb) musicCb.checked = Boolean(optionsState.musicEnabled);
    if (clickCb) clickCb.checked = Boolean(optionsState.clickSfxEnabled);
    if (elimCb) elimCb.checked = Boolean(optionsState.eliminationSfxEnabled);
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
};

