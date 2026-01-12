/**
 * EMBEDDLE - Client Application
 */

const API_BASE = window.location.origin;

// ============ SECURITY UTILITIES ============

/**
 * Escape HTML to prevent XSS attacks.
 * @param {string} text - The text to escape
 * @returns {string} - HTML-escaped text
 */
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

// Game state
let gameState = {
    code: null,
    playerId: null,
    playerName: null,
    isHost: false,
    pollingInterval: null,
    theme: null,
    wordPool: null,
    allThemeWords: null,
    myVote: null,
    authToken: null,  // JWT token for authenticated users
    authUser: null,   // Authenticated user data
};

// ============ LOGIN SYSTEM ============

function initLogin() {
    // Check for OAuth callback token in URL
    const urlParams = new URLSearchParams(window.location.search);
    const authToken = urlParams.get('auth_token');
    const authError = urlParams.get('auth_error');
    
    if (authError) {
        showError('Login failed: ' + authError);
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
    }
    
    if (authToken) {
        // Store token and fetch user info
        localStorage.setItem('embeddle_auth_token', authToken);
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
        loadAuthenticatedUser(authToken);
        return;
    }
    
    // Check for existing auth token (regular Google auth only, not admin)
    const savedToken = localStorage.getItem('embeddle_auth_token');
    if (savedToken) {
        // Decode JWT to check if it's an admin token (don't auto-restore admin sessions)
        try {
            const payload = JSON.parse(atob(savedToken.split('.')[1]));
            if (payload.sub === 'admin_local') {
                // Don't auto-restore admin sessions - clear it
                localStorage.removeItem('embeddle_auth_token');
            } else {
                loadAuthenticatedUser(savedToken);
                return;
            }
        } catch (e) {
            // Invalid token, clear it
            localStorage.removeItem('embeddle_auth_token');
        }
    }
    
    // Fall back to simple name-based login
    const savedName = localStorage.getItem('embeddle_name');
    if (savedName) {
        setLoggedIn(savedName);
    }
}

async function loadAuthenticatedUser(token) {
    try {
        const response = await fetch(`${API_BASE}/api/auth/me`, {
            headers: {
                'Authorization': `Bearer ${token}`,
            },
        });
        
        if (!response.ok) {
            // Token invalid or expired
            localStorage.removeItem('embeddle_auth_token');
            return;
        }
        
        const user = await response.json();
        gameState.authToken = token;
        gameState.authUser = user;
        setLoggedInWithAuth(user);
    } catch (error) {
        console.error('Failed to load authenticated user:', error);
        localStorage.removeItem('embeddle_auth_token');
    }
}

function setLoggedInWithAuth(user) {
    gameState.playerName = user.name;
    gameState.authUser = user;
    
    // Set admin session flag if user is admin
    if (user.is_admin) {
        gameState.isAdminSession = true;
    }
    
    document.getElementById('login-box').classList.add('hidden');
    document.getElementById('logged-in-box').classList.remove('hidden');
    document.getElementById('logged-in-name').textContent = user.name.toUpperCase();
    
    // Show avatar if available
    const avatarEl = document.getElementById('user-avatar');
    if (avatarEl && user.avatar) {
        avatarEl.src = user.avatar;
        avatarEl.classList.remove('hidden');
    }
    
    // Load user cosmetics
    if (typeof loadUserCosmetics === 'function') {
        loadUserCosmetics();
    }
}

function setLoggedIn(name) {
    // Sanitize name - remove any HTML/script tags and limit length
    const sanitizedName = name.replace(/<[^>]*>/g, '').substring(0, 20).trim();
    
    if (!sanitizedName) {
        showError('Please enter a valid callsign');
        return;
    }
    
    // Check for admin callsign (case-insensitive)
    if (sanitizedName.toLowerCase() === 'admin') {
        promptAdminPassword();
        return;
    }
    
    gameState.playerName = sanitizedName;
    localStorage.setItem('embeddle_name', sanitizedName);
    
    document.getElementById('login-box').classList.add('hidden');
    document.getElementById('logged-in-box').classList.remove('hidden');
    document.getElementById('logged-in-name').textContent = sanitizedName.toUpperCase();
}

async function promptAdminPassword() {
    const password = prompt('Enter admin password:');
    if (!password) {
        document.getElementById('login-name').value = '';
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/auth/admin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: password })
        });
        
        if (!response.ok) {
            const err = await response.json();
            showError(err.detail || 'Invalid admin password');
            document.getElementById('login-name').value = '';
            return;
        }
        
        const data = await response.json();
        // Store admin token in sessionStorage (not localStorage) so it doesn't persist
        sessionStorage.setItem('embeddle_admin_token', data.token);
        gameState.authToken = data.token;
        gameState.isAdminSession = true;
        loadAuthenticatedUser(data.token);
    } catch (error) {
        showError('Admin login failed');
        document.getElementById('login-name').value = '';
    }
}

function logout() {
    gameState.playerName = null;
    gameState.authToken = null;
    gameState.authUser = null;
    gameState.isAdminSession = false;
    localStorage.removeItem('embeddle_name');
    localStorage.removeItem('embeddle_auth_token');
    sessionStorage.removeItem('embeddle_admin_token');
    
    document.getElementById('login-box').classList.remove('hidden');
    document.getElementById('logged-in-box').classList.add('hidden');
    document.getElementById('login-name').value = '';
    
    // Hide avatar
    const avatarEl = document.getElementById('user-avatar');
    if (avatarEl) {
        avatarEl.classList.add('hidden');
        avatarEl.src = '';
    }
}

// Google login button
document.getElementById('google-login-btn')?.addEventListener('click', () => {
    window.location.href = `${API_BASE}/api/auth/google`;
});

document.getElementById('login-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const name = e.target.value.trim();
        if (name) {
            setLoggedIn(name);
        }
    }
});

document.getElementById('logout-btn').addEventListener('click', logout);

// Cosmetics button
document.getElementById('cosmetics-btn')?.addEventListener('click', toggleCosmeticsPanel);
document.getElementById('close-cosmetics-btn')?.addEventListener('click', closeCosmeticsPanel);

