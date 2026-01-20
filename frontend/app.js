/**
 * EMBEDDLE - Client Application
 */

// API_BASE is defined in cosmetics.js (loaded first)

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

// ============ SIMILARITY TRANSFORM ============
// Transform raw cosine similarity to more intuitive display values
// Uses sigmoid-like function: t(s) = s^n / (s^n + (c*(1-s))^n) where c = m/(1-m)
const SIMILARITY_TRANSFORM = {
    n: 3,      // Exponent - controls curve steepness
    m: 0.36    // Midpoint - raw value that maps to 50% transformed
};

/**
 * Transform raw cosine similarity to display value
 * @param {number} s - Raw cosine similarity (0-1)
 * @returns {number} - Transformed similarity (0-1)
 */
function transformSimilarity(s) {
    const { n, m } = SIMILARITY_TRANSFORM;
    const c = m / (1 - m);
    const sn = Math.pow(s, n);
    const cn = Math.pow(c * (1 - s), n);
    return sn / (sn + cn);
}

/**
 * Get color for similarity value on green-to-red spectrum
 * @param {number} sim - Transformed similarity (0-1)
 * @returns {string} - HSL color string
 */
function getSimilarityColor(sim) {
    // Map 0-1 to hue 120 (green) to 0 (red)
    const hue = Math.round((1 - sim) * 120);
    return `hsl(${hue}, 100%, 50%)`;
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
        // Apply user's saved volume preference combined with config base volume
        const musicVol = typeof optionsState?.musicVolume === 'number' ? optionsState.musicVolume : 12;
        bgmAudio.volume = clamp01((musicVol / 100) * bgmConfig.volume * (100 / 12));
        bgmAudio.preload = 'auto';

        const tryPlay = async () => {
            const musicVol = typeof optionsState?.musicVolume === 'number' ? optionsState.musicVolume : 12;
            if (musicVol <= 0) return;
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
    
    const musicVol = typeof optionsState.musicVolume === 'number' ? optionsState.musicVolume : 12;
    // Update volume: combine user volume with config base volume
    bgmAudio.volume = clamp01((musicVol / 100) * bgmConfig.volume * (100 / 12));
    
    if (bgmConfig.enabled && musicVol > 0) {
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
    // Timer state (chess clock model)
    turnTimerInterval: null,
    currentPlayerTime: null,  // Current player's time remaining
    turnStartedAt: null,      // When current turn started (client timestamp)
    timeControl: null,        // {initial_time, increment}
    game: null,               // Current game state for reference
    // Word selection timer state
    wordSelectionTimerInterval: null,
    wordSelectionTime: null,
    wordSelectionTimeRemaining: null,
    wordSelectionStartedAt: null,
    // Word change timer state (after elimination)
    wordChangeTimerInterval: null,
    wordChangeTimeRemaining: null,
    // Local flag to track if user has locked their word (prevents race with timeout)
    hasLockedWord: false,
    // Local flag to track if user has submitted word change (prevents race with timeout)
    hasSubmittedWordChange: false,
    // Local flag to track if a guess is currently being submitted (prevents race with timeout)
    isSubmittingGuess: false,
    // Queue/matchmaking state
    queueMode: null,           // 'quick_play' or 'ranked'
    queuePlayerId: null,       // Player ID for queue session
    queuePollingInterval: null,
    queueStartTime: null,      // When queue was joined (for local timer)
};

// ============ OPTIONS ============

const DEFAULT_OPTIONS = {
    chatEnabled: true,
    musicVolume: 12,      // 0-100, default 12%
    sfxVolume: 50,        // 0-100, default 50%
    turnNotificationsEnabled: true,
    nerdMode: false,  // Show embedding details for ML enthusiasts
};

let optionsState = { ...DEFAULT_OPTIONS };

function loadOptions() {
    try {
        const raw = localStorage.getItem('embeddle_options');
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object') {
            // Migrate old boolean options to volume
            if (typeof parsed.musicEnabled === 'boolean') {
                parsed.musicVolume = parsed.musicEnabled ? 12 : 0;
                delete parsed.musicEnabled;
            }
            // Migrate old SFX toggles - default to 50% for new system
            // (old clickSfxEnabled was false by default, so we ignore it for migration)
            if (typeof parsed.clickSfxEnabled !== 'undefined' || typeof parsed.eliminationSfxEnabled !== 'undefined') {
                // If elimination SFX was on (the main one), enable SFX at 50%
                const hadSfx = parsed.eliminationSfxEnabled !== false;
                parsed.sfxVolume = hadSfx ? 50 : 0;
                delete parsed.clickSfxEnabled;
                delete parsed.eliminationSfxEnabled;
            }
            // Ensure sfxVolume has a value (for users with partial old settings)
            if (typeof parsed.sfxVolume !== 'number') {
                parsed.sfxVolume = 50;
            }
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
    // Sync checkboxes and sliders (if present)
    const chatCb = document.getElementById('opt-chat-enabled');
    const musicSlider = document.getElementById('opt-music-volume');
    const musicDisplay = document.getElementById('music-volume-display');
    const sfxSlider = document.getElementById('opt-sfx-volume');
    const sfxDisplay = document.getElementById('sfx-volume-display');
    const turnNotifCb = document.getElementById('opt-turn-notifications');
    const nerdCb = document.getElementById('opt-nerd-mode');

    if (chatCb) chatCb.checked = Boolean(optionsState.chatEnabled);
    
    // Music volume
    const musicVol = typeof optionsState.musicVolume === 'number' ? optionsState.musicVolume : 12;
    if (musicSlider) musicSlider.value = musicVol;
    if (musicDisplay) musicDisplay.textContent = `${musicVol}%`;
    
    // SFX volume
    const sfxVol = typeof optionsState.sfxVolume === 'number' ? optionsState.sfxVolume : 50;
    if (sfxSlider) sfxSlider.value = sfxVol;
    if (sfxDisplay) sfxDisplay.textContent = `${sfxVol}%`;
    
    if (turnNotifCb) turnNotifCb.checked = Boolean(optionsState.turnNotificationsEnabled);
    if (nerdCb) nerdCb.checked = Boolean(optionsState.nerdMode);

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
    
    // Apply nerd mode to body class
    document.body.classList.toggle('nerd-mode', Boolean(optionsState.nerdMode));
}

// ============ SOUND EFFECTS ============

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

function getEffectiveSfxVolume() {
    const vol = typeof optionsState.sfxVolume === 'number' ? optionsState.sfxVolume : 50;
    return vol / 100;
}

function playTone({ freq = 800, durationMs = 40, type = 'square', volume = 0.04 } = {}) {
    const effectiveVolume = getEffectiveSfxVolume();
    if (effectiveVolume <= 0) return;
    
    const ctx = getSfxContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);

    // Scale volume by SFX volume setting
    const scaledVolume = volume * effectiveVolume;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, scaledVolume), now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (durationMs / 1000));

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + (durationMs / 1000) + 0.02);
}

function playEliminationSfx() {
    if (getEffectiveSfxVolume() <= 0) return;
    resumeSfxContext();
    // Two quick tones for a "hit" feel
    playTone({ freq: 140, durationMs: 90, type: 'sawtooth', volume: 0.05 });
    setTimeout(() => playTone({ freq: 90, durationMs: 110, type: 'sawtooth', volume: 0.04 }), 60);
}

// Victory sound effect - triumphant ascending tones
function playVictorySfx() {
    if (getEffectiveSfxVolume() <= 0) return;
    resumeSfxContext();
    // Ascending triumphant chord
    const notes = [523, 659, 784, 1047]; // C5, E5, G5, C6
    notes.forEach((freq, i) => {
        setTimeout(() => {
            playTone({ freq, durationMs: 200, type: 'sine', volume: 0.06 });
        }, i * 80);
    });
    // Final flourish
    setTimeout(() => {
        playTone({ freq: 1047, durationMs: 400, type: 'sine', volume: 0.08 });
        playTone({ freq: 1319, durationMs: 400, type: 'sine', volume: 0.05 }); // E6
    }, 400);
}

// Quest complete sound effect - satisfying ding
function playQuestCompleteSfx() {
    if (getEffectiveSfxVolume() <= 0) return;
    resumeSfxContext();
    // Two-tone satisfying ding
    playTone({ freq: 880, durationMs: 80, type: 'sine', volume: 0.05 });
    setTimeout(() => {
        playTone({ freq: 1320, durationMs: 150, type: 'sine', volume: 0.06 });
    }, 60);
}

// Rank up sound effect - fanfare-like sequence
function playRankUpSfx() {
    if (getEffectiveSfxVolume() <= 0) return;
    resumeSfxContext();
    // Dramatic ascending fanfare
    const fanfare = [
        { freq: 392, delay: 0 },     // G4
        { freq: 494, delay: 100 },   // B4
        { freq: 587, delay: 200 },   // D5
        { freq: 784, delay: 300 },   // G5
        { freq: 988, delay: 450 },   // B5
        { freq: 1175, delay: 600 },  // D6
    ];
    
    fanfare.forEach(({ freq, delay }) => {
        setTimeout(() => {
            playTone({ freq, durationMs: 180, type: 'sine', volume: 0.06 });
        }, delay);
    });
    
    // Final chord
    setTimeout(() => {
        playTone({ freq: 784, durationMs: 500, type: 'sine', volume: 0.07 });
        playTone({ freq: 988, durationMs: 500, type: 'sine', volume: 0.05 });
        playTone({ freq: 1175, durationMs: 500, type: 'sine', volume: 0.04 });
    }, 750);
}

