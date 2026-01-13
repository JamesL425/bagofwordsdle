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

// ============ BACKGROUND MUSIC ============

const DEFAULT_BGM_CONFIG = {
    enabled: true,
    track: '/manwithaplan.mp3',
    volume: 0.12, // keep it low by default
};

let bgmAudio = null;
let bgmConfig = DEFAULT_BGM_CONFIG;
let bgmInitStarted = false;

function clamp01(n) {
    if (typeof n !== 'number' || Number.isNaN(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function hasUserActivation() {
    // Some browsers expose user activation state; if absent, assume "no"
    try {
        const ua = navigator.userActivation;
        return Boolean(ua && (ua.isActive || ua.hasBeenActive));
    } catch (e) {
        return false;
    }
}

async function loadClientConfig() {
    try {
        const cfg = await apiCall('/api/client-config');
        const music = cfg?.audio?.background_music;
        if (music) {
            bgmConfig = {
                enabled: music.enabled !== false,
                track: typeof music.track === 'string' ? music.track : DEFAULT_BGM_CONFIG.track,
                volume: clamp01(Number(music.volume ?? DEFAULT_BGM_CONFIG.volume)),
            };
        }
    } catch (e) {
        // Non-fatal: fall back to defaults
        console.warn('Failed to load client config; using defaults:', e);
        bgmConfig = DEFAULT_BGM_CONFIG;
    }
}

async function startBackgroundMusic() {
    if (bgmInitStarted) return;
    bgmInitStarted = true;

    await loadClientConfig();
    if (!bgmConfig.enabled) return;

    try {
        bgmAudio = new Audio(bgmConfig.track);
        bgmAudio.loop = true;
        bgmAudio.volume = clamp01(bgmConfig.volume);
        bgmAudio.preload = 'auto';

        const tryPlay = async () => {
            if (!optionsState?.musicEnabled) return;
            try {
                await bgmAudio.play();
            } catch (err) {
                // Autoplay may be blocked; retry on first user interaction.
            }
        };

        // And also on first interaction (covers autoplay restrictions)
        const resume = () => {
            tryPlay();
        };
        window.addEventListener('pointerdown', resume, { once: true, capture: true });
        window.addEventListener('keydown', resume, { once: true, capture: true });
        window.addEventListener('touchstart', resume, { once: true, capture: true });

        // If the browser already considers us "activated" (e.g. after a soft navigation),
        // start immediately without triggering autoplay warnings.
        if (hasUserActivation()) {
            await tryPlay();
        }
    } catch (e) {
        console.warn('Background music init failed:', e);
    }
}

async function applyMusicPreference() {
    // Ensure we attempted init at least once (loads config, creates Audio)
    if (!bgmInitStarted) {
        await startBackgroundMusic();
    }
    if (!bgmAudio) return;
    if (bgmConfig.enabled && optionsState.musicEnabled) {
        // Avoid spamming autoplay warnings on load; resume handler will start it on first interaction.
        if (hasUserActivation()) {
            try {
                await bgmAudio.play();
            } catch (e) {
                // Autoplay may still be blocked; user interaction handler will retry
            }
        }
    } else {
        try {
            bgmAudio.pause();
        } catch (e) {
            // ignore
        }
    }
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
    isSpectator: false,
    spectatorId: null,
};

// ============ OPTIONS ============

const DEFAULT_OPTIONS = {
    chatEnabled: true,
    musicEnabled: true,
    clickSfxEnabled: false,
    eliminationSfxEnabled: true,
};

let optionsState = { ...DEFAULT_OPTIONS };

function loadOptions() {
    try {
        const raw = localStorage.getItem('embeddle_options');
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object') {
            optionsState = { ...DEFAULT_OPTIONS, ...parsed };
        } else {
            optionsState = { ...DEFAULT_OPTIONS };
        }
    } catch (e) {
        optionsState = { ...DEFAULT_OPTIONS };
    }
}

function saveOptions() {
    try {
        localStorage.setItem('embeddle_options', JSON.stringify(optionsState));
    } catch (e) {
        // ignore
    }
}

function applyOptionsToUI() {
    // Sync checkboxes (if present)
    const chatCb = document.getElementById('opt-chat-enabled');
    const musicCb = document.getElementById('opt-music-enabled');
    const clickCb = document.getElementById('opt-click-sfx-enabled');
    const elimCb = document.getElementById('opt-elim-sfx-enabled');

    if (chatCb) chatCb.checked = Boolean(optionsState.chatEnabled);
    if (musicCb) musicCb.checked = Boolean(optionsState.musicEnabled);
    if (clickCb) clickCb.checked = Boolean(optionsState.clickSfxEnabled);
    if (elimCb) elimCb.checked = Boolean(optionsState.eliminationSfxEnabled);

    // Show/hide chat button + close panel when disabled
    const chatBtn = document.getElementById('chat-btn');
    if (chatBtn) chatBtn.classList.toggle('hidden', !optionsState.chatEnabled);
    if (!optionsState.chatEnabled) {
        closeChatPanel?.();
    }

    // Apply music state (best-effort)
    if (typeof applyMusicPreference === 'function') {
        applyMusicPreference();
    }

    // Chat panes might have just been shown/hidden
    if (typeof renderChat === 'function') {
        renderChat();
    }
}

// ============ SOUND EFFECTS (PLACEHOLDER) ============

let sfxAudioCtx = null;

function getSfxContext() {
    if (sfxAudioCtx) return sfxAudioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    sfxAudioCtx = new Ctx();
    return sfxAudioCtx;
}

async function resumeSfxContext() {
    const ctx = getSfxContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (e) {}
    }
}

function playTone({ freq = 800, durationMs = 40, type = 'square', volume = 0.04 } = {}) {
    const ctx = getSfxContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (durationMs / 1000));

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + (durationMs / 1000) + 0.02);
}

function playClickSfx() {
    if (!optionsState.clickSfxEnabled) return;
    resumeSfxContext();
    playTone({ freq: 880, durationMs: 28, type: 'square', volume: 0.03 });
}

function playEliminationSfx() {
    if (!optionsState.eliminationSfxEnabled) return;
    resumeSfxContext();
    // Two quick tones for a "hit" feel
    playTone({ freq: 140, durationMs: 90, type: 'sawtooth', volume: 0.05 });
    setTimeout(() => playTone({ freq: 90, durationMs: 110, type: 'sawtooth', volume: 0.04 }), 60);
}

// ============ TEXT CHAT ============

let chatState = {
    code: null,
    lastId: 0,
    messages: [],
    lastSeenId: 0, // Track what the user has seen (for unread indicator)
};

let chatPollInFlight = false;
let chatSendInFlight = false;

function updateChatUnreadDot() {
    const dot = document.getElementById('chat-unread-dot');
    if (!dot) return;
    // Show dot if there are messages newer than what the user has seen and chat panel is closed
    const hasUnread = chatState.lastId > chatState.lastSeenId && !chatPanelOpen;
    dot.classList.toggle('hidden', !hasUnread);
}

function resetChatIfNeeded() {
    if (chatState.code !== gameState.code) {
        chatState = { code: gameState.code, lastId: 0, messages: [], lastSeenId: 0 };
        renderChat();
        updateChatUnreadDot();
    }
}

