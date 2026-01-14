/**
 * Toast Notification System
 * Shows temporary messages to the user
 */

// Toast queue and state
let toastQueue = [];
let toastActive = false;
let toastElement = null;

/**
 * Show a toast notification
 * @param {string} message - Message to display
 * @param {string} type - 'info', 'success', 'error'
 * @param {number} duration - Duration in ms
 */
export function show(message, type = 'info', duration = 3000) {
    toastQueue.push({ message, type, duration });
    processQueue();
}

/**
 * Show an error toast
 * @param {string} message
 */
export function error(message) {
    show(message, 'error', 3000);
}

/**
 * Show a success toast
 * @param {string} message
 */
export function success(message) {
    show(message, 'success', 2000);
}

/**
 * Show an info toast
 * @param {string} message
 */
export function info(message) {
    show(message, 'info', 2000);
}

/**
 * Process the toast queue
 */
function processQueue() {
    if (toastActive || toastQueue.length === 0) return;
    
    const { message, type, duration } = toastQueue.shift();
    toastActive = true;
    
    // Create toast element if it doesn't exist
    if (!toastElement) {
        toastElement = document.getElementById('toast-notification');
        if (!toastElement) {
            toastElement = document.createElement('div');
            toastElement.id = 'toast-notification';
            toastElement.className = 'toast-notification';
            document.body.appendChild(toastElement);
        }
    }
    
    toastElement.textContent = message;
    toastElement.className = `toast-notification toast-${type}`;
    toastElement.classList.add('show');
    
    setTimeout(() => {
        toastElement.classList.remove('show');
        setTimeout(() => {
            toastActive = false;
            processQueue();
        }, 150);
    }, duration);
}

/**
 * Clear all pending toasts
 */
export function clearAll() {
    toastQueue = [];
}

// Legacy function names for compatibility
export const showToast = show;
export const showError = error;
export const showSuccess = success;
export const showInfo = info;

export default {
    show,
    error,
    success,
    info,
    clearAll,
    showToast,
    showError,
    showSuccess,
    showInfo,
};