// DOM Elements
const screens = {
    home: document.getElementById('home-screen'),
    join: document.getElementById('join-screen'),
    lobby: document.getElementById('lobby-screen'),
    singleplayerLobby: document.getElementById('singleplayer-lobby-screen'),
    wordselect: document.getElementById('wordselect-screen'),
    game: document.getElementById('game-screen'),
    gameover: document.getElementById('gameover-screen'),
};

// Utility functions
function showScreen(screenName) {
    Object.values(screens).forEach(screen => {
        if (screen) screen.classList.remove('active');
    });
    if (screens[screenName]) screens[screenName].classList.add('active');
    
    // Start/stop lobby refresh based on screen
    if (screenName === 'home') {
        startLobbyRefresh();
    } else {
        stopLobbyRefresh();
    }
}

function showError(message) {
    alert(message);
}

async function apiCall(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
    };
    
    if (body) {
        options.body = JSON.stringify(body);
    }
    
    const response = await fetch(`${API_BASE}${endpoint}`, options);
    
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
        throw new Error('Server error - please try again');
    }
    
    const data = await response.json();
    
    if (!response.ok) {
        throw new Error(data.detail || 'An error occurred');
    }
    
    return data;
}

// ============ HOME SCREEN ============

let lobbyRefreshInterval = null;

// Load open lobbies on page load and refresh
async function loadLobbies() {
    const container = document.getElementById('open-lobbies');
    try {
        const data = await apiCall('/api/lobbies');
        
        if (data.lobbies.length === 0) {
            container.innerHTML = '<p class="no-lobbies">No open lobbies. Create one!</p>';
        } else {
            container.innerHTML = data.lobbies.map(lobby => `
                <div class="lobby-item" data-code="${escapeHtml(lobby.code)}">
                    <div class="lobby-info-row">
                        <span class="lobby-code">${escapeHtml(lobby.code)}</span>
                        <span class="lobby-players">${escapeHtml(lobby.player_count)}/${escapeHtml(lobby.max_players)} operatives</span>
                    </div>
                    <button class="btn btn-small btn-secondary join-lobby-btn" data-code="${escapeHtml(lobby.code)}">JOIN</button>
                </div>
            `).join('');
            
            // Add click handlers
            container.querySelectorAll('.join-lobby-btn').forEach(btn => {
                btn.addEventListener('click', () => joinLobbyPrompt(btn.dataset.code));
            });
        }
    } catch (error) {
        container.innerHTML = '<p class="error">Failed to load lobbies</p>';
    }
}

function startLobbyRefresh() {
    stopLobbyRefresh();
    loadLobbies();
    lobbyRefreshInterval = setInterval(loadLobbies, 3000);  // Refresh every 3 seconds
}

function stopLobbyRefresh() {
    if (lobbyRefreshInterval) {
        clearInterval(lobbyRefreshInterval);
        lobbyRefreshInterval = null;
    }
}

function joinLobbyPrompt(code) {
    if (!gameState.playerName) {
        showError('Enter your callsign first (top right)');
        document.getElementById('login-name').focus();
        return;
    }
    joinLobby(code, gameState.playerName);
}

document.getElementById('create-game-btn').addEventListener('click', async () => {
    if (!gameState.playerName) {
        showError('Enter your callsign first (top right)');
        document.getElementById('login-name').focus();
        return;
    }
    
    try {
        const data = await apiCall('/api/games', 'POST');
        gameState.code = data.code;
        
        // Join the lobby we just created
        await joinLobby(data.code, gameState.playerName);
    } catch (error) {
        showError(error.message);
    }
});

document.getElementById('refresh-lobbies-btn')?.addEventListener('click', loadLobbies);

// ============ SINGLEPLAYER MODE ============

document.getElementById('singleplayer-btn')?.addEventListener('click', async () => {
    if (!gameState.playerName) {
        showError('Enter your callsign first (top right)');
        document.getElementById('login-name').focus();
        return;
    }
    
    try {
        // Create singleplayer lobby
        const data = await apiCall('/api/singleplayer', 'POST');
        gameState.code = data.code;
        gameState.isSingleplayer = true;
        
        // Join the lobby we just created
        await joinSingleplayerLobby(data.code, gameState.playerName);
    } catch (error) {
        showError(error.message);
    }
});

async function joinSingleplayerLobby(code, name) {
    try {
        const joinData = { name };
        if (gameState.authUser && gameState.authUser.id) {
            joinData.auth_user_id = gameState.authUser.id;
        }
        
        const data = await apiCall(`/api/games/${code}/join`, 'POST', joinData);
        
        gameState.code = code;
        gameState.playerId = data.player_id;
        gameState.playerName = name;
        gameState.isHost = data.is_host;
        gameState.isSingleplayer = true;
        
        showScreen('singleplayerLobby');
        startSingleplayerLobbyPolling();
    } catch (error) {
        showError(error.message);
    }
}

function startSingleplayerLobbyPolling() {
    if (gameState.pollingInterval) {
        clearInterval(gameState.pollingInterval);
    }
    
    updateSingleplayerLobby();
    gameState.pollingInterval = setInterval(updateSingleplayerLobby, 2000);
}