function formatChatTime(ts) {
    const n = Number(ts || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    const ms = n < 100000000000 ? n * 1000 : n; // seconds -> ms (heuristic)
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return '';
    try {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
        return d.toTimeString().slice(0, 5);
    }
}

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

function renderChat() {
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

    const msgs = Array.isArray(chatState.messages) ? chatState.messages.slice(-150) : [];
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

async function pollChatOnce() {
    if (!optionsState.chatEnabled) return;
    if (!gameState.code) return;
    if (chatPollInFlight) return;
    chatPollInFlight = true;

    try {
        resetChatIfNeeded();
        const res = await apiCall(`/api/games/${gameState.code}/chat?after=${chatState.lastId}&limit=50`);
        const msgs = Array.isArray(res?.messages) ? res.messages : [];
        if (msgs.length) {
            chatState.messages = chatState.messages.concat(msgs);
            // Trim memory
            if (chatState.messages.length > 300) {
                chatState.messages = chatState.messages.slice(-300);
            }
            const nextLast = Number(res?.last_id ?? chatState.lastId);
            if (Number.isFinite(nextLast) && nextLast > chatState.lastId) {
                chatState.lastId = nextLast;
            } else {
                // Fallback: compute from payloads
                msgs.forEach(m => {
                    const mid = Number(m?.id ?? 0);
                    if (Number.isFinite(mid) && mid > chatState.lastId) chatState.lastId = mid;
                });
            }
            renderChat();
            updateChatUnreadDot();
        }
    } catch (e) {
        // ignore chat polling failures
    } finally {
        chatPollInFlight = false;
    }
}

async function sendChatMessage(text) {
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
        resetChatIfNeeded();
        const res = await apiCall(`/api/games/${gameState.code}/chat`, 'POST', {
            player_id: gameState.playerId,
            message,
        });
        if (res?.message) {
            chatState.messages.push(res.message);
            const mid = Number(res.message?.id ?? 0);
            if (Number.isFinite(mid) && mid > chatState.lastId) chatState.lastId = mid;
            renderChat();
        } else {
            // Fallback: re-poll to pick up server write
            pollChatOnce();
        }
    } catch (e) {
        console.error('Chat send failed:', e);
        // If we got a backend error id, try to fetch the stored debug payload (admin/debug only).
        try {
            const errId = e?.response?.error_id;
            if (errId) {
                const dbg = await apiCall(`/api/debug/chat-error?id=${encodeURIComponent(errId)}`);
                console.error('Chat debug payload:', dbg);
            }
        } catch (dbgErr) {
            // Ignore debug fetch failures (likely not authorized).
        }
        showError(e.message || 'Failed to send message');
    } finally {
        chatSendInFlight = false;
    }
}

// ============ SESSION PERSISTENCE ============

function saveGameSession() {
    if (gameState.code && gameState.playerId) {
        const session = {
            code: gameState.code,
            playerId: gameState.playerId,
            playerName: gameState.playerName,
            isSingleplayer: gameState.isSingleplayer || false,
        };
        localStorage.setItem('embeddle_session', JSON.stringify(session));
        upsertRecentGame(session);
        // Update URL to include game code
        if (window.location.pathname !== `/game/${gameState.code}`) {
            history.pushState({ gameCode: gameState.code }, '', `/game/${gameState.code}`);
        }
    }
}

function clearGameSession() {
    // Keep a record for "recent games" even if the user leaves the session
    const existing = getSavedSession();
    if (existing) upsertRecentGame(existing);
    localStorage.removeItem('embeddle_session');
    // Reset URL to home
    if (window.location.pathname !== '/') {
        history.pushState({}, '', '/');
    }
}

function getSavedSession() {
    try {
        const saved = localStorage.getItem('embeddle_session');
        return saved ? JSON.parse(saved) : null;
    } catch (e) {
        localStorage.removeItem('embeddle_session');
        return null;
    }
}

function getRecentGames() {
    try {
        const raw = localStorage.getItem('embeddle_recent_games');
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        localStorage.removeItem('embeddle_recent_games');
        return [];
    }
}

function upsertRecentGame(session) {
    if (!session?.code) return;
    const list = getRecentGames();
    const now = Date.now();
    const entry = {
        code: session.code,
        playerId: session.playerId || null,
        playerName: session.playerName || null,
        isSingleplayer: Boolean(session.isSingleplayer),
        lastSeen: now,
    };
    const idx = list.findIndex(x => x.code === entry.code && x.playerName === entry.playerName);
    if (idx >= 0) {
        list[idx] = { ...list[idx], ...entry };
    } else {
        list.unshift(entry);
    }
    localStorage.setItem('embeddle_recent_games', JSON.stringify(list.slice(0, 10)));
}

function generateHexId16() {
    const bytes = new Uint8Array(8);
    if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getOrCreateSpectatorId() {
    try {
        const key = 'embeddle_spectator_id';
        const existing = localStorage.getItem(key);
        if (existing && /^[a-f0-9]{16}$/i.test(existing)) {
            return existing.toLowerCase();
        }
        const id = generateHexId16();
        localStorage.setItem(key, id);
        return id;
    } catch (e) {
        return generateHexId16();
    }
}

async function renderRecentGames() {
    const container = document.getElementById('recent-games');
    if (!container) return;
    const list = getRecentGames();
    if (!list.length) {
        container.innerHTML = '<p class="no-lobbies">No recent games.</p>';
        return;
    }

    // Fetch status for each (best-effort)
    const rows = await Promise.all(list.map(async entry => {
        try {
            const g = await apiCall(`/api/games/${entry.code}/spectate`);
            return { entry, status: g.status, playerCount: g.players?.length || 0, isSingleplayer: Boolean(g.is_singleplayer) };
        } catch (e) {
            return { entry, status: 'expired', playerCount: 0, isSingleplayer: entry.isSingleplayer };
        }
    }));

    container.innerHTML = rows.map(({ entry, status, playerCount, isSingleplayer }) => {
        const label = status === 'expired' ? 'EXPIRED' : String(status || '').toUpperCase();
        const mode = isSingleplayer ? 'SOLO' : 'MULTI';
        return `
            <div class="lobby-item" data-code="${escapeHtml(entry.code)}">
                <div class="lobby-info-row">
                    <span class="lobby-code">${escapeHtml(entry.code)}</span>
                    <span class="lobby-players">${escapeHtml(mode)} • ${escapeHtml(label)} • ${escapeHtml(playerCount)} players</span>
                </div>
                <button class="btn btn-small btn-secondary rejoin-game-btn" data-code="${escapeHtml(entry.code)}">
                    ${status === 'expired' ? 'REMOVE' : 'OPEN'}
                </button>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.rejoin-game-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const code = btn.dataset.code;
            if (btn.textContent.trim() === 'REMOVE') {
                const next = getRecentGames().filter(x => x.code !== code);
                localStorage.setItem('embeddle_recent_games', JSON.stringify(next));
                renderRecentGames();
                return;
            }
            history.pushState({ gameCode: code }, '', `/game/${code}`);
            await attemptRejoin();
        });
    });
}

function getGameCodeFromURL() {
    const match = window.location.pathname.match(/^\/game\/([A-Z0-9]+)$/i);
    return match ? match[1].toUpperCase() : null;
}

// Handle browser back/forward buttons
window.addEventListener('popstate', async (event) => {
    const urlCode = getGameCodeFromURL();
    
    if (urlCode) {
        // Navigated to a game URL
        const rejoined = await attemptRejoin();
        if (!rejoined) {
            showScreen('home');
        }
    } else {
        // Navigated away from game
        stopPolling();
        gameState.code = null;
        gameState.playerId = null;
        showScreen('home');
    }
});

// ============ LOGIN SYSTEM ============

function updateRankedUi() {
    const rankedBtn = document.getElementById('ranked-btn');
    const note = document.getElementById('ranked-signin-note');

    // Ranked mode is allowed only when we have an auth token (Google sign-in).
    const hasAuth = Boolean(gameState.authToken);

    if (rankedBtn) rankedBtn.disabled = !hasAuth;
    if (note) note.classList.toggle('hidden', hasAuth);
}

function initLogin() {
    // Set initial ranked UI state (before token/user load finishes)
    updateRankedUi();

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
        showError(msg);
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
            gameState.authToken = null;
            gameState.authUser = null;
            updateRankedUi();
            return;
        }
        
        const user = await response.json();
        gameState.authToken = token;
        gameState.authUser = user;
        setLoggedInWithAuth(user);
        updateRankedUi();
    } catch (error) {
        console.error('Failed to load authenticated user:', error);
        localStorage.removeItem('embeddle_auth_token');
        gameState.authToken = null;
        gameState.authUser = null;
        updateRankedUi();
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
    
    // Load daily quests/currency
    if (typeof loadDaily === 'function') {
        loadDaily();
    }

    updateRankedUi();
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
    updateRankedUi();
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

    updateRankedUi();
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

// Options panel
let optionsPanelOpen = false;

function toggleOptionsPanel() {
    optionsPanelOpen = !optionsPanelOpen;
    const panel = document.getElementById('options-panel');
    if (panel) {
        panel.classList.toggle('open', optionsPanelOpen);
    }
    if (optionsPanelOpen) {
        applyOptionsToUI();
    }
}

function closeOptionsPanel() {
    optionsPanelOpen = false;
    const panel = document.getElementById('options-panel');
    if (panel) panel.classList.remove('open');
}

document.getElementById('options-btn')?.addEventListener('click', toggleOptionsPanel);
document.getElementById('close-options-btn')?.addEventListener('click', closeOptionsPanel);

// Chat panel
let chatPanelOpen = false;

function toggleChatPanel() {
    // Respect chat toggle
    if (!optionsState.chatEnabled) return;
    chatPanelOpen = !chatPanelOpen;
    const panel = document.getElementById('chat-panel');
    if (panel) {
        panel.classList.toggle('open', chatPanelOpen);
    }
    if (chatPanelOpen) {
        // Mark all current messages as seen
        chatState.lastSeenId = chatState.lastId;
        updateChatUnreadDot();
        renderChat();
        pollChatOnce();
    }
}

function closeChatPanel() {
    chatPanelOpen = false;
    const panel = document.getElementById('chat-panel');
    if (panel) panel.classList.remove('open');
    // Mark messages as seen when closing too (user saw them while open)
    chatState.lastSeenId = chatState.lastId;
    updateChatUnreadDot();
}

document.getElementById('chat-btn')?.addEventListener('click', toggleChatPanel);
document.getElementById('close-chat-btn')?.addEventListener('click', closeChatPanel);

// Track last send time for debounce
let lastChatSendTime = 0;
const CHAT_SEND_DEBOUNCE_MS = 150;

document.getElementById('chat-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // Debounce: ignore rapid submits
    const now = Date.now();
    if (now - lastChatSendTime < CHAT_SEND_DEBOUNCE_MS) return;
    
    // Check in-flight before touching input
    if (chatSendInFlight) return;
    
    const input = document.getElementById('chat-input');
    if (!input) return;
    
    const text = input.value.trim();
    if (!text) return;
    
    // Clear input and mark send time BEFORE async call
    input.value = '';
    lastChatSendTime = now;
    
    await sendChatMessage(text);
});

// Option toggle handlers
document.getElementById('opt-chat-enabled')?.addEventListener('change', (e) => {
    optionsState.chatEnabled = Boolean(e.target.checked);
    saveOptions();
    applyOptionsToUI();
});
document.getElementById('opt-music-enabled')?.addEventListener('change', (e) => {
    optionsState.musicEnabled = Boolean(e.target.checked);
    saveOptions();
    applyOptionsToUI();
});
document.getElementById('opt-click-sfx-enabled')?.addEventListener('change', (e) => {
    optionsState.clickSfxEnabled = Boolean(e.target.checked);
    saveOptions();
    applyOptionsToUI();
});
document.getElementById('opt-elim-sfx-enabled')?.addEventListener('change', (e) => {
    optionsState.eliminationSfxEnabled = Boolean(e.target.checked);
    saveOptions();
    applyOptionsToUI();
});

// Global button click SFX (placeholder)
document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button.btn');
    if (!btn) return;
    if (btn.disabled) return;
    playClickSfx();
}, { capture: true });

// DOM Elements
const screens = {
    home: document.getElementById('home-screen'),
    leaderboard: document.getElementById('leaderboard-screen'),
    join: document.getElementById('join-screen'),
    lobby: document.getElementById('lobby-screen'),
    singleplayerLobby: document.getElementById('singleplayer-lobby-screen'),
    wordselect: document.getElementById('wordselect-screen'),
    game: document.getElementById('game-screen'),
    gameover: document.getElementById('gameover-screen'),
};

// Utility functions
// ============ RESPONSIVE IN-GAME PANELS (MOBILE WORDS/LOG DOCK) ============

const GAME_MOBILE_BREAKPOINT_PX = 900;
let responsiveGamePanelsInitialized = false;

function isGameMobileLayout() {
    try {
        return window.matchMedia(`(max-width: ${GAME_MOBILE_BREAKPOINT_PX}px)`).matches;
    } catch (e) {
        return window.innerWidth <= GAME_MOBILE_BREAKPOINT_PX;
    }
}

function moveElementTo(el, newParent) {
    if (!el || !newParent) return;
    if (el.parentElement === newParent) return;
    newParent.appendChild(el);
}

function setGameMobileActiveTab(which) {
    const wordsTab = document.getElementById('game-mobile-tab-words');
    const logTab = document.getElementById('game-mobile-tab-log');
    const wordsPanel = document.getElementById('mobile-words-panel');
    const logPanel = document.getElementById('mobile-log-panel');

    const wordsActive = which !== 'log';

    if (wordsTab) {
        wordsTab.classList.toggle('active', wordsActive);
        wordsTab.setAttribute('aria-selected', String(wordsActive));
    }
    if (logTab) {
        logTab.classList.toggle('active', !wordsActive);
        logTab.setAttribute('aria-selected', String(!wordsActive));
    }
    if (wordsPanel) wordsPanel.classList.toggle('hidden', !wordsActive);
    if (logPanel) logPanel.classList.toggle('hidden', wordsActive);
}

function applyResponsiveGamePanelsLayout() {
    const wordlist = document.getElementById('game-wordlist');
    const historySection = document.getElementById('history-section');

    const sidebar = document.querySelector('#game-screen .game-sidebar');
    const logHost = document.getElementById('game-log-host');

    const mobileWordsPanel = document.getElementById('mobile-words-panel');
    const mobileLogPanel = document.getElementById('mobile-log-panel');

    const mobile = isGameMobileLayout();

    if (mobile) {
        // Default to WORDS tab when entering mobile layout
        const wordsTabSelected = document.getElementById('game-mobile-tab-words')?.getAttribute('aria-selected') === 'true';
        const logTabSelected = document.getElementById('game-mobile-tab-log')?.getAttribute('aria-selected') === 'true';
        if (!wordsTabSelected && !logTabSelected) {
            setGameMobileActiveTab('words');
        }

        moveElementTo(wordlist, mobileWordsPanel);
        moveElementTo(historySection, mobileLogPanel);
        return;
    }

    // Desktop/tablet: move panels back to their primary homes
    moveElementTo(wordlist, sidebar);
    moveElementTo(historySection, logHost);
}

function setupResponsiveGamePanels() {
    if (responsiveGamePanelsInitialized) return;
    responsiveGamePanelsInitialized = true;

    const wordsTab = document.getElementById('game-mobile-tab-words');
    const logTab = document.getElementById('game-mobile-tab-log');

    if (wordsTab) {
        wordsTab.addEventListener('click', () => setGameMobileActiveTab('words'));
    }
    if (logTab) {
        logTab.addEventListener('click', () => setGameMobileActiveTab('log'));
    }

    // Keep layout in sync with screen size changes (rotate / resize)
    window.addEventListener('resize', () => {
        applyResponsiveGamePanelsLayout();
    });

    applyResponsiveGamePanelsLayout();
}

function showScreen(screenName) {
    Object.values(screens).forEach(screen => {
        if (screen) screen.classList.remove('active');
    });
    if (screens[screenName]) screens[screenName].classList.add('active');

    // Allow CSS to widen/adjust layout when actively in a match
    document.body.classList.toggle('in-game', screenName === 'game');

    // Ensure the in-game word list / log live in the correct containers for this viewport
    applyResponsiveGamePanelsLayout();
    
    // Start/stop lobby refresh based on screen
    if (screenName === 'home') {
        startLobbyRefresh();
        startSpectateRefresh();
        renderRecentGames();
    } else {
        stopLobbyRefresh();
        stopSpectateRefresh();
    }
}

setupResponsiveGamePanels();

function showError(message) {
    alert(message);
}

async function apiCall(endpoint, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    // Send auth token when available (required for ranked endpoints)
    if (gameState.authToken) {
        headers['Authorization'] = `Bearer ${gameState.authToken}`;
    }
    const options = {
        method,
        headers,
    };
    
    if (body !== null) {
        options.body = JSON.stringify(body);
    }
    
    let response;
    try {
        response = await fetch(`${API_BASE}${endpoint}`, options);
    } catch (e) {
        throw new Error('Network error - please try again');
    }

    // Don't rely on Content-Type (CDNs/proxies can mislabel errors). Try to parse JSON either way.
    const rawText = await response.text();
    let data = null;
    if (rawText) {
        try {
            data = JSON.parse(rawText);
        } catch (e) {
            data = null;
        }
    }

    if (data === null) {
        // Keep the UI error generic, but log the real response for debugging.
        console.error('Non-JSON API response', {
            endpoint,
            method,
            status: response.status,
            statusText: response.statusText,
            contentType: response.headers.get('content-type'),
            body: rawText?.slice?.(0, 1000) ?? rawText,
        });
        throw new Error(`Server error (${response.status || 'unknown'}) - please try again`);
    }

    if (!response.ok) {
        let msg = data.detail || data.error || data.message || 'An error occurred';
        if (data.error_code) msg += ` [${data.error_code}]`;
        if (data.error_id) msg += ` (ref: ${data.error_id})`;
        if (data.debug && typeof data.debug === 'object') {
            const where = data.debug.where ? String(data.debug.where) : 'debug';
            const typ = data.debug.type ? String(data.debug.type) : '';
            const err = data.debug.error ? String(data.debug.error) : '';
            const trace = data.debug.trace ? String(data.debug.trace) : '';
            msg += `\n\n${where}${typ ? `: ${typ}` : ''}${err ? `: ${err}` : ''}${trace ? `\n${trace}` : ''}`;
        }
        const error = new Error(msg);
        error.status = response.status;
        error.endpoint = endpoint;
        error.method = method;
        error.response = data;
        console.error('API error', { endpoint, method, status: response.status, data });
        throw error;
    }

    return data;
}

// ============ HOME SCREEN ============

let lobbyRefreshInterval = null;
let spectateRefreshInterval = null;

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
                        <span class="lobby-players">
                            ${escapeHtml(lobby.player_count)}/${escapeHtml(lobby.max_players)} operatives
                            ${lobby.is_ranked ? '• RANKED' : '• CASUAL'}
                        </span>
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

// Load public, spectateable games (not finished)
async function loadSpectateGames() {
    const container = document.getElementById('spectate-games');
    if (!container) return;
    try {
        const data = await apiCall('/api/spectateable');
        const games = Array.isArray(data?.games) ? data.games : [];

        if (games.length === 0) {
            container.innerHTML = '<p class="no-lobbies">No live matches right now.</p>';
            return;
        }

        container.innerHTML = games.map(g => {
            const status = String(g.status || '').toUpperCase();
            const ranked = g.is_ranked ? '• RANKED' : '• CASUAL';
            const specs = Number(g.spectator_count || 0);
            const specLabel = `• ${escapeHtml(Number.isFinite(specs) ? specs : 0)} spectators`;
            return `
                <div class="lobby-item" data-code="${escapeHtml(g.code)}">
                    <div class="lobby-info-row">
                        <span class="lobby-code">${escapeHtml(g.code)}</span>
                        <span class="lobby-players">
                            ${escapeHtml(status || 'LIVE')} • ${escapeHtml(g.player_count)}/${escapeHtml(g.max_players)} operatives ${ranked} ${specLabel}
                        </span>
                    </div>
                    <button class="btn btn-small btn-secondary spectate-game-btn" data-code="${escapeHtml(g.code)}">SPECTATE</button>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.spectate-game-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const code = btn.dataset.code;
                if (!code) return;
                history.pushState({ gameCode: code }, '', `/game/${code}`);
                startSpectatePolling(code);
            });
        });
    } catch (error) {
        container.innerHTML = '<p class="error">Failed to load live matches</p>';
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

function startSpectateRefresh() {
    stopSpectateRefresh();
    loadSpectateGames();
    spectateRefreshInterval = setInterval(loadSpectateGames, 3000);
}

function stopSpectateRefresh() {
    if (spectateRefreshInterval) {
        clearInterval(spectateRefreshInterval);
        spectateRefreshInterval = null;
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

function normalizeGameCodeInput(raw) {
    return String(raw || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 6);
}

async function createLobby({ visibility = 'private', isRanked = false } = {}) {
    if (!gameState.playerName) {
        showError('Enter your callsign first (top right)');
        document.getElementById('login-name').focus();
        return;
    }
    if (isRanked && !gameState.authToken) {
        showError('Ranked requires Google sign-in');
        return;
    }
    try {
        const data = await apiCall('/api/games', 'POST', {
            visibility,
            is_ranked: Boolean(isRanked),
        });
        gameState.code = data.code;
        await joinLobby(data.code, gameState.playerName);
    } catch (error) {
        showError(error.message);
    }
}

async function quickPlay({ ranked = false } = {}) {
    if (!gameState.playerName) {
        showError('Enter your callsign first (top right)');
        document.getElementById('login-name').focus();
        return;
    }
    if (ranked && !gameState.authToken) {
        showError('Ranked requires Google sign-in');
        return;
    }

    try {
        const mode = ranked ? 'ranked' : 'unranked';
        const data = await apiCall(`/api/lobbies?mode=${mode}`);
        const lobbies = Array.isArray(data?.lobbies) ? data.lobbies : [];
        // Prefer the most-filled lobby so matches start faster
        const best = lobbies
            .slice()
            .sort((a, b) => (b.player_count || 0) - (a.player_count || 0))[0];

        if (best?.code) {
            await joinLobby(best.code, gameState.playerName);
            return;
        }

        // No suitable lobby: create a fresh public one
        await createLobby({ visibility: 'public', isRanked: ranked });
    } catch (error) {
        showError(error.message);
    }
}

document.getElementById('quickplay-btn')?.addEventListener('click', async () => {
    await quickPlay({ ranked: false });
});

document.getElementById('create-public-btn')?.addEventListener('click', async () => {
    await createLobby({ visibility: 'public', isRanked: false });
});

document.getElementById('create-private-btn')?.addEventListener('click', async () => {
    await createLobby({ visibility: 'private', isRanked: false });
});

document.getElementById('ranked-btn')?.addEventListener('click', async () => {
    await quickPlay({ ranked: true });
});

// Join by code (home screen)
const joinCodeInput = document.getElementById('join-code-input');
joinCodeInput?.addEventListener('input', (e) => {
    e.target.value = normalizeGameCodeInput(e.target.value);
});

async function joinByCodeFromHome() {
    const raw = joinCodeInput?.value || '';
    const code = normalizeGameCodeInput(raw);
    if (code.length !== 6) {
        showError('Enter a 6-character SERVER_ID');
        joinCodeInput?.focus();
        return;
    }
    joinLobbyPrompt(code);
}

document.getElementById('join-code-btn')?.addEventListener('click', joinByCodeFromHome);
joinCodeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        joinByCodeFromHome();
    }
});

