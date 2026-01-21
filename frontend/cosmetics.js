/**
 * EMBEDDLE - Cosmetics System (Simplified)
 * Theme colors and badges only - non-intrusive customization
 */

// API base URL
const API_BASE = window.location.origin;

// Cosmetics state
let cosmeticsState = {
    catalog: null,
    userCosmetics: null,
    isDonor: false,
    isAdmin: false,
    paywallEnabled: false,
    unlockAll: false,
    panelOpen: false,
    customColor: null,
};

// ============ COSMETICS CATALOG ============

async function loadCosmeticsCatalog() {
    try {
        const response = await fetch(`${API_BASE}/api/cosmetics`);
        if (response.ok) {
            const data = await response.json();
            cosmeticsState.catalog = data.catalog;
            cosmeticsState.paywallEnabled = Boolean(data.paywall_enabled);
            cosmeticsState.unlockAll = Boolean(data.unlock_all);
        }
    } catch (e) {
        console.error('Failed to load cosmetics catalog:', e);
    }
}

async function loadUserCosmetics() {
    if (typeof gameState === 'undefined' || !gameState.authToken) return;
    try {
        const response = await fetch(`${API_BASE}/api/user/cosmetics`, {
            headers: { 'Authorization': `Bearer ${gameState.authToken}` }
        });
        if (response.ok) {
            const data = await response.json();
            cosmeticsState.userCosmetics = data.cosmetics;
            cosmeticsState.isDonor = data.is_donor;
            cosmeticsState.isAdmin = data.is_admin;
            if (typeof data.paywall_enabled === 'boolean') {
                cosmeticsState.paywallEnabled = data.paywall_enabled;
            }
            if (typeof data.unlock_all === 'boolean') {
                cosmeticsState.unlockAll = data.unlock_all;
            }
            applyThemeColor();
            updateCosmeticsPreview();
        }
    } catch (e) {
        console.error('Failed to load user cosmetics:', e);
    }
}

async function equipCosmetic(category, cosmeticId) {
    if (typeof gameState === 'undefined' || !gameState.authToken) {
        showError('Sign in with Google to customize');
        return false;
    }
    try {
        const response = await fetch(`${API_BASE}/api/cosmetics/equip`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${gameState.authToken}`
            },
            body: JSON.stringify({ category, cosmetic_id: cosmeticId })
        });
        if (response.ok) {
            const data = await response.json();
            cosmeticsState.userCosmetics = data.cosmetics;
            applyThemeColor();
            updateCosmeticsPanel();
            updateCosmeticsPreview();
            return true;
        } else {
            const err = await response.json();
            showError(err.detail || 'Failed to equip');
            return false;
        }
    } catch (e) {
        console.error('Failed to equip cosmetic:', e);
        return false;
    }
}

// Save custom hex color
async function saveCustomColor(hexColor) {
    if (typeof gameState === 'undefined' || !gameState.authToken) {
        showError('Sign in to save custom color');
        return false;
    }
    try {
        const response = await fetch(`${API_BASE}/api/cosmetics/custom-color`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${gameState.authToken}`
            },
            body: JSON.stringify({ hex_color: hexColor })
        });
        if (response.ok) {
            cosmeticsState.customColor = hexColor;
            applyThemeColor(hexColor);
            return true;
        }
    } catch (e) {
        console.error('Failed to save custom color:', e);
    }
    return false;
}

// ============ THEME COLOR APPLICATION ============