async function updateSingleplayerLobby() {
    try {
        const data = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
        
        // Update theme display
        document.getElementById('sp-theme-name').textContent = data.theme?.name || 'Loading...';
        
        // Update players list
        const playersList = document.getElementById('sp-players-list');
        playersList.innerHTML = data.players.map(p => {
            const isYou = p.id === gameState.playerId;
            const isAI = p.is_ai;
            const difficultyClass = isAI ? `ai-${p.difficulty}` : '';
            
            return `
                <div class="sp-player-item ${isYou ? 'is-you' : ''} ${isAI ? 'is-ai' : ''}">
                    <div class="sp-player-info">
                        <span class="sp-player-icon">${isAI ? '🤖' : '👤'}</span>
                        <span class="sp-player-name">${escapeHtml(p.name)}${isYou ? ' (you)' : ''}</span>
                        ${isYou ? '<span class="sp-player-badge host">HOST</span>' : ''}
                        ${isAI ? `<span class="sp-player-badge ${difficultyClass}">${escapeHtml(p.difficulty)}</span>` : ''}
                    </div>
                    ${isAI ? `<button class="sp-remove-ai" data-ai-id="${escapeHtml(p.id)}">✕ Remove</button>` : ''}
                </div>
            `;
        }).join('');
        
        // Add remove AI handlers
        playersList.querySelectorAll('.sp-remove-ai').forEach(btn => {
            btn.addEventListener('click', () => removeAI(btn.dataset.aiId));
        });
        
        // Update player count
        document.getElementById('sp-player-count').textContent = data.players.length;
        
        // Enable/disable AI add buttons based on player count
        const aiButtons = document.querySelectorAll('.btn-ai-add');
        const canAddMore = data.players.length < 6;
        aiButtons.forEach(btn => {
            btn.disabled = !canAddMore;
        });
        
        // Enable start button if we have at least 2 players (1 human + 1 AI)
        const aiCount = data.players.filter(p => p.is_ai).length;
        document.getElementById('sp-start-game-btn').disabled = aiCount < 1;
        
        // Check if game moved to word selection
        if (data.status === 'word_selection') {
            clearInterval(gameState.pollingInterval);
            gameState.theme = data.theme;
            gameState.allThemeWords = data.theme?.words || [];
            showWordSelectionScreen(data);
        }
    } catch (error) {
        console.error('Singleplayer lobby poll error:', error);
    }
}

// Add AI player
document.querySelectorAll('.btn-ai-add').forEach(btn => {
    btn.addEventListener('click', async () => {
        const difficulty = btn.dataset.difficulty;
        try {
            await apiCall(`/api/games/${gameState.code}/add-ai`, 'POST', {
                player_id: gameState.playerId,
                difficulty: difficulty,
            });
            updateSingleplayerLobby();
        } catch (error) {
            showError(error.message);
        }
    });
});

async function removeAI(aiId) {
    try {
        await apiCall(`/api/games/${gameState.code}/remove-ai`, 'POST', {
            player_id: gameState.playerId,
            ai_id: aiId,
        });
        updateSingleplayerLobby();
    } catch (error) {
        showError(error.message);
    }
}

// Start singleplayer game
document.getElementById('sp-start-game-btn')?.addEventListener('click', async () => {
    try {
        await apiCall(`/api/games/${gameState.code}/start`, 'POST', {
            player_id: gameState.playerId,
        });
        // Polling will detect status change
    } catch (error) {
        showError(error.message);
    }
});

// Leave singleplayer lobby
document.getElementById('sp-leave-lobby-btn')?.addEventListener('click', () => {
    if (gameState.pollingInterval) {
        clearInterval(gameState.pollingInterval);
    }
    gameState.code = null;
    gameState.playerId = null;
    gameState.isSingleplayer = false;
    showScreen('home');
    loadLobbies();
});

// ============ JOIN LOBBY ============

async function joinLobby(code, name) {
    try {
        const joinData = { name };
        // Include auth user ID if logged in with Google
        if (gameState.authUser && gameState.authUser.id) {
            joinData.auth_user_id = gameState.authUser.id;
        }
        
        const data = await apiCall(`/api/games/${code}/join`, 'POST', joinData);
        
        gameState.code = code;
        gameState.playerId = data.player_id;
        gameState.playerName = name;
        gameState.isHost = data.is_host;
        
        // Go to lobby screen
        document.getElementById('lobby-code').textContent = code;
        showScreen('lobby');
        
        // Start polling for lobby updates
        startLobbyPolling();
    } catch (error) {
        showError(error.message);
    }
}

function startLobbyPolling() {
    if (gameState.pollingInterval) {
        clearInterval(gameState.pollingInterval);
    }
    
    updateLobby();
    gameState.pollingInterval = setInterval(updateLobby, 2000);
}

async function updateLobby() {
    try {
        const data = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
        
        // Update players list
        const playersList = document.getElementById('lobby-players');
        playersList.innerHTML = data.players.map(p => `
            <div class="lobby-player ${p.id === data.host_id ? 'host' : ''}">
                <span class="player-name">${escapeHtml(p.name)}${p.id === gameState.playerId ? ' (you)' : ''}</span>
                ${p.id === data.host_id ? '<span class="host-badge">HOST</span>' : ''}
            </div>
        `).join('');
        
        document.getElementById('player-count').textContent = data.players.length;
        
        // Update theme voting with voter names
        updateThemeVoting(data.theme_options, data.theme_votes);
        
        // Show/hide host controls
        const hostControls = document.getElementById('host-controls');
        if (gameState.isHost) {
            hostControls.classList.remove('hidden');
            // Admin can start with 1 player, others need at least 2
            const isAdmin = gameState.isAdminSession || (gameState.authUser && gameState.authUser.is_admin);
            const minPlayers = isAdmin ? 1 : 2;
            document.getElementById('start-game-btn').disabled = data.players.length < minPlayers;
        } else {
            hostControls.classList.add('hidden');
        }
        
        // Check if game moved to word selection
        if (data.status === 'word_selection') {
            clearInterval(gameState.pollingInterval);
            gameState.theme = data.theme;
            gameState.allThemeWords = data.theme?.words || [];
            showWordSelectionScreen(data);
        }
    } catch (error) {
        // Silently ignore polling errors
    }
}

function updateThemeVoting(options, votes) {
    const container = document.getElementById('theme-vote-options');
    if (!container || !options) return;
    
    container.innerHTML = options.map(theme => {
        const voters = votes[theme] || [];
        const voteCount = voters.length;
        const isMyVote = voters.some(v => v.id === gameState.playerId);
        const voterNames = voters.map(v => escapeHtml(v.name)).join(', ');
        return `
            <button class="btn theme-vote-btn ${isMyVote ? 'voted' : ''}" data-theme="${escapeHtml(theme)}">
                <span class="theme-name">${escapeHtml(theme)}</span>
                <span class="vote-count">${escapeHtml(voteCount)} vote${voteCount !== 1 ? 's' : ''}</span>
                ${voterNames ? `<span class="voter-names">${voterNames}</span>` : ''}
            </button>
        `;
    }).join('');
    
    container.querySelectorAll('.theme-vote-btn').forEach(btn => {
        btn.addEventListener('click', () => voteForTheme(btn.dataset.theme));
    });
}