document.getElementById('refresh-lobbies-btn')?.addEventListener('click', loadLobbies);
document.getElementById('refresh-spectate-btn')?.addEventListener('click', loadSpectateGames);

// ============ LEADERBOARDS ============

let leaderboardState = {
    mode: 'casual',      // 'casual' | 'ranked'
    casualType: 'alltime' // 'alltime' | 'weekly'
};

function getRankTier(mmr) {
    const v = Number(mmr || 0);
    // NOTE: Avoid emoji icons here (font support varies). We render CSS badges instead.
    if (v >= 1700) return { key: 'diamond', name: 'DIAMOND' };
    if (v >= 1550) return { key: 'platinum', name: 'PLATINUM' };
    if (v >= 1400) return { key: 'gold', name: 'GOLD' };
    if (v >= 1250) return { key: 'silver', name: 'SILVER' };
    if (v >= 1100) return { key: 'bronze', name: 'BRONZE' };
    return { key: 'unranked', name: 'UNRANKED' };
}

function renderRankBadge(tier) {
    if (!tier) return '';
    const key = String(tier.key || 'unranked').toLowerCase();
    const name = String(tier.name || 'UNRANKED');
    return `<span class="rank-badge rank-${escapeHtml(key)}">${escapeHtml(name)}</span>`;
}

