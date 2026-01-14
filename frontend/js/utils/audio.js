/**
 * Audio Utilities
 * Sound effects and background music management
 */

// Audio state
let bgmAudio = null;
let bgmConfig = {
    enabled: true,
    track: '/manwithaplan.mp3',
    volume: 0.12,
};
let bgmInitStarted = false;
let sfxAudioCtx = null;

/**
 * Clamp a number between 0 and 1
 * @param {number} n
 * @returns {number}
 */
function clamp01(n) {
    if (typeof n !== 'number' || Number.isNaN(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

/**
 * Check if browser has user activation
 * @returns {boolean}
 */
function hasUserActivation() {
    try {
        const ua = navigator.userActivation;
        return Boolean(ua && (ua.isActive || ua.hasBeenActive));
    } catch (e) {
        return false;
    }
}

/**
 * Get or create AudioContext for SFX
 * @returns {AudioContext|null}
 */
function getSfxContext() {
    if (sfxAudioCtx) return sfxAudioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    sfxAudioCtx = new Ctx();
    return sfxAudioCtx;
}

/**
 * Resume SFX AudioContext if suspended
 */
export async function resumeSfxContext() {
    const ctx = getSfxContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (e) {}
    }
}

/**
 * Play a synthesized tone
 * @param {Object} options - Tone options
 */
export function playTone({ freq = 800, durationMs = 40, type = 'square', volume = 0.04 } = {}) {
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

/**
 * Play click sound effect
 * @param {boolean} enabled - Whether click SFX is enabled
 */
export function playClickSfx(enabled) {
    if (!enabled) return;
    resumeSfxContext();
    playTone({ freq: 880, durationMs: 28, type: 'square', volume: 0.03 });
}

/**
 * Play elimination sound effect
 * @param {boolean} enabled - Whether elimination SFX is enabled
 */
export function playEliminationSfx(enabled) {
    if (!enabled) return;
    resumeSfxContext();
    playTone({ freq: 140, durationMs: 90, type: 'sawtooth', volume: 0.05 });
    setTimeout(() => playTone({ freq: 90, durationMs: 110, type: 'sawtooth', volume: 0.04 }), 60);
}

/**
 * Set BGM configuration
 * @param {Object} config - BGM config from server
 */
export function setBgmConfig(config) {
    if (config) {
        bgmConfig = {
            enabled: config.enabled !== false,
            track: typeof config.track === 'string' ? config.track : bgmConfig.track,
            volume: clamp01(Number(config.volume ?? bgmConfig.volume)),
        };
    }
}

/**
 * Get current BGM config
 * @returns {Object}
 */
export function getBgmConfig() {
    return { ...bgmConfig };
}

/**
 * Check if BGM has been initialized
 * @returns {boolean}
 */
export function isBgmInitialized() {
    return bgmInitStarted;
}

/**
 * Initialize and start background music
 * @param {boolean} musicEnabled - Whether user has music enabled
 */
export async function startBackgroundMusic(musicEnabled) {
    if (bgmInitStarted) return;
    bgmInitStarted = true;

    if (!bgmConfig.enabled) return;

    try {
        bgmAudio = new Audio(bgmConfig.track);
        bgmAudio.loop = true;
        bgmAudio.volume = clamp01(bgmConfig.volume);
        bgmAudio.preload = 'auto';

        const tryPlay = async () => {
            if (!musicEnabled) return;
            try {
                await bgmAudio.play();
            } catch (err) {
                // Autoplay may be blocked
            }
        };

        const resume = () => {
            tryPlay();
        };
        window.addEventListener('pointerdown', resume, { once: true, capture: true });
        window.addEventListener('keydown', resume, { once: true, capture: true });
        window.addEventListener('touchstart', resume, { once: true, capture: true });

        if (hasUserActivation()) {
            await tryPlay();
        }
    } catch (e) {
        console.warn('Background music init failed:', e);
    }
}

/**
 * Apply music preference (play/pause)
 * @param {boolean} musicEnabled - Whether user has music enabled
 */
export async function applyMusicPreference(musicEnabled) {
    if (!bgmInitStarted) {
        await startBackgroundMusic(musicEnabled);
    }
    if (!bgmAudio) return;
    
    if (bgmConfig.enabled && musicEnabled) {
        if (hasUserActivation()) {
            try {
                await bgmAudio.play();
            } catch (e) {
                // Autoplay may still be blocked
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