async function voteForTheme(theme) {
    try {
        await apiCall(`/api/games/${gameState.code}/vote`, 'POST', {
            player_id: gameState.playerId,
            theme,
        });
        gameState.myVote = theme;
    } catch (error) {
        showError(error.message);
    }
}

// Word Selection Screen
function showWordSelectionScreen(data) {
    gameState.theme = data.theme;
    gameState.allThemeWords = data.theme?.words || [];
    
    const myPlayer = data.players.find(p => p.id === gameState.playerId);
    gameState.wordPool = myPlayer?.word_pool || [];
    
    // Set theme name
    document.getElementById('wordselect-theme-name').textContent = data.theme?.name || '-';
    
    // Show word pool as clickable buttons
    const poolContainer = document.getElementById('word-select-pool');
    poolContainer.innerHTML = gameState.wordPool.map(word => `
        <span class="word-option" data-word="${escapeHtml(word)}">${escapeHtml(word)}</span>
    `).join('');
    
    // Add click handlers
    poolContainer.querySelectorAll('.word-option').forEach(el => {
        el.addEventListener('click', () => {
            // Deselect others
            poolContainer.querySelectorAll('.word-option').forEach(w => w.classList.remove('selected'));
            el.classList.add('selected');
            document.getElementById('selected-word-display').textContent = el.dataset.word.toUpperCase();
            document.getElementById('selected-word-display').dataset.word = el.dataset.word;
        });
    });
    
    // Reset state
    document.getElementById('selected-word-display').textContent = 'Click a word above';
    document.getElementById('selected-word-display').dataset.word = '';
    document.getElementById('word-select-controls').classList.remove('hidden');
    document.getElementById('word-locked-notice').classList.add('hidden');
    
    showScreen('wordselect');
    startWordSelectPolling();
}

function startWordSelectPolling() {
    if (gameState.pollingInterval) {
        clearInterval(gameState.pollingInterval);
    }
    updateWordSelectScreen();
    gameState.pollingInterval = setInterval(updateWordSelectScreen, 2000);
}

async function updateWordSelectScreen() {
    try {
        const data = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
        
        // Update player status
        const lockedCount = data.players.filter(p => p.has_word).length;
        document.getElementById('locked-count').textContent = lockedCount;
        document.getElementById('total-count').textContent = data.players.length;
        
        const statusList = document.getElementById('player-status-list');
        statusList.innerHTML = data.players.map(p => `
            <div class="player-status-item ${p.has_word ? 'locked' : ''}">
                <span>${escapeHtml(p.name)}${p.id === gameState.playerId ? ' (you)' : ''}</span>
                <span>${p.has_word ? '✓ LOCKED' : '○ SELECTING'}</span>
            </div>
        `).join('');
        
        // Show host controls if all locked
        const myPlayer = data.players.find(p => p.id === gameState.playerId);
        if (gameState.isHost) {
            document.getElementById('host-begin-controls').classList.remove('hidden');
            document.getElementById('begin-game-btn').disabled = lockedCount < data.players.length;
        }
        
        // Check if game started
        if (data.status === 'playing') {
            clearInterval(gameState.pollingInterval);
            showScreen('game');
            startGamePolling();
        }
    } catch (error) {
        // Silently ignore
    }
}

// Lock in word button
document.getElementById('lock-word-btn')?.addEventListener('click', async () => {
    const wordDisplay = document.getElementById('selected-word-display');
    const word = wordDisplay.dataset.word;
    if (!word) {
        showError('Please select a word');
        return;
    }
    
    try {
        await apiCall(`/api/games/${gameState.code}/set-word`, 'POST', {
            player_id: gameState.playerId,
            secret_word: word,
        });
        
        // Show locked notice
        document.getElementById('word-select-controls').classList.add('hidden');
        document.getElementById('word-locked-notice').classList.remove('hidden');
        document.getElementById('locked-word-display').textContent = word.toUpperCase();
        
        // Disable word selection
        document.querySelectorAll('.word-option').forEach(el => {
            el.style.pointerEvents = 'none';
            if (el.dataset.word.toLowerCase() !== word.toLowerCase()) {
                el.style.opacity = '0.3';
            }
        });
    } catch (error) {
        showError(error.message);
    }
});

// Begin game button (host only)
document.getElementById('begin-game-btn')?.addEventListener('click', async () => {
    try {
        await apiCall(`/api/games/${gameState.code}/begin`, 'POST', {
            player_id: gameState.playerId,
        });
        // Polling will detect status change
    } catch (error) {
        showError(error.message);
    }
});

// Keep old functions for backwards compatibility but redirect
function showWordSelectionOrGame(data) {
    const myPlayer = data.players.find(p => p.id === gameState.playerId);
    
    if (!myPlayer.secret_word) {
        showWordSelectionScreen(data);
    } else {
        gameState.wordPool = myPlayer.word_pool || [];
        showScreen('game');
        startGamePolling();
    }
}

function showWordSelection(data) {
    showWordSelectionScreen(data);
}

// Screen: Join (for word selection after game starts)
document.getElementById('back-home-btn').addEventListener('click', () => {
    gameState.code = null;
    showScreen('home');
});

document.getElementById('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const secretWord = document.getElementById('secret-word').value.trim();
    
    if (!secretWord) {
        showError('Please pick a secret word');
        return;
    }
    
    try {
        await apiCall(`/api/games/${gameState.code}/set-word`, 'POST', {
            player_id: gameState.playerId,
            secret_word: secretWord,
        });
        
        document.getElementById('secret-word').value = '';
        
        // Go to game
        showScreen('game');
        startGamePolling();
    } catch (error) {
        showError(error.message);
    }
});