// MMR change sound effect
function playMMRChangeSfx(isGain) {
    if (getEffectiveSfxVolume() <= 0) return;
    resumeSfxContext();
    if (isGain) {
        // Ascending positive tone
        playTone({ freq: 440, durationMs: 100, type: 'sine', volume: 0.04 });
        setTimeout(() => {
            playTone({ freq: 554, durationMs: 100, type: 'sine', volume: 0.04 });
        }, 80);
        setTimeout(() => {
            playTone({ freq: 659, durationMs: 150, type: 'sine', volume: 0.05 });
        }, 160);
    } else {
        // Descending negative tone
        playTone({ freq: 440, durationMs: 100, type: 'sine', volume: 0.04 });
        setTimeout(() => {
            playTone({ freq: 370, durationMs: 100, type: 'sine', volume: 0.04 });
        }, 80);
        setTimeout(() => {
            playTone({ freq: 311, durationMs: 150, type: 'sine', volume: 0.05 });
        }, 160);
    }
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
        ? msgs.map(m => {
            const senderName = m.sender_name || '???';
            return `
            <div class="chat-message">
                ${formatChatTime(m.ts) ? `<span class="chat-time" title="${escapeHtml(formatChatTimeTitle(m.ts))}">${escapeHtml(formatChatTime(m.ts))}</span>` : ''}
                <span class="chat-sender clickable-profile" data-player-name="${escapeHtml(senderName)}">${escapeHtml(senderName)}</span>
                <span class="chat-text">: ${escapeHtml(m.text || '')}</span>
            </div>
        `;
        }).join('')
        : `<div class="chat-message"><span class="chat-text">No messages yet.</span></div>`;

    if (!log) return;
    const atBottom = Math.abs((log.scrollHeight - log.scrollTop) - log.clientHeight) < 5;
    log.innerHTML = html;
    
    // Attach profile click handlers to chat sender names
    log.querySelectorAll('.chat-sender.clickable-profile').forEach(el => {
        el.addEventListener('click', () => {
            const name = el.dataset.playerName;
            if (name && name !== '???') openProfileModal(name);
        });
    });
    
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
            // Deduplicate by ID to prevent double-showing sent messages
            const existingIds = new Set(chatState.messages.map(m => m.id));
            const newMsgs = msgs.filter(m => !existingIds.has(m.id));
            chatState.messages = chatState.messages.concat(newMsgs);
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
            session_token: gameState.sessionToken,
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
            sessionToken: gameState.sessionToken,  // SECURITY: Save session token
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
    // Clear turn timer
    hideTimer();
    // Clear word selection timer
    stopWordSelectionTimer();
    // Reset local race-condition flags
    gameState.hasLockedWord = false;
    gameState.hasSubmittedWordChange = false;
    gameState.isSubmittingGuess = false;
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
        sessionToken: session.sessionToken || null,  // SECURITY: Save session token
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
        const buttonText = status === 'expired' ? 'REMOVE' : (status === 'finished' ? 'REPLAY' : 'OPEN');
        return `
            <div class="lobby-item" data-code="${escapeHtml(entry.code)}">
                <div class="lobby-info-row">
                    <span class="lobby-code">${escapeHtml(entry.code)}</span>
                    <span class="lobby-players">${escapeHtml(mode)} • ${escapeHtml(label)} • ${escapeHtml(playerCount)} players</span>
                </div>
                <button class="btn btn-small btn-secondary rejoin-game-btn" data-code="${escapeHtml(entry.code)}" data-status="${escapeHtml(status)}">
                    ${buttonText}
                </button>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.rejoin-game-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const code = btn.dataset.code;
            const status = btn.dataset.status;
            if (btn.textContent.trim() === 'REMOVE') {
                const next = getRecentGames().filter(x => x.code !== code);
                localStorage.setItem('embeddle_recent_games', JSON.stringify(next));
                renderRecentGames();
                return;
            }
            if (status === 'finished') {
                // Load replay for finished games
                btn.disabled = true;
                btn.textContent = 'LOADING...';
                try {
                    const response = await fetch(`${API_BASE}/api/games/${code}/replay`);
                    if (!response.ok) {
                        throw new Error('Failed to load replay');
                    }
                    const data = await response.json();
                    const replayCode = await encodeReplayData(data);
                    history.pushState({}, '', `/replay/${replayCode}`);
                    await loadAndShowReplay(replayCode);
                } catch (e) {
                    console.error('Failed to load replay:', e);
                    showError('Failed to load replay');
                    btn.textContent = 'REPLAY';
                    btn.disabled = false;
                }
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

function getChallengeIdFromURL() {
    const match = window.location.pathname.match(/^\/challenge\/([A-Z0-9]+)$/i);
    return match ? match[1].toUpperCase() : null;
}

// Handle challenge links
async function handleChallengeURL() {
    const challengeId = getChallengeIdFromURL();
    if (!challengeId) return false;
    
    try {
        // First, get challenge details
        const response = await fetch(`${API_BASE}/api/challenge/${challengeId}`);
        if (!response.ok) {
            showError('Challenge not found or expired');
            window.history.replaceState({}, document.title, '/');
            return false;
        }
        
        const challenge = await response.json();
        
        // Show challenge acceptance modal
        showChallengeModal(challenge);
        return true;
    } catch (e) {
        console.error('Failed to load challenge:', e);
        showError('Failed to load challenge');
        window.history.replaceState({}, document.title, '/');
        return false;
    }
}

function showChallengeModal(challenge) {
    // Create modal if it doesn't exist
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
        
        document.getElementById('decline-challenge-btn').addEventListener('click', () => {
            modal.classList.remove('show');
            window.history.replaceState({}, document.title, '/');
            showScreen('home');
        });
    }
    
    // Update modal content
    modal.querySelector('.challenger-name').textContent = `${challenge.challenger_name} has challenged you!`;
    modal.querySelector('.challenge-theme').textContent = challenge.theme 
        ? `Theme: ${challenge.theme}` 
        : 'Theme: Voting enabled';
    
    // Store challenge for acceptance
    gameState.pendingChallenge = challenge;
    
    // Update accept button handler
    const acceptBtn = document.getElementById('accept-challenge-btn');
    acceptBtn.onclick = async () => {
        acceptBtn.disabled = true;
        acceptBtn.textContent = 'ACCEPTING...';
        
        try {
            const response = await fetch(`${API_BASE}/api/challenge/${challenge.id}/accept`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            
            if (!response.ok) {
                throw new Error('Failed to accept challenge');
            }
            
            const data = await response.json();
            
            // Close modal and join the game
            modal.classList.remove('show');
            window.history.replaceState({}, document.title, `/game/${data.code}`);
            
            // Store the code and join
            gameState.code = data.code;
            showScreen('lobby');
            
            // Auto-join if we have a name
            const name = gameState.user?.name || localStorage.getItem('embeddle_name');
            if (name) {
                await joinLobby(data.code, name);
            }
        } catch (e) {
            console.error('Failed to accept challenge:', e);
            showError('Failed to accept challenge');
            acceptBtn.disabled = false;
            acceptBtn.textContent = '> ACCEPT CHALLENGE';
        }
    };
    
    modal.classList.add('show');
}

// Handle browser back/forward buttons
window.addEventListener('popstate', async (event) => {
    const urlCode = getGameCodeFromURL();
    const challengeId = getChallengeIdFromURL();
    const replayCode = getReplayCodeFromURL();
    
    if (replayCode) {
        // Navigated to a replay URL
        await loadAndShowReplay(replayCode);
    } else if (challengeId) {
        // Navigated to a challenge URL
        handleChallengeURL();
    } else if (urlCode) {
        // Navigated to a game URL
        const rejoined = await attemptRejoin();
        if (!rejoined) {
            showScreen('home');
        }
    } else {
        // Navigated away from game
        stopPolling();
        stopReplayPlayback();
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
    
    // Check for profile URL parameter
    const profileParam = urlParams.get('profile');
    if (profileParam) {
        // Clean URL first, then open profile after a short delay to allow app to initialize
        window.history.replaceState({}, document.title, window.location.pathname);
        setTimeout(() => {
            openProfileModal(profileParam);
        }, 100);
    }
    
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
    
    // Check for existing auth token
    const savedToken = localStorage.getItem('embeddle_auth_token');
    if (savedToken) {
        loadAuthenticatedUser(savedToken);
        return;
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
        
        // Check if user needs to set a username
        if (user.needs_username) {
            showUsernameModal();
        }
    } catch (error) {
        console.error('Failed to load authenticated user:', error);
        localStorage.removeItem('embeddle_auth_token');
        gameState.authToken = null;
        gameState.authUser = null;
        updateRankedUi();
    }
}

function setLoggedInWithAuth(user) {
    // Use username if set, otherwise fall back to Google name
    const displayName = user.username || user.name;
    gameState.playerName = displayName;
    gameState.authUser = user;
    
    document.getElementById('login-box').classList.add('hidden');
    document.getElementById('logged-in-box').classList.remove('hidden');
    document.getElementById('logged-in-name').textContent = displayName.toUpperCase();
    
    // Update topbar toggle username for mobile collapsed state
    updateTopbarState();
    
    // Hide user avatar element (we don't use Google profile photos)
    const avatarEl = document.getElementById('user-avatar');
    if (avatarEl) {
        avatarEl.classList.add('hidden');
    }
    
    // Load user cosmetics
    if (typeof loadUserCosmetics === 'function') {
        loadUserCosmetics();
    }
    
    // Load daily quests/currency and update streak widget
    if (typeof loadDaily === 'function') {
        loadDaily().then(() => {
            updateHomeStreakWidget();
        });
    }

    updateRankedUi();
}

function updateHomeStatsBar() {
    const statsBar = document.getElementById('home-stats-bar');
    const streakEl = document.getElementById('stats-streak-count');
    const creditsEl = document.getElementById('stats-credits');
    const rankEl = document.getElementById('stats-rank');
    const yourStatsCard = document.getElementById('home-your-stats');
    
    // These elements are now hidden and only used for JS data storage
    // Keep them hidden but still update their values for potential future use
    
    // Only update values for authenticated users (not guests)
    if (!gameState.authToken) {
        return;
    }
    
    // Update streak
    const streak = dailyState?.streak;
    if (streakEl) {
        streakEl.textContent = streak?.streak_count || 0;
    }
    
    // Update credits
    const credits = dailyState?.wallet?.credits || 0;
    if (creditsEl) {
        creditsEl.textContent = credits.toLocaleString();
    }
    
    // Update rank (show placement progress or MMR)
    // Stats come from authUser (set on login)
    if (rankEl) {
        const stats = gameState.authUser?.stats;
        const mmr = stats?.mmr;
        const rankedGames = stats?.ranked_games || 0;
        
        if (rankedGames < 5) {
            // Show placement progress
            rankEl.textContent = `${rankedGames}/5`;
        } else if (mmr != null) {
            // Show MMR for ranked players
            rankEl.textContent = mmr;
        } else {
            rankEl.textContent = '—';
        }
    }
    
    // Update your stats card values (keep hidden)
    if (yourStatsCard && gameState.authUser?.stats) {
        const stats = gameState.authUser.stats;
        const gamesEl = document.getElementById('home-stat-games');
        const winsEl = document.getElementById('home-stat-wins');
        const elimsEl = document.getElementById('home-stat-elims');
        const mmrEl = document.getElementById('home-stat-mmr');
        
        if (gamesEl) gamesEl.textContent = (stats.mp_games_played || 0).toLocaleString();
        if (winsEl) winsEl.textContent = (stats.mp_wins || 0).toLocaleString();
        if (elimsEl) elimsEl.textContent = (stats.mp_eliminations || 0).toLocaleString();
        
        // Show placement progress or MMR
        if (mmrEl) {
            const rankedGames = stats.ranked_games || 0;
            if (rankedGames < 5) {
                mmrEl.textContent = `${rankedGames}/5`;
            } else {
                mmrEl.textContent = stats.mmr || '—';
            }
        }
    }
}

// Legacy function name for compatibility
function updateHomeStreakWidget() {
    updateHomeStatsBar();
}

function setLoggedIn(name) {
    // Sanitize name - remove any HTML/script tags and limit length
    const sanitizedName = name.replace(/<[^>]*>/g, '').substring(0, 20).trim();
    
    if (!sanitizedName) {
        showError('Please enter a valid callsign');
        return;
    }
    
    // Block reserved name "admin"
    if (sanitizedName.toLowerCase() === 'admin') {
        showError('This callsign is reserved. Please choose another.');
        return;
    }
    
    gameState.playerName = sanitizedName;
    localStorage.setItem('embeddle_name', sanitizedName);
    
    document.getElementById('login-box').classList.add('hidden');
    document.getElementById('logged-in-box').classList.remove('hidden');
    document.getElementById('logged-in-name').textContent = sanitizedName.toUpperCase();
    
    // Update topbar toggle username for mobile collapsed state
    updateTopbarState();
    
    updateRankedUi();
}

function logout() {
    gameState.playerName = null;
    gameState.authToken = null;
    gameState.authUser = null;
    localStorage.removeItem('embeddle_name');
    localStorage.removeItem('embeddle_auth_token');
    
    // Clear daily state to prevent stale data showing
    if (typeof dailyState !== 'undefined') {
        dailyState.quests = [];
        dailyState.weeklyQuests = [];
        dailyState.wallet = { credits: 0 };
        dailyState.streak = {
            streak_count: 0,
            streak_last_date: '',
            longest_streak: 0,
            streak_claimed_today: false,
        };
        dailyState.streakCreditsEarned = 0;
        dailyState.streakMilestoneBonus = 0;
        dailyState.streakBroken = false;
        dailyState.ownedCosmetics = {};
    }
    
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
    
    // Update UI to reflect logged-out state
    updateHomeStatsBar();
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

// ============ NAME PROMPT MODAL (LAZY NAME ENTRY) ============

let namePromptCallback = null;

function showNamePromptModal(callback) {
    const modal = document.getElementById('name-prompt-modal');
    const input = document.getElementById('name-prompt-input');
    const errorEl = document.getElementById('name-prompt-error');
    
    if (!modal || !input) return;
    
    namePromptCallback = callback;
    
    // Pre-populate with saved name if available
    const savedName = localStorage.getItem('embeddle_name') || '';
    input.value = savedName;
    
    // Clear error state
    errorEl?.classList.add('hidden');
    input.classList.remove('error');
    
    // Show modal
    modal.style.display = 'flex';
    
    // Focus input after a brief delay for animation
    setTimeout(() => {
        input.focus();
        input.select();
    }, 50);
}

function hideNamePromptModal() {
    const modal = document.getElementById('name-prompt-modal');
    if (modal) {
        modal.style.display = 'none';
    }
    namePromptCallback = null;
}

function validateAndSubmitNamePrompt() {
    const input = document.getElementById('name-prompt-input');
    const errorEl = document.getElementById('name-prompt-error');
    
    if (!input) return;
    
    const name = input.value.trim();
    
    // Sanitize name - remove any HTML/script tags and limit length
    const sanitizedName = name.replace(/<[^>]*>/g, '').substring(0, 20).trim();
    
    if (!sanitizedName) {
        input.classList.add('error');
        if (errorEl) {
            errorEl.textContent = 'Please enter a callsign';
            errorEl.classList.remove('hidden');
        }
        return;
    }
    
    // Block reserved name "admin"
    if (sanitizedName.toLowerCase() === 'admin') {
        input.classList.add('error');
        if (errorEl) {
            errorEl.textContent = 'This callsign is reserved. Please choose another.';
            errorEl.classList.remove('hidden');
        }
        return;
    }
    
    // Set the name
    setLoggedIn(sanitizedName);
    
    // Hide modal
    hideNamePromptModal();
    
    // Execute callback if provided
    if (namePromptCallback) {
        namePromptCallback();
    }
}

// Name prompt modal event listeners
document.getElementById('name-prompt-submit')?.addEventListener('click', validateAndSubmitNamePrompt);

document.getElementById('name-prompt-cancel')?.addEventListener('click', hideNamePromptModal);

document.getElementById('name-prompt-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        validateAndSubmitNamePrompt();
    } else if (e.key === 'Escape') {
        hideNamePromptModal();
    }
});

// Close modal on backdrop click
document.getElementById('name-prompt-modal')?.querySelector('.modal-backdrop')?.addEventListener('click', hideNamePromptModal);

// Clear error on input
document.getElementById('name-prompt-input')?.addEventListener('input', () => {
    const input = document.getElementById('name-prompt-input');
    const errorEl = document.getElementById('name-prompt-error');
    input?.classList.remove('error');
    errorEl?.classList.add('hidden');
});

/**
 * Ensure player has a name, prompting if needed
 * @param {Function} callback - Called after name is confirmed
 * @returns {boolean} - True if name exists, false if prompt shown
 */
function ensurePlayerName(callback) {
    if (gameState.playerName) {
        return true;
    }
    showNamePromptModal(callback);
    return false;
}

// Logout button in profile modal
document.getElementById('profile-logout-btn')?.addEventListener('click', logout);

// Cosmetics button
document.getElementById('cosmetics-btn')?.addEventListener('click', toggleCosmeticsPanel);
document.getElementById('close-cosmetics-btn')?.addEventListener('click', closeCosmeticsPanel);

// Daily Ops button
document.getElementById('daily-btn')?.addEventListener('click', window.toggleDailyPanel);
document.getElementById('close-daily-btn')?.addEventListener('click', window.closeDailyPanel);

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

// Info panel
let infoPanelOpen = false;

function toggleInfoPanel() {
    infoPanelOpen = !infoPanelOpen;
    const panel = document.getElementById('info-panel');
    if (panel) {
        panel.classList.toggle('open', infoPanelOpen);
    }
}

function closeInfoPanel() {
    infoPanelOpen = false;
    const panel = document.getElementById('info-panel');
    if (panel) panel.classList.remove('open');
}

document.getElementById('info-btn')?.addEventListener('click', toggleInfoPanel);
document.getElementById('close-info-btn')?.addEventListener('click', closeInfoPanel);

// Replay button in topbar - prompts for replay code
document.getElementById('topbar-replay-btn')?.addEventListener('click', () => {
    const code = prompt('Enter replay code:');
    if (code && code.trim()) {
        loadAndShowReplay(code.trim());
    }
});

// Topbar toggle (mobile minimizable)
let topbarCollapsed = false;

function initTopbarToggle() {
    const toggle = document.getElementById('topbar-toggle');
    const loggedInBox = document.getElementById('logged-in-box');
    
    if (!toggle || !loggedInBox) return;
    
    // Load saved state (default to collapsed on mobile)
    try {
        const saved = localStorage.getItem('embeddle_topbar_collapsed');
        topbarCollapsed = saved !== null ? JSON.parse(saved) : true;
    } catch (e) {
        topbarCollapsed = true;
    }
    
    // Apply initial state
    updateTopbarState();
    
    // Add click handler
    toggle.addEventListener('click', () => {
        topbarCollapsed = !topbarCollapsed;
        try {
            localStorage.setItem('embeddle_topbar_collapsed', JSON.stringify(topbarCollapsed));
        } catch (e) { /* ignore */ }
        updateTopbarState();
    });
}

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

// Initialize topbar toggle
initTopbarToggle();

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
document.getElementById('opt-music-volume')?.addEventListener('input', (e) => {
    const volume = parseInt(e.target.value, 10) || 0;
    optionsState.musicVolume = volume;
    const display = document.getElementById('music-volume-display');
    if (display) display.textContent = `${volume}%`;
    saveOptions();
    applyOptionsToUI();
});
document.getElementById('opt-sfx-volume')?.addEventListener('input', (e) => {
    const volume = parseInt(e.target.value, 10) || 0;
    optionsState.sfxVolume = volume;
    const display = document.getElementById('sfx-volume-display');
    if (display) display.textContent = `${volume}%`;
    saveOptions();
});
document.getElementById('opt-turn-notifications')?.addEventListener('change', (e) => {
    optionsState.turnNotificationsEnabled = Boolean(e.target.checked);
    saveOptions();
    applyOptionsToUI();
});
document.getElementById('opt-nerd-mode')?.addEventListener('change', (e) => {
    optionsState.nerdMode = Boolean(e.target.checked);
    saveOptions();
    applyOptionsToUI();
});

// ML Info Modal
document.getElementById('ml-info-btn')?.addEventListener('click', () => {
    const modal = document.getElementById('ml-info-modal');
    if (modal) modal.classList.add('show');
});

document.getElementById('close-ml-info-btn')?.addEventListener('click', () => {
    const modal = document.getElementById('ml-info-modal');
    if (modal) modal.classList.remove('show');
});

// Generic closable modal handlers (for modals with .closable-modal class)
document.addEventListener('click', (e) => {
    // Close modal when clicking on backdrop with data-close attribute
    if (e.target?.dataset?.close) {
        const modal = e.target.closest('.closable-modal');
        if (modal) modal.classList.remove('show');
    }
});

// Escape key closes any open closable modal
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const openModals = document.querySelectorAll('.closable-modal.show');
        openModals.forEach(modal => modal.classList.remove('show'));
    }
});

// ============ PLAYER PROFILE MODAL ============

let profileModalInFlight = false;
let currentProfileName = null;

// Badge emoji mapping
const BADGE_EMOJIS = {
    coffee: '☕', diamond: '💎', star: '⭐', rookie: '🔰',
    hunter: '⚔️', assassin: '🗡️', executioner: '☠️', victor: '🎖️',
    champion: '🏆', legend: '👑', veteran: '🎗️', rank_bronze: '🥉',
    rank_silver: '🥈', rank_gold: '🥇', rank_platinum: '💠',
        rank_diamond: '🔷', rank_master: '⚜️', skull: '💀', ghost: '👻', rocket: '🚀',
    hacker: '💻', ghost_protocol: '🕵️', overlord: '🦅', dragon: '🐉',
    alien: '👽', wizard: '🧙', robot: '🤖', unicorn: '🦄',
    crystal_ball: '🔮', joystick: '🕹️', meteor: '☄️', phoenix: '🔥',
    wolf: '🐺', octopus: '🐙', ninja: '🥷', fairy: '🧚',
    cat: '🐈‍⬛', dice: '🎲', eye: '👁️',
    ancient_one: '🦑', cosmic_entity: '🌌', infinity: '♾️',
    heart: '❤️', crown: '👑', lightning: '⚡', flame: '🔥'
};

// Get rank tier from MMR
function getProfileRankTier(mmr) {
    const v = Number(mmr || 0);
    if (v >= 2000) return { key: 'master', name: 'MASTER' };
    if (v >= 1800) return { key: 'diamond', name: 'DIAMOND' };
    if (v >= 1600) return { key: 'platinum', name: 'PLATINUM' };
    if (v >= 1400) return { key: 'gold', name: 'GOLD' };
    if (v >= 1200) return { key: 'silver', name: 'SILVER' };
    if (v >= 1000) return { key: 'bronze', name: 'BRONZE' };
    return { key: 'unranked', name: 'UNRANKED' };
}

async function openProfileModal(playerName) {
    if (!playerName || profileModalInFlight) return;
    
    const modal = document.getElementById('profile-modal');
    if (!modal) return;
    
    currentProfileName = playerName;
    
    // Show modal immediately with loading state
    const loadingEl = document.getElementById('profile-loading');
    const rankedSection = document.getElementById('profile-ranked-section');
    
    // Reset to loading state
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (rankedSection) rankedSection.classList.add('hidden');
    
    // Set placeholder values
    document.getElementById('profile-name').textContent = playerName;
    document.getElementById('profile-joined').textContent = '';
    document.getElementById('profile-avatar').classList.add('hidden');
    document.getElementById('profile-avatar-placeholder').classList.remove('hidden');
    document.getElementById('profile-avatar-emoji')?.classList.add('hidden');
    document.getElementById('profile-badge').textContent = '';
    
    modal.classList.add('show');
    
    // Show logout button and edit avatar button only when viewing own profile
    const logoutBtn = document.getElementById('profile-logout-btn');
    const editAvatarBtn = document.getElementById('edit-avatar-btn');
    const isOwnProfile = gameState.playerName && 
        gameState.playerName.toLowerCase() === playerName.toLowerCase();
    if (logoutBtn) {
        logoutBtn.classList.toggle('hidden', !isOwnProfile);
    }
    if (editAvatarBtn) {
        // Only show edit button if user is authenticated
        editAvatarBtn.classList.toggle('hidden', !isOwnProfile || !gameState.authToken);
    }
    
    profileModalInFlight = true;
    try {
        const data = await apiCall(`/api/profile/${encodeURIComponent(playerName)}`);
        
        currentProfileName = data.name || playerName;
        
        // Update name (might be different case)
        document.getElementById('profile-name').textContent = data.name || playerName;
        
        // Update badge if available
        const badgeEl = document.getElementById('profile-badge');
        if (badgeEl && data.badge && BADGE_EMOJIS[data.badge]) {
            badgeEl.textContent = BADGE_EMOJIS[data.badge];
        } else if (badgeEl) {
            badgeEl.textContent = '';
        }
        
        // Apply cosmetics (banner, accent, title)
        const profileModal = modal.querySelector('.profile-modal');
        const bannerEl = modal.querySelector('.profile-banner');
        const joinedEl = document.getElementById('profile-joined');
        
        // Reset previous cosmetics
        if (profileModal) {
            profileModal.style.removeProperty('--profile-accent');
            profileModal.removeAttribute('data-banner');
        }
        if (bannerEl) {
            bannerEl.removeAttribute('data-banner');
        }
        
        if (data.cosmetics) {
            // Apply profile accent color
            if (data.cosmetics.profile_accent && data.cosmetics.profile_accent !== 'default') {
                const accentColor = typeof getProfileAccentColor === 'function' ? getProfileAccentColor(data.cosmetics) : null;
                if (accentColor && profileModal) {
                    profileModal.style.setProperty('--profile-accent', accentColor);
                }
            }
            
            // Apply banner
            if (data.cosmetics.profile_banner && data.cosmetics.profile_banner !== 'none') {
                if (bannerEl) {
                    bannerEl.setAttribute('data-banner', data.cosmetics.profile_banner);
                }
            }
            
            // Apply title (display under name)
            if (data.cosmetics.profile_title && data.cosmetics.profile_title !== 'none') {
                const titleHtml = typeof getTitleHtml === 'function' ? getTitleHtml(data.cosmetics) : '';
                if (titleHtml && joinedEl) {
                    // Insert title before joined date
                    const existingTitle = modal.querySelector('.profile-player-title');
                    if (existingTitle) existingTitle.remove();
                    const titleEl = document.createElement('span');
                    titleEl.className = 'profile-player-title player-title';
                    titleEl.innerHTML = titleHtml.replace(/<\/?span[^>]*>/g, ''); // Extract just the text
                    joinedEl.parentNode.insertBefore(titleEl, joinedEl);
                }
            } else {
                // Remove existing title if no title cosmetic
                const existingTitle = modal.querySelector('.profile-player-title');
                if (existingTitle) existingTitle.remove();
            }
        } else {
            // No cosmetics - remove any existing title
            const existingTitle = modal.querySelector('.profile-player-title');
            if (existingTitle) existingTitle.remove();
        }
        
        // Update avatar
        const avatarEl = document.getElementById('profile-avatar');
        const placeholderEl = document.getElementById('profile-avatar-placeholder');
        const emojiAvatarEl = document.getElementById('profile-avatar-emoji');
        
        // For own profile, prefer local cosmeticsState (more up-to-date after equipping)
        let avatarToShow = data.custom_avatar;
        if (isOwnProfile && cosmeticsState?.userCosmetics?.profile_avatar && cosmeticsState.userCosmetics.profile_avatar !== 'default') {
            // Get the icon from the catalog
            const avatarId = cosmeticsState.userCosmetics.profile_avatar;
            const catalog = cosmeticsState?.catalog?.profile_avatars || avatarPickerCatalog || {};
            avatarToShow = catalog[avatarId]?.icon || data.custom_avatar;
        }
        
        if (avatarToShow) {
            // Show emoji avatar
            if (emojiAvatarEl) {
                emojiAvatarEl.textContent = avatarToShow;
                emojiAvatarEl.classList.remove('hidden');
            }
            avatarEl.classList.add('hidden');
            placeholderEl.classList.add('hidden');
        } else {
            // No custom avatar - show placeholder (no Google avatar)
            avatarEl.classList.add('hidden');
            placeholderEl.classList.remove('hidden');
            if (emojiAvatarEl) emojiAvatarEl.classList.add('hidden');
        }
        
        // Update joined date
        if (data.created_at) {
            const joinDate = new Date(data.created_at * 1000);
            const now = new Date();
            const diffDays = Math.floor((now - joinDate) / (1000 * 60 * 60 * 24));
            
            let timeAgo;
            if (diffDays === 0) {
                timeAgo = 'today';
            } else if (diffDays === 1) {
                timeAgo = 'yesterday';
            } else if (diffDays < 30) {
                timeAgo = `${diffDays} days ago`;
            } else if (diffDays < 365) {
                const months = Math.floor(diffDays / 30);
                timeAgo = months === 1 ? '1 month ago' : `${months} months ago`;
            } else {
                const years = Math.floor(diffDays / 365);
                timeAgo = years === 1 ? '1 year ago' : `${years} years ago`;
            }
            joinedEl.textContent = `Playing since ${joinDate.toLocaleDateString()} (${timeAgo})`;
        } else {
            // No created_at - either guest or legacy user without timestamp
            joinedEl.textContent = '';
        }
        
        // Update stats
        document.getElementById('profile-wins').textContent = data.wins || 0;
        document.getElementById('profile-games').textContent = data.games_played || 0;
        document.getElementById('profile-winrate').textContent = `${data.win_rate || 0}%`;
        document.getElementById('profile-elims').textContent = data.eliminations || 0;
        document.getElementById('profile-times-eliminated').textContent = data.times_eliminated || 0;
        document.getElementById('profile-streak').textContent = data.best_streak || 0;
        
        // Update ranked section
        if (data.ranked) {
            const mmr = data.ranked.mmr || 1000;
            document.getElementById('profile-mmr').textContent = mmr;
            document.getElementById('profile-peak-mmr').textContent = data.ranked.peak_mmr || 1000;
            document.getElementById('profile-ranked-record').textContent = 
                `${data.ranked.ranked_wins || 0}-${data.ranked.ranked_losses || 0}`;
            
            // Update rank tier badge
            const rankTierEl = document.getElementById('profile-rank-tier');
            if (rankTierEl) {
                const tier = getProfileRankTier(mmr);
                rankTierEl.innerHTML = `<span class="rank-badge rank-${escapeHtml(tier.key)}">${escapeHtml(tier.name)}</span>`;
            }
            
            rankedSection.classList.remove('hidden');
        } else {
            rankedSection.classList.add('hidden');
        }
        
        // Hide loading
        if (loadingEl) loadingEl.classList.add('hidden');
        
    } catch (e) {
        console.error('Failed to load profile:', e);
        // Show error state but keep modal open
        if (loadingEl) loadingEl.textContent = 'Failed to load profile';
    } finally {
        profileModalInFlight = false;
    }
}

function closeProfileModal() {
    const modal = document.getElementById('profile-modal');
    if (modal) modal.classList.remove('show');
}

// ============ USERNAME MODAL ============

function showUsernameModal() {
    const modal = document.getElementById('username-modal');
    if (!modal) return;
    
    // Reset state
    const input = document.getElementById('username-input');
    const error = document.getElementById('username-error');
    const charCount = document.getElementById('username-char-count');
    const submitBtn = document.getElementById('username-submit-btn');
    
    if (input) {
        input.value = '';
        input.classList.remove('error');
    }
    if (error) {
        error.textContent = '';
        error.classList.add('hidden');
    }
    if (charCount) charCount.textContent = '0/20';
    if (submitBtn) submitBtn.disabled = true;
    
    modal.style.display = 'flex';
}

function hideUsernameModal() {
    const modal = document.getElementById('username-modal');
    if (modal) modal.style.display = 'none';
}

function validateUsernameInput(username) {
    if (!username || username.length < 3) {
        return { valid: false, error: 'Username must be at least 3 characters' };
    }
    if (username.length > 20) {
        return { valid: false, error: 'Username must be at most 20 characters' };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
        return { valid: false, error: 'Only letters, numbers, underscores, and hyphens allowed' };
    }
    return { valid: true, error: '' };
}

async function submitUsername(username) {
    const submitBtn = document.getElementById('username-submit-btn');
    const error = document.getElementById('username-error');
    
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'SAVING...';
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/user/username`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${gameState.authToken}`,
            },
            body: JSON.stringify({ username }),
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            if (error) {
                error.textContent = data.detail || data.error || 'Failed to set username';
                error.classList.remove('hidden');
            }
            const input = document.getElementById('username-input');
            if (input) input.classList.add('error');
            return false;
        }
        
        // Success - update local state
        if (gameState.authUser) {
            gameState.authUser.username = data.username;
            gameState.authUser.needs_username = false;
        }
        gameState.playerName = data.username;
        
        // Update UI
        const nameEl = document.getElementById('logged-in-name');
        if (nameEl) nameEl.textContent = data.username.toUpperCase();
        updateTopbarState();
        
        hideUsernameModal();
        showToast('Callsign set successfully!', 'success');
        return true;
    } catch (err) {
        console.error('Failed to set username:', err);
        if (error) {
            error.textContent = 'Network error. Please try again.';
            error.classList.remove('hidden');
        }
        return false;
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '> CONFIRM CALLSIGN';
        }
    }
}

// Username modal input handler
document.getElementById('username-input')?.addEventListener('input', (e) => {
    const value = e.target.value;
    const charCount = document.getElementById('username-char-count');
    const submitBtn = document.getElementById('username-submit-btn');
    const error = document.getElementById('username-error');
    
    if (charCount) charCount.textContent = `${value.length}/20`;
    
    const validation = validateUsernameInput(value);
    
    if (error) {
        if (!validation.valid && value.length > 0) {
            error.textContent = validation.error;
            error.classList.remove('hidden');
            e.target.classList.add('error');
        } else {
            error.classList.add('hidden');
            e.target.classList.remove('error');
        }
    }
    
    if (submitBtn) {
        submitBtn.disabled = !validation.valid;
    }
});

// Username modal submit button
document.getElementById('username-submit-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('username-input');
    if (!input) return;
    
    const username = input.value.trim();
    const validation = validateUsernameInput(username);
    
    if (!validation.valid) return;
    
    await submitUsername(username);
});

// Username modal skip button
document.getElementById('username-skip-btn')?.addEventListener('click', () => {
    hideUsernameModal();
});

// Allow Enter key to submit username
document.getElementById('username-input')?.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        const input = e.target;
        const username = input.value.trim();
        const validation = validateUsernameInput(username);
        
        if (validation.valid) {
            await submitUsername(username);
        }
    }
});

// Profile modal close button
document.getElementById('close-profile-btn')?.addEventListener('click', closeProfileModal);

// Click on logged-in username to open own profile
document.getElementById('logged-in-name')?.addEventListener('click', () => {
    if (gameState.playerName) {
        openProfileModal(gameState.playerName);
    }
});

// Share profile button
document.getElementById('share-profile-btn')?.addEventListener('click', async () => {
    if (!currentProfileName) return;
    
    const shareUrl = `${window.location.origin}/?profile=${encodeURIComponent(currentProfileName)}`;
    const shareText = `Check out ${currentProfileName}'s profile on Embeddle!`;
    const btn = document.getElementById('share-profile-btn');
    
    // Try Web Share API first (mobile)
    if (navigator.share) {
        try {
            await navigator.share({
                title: `${currentProfileName} - Embeddle Profile`,
                text: shareText,
                url: shareUrl
            });
            return;
        } catch (e) {
            // User cancelled or share failed, fall through to clipboard
            if (e.name === 'AbortError') return;
        }
    }
    
    // Fall back to clipboard
    try {
        await navigator.clipboard.writeText(shareUrl);
        if (btn) {
            const originalHtml = btn.innerHTML;
            btn.innerHTML = '<span class="share-icon">✓</span> COPIED!';
            btn.classList.add('copied');
            setTimeout(() => {
                btn.innerHTML = originalHtml;
                btn.classList.remove('copied');
            }, 2000);
        }
    } catch (e) {
        console.error('Failed to copy profile URL:', e);
        showError('Failed to copy link');
    }
});