function setLeaderboardMode(mode) {
    leaderboardState.mode = mode;
    document.getElementById('lb-casual-panel')?.classList.toggle('hidden', mode !== 'casual');
    document.getElementById('lb-ranked-panel')?.classList.toggle('hidden', mode !== 'ranked');

    // Button styling
    const casualBtn = document.getElementById('lb-tab-casual');
    const rankedBtn = document.getElementById('lb-tab-ranked');
    if (casualBtn) casualBtn.classList.toggle('btn-primary', mode === 'casual');
    if (rankedBtn) rankedBtn.classList.toggle('btn-primary', mode === 'ranked');
    if (casualBtn) casualBtn.classList.toggle('btn-secondary', mode !== 'casual');
    if (rankedBtn) rankedBtn.classList.toggle('btn-secondary', mode !== 'ranked');

    if (mode === 'casual') {
        loadCasualLeaderboard(leaderboardState.casualType);
    } else {
        loadRankedLeaderboard();
    }
}

function setCasualLeaderboardType(type) {
    leaderboardState.casualType = type;
    const allBtn = document.getElementById('lb-casual-alltime');
    const wkBtn = document.getElementById('lb-casual-weekly');
    if (allBtn) allBtn.classList.toggle('btn-primary', type === 'alltime');
    if (wkBtn) wkBtn.classList.toggle('btn-primary', type === 'weekly');
    if (allBtn) allBtn.classList.toggle('btn-ghost', type !== 'alltime');
    if (wkBtn) wkBtn.classList.toggle('btn-ghost', type !== 'weekly');
    loadCasualLeaderboard(type);
}

function renderLeaderboardTable(containerId, headers, rowsHtml) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!rowsHtml) {
        container.innerHTML = '<div class="leaderboard-empty">No data yet.</div>';
        return;
    }
    container.innerHTML = `
        <table class="leaderboard-table">
            <thead>
                <tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>
            </thead>
            <tbody>
                ${rowsHtml}
            </tbody>
        </table>
    `;
}

async function loadCasualLeaderboard(type = 'alltime') {
    const container = document.getElementById('casual-leaderboard-table');
    if (container) container.innerHTML = '<div class="leaderboard-empty">Loading...</div>';
    try {
        const data = await apiCall(`/api/leaderboard?type=${encodeURIComponent(type)}`);
        const players = Array.isArray(data?.players) ? data.players : [];
        const headers = type === 'weekly'
            ? ['Rank', 'Player', 'Weekly wins', 'All-time wins', 'Games', 'Win%']
            : ['Rank', 'Player', 'Wins', 'Games', 'Win%'];

        const rows = players.map((p, idx) => {
            const wins = Number(p?.wins || 0);
            const games = Number(p?.games_played || 0);
            const winRate = games > 0 ? Math.round((wins / games) * 100) : 0;
            const weeklyWins = Number(p?.weekly_wins || 0);
            const rankClass = idx === 0 ? 'rank-1' : idx === 1 ? 'rank-2' : idx === 2 ? 'rank-3' : '';

            if (type === 'weekly') {
                return `
                    <tr>
                        <td class="rank ${rankClass}">${escapeHtml(idx + 1)}</td>
                        <td class="player-name">${escapeHtml(p?.name || '')}</td>
                        <td class="stat">${escapeHtml(weeklyWins)}</td>
                        <td class="stat">${escapeHtml(wins)}</td>
                        <td class="stat">${escapeHtml(games)}</td>
                        <td class="win-rate">${escapeHtml(winRate)}%</td>
                    </tr>
                `;
            }

            return `
                <tr>
                    <td class="rank ${rankClass}">${escapeHtml(idx + 1)}</td>
                    <td class="player-name">${escapeHtml(p?.name || '')}</td>
                    <td class="stat">${escapeHtml(wins)}</td>
                    <td class="stat">${escapeHtml(games)}</td>
                    <td class="win-rate">${escapeHtml(winRate)}%</td>
                </tr>
            `;
        }).join('');

        renderLeaderboardTable('casual-leaderboard-table', headers, rows);
    } catch (e) {
        renderLeaderboardTable('casual-leaderboard-table', ['Rank', 'Player', 'Wins'], '');
    }
}