function displayWordPool(themeName, wordPool) {
    document.getElementById('theme-name').textContent = themeName || 'Loading...';
    
    const wordsContainer = document.getElementById('theme-words');
    wordsContainer.innerHTML = '';
    
    if (!wordPool || wordPool.length === 0) {
        wordsContainer.innerHTML = '<span class="theme-word" style="color: var(--text-muted);">Loading words...</span>';
        document.getElementById('theme-display').classList.remove('hidden');
        return;
    }
    
    const sortedWords = [...wordPool].sort();
    
    sortedWords.forEach(word => {
        const wordEl = document.createElement('span');
        wordEl.className = 'theme-word';
        wordEl.textContent = word;
        wordEl.addEventListener('click', () => {
            document.getElementById('secret-word').value = word;
        });
        wordsContainer.appendChild(wordEl);
    });
    
    document.getElementById('theme-display').classList.remove('hidden');
}

// Screen: Lobby
document.getElementById('copy-code-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(gameState.code);
    document.getElementById('copy-code-btn').textContent = 'Copied!';
    setTimeout(() => {
        document.getElementById('copy-code-btn').textContent = 'Copy';
    }, 2000);
});

document.getElementById('start-game-btn').addEventListener('click', async () => {
    try {
        await apiCall(`/api/games/${gameState.code}/start`, 'POST', {
            player_id: gameState.playerId,
        });
    } catch (error) {
        showError(error.message);
    }
});

document.getElementById('leave-lobby-btn')?.addEventListener('click', () => {
    if (gameState.pollingInterval) {
        clearInterval(gameState.pollingInterval);
    }
    gameState.code = null;
    gameState.playerId = null;
    showScreen('home');
    loadLobbies();
});

// Screen: Game
function startGamePolling() {
    if (gameState.pollingInterval) {
        clearInterval(gameState.pollingInterval);
    }
    
    pollGame();
    gameState.pollingInterval = setInterval(pollGame, 2000);
}

async function pollGame() {
    try {
        const game = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
        
        if (game.status === 'finished') {
            clearInterval(gameState.pollingInterval);
            showGameOver(game);
            return;
        }
        
        // Check if we still need to set our word
        const myPlayer = game.players.find(p => p.id === gameState.playerId);
        if (!myPlayer.secret_word && game.status === 'playing') {
            showWordSelection(game);
            return;
        }
        
        updateGame(game);
    } catch (error) {
        console.error('Game poll error:', error);
    }
}

function showGame(game) {
    showScreen('game');
    updateGame(game);
}

function updateGame(game) {
    const myPlayer = game.players.find(p => p.id === gameState.playerId);
    
    // Check if waiting for other players to pick words
    if (!game.all_words_set) {
        // Show waiting state
        const playersWithWords = game.players.filter(p => p.has_word).length;
        const totalPlayers = game.players.length;
        const waitingFor = game.players.filter(p => !p.has_word).map(p => escapeHtml(p.name));
        
        document.getElementById('turn-indicator').innerHTML = `
            <span class="waiting-for-words">
                WAITING FOR WORD SELECTION (${escapeHtml(playersWithWords)}/${escapeHtml(totalPlayers)})
                <br><small>Waiting for: ${waitingFor.join(', ') || 'loading...'}</small>
            </span>
        `;
        
        // Disable guessing
        const guessInput = document.getElementById('guess-input');
        const guessForm = document.getElementById('guess-form');
        guessInput.disabled = true;
        guessForm.querySelector('button').disabled = true;
        
        updatePlayersGrid(game);
        return;
    }
    
    if (myPlayer) {
        document.getElementById('your-secret-word').textContent = myPlayer.secret_word || '???';
        
        const changeWordContainer = document.getElementById('change-word-container');
        const wordPoolOptions = document.getElementById('word-pool-options');
        
        if (myPlayer.can_change_word) {
            changeWordContainer.classList.remove('hidden');
            
            // Show word pool options (excluding guessed words)
            const guessedWords = new Set(game.history
                .filter(e => e.word)
                .map(e => e.word.toLowerCase()));
            
            const availableWords = (myPlayer.word_pool || gameState.wordPool || [])
                .filter(w => !guessedWords.has(w.toLowerCase()));
            
            if (wordPoolOptions) {
                wordPoolOptions.innerHTML = '';
                const newWordDisplay = document.getElementById('new-word-display');
                newWordDisplay.textContent = 'Click a word above';
                newWordDisplay.dataset.word = '';
                
                availableWords.sort().forEach(word => {
                    const wordEl = document.createElement('span');
                    wordEl.className = 'word-pool-option';
                    wordEl.textContent = word;
                    wordEl.addEventListener('click', () => {
                        // Deselect others
                        wordPoolOptions.querySelectorAll('.word-pool-option').forEach(w => w.classList.remove('selected'));
                        wordEl.classList.add('selected');
                        newWordDisplay.textContent = word.toUpperCase();
                        newWordDisplay.dataset.word = word;
                    });
                    wordPoolOptions.appendChild(wordEl);
                });
            }
        } else {
            changeWordContainer.classList.add('hidden');
        }
        
        // Store word pool for change word feature
        if (myPlayer.word_pool) {
            gameState.wordPool = myPlayer.word_pool;
        }
    }
    
    // Update theme info in game screen
    if (game.theme) {
        document.getElementById('game-theme-name').textContent = game.theme.name || '-';
        gameState.allThemeWords = game.theme.words || [];
    }
    
    // Update sidebar word list with highlights
    updateSidebarWordList(game);
    
    updatePlayersGrid(game);
    updateTurnIndicator(game);
    
    // Handle waiting for word change state
    const waitingNotice = document.getElementById('waiting-for-change');
    const isWaitingForMe = game.waiting_for_word_change === gameState.playerId;
    const isWaitingForOther = game.waiting_for_word_change && !isWaitingForMe;
    
    if (isWaitingForOther) {
        const waitingPlayer = game.players.find(p => p.id === game.waiting_for_word_change);
        document.getElementById('waiting-player-name').textContent = waitingPlayer?.name || 'Someone';
        waitingNotice.classList.remove('hidden');
    } else {
        waitingNotice.classList.add('hidden');
    }
    
    // Disable guessing if waiting for word change
    const isMyTurn = game.current_player_id === gameState.playerId && myPlayer?.is_alive && !game.waiting_for_word_change;
    const guessInput = document.getElementById('guess-input');
    const guessForm = document.getElementById('guess-form');
    guessInput.disabled = !isMyTurn;
    guessForm.querySelector('button').disabled = !isMyTurn;
    
    if (isMyTurn && !game.waiting_for_word_change) {
        guessInput.focus();
    }
    
    updateHistory(game);
}