function applyThemeColor(overrideColor = null) {
    const c = cosmeticsState.userCosmetics || {};
    const catalog = cosmeticsState.catalog;
    
    let hexColor = '#00cc88'; // Default
    
    if (overrideColor) {
        hexColor = overrideColor;
    } else if (c.theme_color && catalog?.theme_colors) {
        const themeData = catalog.theme_colors[c.theme_color];
        if (themeData?.hex) {
            hexColor = themeData.hex;
        } else if (c.theme_color === 'custom' && c.custom_hex) {
            hexColor = c.custom_hex;
        }
    }
    
    // Parse hex to RGB
    const rgb = hexToRgb(hexColor);
    const dimColor = adjustBrightness(hexColor, -30);
    
    // Apply to CSS variables
    document.documentElement.style.setProperty('--user-accent', hexColor);
    document.documentElement.style.setProperty('--user-accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    document.documentElement.style.setProperty('--user-accent-dim', dimColor);
    document.documentElement.style.setProperty('--user-accent-glow', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.25)`);
}

function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : { r: 0, g: 204, b: 136 };
}

function adjustBrightness(hex, percent) {
    const rgb = hexToRgb(hex);
    const adjust = (val) => Math.max(0, Math.min(255, Math.round(val * (1 + percent / 100))));
    const r = adjust(rgb.r).toString(16).padStart(2, '0');
    const g = adjust(rgb.g).toString(16).padStart(2, '0');
    const b = adjust(rgb.b).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
}

// ============ COSMETICS PANEL UI ============

function toggleCosmeticsPanel() {
    cosmeticsState.panelOpen = !cosmeticsState.panelOpen;
    const panel = document.getElementById('cosmetics-panel');
    if (panel) {
        panel.classList.toggle('open', cosmeticsState.panelOpen);
    }
    if (cosmeticsState.panelOpen) {
        updateCosmeticsPanel();
    }
}

function closeCosmeticsPanel() {
    cosmeticsState.panelOpen = false;
    const panel = document.getElementById('cosmetics-panel');
    if (panel) panel.classList.remove('open');
}

function updateCosmeticsPanel() {
    const panel = document.getElementById('cosmetics-panel');
    if (!panel || !cosmeticsState.catalog) return;
    
    const content = panel.querySelector('.cosmetics-content');
    if (!content) return;
    
    const hasFullAccess = cosmeticsState.unlockAll || !cosmeticsState.paywallEnabled || cosmeticsState.isDonor || cosmeticsState.isAdmin;
    const userStats = (typeof gameState !== 'undefined' && gameState?.authUser?.stats) ? gameState.authUser.stats : {};
    const equipped = cosmeticsState.userCosmetics || {};
    
    let html = '';
    
    // Status banner
    if (cosmeticsState.unlockAll) {
        html += `<div class="cosmetics-banner">&gt; All customization unlocked</div>`;
    } else if (!cosmeticsState.paywallEnabled) {
        html += `<div class="cosmetics-banner">&gt; Premium features currently free</div>`;
    } else if (!hasFullAccess) {
        html += `
            <div class="cosmetics-banner locked">
                <p>&gt; Support to unlock custom colors</p>
                <a href="https://ko-fi.com/embeddle" target="_blank" class="btn btn-primary btn-small">&gt; SUPPORT</a>
            </div>
        `;
    } else if (cosmeticsState.isAdmin) {
        html += `<div class="cosmetics-banner">&gt; Admin access</div>`;
    } else {
        html += `<div class="cosmetics-banner">&gt; Supporter - thank you</div>`;
    }
    
    // Theme Color Section
    html += renderThemeColorSection(equipped, hasFullAccess, userStats);
    
    // Badge Section
    html += renderBadgeSection(equipped, hasFullAccess, userStats);
    
    // Title Section
    html += renderTitleSection(equipped, hasFullAccess, userStats);
    
    content.innerHTML = html;
    
    // Add event listeners
    setupCosmeticsEventListeners(content, hasFullAccess);
    updateCosmeticsPreview();
}

function renderThemeColorSection(equipped, hasFullAccess, userStats) {
    const colors = cosmeticsState.catalog.theme_colors || {};
    const currentId = equipped.theme_color || 'default';
    
    let html = `<div class="cosmetic-category">
        <label>// THEME_COLOUR</label>
        <div class="theme-color-grid">`;
    
    Object.entries(colors).forEach(([id, item]) => {
        if (id === 'custom') return; // Handle custom separately
        
        const isEquipped = id === currentId;
        const reqInfo = buildRequirementsInfo(item.requirements, userStats);
        // Admins and those with full access bypass requirements
        const isLocked = !hasFullAccess && !cosmeticsState.isAdmin && Boolean(reqInfo.unmet);
        
        html += `
            <div class="theme-color-option ${isEquipped ? 'equipped' : ''} ${isLocked ? 'locked' : ''}"
                 data-category="theme_color" data-id="${id}"
                 style="--preview-color: ${item.hex}"
                 title="${item.description}${isLocked ? ' - ' + formatLockReason(reqInfo.unmet) : ''}">
                <span class="color-swatch"></span>
                <span class="color-name">${item.name}</span>
            </div>
        `;
    });
    
    html += `</div>`;
    
    // Custom color picker (premium only)
    if (hasFullAccess) {
        const customHex = equipped.custom_hex || '#00cc88';
        html += `
            <div class="custom-color-section">
                <label>// CUSTOM_HEX</label>
                <div class="custom-color-row">
                    <input type="color" id="custom-color-picker" value="${customHex}" class="color-picker-input">
                    <input type="text" id="custom-color-hex" value="${customHex}" maxlength="7" placeholder="#000000" class="hex-input">
                    <button id="apply-custom-color" class="btn btn-small btn-primary">&gt; APPLY</button>
                </div>
            </div>
        `;
    }
    
    html += `</div>`;
    return html;
}

function renderBadgeSection(equipped, hasFullAccess, userStats) {
    const badges = cosmeticsState.catalog.badges || {};
    const currentId = equipped.badge || 'none';
    
    let html = `<div class="cosmetic-category">
        <label>// BADGE</label>
        <div class="badge-grid">`;
    
    Object.entries(badges).forEach(([id, item]) => {
        if (item.admin_only && !cosmeticsState.isAdmin) return;
        
        const isEquipped = id === currentId;
        const isPremiumLocked = cosmeticsState.paywallEnabled && item.premium && !hasFullAccess;
        const reqInfo = buildRequirementsInfo(item.requirements, userStats);
        // Admins bypass all requirements
        const isReqLocked = !cosmeticsState.isAdmin && !cosmeticsState.unlockAll && Boolean(reqInfo.unmet);
        const isLocked = isPremiumLocked || isReqLocked;
        
        let lockReason = '';
        if (isPremiumLocked) lockReason = 'Supporter exclusive';
        else if (isReqLocked) lockReason = formatLockReason(reqInfo.unmet);
        
        html += `
            <div class="badge-option ${isEquipped ? 'equipped' : ''} ${isLocked ? 'locked' : ''}"
                 data-category="badge" data-id="${id}"
                 title="${item.description}${lockReason ? ' - ' + lockReason : ''}">
                <span class="badge-icon">${item.icon || '[-]'}</span>
                <span class="badge-name">${item.name}</span>
            </div>
        `;
    });
    
    html += `</div></div>`;
    return html;
}

function renderTitleSection(equipped, hasFullAccess, userStats) {
    const titles = cosmeticsState.catalog.profile_titles || {};
    const currentId = equipped.profile_title || 'none';
    
    let html = `<div class="cosmetic-category">
        <label>// TITLE</label>
        <div class="title-grid">`;
    
    Object.entries(titles).forEach(([id, item]) => {
        if (item.admin_only && !cosmeticsState.isAdmin) return;
        
        const isEquipped = id === currentId;
        const isPremiumLocked = cosmeticsState.paywallEnabled && item.premium && !hasFullAccess;
        const reqInfo = buildRequirementsInfo(item.requirements, userStats);
        // Admins bypass all requirements
        const isReqLocked = !cosmeticsState.isAdmin && !cosmeticsState.unlockAll && Boolean(reqInfo.unmet);
        const isLocked = isPremiumLocked || isReqLocked;
        
        let lockReason = '';
        if (isPremiumLocked) lockReason = 'Supporter exclusive';
        else if (isReqLocked) lockReason = formatLockReason(reqInfo.unmet);
        
        html += `
            <div class="title-option ${isEquipped ? 'equipped' : ''} ${isLocked ? 'locked' : ''}"
                 data-category="profile_title" data-id="${id}"
                 title="${item.description}${lockReason ? ' - ' + lockReason : ''}">
                <span class="title-text">${item.text || 'None'}</span>
            </div>
        `;
    });
    
    html += `</div></div>`;
    return html;
}

function setupCosmeticsEventListeners(content, hasFullAccess) {
    // Theme color options
    content.querySelectorAll('.theme-color-option').forEach(el => {
        el.addEventListener('click', () => {
            if (!el.classList.contains('locked')) {
                equipCosmetic('theme_color', el.dataset.id);
            }
        });
    });
    
    // Badge options
    content.querySelectorAll('.badge-option').forEach(el => {
        el.addEventListener('click', () => {
            if (!el.classList.contains('locked')) {
                equipCosmetic('badge', el.dataset.id);
            }
        });
    });
    
    // Title options
    content.querySelectorAll('.title-option').forEach(el => {
        el.addEventListener('click', () => {
            if (!el.classList.contains('locked')) {
                equipCosmetic('profile_title', el.dataset.id);
            }
        });
    });
    
    // Custom color picker
    const colorPicker = document.getElementById('custom-color-picker');
    const hexInput = document.getElementById('custom-color-hex');
    const applyBtn = document.getElementById('apply-custom-color');
    
    if (colorPicker && hexInput) {
        colorPicker.addEventListener('input', () => {
            hexInput.value = colorPicker.value;
            applyThemeColor(colorPicker.value);
        });
        
        hexInput.addEventListener('input', () => {
            if (/^#[0-9A-Fa-f]{6}$/.test(hexInput.value)) {
                colorPicker.value = hexInput.value;
                applyThemeColor(hexInput.value);
            }
        });
        
        if (applyBtn) {
            applyBtn.addEventListener('click', async () => {
                const hex = hexInput.value;
                if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
                    await equipCosmetic('theme_color', 'custom');
                    await saveCustomColor(hex);
                }
            });
        }
    }
}

function formatLockReason(unmet) {
    if (!unmet) return '';
    const labels = {
        mp_games_played: 'games',
        mp_wins: 'wins',
        mp_eliminations: 'eliminations',
        peak_mmr: 'MMR',
    };
    return `${unmet.min} ${labels[unmet.metric] || unmet.metric} required`;
}

function buildRequirementsInfo(requirements, stats) {
    const reqs = Array.isArray(requirements) ? requirements : [];
    if (!reqs.length) return { unmet: null, all: [] };
    
    const parts = reqs.map(r => ({
        metric: r.metric,
        min: Number(r.min || 0),
        have: Number(stats?.[r.metric] || 0)
    })).filter(p => p.metric && p.min > 0);
    
    const unmet = parts.find(p => p.have < p.min) || null;
    return { unmet, all: parts };
}

function updateCosmeticsPreview() {
    const card = document.getElementById('cosmetics-preview-card');
    const nameEl = document.getElementById('cosmetics-preview-name');
    if (!card || !nameEl) return;

    const c = cosmeticsState.userCosmetics || {};
    const badgeHtml = getBadgeHtml(c);
    const titleHtml = getTitleHtml(c);
    
    nameEl.innerHTML = `YOU${badgeHtml}${titleHtml}`;
}

// ============ PLAYER CARD COSMETICS ============

function getPlayerCardClasses(cosmetics) {
    // Simplified - no more fancy borders
    return '';
}

function getNameColorClass(cosmetics) {
    // Simplified - color comes from theme
    return '';
}

function getBadgeHtml(cosmetics) {
    if (!cosmetics || !cosmetics.badge || cosmetics.badge === 'none') return '';
    const catalog = cosmeticsState.catalog;
    if (catalog && catalog.badges && catalog.badges[cosmetics.badge]) {
        const badgeData = catalog.badges[cosmetics.badge];
        if (badgeData.icon) {
            return `<span class="player-badge">${badgeData.icon}</span>`;
        }
    }
    return '';
}

function getTitleHtml(cosmetics) {
    if (!cosmetics || !cosmetics.profile_title || cosmetics.profile_title === 'none') return '';
    const catalog = cosmeticsState.catalog;
    if (catalog && catalog.profile_titles && catalog.profile_titles[cosmetics.profile_title]) {
        const titleData = catalog.profile_titles[cosmetics.profile_title];
        if (titleData.text) {
            return `<span class="player-title">${titleData.text}</span>`;
        }
    }
    return '';
}

// ============ SIMPLIFIED EFFECTS ============

// Victory effect - just simple confetti, no fancy animations
function playVictoryEffect(effectId, targetEl = null) {
    const container = targetEl || document.getElementById('confetti-container');
    if (!container) return;
    createConfetti(container);
}

function createConfetti(container) {
    container.innerHTML = '';
    const colors = ['var(--user-accent)', '#ffffff', 'var(--user-accent-dim)'];
    
    for (let i = 0; i < 50; i++) {
        const piece = document.createElement('div');
        piece.className = 'confetti-piece';
        piece.style.left = Math.random() * 100 + '%';
        piece.style.background = colors[Math.floor(Math.random() * colors.length)];
        piece.style.animationDelay = Math.random() * 0.5 + 's';
        piece.style.animationDuration = (2 + Math.random() * 2) + 's';
        container.appendChild(piece);
    }
    
    setTimeout(() => container.innerHTML = '', 4000);
}

// Guess effect - subtle pulse only
function playGuessEffect(guessBar, cosmetics) {
    if (!guessBar) return;
    guessBar.classList.add('guess-pulse');
    setTimeout(() => guessBar.classList.remove('guess-pulse'), 400);
}

function getGuessEffectClass(cosmetics) {
    return 'guess-pulse';
}

// Background - no custom backgrounds, just default
function applyCustomBackground(backgroundId) {
    // Disabled - using default noir background
}

// ============ INITIALIZATION ============

loadCosmeticsCatalog();

// Preview test buttons
document.getElementById('cosmetics-test-turn')?.addEventListener('click', () => {
    const card = document.getElementById('cosmetics-preview-card');
    if (card) {
        card.classList.toggle('current-turn');
        updateCosmeticsPreview();
    }
});

document.getElementById('cosmetics-test-guess')?.addEventListener('click', () => {
    const guessForm = document.getElementById('cosmetics-guess-form');
    playGuessEffect(guessForm, cosmeticsState.userCosmetics);
});

document.getElementById('cosmetics-test-elim')?.addEventListener('click', () => {
    const card = document.getElementById('cosmetics-preview-card');
    if (card) {
        card.classList.add('elim-flash');
        setTimeout(() => card.classList.remove('elim-flash'), 500);
    }
});

document.getElementById('cosmetics-test-victory')?.addEventListener('click', () => {
    playVictoryEffect('classic', document.getElementById('cosmetics-victory-container'));
});

updateCosmeticsPreview();