async function loadRankedLeaderboard() {
    const container = document.getElementById('ranked-leaderboard-table');
    if (container) container.innerHTML = '<div class="leaderboard-empty">Loading...</div>';
    try {
        const data = await apiCall('/api/leaderboard/ranked');
        const players = Array.isArray(data?.players) ? data.players : [];

        const headers = ['Rank', 'Player', 'Tier', 'MMR', 'Peak', 'Games', 'W-L'];

        const rows = players.map((p, idx) => {
            const mmr = Number(p?.mmr || 0);
            const peak = Number(p?.peak_mmr || 0);
            const games = Number(p?.ranked_games || 0);
            const wins = Number(p?.ranked_wins || 0);
            const losses = Number(p?.ranked_losses || 0);
            const tier = getRankTier(mmr);
            const rankClass = idx === 0 ? 'rank-1' : idx === 1 ? 'rank-2' : idx === 2 ? 'rank-3' : '';
            return `
                <tr>
                    <td class="rank ${rankClass}">${escapeHtml(idx + 1)}</td>
                    <td class="player-name">${escapeHtml(p?.name || '')}</td>
                    <td class="stat">${renderRankBadge(tier)}</td>
                    <td class="stat">${escapeHtml(mmr)}</td>
                    <td class="stat">${escapeHtml(peak)}</td>
                    <td class="stat">${escapeHtml(games)}</td>
                    <td class="stat">${escapeHtml(wins)}-${escapeHtml(losses)}</td>
                </tr>
            `;
        }).join('');

        renderLeaderboardTable('ranked-leaderboard-table', headers, rows);
    } catch (e) {
        renderLeaderboardTable('ranked-leaderboard-table', ['Rank', 'Player', 'MMR'], '');
    }
}

// Leaderboard navigation
document.getElementById('open-leaderboard-btn')?.addEventListener('click', () => {
    showScreen('leaderboard');
    // Default to casual view
    setLeaderboardMode(leaderboardState.mode || 'casual');
    setCasualLeaderboardType(leaderboardState.casualType || 'alltime');
});
document.getElementById('lb-back-btn')?.addEventListener('click', () => {
    showScreen('home');
});
document.getElementById('lb-tab-casual')?.addEventListener('click', () => setLeaderboardMode('casual'));
document.getElementById('lb-tab-ranked')?.addEventListener('click', () => setLeaderboardMode('ranked'));
document.getElementById('lb-casual-alltime')?.addEventListener('click', () => setCasualLeaderboardType('alltime'));
document.getElementById('lb-casual-weekly')?.addEventListener('click', () => setCasualLeaderboardType('weekly'));

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
        
        // Save session for persistence
        saveGameSession();
        
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

let spThemeAutoVoted = false;
let spStartInProgress = false;

const AI_DIFFICULTY_INFO = {
    rookie: { label: 'Rookie', tagline: 'Wears a wire, drops a clue.' },
    analyst: { label: 'Desk Analyst', tagline: 'Careful scans. Minimal self-leak.' },
    'field-agent': { label: 'Field Agent', tagline: 'Balanced ops: probes, then strikes.' },
    spymaster: { label: 'Spymaster', tagline: 'Builds a profile. Executes cleanly.' },
    ghost: { label: 'Ghost Protocol', tagline: 'Leaves no trace. Panics into offense.' },
};

function getAiDifficultyInfo(key) {
    const k = (key || '').toString();
    return AI_DIFFICULTY_INFO[k] || { label: k || 'AI', tagline: '' };
}