function updateSidebarWordList(game) {
    const wordlist = document.getElementById('game-wordlist');
    if (!wordlist) return;
    
    const allWords = game.theme?.words || gameState.allThemeWords || [];
    if (allWords.length === 0) return;
    
    // Get guessed words
    const guessedWords = new Set();
    game.history.forEach(entry => {
        if (entry.word) {
            guessedWords.add(entry.word.toLowerCase());
        }
    });
    
    // Get eliminated words (words that caused eliminations)
    const eliminatedWords = new Set();
    game.history.forEach(entry => {
        if (entry.eliminations && entry.eliminations.length > 0 && entry.word) {
            eliminatedWords.add(entry.word.toLowerCase());
        }
    });
    
    // Get my secret word
    const myPlayer = game.players.find(p => p.id === gameState.playerId);
    const myWord = myPlayer?.secret_word?.toLowerCase();
    
    // Sort and render
    const sortedWords = [...allWords].sort();
    
    wordlist.innerHTML = '';
    sortedWords.forEach(word => {
        const wordEl = document.createElement('span');
        wordEl.className = 'word-item';
        wordEl.textContent = word;
        
        const wordLower = word.toLowerCase();
        
        if (wordLower === myWord) {
            wordEl.classList.add('your-word');
            wordEl.title = 'Your secret word';
        } else if (eliminatedWords.has(wordLower)) {
            wordEl.classList.add('eliminated');
            wordEl.title = 'This word eliminated a player';
        } else if (guessedWords.has(wordLower)) {
            wordEl.classList.add('guessed');
            wordEl.title = 'This word was guessed';
        }
        
        // Click to fill guess input
        wordEl.addEventListener('click', () => {
            const guessInput = document.getElementById('guess-input');
            if (guessInput && !guessInput.disabled) {
                guessInput.value = word;
                guessInput.focus();
            }
        });
        
        wordlist.appendChild(wordEl);
    });
}

function updatePlayersGrid(game) {
    const grid = document.getElementById('players-grid');
    grid.innerHTML = '';
    
    // Build top 3 closest guesses for each player from history
    const topGuessesPerPlayer = {};
    game.players.forEach(p => {
        topGuessesPerPlayer[p.id] = [];
    });
    
    // Track word changes to reset top guesses
    const wordChangeAfterIndex = {};  // playerId -> index after which they changed word
    game.history.forEach((entry, index) => {
        if (entry.type === 'word_change') {
            wordChangeAfterIndex[entry.player_id] = index;
        }
    });
    
    // Calculate top 3 guesses for each player (only after their last word change)
    game.history.forEach((entry, index) => {
        if (entry.type === 'word_change') return;  // Skip word change entries
        
        game.players.forEach(player => {
            // Skip if this guess was before the player's word change
            const changeIndex = wordChangeAfterIndex[player.id];
            if (changeIndex !== undefined && index < changeIndex) {
                return;  // This guess was before their word change, ignore it
            }
            
            const sim = entry.similarities[player.id];
            if (sim !== undefined) {
                topGuessesPerPlayer[player.id].push({
                    word: entry.word,
                    similarity: sim
                });
            }
        });
    });
    
    // Sort and keep top 3 for each player
    Object.keys(topGuessesPerPlayer).forEach(playerId => {
        topGuessesPerPlayer[playerId].sort((a, b) => b.similarity - a.similarity);
        topGuessesPerPlayer[playerId] = topGuessesPerPlayer[playerId].slice(0, 3);
    });
    
    // Calculate danger score for each player
    // Formula: top1 * 0.6 + top2 * 0.25 + top3 * 0.15
    // This weights the highest similarity most, but multiple high ones add up
    function calculateDangerScore(topGuesses) {
        if (!topGuesses || topGuesses.length === 0) return 0;
        const weights = [0.6, 0.25, 0.15];
        let score = 0;
        topGuesses.forEach((guess, i) => {
            score += guess.similarity * (weights[i] || 0);
        });
        return score;
    }
    
    function getDangerLevel(score) {
        // Returns: 'safe', 'low', 'medium', 'high', 'critical'
        if (score < 0.3) return 'safe';
        if (score < 0.45) return 'low';
        if (score < 0.6) return 'medium';
        if (score < 0.75) return 'high';
        return 'critical';
    }
    
    game.players.forEach(player => {
        const isCurrentTurn = player.id === game.current_player_id;
        const isYou = player.id === gameState.playerId;
        const isAI = player.is_ai;
        
        // Get cosmetic classes
        const cosmeticClasses = typeof getPlayerCardClasses === 'function' 
            ? getPlayerCardClasses(player.cosmetics) : '';
        const nameColorClass = typeof getNameColorClass === 'function'
            ? getNameColorClass(player.cosmetics) : '';
        const badgeHtml = typeof getBadgeHtml === 'function'
            ? getBadgeHtml(player.cosmetics) : '';
        
        const div = document.createElement('div');
        div.className = `player-card${isCurrentTurn ? ' current-turn' : ''}${!player.is_alive ? ' eliminated' : ''}${isYou ? ' is-you' : ''}${isAI ? ' is-ai' : ''} ${cosmeticClasses}`;
        div.dataset.playerId = player.id;
        
        // Check if this player recently changed their word
        const hasChangedWord = wordChangeAfterIndex[player.id] !== undefined;
        
        // Calculate danger score
        const topGuesses = topGuessesPerPlayer[player.id];
        const dangerScore = calculateDangerScore(topGuesses);
        const dangerLevel = getDangerLevel(dangerScore);
        
        // Build danger indicator HTML (only for alive players with guesses)
        let dangerHtml = '';
        if (player.is_alive && topGuesses && topGuesses.length > 0) {
            dangerHtml = `<div class="danger-indicator danger-${dangerLevel}" title="Risk: ${(dangerScore * 100).toFixed(0)}%"></div>`;
        }
        
        // Build AI difficulty badge HTML
        let aiDifficultyBadge = '';
        if (isAI && player.difficulty) {
            aiDifficultyBadge = `<span class="ai-difficulty-badge ${player.difficulty}">${player.difficulty}</span>`;
        }
        
        // Build top guesses HTML
        let topGuessesHtml = '';
        if (topGuesses && topGuesses.length > 0) {
            topGuessesHtml = '<div class="top-guesses">';
            topGuesses.forEach(guess => {
                const simClass = getSimilarityClass(guess.similarity);
                topGuessesHtml += `
                    <div class="top-guess">
                        <span class="guess-word">${escapeHtml(guess.word)}</span>
                        <span class="guess-sim ${simClass}">${escapeHtml((guess.similarity * 100).toFixed(0))}%</span>
                    </div>
                `;
            });
            topGuessesHtml += '</div>';
        } else if (hasChangedWord && player.is_alive) {
            topGuessesHtml = '<div class="word-changed-note">Word changed!</div>';
        }
        
        div.innerHTML = `
            ${dangerHtml}
            <div class="name ${nameColorClass}">${escapeHtml(player.name)}${aiDifficultyBadge}${badgeHtml}${isYou ? ' (you)' : ''}</div>
            <div class="status ${player.is_alive ? 'alive' : 'eliminated'}">
                ${player.is_alive ? 'Alive' : 'Eliminated'}
            </div>
            ${topGuessesHtml}
        `;
        grid.appendChild(div);
    });
}

