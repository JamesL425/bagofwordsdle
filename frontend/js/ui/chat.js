/**
 * Chat UI Component
 * Renders and manages the chat panel
 */

import { escapeHtml } from '../utils/dom.js';
import { chat as chatApi } from '../services/api.js';
import { gameState } from '../state/gameState.js';
import * as chatState from '../state/chatState.js';
import { optionsState } from '../state/optionsState.js';
import { showError } from './toast.js';

// Chat panel state
let chatPanelOpen = false;
let chatSendInFlight = false;
let lastChatSendTime = 0;
const CHAT_SEND_DEBOUNCE_MS = 150;

/**
 * Initialize chat UI
 */
export function init() {
    // Chat button
    document.getElementById('chat-btn')?.addEventListener('click', toggle);
    document.getElementById('close-chat-btn')?.addEventListener('click', close);
    
    // Chat form
    document.getElementById('chat-form')?.addEventListener('submit', handleSubmit);
}

/**
 * Toggle chat panel
 */
export function toggle() {
    if (!optionsState.chatEnabled) return;
    
    chatPanelOpen = !chatPanelOpen;
    const panel = document.getElementById('chat-panel');
    if (panel) {
        panel.classList.toggle('open', chatPanelOpen);
    }
    
    if (chatPanelOpen) {
        chatState.markAsSeen();
        updateUnreadDot();
        render();
    }
}

/**
 * Close chat panel
 */
export function close() {
    chatPanelOpen = false;
    const panel = document.getElementById('chat-panel');
    if (panel) panel.classList.remove('open');
    chatState.markAsSeen();
    updateUnreadDot();
}

/**
 * Check if chat panel is open
 * @returns {boolean}
 */
export function isOpen() {
    return chatPanelOpen;
}

/**
 * Update unread indicator dot
 */
export function updateUnreadDot() {
    const dot = document.getElementById('chat-unread-dot');
    if (!dot) return;
    const hasUnread = chatState.hasUnread() && !chatPanelOpen;
    dot.classList.toggle('hidden', !hasUnread);
}

/**
 * Format timestamp for display
 * @param {number} ts
 * @returns {string}
 */
function formatChatTime(ts) {
    const n = Number(ts || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    const ms = n < 100000000000 ? n * 1000 : n;
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return '';
    try {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
        return d.toTimeString().slice(0, 5);
    }
}

/**
 * Format timestamp for title attribute
 * @param {number} ts
 * @returns {string}
 */
function formatChatTimeTitle(ts) {
    const n = Number(ts || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    const ms = n < 100000000000 ? n * 1000 : n;
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return '';
    try {
        return d.toLocaleString();
    } catch (e) {
        return d.toString();
    }
}

/**
 * Render chat messages
 */
export function render() {
    const log = document.getElementById('chat-log');
    const input = document.getElementById('chat-input');
    const hint = document.getElementById('chat-hint');

    const enabled = Boolean(optionsState.chatEnabled);
    const canSend = enabled && !gameState.isSpectator && Boolean(gameState.code && gameState.playerId);

    if (input) input.disabled = !canSend;

    if (!enabled) {
        if (log) log.innerHTML = '';
        if (hint) {
            hint.textContent = 'Chat is disabled in options.';
            hint.classList.remove('hidden');
        }
        return;
    }

    if (hint) {
        if (!gameState.code) {
            hint.textContent = 'Join a match to chat.';
            hint.classList.remove('hidden');
        } else if (gameState.isSpectator) {
            hint.textContent = 'Spectators cannot send messages.';
            hint.classList.remove('hidden');
        } else {
            hint.classList.add('hidden');
        }
    }

    const msgs = chatState.getMessages(150);
    const html = msgs.length
        ? msgs.map(m => `
            <div class="chat-message">
                ${formatChatTime(m.ts) ? `<span class="chat-time" title="${escapeHtml(formatChatTimeTitle(m.ts))}">${escapeHtml(formatChatTime(m.ts))}</span>` : ''}
                <span class="chat-sender">${escapeHtml(m.sender_name || '???')}</span>
                <span class="chat-text">: ${escapeHtml(m.text || '')}</span>
            </div>
        `).join('')
        : `<div class="chat-message"><span class="chat-text">No messages yet.</span></div>`;

    if (!log) return;
    const atBottom = Math.abs((log.scrollHeight - log.scrollTop) - log.clientHeight) < 5;
    log.innerHTML = html;
    if (atBottom) {
        log.scrollTop = log.scrollHeight;
    }
}

/**
 * Handle chat form submission
 * @param {Event} e
 */
async function handleSubmit(e) {
    e.preventDefault();
    
    // Debounce
    const now = Date.now();
    if (now - lastChatSendTime < CHAT_SEND_DEBOUNCE_MS) return;
    if (chatSendInFlight) return;
    
    const input = document.getElementById('chat-input');
    if (!input) return;
    
    const text = input.value.trim();
    if (!text) return;
    
    input.value = '';
    lastChatSendTime = now;
    
    await sendMessage(text);
}

/**
 * Send a chat message
 * @param {string} text
 */
export async function sendMessage(text) {
    if (!optionsState.chatEnabled) return;
    if (chatSendInFlight) return;
    if (gameState.isSpectator) {
        showError('Spectators cannot send chat messages');
        return;
    }
    if (!gameState.code || !gameState.playerId) return;

    const message = String(text || '').trim().slice(0, 200);
    if (!message) return;

    chatSendInFlight = true;
    try {
        chatState.resetIfNeeded(gameState.code);
        const res = await chatApi.send(gameState.code, gameState.playerId, message);
        if (res?.message) {
            chatState.addMessage(res.message);
            render();
        }
    } catch (e) {
        console.error('Chat send failed:', e);
        showError(e.message || 'Failed to send message');
    } finally {
        chatSendInFlight = false;
    }
}

/**
 * Update chat visibility based on options
 */
export function updateVisibility() {
    const chatBtn = document.getElementById('chat-btn');
    if (chatBtn) {
        chatBtn.classList.toggle('hidden', !optionsState.chatEnabled);
    }
    if (!optionsState.chatEnabled) {
        close();
    }
}

export default {
    init,
    toggle,
    close,
    isOpen,
    updateUnreadDot,
    render,
    sendMessage,
    updateVisibility,
};