// ============ AVATAR PICKER ============

let avatarPickerCatalog = null;

async function openAvatarPicker() {
    const modal = document.getElementById('avatar-picker-modal');
    if (!modal) return;
    
    // Load avatar catalog if not loaded
    if (!avatarPickerCatalog && cosmeticsState?.catalog?.profile_avatars) {
        avatarPickerCatalog = cosmeticsState.catalog.profile_avatars;
    }
    
    if (!avatarPickerCatalog) {
        // Try to fetch from API
        try {
            const response = await fetch(`${API_BASE}/api/cosmetics`);
            if (response.ok) {
                const data = await response.json();
                avatarPickerCatalog = data.catalog?.profile_avatars || {};
            }
        } catch (e) {
            console.error('Failed to load avatar catalog:', e);
        }
    }
    
    if (!avatarPickerCatalog || Object.keys(avatarPickerCatalog).length === 0) {
        showError('Failed to load avatars');
        return;
    }
    
    const grid = document.getElementById('avatar-picker-grid');
    if (!grid) return;
    
    const currentAvatar = cosmeticsState?.userCosmetics?.profile_avatar || 'default';
    const userStats = gameState?.authUser?.stats || {};
    const hasFullAccess = cosmeticsState?.unlockAll || !cosmeticsState?.paywallEnabled || cosmeticsState?.isDonor || cosmeticsState?.isAdmin;
    const ownedList = (cosmeticsState?.ownedCosmetics || {})['profile_avatar'] || [];
    
    let html = '';
    
    Object.entries(avatarPickerCatalog).forEach(([id, avatar]) => {
        const isSelected = id === currentAvatar;
        const isPremiumLocked = cosmeticsState?.paywallEnabled && avatar.premium && !hasFullAccess;
        const isAdminOnly = avatar.admin_only && !cosmeticsState?.isAdmin;
        
        // Check requirements
        let isReqLocked = false;
        let reqText = '';
        if (avatar.requirements && !cosmeticsState?.isAdmin && !cosmeticsState?.unlockAll) {
            for (const req of avatar.requirements) {
                const have = userStats[req.metric] || 0;
                if (have < req.min) {
                    isReqLocked = true;
                    const labels = {
                        mp_games_played: 'games',
                        mp_wins: 'wins',
                        mp_eliminations: 'eliminations',
                        peak_mmr: 'MMR',
                    };
                    reqText = `${have}/${req.min} ${labels[req.metric] || req.metric}`;
                    break;
                }
            }
        }
        
        // Check shop purchase
        const price = parseInt(avatar.price || 0, 10);
        const isShopItem = price > 0 && !avatar.premium;
        const isOwned = Array.isArray(ownedList) && ownedList.includes(id);
        const isShopLocked = isShopItem && !isOwned && !(cosmeticsState?.isAdmin || cosmeticsState?.unlockAll);
        
        const isLocked = isPremiumLocked || isReqLocked || isShopLocked || isAdminOnly;
        
        let lockInfo = '';
        if (isAdminOnly) lockInfo = 'Admin only';
        else if (isPremiumLocked) lockInfo = 'Supporter only';
        else if (isShopLocked) lockInfo = `${price}¢`;
        else if (isReqLocked) lockInfo = reqText;
        
        html += `
            <div class="avatar-option ${isSelected ? 'selected' : ''} ${isLocked ? 'locked' : ''}" 
                 data-id="${id}" 
                 data-locked="${isLocked}"
                 title="${avatar.name}: ${avatar.description}${lockInfo ? ' (🔒 ' + lockInfo + ')' : ''}">
                <span class="avatar-icon">${avatar.icon}</span>
                <span class="avatar-name">${avatar.name}</span>
                ${isLocked ? '<span class="avatar-lock">🔒</span>' : ''}
            </div>
        `;
    });
    
    grid.innerHTML = html;
    
    // Add click handlers
    grid.querySelectorAll('.avatar-option').forEach(el => {
        el.addEventListener('click', async () => {
            if (el.dataset.locked === 'true') {
                showError('This avatar is locked');
                return;
            }
            await selectAvatar(el.dataset.id);
        });
    });
    
    modal.classList.add('show');
}

function closeAvatarPicker() {
    const modal = document.getElementById('avatar-picker-modal');
    if (modal) modal.classList.remove('show');
}