function getSimilarityClass(sim) {
    if (sim >= 0.95) return 'danger';
    if (sim >= 0.7) return 'high';
    if (sim >= 0.4) return 'medium';
    return 'low';
}

function updateTurnIndicator(game) {
    const indicator = document.getElementById('turn-indicator');
    const turnText = document.getElementById('turn-text');
    
    if (game.status === 'finished') {
        indicator.classList.remove('your-turn');
        turnText.textContent = 'Game Over!';
        return;
    }
    
    const currentPlayer = game.players.find(p => p.id === game.current_player_id);
    const isMyTurn = game.current_player_id === gameState.playerId;
    
    if (isMyTurn) {
        indicator.classList.add('your-turn');
        turnText.textContent = "It's your turn! Make a guess.";
    } else {
        indicator.classList.remove('your-turn');
        const aiIndicator = currentPlayer?.is_ai ? ' 🤖' : '';
        turnText.textContent = `Waiting for ${currentPlayer?.name || '...'}${aiIndicator} to guess...`;
    }
}

function updateHistory(game) {
    const historyLog = document.getElementById('history-log');
    historyLog.innerHTML = '';
    
    // Track previous history length to detect new eliminations
    const prevHistoryLength = gameState.prevHistoryLength || 0;
    const currentHistoryLength = game.history.length;
    
    [...game.history].reverse().forEach((entry, reverseIdx) => {
        const originalIdx = game.history.length - 1 - reverseIdx;
        const div = document.createElement('div');
        div.className = 'history-entry';
        
        // Handle word change entries
        if (entry.type === 'word_change') {
            div.className = 'history-entry word-change-entry';
            div.innerHTML = `
                <div class="word-change-notice">
                    <span class="change-icon">🔄</span>
                    <span><strong>${escapeHtml(entry.player_name)}</strong> changed their secret word!</span>
                </div>
            `;
            historyLog.appendChild(div);
            return;
        }
        
        // Play elimination effect for new eliminations
        if (originalIdx >= prevHistoryLength && entry.eliminations && entry.eliminations.length > 0) {
            const guesser = game.players.find(p => p.id === entry.guesser_id);
            const elimEffect = guesser?.cosmetics?.elimination_effect || 'classic';
            entry.eliminations.forEach(eliminatedId => {
                if (typeof playEliminationEffect === 'function') {
                    setTimeout(() => playEliminationEffect(eliminatedId, elimEffect), 100);
                }
            });
        }
        
        let simsHtml = '';
        game.players.forEach(player => {
            const sim = entry.similarities[player.id];
            if (sim !== undefined) {
                const simClass = getSimilarityClass(sim);
                simsHtml += `
                    <div class="sim-badge">
                        <span>${escapeHtml(player.name)}</span>
                        <span class="score ${simClass}">${escapeHtml((sim * 100).toFixed(0))}%</span>
                    </div>
                `;
            }
        });
        
        let eliminationHtml = '';
        if (entry.eliminations && entry.eliminations.length > 0) {
            const eliminatedNames = entry.eliminations.map(id => {
                const p = game.players.find(pl => pl.id === id);
                return p ? escapeHtml(p.name) : 'Unknown';
            });
            eliminationHtml = `<div class="elimination">Eliminated: ${eliminatedNames.join(', ')}</div>`;
        }
        
        // Check if guesser is AI
        const guesser = game.players.find(p => p.id === entry.guesser_id);
        const aiIndicator = guesser?.is_ai ? ' 🤖' : '';
        
        div.innerHTML = `
            <div class="header">
                <span class="guesser">${escapeHtml(entry.guesser_name)}${aiIndicator}</span>
                <span class="word">"${escapeHtml(entry.word)}"</span>
            </div>
            <div class="similarities">${simsHtml}</div>
            ${eliminationHtml}
        `;
        historyLog.appendChild(div);
    });
    
    // Store history length for next update
    gameState.prevHistoryLength = currentHistoryLength;
}

// Guess form - handles both button click and Enter key
document.getElementById('guess-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitGuess();
});

// Also handle Enter key explicitly on the input
document.getElementById('guess-input').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        await submitGuess();
    }
});

async function submitGuess() {
    const guessInput = document.getElementById('guess-input');
    const word = guessInput.value.trim();
    
    if (!word) return;
    if (guessInput.disabled) return;
    
    try {
        // Play guess effect
        const guessEffect = cosmeticsState?.userCosmetics?.guess_effect || 'classic';
        if (typeof playGuessEffect === 'function') {
            playGuessEffect(guessEffect);
        }
        
        await apiCall(`/api/games/${gameState.code}/guess`, 'POST', {
            player_id: gameState.playerId,
            word,
        });
        guessInput.value = '';
    } catch (error) {
        showError(error.message);
    }
}

