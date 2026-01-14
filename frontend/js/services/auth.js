/**
 * Authentication Service
 * Handles OAuth, JWT tokens, and user sessions
 */

import { apiCall, getApiBase } from './api.js';
import * as gameState from '../state/gameState.js';
import { 
    getAuthToken, setAuthToken, removeAuthToken,
    getSavedName, setSavedName, removeSavedName,
    getAdminToken, setAdminToken, removeAdminToken
} from '../utils/storage.js';

/**
 * Initialize authentication from URL params or localStorage
 * @returns {Promise<Object|null>} - User data if authenticated
 */
export async function initAuth() {
    // Check for OAuth callback token in URL
    const urlParams = new URLSearchParams(window.location.search);
    const authToken = urlParams.get('auth_token');
    const authError = urlParams.get('auth_error');
    const authErrorDescription = urlParams.get('auth_error_description') || urlParams.get('google_error_description') || '';
    const googleError = urlParams.get('google_error') || '';
    const authErrorStatus = urlParams.get('auth_error_status') || '';
    
    if (authError) {
        let msg = 'Login failed: ' + authError;
        if (googleError) msg += ` (${googleError})`;
        if (authErrorDescription) msg += ` - ${authErrorDescription}`;
        if (authErrorStatus) msg += ` [${authErrorStatus}]`;
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
        throw new Error(msg);
    }
    
    if (authToken) {
        // Store token and fetch user info
        setAuthToken(authToken);
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
        return await loadAuthenticatedUser(authToken);
    }
    
    // Check for existing auth token
    const savedToken = getAuthToken();
    if (savedToken) {
        // Decode JWT to check if it's an admin token (don't auto-restore admin sessions)
        try {
            const payload = JSON.parse(atob(savedToken.split('.')[1]));
            if (payload.sub === 'admin_local') {
                // Don't auto-restore admin sessions - clear it
                removeAuthToken();
                return null;
            }
            return await loadAuthenticatedUser(savedToken);
        } catch (e) {
            // Invalid token, clear it
            removeAuthToken();
            return null;
        }
    }
    
    // Fall back to simple name-based login
    const savedName = getSavedName();
    if (savedName) {
        gameState.set('playerName', savedName);
        return { name: savedName, isGuest: true };
    }
    
    return null;
}

/**
 * Load authenticated user data from server
 * @param {string} token - JWT token
 * @returns {Promise<Object|null>}
 */
export async function loadAuthenticatedUser(token) {
    try {
        const user = await apiCall('/api/auth/me', 'GET', null, { authToken: token });
        gameState.setAuth(token, user);
        return user;
    } catch (error) {
        console.error('Failed to load authenticated user:', error);
        removeAuthToken();
        gameState.clearAuth();
        return null;
    }
}

/**
 * Start Google OAuth flow
 */
export function loginWithGoogle() {
    window.location.href = `${getApiBase()}/api/auth/google`;
}

/**
 * Login with simple name (guest mode)
 * @param {string} name
 * @returns {Object}
 */
export function loginAsGuest(name) {
    // Sanitize name
    const sanitizedName = name.replace(/<[^>]*>/g, '').substring(0, 20).trim();
    
    if (!sanitizedName) {
        throw new Error('Please enter a valid callsign');
    }
    
    // Check for admin callsign
    if (sanitizedName.toLowerCase() === 'admin') {
        throw new Error('ADMIN_LOGIN_REQUIRED');
    }
    
    gameState.set('playerName', sanitizedName);
    setSavedName(sanitizedName);
    
    return { name: sanitizedName, isGuest: true };
}

/**
 * Login as admin with password
 * @param {string} password
 * @returns {Promise<Object>}
 */
export async function loginAsAdmin(password) {
    const response = await apiCall('/api/auth/admin', 'POST', { password });
    
    // Store admin token in sessionStorage (not localStorage)
    setAdminToken(response.token);
    gameState.setAuth(response.token, { name: 'ADMIN', is_admin: true });
    gameState.set('isAdminSession', true);
    
    // Also load full user data
    return await loadAuthenticatedUser(response.token);
}

/**
 * Logout current user
 */
export function logout() {
    gameState.clearAuth();
    gameState.set('playerName', null);
    gameState.set('isAdminSession', false);
    removeSavedName();
    removeAuthToken();
    removeAdminToken();
}

/**
 * Check if user is authenticated (has valid token)
 * @returns {boolean}
 */
export function isAuthenticated() {
    return gameState.isAuthenticated();
}

/**
 * Check if user has admin privileges
 * @returns {boolean}
 */
export function isAdmin() {
    return gameState.isAdmin();
}

/**
 * Get current user
 * @returns {Object|null}
 */
export function getCurrentUser() {
    return gameState.get('authUser');
}

/**
 * Get current player name
 * @returns {string|null}
 */
export function getPlayerName() {
    return gameState.get('playerName');
}

/**
 * Check if name is the admin callsign
 * @param {string} name
 * @returns {boolean}
 */
export function isAdminCallsign(name) {
    return name?.toLowerCase() === 'admin';
}

export default {
    initAuth,
    loadAuthenticatedUser,
    loginWithGoogle,
    loginAsGuest,
    loginAsAdmin,
    logout,
    isAuthenticated,
    isAdmin,
    getCurrentUser,
    getPlayerName,
    isAdminCallsign,
};