function updateSingleplayerThemeVoting(options, votes) {
    const container = document.getElementById('sp-theme-vote-options');
    if (!container) return;
    if (!options || options.length === 0) {
        container.innerHTML = '<p class="no-lobbies">Loading databases...</p>';
        return;
    }

    container.innerHTML = options.map(theme => {
        const voters = (votes && votes[theme]) ? votes[theme] : [];
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

async function updateSingleplayerLobby() {
    try {
        const data = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
        
        // Update theme voting UI (singleplayer uses the same vote endpoint, but only the host typically votes)
        updateSingleplayerThemeVoting(data.theme_options || [], data.theme_votes || {});

        // Auto-vote a default theme once so the player sees a selection immediately
        if (!spThemeAutoVoted && data.status === 'waiting' && (data.theme_options || []).length > 0) {
            const alreadyVoted = (data.theme_options || []).some(t => (data.theme_votes?.[t] || []).some(v => v.id === gameState.playerId));
            if (!alreadyVoted) {
                spThemeAutoVoted = true;
                voteForTheme(data.theme_options[0]).catch(() => {
                    // If vote fails (rare), allow retry next poll
                    spThemeAutoVoted = false;
                });
            } else {
                spThemeAutoVoted = true;
            }
        }

        // Update theme display (show voted theme while in lobby)
        let chosenTheme = data.theme?.name;
        if (!chosenTheme) {
            const opts = data.theme_options || [];
            const votes = data.theme_votes || {};
            const myVote = opts.find(t => (votes[t] || []).some(v => v.id === gameState.playerId));
            chosenTheme = myVote || opts[0] || '';
        }
        document.getElementById('sp-theme-name').textContent = chosenTheme || 'Loading...';
        
        // Update players list
        const playersList = document.getElementById('sp-players-list');
        playersList.innerHTML = data.players.map(p => {
            const isYou = p.id === gameState.playerId;
            const isAI = p.is_ai;
            const difficultyClass = isAI ? `ai-${p.difficulty}` : '';
            const diffInfo = isAI ? getAiDifficultyInfo(p.difficulty) : null;
            
            return `
                <div class="sp-player-item ${isYou ? 'is-you' : ''} ${isAI ? 'is-ai' : ''}">
                    <div class="sp-player-info">
                        <span class="sp-player-icon">${isAI ? '🤖' : '👤'}</span>
                        <span class="sp-player-name">${escapeHtml(p.name)}${isYou ? ' (you)' : ''}</span>
                        ${isYou ? '<span class="sp-player-badge host">HOST</span>' : ''}
                        ${isAI ? `<span class="sp-player-badge ${difficultyClass}" title="${escapeHtml(diffInfo?.tagline || '')}">${escapeHtml(diffInfo?.label || p.difficulty)}</span>` : ''}
                    </div>
                    ${isAI ? `<button class="sp-remove-ai" data-ai-id="${escapeHtml(p.id)}" title="Remove AI" aria-label="Remove AI">×</button>` : ''}
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
        const startBtn = document.getElementById('sp-start-game-btn');
        const minPlayersNote = document.getElementById('sp-min-players');

        if (minPlayersNote) {
            if (aiCount < 1) {
                minPlayersNote.textContent = 'Add at least 1 AI opponent';
                minPlayersNote.style.display = '';
            } else {
                minPlayersNote.textContent = 'Ready to start';
                minPlayersNote.style.display = 'none';
            }
        }

        if (startBtn && !spStartInProgress) {
            startBtn.disabled = aiCount < 1;
            // Ensure the label is correct when not actively starting
            startBtn.textContent = '> START_MISSION';
        }
        
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
    const startBtn = document.getElementById('sp-start-game-btn');
    const originalText = startBtn.textContent;
    
    try {
        // Show loading state on button for immediate feedback
        spStartInProgress = true;
        startBtn.disabled = true;
        startBtn.textContent = 'STARTING...';
        
        // Call the API (AI word selection happens server-side)
        const response = await apiCall(`/api/games/${gameState.code}/start`, 'POST', {
            player_id: gameState.playerId,
        });
        
        // Fetch the updated game state with word pools
        const data = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
        
        // Now transition to word selection with the data
        showWordSelectionScreen(data);
    } catch (error) {
        showError(error.message);
        startBtn.disabled = false;
        startBtn.textContent = originalText;
        spStartInProgress = false;
    }
});

// Leave singleplayer lobby
document.getElementById('sp-leave-lobby-btn')?.addEventListener('click', async () => {
    try {
        if (gameState.code && gameState.playerId) {
            await apiCall(`/api/games/${gameState.code}/leave`, 'POST', { player_id: gameState.playerId });
        }
    } catch (e) {
        // best-effort
    }
    if (gameState.pollingInterval) {
        clearInterval(gameState.pollingInterval);
    }
    gameState.code = null;
    gameState.playerId = null;
    gameState.isSingleplayer = false;
    clearGameSession();
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
        
        // Save session for persistence
        saveGameSession();
        
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

        // Chat (best-effort)
        pollChatOnce();
        
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

        // In singleplayer, trigger AI word selection in the background while you choose yours
        maybeTriggerSingleplayerAiWordPick(data);
        
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
    const startBtn = document.getElementById('start-game-btn');
    const originalText = startBtn.textContent;
    
    try {
        // Show loading state on button for immediate feedback
        startBtn.disabled = true;
        startBtn.textContent = 'STARTING...';
        
        // Call the API
        await apiCall(`/api/games/${gameState.code}/start`, 'POST', {
            player_id: gameState.playerId,
        });
        
        // Fetch the updated game state with word pools
        const data = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
        
        // Now transition to word selection with the data
        showWordSelectionScreen(data);
    } catch (error) {
        showError(error.message);
        startBtn.disabled = false;
        startBtn.textContent = originalText;
    }
});

document.getElementById('leave-lobby-btn')?.addEventListener('click', async () => {
    try {
        if (gameState.code && gameState.playerId) {
            await apiCall(`/api/games/${gameState.code}/leave`, 'POST', { player_id: gameState.playerId });
        }
    } catch (e) {
        // best-effort
    }
    if (gameState.pollingInterval) {
        clearInterval(gameState.pollingInterval);
    }
    gameState.code = null;
    gameState.playerId = null;
    clearGameSession();
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
            showWordSelectionScreen(game);
            return;
        }
        
        updateGame(game);
        pollChatOnce();
        maybeRunSingleplayerAiTurns(game);
    } catch (error) {
        console.error('Game poll error:', error);
    }
}

function showGame(game) {
    showScreen('game');
    updateGame(game);
}

function updateGame(game) {
    const isSpectator = Boolean(gameState.isSpectator);
    const myPlayer = game.players.find(p => p.id === gameState.playerId);

    // Always update sidebar meta (turn/spectators/words played), even while waiting for word selection.
    updateSidebarMeta(game);
    
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
    
    if (isSpectator) {
        // Spectator: hide personal state / actions
        document.getElementById('your-secret-word').textContent = 'SPECTATING';
        document.getElementById('change-word-container')?.classList.add('hidden');
    } else if (myPlayer) {
        document.getElementById('your-secret-word').textContent = myPlayer.secret_word || '???';
        
        const changeWordContainer = document.getElementById('change-word-container');
        const wordPoolOptions = document.getElementById('word-pool-options');
        
        if (myPlayer.can_change_word) {
            changeWordContainer.classList.remove('hidden');
            
            // Show word pool options (excluding guessed words)
            const guessedWords = new Set(game.history
                .filter(e => e.word)
                .map(e => e.word.toLowerCase()));
            
            const offeredSample = Array.isArray(myPlayer.word_change_options) && myPlayer.word_change_options.length > 0
                ? myPlayer.word_change_options
                : null;

            const sourceWords = offeredSample || (myPlayer.word_pool || gameState.wordPool || []);
            const availableWords = sourceWords.filter(w => !guessedWords.has(w.toLowerCase()));

            // Only allow keeping your current word if it's in the offered sample
            const keepBtn = document.getElementById('skip-word-change-btn');
            if (keepBtn) {
                if (offeredSample) {
                    const current = (myPlayer.secret_word || '').toLowerCase();
                    const canKeep = offeredSample.some(w => String(w).toLowerCase() === current);
                    keepBtn.classList.toggle('hidden', !canKeep);
                } else {
                    keepBtn.classList.remove('hidden');
                }
            }
            
            if (wordPoolOptions) {
                const newWordDisplay = document.getElementById('new-word-display');

                // Preserve any prior selection across polling updates
                const prevSelectedLower = (newWordDisplay?.dataset?.word || '').toLowerCase();
                const sortedAvailable = availableWords.slice().sort();
                const availableLower = new Set(sortedAvailable.map(w => String(w).toLowerCase()));

                // Only rebuild the DOM if the option set changed
                const optionsKey = sortedAvailable.map(w => String(w).toLowerCase()).join('|');
                const prevOptionsKey = wordPoolOptions.dataset.optionsKey || '';
                const needsRebuild = prevOptionsKey !== optionsKey;

                // Determine the currently selected word (if still valid)
                let selectedLower = prevSelectedLower;
                if (selectedLower && !availableLower.has(selectedLower)) {
                    selectedLower = '';
                }

                // Ensure display matches selection (or default prompt)
                if (newWordDisplay) {
                    if (!selectedLower) {
                        newWordDisplay.textContent = 'Click a word above';
                        newWordDisplay.dataset.word = '';
                    } else {
                        const selectedOriginal = sortedAvailable.find(w => String(w).toLowerCase() === selectedLower) || selectedLower;
                        newWordDisplay.textContent = String(selectedOriginal).toUpperCase();
                        newWordDisplay.dataset.word = String(selectedOriginal);
                    }
                }

                if (needsRebuild) {
                    wordPoolOptions.dataset.optionsKey = optionsKey;
                    wordPoolOptions.innerHTML = '';

                    sortedAvailable.forEach(word => {
                        const wordStr = String(word);
                        const wordLower = wordStr.toLowerCase();
                        const wordEl = document.createElement('span');
                        wordEl.className = 'word-pool-option';
                        if (selectedLower && wordLower === selectedLower) {
                            wordEl.classList.add('selected');
                        }
                        wordEl.textContent = wordStr;
                        wordEl.addEventListener('click', () => {
                            // Deselect others
                            wordPoolOptions.querySelectorAll('.word-pool-option').forEach(w => w.classList.remove('selected'));
                            wordEl.classList.add('selected');
                            if (newWordDisplay) {
                                newWordDisplay.textContent = wordStr.toUpperCase();
                                newWordDisplay.dataset.word = wordStr;
                            }
                        });
                        wordPoolOptions.appendChild(wordEl);
                    });
                } else if (selectedLower) {
                    // Ensure the selected class is still applied (in case the DOM persisted but classes got reset)
                    wordPoolOptions.querySelectorAll('.word-pool-option').forEach(el => {
                        el.classList.toggle('selected', String(el.textContent || '').toLowerCase() === selectedLower);
                    });
                }
            }
        } else {
            changeWordContainer.classList.add('hidden');
            // Reset cached word-change options so next time we re-render
            if (wordPoolOptions) {
                wordPoolOptions.dataset.optionsKey = '';
            }
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
    const isMyTurn = !isSpectator && game.current_player_id === gameState.playerId && myPlayer?.is_alive && !game.waiting_for_word_change;
    const guessInput = document.getElementById('guess-input');
    const guessForm = document.getElementById('guess-form');
    guessInput.disabled = isSpectator || !isMyTurn;
    guessForm.querySelector('button').disabled = isSpectator || !isMyTurn;
    
    if (isMyTurn && !game.waiting_for_word_change) {
        // Only auto-focus guess input if user isn't already typing somewhere else
        const activeEl = document.activeElement;
        const isTypingElsewhere = activeEl && (
            activeEl.tagName === 'INPUT' ||
            activeEl.tagName === 'TEXTAREA' ||
            activeEl.isContentEditable
        );
        if (!isTypingElsewhere) {
            guessInput.focus();
        }
    }
    
    updateHistory(game);
}

function updateSidebarMeta(game) {
    const turnEl = document.getElementById('turn-number');
    const specEl = document.getElementById('spectator-count');
    if (!turnEl || !specEl) return;

    const history = Array.isArray(game?.history) ? game.history : [];
    const guessedWords = history
        // Only count actual guess turns here (forfeit reveals include a word but are not a "turn")
        .filter(e => e && e.word && e.type !== 'forfeit')
        .map(e => String(e.word));

    const guessCount = guessedWords.length;
    const turnNumber = game?.status === 'finished' ? guessCount : (guessCount + 1);
    turnEl.textContent = String(turnNumber);

    const spectatorCount = Number(game?.spectator_count ?? 0);
    specEl.textContent = String(Number.isFinite(spectatorCount) ? spectatorCount : 0);
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
        // Skip non-guess history entries (they don't have similarities)
        if (entry.type === 'word_change' || entry.type === 'forfeit') return;
        
        game.players.forEach(player => {
            // Skip if this guess was before the player's word change
            const changeIndex = wordChangeAfterIndex[player.id];
            if (changeIndex !== undefined && index < changeIndex) {
                return;  // This guess was before their word change, ignore it
            }
            
            const sim = entry.similarities?.[player.id];
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
            const diffInfo = getAiDifficultyInfo(player.difficulty);
            aiDifficultyBadge = `<span class="ai-difficulty-badge ${escapeHtml(player.difficulty)}" title="${escapeHtml(diffInfo.tagline || '')}">${escapeHtml(diffInfo.label || player.difficulty)}</span>`;
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

        // Handle forfeit entries (server-side leave -> eliminated)
        if (entry.type === 'forfeit') {
            div.className = 'history-entry word-change-entry';
            const revealedWord = entry.word ? String(entry.word) : '';
            div.innerHTML = `
                <div class="word-change-notice">
                    <span class="change-icon">🏳️</span>
                    <span><strong>${escapeHtml(entry.player_name || 'Operative')}</strong> forfeited${revealedWord ? ` — word was "${escapeHtml(revealedWord)}"` : ''}.</span>
                </div>
            `;
            historyLog.appendChild(div);

            // Play elimination feedback for new forfeits
            if (originalIdx >= prevHistoryLength) {
                playEliminationSfx();
                const pid = entry.player_id;
                if (pid && typeof playEliminationEffect === 'function') {
                    setTimeout(() => playEliminationEffect(pid, 'classic'), 100);
                }
            }
            return;
        }
        
        // Play elimination effect for new eliminations
        if (originalIdx >= prevHistoryLength && entry.eliminations && entry.eliminations.length > 0) {
            playEliminationSfx();
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
            const sim = entry.similarities?.[player.id];
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
    
    const originalPlaceholder = guessInput.placeholder;

    // Immediately clear input and disable for responsive feel
    guessInput.value = '';
    guessInput.disabled = true;
    guessInput.placeholder = 'Processing...';
    
    try {
        // Play guess effect
        const guessEffect = cosmeticsState?.userCosmetics?.guess_effect || 'classic';
        if (typeof playGuessEffect === 'function') {
            playGuessEffect(guessEffect);
        }
        
        const response = await apiCall(`/api/games/${gameState.code}/guess`, 'POST', {
            player_id: gameState.playerId,
            word,
        });

        // Immediately show YOUR result first
        const game = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
        updateGame(game);

        // Then let AIs take their turns with simulated thinking time
        maybeRunSingleplayerAiTurns(game);
    } catch (error) {
        showError(error.message);
    } finally {
        // Restore placeholder; input enabled/disabled is managed by updateGame()
        guessInput.placeholder = originalPlaceholder;
    }
}

// ============ SINGLEPLAYER AI TURN RUNNER ============

let singleplayerAiRunnerActive = false;
let singleplayerAiPickWordsInFlight = false;
let singleplayerAiPickWordsLastAttempt = 0;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function maybeTriggerSingleplayerAiWordPick(game) {
    if (!game?.is_singleplayer) return;
    if (game.status !== 'word_selection') return;
    const hasUnpickedAi = (game.players || []).some(p => p.is_ai && !p.has_word);
    if (!hasUnpickedAi) return;
    if (singleplayerAiPickWordsInFlight) return;
    const now = Date.now();
    if (now - singleplayerAiPickWordsLastAttempt < 1500) return; // simple cooldown
    singleplayerAiPickWordsLastAttempt = now;
    singleplayerAiPickWordsInFlight = true;

    // Fire-and-forget: let AIs pick words while the human chooses theirs
    apiCall(`/api/games/${gameState.code}/ai-pick-words`, 'POST', {
        player_id: gameState.playerId,
    }).catch(err => {
        console.error('AI pick-words error:', err);
    }).finally(() => {
        singleplayerAiPickWordsInFlight = false;
    });
}

function isAiTurn(game) {
    const current = game.players?.find(p => p.id === game.current_player_id);
    return Boolean(game.is_singleplayer && game.status === 'playing' && !game.waiting_for_word_change && current?.is_ai);
}

async function maybeRunSingleplayerAiTurns(game) {
    if (singleplayerAiRunnerActive) return;
    if (!game || !isAiTurn(game)) return;
    // Fire and forget - keep UI responsive
    runSingleplayerAiTurns().catch(err => console.error('AI runner error:', err));
}

async function runSingleplayerAiTurns() {
    if (singleplayerAiRunnerActive) return;
    singleplayerAiRunnerActive = true;

    try {
        while (true) {
            const game = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
            if (!isAiTurn(game)) break;

            const currentAi = game.players.find(p => p.id === game.current_player_id);
            const turnText = document.getElementById('turn-text');
            if (turnText && currentAi) {
                turnText.textContent = `${currentAi.name} is thinking...`;
            }

            // Simulated thinking time (requested: ~1s per AI)
            await sleep(1000);

            // Process exactly one AI move server-side
            await apiCall(`/api/games/${gameState.code}/ai-step`, 'POST', {
                player_id: gameState.playerId,
            });

            // Show updated state after that single AI move
            const updated = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
            if (updated.status === 'finished') {
                clearInterval(gameState.pollingInterval);
                showGameOver(updated);
                break;
            }
            updateGame(updated);
        }
    } finally {
        singleplayerAiRunnerActive = false;
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

        const game = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
        updateGame(game);
        maybeRunSingleplayerAiTurns(game);
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

        const game = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
        updateGame(game);
        maybeRunSingleplayerAiTurns(game);
    } catch (error) {
        showError(error.message);
    }
}

// Screen: Game Over
function showGameOver(game) {
    showScreen('gameover');
    
    // Refresh daily quests (progress may have updated)
    if (typeof loadDaily === 'function') {
        loadDaily();
    }
    
    const winner = game.players.find(p => p.id === game.winner);
    const isWinner = game.winner === gameState.playerId;
    const isRanked = Boolean(game.is_ranked);
    
    // Show trophy animation for winner
    const trophyIcon = document.getElementById('trophy-icon');
    if (trophyIcon) {
        trophyIcon.textContent = isWinner ? '🏆' : '🎮';
    }
    
    document.getElementById('gameover-title').textContent = isWinner ? 'Victory!' : 'Game Over!';
    const msgEl = document.getElementById('gameover-message');
    const baseMsg = winner ? `${winner.name} is the last one standing!` : 'The game has ended.';

    // Ranked: show your MMR + delta (if available)
    let rankedLine = '';
    if (isRanked) {
        const me = game.players.find(p => p.id === gameState.playerId);
        const mmr = Number(me?.mmr);
        const delta = Number(me?.mmr_delta);
        if (Number.isFinite(mmr) && Number.isFinite(delta)) {
            const sign = delta > 0 ? '+' : '';
            rankedLine = `\nMMR: ${mmr} (${sign}${delta})`;
        } else if (Number.isFinite(mmr)) {
            rankedLine = `\nMMR: ${mmr}`;
        }
    }
    if (msgEl) msgEl.textContent = baseMsg + rankedLine;
    
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

        let mmrHtml = '';
        if (isRanked && Number.isFinite(Number(player?.mmr))) {
            const mmr = Number(player.mmr);
            const delta = Number(player?.mmr_delta);
            const showDelta = Number.isFinite(delta);
            const sign = showDelta && delta > 0 ? '+' : '';
            mmrHtml = `
                <span class="player-mmr" title="Match MMR change">${escapeHtml(mmr)}${showDelta ? ` (${escapeHtml(sign)}${escapeHtml(delta)})` : ''}</span>
            `;
        }

        div.innerHTML = `
            <span class="player-name">${escapeHtml(player.name)}${isWinnerPlayer ? ' 👑' : ''}</span>
            <span class="player-word">${escapeHtml(player.secret_word) || '???'}</span>
            ${mmrHtml}
        `;
        revealedWords.appendChild(div);
    });
}

function createConfetti(targetEl = null) {
    const container = targetEl || document.getElementById('confetti-container');
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
    clearGameSession();
    gameState.code = null;
    gameState.playerId = null;
    showScreen('home');
    loadLobbies();
});

// Leave game (in-match) with confirmation
function openLeaveGameModal() {
    const modal = document.getElementById('leave-game-modal');
    if (!modal) return;

    const textEl = modal.querySelector('.modal-text');
    const exitBtn = document.getElementById('leave-game-exit');
    const confirmBtn = document.getElementById('leave-game-confirm'); // forfeit button

    if (gameState.isSpectator) {
        if (textEl) textEl.textContent = 'Stop spectating and return to base?';
        if (exitBtn) {
            exitBtn.textContent = '> LEAVE';
            exitBtn.classList.remove('hidden');
        }
        if (confirmBtn) confirmBtn.classList.add('hidden');
    } else if (gameState.isSingleplayer) {
        if (textEl) textEl.textContent = 'Exit to base? Your solo run will stay active — reopen it from Recent Games.';
        if (exitBtn) {
            exitBtn.textContent = '> SAVE & EXIT';
            exitBtn.classList.remove('hidden');
        }
        if (confirmBtn) {
            confirmBtn.textContent = '> FORFEIT';
            confirmBtn.classList.remove('hidden');
        }
    } else {
        if (textEl) textEl.textContent = 'Are you sure? Leaving will forfeit your current match.';
        if (exitBtn) exitBtn.classList.add('hidden');
        if (confirmBtn) {
            confirmBtn.textContent = '> FORFEIT';
            confirmBtn.classList.remove('hidden');
        }
    }

    modal.classList.remove('hidden');
}

function closeLeaveGameModal() {
    const modal = document.getElementById('leave-game-modal');
    if (!modal) return;
    modal.classList.add('hidden');
}

async function confirmLeaveGame({ forfeit = false } = {}) {
    closeLeaveGameModal();

    // Spectators just return home (no server-side action)
    if (gameState.isSpectator) {
        stopPolling();
        clearGameSession();
        gameState.code = null;
        gameState.playerId = null;
        gameState.isSpectator = false;
        showScreen('home');
        loadLobbies();
        return;
    }

    const code = gameState.code;
    const playerId = gameState.playerId;

    try {
        if (code && playerId) {
            const payload = { player_id: playerId };
            // Only solo games support "soft exit" vs "forfeit".
            if (gameState.isSingleplayer && forfeit) {
                payload.forfeit = true;
            }
            await apiCall(`/api/games/${code}/leave`, 'POST', payload);
        }
    } catch (e) {
        // Best-effort: still leave locally
        console.warn('Leave game request failed:', e);
    } finally {
        stopPolling();
        clearGameSession();
        gameState.code = null;
        gameState.playerId = null;
        gameState.isSingleplayer = false;
        gameState.isSpectator = false;
        showScreen('home');
        loadLobbies();
    }
}

document.getElementById('leave-game-btn')?.addEventListener('click', openLeaveGameModal);
document.getElementById('leave-game-cancel')?.addEventListener('click', closeLeaveGameModal);
document.getElementById('leave-game-exit')?.addEventListener('click', () => confirmLeaveGame({ forfeit: false }));
document.getElementById('leave-game-confirm')?.addEventListener('click', () => confirmLeaveGame({ forfeit: true }));

document.getElementById('leave-game-modal')?.addEventListener('click', (e) => {
    if (e.target?.dataset?.close) closeLeaveGameModal();
});

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeLeaveGameModal();
    }
});

// NOTE: No "play again" button on game over (intentionally removed for a simpler flow).

// Cleanup old polling functions
function stopPolling() {
    if (gameState.pollingInterval) {
        clearInterval(gameState.pollingInterval);
        gameState.pollingInterval = null;
    }
}

// ============ SPECTATOR MODE ============

function startSpectatePolling(code) {
    stopPolling();
    gameState.code = code;
    gameState.isSpectator = true;
    gameState.spectatorId = getOrCreateSpectatorId();
    pollSpectate();
    gameState.pollingInterval = setInterval(pollSpectate, 2000);
}

function showSpectateLobby(game) {
    // Reuse lobby UI but make it read-only
    document.getElementById('lobby-code').textContent = game.code;
    showScreen('lobby');

    // Hide host controls and voting interactions
    document.getElementById('host-controls')?.classList.add('hidden');

    // Players list
    const playersList = document.getElementById('lobby-players');
    if (playersList) {
        playersList.innerHTML = (game.players || []).map(p => `
            <div class="lobby-player ${p.id === game.host_id ? 'host' : ''}">
                <span class="player-name">${escapeHtml(p.name)}</span>
                ${p.id === game.host_id ? '<span class="host-badge">HOST</span>' : ''}
            </div>
        `).join('');
    }

    const countEl = document.getElementById('player-count');
    if (countEl) countEl.textContent = (game.players || []).length;

    // Read-only theme voting
    const container = document.getElementById('theme-vote-options');
    const options = game.theme_options || [];
    const votes = game.theme_votes || {};
    if (container && options.length) {
        container.innerHTML = options.map(theme => {
            const voters = votes[theme] || [];
            const voteCount = voters.length;
            const voterNames = voters.map(v => escapeHtml(v.name)).join(', ');
            return `
                <button class="btn theme-vote-btn" disabled>
                    <span class="theme-name">${escapeHtml(theme)}</span>
                    <span class="vote-count">${escapeHtml(voteCount)} vote${voteCount !== 1 ? 's' : ''}</span>
                    ${voterNames ? `<span class="voter-names">${voterNames}</span>` : ''}
                </button>
            `;
        }).join('');
    }
}

async function pollSpectate() {
    if (!gameState.code) return;
    try {
        const sid = gameState.spectatorId || getOrCreateSpectatorId();
        gameState.spectatorId = sid;
        const game = await apiCall(`/api/games/${gameState.code}/spectate?spectator_id=${encodeURIComponent(sid)}`);
        if (game.status === 'waiting') {
            showSpectateLobby(game);
            pollChatOnce();
            return;
        }
        // Finished games should still render; showGameOver will reveal if provided
        if (game.status === 'finished') {
            clearInterval(gameState.pollingInterval);
            showGameOver(game);
            return;
        }
        // word_selection / playing -> game screen
        showScreen('game');
        updateGame(game);
        pollChatOnce();
    } catch (e) {
        console.error('Spectate poll error:', e);
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

// Attempt to rejoin a game from URL or saved session
async function attemptRejoin() {
    // Check URL first
    const urlCode = getGameCodeFromURL();
    const savedSession = getSavedSession();
    const recentGames = getRecentGames();
    
    // Determine which code and session to use
    let code = urlCode;
    let playerId = null;
    let playerName = gameState.playerName;
    let isSingleplayer = false;
    
    if (savedSession) {
        // If URL has a code, use it but check if saved session matches
        if (urlCode && savedSession.code === urlCode) {
            playerId = savedSession.playerId;
            playerName = savedSession.playerName || playerName;
            isSingleplayer = savedSession.isSingleplayer || false;
        } else if (!urlCode) {
            // No URL code, use saved session
            code = savedSession.code;
            playerId = savedSession.playerId;
            playerName = savedSession.playerName || playerName;
            isSingleplayer = savedSession.isSingleplayer || false;
        }
    }

    // If we have a URL code but no active session, try to restore from recent games
    if (urlCode && !playerId) {
        const recent = recentGames.find(r => r.code === urlCode);
        if (recent) {
            playerId = recent.playerId || playerId;
            playerName = recent.playerName || playerName;
            isSingleplayer = recent.isSingleplayer || isSingleplayer;
        }
    }
    
    if (!code) {
        return false; // No game to rejoin
    }
    
    try {
        // Try to fetch the game state (spectate endpoint works without membership)
        const game = playerId
            ? await apiCall(`/api/games/${code}?player_id=${playerId}`)
            : await apiCall(`/api/games/${code}/spectate`);
        
        if (!game || game.status === 'finished') {
            // Game is over or doesn't exist
            clearGameSession();
            return false;
        }
        
        // Check if our player is still in the game
        const player = playerId 
            ? game.players.find(p => p.id === playerId)
            : game.players.find(p => p.name.toLowerCase() === playerName?.toLowerCase());
        
        if (!player) {
            // Not a participant. If lobby is open and we have a callsign, join; otherwise spectate.
            if (playerName && game.status === 'waiting') {
                if (isSingleplayer || game.is_singleplayer) {
                    await joinSingleplayerLobby(code, playerName);
                } else {
                    await joinLobby(code, playerName);
                }
                return true;
            }
            // Spectate started games
            startSpectatePolling(code);
            return true;
        }
        
        // Restore game state
        gameState.code = code;
        gameState.playerId = player.id;
        gameState.playerName = player.name;
        gameState.isHost = game.host_id === player.id;
        gameState.isSingleplayer = game.is_singleplayer || false;
        gameState.isSpectator = false;
        
        // Save/update the session
        saveGameSession();
        
        // Navigate to appropriate screen based on game status
        if (game.status === 'waiting') {
            if (gameState.isSingleplayer) {
                showScreen('singleplayerLobby');
                startSingleplayerLobbyPolling();
            } else {
                document.getElementById('lobby-code').textContent = code;
                showScreen('lobby');
                startLobbyPolling();
            }
        } else if (game.status === 'word_selection') {
            showWordSelectionScreen(game);
        } else if (game.status === 'playing') {
            // Check if we still need to pick our word
            const myPlayer = game.players.find(p => p.id === gameState.playerId);
            if (!myPlayer.has_word) {
                showWordSelectionScreen(game);
            } else {
                showScreen('game');
                startGamePolling();
            }
        } else {
            // Fallback: spectate unknown states
            startSpectatePolling(code);
        }
        
        return true;
    } catch (error) {
        console.error('Failed to rejoin game:', error);
        clearGameSession();
        return false;
    }
}

// Initialise
initLogin();
initMatrixRain();
loadOptions();
applyOptionsToUI();
startBackgroundMusic();

// Try to rejoin existing game, otherwise show home
attemptRejoin().then(rejoined => {
    if (!rejoined) {
showScreen('home');
    }
});