// Change word - also handle Enter key
document.getElementById('change-word-btn').addEventListener('click', async () => {
    await submitWordChange();
});

// Skip word change button
document.getElementById('skip-word-change-btn').addEventListener('click', async () => {
    try {
        await apiCall(`/api/games/${gameState.code}/skip-word-change`, 'POST', {
            player_id: gameState.playerId,
        });
    } catch (error) {
        showError(error.message);
    }
});

async function submitWordChange() {
    const newWordDisplay = document.getElementById('new-word-display');
    const newWord = newWordDisplay.dataset.word;
    
    if (!newWord) {
        showError('Please select a word');
        return;
    }
    
    try {
        await apiCall(`/api/games/${gameState.code}/change-word`, 'POST', {
            player_id: gameState.playerId,
            new_word: newWord,
        });
        newWordDisplay.textContent = 'Click a word above';
        newWordDisplay.dataset.word = '';
    } catch (error) {
        showError(error.message);
    }
}

// Screen: Game Over
function showGameOver(game) {
    showScreen('gameover');
    
    const winner = game.players.find(p => p.id === game.winner);
    const isWinner = game.winner === gameState.playerId;
    
    // Show trophy animation for winner
    const trophyIcon = document.getElementById('trophy-icon');
    if (trophyIcon) {
        trophyIcon.textContent = isWinner ? '🏆' : '🎮';
    }
    
    document.getElementById('gameover-title').textContent = isWinner ? 'Victory!' : 'Game Over!';
    document.getElementById('gameover-message').textContent = winner 
        ? `${winner.name} is the last one standing!`
        : 'The game has ended.';
    
    // Create victory effect based on winner's cosmetics
    if (isWinner) {
        const victoryEffect = cosmeticsState?.userCosmetics?.victory_effect || 'classic';
        if (typeof playVictoryEffect === 'function') {
            playVictoryEffect(victoryEffect);
        } else {
            createConfetti();
        }
    } else if (winner && winner.cosmetics && winner.cosmetics.victory_effect) {
        // Show winner's victory effect for other players
        if (typeof playVictoryEffect === 'function') {
            playVictoryEffect(winner.cosmetics.victory_effect);
        } else {
            createConfetti();
        }
    }
    
    // Show all players' secret words
    const revealedWords = document.getElementById('revealed-words');
    revealedWords.innerHTML = '<h3>Secret Words Revealed</h3>';
    
    game.players.forEach(player => {
        const isWinnerPlayer = player.id === game.winner;
        const div = document.createElement('div');
        div.className = `revealed-word-item${isWinnerPlayer ? ' winner' : ''}${!player.is_alive ? ' eliminated' : ''}`;
        div.innerHTML = `
            <span class="player-name">${escapeHtml(player.name)}${isWinnerPlayer ? ' 👑' : ''}</span>
            <span class="player-word">${escapeHtml(player.secret_word) || '???'}</span>
        `;
        revealedWords.appendChild(div);
    });
}

function createConfetti() {
    const container = document.getElementById('confetti-container');
    if (!container) return;
    
    container.innerHTML = '';
    const chars = '01<>{}[]/*-+=$#@!';
    
    for (let i = 0; i < 80; i++) {
        const confetti = document.createElement('div');
        confetti.className = 'confetti';
        confetti.textContent = chars[Math.floor(Math.random() * chars.length)];
        confetti.style.left = Math.random() * 100 + '%';
        confetti.style.animationDelay = Math.random() * 3 + 's';
        confetti.style.animationDuration = (Math.random() * 2 + 2) + 's';
        confetti.style.color = '#00ff41';
        confetti.style.textShadow = '0 0 10px #00ff41';
        container.appendChild(confetti);
    }
    
    // Clear confetti after animation
    setTimeout(() => {
        container.innerHTML = '';
    }, 5000);
}

// Back to lobby button
document.getElementById('back-to-lobby-btn')?.addEventListener('click', () => {
    // TODO: Implement returning to same lobby for rematch
    stopPolling();
    gameState.code = null;
    gameState.playerId = null;
    showScreen('home');
    loadLobbies();
});

document.getElementById('play-again-btn').addEventListener('click', () => {
    stopPolling();
    const savedName = gameState.playerName;
    const savedAuthToken = gameState.authToken;
    const savedAuthUser = gameState.authUser;
    gameState = {
        code: null,
        playerId: null,
        playerName: savedName,  // Preserve the name
        isHost: false,
        pollingInterval: null,
        theme: null,
        wordPool: null,
        allThemeWords: null,
        myVote: null,
        authToken: savedAuthToken,
        authUser: savedAuthUser,
        isSingleplayer: false,
    };
    showScreen('home');
});

// Cleanup old polling functions
function stopPolling() {
    if (gameState.pollingInterval) {
        clearInterval(gameState.pollingInterval);
        gameState.pollingInterval = null;
    }
}

// Matrix Rain Effect
function initMatrixRain() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const container = document.getElementById('matrix-bg');
    if (!container) return;
    
    container.appendChild(canvas);
    
    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);
    
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*()';
    const fontSize = 14;
    const columns = Math.floor(canvas.width / fontSize);
    const drops = Array(columns).fill(1);
    
    function draw() {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Get matrix color from CSS variable (set by cosmetics)
        const matrixColor = getComputedStyle(document.documentElement).getPropertyValue('--matrix-color').trim() || '#00ff41';
        ctx.fillStyle = matrixColor;
        ctx.font = fontSize + 'px Courier Prime';
        
        for (let i = 0; i < drops.length; i++) {
            const char = chars[Math.floor(Math.random() * chars.length)];
            ctx.fillText(char, i * fontSize, drops[i] * fontSize);
            
            if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
                drops[i] = 0;
            }
            drops[i]++;
        }
    }
    
    setInterval(draw, 50);
}

// Initialise
initLogin();
initMatrixRain();
showScreen('home');