async function selectAvatar(avatarId) {
    if (!gameState.authToken) {
        showError('Please sign in to change your avatar');
        return;
    }
    
    try {
        // Use the existing cosmetics equip endpoint
        const response = await fetch(`${API_BASE}/api/cosmetics/equip`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${gameState.authToken}`
            },
            body: JSON.stringify({ 
                category: 'profile_avatar', 
                cosmetic_id: avatarId 
            })
        });
        
        if (response.ok) {
            const data = await response.json();
            cosmeticsState.userCosmetics = data.cosmetics;
            
            // Update the profile modal avatar immediately
            const emojiAvatarEl = document.getElementById('profile-avatar-emoji');
            const avatarEl = document.getElementById('profile-avatar');
            const placeholderEl = document.getElementById('profile-avatar-placeholder');
            
            if (avatarId === 'default') {
                // Show placeholder (no Google avatar)
                if (emojiAvatarEl) emojiAvatarEl.classList.add('hidden');
                avatarEl.classList.add('hidden');
                placeholderEl.classList.remove('hidden');
            } else {
                // Show emoji avatar
                const icon = avatarPickerCatalog?.[avatarId]?.icon || '👤';
                if (emojiAvatarEl) {
                    emojiAvatarEl.textContent = icon;
                    emojiAvatarEl.classList.remove('hidden');
                }
                avatarEl.classList.add('hidden');
                placeholderEl.classList.add('hidden');
            }
            
            closeAvatarPicker();
            showToast('Avatar updated!');
        } else {
            const err = await response.json();
            showError(err.detail || 'Failed to update avatar');
        }
    } catch (e) {
        console.error('Failed to update avatar:', e);
        showError('Failed to update avatar');
    }
}

// Edit avatar button
document.getElementById('edit-avatar-btn')?.addEventListener('click', openAvatarPicker);

// Close avatar picker
document.getElementById('close-avatar-picker-btn')?.addEventListener('click', closeAvatarPicker);

// Global button click handler (no sound)
document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button.btn');
    if (!btn) return;
    if (btn.disabled) return;
    // Click sound removed
}, { capture: true });

// DOM Elements
const screens = {
    home: document.getElementById('home-screen'),
    queue: document.getElementById('queue-screen'),
    leaderboard: document.getElementById('leaderboard-screen'),
    join: document.getElementById('join-screen'),
    lobby: document.getElementById('lobby-screen'),
    singleplayerLobby: document.getElementById('singleplayer-lobby-screen'),
    wordselect: document.getElementById('wordselect-screen'),
    game: document.getElementById('game-screen'),
    gameover: document.getElementById('gameover-screen'),
    replay: document.getElementById('replay-screen'),
};

// Utility functions
// ============ RESPONSIVE IN-GAME PANELS (MOBILE GUESS/LOG DOCK) ============

const GAME_MOBILE_BREAKPOINT_PX = 768;
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
    const guessSection = document.getElementById('guess-section');
    const historySection = document.getElementById('history-section');

    const gameCenter = document.querySelector('#game-screen .game-center');
    const logHost = document.getElementById('game-log-host');

    const mobileWordsPanel = document.getElementById('mobile-words-panel');
    const mobileLogPanel = document.getElementById('mobile-log-panel');

    const mobile = isGameMobileLayout();

    if (mobile) {
        // Default to GUESS tab when entering mobile layout
        const wordsTabSelected = document.getElementById('game-mobile-tab-words')?.getAttribute('aria-selected') === 'true';
        const logTabSelected = document.getElementById('game-mobile-tab-log')?.getAttribute('aria-selected') === 'true';
        if (!wordsTabSelected && !logTabSelected) {
            setGameMobileActiveTab('words');
        }

        moveElementTo(guessSection, mobileWordsPanel);
        moveElementTo(historySection, mobileLogPanel);
        return;
    }

    // Desktop/tablet: move panels back to their primary homes
    if (guessSection && gameCenter) {
        gameCenter.appendChild(guessSection);
    }
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
    
    // Toggle home screen class for hiding site footer
    document.body.classList.toggle('on-home-screen', screenName === 'home');

    // Ensure the in-game word list / log live in the correct containers for this viewport
    applyResponsiveGamePanelsLayout();
    
    // Reset singleplayer start button state when returning to lobby
    if (screenName === 'singleplayerLobby') {
        spStartInProgress = false;
        const startBtn = document.getElementById('sp-start-game-btn');
        if (startBtn) {
            startBtn.textContent = '> START_MISSION';
        }
    }
    
    // Clean up queue state when leaving queue screen
    if (screenName !== 'queue' && gameState.queuePollingInterval) {
        stopQueuePolling();
    }
    
    // Start/stop lobby refresh based on screen
    if (screenName === 'home') {
        startLobbyRefresh();
        startSpectateRefresh();
        renderRecentGames();
        // Refresh stats bar (ranked counter, credits, streak) when returning home
        updateHomeStatsBar();
        // Start queue count polling
        startQueueCountPolling();
    } else {
        stopLobbyRefresh();
        stopSpectateRefresh();
        stopQueueCountPolling();
    }
}

setupResponsiveGamePanels();

// ============ TOAST NOTIFICATION SYSTEM ============

let toastQueue = [];
let toastActive = false;

function showToast(message, type = 'info', duration = 3000) {
    toastQueue.push({ message, type, duration });
    processToastQueue();
}

function processToastQueue() {
    if (toastActive || toastQueue.length === 0) return;
    
    const { message, type, duration } = toastQueue.shift();
    toastActive = true;
    
    // Create toast element if it doesn't exist
    let toast = document.getElementById('toast-notification');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast-notification';
        toast.className = 'toast-notification';
        document.body.appendChild(toast);
    }
    
    toast.textContent = message;
    toast.className = `toast-notification toast-${type}`;
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            toastActive = false;
            processToastQueue();
        }, 150); // Reduced from 300ms
    }, duration);
}

function showError(message) {
    showToast(message, 'error', 3000);
}

function showSuccess(message) {
    showToast(message, 'success', 2000);
}

function showInfo(message) {
    showToast(message, 'info', 2000);
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
    loadMiniLeaderboard(); // Load mini-leaderboard on home screen
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
    // Lazy name prompt - show modal if no name
    if (!gameState.playerName) {
        showNamePromptModal(() => joinLobbyPrompt(code));
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

async function createLobby({ visibility = 'private', isRanked = false, timeControl = 'rapid' } = {}) {
    // Lazy name prompt - show modal if no name
    if (!gameState.playerName) {
        showNamePromptModal(() => createLobby({ visibility, isRanked, timeControl }));
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
            time_control: timeControl,
        });
        gameState.code = data.code;
        await joinLobby(data.code, gameState.playerName);
    } catch (error) {
        showError(error.message);
    }
}

async function quickPlay({ ranked = false } = {}) {
    // Lazy name prompt - show modal if no name
    if (!gameState.playerName) {
        showNamePromptModal(() => quickPlay({ ranked }));
        return;
    }
    if (ranked && !gameState.authToken) {
        showError('Ranked requires Google sign-in');
        return;
    }

    // Join the matchmaking queue
    await joinMatchmakingQueue(ranked ? 'ranked' : 'quick_play');
}

// ============ MATCHMAKING QUEUE ============

async function joinMatchmakingQueue(mode) {
    // Lazy name prompt - show modal if no name
    if (!gameState.playerName) {
        showNamePromptModal(() => joinMatchmakingQueue(mode));
        return;
    }

    try {
        const response = await apiCall('/api/queue/join', 'POST', {
            mode: mode,
            player_name: gameState.playerName,
        });

        if (response.status === 'ineligible') {
            // Not eligible for ranked
            const gamesNeeded = response.games_required - response.games_played;
            showError(`Play ${gamesNeeded} more casual game${gamesNeeded !== 1 ? 's' : ''} to unlock ranked`);
            return;
        }

        if (response.status === 'error') {
            showError(response.message || 'Failed to join queue');
            return;
        }

        // Store queue state
        gameState.queueMode = mode;
        gameState.queuePlayerId = response.player_id;
        gameState.queueStartTime = Date.now();

        // Show queue screen
        showQueueScreen(mode);

        // Start polling for match
        startQueuePolling();

    } catch (error) {
        showError(error.message || 'Failed to join queue');
    }
}

function showQueueScreen(mode) {
    showScreen('queue');

    // Update mode display
    const modeDisplay = document.getElementById('queue-mode');
    if (modeDisplay) {
        modeDisplay.textContent = mode === 'ranked' ? 'RANKED' : 'QUICK PLAY';
        modeDisplay.className = `queue-value ${mode === 'ranked' ? 'queue-ranked' : 'queue-casual'}`;
    }

    // Show/hide MMR display for ranked only
    const mmrDisplay = document.getElementById('queue-mmr-display');
    if (mmrDisplay) {
        mmrDisplay.classList.toggle('hidden', mode !== 'ranked');
    }

    // Show/hide min size display for quick play only
    const minSizeDisplay = document.getElementById('queue-min-size-display');
    if (minSizeDisplay) {
        minSizeDisplay.classList.toggle('hidden', mode !== 'quick_play');
    }

    // Reset displays
    const playersDisplay = document.getElementById('queue-players');
    if (playersDisplay) playersDisplay.textContent = '0';

    const targetSizeDisplay = document.getElementById('queue-target-size');
    if (targetSizeDisplay) targetSizeDisplay.textContent = '4';

    const minSizeValue = document.getElementById('queue-min-size');
    if (minSizeValue) minSizeValue.textContent = '4';

    const timerDisplay = document.getElementById('queue-timer');
    if (timerDisplay) timerDisplay.textContent = '0:00';

    const statusMessage = document.getElementById('queue-status-message');
    if (statusMessage) {
        statusMessage.textContent = 'Scanning for available operatives...';
    }
}

function startQueuePolling() {
    // Clear any existing polling
    stopQueuePolling();

    // Update timer immediately and start interval
    updateQueueTimer();

    // Poll for status every 2 seconds
    gameState.queuePollingInterval = setInterval(async () => {
        await pollQueueStatus();
        updateQueueTimer();
    }, 2000);
}

function stopQueuePolling() {
    if (gameState.queuePollingInterval) {
        clearInterval(gameState.queuePollingInterval);
        gameState.queuePollingInterval = null;
    }
}

function updateQueueTimer() {
    if (!gameState.queueStartTime) return;

    const elapsed = Math.floor((Date.now() - gameState.queueStartTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;

    const timerDisplay = document.getElementById('queue-timer');
    if (timerDisplay) {
        timerDisplay.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    // Update status message based on wait time
    const statusMessage = document.getElementById('queue-status-message');
    if (statusMessage) {
        if (gameState.queueMode === 'quick_play') {
            // Quick play - show flexible match size status
            if (elapsed >= 60) {
                statusMessage.textContent = 'Will start with 2+ players...';
            } else if (elapsed >= 30) {
                statusMessage.textContent = 'Will start with 3+ players...';
            } else if (elapsed >= 15) {
                statusMessage.textContent = 'Expanding search parameters...';
            } else {
                statusMessage.textContent = 'Scanning for available operatives...';
            }
        } else {
            // Ranked - always 4 players, show MMR expansion
            if (elapsed >= 90) {
                statusMessage.textContent = 'Searching across all skill levels...';
            } else if (elapsed >= 60) {
                statusMessage.textContent = 'Widening MMR search range...';
            } else if (elapsed >= 30) {
                statusMessage.textContent = 'Expanding search parameters...';
            } else if (elapsed >= 15) {
                statusMessage.textContent = 'Broadening skill range...';
            } else {
                statusMessage.textContent = 'Searching for operatives at your skill level...';
            }
        }
    }
}

async function pollQueueStatus() {
    if (!gameState.queueMode || !gameState.queuePlayerId) return;

    try {
        const response = await apiCall(
            `/api/queue/status?mode=${gameState.queueMode}&player_id=${gameState.queuePlayerId}`
        );

        if (response.status === 'matched') {
            // Match found!
            stopQueuePolling();
            await onMatchFound(response);
            return;
        }

        if (response.status === 'not_in_queue') {
            // Somehow removed from queue
            stopQueuePolling();
            showScreen('home');
            showError('Removed from queue');
            return;
        }

        // Update queue info
        const playersDisplay = document.getElementById('queue-players');
        if (playersDisplay && response.queue_size !== undefined) {
            // Show queue size as indicator of activity
            playersDisplay.textContent = Math.min(response.queue_size, 4).toString();
        }

        // Update MMR range for ranked
        if (response.mmr_range !== undefined) {
            const mmrRangeDisplay = document.getElementById('queue-mmr-range');
            if (mmrRangeDisplay) {
                mmrRangeDisplay.textContent = `+/- ${response.mmr_range} MMR`;
            }
        }

        // Update min match size for quick play
        if (response.min_match_size !== undefined) {
            const minSizeDisplay = document.getElementById('queue-min-size');
            if (minSizeDisplay) {
                minSizeDisplay.textContent = response.min_match_size.toString();
            }
            // Update the target size display to show the range
            const targetSizeDisplay = document.getElementById('queue-target-size');
            if (targetSizeDisplay) {
                // Show "2-4" format when min is less than max
                if (response.min_match_size < (response.max_match_size || 4)) {
                    targetSizeDisplay.textContent = `${response.min_match_size}-${response.max_match_size || 4}`;
                } else {
                    targetSizeDisplay.textContent = (response.max_match_size || 4).toString();
                }
            }
        }

    } catch (error) {
        console.error('Queue poll error:', error);
        // Don't stop polling on transient errors
    }
}

async function onMatchFound(matchData) {
    const gameCode = matchData.game_code;
    const playerId = matchData.player_id;
    const sessionToken = matchData.session_token;
    
    if (!gameCode) {
        showError('Match found but no game code received');
        showScreen('home');
        return;
    }

    // Clear queue state
    gameState.queueMode = null;
    gameState.queuePlayerId = null;
    gameState.queueStartTime = null;

    // If we have session info from the match, use it directly
    if (playerId && sessionToken) {
        gameState.code = gameCode;
        gameState.playerId = playerId;
        gameState.sessionToken = sessionToken;
        
        // Save session for persistence
        saveGameSession();
        
        // Show success message
        showSuccess('Match found! Joining game...');
        
        // Go directly to lobby
        document.getElementById('lobby-code').textContent = gameCode;
        showScreen('lobby');
        startLobbyPolling();
    } else {
        // Fallback: join via API (shouldn't normally happen)
        showSuccess('Match found! Joining game...');
        try {
            await joinLobby(gameCode, gameState.playerName);
        } catch (error) {
            showError('Failed to join match: ' + (error.message || 'Unknown error'));
            showScreen('home');
        }
    }
}

async function leaveQueue() {
    if (!gameState.queueMode || !gameState.queuePlayerId) {
        showScreen('home');
        return;
    }

    try {
        await apiCall('/api/queue/leave', 'POST', {
            mode: gameState.queueMode,
            player_id: gameState.queuePlayerId,
        });
    } catch (error) {
        console.error('Error leaving queue:', error);
    }

    // Clear state regardless of API result
    stopQueuePolling();
    gameState.queueMode = null;
    gameState.queuePlayerId = null;
    gameState.queueStartTime = null;

    showScreen('home');
}

// Cancel queue button
document.getElementById('cancel-queue-btn')?.addEventListener('click', leaveQueue);

document.getElementById('quickplay-btn')?.addEventListener('click', async () => {
    await quickPlay({ ranked: false });
});

document.getElementById('create-lobby-btn')?.addEventListener('click', () => {
    showCustomLobbyModal();
});

document.getElementById('ranked-btn')?.addEventListener('click', async () => {
    await quickPlay({ ranked: true });
});

// Custom Lobby Modal
let customLobbyVisibility = 'public';

function showCustomLobbyModal() {
    // Lazy name prompt - show modal if no name
    if (!gameState.playerName) {
        showNamePromptModal(showCustomLobbyModal);
        return;
    }
    const modal = document.getElementById('custom-lobby-modal');
    if (modal) modal.classList.add('show');
    
    // Reset to public by default
    customLobbyVisibility = 'public';
    updateVisibilityToggle();
}

function hideCustomLobbyModal() {
    const modal = document.getElementById('custom-lobby-modal');
    if (modal) modal.classList.remove('show');
}

function updateVisibilityToggle() {
    const publicBtn = document.getElementById('visibility-public');
    const privateBtn = document.getElementById('visibility-private');
    const hint = document.getElementById('visibility-hint');
    
    if (publicBtn && privateBtn) {
        publicBtn.classList.toggle('active', customLobbyVisibility === 'public');
        privateBtn.classList.toggle('active', customLobbyVisibility === 'private');
    }
    
    if (hint) {
        hint.textContent = customLobbyVisibility === 'public' 
            ? 'Anyone can join from Active Servers' 
            : 'Only players with the code can join';
    }
}

document.getElementById('visibility-public')?.addEventListener('click', () => {
    customLobbyVisibility = 'public';
    updateVisibilityToggle();
});

document.getElementById('visibility-private')?.addEventListener('click', () => {
    customLobbyVisibility = 'private';
    updateVisibilityToggle();
});

document.getElementById('close-custom-lobby-btn')?.addEventListener('click', hideCustomLobbyModal);

document.getElementById('custom-lobby-modal')?.querySelector('.modal-backdrop')?.addEventListener('click', hideCustomLobbyModal);

document.getElementById('create-custom-lobby-confirm')?.addEventListener('click', async () => {
    const timeControlSelect = document.getElementById('custom-time-control');
    const timeControl = timeControlSelect?.value || 'rapid';
    hideCustomLobbyModal();
    await createLobby({ visibility: customLobbyVisibility, isRanked: false, timeControl });
});

// Queue count polling
let queueCountInterval = null;

async function fetchQueueCounts() {
    try {
        const data = await apiCall('/api/queue/counts');
        updateQueueCountDisplay('quickplay', data.quick_play || 0);
        updateQueueCountDisplay('ranked', data.ranked || 0);
    } catch (error) {
        // Silently fail - queue counts are nice-to-have
        console.debug('Failed to fetch queue counts:', error);
    }
}

function updateQueueCountDisplay(mode, count) {
    const elementId = mode === 'quickplay' ? 'quickplay-queue-count' : 'ranked-queue-count';
    const el = document.getElementById(elementId);
    if (!el) return;
    
    el.textContent = count === 1 ? '1 in queue' : `${count} in queue`;
    el.classList.remove('hidden');
}

function startQueueCountPolling() {
    // Fetch immediately
    fetchQueueCounts();
    // Then poll every 5 seconds
    if (!queueCountInterval) {
        queueCountInterval = setInterval(fetchQueueCounts, 5000);
    }
}

function stopQueueCountPolling() {
    if (queueCountInterval) {
        clearInterval(queueCountInterval);
        queueCountInterval = null;
    }
}

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

// Collapsible rules toggle
document.getElementById('rules-toggle')?.addEventListener('click', () => {
    const content = document.getElementById('rules-content');
    const icon = document.querySelector('.rules-toggle-icon');
    if (content) {
        content.classList.toggle('collapsed');
        if (icon) {
            icon.textContent = content.classList.contains('collapsed') ? '▶' : '▼';
        }
    }
});

// ============ LEADERBOARDS ============

let leaderboardState = {
    mode: 'casual',      // 'casual' | 'ranked'
    casualType: 'alltime' // 'alltime' | 'weekly'
};

function getRankTier(mmr) {
    const v = Number(mmr || 0);
    // NOTE: Avoid emoji icons here (font support varies). We render CSS badges instead.
    if (v >= 2000) return { key: 'master', name: 'MASTER' };
    if (v >= 1800) return { key: 'diamond', name: 'DIAMOND' };
    if (v >= 1600) return { key: 'platinum', name: 'PLATINUM' };
    if (v >= 1400) return { key: 'gold', name: 'GOLD' };
    if (v >= 1200) return { key: 'silver', name: 'SILVER' };
    if (v >= 1000) return { key: 'bronze', name: 'BRONZE' };
    return { key: 'unranked', name: 'UNRANKED' };
}

function renderRankBadge(tier) {
    if (!tier) return '';
    const key = String(tier.key || 'unranked').toLowerCase();
    const name = String(tier.name || 'UNRANKED');
    return `<span class="rank-badge rank-${escapeHtml(key)}">${escapeHtml(name)}</span>`;
}

// ============ MMR ANIMATION SYSTEM ============

// Tier boundaries for MMR bar visualization
const MMR_TIER_BOUNDARIES = {
    bronze: { min: 1000, max: 1200 },
    silver: { min: 1200, max: 1400 },
    gold: { min: 1400, max: 1600 },
    platinum: { min: 1600, max: 1800 },
    diamond: { min: 1800, max: 2000 },
    master: { min: 2000, max: 3000 }
};

// Convert MMR to percentage position on the bar (0-100)
function mmrToBarPosition(mmr) {
    const minMMR = 0;
    const maxMMR = 3000;
    const clamped = Math.max(minMMR, Math.min(maxMMR, mmr));
    return (clamped / maxMMR) * 100;
}

// Animate MMR change with counting effect and visual feedback
function animateMMRChange(oldMMR, newMMR, delta) {
    const widget = document.getElementById('mmr-change-widget');
    const barFill = document.getElementById('mmr-bar-fill');
    const barMarker = document.getElementById('mmr-bar-marker');
    const valueDisplay = document.getElementById('mmr-value-current');
    const deltaFloat = document.getElementById('mmr-delta-float');
    const tierBadge = document.getElementById('mmr-tier-badge');
    const rankUpBanner = document.getElementById('rank-up-banner');
    const rankUpTier = document.getElementById('rank-up-tier');
    
    if (!widget || !barFill || !barMarker || !valueDisplay) return;
    
    // Show widget with animation
    widget.classList.remove('hidden');
    setTimeout(() => widget.classList.add('visible'), 50);
    
    // Get tier info
    const oldTier = getRankTier(oldMMR);
    const newTier = getRankTier(newMMR);
    const tierChanged = oldTier.key !== newTier.key;
    const isGain = delta > 0;
    
    // Set initial state
    const startPos = mmrToBarPosition(oldMMR);
    const endPos = mmrToBarPosition(newMMR);
    
    barFill.style.transition = 'none';
    barFill.style.width = startPos + '%';
    barMarker.style.transition = 'none';
    barMarker.style.left = startPos + '%';
    valueDisplay.textContent = oldMMR;
    
    // Set tier badge
    tierBadge.className = `mmr-tier-badge tier-${oldTier.key}`;
    tierBadge.textContent = oldTier.name;
    
    // Force reflow
    void barFill.offsetWidth;
    
    // Add gain/loss class
    barFill.classList.remove('gain', 'loss');
    barFill.classList.add(isGain ? 'gain' : 'loss');
    
    // Start animation after brief anticipation pause
    setTimeout(() => {
        // Animate bar
        barFill.style.transition = 'width 1.5s cubic-bezier(0.4, 0, 0.2, 1)';
        barMarker.style.transition = 'left 1.5s cubic-bezier(0.4, 0, 0.2, 1)';
        barFill.style.width = endPos + '%';
        barMarker.style.left = endPos + '%';
        
        // Animate number counting
        animateNumberCount(valueDisplay, oldMMR, newMMR, 1500);
        
        // Show delta float
        deltaFloat.textContent = (isGain ? '+' : '') + delta;
        deltaFloat.className = `mmr-delta-float visible ${isGain ? 'gain' : 'loss'}`;
        
        // Play sound effect
        if (typeof playMMRChangeSfx === 'function') {
            playMMRChangeSfx(isGain);
        }
        
        // Handle tier change (rank up/down)
        if (tierChanged) {
            setTimeout(() => {
                // Flash tier badge
                tierBadge.className = `mmr-tier-badge tier-${newTier.key} flash`;
                tierBadge.textContent = newTier.name;
                
                // If rank UP, show celebration
                if (isGain && newTier.key !== 'unranked') {
                    showRankUpCelebration(newTier, rankUpBanner, rankUpTier);
                }
            }, 1200);
        }
    }, 400); // Anticipation pause
}

// Animate a number counting up/down
function animateNumberCount(element, from, to, duration) {
    const startTime = performance.now();
    const diff = to - from;
    
    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Ease out cubic
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(from + diff * eased);
        
        element.textContent = current;
        
        if (progress < 1) {
            requestAnimationFrame(update);
        }
    }
    
    requestAnimationFrame(update);
}

// Show rank up celebration
function showRankUpCelebration(tier, banner, tierEl) {
    if (!banner || !tierEl) return;
    
    tierEl.textContent = tier.name;
    tierEl.className = `rank-up-tier tier-${tier.key}`;
    tierEl.style.color = getTierColor(tier.key);
    
    banner.classList.remove('hidden');
    banner.classList.add('visible');
    
    // Play rank up sound
    if (typeof playRankUpSfx === 'function') {
        playRankUpSfx();
    }
    
    // Create rank-up particle burst
    createRankUpParticles(tier.key);
    
    // Hide after delay
    setTimeout(() => {
        banner.classList.remove('visible');
        setTimeout(() => banner.classList.add('hidden'), 500);
    }, 3000);
}

// Create particle burst for rank up celebration
function createRankUpParticles(tierKey) {
    const container = document.createElement('div');
    container.className = 'rank-up-particles';
    container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999;overflow:hidden;';
    document.body.appendChild(container);
    
    const tierColors = {
        bronze: ['#cd7f32', '#8b4513', '#daa520'],
        silver: ['#c0c0c0', '#808080', '#e8e8e8'],
        gold: ['#ffd700', '#daa520', '#ffed4a'],
        platinum: ['#00d4ff', '#0099cc', '#66e0ff'],
        diamond: ['#b9f2ff', '#4fc3f7', '#e0f7fa'],
        master: ['#9c27b0', '#e91e63', '#ff5722']
    };
    
    const colors = tierColors[tierKey] || tierColors.gold;
    const particleCount = 40;
    
    for (let i = 0; i < particleCount; i++) {
        const particle = document.createElement('div');
        const size = 8 + Math.random() * 12;
        const angle = (i / particleCount) * Math.PI * 2;
        const velocity = 150 + Math.random() * 200;
        const tx = Math.cos(angle) * velocity;
        const ty = Math.sin(angle) * velocity - 100; // Bias upward
        
        particle.style.cssText = `
            position: absolute;
            left: 50%;
            top: 50%;
            width: ${size}px;
            height: ${size}px;
            background: ${colors[Math.floor(Math.random() * colors.length)]};
            border-radius: 50%;
            transform: translate(-50%, -50%);
            animation: rankUpParticleBurst 1s ease-out forwards;
            --tx: ${tx}px;
            --ty: ${ty}px;
        `;
        container.appendChild(particle);
    }
    
    // Add some star shapes
    for (let i = 0; i < 10; i++) {
        const star = document.createElement('div');
        const angle = Math.random() * Math.PI * 2;
        const velocity = 100 + Math.random() * 150;
        const tx = Math.cos(angle) * velocity;
        const ty = Math.sin(angle) * velocity - 80;
        
        star.textContent = '✦';
        star.style.cssText = `
            position: absolute;
            left: 50%;
            top: 50%;
            font-size: ${16 + Math.random() * 16}px;
            color: ${colors[0]};
            transform: translate(-50%, -50%);
            animation: rankUpParticleBurst 1.2s ease-out forwards;
            --tx: ${tx}px;
            --ty: ${ty}px;
            text-shadow: 0 0 10px ${colors[0]};
        `;
        container.appendChild(star);
    }
    
    // Cleanup
    setTimeout(() => container.remove(), 1500);
}

// Get tier color for styling
function getTierColor(tierKey) {
    const colors = {
        bronze: '#cd7f32',
        silver: '#c0c0c0',
        gold: '#ffd700',
        platinum: '#00d4ff',
        diamond: '#b9f2ff',
        master: '#e91e63',
        unranked: '#888888'
    };
    return colors[tierKey] || colors.unranked;
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
            const playerName = p?.name || '';

            if (type === 'weekly') {
                return `
                    <tr class="clickable-profile" data-player-name="${escapeHtml(playerName)}">
                        <td class="rank ${rankClass}">${escapeHtml(idx + 1)}</td>
                        <td class="player-name">${escapeHtml(playerName)}</td>
                        <td class="stat">${escapeHtml(weeklyWins)}</td>
                        <td class="stat">${escapeHtml(wins)}</td>
                        <td class="stat">${escapeHtml(games)}</td>
                        <td class="win-rate">${escapeHtml(winRate)}%</td>
                    </tr>
                `;
            }

            return `
                <tr class="clickable-profile" data-player-name="${escapeHtml(playerName)}">
                    <td class="rank ${rankClass}">${escapeHtml(idx + 1)}</td>
                    <td class="player-name">${escapeHtml(playerName)}</td>
                    <td class="stat">${escapeHtml(wins)}</td>
                    <td class="stat">${escapeHtml(games)}</td>
                    <td class="win-rate">${escapeHtml(winRate)}%</td>
                </tr>
            `;
        }).join('');

        renderLeaderboardTable('casual-leaderboard-table', headers, rows);
        
        // Add click handlers for profile viewing
        container.querySelectorAll('.clickable-profile').forEach(el => {
            el.addEventListener('click', () => {
                const name = el.dataset.playerName;
                if (name) openProfileModal(name);
            });
        });
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
            const playerName = p?.name || '';
            return `
                <tr class="clickable-profile" data-player-name="${escapeHtml(playerName)}">
                    <td class="rank ${rankClass}">${escapeHtml(idx + 1)}</td>
                    <td class="player-name">${escapeHtml(playerName)}</td>
                    <td class="stat">${renderRankBadge(tier)}</td>
                    <td class="stat">${escapeHtml(mmr)}</td>
                    <td class="stat">${escapeHtml(peak)}</td>
                    <td class="stat">${escapeHtml(games)}</td>
                    <td class="stat">${escapeHtml(wins)}-${escapeHtml(losses)}</td>
                </tr>
            `;
        }).join('');

        renderLeaderboardTable('ranked-leaderboard-table', headers, rows);
        
        // Add click handlers for profile viewing
        container.querySelectorAll('.clickable-profile').forEach(el => {
            el.addEventListener('click', () => {
                const name = el.dataset.playerName;
                if (name) openProfileModal(name);
            });
        });
    } catch (e) {
        renderLeaderboardTable('ranked-leaderboard-table', ['Rank', 'Player', 'MMR'], '');
    }
}

// Leaderboard navigation
document.getElementById('view-full-leaderboard-btn')?.addEventListener('click', () => {
    showScreen('leaderboard');
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

// Mini-leaderboard on home screen
async function loadMiniLeaderboard() {
    const container = document.getElementById('mini-leaderboard');
    if (!container) return;
    
    try {
        // Fetch both ranked and casual leaderboards in parallel
        const [rankedData, casualData] = await Promise.all([
            apiCall('/api/leaderboard/ranked').catch(() => ({ players: [] })),
            apiCall('/api/leaderboard?type=alltime').catch(() => ({ players: [] }))
        ]);
        
        const rankedPlayers = Array.isArray(rankedData?.players) ? rankedData.players.slice(0, 5) : [];
        const casualPlayers = Array.isArray(casualData?.players) ? casualData.players.slice(0, 5) : [];
        
        if (rankedPlayers.length === 0 && casualPlayers.length === 0) {
            container.innerHTML = '<p class="loading-lobbies">No data yet.</p>';
            return;
        }
        
        let html = '';
        
        // Ranked section (by ELO/MMR)
        if (rankedPlayers.length > 0) {
            html += '<div class="mini-lb-section">';
            html += '<div class="mini-lb-section-header">RANKED</div>';
            rankedPlayers.forEach((p, idx) => {
                const mmr = Number(p?.mmr || 0);
                const isTop3 = idx < 3;
                const playerName = p?.name || 'Unknown';
                const tier = getRankTier(mmr);
                html += `<div class="mini-lb-entry mini-lb-ranked ${isTop3 ? 'top-3' : ''} clickable-profile" data-player-name="${escapeHtml(playerName)}">
                    <span class="mini-lb-rank">#${idx + 1}</span>
                    <span class="mini-lb-name">${escapeHtml(playerName)}</span>
                    <span class="mini-lb-mmr rank-${tier.key}">${mmr}</span>
                </div>`;
            });
            html += '</div>';
        }
        
        // Casual section (by wins)
        if (casualPlayers.length > 0) {
            html += '<div class="mini-lb-section">';
            html += '<div class="mini-lb-section-header">CASUAL</div>';
            casualPlayers.forEach((p, idx) => {
                const wins = Number(p?.wins || 0);
                const isTop3 = idx < 3;
                const playerName = p?.name || 'Unknown';
                html += `<div class="mini-lb-entry mini-lb-casual ${isTop3 ? 'top-3' : ''} clickable-profile" data-player-name="${escapeHtml(playerName)}">
                    <span class="mini-lb-rank">#${idx + 1}</span>
                    <span class="mini-lb-name">${escapeHtml(playerName)}</span>
                    <span class="mini-lb-wins">${wins} wins</span>
                </div>`;
            });
            html += '</div>';
        }
        
        container.innerHTML = html;
        
        // Add click handlers for profile viewing
        container.querySelectorAll('.clickable-profile').forEach(el => {
            el.addEventListener('click', () => {
                const name = el.dataset.playerName;
                if (name) openProfileModal(name);
            });
        });
    } catch (e) {
        console.error('Failed to load mini-leaderboard:', e);
        container.innerHTML = '<p class="loading-lobbies">Failed to load.</p>';
    }
}

// ============ SINGLEPLAYER MODE ============

async function startSingleplayer() {
    // Lazy name prompt - show modal if no name
    if (!gameState.playerName) {
        showNamePromptModal(startSingleplayer);
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
}

document.getElementById('singleplayer-btn')?.addEventListener('click', startSingleplayer);

async function joinSingleplayerLobby(code, name) {
    try {
        const joinData = { name };
        if (gameState.authUser && gameState.authUser.id) {
            joinData.auth_user_id = gameState.authUser.id;
        }
        
        const data = await apiCall(`/api/games/${code}/join`, 'POST', joinData);
        
        gameState.code = code;
        gameState.playerId = data.player_id;
        gameState.sessionToken = data.session_token;  // SECURITY: Store session token
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
    
    // Set up delegated click handler for theme voting (survives DOM rebuilds)
    const themeContainer = document.getElementById('sp-theme-vote-options');
    if (themeContainer && !themeContainer._delegatedHandler) {
        themeContainer._delegatedHandler = true;
        themeContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('.theme-vote-btn');
            if (btn) voteForTheme(btn.dataset.theme);
        });
    }
    
    updateSingleplayerLobby();
    gameState.pollingInterval = setInterval(updateSingleplayerLobby, 2000);
}

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
    // Event delegation is set up once in startSingleplayerLobbyPolling() to avoid lost clicks during DOM rebuild
}

async function updateSingleplayerLobby() {
    try {
        const data = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
        
        // Update theme voting UI (singleplayer uses the same vote endpoint, but only the host typically votes)
        updateSingleplayerThemeVoting(data.theme_options || [], data.theme_votes || {});

        // Update theme display (show voted theme while in lobby, or prompt to select)
        let chosenTheme = data.theme?.name;
        if (!chosenTheme) {
            const opts = data.theme_options || [];
            const votes = data.theme_votes || {};
            const myVote = opts.find(t => (votes[t] || []).some(v => v.id === gameState.playerId));
            chosenTheme = myVote || '';
        }
        document.getElementById('sp-theme-name').textContent = chosenTheme || 'Select a database below';
        
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
        
        // Check if player has voted for a theme
        const opts = data.theme_options || [];
        const votes = data.theme_votes || {};
        const hasVoted = opts.some(t => (votes[t] || []).some(v => v.id === gameState.playerId));
        
        // Enable start button if we have at least 2 players (1 human + 1 AI) AND a theme is selected
        const aiCount = data.players.filter(p => p.is_ai).length;
        const startBtn = document.getElementById('sp-start-game-btn');
        const minPlayersNote = document.getElementById('sp-min-players');

        if (minPlayersNote) {
            if (aiCount < 1) {
                minPlayersNote.textContent = 'Add at least 1 AI opponent';
                minPlayersNote.style.display = '';
            } else if (!hasVoted) {
                minPlayersNote.textContent = 'Select a database above';
                minPlayersNote.style.display = '';
            } else {
                minPlayersNote.textContent = 'Ready to start';
                minPlayersNote.style.display = 'none';
            }
        }

        if (startBtn && !spStartInProgress) {
            startBtn.disabled = aiCount < 1 || !hasVoted;
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
                session_token: gameState.sessionToken,
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
            session_token: gameState.sessionToken,
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
            session_token: gameState.sessionToken,
        });
        
        // Fetch the updated game state with word pools
        const data = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
        
        // Reset button state on success
        spStartInProgress = false;
        startBtn.disabled = false;
        startBtn.textContent = '> START_MISSION';
        
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
            await apiCall(`/api/games/${gameState.code}/leave`, 'POST', {
                player_id: gameState.playerId,
                session_token: gameState.sessionToken,
            });
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
        gameState.sessionToken = data.session_token;  // SECURITY: Store session token
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
    
    // Set up delegated click handler for theme voting (survives DOM rebuilds)
    const themeContainer = document.getElementById('theme-vote-options');
    if (themeContainer && !themeContainer._delegatedHandler) {
        themeContainer._delegatedHandler = true;
        themeContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('.theme-vote-btn');
            if (btn) voteForTheme(btn.dataset.theme);
        });
    }
    
    updateLobby();
    gameState.pollingInterval = setInterval(updateLobby, 2000);
}

async function updateLobby() {
    try {
        const data = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
        
        // Update mode badge (ranked/casual)
        const modeBadge = document.getElementById('lobby-mode-badge');
        if (modeBadge) {
            const isRanked = Boolean(data.is_ranked);
            modeBadge.textContent = isRanked ? 'RANKED' : 'CASUAL';
            modeBadge.className = `mode-badge ${isRanked ? 'ranked' : 'casual'}`;
        }
        
        // Update time control badge (chess clock format)
        const timeBadge = document.getElementById('lobby-time-badge');
        if (timeBadge) {
            const timeControl = data.time_control;
            const initialTime = timeControl?.initial_time || 0;
            const increment = timeControl?.increment || 0;
            
            if (initialTime > 0) {
                const mins = Math.floor(initialTime / 60);
                const secs = initialTime % 60;
                const timeStr = secs > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${mins} min`;
                timeBadge.textContent = `⏱ ${timeStr} +${increment}s`;
                timeBadge.classList.remove('hidden', 'no-limit');
            } else {
                timeBadge.textContent = '⏱ No Limit';
                timeBadge.classList.remove('hidden');
                timeBadge.classList.add('no-limit');
            }
        }
        
        // Update players list
        const playersList = document.getElementById('lobby-players');
        playersList.innerHTML = data.players.map(p => {
            const isAI = p.is_ai;
            const clickableClass = !isAI ? 'clickable-profile' : '';
            const dataAttr = !isAI ? `data-player-name="${escapeHtml(p.name)}"` : '';
            return `
                <div class="lobby-player ${p.id === data.host_id ? 'host' : ''}">
                    <span class="player-name ${clickableClass}" ${dataAttr}>${escapeHtml(p.name)}${p.id === gameState.playerId ? ' (you)' : ''}</span>
                    ${p.id === data.host_id ? '<span class="host-badge">HOST</span>' : ''}
                </div>
            `;
        }).join('');
        
        // Add click handlers for profile viewing (non-AI players only)
        playersList.querySelectorAll('.clickable-profile').forEach(el => {
            el.addEventListener('click', () => {
                const name = el.dataset.playerName;
                if (name) openProfileModal(name);
            });
        });
        
        document.getElementById('player-count').textContent = data.players.length;
        
        // Update theme voting with voter names
        updateThemeVoting(data.theme_options, data.theme_votes);
        
        // Update host status from server (in case host changed or initial state was wrong)
        gameState.isHost = data.host_id === gameState.playerId;
        
        // Show/hide host controls
        const hostControls = document.getElementById('host-controls');
        if (gameState.isHost) {
            hostControls.classList.remove('hidden');
            // Need at least 2 players to start
            const minPlayers = 2;
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
    // Event delegation is set up once in startLobbyPolling() to avoid lost clicks during DOM rebuild
}

async function voteForTheme(theme) {
    try {
        await apiCall(`/api/games/${gameState.code}/vote`, 'POST', {
            player_id: gameState.playerId,
            session_token: gameState.sessionToken,
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
    
    // Store word selection timer info
    gameState.wordSelectionTime = data.word_selection_time || 0;
    gameState.wordSelectionTimeRemaining = data.word_selection_time_remaining;
    gameState.wordSelectionStartedAt = Date.now();
    
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
        el.addEventListener('dblclick', () => {
            // Select the word
            poolContainer.querySelectorAll('.word-option').forEach(w => w.classList.remove('selected'));
            el.classList.add('selected');
            document.getElementById('selected-word-display').textContent = el.dataset.word.toUpperCase();
            document.getElementById('selected-word-display').dataset.word = el.dataset.word;
            // Lock it in
            lockWordSelection();
        });
    });
    
    // Reset state
    document.getElementById('selected-word-display').textContent = 'Click a word above';
    document.getElementById('selected-word-display').dataset.word = '';
    document.getElementById('word-select-controls').classList.remove('hidden');
    document.getElementById('word-locked-notice').classList.add('hidden');
    
    // Reset local lock flag
    gameState.hasLockedWord = false;
    
    showScreen('wordselect');
    startWordSelectPolling();
    
    // Start word selection timer if there's a time limit
    if (gameState.wordSelectionTime > 0) {
        startWordSelectionTimer();
    }
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

        // Store game state for reference
        gameState.game = data;

        // In singleplayer, trigger AI word selection in the background while you choose yours
        maybeTriggerSingleplayerAiWordPick(data);
        
        // Sync word selection timer with server
        if (data.word_selection_time_remaining !== undefined && data.word_selection_time_remaining !== null) {
            gameState.wordSelectionTimeRemaining = data.word_selection_time_remaining;
            gameState.wordSelectionStartedAt = Date.now();
            gameState.wordSelectionTime = data.word_selection_time || 0;
            
            // Start timer if not already running
            if (!gameState.wordSelectionTimerInterval && gameState.wordSelectionTime > 0) {
                startWordSelectionTimer();
            }
        }
        
        // Update player status
        const lockedCount = data.players.filter(p => p.has_word).length;
        const totalCount = data.players.length;
        const myPlayer = data.players.find(p => p.id === gameState.playerId);
        const iHaveLocked = myPlayer?.has_word;
        const allLocked = lockedCount === totalCount;
        
        document.getElementById('locked-count').textContent = lockedCount;
        document.getElementById('total-count').textContent = totalCount;
        
        // Update waiting text based on status
        const waitingTextEl = document.getElementById('waiting-text');
        if (waitingTextEl && iHaveLocked) {
            if (allLocked) {
                if (gameState.isHost) {
                    waitingTextEl.textContent = 'All operatives ready! Click BEGIN below.';
                } else {
                    waitingTextEl.textContent = 'All operatives ready! Waiting for host to begin...';
                }
            } else {
                // Show who we're waiting for
                const notLocked = data.players.filter(p => !p.has_word && p.id !== gameState.playerId);
                if (notLocked.length > 0) {
                    const names = notLocked.map(p => p.name).join(', ');
                    waitingTextEl.textContent = `Waiting for: ${names}`;
                } else {
                    waitingTextEl.textContent = 'Waiting for other operatives...';
                }
            }
        }
        
        const statusList = document.getElementById('player-status-list');
        statusList.innerHTML = data.players.map(p => {
            const isAI = p.is_ai;
            const clickableClass = !isAI ? 'clickable-profile' : '';
            const dataAttr = !isAI ? `data-player-name="${escapeHtml(p.name)}"` : '';
            return `
                <div class="player-status-item ${p.has_word ? 'locked' : ''}">
                    <span class="${clickableClass}" ${dataAttr}>${escapeHtml(p.name)}${p.id === gameState.playerId ? ' (you)' : ''}</span>
                    <span>${p.has_word ? '✓ LOCKED' : '○ SELECTING'}</span>
                </div>
            `;
        }).join('');
        
        // Add click handlers for profile viewing (non-AI players only)
        statusList.querySelectorAll('.clickable-profile').forEach(el => {
            el.addEventListener('click', () => {
                const name = el.dataset.playerName;
                if (name) openProfileModal(name);
            });
        });
        
        // Show host controls if all locked
        if (gameState.isHost) {
            document.getElementById('host-begin-controls').classList.remove('hidden');
            document.getElementById('begin-game-btn').disabled = !allLocked;
        }
        
        // Check if game started
        if (data.status === 'playing') {
            clearInterval(gameState.pollingInterval);
            stopWordSelectionTimer();
            showScreen('game');
            startGamePolling();
        }
    } catch (error) {
        // Silently ignore
    }
}

// ============ WORD SELECTION TIMER ============

function startWordSelectionTimer() {
    // Clear any existing timer
    if (gameState.wordSelectionTimerInterval) {
        clearInterval(gameState.wordSelectionTimerInterval);
    }
    
    // Update timer immediately
    updateWordSelectionTimerDisplay();
    
    // Update every 100ms for smooth countdown
    gameState.wordSelectionTimerInterval = setInterval(() => {
        updateWordSelectionTimerDisplay();
    }, 100);
}

function updateWordSelectionTimerDisplay() {
    const timerEl = document.getElementById('word-selection-timer');
    if (!timerEl) return;
    
    const totalTime = gameState.wordSelectionTime || 0;
    if (totalTime <= 0) {
        timerEl.classList.add('hidden');
        return;
    }
    
    // Calculate remaining time
    let remaining = gameState.wordSelectionTimeRemaining || 0;
    if (gameState.wordSelectionStartedAt) {
        const elapsed = (Date.now() - gameState.wordSelectionStartedAt) / 1000;
        remaining = Math.max(0, remaining - elapsed);
    }
    
    // Format and display
    const timeStr = formatChessClockTime(remaining);
    timerEl.textContent = `⏱ ${timeStr}`;
    timerEl.classList.remove('hidden');
    
    // Update urgency class
    timerEl.classList.remove('normal', 'warning', 'critical');
    if (remaining <= 5) {
        timerEl.classList.add('critical');
    } else if (remaining <= 15) {
        timerEl.classList.add('warning');
    } else {
        timerEl.classList.add('normal');
    }
    
    // Check for timeout
    if (remaining <= 0) {
        handleWordSelectionTimeout();
    }
}

async function handleWordSelectionTimeout() {
    // Stop the timer
    if (gameState.wordSelectionTimerInterval) {
        clearInterval(gameState.wordSelectionTimerInterval);
        gameState.wordSelectionTimerInterval = null;
    }
    
    // Check if we already have a word locked (local flag takes priority to avoid race condition)
    if (gameState.hasLockedWord) {
        return; // Already locked in locally, nothing to do
    }
    
    // Also check server state as fallback
    const myPlayer = gameState.game?.players?.find(p => p.id === gameState.playerId);
    if (myPlayer?.has_word) {
        return; // Already locked in on server, nothing to do
    }
    
    try {
        const result = await apiCall(`/api/games/${gameState.code}/word-selection-timeout`, 'POST', {
            player_id: gameState.playerId,
            session_token: gameState.sessionToken,
        });
        
        if (result.timeout) {
            // Check if we were auto-assigned a word
            const myAssignment = result.auto_assigned?.find(p => p.id === gameState.playerId);
            if (myAssignment) {
                // Fetch updated game state to get the assigned word
                const data = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
                gameState.game = data;
                const updatedPlayer = data.players?.find(p => p.id === gameState.playerId);
                const assignedWord = updatedPlayer?.secret_word || 'RANDOM';
                
                showError(`Time expired! "${assignedWord.toUpperCase()}" was assigned to you.`);
                
                // Lock the UI - show locked notice with assigned word
                document.getElementById('word-select-controls').classList.add('hidden');
                document.getElementById('word-locked-notice').classList.remove('hidden');
                document.getElementById('locked-word-display').textContent = assignedWord.toUpperCase();
                
                // Disable word selection options
                document.querySelectorAll('.word-option').forEach(el => {
                    el.style.pointerEvents = 'none';
                    if (el.dataset.word.toLowerCase() !== assignedWord.toLowerCase()) {
                        el.style.opacity = '0.3';
                    } else {
                        el.classList.add('selected');
                    }
                });
                
                // Update the selected word display
                document.getElementById('selected-word-display').textContent = assignedWord.toUpperCase();
                document.getElementById('selected-word-display').dataset.word = assignedWord;
            }
            
            // Refresh the screen to update player status counts
            updateWordSelectScreen();
        }
    } catch (error) {
        console.error('Word selection timeout error:', error);
    }
}

function stopWordSelectionTimer() {
    if (gameState.wordSelectionTimerInterval) {
        clearInterval(gameState.wordSelectionTimerInterval);
        gameState.wordSelectionTimerInterval = null;
    }
}

// Lock word selection function (used by button and double-click)
async function lockWordSelection() {
    const wordDisplay = document.getElementById('selected-word-display');
    const word = wordDisplay.dataset.word;
    if (!word) {
        showError('Please select a word');
        return;
    }
    
    try {
        await apiCall(`/api/games/${gameState.code}/set-word`, 'POST', {
            player_id: gameState.playerId,
            session_token: gameState.sessionToken,
            secret_word: word,
        });
        
        // Set local flag IMMEDIATELY to prevent timeout race condition
        gameState.hasLockedWord = true;
        
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
}

// Lock in word button
document.getElementById('lock-word-btn')?.addEventListener('click', lockWordSelection);

// Begin game button (host only)
document.getElementById('begin-game-btn')?.addEventListener('click', async () => {
    try {
        await apiCall(`/api/games/${gameState.code}/begin`, 'POST', {
            player_id: gameState.playerId,
            session_token: gameState.sessionToken,
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
            session_token: gameState.sessionToken,
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
    }, 1000);
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
            session_token: gameState.sessionToken,
        });
        
        // Fetch the updated game state with word pools
        const data = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
        
        // Reset button state on success (for next game without refresh)
        startBtn.disabled = false;
        startBtn.textContent = '> SELECT_WORDS';
        
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
            await apiCall(`/api/games/${gameState.code}/leave`, 'POST', {
                player_id: gameState.playerId,
                session_token: gameState.sessionToken,
            });
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

// Track last game state to avoid unnecessary re-renders
let lastGameHistoryLength = -1;
let lastGameCurrentPlayerId = null;

function updateGame(game) {
    const isSpectator = Boolean(gameState.isSpectator);
    const myPlayer = game.players.find(p => p.id === gameState.playerId);

    // Always update header meta (turn/mode badge), even while waiting for word selection.
    updateGameHeaderMeta(game);
    
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
        
        // Disable guessing during word selection
        const submitBtn = document.getElementById('guess-submit-btn');
        if (submitBtn) submitBtn.disabled = true;
        
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
            
            // Reset word change flag when the UI is shown (new word change opportunity)
            gameState.hasSubmittedWordChange = false;
            
            // Start/update word change timer if we have time remaining from server
            updateWordChangeTimer(game.word_change_time_remaining);
            
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
            // Stop word change timer
            stopWordChangeTimer();
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
    
    // Store game state for timer access
    gameState.game = game;
    
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
    
    // Update guess word grid
    updateGuessWordGrid(game, isMyTurn, isSpectator);
    
    // Only re-render history if it has actually changed (avoid flicker)
    const historyLength = game.history?.length || 0;
    const currentPlayerId = game.current_player_id;
    if (historyLength !== lastGameHistoryLength || currentPlayerId !== lastGameCurrentPlayerId) {
        lastGameHistoryLength = historyLength;
        lastGameCurrentPlayerId = currentPlayerId;
        updateHistory(game);
    }
}

function updateGameHeaderMeta(game) {
    const turnEl = document.getElementById('turn-number');
    const modeBadge = document.getElementById('game-mode-badge');
    if (!turnEl) return;

    // Update mode badge (ranked/casual)
    if (modeBadge) {
        const isRanked = Boolean(game?.is_ranked);
        modeBadge.textContent = isRanked ? 'RANKED' : 'CASUAL';
        modeBadge.className = `mode-badge ${isRanked ? 'ranked' : 'casual'}`;
    }

    // Calculate round number based on complete rounds where all alive players have guessed
    // A round completes when every alive player has had their turn
    const history = Array.isArray(game?.history) ? game.history : [];
    const players = Array.isArray(game?.players) ? game.players : [];
    const totalPlayers = players.length || 1;
    
    // Count guesses per round, accounting for eliminations
    // We track which round each guess belongs to by simulating the game
    let roundNumber = 1;
    let guessesInCurrentRound = 0;
    let aliveCount = totalPlayers; // Start with all players alive
    
    for (const entry of history) {
        if (entry.type === 'forfeit' || entry.type === 'word_change') {
            // Forfeits and word changes don't count as turns
            continue;
        }
        
        if (entry.word) {
            guessesInCurrentRound++;
            
            // Check if this guess caused eliminations
            const eliminations = entry.eliminations || [];
            aliveCount -= eliminations.length;
            
            // If we've had enough guesses for all alive players (before eliminations), round is complete
            // We use the alive count BEFORE eliminations for the round threshold
            const playersBeforeElim = aliveCount + eliminations.length;
            if (guessesInCurrentRound >= playersBeforeElim) {
                roundNumber++;
                guessesInCurrentRound = 0;
            }
        }
    }
    
    turnEl.textContent = String(roundNumber);
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
    
    // Sort and keep top 3 unique words for each player
    Object.keys(topGuessesPerPlayer).forEach(playerId => {
        // Sort by similarity descending
        topGuessesPerPlayer[playerId].sort((a, b) => b.similarity - a.similarity);
        // Deduplicate words, keeping only the highest similarity for each word
        const seen = new Set();
        const unique = [];
        for (const guess of topGuessesPerPlayer[playerId]) {
            const wordLower = guess.word.toLowerCase();
            if (!seen.has(wordLower)) {
                seen.add(wordLower);
                unique.push(guess);
                if (unique.length >= 3) break;
            }
        }
        topGuessesPerPlayer[playerId] = unique;
    });
    
    // Get max transformed similarity for danger indicator
    function getMaxTransformedSimilarity(topGuesses) {
        if (!topGuesses || topGuesses.length === 0) return 0;
        // Get the highest raw similarity and transform it
        const maxRaw = topGuesses[0].similarity;
        return transformSimilarity(maxRaw);
    }
    
    game.players.forEach(player => {
        // Don't highlight current turn if game is paused for word change
        const isCurrentTurn = player.id === game.current_player_id && !game.waiting_for_word_change;
        const isYou = player.id === gameState.playerId;
        const isAI = player.is_ai;
        const isRankedGame = Boolean(game.is_ranked);
        
        // Get cosmetic classes
        const cosmeticClasses = typeof getPlayerCardClasses === 'function' 
            ? getPlayerCardClasses(player.cosmetics) : '';
        const nameColorClass = typeof getNameColorClass === 'function'
            ? getNameColorClass(player.cosmetics) : '';
        const badgeHtml = typeof getBadgeHtml === 'function'
            ? getBadgeHtml(player.cosmetics) : '';
        const titleHtml = typeof getTitleHtml === 'function'
            ? getTitleHtml(player.cosmetics) : '';
        
        const div = document.createElement('div');
        div.className = `player-card${isCurrentTurn ? ' current-turn' : ''}${!player.is_alive ? ' eliminated' : ''}${isYou ? ' is-you' : ''}${isAI ? ' is-ai' : ''} ${cosmeticClasses}`;
        div.dataset.playerId = player.id;
        
        // Apply profile banner if set
        if (player.cosmetics && player.cosmetics.profile_banner && player.cosmetics.profile_banner !== 'none') {
            div.dataset.banner = player.cosmetics.profile_banner;
        }
        
        // Calculate max transformed similarity for danger indicator
        const topGuesses = topGuessesPerPlayer[player.id];
        const maxTransformedSim = getMaxTransformedSimilarity(topGuesses);
        
        // Build danger indicator HTML (only for alive players with guesses)
        // Uses a fill bar that grows with danger, colored on green-to-red spectrum
        let dangerHtml = '';
        if (player.is_alive && topGuesses && topGuesses.length > 0) {
            const dangerColor = getSimilarityColor(maxTransformedSim);
            const dangerPercent = Math.round(maxTransformedSim * 100);
            dangerHtml = `<div class="danger-indicator" title="Max similarity: ${dangerPercent}%">
                <div class="danger-fill" style="width: ${dangerPercent}%; background: ${dangerColor}"></div>
            </div>`;
        }
        
        // Build AI difficulty badge HTML
        let aiDifficultyBadge = '';
        if (isAI && player.difficulty) {
            const diffInfo = getAiDifficultyInfo(player.difficulty);
            aiDifficultyBadge = `<span class="ai-difficulty-badge ${escapeHtml(player.difficulty)}" title="${escapeHtml(diffInfo.tagline || '')}">${escapeHtml(diffInfo.label || player.difficulty)}</span>`;
        }
        
        // Build ranked info HTML (show MMR and rank for ranked games)
        let rankedInfoHtml = '';
        if (isRankedGame && !isAI && player.mmr_display) {
            const mmr = Number(player.mmr_display.mmr || 0);
            const rankedGames = Number(player.mmr_display.ranked_games || 0);
            const isPlacement = rankedGames < 5;
            const tier = getRankTier(mmr);
            
            if (isPlacement) {
                rankedInfoHtml = `<div class="player-ranked-info placement"><span class="placement-badge">PLACEMENT</span><span class="placement-games">${rankedGames}/5</span></div>`;
            } else {
                rankedInfoHtml = `<div class="player-ranked-info">${renderRankBadge(tier)}<span class="player-mmr">${mmr}</span></div>`;
            }
        }
        
        // Build top guesses HTML (show top 3 closest guesses for each player)
        let topGuessesHtml = '';
        
        // Check if this player recently changed their word
        const hasChangedWord = wordChangeAfterIndex[player.id] !== undefined;
        
        if (topGuesses && topGuesses.length > 0) {
            topGuessesHtml = '<div class="top-guesses">';
            topGuesses.forEach(guess => {
                const transformedSim = transformSimilarity(guess.similarity);
                const simColor = getSimilarityColor(transformedSim);
                topGuessesHtml += `
                    <div class="top-guess">
                        <span class="guess-word">${escapeHtml(guess.word)}</span>
                        <span class="guess-sim" style="color: ${simColor}">${Math.round(transformedSim * 100)}%</span>
                    </div>
                `;
            });
            topGuessesHtml += '</div>';
        } else if (hasChangedWord && player.is_alive) {
            topGuessesHtml = '<div class="word-changed-note">Word changed!</div>';
        }
        
        // Build name HTML with clickable profile (for non-AI players)
        const nameClickable = !isAI ? 'clickable-profile' : '';
        const nameDataAttr = !isAI ? `data-player-name="${escapeHtml(player.name)}"` : '';
        
        // Build time remaining HTML (chess clock)
        let timeHtml = '';
        const timeControl = game.time_control;
        const hasTimeControl = timeControl && timeControl.initial_time > 0;
        if (hasTimeControl && player.time_remaining !== null && player.time_remaining !== undefined) {
            const timeRemaining = Math.max(0, player.time_remaining);
            const timeStr = formatChessClockTime(timeRemaining);
            const isLowTime = timeRemaining < 30;
            const isCriticalTime = timeRemaining < 10;
            const timeClass = isCriticalTime ? 'critical' : (isLowTime ? 'warning' : '');
            timeHtml = `<div class="player-time ${timeClass}" data-player-id="${player.id}">${timeStr}</div>`;
        }
        
        div.innerHTML = `
            ${dangerHtml}
            <div class="name ${nameColorClass} ${nameClickable}" ${nameDataAttr}>${escapeHtml(player.name)}${aiDifficultyBadge}${badgeHtml}${isYou ? ' (you)' : ''}${titleHtml}</div>
            ${rankedInfoHtml}
            ${timeHtml}
            <div class="status ${player.is_alive ? 'alive' : 'eliminated'}">
                ${player.is_alive ? 'Alive' : 'Eliminated'}
            </div>
            ${topGuessesHtml}
        `;
        
        // Add click handler for profile viewing (non-AI players only)
        if (!isAI) {
            const nameEl = div.querySelector('.name.clickable-profile');
            if (nameEl) {
                nameEl.addEventListener('click', (e) => {
                    e.stopPropagation(); // Don't trigger card click
                    openProfileModal(player.name);
                });
            }
        }
        
        grid.appendChild(div);
    });
}

function getSimilarityClass(sim) {
    // Thresholds for TRANSFORMED similarity values
    if (sim >= 0.95) return 'danger';  // Very close to elimination (~88%+ raw)
    if (sim >= 0.75) return 'high';    // High danger zone (~55%+ raw)
    if (sim >= 0.50) return 'medium';  // Moderate similarity (~37%+ raw)
    return 'low';
}

function updateTurnIndicator(game) {
    const indicator = document.getElementById('turn-indicator');
    const turnText = document.getElementById('turn-text');
    const timerEl = document.getElementById('turn-timer');
    
    if (game.status === 'finished') {
        indicator.classList.remove('your-turn');
        turnText.textContent = 'Game Over!';
        hideTimer();
        return;
    }
    
    // If game is paused for word change, show that instead of whose turn it is
    if (game.waiting_for_word_change) {
        const waitingPlayer = game.players.find(p => p.id === game.waiting_for_word_change);
        const isMe = game.waiting_for_word_change === gameState.playerId;
        
        if (isMe) {
            indicator.classList.add('your-turn');
            turnText.textContent = "🎯 PICK A NEW SECRET WORD NOW!";
        } else {
            indicator.classList.remove('your-turn');
            turnText.textContent = `⏳ ${waitingPlayer?.name || '...'} is choosing a new secret word...`;
        }
        hideTimer();
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
    
    // Update timer state from server response
    updateTimerFromGame(game);
}

// ============ TURN TIMER (Chess Clock Model) ============

function formatChessClockTime(seconds) {
    if (seconds <= 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function updateTimerFromGame(game) {
    const timeControl = game.time_control;
    const initialTime = timeControl?.initial_time || 0;
    const increment = timeControl?.increment || 0;
    
    // Store time control for later use
    gameState.timeControl = timeControl;
    
    // No timer if no time limit or game is paused
    if (initialTime <= 0 || game.waiting_for_word_change || game.status !== 'playing' || !game.all_words_set) {
        hideTimer();
        return;
    }
    
    // Get current player's time from server (already calculated)
    const currentPlayer = game.players.find(p => p.id === game.current_player_id);
    if (currentPlayer && currentPlayer.time_remaining !== null && currentPlayer.time_remaining !== undefined) {
        gameState.currentPlayerTime = currentPlayer.time_remaining;
        gameState.turnStartedAt = Date.now();
    }
    
    // Start or continue the timer
    startTurnTimer();
}

function startTurnTimer() {
    // Clear any existing timer
    if (gameState.turnTimerInterval) {
        clearInterval(gameState.turnTimerInterval);
    }
    
    const timerEl = document.getElementById('turn-timer');
    if (!timerEl) return;
    
    timerEl.classList.remove('hidden');
    
    // Update timer immediately
    updateTimerDisplay();
    
    // Update every 100ms for smooth countdown
    gameState.turnTimerInterval = setInterval(() => {
        updateTimerDisplay();
    }, 100);
}

function updateTimerDisplay() {
    const timerEl = document.getElementById('turn-timer');
    if (!timerEl) return;
    
    const timeControl = gameState.timeControl;
    const initialTime = timeControl?.initial_time || 0;
    const increment = timeControl?.increment || 0;
    
    // Don't update timers if game is paused for word change
    if (initialTime <= 0 || gameState.game?.waiting_for_word_change) {
        hideTimer();
        return;
    }
    
    // Calculate remaining time (chess clock: decrement from player's stored time)
    let remaining = gameState.currentPlayerTime || 0;
    if (gameState.turnStartedAt) {
        const elapsed = (Date.now() - gameState.turnStartedAt) / 1000;
        remaining = Math.max(0, remaining - elapsed);
    }
    
    // Format time with increment display
    const timeStr = formatChessClockTime(remaining);
    const incrementStr = increment > 0 ? ` +${increment}s` : '';
    timerEl.textContent = `⏱ ${timeStr}${incrementStr}`;
    
    // Update urgency class
    timerEl.classList.remove('normal', 'warning', 'critical');
    if (remaining <= 10) {
        timerEl.classList.add('critical');
    } else if (remaining <= 30) {
        timerEl.classList.add('warning');
    } else {
        timerEl.classList.add('normal');
    }
    
    // Check for timeout
    if (remaining <= 0) {
        handleTurnTimeout();
    }
    
    // Update player card timers too
    updatePlayerCardTimers(remaining);
}

function updatePlayerCardTimers(currentPlayerRemaining) {
    // Update the current player's card timer in real-time
    // Other players' times are static (from last server sync)
    // Don't update if game is paused for word change
    if (gameState.game?.waiting_for_word_change) {
        return;
    }
    
    const playerTimeEls = document.querySelectorAll('.player-time');
    playerTimeEls.forEach(el => {
        const playerId = el.dataset.playerId;
        // Only update the current player's timer
        if (playerId && gameState.game && gameState.game.current_player_id === playerId) {
            const timeStr = formatChessClockTime(currentPlayerRemaining);
            el.textContent = timeStr;
            
            // Update urgency class
            el.classList.remove('warning', 'critical');
            if (currentPlayerRemaining <= 10) {
                el.classList.add('critical');
            } else if (currentPlayerRemaining <= 30) {
                el.classList.add('warning');
            }
        }
    });
}

function hideTimer() {
    const timerEl = document.getElementById('turn-timer');
    if (timerEl) {
        timerEl.classList.add('hidden');
    }
    if (gameState.turnTimerInterval) {
        clearInterval(gameState.turnTimerInterval);
        gameState.turnTimerInterval = null;
    }
}

// ============ WORD CHANGE TIMER (30 seconds after elimination) ============

function updateWordChangeTimer(serverTimeRemaining) {
    const timerEl = document.getElementById('word-change-timer');
    const countdownEl = document.getElementById('word-change-countdown');
    if (!timerEl || !countdownEl) return;
    
    // If server gives us time remaining, sync to it
    if (serverTimeRemaining !== null && serverTimeRemaining !== undefined) {
        gameState.wordChangeTimeRemaining = serverTimeRemaining;
    }
    
    // Show timer
    timerEl.classList.remove('hidden');
    
    // Start interval if not already running
    if (!gameState.wordChangeTimerInterval) {
        gameState.wordChangeTimerInterval = setInterval(() => {
            updateWordChangeTimerDisplay();
        }, 100);
    }
    
    // Update display immediately
    updateWordChangeTimerDisplay();
}

function updateWordChangeTimerDisplay() {
    const timerEl = document.getElementById('word-change-timer');
    const countdownEl = document.getElementById('word-change-countdown');
    if (!timerEl || !countdownEl) return;
    
    // Decrement time
    if (gameState.wordChangeTimeRemaining !== null) {
        gameState.wordChangeTimeRemaining = Math.max(0, gameState.wordChangeTimeRemaining - 0.1);
    }
    
    const remaining = gameState.wordChangeTimeRemaining || 0;
    countdownEl.textContent = Math.ceil(remaining);
    
    // Add urgency class when low
    if (remaining <= 5) {
        timerEl.classList.add('urgent');
    } else {
        timerEl.classList.remove('urgent');
    }
    
    // Check for timeout
    if (remaining <= 0) {
        handleWordChangeTimeout();
    }
}

function stopWordChangeTimer() {
    const timerEl = document.getElementById('word-change-timer');
    if (timerEl) {
        timerEl.classList.add('hidden');
        timerEl.classList.remove('urgent');
    }
    if (gameState.wordChangeTimerInterval) {
        clearInterval(gameState.wordChangeTimerInterval);
        gameState.wordChangeTimerInterval = null;
    }
    gameState.wordChangeTimeRemaining = null;
}

async function handleWordChangeTimeout() {
    // Stop the timer to prevent multiple calls
    stopWordChangeTimer();
    
    // Only trigger timeout if we're in the game (not spectating) and we have a word change pending
    if (gameState.isSpectator || !gameState.code) {
        return;
    }
    
    // Check if we already submitted a word change (local flag to prevent race condition)
    if (gameState.hasSubmittedWordChange) {
        return; // Already submitted locally, nothing to do
    }
    
    try {
        const result = await apiCall(`/api/games/${gameState.code}/word-change-timeout`, 'POST', {
            player_id: gameState.playerId,
            session_token: gameState.sessionToken,
        });
        
        if (result.timeout) {
            showSuccess('Time expired! A random word was selected for you.');
        }
        
        // Refresh game state
        const game = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
        updateGame(game);
    } catch (error) {
        console.error('Word change timeout error:', error);
        // Try to refresh game state anyway
        try {
            const game = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
            updateGame(game);
        } catch (e) {
            // Ignore secondary error
        }
    }
}

async function handleTurnTimeout() {
    // Stop the timer to prevent multiple calls
    if (gameState.turnTimerInterval) {
        clearInterval(gameState.turnTimerInterval);
        gameState.turnTimerInterval = null;
    }
    
    // Only trigger timeout if we're in the game (not spectating)
    if (gameState.isSpectator || !gameState.code) {
        return;
    }
    
    // Check if we're currently submitting a guess (prevents race condition)
    if (gameState.isSubmittingGuess) {
        return; // Guess is in flight, let it complete - server will handle timing
    }
    
    try {
        const result = await apiCall(`/api/games/${gameState.code}/timeout`, 'POST', {
            player_id: gameState.playerId,
            session_token: gameState.sessionToken,
        });
        
        if (result.timeout) {
            // Show notification about the timeout (always elimination in chess clock model)
            const timedOutPlayer = result.timed_out_player;
            const isMe = timedOutPlayer?.id === gameState.playerId;
            
            if (isMe) {
                showError('Time expired! You have been eliminated.');
            } else {
                showSuccess(`${timedOutPlayer?.name || 'Player'} ran out of time and was eliminated!`);
            }
            // Play elimination effect
            if (timedOutPlayer?.id && typeof playEliminationEffect === 'function') {
                playEliminationEffect(timedOutPlayer.id, 'classic');
            }
            playEliminationSfx();
            
            // Update game state with response
            if (result.status) {
                updateGame(result);
            }
        }
    } catch (error) {
        console.error('Timeout error:', error);
        // Timer will resync on next poll
    }
}

function updateHistory(game) {
    const historyLog = document.getElementById('history-log');
    historyLog.innerHTML = '';
    
    // Track previous history length to detect new eliminations
    const prevHistoryLength = gameState.prevHistoryLength || 0;
    const currentHistoryLength = game.history.length;
    
    // Build elimination index: player_id -> history index where they were eliminated
    const eliminatedAtIndex = {};
    game.history.forEach((entry, idx) => {
        if (entry.type === 'forfeit' && entry.player_id) {
            if (!(entry.player_id in eliminatedAtIndex)) {
                eliminatedAtIndex[entry.player_id] = idx;
            }
        }
        if (entry.type === 'timeout' && entry.penalty === 'eliminate' && entry.player_id) {
            if (!(entry.player_id in eliminatedAtIndex)) {
                eliminatedAtIndex[entry.player_id] = idx;
            }
        }
        if (entry.eliminations && entry.eliminations.length > 0) {
            for (const pid of entry.eliminations) {
                if (!(pid in eliminatedAtIndex)) {
                    eliminatedAtIndex[pid] = idx;
                }
            }
        }
    });
    
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
        
        // Handle timeout entries
        if (entry.type === 'timeout') {
            div.className = 'history-entry word-change-entry';
            const penalty = entry.penalty || 'skip';
            const icon = penalty === 'eliminate' ? '⏱️💀' : '⏱️';
            const message = penalty === 'eliminate' 
                ? `<strong>${escapeHtml(entry.player_name || 'Operative')}</strong> ran out of time and was eliminated!`
                : `<strong>${escapeHtml(entry.player_name || 'Operative')}</strong> ran out of time. Turn skipped.`;
            div.innerHTML = `
                <div class="word-change-notice">
                    <span class="change-icon">${icon}</span>
                    <span>${message}</span>
                </div>
            `;
            historyLog.appendChild(div);

            // Play elimination feedback for new timeouts that eliminate
            if (originalIdx >= prevHistoryLength && penalty === 'eliminate') {
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
                // Check if this player was already eliminated before this entry
                const playerElimIdx = eliminatedAtIndex[player.id];
                const wasAlreadyEliminated = playerElimIdx !== undefined && originalIdx > playerElimIdx;
                
                // Don't show similarity for players who were already eliminated
                if (wasAlreadyEliminated) return;
                
                const transformedSim = transformSimilarity(sim);
                const simColor = getSimilarityColor(transformedSim);
                // Show raw cosine similarity in nerd mode
                const nerdInfo = optionsState.nerdMode 
                    ? `<span class="nerd-sim" title="Raw cosine similarity">(${sim.toFixed(4)})</span>` 
                    : '';
                simsHtml += `
                    <div class="sim-badge">
                        <span>${escapeHtml(player.name)}</span>
                        <span class="score" style="color: ${simColor}">${escapeHtml((transformedSim * 100).toFixed(0))}%${nerdInfo}</span>
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

// Track selected guess word
let selectedGuessWord = null;

// Guess submit button click handler
document.getElementById('guess-submit-btn').addEventListener('click', async () => {
    await submitGuess();
});

/**
 * Update the guess word grid with theme words
 */
function updateGuessWordGrid(game, isMyTurn, isSpectator) {
    const grid = document.getElementById('guess-word-grid');
    const submitBtn = document.getElementById('guess-submit-btn');
    const selectedDisplay = document.getElementById('guess-selected-word');
    
    if (!grid) return;
    
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
    
    // Check if we can interact
    const canSelect = isMyTurn && !isSpectator && !game.waiting_for_word_change;
    
    // Clear selection if turn changed
    if (!canSelect && selectedGuessWord) {
        selectedGuessWord = null;
    }
    
    // Sort words alphabetically
    const sortedWords = [...allWords].sort();
    
    // Build grid HTML
    grid.innerHTML = '';
    sortedWords.forEach(word => {
        const wordEl = document.createElement('button');
        wordEl.type = 'button';
        wordEl.className = 'guess-word';
        wordEl.textContent = word;
        
        const wordLower = word.toLowerCase();
        
        // Add state classes
        if (wordLower === myWord) {
            wordEl.classList.add('your-word');
            wordEl.disabled = true;
            wordEl.title = 'Your secret word';
        } else if (eliminatedWords.has(wordLower)) {
            wordEl.classList.add('eliminated');
            wordEl.title = 'This word eliminated a player';
        } else if (guessedWords.has(wordLower)) {
            wordEl.classList.add('guessed');
            wordEl.title = 'This word was guessed';
        }
        
        // Selection state
        if (selectedGuessWord && wordLower === selectedGuessWord.toLowerCase()) {
            wordEl.classList.add('selected');
        }
        
        // Interactivity
        if (canSelect && wordLower !== myWord) {
            wordEl.classList.add('selectable');
            wordEl.addEventListener('click', () => {
                // Deselect others
                grid.querySelectorAll('.guess-word').forEach(w => w.classList.remove('selected'));
                // Select this one
                wordEl.classList.add('selected');
                selectedGuessWord = word;
                // Update display
                selectedDisplay.textContent = word.toUpperCase();
                selectedDisplay.classList.add('has-selection');
                submitBtn.disabled = false;
                // Add has-selection to the bar itself
                const selectionBar = document.getElementById('guess-selection-bar');
                if (selectionBar) selectionBar.classList.add('has-selection');
            });
            wordEl.addEventListener('dblclick', () => {
                // Select this word
                grid.querySelectorAll('.guess-word').forEach(w => w.classList.remove('selected'));
                wordEl.classList.add('selected');
                selectedGuessWord = word;
                selectedDisplay.textContent = word.toUpperCase();
                selectedDisplay.classList.add('has-selection');
                submitBtn.disabled = false;
                const selectionBar = document.getElementById('guess-selection-bar');
                if (selectionBar) selectionBar.classList.add('has-selection');
                // Submit the guess
                submitGuess();
            });
        } else {
            wordEl.disabled = !canSelect || wordLower === myWord;
        }
        
        grid.appendChild(wordEl);
    });
    
    // Update selection bar state
    const selectionBar = document.getElementById('guess-selection-bar');
    if (!canSelect) {
        submitBtn.disabled = true;
        if (isSpectator) {
            selectedDisplay.textContent = 'Spectating';
        } else if (game.waiting_for_word_change) {
            selectedDisplay.textContent = 'Waiting...';
        } else {
            selectedDisplay.textContent = 'Not your turn';
        }
        selectedDisplay.classList.remove('has-selection');
        if (selectionBar) selectionBar.classList.remove('has-selection');
    } else if (!selectedGuessWord) {
        submitBtn.disabled = true;
        selectedDisplay.textContent = 'Click a word to guess';
        selectedDisplay.classList.remove('has-selection');
        if (selectionBar) selectionBar.classList.remove('has-selection');
    }
}

async function submitGuess() {
    const submitBtn = document.getElementById('guess-submit-btn');
    const selectedDisplay = document.getElementById('guess-selected-word');
    
    if (!selectedGuessWord) return;
    if (submitBtn.disabled) return;
    
    const word = selectedGuessWord;
    
    // Disable button immediately
    submitBtn.disabled = true;
    selectedDisplay.textContent = 'Submitting...';
    
    // Set flag IMMEDIATELY to prevent timeout race condition
    gameState.isSubmittingGuess = true;
    
    // Play guess effect immediately for responsive feedback
    const guessEffect = cosmeticsState?.userCosmetics?.guess_effect || 'classic';
    const selectionBar = document.getElementById('guess-selection-bar');
    if (selectionBar) {
        // Remove any existing effect classes
        selectionBar.className = selectionBar.className.replace(/guess-\S+/g, '').trim();
        // Add the effect class
        selectionBar.classList.add(`guess-${guessEffect}`);
        // Remove after animation
        setTimeout(() => {
            selectionBar.classList.remove(`guess-${guessEffect}`);
        }, 600);
    }
    
    // Optimistic UI: show pending guess in history immediately
    addPendingGuessToHistory(word, gameState.playerName || 'You');
    
    // Clear selection
    selectedGuessWord = null;
    
    try {
        // Submit guess - server returns updated game state
        const game = await apiCall(`/api/games/${gameState.code}/guess`, 'POST', {
            player_id: gameState.playerId,
            session_token: gameState.sessionToken,
            word,
        });

        // Update with real server state
        removePendingGuessFromHistory();
        updateGame(game);
        
        // Show AI reactions if any (singleplayer)
        if (game.ai_reactions && game.ai_reactions.length > 0) {
            showAiReactions(game.ai_reactions);
        }

        // Then let AIs take their turns
        maybeRunSingleplayerAiTurns(game);
    } catch (error) {
        showError(error.message);
        // Remove pending entry on error and re-fetch state
        removePendingGuessFromHistory();
        try {
            const game = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
            updateGame(game);
        } catch (e) {
            // ignore secondary fetch error
        }
    } finally {
        gameState.isSubmittingGuess = false;
    }
}

/**
 * Show AI reactions (chat messages) with staggered timing
 */
function showAiReactions(reactions) {
    if (!reactions || reactions.length === 0) return;
    
    reactions.forEach((reaction, index) => {
        // Stagger reactions by 400ms each
        setTimeout(() => {
            showAiChatMessage(reaction.ai_name, reaction.message);
        }, index * 400);
    });
}

// Optimistic UI helpers for guess submission
function addPendingGuessToHistory(word, playerName) {
    const historyLog = document.getElementById('history-log');
    if (!historyLog) return;
    
    // Create pending entry at the top (history is shown in reverse)
    const div = document.createElement('div');
    div.className = 'history-entry pending-guess';
    div.id = 'pending-guess-entry';
    div.innerHTML = `
        <div class="header">
            <span class="guesser">${escapeHtml(playerName)}</span>
            <span class="word">"${escapeHtml(word)}"</span>
            <span class="pending-indicator">⏳</span>
        </div>
        <div class="similarities"><span class="pending-text">Calculating...</span></div>
    `;
    historyLog.insertBefore(div, historyLog.firstChild);
}

function removePendingGuessFromHistory() {
    const pending = document.getElementById('pending-guess-entry');
    if (pending) pending.remove();
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
        session_token: gameState.sessionToken,
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
    // Fire and forget - keep UI responsive, pass the game state to avoid re-fetch
    runSingleplayerAiTurns(game).catch(err => console.error('AI runner error:', err));
}

async function runSingleplayerAiTurns(initialGame) {
    if (singleplayerAiRunnerActive) return;
    singleplayerAiRunnerActive = true;

    try {
        // Show thinking message
        const turnText = document.getElementById('turn-text');
        if (turnText) {
            turnText.textContent = 'Bots are playing...';
        }

        // One call processes ALL AI turns until human turn or game over
        const game = await apiCall(`/api/games/${gameState.code}/ai-step`, 'POST', {
            player_id: gameState.playerId,
            session_token: gameState.sessionToken,
        });
        
        if (game.status === 'finished') {
            clearInterval(gameState.pollingInterval);
            showGameOver(game);
        } else {
            updateGame(game);
        }
    } finally {
        singleplayerAiRunnerActive = false;
    }
}

/**
 * Show an AI chat message in the game UI
 */
function showAiChatMessage(aiName, message) {
    if (!message) return;
    
    // Use toast for now, could be enhanced with a proper chat bubble
    const chatEl = document.createElement('div');
    chatEl.className = 'ai-chat-bubble';
    chatEl.innerHTML = `<strong>${aiName}:</strong> ${message}`;
    chatEl.style.cssText = `
        position: fixed;
        bottom: 100px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 8px 16px;
        border-radius: 20px;
        font-size: 14px;
        z-index: 1000;
        animation: fadeInOut 2.5s ease-in-out forwards;
    `;
    
    document.body.appendChild(chatEl);
    
    // Remove after animation
    setTimeout(() => chatEl.remove(), 2500);
}

// Change word - also handle Enter key
document.getElementById('change-word-btn').addEventListener('click', async () => {
    await submitWordChange();
});

// Skip word change button
document.getElementById('skip-word-change-btn').addEventListener('click', async () => {
    const btn = document.getElementById('skip-word-change-btn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Keeping...';
    
    // Set local flag IMMEDIATELY to prevent timeout race condition
    gameState.hasSubmittedWordChange = true;
    
    // Optimistic: hide the change word UI immediately
    document.getElementById('change-word-container')?.classList.add('hidden');
    
    try {
        const game = await apiCall(`/api/games/${gameState.code}/skip-word-change`, 'POST', {
            player_id: gameState.playerId,
            session_token: gameState.sessionToken,
        });
        updateGame(game);
        maybeRunSingleplayerAiTurns(game);
    } catch (error) {
        showError(error.message);
        // Restore UI on error - also reset the flag
        gameState.hasSubmittedWordChange = false;
        document.getElementById('change-word-container')?.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
});

async function submitWordChange() {
    const newWordDisplay = document.getElementById('new-word-display');
    const newWord = newWordDisplay.dataset.word;
    
    if (!newWord) {
        showError('Please select a word');
        return;
    }
    
    const changeBtn = document.getElementById('change-word-btn');
    const originalBtnText = changeBtn?.textContent;
    if (changeBtn) {
        changeBtn.disabled = true;
        changeBtn.textContent = 'Changing...';
    }
    
    // Set local flag IMMEDIATELY to prevent timeout race condition
    gameState.hasSubmittedWordChange = true;
    
    // Optimistic: update secret word display and hide change UI immediately
    document.getElementById('your-secret-word').textContent = newWord.toUpperCase();
    document.getElementById('change-word-container')?.classList.add('hidden');
    newWordDisplay.textContent = 'Click a word above';
    newWordDisplay.dataset.word = '';
    
    try {
        const game = await apiCall(`/api/games/${gameState.code}/change-word`, 'POST', {
            player_id: gameState.playerId,
            session_token: gameState.sessionToken,
            new_word: newWord,
        });
        updateGame(game);
        maybeRunSingleplayerAiTurns(game);
    } catch (error) {
        showError(error.message);
        // Restore UI on error - also reset the flag
        gameState.hasSubmittedWordChange = false;
        // Re-fetch to get correct state
        try {
            const game = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
            updateGame(game);
        } catch (e) {
            // ignore secondary fetch error
        }
    } finally {
        if (changeBtn) {
            changeBtn.disabled = false;
            changeBtn.textContent = originalBtnText;
        }
    }
}

// Screen: Game Over - Cinematic Victory Sequence
function showGameOver(game) {
    showScreen('gameover');
    
    // Refresh daily quests (progress may have updated)
    if (typeof loadDaily === 'function') {
        loadDaily();
    }
    
    // Refresh auth user data to get updated stats (especially for ranked games)
    const savedToken = localStorage.getItem('embeddle_auth_token');
    if (savedToken && typeof loadAuthenticatedUser === 'function') {
        loadAuthenticatedUser(savedToken);
    }
    
    const winner = game.players.find(p => p.id === game.winner);
    const isWinner = game.winner === gameState.playerId;
    const isRanked = Boolean(game.is_ranked);
    
    // Get elements for cinematic sequence
    const gameoverCard = document.querySelector('.gameover-card');
    const trophyIcon = document.getElementById('trophy-icon');
    const titleEl = document.getElementById('gameover-title');
    const msgEl = document.getElementById('gameover-message');
    const revealedWords = document.getElementById('revealed-words');
    const mmrWidget = document.getElementById('mmr-change-widget');
    
    // Reset elements for animation
    if (trophyIcon) {
        trophyIcon.textContent = isWinner ? '🏆' : '🎮';
        trophyIcon.classList.remove('animate');
    }
    if (titleEl) {
        titleEl.textContent = isWinner ? 'Victory!' : 'Game Over!';
        titleEl.classList.remove('animate');
        titleEl.style.opacity = '0';
    }
    if (msgEl) {
        const baseMsg = winner ? `${winner.name} is the last one standing!` : 'The game has ended.';
        msgEl.textContent = baseMsg;
        msgEl.classList.remove('animate');
        msgEl.style.opacity = '0';
    }
    
    // Hide MMR widget initially
    if (mmrWidget) {
        mmrWidget.classList.add('hidden');
        mmrWidget.classList.remove('visible');
    }
    
    // Create spotlight overlay for dramatic effect
    let spotlight = document.querySelector('.victory-spotlight');
    if (!spotlight) {
        spotlight = document.createElement('div');
        spotlight.className = 'victory-spotlight';
        document.body.appendChild(spotlight);
    }
    
    // Build revealed words HTML but keep hidden initially
    revealedWords.innerHTML = '<h3>Secret Words Revealed</h3>';
    const wordItems = [];
    
    game.players.forEach((player, index) => {
        const isWinnerPlayer = player.id === game.winner;
        const isAI = player.is_ai;
        const div = document.createElement('div');
        div.className = `revealed-word-item${isWinnerPlayer ? ' winner' : ''}${!player.is_alive ? ' eliminated' : ''}`;
        div.style.transitionDelay = `${index * 150}ms`;

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

        const clickableClass = !isAI ? 'clickable-profile' : '';
        const dataAttr = !isAI ? `data-player-name="${escapeHtml(player.name)}"` : '';
        
        div.innerHTML = `
            <span class="player-name ${clickableClass}" ${dataAttr}>${escapeHtml(player.name)}${isWinnerPlayer ? ' 👑' : ''}</span>
            <span class="player-word">${escapeHtml(player.secret_word) || '???'}</span>
            ${mmrHtml}
        `;
        
        // Add click handler for profile viewing (non-AI players only)
        if (!isAI) {
            const nameEl = div.querySelector('.clickable-profile');
            if (nameEl) {
                nameEl.addEventListener('click', () => openProfileModal(player.name));
            }
        }
        
        revealedWords.appendChild(div);
        wordItems.push(div);
    });
    
    // ============ CINEMATIC SEQUENCE ============
    
    // Phase 1: Spotlight dims in (100ms)
    setTimeout(() => {
        spotlight.classList.add('visible');
    }, 100);
    
    // Phase 2: Trophy bounces in (300ms)
    setTimeout(() => {
        if (trophyIcon) {
            trophyIcon.classList.add('animate');
        }
    }, 300);
    
    // Phase 3: Title reveals (700ms)
    setTimeout(() => {
        if (titleEl) {
            titleEl.style.opacity = '1';
            titleEl.classList.add('animate');
        }
    }, 700);
    
    // Phase 4: Message reveals (1000ms)
    setTimeout(() => {
        if (msgEl) {
            msgEl.style.opacity = '1';
            msgEl.classList.add('animate');
        }
    }, 1000);
    
    // Phase 5: MMR animation for ranked games (1400ms)
    if (isRanked && mmrWidget) {
        const me = game.players.find(p => p.id === gameState.playerId);
        const mmr = Number(me?.mmr);
        const delta = Number(me?.mmr_delta);
        
        if (Number.isFinite(mmr) && Number.isFinite(delta)) {
            const oldMMR = mmr - delta;
            setTimeout(() => {
                animateMMRChange(oldMMR, mmr, delta);
            }, 1400);
        }
    }
    
    // Phase 6: Victory effect plays (1600ms)
    setTimeout(() => {
        if (isWinner) {
            const victoryEffect = cosmeticsState?.userCosmetics?.victory_effect || 'classic';
            if (typeof playVictoryEffect === 'function') {
                playVictoryEffect(victoryEffect);
            } else {
                createConfetti();
            }
            // Play victory sound
            if (typeof playVictorySfx === 'function') {
                playVictorySfx();
            }
        } else if (winner && winner.cosmetics && winner.cosmetics.victory_effect) {
            if (typeof playVictoryEffect === 'function') {
                playVictoryEffect(winner.cosmetics.victory_effect);
            } else {
                createConfetti();
            }
        }
    }, 1600);
    
    // Phase 7: Secret words reveal one-by-one with stagger (2000ms)
    setTimeout(() => {
        wordItems.forEach((item, index) => {
            setTimeout(() => {
                item.classList.add('revealed');
            }, index * 150);
        });
    }, 2000);
    
    // Phase 8: Fade out spotlight (3500ms)
    setTimeout(() => {
        spotlight.classList.remove('visible');
    }, 3500);
    
    // Pre-generate replay code for sharing (so clipboard write is synchronous on click)
    gameState.cachedReplayCode = null;
    (async () => {
        try {
            const response = await fetch(`${API_BASE}/api/games/${gameState.code}/replay`);
            if (response.ok) {
                const data = await response.json();
                gameState.cachedReplayCode = await encodeReplayData(data);
            }
        } catch (e) {
            console.error('Failed to pre-generate replay code:', e);
        }
    })();
    
    // Generate and display share results
    generateShareResults(game, isWinner);
    
    // Show support prompt for non-donors after 3+ games
    showSupportPromptIfEligible();
}

// Check if user should see support prompt
function showSupportPromptIfEligible() {
    const prompt = document.getElementById('gameover-support-prompt');
    if (!prompt) return;
    
    // Hide by default
    prompt.classList.add('hidden');
    
    // Don't show if user is a donor
    if (gameState.authUser?.is_donor) return;
    
    // Don't show if user dismissed it recently (stored in localStorage)
    const dismissedUntil = localStorage.getItem('support_prompt_dismissed');
    if (dismissedUntil && Date.now() < parseInt(dismissedUntil, 10)) return;
    
    // Show after 3+ games played
    const gamesPlayed = gameState.authUser?.stats?.mp_games_played || 0;
    if (gamesPlayed >= 3) {
        prompt.classList.remove('hidden');
    }
}

// Dismiss support prompt handler
document.getElementById('dismiss-support-prompt')?.addEventListener('click', () => {
    const prompt = document.getElementById('gameover-support-prompt');
    if (prompt) prompt.classList.add('hidden');
    // Don't show again for 7 days
    localStorage.setItem('support_prompt_dismissed', String(Date.now() + 7 * 24 * 60 * 60 * 1000));
});

// Generate share results
function generateShareResults(game, isWinner) {
    const sharePreview = document.getElementById('share-preview');
    if (!sharePreview) return;
    
    const theme = typeof game.theme === 'string' ? game.theme : (game.theme?.name || 'Unknown');
    const turnCount = game.history ? game.history.filter(h => h.type !== 'word_change' && h.type !== 'forfeit').length : 0;
    const totalElimCount = game.history ? game.history.reduce((acc, h) => acc + (h.eliminations?.length || 0), 0) : 0;
    const isRanked = Boolean(game.is_ranked);
    
    // Generate game number (based on date + some uniqueness)
    const gameNum = Math.floor(Date.now() / 86400000) % 10000;
    
    // Count eliminations per player (who caused eliminations)
    const elimsByPlayer = {};
    if (game.history) {
        game.history.forEach(entry => {
            if (entry.eliminations && entry.eliminations.length > 0 && entry.guesser_id) {
                elimsByPlayer[entry.guesser_id] = (elimsByPlayer[entry.guesser_id] || 0) + entry.eliminations.length;
            }
        });
    }
    
    // Build player list with outcomes
    const playerOutcomes = game.players.map(p => ({
        name: p.name,
        isWinner: p.id === game.winner,
        isMe: p.id === gameState.playerId,
        eliminated: !p.is_alive,
        elimCount: elimsByPlayer[p.id] || 0,
        secretWord: p.secret_word || '???',
        mmr: isRanked && Number.isFinite(Number(p?.mmr)) ? Number(p.mmr) : null
    }));
    
    // Sort: winner first, then by elims (descending), then survivors before eliminated
    playerOutcomes.sort((a, b) => {
        if (a.isWinner) return -1;
        if (b.isWinner) return 1;
        if (a.eliminated && !b.eliminated) return 1;
        if (!a.eliminated && b.eliminated) return -1;
        return b.elimCount - a.elimCount;
    });
    
    // Build share text
    const modeLabel = isRanked ? 'RANKED' : 'CASUAL';
    let shareText = `EMBEDDLE #${gameNum} - ${isWinner ? 'Victory!' : 'Defeated'} [${modeLabel}]\n`;
    shareText += `Theme: ${theme} | Turns: ${turnCount} | Elims: ${totalElimCount}\n\n`;
    
    // Add player outcomes
    playerOutcomes.forEach(p => {
        const status = p.isWinner ? '🏆' : (p.eliminated ? '☠️' : '✓');
        const youMarker = p.isMe ? ' (YOU)' : '';
        const elimInfo = p.elimCount > 0 ? ` [${p.elimCount} kill${p.elimCount > 1 ? 's' : ''}]` : '';
        const mmrInfo = p.mmr !== null ? ` (${p.mmr})` : '';
        shareText += `${status} ${p.name}${youMarker}${mmrInfo}${elimInfo} - "${p.secretWord}"\n`;
    });
    
    shareText += `\nembeddle.io`;
    
    // Store for copy/share
    gameState.shareText = shareText;
    
    // Display preview with HTML formatting
    let previewHtml = `<div class="share-header">EMBEDDLE #${gameNum} - ${isWinner ? 'Victory!' : 'Defeated'} [${modeLabel}]</div>`;
    previewHtml += `<div class="share-stats">Theme: ${escapeHtml(theme)} | Turns: ${turnCount} | Elims: ${totalElimCount}</div>`;
    previewHtml += `<div class="share-grid">`;
    
    playerOutcomes.forEach(p => {
        const status = p.isWinner ? '🏆' : (p.eliminated ? '☠️' : '✓');
        const youMarker = p.isMe ? ' (YOU)' : '';
        const elimInfo = p.elimCount > 0 ? ` [${p.elimCount}]` : '';
        const mmrInfo = p.mmr !== null ? ` (${p.mmr})` : '';
        previewHtml += `<div class="share-grid-row">`;
        previewHtml += `<span class="share-grid-blocks">${status}</span>`;
        previewHtml += `<span class="share-grid-player">${escapeHtml(p.name)}${youMarker}${mmrInfo}${elimInfo} - "${escapeHtml(p.secretWord)}"</span>`;
        previewHtml += `</div>`;
    });
    
    previewHtml += `</div>`;
    
    sharePreview.innerHTML = previewHtml;
}

// Copy results to clipboard
document.getElementById('copy-results-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('copy-results-btn');
    if (!gameState.shareText) return;
    
    try {
        await navigator.clipboard.writeText(gameState.shareText);
        btn.textContent = '✓ COPIED';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.textContent = '📋 COPY';
            btn.classList.remove('copied');
        }, 1000);
    } catch (e) {
        console.error('Failed to copy:', e);
        showError('Failed to copy to clipboard');
    }
});

// Share to Twitter/X
document.getElementById('share-twitter-btn')?.addEventListener('click', () => {
    if (!gameState.shareText) return;
    
    const tweetText = encodeURIComponent(gameState.shareText);
    const twitterUrl = `https://twitter.com/intent/tweet?text=${tweetText}`;
    window.open(twitterUrl, '_blank', 'width=550,height=420');
});

// ============ REPLAY VIEWER ============

let replayState = {
    data: null,
    currentTurn: 0,
    isPlaying: false,
    playInterval: null,
};

document.getElementById('watch-replay-btn')?.addEventListener('click', async () => {
    if (!gameState.code) return;
    
    const btn = document.getElementById('watch-replay-btn');
    btn.disabled = true;
    btn.textContent = 'LOADING...';
    
    try {
        const response = await fetch(`${API_BASE}/api/games/${gameState.code}/replay`);
        if (!response.ok) {
            throw new Error('Failed to load replay');
        }
        
        const data = await response.json();
        
        // Encode the replay data and navigate to replay screen
        const replayCode = await encodeReplayData(data);
        history.pushState({}, '', `/replay/${replayCode}`);
        await loadAndShowReplay(replayCode);
    } catch (e) {
        console.error('Failed to load replay:', e);
        showError('Failed to load replay');
    } finally {
        btn.textContent = '🎬 WATCH REPLAY';
        btn.disabled = false;
    }
});

function showReplayModal() {
    const modal = document.getElementById('replay-modal');
    if (!modal || !replayState.data) return;
    
    const data = replayState.data;
    const history = data.history.filter(h => h.type !== 'word_change' && h.type !== 'forfeit');
    
    // Set theme
    document.getElementById('replay-theme').textContent = `Theme: ${data.theme?.name || 'Unknown'}`;
    
    // Set slider max
    const slider = document.getElementById('replay-slider');
    slider.max = history.length;
    slider.value = 0;
    
    // Initial render
    renderReplayState(0);
    
    modal.classList.add('show');
}

function renderReplayState(turnIndex) {
    const data = replayState.data;
    if (!data) return;
    
    const history = data.history.filter(h => h.type !== 'word_change' && h.type !== 'forfeit');
    const playersContainer = document.getElementById('replay-players');
    const turnCounter = document.getElementById('replay-turn-counter');
    const currentTurnEl = document.getElementById('replay-current-turn');
    
    // Calculate player states at this point
    const playerStates = {};
    data.players.forEach(p => {
        playerStates[p.id] = {
            ...p,
            isAlive: true,
            maxSimilarity: 0,
            lastGuess: null,
        };
    });
    
    // Calculate round number (same logic as updateSidebarMeta)
    // A round completes when all alive players have guessed
    const totalPlayers = data.players.length || 1;
    let roundNumber = 1;
    let guessesInCurrentRound = 0;
    let aliveCount = totalPlayers;
    
    // Process history up to current turn
    for (let i = 0; i < turnIndex && i < history.length; i++) {
        const entry = history[i];
        
        // Update similarities
        if (entry.similarities) {
            Object.entries(entry.similarities).forEach(([pid, sim]) => {
                if (playerStates[pid]) {
                    playerStates[pid].maxSimilarity = Math.max(playerStates[pid].maxSimilarity, sim);
                }
            });
        }
        
        // Track round progression
        guessesInCurrentRound++;
        
        // Check eliminations and update alive count
        const eliminations = entry.eliminations || [];
        
        // Mark eliminations in player states
        eliminations.forEach(pid => {
            if (playerStates[pid]) {
                playerStates[pid].isAlive = false;
            }
        });
        
        // Check if round is complete (all alive players before eliminations have guessed)
        const playersBeforeElim = aliveCount;
        aliveCount -= eliminations.length;
        
        if (guessesInCurrentRound >= playersBeforeElim) {
            roundNumber++;
            guessesInCurrentRound = 0;
        }
    }
    
    // Update turn counter to show round number
    turnCounter.textContent = `Round ${roundNumber}`;
    
    // Render player cards
    let playersHtml = '';
    Object.values(playerStates).forEach(p => {
        const transformedSim = transformSimilarity(p.maxSimilarity);
        const simColor = getSimilarityColor(transformedSim);
        const isWinner = p.id === data.winner;
        
        playersHtml += `
            <div class="replay-player ${p.isAlive ? '' : 'eliminated'} ${isWinner ? 'winner' : ''}">
                <div class="replay-player-name">${escapeHtml(p.name)}${isWinner ? ' 🏆' : ''}${!p.isAlive ? ' ☠️' : ''}</div>
                <div class="replay-player-word">${escapeHtml(p.secret_word || '???')}</div>
                <div class="replay-player-danger" style="color: ${simColor}">${Math.round(transformedSim * 100)}%</div>
            </div>
        `;
    });
    playersContainer.innerHTML = playersHtml;
    
    // Show current turn info
    if (turnIndex > 0 && turnIndex <= history.length) {
        const entry = history[turnIndex - 1];
        let turnHtml = `
            <div class="replay-turn-info">
                <span class="replay-guesser">${escapeHtml(entry.guesser_name)}</span>
                <span class="replay-word">"${escapeHtml(entry.word)}"</span>
            </div>
        `;
        
        if (entry.eliminations && entry.eliminations.length > 0) {
            const elimNames = entry.eliminations.map(id => {
                const p = data.players.find(pl => pl.id === id);
                return p ? escapeHtml(p.name) : 'Unknown';
            });
            turnHtml += `<div class="replay-elimination">💥 Eliminated: ${elimNames.join(', ')}</div>`;
        }
        
        currentTurnEl.innerHTML = turnHtml;
    } else {
        currentTurnEl.innerHTML = '<div class="replay-turn-info">Game start</div>';
    }
    
    // Update slider
    document.getElementById('replay-slider').value = turnIndex;
}

// Replay controls
document.getElementById('replay-prev')?.addEventListener('click', () => {
    if (replayState.currentTurn > 0) {
        replayState.currentTurn--;
        renderReplayState(replayState.currentTurn);
    }
});

document.getElementById('replay-next')?.addEventListener('click', () => {
    const history = replayState.data?.history.filter(h => h.type !== 'word_change' && h.type !== 'forfeit') || [];
    if (replayState.currentTurn < history.length) {
        replayState.currentTurn++;
        renderReplayState(replayState.currentTurn);
    }
});

document.getElementById('replay-play')?.addEventListener('click', () => {
    const btn = document.getElementById('replay-play');
    
    if (replayState.isPlaying) {
        // Stop
        clearInterval(replayState.playInterval);
        replayState.isPlaying = false;
        btn.textContent = '▶ PLAY';
    } else {
        // Start
        replayState.isPlaying = true;
        btn.textContent = '⏸ PAUSE';
        
        replayState.playInterval = setInterval(() => {
            const history = replayState.data?.history.filter(h => h.type !== 'word_change' && h.type !== 'forfeit') || [];
            if (replayState.currentTurn < history.length) {
                replayState.currentTurn++;
                renderReplayState(replayState.currentTurn);
            } else {
                // End of replay
                clearInterval(replayState.playInterval);
                replayState.isPlaying = false;
                btn.textContent = '▶ PLAY';
            }
        }, 1500);
    }
});

document.getElementById('replay-slider')?.addEventListener('input', (e) => {
    replayState.currentTurn = parseInt(e.target.value, 10);
    renderReplayState(replayState.currentTurn);
});

document.getElementById('close-replay-btn')?.addEventListener('click', () => {
    const modal = document.getElementById('replay-modal');
    if (modal) modal.classList.remove('show');
    
    // Stop playback
    if (replayState.playInterval) {
        clearInterval(replayState.playInterval);
    }
    replayState.isPlaying = false;
    document.getElementById('replay-play').textContent = '▶ PLAY';
});

// Share replay button (game over screen)
document.getElementById('share-replay-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('share-replay-btn');
    
    // Use cached code if available (synchronous clipboard write preserves user activation)
    if (gameState.cachedReplayCode) {
        const replayLink = getReplayLink(gameState.cachedReplayCode);
        try {
            await navigator.clipboard.writeText(replayLink);
            showToast('Replay link copied!');
        } catch (e) {
            // Fallback
            const input = document.createElement('input');
            input.value = replayLink;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
            showToast('Replay link copied!');
        }
        return;
    }
    
    // Fallback to fetching if not cached (existing behavior)
    if (!gameState.code) return;
    
    btn.disabled = true;
    btn.textContent = 'GENERATING...';
    
    try {
        // Fetch replay data from API
        const response = await fetch(`${API_BASE}/api/games/${gameState.code}/replay`);
        if (!response.ok) {
            throw new Error('Failed to load replay');
        }
        
        const data = await response.json();
        
        // Encode the replay data
        const replayCode = await encodeReplayData(data);
        const replayLink = getReplayLink(replayCode);
        
        // Copy to clipboard
        try {
            await navigator.clipboard.writeText(replayLink);
            showToast('Replay link copied!');
        } catch (e) {
            // Fallback
            const input = document.createElement('input');
            input.value = replayLink;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
            showToast('Replay link copied!');
        }
    } catch (e) {
        console.error('Failed to share replay:', e);
        showError('Failed to generate replay link');
    } finally {
        btn.textContent = '🔗 SHARE REPLAY';
        btn.disabled = false;
    }
});

// Home screen replay input
document.getElementById('home-replay-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('home-replay-input');
    const code = input?.value?.trim();
    if (!code) {
        showError('Please enter a replay code');
        return;
    }
    
    history.pushState({}, '', `/replay/${code}`);
    await loadAndShowReplay(code);
});

// Allow pressing Enter in the home replay input
document.getElementById('home-replay-input')?.addEventListener('keypress', async (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('home-replay-btn')?.click();
    }
});

// ============ REPLAY ENCODING/DECODING ============

/**
 * Compress a string using deflate (via CompressionStream or fallback)
 * @param {string} str - The string to compress
 * @returns {Promise<Uint8Array>} - Compressed bytes
 */
async function compressString(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    
    // Use native CompressionStream if available
    if (typeof CompressionStream !== 'undefined') {
        const cs = new CompressionStream('deflate');
        const writer = cs.writable.getWriter();
        writer.write(data);
        writer.close();
        
        const chunks = [];
        const reader = cs.readable.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        
        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }
    
    // Fallback: simple base64 without compression
    return data;
}

/**
 * Decompress bytes using inflate (via DecompressionStream or fallback)
 * @param {Uint8Array} data - The compressed bytes
 * @returns {Promise<string>} - Decompressed string
 */
async function decompressBytes(data) {
    // Use native DecompressionStream if available
    if (typeof DecompressionStream !== 'undefined') {
        try {
            const ds = new DecompressionStream('deflate');
            const writer = ds.writable.getWriter();
            writer.write(data);
            writer.close();
            
            const chunks = [];
            const reader = ds.readable.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
            
            const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }
            
            const decoder = new TextDecoder();
            return decoder.decode(result);
        } catch (e) {
            // Fall through to uncompressed fallback
        }
    }
    
    // Fallback: assume uncompressed
    const decoder = new TextDecoder();
    return decoder.decode(data);
}

/**
 * Encode bytes to base64url (URL-safe base64)
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    // Convert to base64url: replace + with -, / with _, remove padding =
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode base64url to bytes
 * @param {string} str
 * @returns {Uint8Array}
 */
function base64urlToBytes(str) {
    // Convert from base64url: replace - with +, _ with /
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    // Add padding if needed
    while (base64.length % 4) {
        base64 += '=';
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * Encode replay data to a shareable code
 * @param {Object} replayData - The replay data object
 * @returns {Promise<string>} - The encoded replay code
 */
async function encodeReplayData(replayData) {
    // Minimize the data structure for smaller codes
    const minimal = {
        t: replayData.theme?.name || '', // theme name
        p: (replayData.players || []).map(p => ({
            i: p.id,
            n: p.name,
            w: p.secret_word,
            a: p.is_ai ? 1 : 0,
            c: p.cosmetics || {},
        })),
        h: (replayData.history || []).map(h => {
            if (h.type === 'word_change') return { x: 'c', p: h.player_id };
            if (h.type === 'forfeit') return { x: 'f', p: h.player_id, w: h.word };
            return {
                g: h.guesser_id,
                w: h.word,
                s: h.similarities || {},
                e: h.eliminations || [],
            };
        }),
        w: replayData.winner, // winner id
        r: replayData.is_ranked ? 1 : 0,
    };
    
    const json = JSON.stringify(minimal);
    const compressed = await compressString(json);
    return bytesToBase64url(compressed);
}

/**
 * Decode a replay code back to replay data
 * @param {string} code - The encoded replay code
 * @returns {Promise<Object|null>} - The decoded replay data, or null if invalid
 */
async function decodeReplayData(code) {
    try {
        const bytes = base64urlToBytes(code);
        const json = await decompressBytes(bytes);
        const minimal = JSON.parse(json);
        
        // Build player map for name lookups
        const playerMap = {};
        const players = (minimal.p || []).map(p => {
            const player = {
                id: p.i,
                name: p.n,
                secret_word: p.w,
                is_ai: p.a === 1,
                cosmetics: p.c || {},
            };
            playerMap[p.i] = player;
            return player;
        });
        
        // Reconstruct history
        const history = (minimal.h || []).map(h => {
            if (h.x === 'c') return { type: 'word_change', player_id: h.p };
            if (h.x === 'f') return { type: 'forfeit', player_id: h.p, word: h.w };
            return {
                guesser_id: h.g,
                guesser_name: playerMap[h.g]?.name || 'Unknown',
                word: h.w,
                similarities: h.s || {},
                eliminations: h.e || [],
            };
        });
        
        return {
            theme: { name: minimal.t },
            players,
            history,
            winner: minimal.w,
            is_ranked: minimal.r === 1,
        };
    } catch (e) {
        console.error('Failed to decode replay:', e);
        return null;
    }
}

/**
 * Generate a shareable replay link
 * @param {string} replayCode
 * @returns {string}
 */
function getReplayLink(replayCode) {
    return `${window.location.origin}/replay/${replayCode}`;
}

/**
 * Get replay code from URL if on a /replay/ route
 * @returns {string|null}
 */
function getReplayCodeFromURL() {
    const match = window.location.pathname.match(/^\/replay\/(.+)$/);
    return match ? match[1] : null;
}

// ============ REPLAY SCREEN ============

let replayScreenState = {
    data: null,
    code: null,
    currentTurn: 0,
    isPlaying: false,
    playInterval: null,
};

/**
 * Stop replay playback
 */
function stopReplayPlayback() {
    if (replayScreenState.playInterval) {
        clearInterval(replayScreenState.playInterval);
        replayScreenState.playInterval = null;
    }
    replayScreenState.isPlaying = false;
    const playBtn = document.getElementById('replay-screen-play');
    if (playBtn) playBtn.textContent = '▶ PLAY';
}

/**
 * Load and show replay from a code
 * @param {string} code - The encoded replay code
 */
async function loadAndShowReplay(code) {
    try {
        const data = await decodeReplayData(code);
        if (!data) {
            showError('Invalid replay code');
            history.replaceState({}, '', '/');
            showScreen('home');
            return;
        }
        
        replayScreenState.data = data;
        replayScreenState.code = code;
        replayScreenState.currentTurn = 0;
        stopReplayPlayback();
        
        showScreen('replay');
        renderReplayScreen(0);
    } catch (e) {
        console.error('Failed to load replay:', e);
        showError('Failed to load replay');
        history.replaceState({}, '', '/');
        showScreen('home');
    }
}

/**
 * Render the replay screen at a specific turn
 * @param {number} turnIndex
 */
function renderReplayScreen(turnIndex) {
    const data = replayScreenState.data;
    if (!data) return;
    
    const history = data.history.filter(h => h.type !== 'word_change' && h.type !== 'forfeit');
    
    // Update theme
    const themeEl = document.getElementById('replay-screen-theme');
    if (themeEl) themeEl.textContent = `Theme: ${data.theme?.name || 'Unknown'}`;
    
    // Update slider
    const slider = document.getElementById('replay-screen-slider');
    if (slider) {
        slider.max = history.length;
        slider.value = turnIndex;
    }
    
    // Calculate player states at this point
    const playerStates = {};
    data.players.forEach(p => {
        playerStates[p.id] = {
            ...p,
            isAlive: true,
            maxSimilarity: 0,
            lastSimilarity: 0,
        };
    });
    
    // Calculate round number (same logic as updateSidebarMeta)
    // A round completes when all alive players have guessed
    const totalPlayers = data.players.length || 1;
    let roundNumber = 1;
    let guessesInCurrentRound = 0;
    let aliveCount = totalPlayers;
    
    // Process history up to current turn
    for (let i = 0; i < turnIndex && i < history.length; i++) {
        const entry = history[i];
        
        // Update similarities
        if (entry.similarities) {
            Object.entries(entry.similarities).forEach(([pid, sim]) => {
                if (playerStates[pid]) {
                    playerStates[pid].maxSimilarity = Math.max(playerStates[pid].maxSimilarity, sim);
                    playerStates[pid].lastSimilarity = sim;
                }
            });
        }
        
        // Track round progression
        guessesInCurrentRound++;
        
        // Check eliminations and update alive count
        const eliminations = entry.eliminations || [];
        
        // Mark eliminations in player states
        eliminations.forEach(pid => {
            if (playerStates[pid]) {
                playerStates[pid].isAlive = false;
            }
        });
        
        // Check if round is complete (all alive players before eliminations have guessed)
        const playersBeforeElim = aliveCount;
        aliveCount -= eliminations.length;
        
        if (guessesInCurrentRound >= playersBeforeElim) {
            roundNumber++;
            guessesInCurrentRound = 0;
        }
    }
    
    // Update turn counter to show round number
    const turnCounter = document.getElementById('replay-screen-turn-counter');
    if (turnCounter) turnCounter.textContent = `Round ${roundNumber}`;
    
    // Render player cards
    const playersContainer = document.getElementById('replay-screen-players');
    if (playersContainer) {
        let playersHtml = '';
        Object.values(playerStates).forEach(p => {
            const transformedSim = transformSimilarity(p.maxSimilarity);
            const simColor = getSimilarityColor(transformedSim);
            const isWinner = p.id === data.winner;
            
            playersHtml += `
                <div class="replay-screen-player ${p.isAlive ? '' : 'eliminated'} ${isWinner ? 'winner' : ''}">
                    <div class="replay-screen-player-name">
                        ${escapeHtml(p.name)}${isWinner ? ' 🏆' : ''}${!p.isAlive ? ' ☠️' : ''}
                        ${p.is_ai ? ' 🤖' : ''}
                    </div>
                    <div class="replay-screen-player-word">${escapeHtml(p.secret_word || '???')}</div>
                    <div class="replay-screen-player-danger" style="color: ${simColor}">${Math.round(transformedSim * 100)}%</div>
                </div>
            `;
        });
        playersContainer.innerHTML = playersHtml;
    }
    
    // Show current turn info
    const currentTurnEl = document.getElementById('replay-screen-current-turn');
    if (currentTurnEl) {
        if (turnIndex > 0 && turnIndex <= history.length) {
            const entry = history[turnIndex - 1];
            let turnHtml = `
                <div class="replay-turn-info">
                    <span class="replay-guesser">${escapeHtml(entry.guesser_name || 'Unknown')}</span>
                    <span class="replay-word">"${escapeHtml(entry.word)}"</span>
                </div>
            `;
            
            if (entry.eliminations && entry.eliminations.length > 0) {
                const elimNames = entry.eliminations.map(id => {
                    const p = data.players.find(pl => pl.id === id);
                    return p ? escapeHtml(p.name) : 'Unknown';
                });
                turnHtml += `<div class="replay-elimination">💥 Eliminated: ${elimNames.join(', ')}</div>`;
            }
            
            currentTurnEl.innerHTML = turnHtml;
        } else {
            currentTurnEl.innerHTML = '<div class="replay-turn-info">Game start</div>';
        }
    }
    
    replayScreenState.currentTurn = turnIndex;
}

// Replay screen event listeners
document.getElementById('replay-screen-prev')?.addEventListener('click', () => {
    if (replayScreenState.currentTurn > 0) {
        replayScreenState.currentTurn--;
        renderReplayScreen(replayScreenState.currentTurn);
    }
});

document.getElementById('replay-screen-next')?.addEventListener('click', () => {
    const history = replayScreenState.data?.history.filter(h => h.type !== 'word_change' && h.type !== 'forfeit') || [];
    if (replayScreenState.currentTurn < history.length) {
        replayScreenState.currentTurn++;
        renderReplayScreen(replayScreenState.currentTurn);
    }
});

document.getElementById('replay-screen-play')?.addEventListener('click', () => {
    const btn = document.getElementById('replay-screen-play');
    
    if (replayScreenState.isPlaying) {
        stopReplayPlayback();
    } else {
        replayScreenState.isPlaying = true;
        btn.textContent = '⏸ PAUSE';
        
        replayScreenState.playInterval = setInterval(() => {
            const history = replayScreenState.data?.history.filter(h => h.type !== 'word_change' && h.type !== 'forfeit') || [];
            if (replayScreenState.currentTurn < history.length) {
                replayScreenState.currentTurn++;
                renderReplayScreen(replayScreenState.currentTurn);
            } else {
                stopReplayPlayback();
            }
        }, 1500);
    }
});

document.getElementById('replay-screen-slider')?.addEventListener('input', (e) => {
    replayScreenState.currentTurn = parseInt(e.target.value, 10);
    renderReplayScreen(replayScreenState.currentTurn);
});

document.getElementById('replay-back-btn')?.addEventListener('click', () => {
    stopReplayPlayback();
    history.pushState({}, '', '/');
    showScreen('home');
});

// Copy replay link
document.getElementById('replay-copy-link-btn')?.addEventListener('click', async () => {
    const code = replayScreenState.code;
    if (!code) return;
    
    const link = getReplayLink(code);
    try {
        await navigator.clipboard.writeText(link);
        showToast('Replay link copied!');
    } catch (e) {
        // Fallback
        const input = document.createElement('input');
        input.value = link;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        showToast('Replay link copied!');
    }
});

// Copy replay code
document.getElementById('replay-copy-code-btn')?.addEventListener('click', async () => {
    const code = replayScreenState.code;
    if (!code) return;
    
    try {
        await navigator.clipboard.writeText(code);
        showToast('Replay code copied!');
    } catch (e) {
        // Fallback
        const input = document.createElement('input');
        input.value = code;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        showToast('Replay code copied!');
    }
});

// Load replay from input
document.getElementById('replay-load-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('replay-load-input');
    const code = input?.value?.trim();
    if (!code) {
        showError('Please enter a replay code');
        return;
    }
    
    history.pushState({}, '', `/replay/${code}`);
    await loadAndShowReplay(code);
});

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
    stopPolling();
    clearGameSession();
    gameState.code = null;
    gameState.playerId = null;
    gameState.cachedReplayCode = null;
    gameState.lastGameMode = null;
    showScreen('home');
    loadLobbies();
});

