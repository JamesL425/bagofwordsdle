/**
 * Chat State Management
 * Text chat state and message handling
 */

// Chat state singleton
const chatState = {
    code: null,
    lastId: 0,
    messages: [],
    lastSeenId: 0,
};

// Change listeners
const listeners = new Set();

/**
 * Subscribe to chat state changes
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
            cb(chatState);
        } catch (e) {
            console.error('Chat listener error:', e);
        }
    });
}

/**
 * Get chat state
 * @returns {Object}
 */
export function getState() {
    return { ...chatState, messages: [...chatState.messages] };
}

/**
 * Reset chat if game code changed
 * @param {string} currentCode - Current game code
 * @returns {boolean} - True if reset occurred
 */
export function resetIfNeeded(currentCode) {
    if (chatState.code !== currentCode) {
        chatState.code = currentCode;
        chatState.lastId = 0;
        chatState.messages = [];
        chatState.lastSeenId = 0;
        notify();
        return true;
    }
    return false;
}

/**
 * Add messages to chat
 * @param {Array} newMessages - New messages to add
 * @param {number} lastId - Last message ID from server
 */
export function addMessages(newMessages, lastId) {
    if (!Array.isArray(newMessages) || newMessages.length === 0) return;
    
    // Deduplicate by ID
    const existingIds = new Set(chatState.messages.map(m => m.id));
    const uniqueNew = newMessages.filter(m => !existingIds.has(m.id));
    
    chatState.messages = chatState.messages.concat(uniqueNew);
    
    // Trim memory
    if (chatState.messages.length > 300) {
        chatState.messages = chatState.messages.slice(-300);
    }
    
    // Update last ID
    if (Number.isFinite(lastId) && lastId > chatState.lastId) {
        chatState.lastId = lastId;
    } else {
        // Fallback: compute from payloads
        newMessages.forEach(m => {
            const mid = Number(m?.id ?? 0);
            if (Number.isFinite(mid) && mid > chatState.lastId) {
                chatState.lastId = mid;
            }
        });
    }
    
    notify();
}

/**
 * Add a single message (for local echo)
 * @param {Object} message
 */
export function addMessage(message) {
    chatState.messages.push(message);
    const mid = Number(message?.id ?? 0);
    if (Number.isFinite(mid) && mid > chatState.lastId) {
        chatState.lastId = mid;
    }
    notify();
}

/**
 * Mark messages as seen
 */
export function markAsSeen() {
    chatState.lastSeenId = chatState.lastId;
    notify();
}

/**
 * Check if there are unread messages
 * @returns {boolean}
 */
export function hasUnread() {
    return chatState.lastId > chatState.lastSeenId;
}

/**
 * Get last ID for polling
 * @returns {number}
 */
export function getLastId() {
    return chatState.lastId;
}

/**
 * Get messages (last N)
 * @param {number} limit
 * @returns {Array}
 */
export function getMessages(limit = 150) {
    return chatState.messages.slice(-limit);
}

/**
 * Clear all chat state
 */
export function clear() {
    chatState.code = null;
    chatState.lastId = 0;
    chatState.messages = [];
    chatState.lastSeenId = 0;
    notify();
}

// Export raw state for legacy compatibility
export { chatState };

