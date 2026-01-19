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

// Volume state (0-100 scale from UI, converted to 0-1 internally)
let musicVolume = 12;  // Default 12%
let sfxVolume = 50;    // Default 50%

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
 * Get effective SFX volume (0-1 scale)
 * @returns {number}
 */
function getEffectiveSfxVolume() {
    return sfxVolume / 100;
}

/**
 * Play a synthesized tone
 * @param {Object} options - Tone options
 */
export function playTone({ freq = 800, durationMs = 40, type = 'square', volume = 0.04 } = {}) {
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

/**
 * Play elimination sound effect
 */
export function playEliminationSfx() {
    if (getEffectiveSfxVolume() <= 0) return;
    resumeSfxContext();
    playTone({ freq: 140, durationMs: 90, type: 'sawtooth', volume: 0.05 });
    setTimeout(() => playTone({ freq: 90, durationMs: 110, type: 'sawtooth', volume: 0.04 }), 60);
}

/**
 * Play victory sound effect - triumphant ascending tones
 */
export function playVictorySfx() {
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

/**
 * Play quest complete sound effect - satisfying ding
 */
export function playQuestCompleteSfx() {
    if (getEffectiveSfxVolume() <= 0) return;
    resumeSfxContext();
    // Two-tone satisfying ding
    playTone({ freq: 880, durationMs: 80, type: 'sine', volume: 0.05 });
    setTimeout(() => {
        playTone({ freq: 1320, durationMs: 150, type: 'sine', volume: 0.06 });
    }, 60);
}

/**
 * Play rank up sound effect - fanfare-like sequence
 */
export function playRankUpSfx() {
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

/**
 * Play MMR change sound effect
 * @param {boolean} isGain - Whether MMR increased (true) or decreased (false)
 */
export function playMMRChangeSfx(isGain) {
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

/**
 * Play turn notification sound effect - attention-grabbing but pleasant chime
 */
export function playTurnNotificationSfx() {
    if (getEffectiveSfxVolume() <= 0) return;
    resumeSfxContext();
    // Two-note attention chime (like a doorbell or notification)
    playTone({ freq: 587, durationMs: 120, type: 'sine', volume: 0.06 }); // D5
    setTimeout(() => {
        playTone({ freq: 880, durationMs: 180, type: 'sine', volume: 0.07 }); // A5
    }, 100);
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
 * Set music volume (0-100)
 * @param {number} volume - Volume level 0-100
 */
export function setMusicVolume(volume) {
    musicVolume = Math.max(0, Math.min(100, Number(volume) || 0));
    if (bgmAudio) {
        // Combine user volume with config base volume
        bgmAudio.volume = clamp01((musicVolume / 100) * bgmConfig.volume * (100 / 12));
    }
}

/**
 * Get current music volume (0-100)
 * @returns {number}
 */
export function getMusicVolume() {
    return musicVolume;
}

/**
 * Set SFX volume (0-100)
 * @param {number} volume - Volume level 0-100
 */
export function setSfxVolume(volume) {
    sfxVolume = Math.max(0, Math.min(100, Number(volume) || 0));
}

/**
 * Get current SFX volume (0-100)
 * @returns {number}
 */
export function getSfxVolume() {
    return sfxVolume;
}

/**
 * Initialize and start background music
 * @param {number} volume - Music volume 0-100
 */
export async function startBackgroundMusic(volume) {
    // Update volume state
    if (typeof volume === 'number') {
        musicVolume = Math.max(0, Math.min(100, volume));
    }
    
    if (bgmInitStarted) {
        // Just update volume if already initialized
        if (bgmAudio) {
            bgmAudio.volume = clamp01((musicVolume / 100) * bgmConfig.volume * (100 / 12));
            if (musicVolume > 0 && bgmAudio.paused && hasUserActivation()) {
                try { await bgmAudio.play(); } catch (e) {}
            } else if (musicVolume <= 0) {
                bgmAudio.pause();
            }
        }
        return;
    }
    bgmInitStarted = true;

    if (!bgmConfig.enabled) return;

    try {
        bgmAudio = new Audio(bgmConfig.track);
        bgmAudio.loop = true;
        bgmAudio.volume = clamp01((musicVolume / 100) * bgmConfig.volume * (100 / 12));
        bgmAudio.preload = 'auto';

        const tryPlay = async () => {
            if (musicVolume <= 0) return;
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
 * Apply music volume preference
 * @param {number} volume - Music volume 0-100
 */
export async function applyMusicPreference(volume) {
    if (typeof volume === 'number') {
        musicVolume = Math.max(0, Math.min(100, volume));
    }
    
    if (!bgmInitStarted) {
        await startBackgroundMusic(musicVolume);
        return;
    }
    if (!bgmAudio) return;
    
    // Update volume
    bgmAudio.volume = clamp01((musicVolume / 100) * bgmConfig.volume * (100 / 12));
    
    if (bgmConfig.enabled && musicVolume > 0) {
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