// Play Again button - smart mode detection
document.getElementById('play-again-btn')?.addEventListener('click', playAgain);

async function playAgain() {
    const btn = document.getElementById('play-again-btn');
    const originalText = btn?.textContent;
    
    // Show loading state
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'JOINING...';
    }
    
    try {
        // Determine game mode from last game
        const lastGame = gameState.game;
        const wasRanked = lastGame?.is_ranked;
        const wasSingleplayer = gameState.isSingleplayer;
        
        // Clean up current game state
        stopPolling();
        clearGameSession();
        gameState.code = null;
        gameState.playerId = null;
        gameState.cachedReplayCode = null;
        
        if (wasSingleplayer) {
            // Start new singleplayer game
            await startSingleplayer();
        } else if (wasRanked && gameState.authToken) {
            // Queue for ranked if eligible
            await quickPlay({ ranked: true });
        } else {
            // Default to casual quick play
            await quickPlay({ ranked: false });
        }
    } catch (error) {
        showError(error.message || 'Failed to start new game');
        // Restore button state on error
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }
}

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
            const payload = {
                player_id: playerId,
                session_token: gameState.sessionToken,
            };
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
        playersList.innerHTML = (game.players || []).map(p => {
            const isAI = p.is_ai;
            const clickableClass = !isAI ? 'clickable-profile' : '';
            const dataAttr = !isAI ? `data-player-name="${escapeHtml(p.name)}"` : '';
            return `
                <div class="lobby-player ${p.id === game.host_id ? 'host' : ''}">
                    <span class="player-name ${clickableClass}" ${dataAttr}>${escapeHtml(p.name)}</span>
                    ${p.id === game.host_id ? '<span class="host-badge">HOST</span>' : ''}
                </div>
            `;
        }).join('');
        
        // Add click handlers for profile viewing (non-AI players only)
        playersList.querySelectorAll('.clickable-profile').forEach(el => {
            el.addEventListener('click', () => {
                const name = el.dataset.playerName;
                if (name) openProfileModal(name);
            });
        });
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
        // 404 means game ended/expired - this is expected, go back to home
        if (e.status === 404) {
            stopPolling();
            showScreen('home');
            showInfo('Game has ended');
            return;
        }
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
    let sessionToken = null;  // SECURITY: Session token for game actions
    let playerName = gameState.playerName;
    let isSingleplayer = false;
    
    if (savedSession) {
        // If URL has a code, use it but check if saved session matches
        if (urlCode && savedSession.code === urlCode) {
            playerId = savedSession.playerId;
            sessionToken = savedSession.sessionToken;  // SECURITY: Restore session token
            playerName = savedSession.playerName || playerName;
            isSingleplayer = savedSession.isSingleplayer || false;
        } else if (!urlCode) {
            // No URL code, use saved session
            code = savedSession.code;
            playerId = savedSession.playerId;
            sessionToken = savedSession.sessionToken;  // SECURITY: Restore session token
            playerName = savedSession.playerName || playerName;
            isSingleplayer = savedSession.isSingleplayer || false;
        }
    }

    // If we have a URL code but no active session, try to restore from recent games
    if (urlCode && !playerId) {
        const recent = recentGames.find(r => r.code === urlCode);
        if (recent) {
            playerId = recent.playerId || playerId;
            sessionToken = recent.sessionToken || sessionToken;  // SECURITY: Restore session token
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
        gameState.sessionToken = sessionToken;  // SECURITY: Restore session token
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

// Check for challenge URL first, then try to rejoin existing game
async function initializeApp() {
    // Check for replay URL first
    const replayCode = getReplayCodeFromURL();
    if (replayCode) {
        await loadAndShowReplay(replayCode);
        return;
    }
    
    // Check for challenge URL
    const challengeId = getChallengeIdFromURL();
    if (challengeId) {
        const handled = await handleChallengeURL();
        if (handled) return;
    }
    
    // Try to rejoin existing game
    const rejoined = await attemptRejoin();
    if (!rejoined) {
        showScreen('home');
    }
}

// Clean up queue when leaving the page
window.addEventListener('beforeunload', () => {
    if (gameState.queueMode && gameState.queuePlayerId) {
        // Use sendBeacon for reliable delivery during page unload
        const data = JSON.stringify({
            mode: gameState.queueMode,
            player_id: gameState.queuePlayerId,
        });
        navigator.sendBeacon('/api/queue/leave', data);
    }
});

initializeApp();
