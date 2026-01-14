/**
 * Modal Management
 * Handles modal dialogs and overlays
 */

import { escapeHtml } from '../utils/dom.js';

// Modal state
const openModals = new Set();

/**
 * Initialize modal system (attach global handlers)
 */
export function init() {
    // Close modal when clicking backdrop with data-close attribute
    document.addEventListener('click', (e) => {
        if (e.target?.dataset?.close) {
            const modal = e.target.closest('.closable-modal');
            if (modal) close(modal.id);
        }
    });
    
    // Escape key closes any open closable modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const openModalEls = document.querySelectorAll('.closable-modal.show');
            openModalEls.forEach(modal => close(modal.id));
        }
    });
}

/**
 * Show a modal by ID
 * @param {string} modalId
 */
export function show(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('show');
        openModals.add(modalId);
    }
}

/**
 * Close a modal by ID
 * @param {string} modalId
 */
export function close(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');
        openModals.delete(modalId);
    }
}

/**
 * Toggle a modal by ID
 * @param {string} modalId
 */
export function toggle(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        if (modal.classList.contains('show')) {
            close(modalId);
        } else {
            show(modalId);
        }
    }
}

/**
 * Check if a modal is open
 * @param {string} modalId
 * @returns {boolean}
 */
export function isOpen(modalId) {
    return openModals.has(modalId);
}

/**
 * Close all modals
 */
export function closeAll() {
    openModals.forEach(id => close(id));
}

/**
 * Create and show a confirm dialog
 * @param {Object} options
 * @returns {Promise<boolean>}
 */
export function confirm({ title, message, confirmText = 'Confirm', cancelText = 'Cancel' }) {
    return new Promise((resolve) => {
        // Create modal if it doesn't exist
        let modal = document.getElementById('confirm-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'confirm-modal';
            modal.className = 'modal-overlay closable-modal';
            modal.innerHTML = `
                <div class="modal-backdrop" data-close="true"></div>
                <div class="modal confirm-modal">
                    <h2 id="confirm-modal-title"></h2>
                    <p id="confirm-modal-message"></p>
                    <div class="modal-buttons">
                        <button id="confirm-modal-cancel" class="btn btn-secondary"></button>
                        <button id="confirm-modal-confirm" class="btn btn-primary"></button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }
        
        // Update content
        document.getElementById('confirm-modal-title').textContent = title || 'Confirm';
        document.getElementById('confirm-modal-message').textContent = message || '';
        document.getElementById('confirm-modal-confirm').textContent = confirmText;
        document.getElementById('confirm-modal-cancel').textContent = cancelText;
        
        // Set up handlers
        const confirmBtn = document.getElementById('confirm-modal-confirm');
        const cancelBtn = document.getElementById('confirm-modal-cancel');
        
        const cleanup = () => {
            close('confirm-modal');
            confirmBtn.onclick = null;
            cancelBtn.onclick = null;
        };
        
        confirmBtn.onclick = () => {
            cleanup();
            resolve(true);
        };
        
        cancelBtn.onclick = () => {
            cleanup();
            resolve(false);
        };
        
        show('confirm-modal');
    });
}

/**
 * Show challenge modal
 * @param {Object} challenge
 * @param {Function} onAccept
 * @param {Function} onDecline
 */
export function showChallenge(challenge, onAccept, onDecline) {
    let modal = document.getElementById('challenge-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'challenge-modal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal challenge-modal">
                <h2>⚔️ CHALLENGE RECEIVED</h2>
                <div class="challenge-info">
                    <p class="challenger-name"></p>
                    <p class="challenge-theme"></p>
                </div>
                <div class="modal-buttons">
                    <button id="accept-challenge-btn" class="btn btn-primary">&gt; ACCEPT CHALLENGE</button>
                    <button id="decline-challenge-btn" class="btn btn-secondary">&gt; DECLINE</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    
    // Update content
    modal.querySelector('.challenger-name').textContent = `${challenge.challenger_name} has challenged you!`;
    modal.querySelector('.challenge-theme').textContent = challenge.theme 
        ? `Theme: ${challenge.theme}` 
        : 'Theme: Voting enabled';
    
    // Set up handlers
    const acceptBtn = document.getElementById('accept-challenge-btn');
    const declineBtn = document.getElementById('decline-challenge-btn');
    
    acceptBtn.onclick = async () => {
        acceptBtn.disabled = true;
        acceptBtn.textContent = 'ACCEPTING...';
        try {
            await onAccept(challenge);
            close('challenge-modal');
        } catch (e) {
            acceptBtn.disabled = false;
            acceptBtn.textContent = '> ACCEPT CHALLENGE';
        }
    };
    
    declineBtn.onclick = () => {
        close('challenge-modal');
        if (onDecline) onDecline();
    };
    
    show('challenge-modal');
}

/**
 * Show leave game modal
 * @param {boolean} isAlive - Whether player is still alive
 * @param {Function} onLeave
 * @param {Function} onForfeit
 */
export function showLeaveGame(isAlive, onLeave, onForfeit) {
    const modal = document.getElementById('leave-game-modal');
    if (!modal) return;
    
    const forfeitOption = document.getElementById('forfeit-option');
    const leaveOption = document.getElementById('leave-option');
    
    if (forfeitOption) {
        forfeitOption.classList.toggle('hidden', !isAlive);
    }
    if (leaveOption) {
        leaveOption.textContent = isAlive 
            ? 'Leave without revealing your word (you will be eliminated)'
            : 'Leave game';
    }
    
    // Set up handlers
    const forfeitBtn = document.getElementById('forfeit-leave-btn');
    const leaveBtn = document.getElementById('simple-leave-btn');
    const cancelBtn = document.getElementById('cancel-leave-btn');
    
    if (forfeitBtn) {
        forfeitBtn.onclick = () => {
            close('leave-game-modal');
            if (onForfeit) onForfeit();
        };
    }
    
    if (leaveBtn) {
        leaveBtn.onclick = () => {
            close('leave-game-modal');
            if (onLeave) onLeave();
        };
    }
    
    if (cancelBtn) {
        cancelBtn.onclick = () => close('leave-game-modal');
    }
    
    show('leave-game-modal');
}

export default {
    init,
    show,
    close,
    toggle,
    isOpen,
    closeAll,
    confirm,
    showChallenge,
    showLeaveGame,
};

