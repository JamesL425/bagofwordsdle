/**
 * EMBEDDLE - Cosmetics System
 * Handles cosmetic effects, backgrounds, and visual customizations
 */

// Cosmetics state
let cosmeticsState = {
    catalog: null,
    userCosmetics: null,
    isDonor: false,
    isAdmin: false,
    paywallEnabled: false,
    unlockAll: false,
    panelOpen: false,
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
    if (!gameState.authToken) return;
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
            applyPersonalCosmetics();
            updateCosmeticsPreview();
        }
    } catch (e) {
        console.error('Failed to load user cosmetics:', e);
    }
}

async function equipCosmetic(category, cosmeticId) {
    if (!gameState.authToken) {
        showError('Please sign in with Google to use cosmetics');
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
            applyPersonalCosmetics();
            updateCosmeticsPanel();
            updateCosmeticsPreview();
            return true;
        } else {
            const err = await response.json();
            showError(err.detail || 'Failed to equip cosmetic');
            return false;
        }
    } catch (e) {
        console.error('Failed to equip cosmetic:', e);
        return false;
    }
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
    
    // Admins have full access like donors. If unlockAll is enabled, everyone has access.
    const hasFullAccess = cosmeticsState.unlockAll || !cosmeticsState.paywallEnabled || cosmeticsState.isDonor || cosmeticsState.isAdmin;
    const userStats = (typeof gameState !== 'undefined' && gameState?.authUser?.stats) ? gameState.authUser.stats : {};
    const equipped = cosmeticsState.userCosmetics || {};
    
    let html = '';
    
    // Donor status banner / paywall banner
    if (cosmeticsState.unlockAll) {
        html += `<div class="cosmetics-banner donor">🎨 All cosmetics are unlocked right now (temporary).</div>`;
    } else if (!cosmeticsState.paywallEnabled) {
        html += `<div class="cosmetics-banner donor">🎨 Premium cosmetics are free right now (paywall disabled). Progression unlocks still apply.</div>`;
    } else if (!hasFullAccess) {
        html += `
            <div class="cosmetics-banner">
                <p>🔒 Donate to unlock Premium cosmetics!</p>
                <a href="https://ko-fi.com/jamesleung425" target="_blank" class="btn btn-primary btn-small">☕ Support on Ko-fi</a>
            </div>
        `;
    } else if (cosmeticsState.isAdmin) {
        html += `<div class="cosmetics-banner donor">👑 Admin Access - All cosmetics unlocked</div>`;
    } else {
        html += `<div class="cosmetics-banner donor">✓ Thank you for supporting Embeddle!</div>`;
    }
    
    // Visible to all section
    html += '<h3 class="cosmetics-section-title">VISIBLE TO ALL PLAYERS</h3>';
    
    const visibleCategories = [
        ['card_border', 'card_borders', 'Card Border'],
        ['card_background', 'card_backgrounds', 'Card Background'],
        ['name_color', 'name_colors', 'Name Color'],
        ['badge', 'badges', 'Badge'],
        ['elimination_effect', 'elimination_effects', 'Elimination Effect'],
        ['guess_effect', 'guess_effects', 'Guess Effect'],
        ['turn_indicator', 'turn_indicators', 'Turn Indicator'],
        ['victory_effect', 'victory_effects', 'Victory Effect'],
    ];
    
    visibleCategories.forEach(([key, catalogKey, label]) => {
        html += renderCosmeticCategory(key, catalogKey, label, equipped, hasFullAccess, userStats);
    });
    
    // Personal section
    html += '<h3 class="cosmetics-section-title">PERSONAL (Only You See)</h3>';
    
    const personalCategories = [
        ['matrix_color', 'matrix_colors', 'Matrix Color'],
        ['particle_overlay', 'particle_overlays', 'Particles'],
        ['seasonal_theme', 'seasonal_themes', 'Seasonal'],
        ['alt_background', 'alt_backgrounds', 'Background'],
    ];
    
    personalCategories.forEach(([key, catalogKey, label]) => {
        html += renderCosmeticCategory(key, catalogKey, label, equipped, hasFullAccess, userStats);
    });
    
    content.innerHTML = html;
    
    // Add click handlers
    content.querySelectorAll('.cosmetic-option').forEach(el => {
        el.addEventListener('click', () => {
            const cat = el.dataset.category;
            const id = el.dataset.id;
            if (!el.classList.contains('locked')) {
                equipCosmetic(cat, id);
            } else {
                const reason = el.dataset.lockReason;
                if (reason) {
                    showError(reason);
                } else if (cosmeticsState.paywallEnabled && !hasFullAccess) {
                    showError('Donate to unlock premium cosmetics!');
                } else {
                    showError('Locked');
                }
            }
        });
    });

    updateCosmeticsPreview();
}

function formatRequirement(req, stats) {
    const metric = req?.metric;
    const min = Number(req?.min || 0);
    const have = Number(stats?.[metric] || 0);
    const labels = {
        mp_games_played: 'MP games',
        mp_wins: 'MP wins',
        mp_eliminations: 'MP elims',
        mp_times_eliminated: 'MP deaths',
        peak_mmr: 'Peak MMR',
    };
    const metricLabel = labels[metric] || metric || 'progress';
    return { metric, min, have, metricLabel };
}

function buildRequirementsInfo(requirements, stats) {
    const reqs = Array.isArray(requirements) ? requirements : [];
    if (!reqs.length) return { unmet: null, all: [] };
    const parts = reqs
        .map(r => formatRequirement(r, stats))
        .filter(p => p.metric && p.min > 0);
    const unmet = parts.find(p => p.have < p.min) || null;
    return { unmet, all: parts };
}

function updateCosmeticsPreview() {
    const card = document.getElementById('cosmetics-preview-card');
    const nameEl = document.getElementById('cosmetics-preview-name');
    if (!card || !nameEl) return;

    const c = cosmeticsState.userCosmetics || {};
    const keepTurn = card.classList.contains('current-turn');

    const cosmeticClasses = typeof getPlayerCardClasses === 'function' ? getPlayerCardClasses(c) : '';
    card.className = `player-card cosmetics-preview-card ${cosmeticClasses}`.trim();
    if (keepTurn) card.classList.add('current-turn');

    const nameColorClass = typeof getNameColorClass === 'function' ? getNameColorClass(c) : '';
    nameEl.className = `name ${nameColorClass}`.trim();

    const badgeHtml = typeof getBadgeHtml === 'function' ? getBadgeHtml(c) : '';
    nameEl.innerHTML = `YOU${badgeHtml}`;
}

function renderCosmeticCategory(key, catalogKey, label, equipped, hasFullAccess, userStats) {
    const items = cosmeticsState.catalog[catalogKey] || {};
    const currentId = equipped[key] || Object.keys(items)[0];
    
    let html = `<div class="cosmetic-category"><label>${label}</label><div class="cosmetic-options">`;
    
    Object.entries(items).forEach(([id, item]) => {
        const isEquipped = id === currentId;
        const isPremiumLocked = cosmeticsState.paywallEnabled && item.premium && !hasFullAccess;
        const reqInfo = (cosmeticsState.isAdmin || cosmeticsState.unlockAll)
            ? { unmet: null, all: [] }
            : buildRequirementsInfo(item.requirements, userStats);
        const isReqLocked = Boolean(reqInfo.unmet);
        const isLocked = isPremiumLocked || isReqLocked;
        const icon = item.icon || '';

        let lockReason = '';
        let progressHtml = '';
        if (isPremiumLocked) {
            lockReason = 'Donate to unlock premium cosmetics!';
        } else if (isReqLocked && reqInfo.unmet) {
            lockReason = `Locked: requires ${reqInfo.unmet.min} ${reqInfo.unmet.metricLabel} (${reqInfo.unmet.have}/${reqInfo.unmet.min})`;
            progressHtml = `<span class="cosmetic-progress">${reqInfo.unmet.have}/${reqInfo.unmet.min}</span>`;
        }

        const titleParts = [item.description].filter(Boolean);
        if (isReqLocked && reqInfo.all.length) {
            const detail = reqInfo.all
                .map(p => `${p.metricLabel}: ${Math.min(p.have, p.min)}/${p.min}`)
                .join(' • ');
            titleParts.push(`Requires ${detail}`);
        }
        if (isPremiumLocked) titleParts.push('Donate to unlock');
        
        html += `
            <div class="cosmetic-option ${isEquipped ? 'equipped' : ''} ${isLocked ? 'locked' : ''}" 
                 data-category="${key}" data-id="${id}" data-lock-reason="${lockReason}" title="${titleParts.join(' — ')}">
                ${icon ? `<span class="cosmetic-icon">${icon}</span>` : ''}
                <span class="cosmetic-name">${item.name}</span>
                ${progressHtml}
                ${isLocked ? '<span class="lock-icon">🔒</span>' : ''}
            </div>
        `;
    });
    
    html += '</div></div>';
    return html;
}

// ============ APPLY COSMETICS ============

function applyPersonalCosmetics() {
    if (!cosmeticsState.userCosmetics) return;
    const c = cosmeticsState.userCosmetics;
    
    // Apply matrix color
    applyMatrixColor(c.matrix_color || 'classic');
    
    // Apply alt background
    applyAltBackground(c.alt_background || 'matrix');
    
    // Apply particle overlay
    applyParticleOverlay(c.particle_overlay || 'none');
    
    // Apply seasonal theme
    applySeasonalTheme(c.seasonal_theme || 'none');
}

function applyMatrixColor(colorId) {
    const colors = {
        classic: '#00ff41',
        crimson: '#ff3333',
        cyber_blue: '#00ccff',
        royal_purple: '#9933ff',
        gold_rush: '#ffd700',
        monochrome: '#ffffff',
        neon_pink: '#ff00ff',
    };
    document.documentElement.style.setProperty('--matrix-color', colors[colorId] || colors.classic);
}

function applyAltBackground(bgId) {
    document.body.dataset.background = bgId;
}

function applyParticleOverlay(particleId) {
    document.body.dataset.particles = particleId;
}

function applySeasonalTheme(seasonalId) {
    document.body.dataset.seasonal = seasonalId;
}

// ============ PLAYER CARD COSMETICS ============

function getPlayerCardClasses(cosmetics) {
    if (!cosmetics) return '';
    const classes = [];
    if (cosmetics.card_border && cosmetics.card_border !== 'classic') {
        classes.push(`border-${cosmetics.card_border}`);
    }
    if (cosmetics.card_background && cosmetics.card_background !== 'default') {
        classes.push(`bg-${cosmetics.card_background}`);
    }
    if (cosmetics.turn_indicator && cosmetics.turn_indicator !== 'classic') {
        classes.push(`turn-${cosmetics.turn_indicator}`);
    }
    return classes.join(' ');
}

function getNameColorClass(cosmetics) {
    if (!cosmetics || !cosmetics.name_color || cosmetics.name_color === 'default') return '';
    return `name-${cosmetics.name_color}`;
}

function getBadgeHtml(cosmetics) {
    if (!cosmetics || !cosmetics.badge || cosmetics.badge === 'none') return '';
    const badges = {
        coffee: '☕',
        diamond: '💎',
        rookie: '🔰',
        hunter: '⚔️',
        executioner: '☠️',
        champion: '🏆',
        legend: '👑',
        // Legacy v1 IDs (kept so old game states still render)
        star: '⭐',
        heart: '❤️',
        crown: '👑',
        lightning: '⚡',
        flame: '🔥'
    };
    return badges[cosmetics.badge] ? `<span class="player-badge">${badges[cosmetics.badge]}</span>` : '';
}

// ============ EFFECTS ============

function playEliminationEffect(playerId, effectId) {
    const card = document.querySelector(`.player-card[data-player-id="${playerId}"]`);
    if (!card) return;
    
    const effect = effectId || 'classic';
    card.classList.add(`elim-${effect}`);
    
    setTimeout(() => {
        card.classList.remove(`elim-${effect}`);
    }, 1500);
}

function playGuessEffect(effectId, targetEl = null) {
    const form = targetEl || document.getElementById('guess-form');
    if (!form) return;
    
    const effect = effectId || 'classic';
    form.classList.add(`guess-${effect}`);
    
    setTimeout(() => {
        form.classList.remove(`guess-${effect}`);
    }, 800);
}

function playVictoryEffect(effectId, targetEl = null) {
    const container = targetEl || document.getElementById('confetti-container');
    if (!container) return;
    
    const effect = effectId || 'classic';
    container.dataset.effect = effect;
    
    // Different effects based on type
    switch (effect) {
        case 'fireworks':
            createFireworksEffect(container);
            break;
        case 'gold_rain':
            createGoldRainEffect(container);
            break;
        case 'lightning_storm':
            createLightningEffect(container);
            break;
        case 'supernova':
            createSupernovaEffect(container);
            break;
        default:
            if (typeof createConfetti === 'function') {
                createConfetti(container); // Use existing confetti (allow override)
            }
    }
}

function createFireworksEffect(container) {
    container.innerHTML = '';
    for (let i = 0; i < 20; i++) {
        setTimeout(() => {
            const firework = document.createElement('div');
            firework.className = 'firework';
            firework.style.left = Math.random() * 100 + '%';
            firework.style.top = Math.random() * 50 + '%';
            container.appendChild(firework);
            setTimeout(() => firework.remove(), 1000);
        }, i * 150);
    }
}

function createGoldRainEffect(container) {
    container.innerHTML = '';
    const height = container.clientHeight || window.innerHeight || 800;
    const fallDistance = (height + 40) + 'px';

    for (let i = 0; i < 70; i++) {
        const coin = document.createElement('div');
        coin.className = 'gold-particle';

        const size = Math.floor(10 + Math.random() * 14); // 10px - 24px
        const opacity = (0.55 + Math.random() * 0.45).toFixed(2);
        const duration = (1.8 + Math.random() * 2.6).toFixed(2); // 1.8s - 4.4s
        const delay = (Math.random() * 0.8).toFixed(2); // 0s - 0.8s

        coin.style.left = Math.random() * 100 + '%';
        coin.style.setProperty('--size', `${size}px`);
        coin.style.setProperty('--opacity', opacity);
        coin.style.setProperty('--dur', `${duration}s`);
        coin.style.setProperty('--fall-distance', fallDistance);
        coin.style.animationDelay = `${delay}s`;

        container.appendChild(coin);
    }

    setTimeout(() => {
        container.innerHTML = '';
    }, 5500);
}

function createLightningEffect(container) {
    container.innerHTML = '';
    for (let i = 0; i < 8; i++) {
        setTimeout(() => {
            const flash = document.createElement('div');
            flash.className = 'lightning-flash';
            container.appendChild(flash);
            setTimeout(() => flash.remove(), 200);
        }, i * 300);
    }
}

function createSupernovaEffect(container) {
    container.innerHTML = '';
    const nova = document.createElement('div');
    nova.className = 'supernova';
    container.appendChild(nova);
    setTimeout(() => container.innerHTML = '', 2000);
}

// Initialize cosmetics
document.addEventListener('DOMContentLoaded', () => {
    loadCosmeticsCatalog();
    // Preview/test harness
    document.getElementById('cosmetics-test-turn')?.addEventListener('click', () => {
        const card = document.getElementById('cosmetics-preview-card');
        if (!card) return;
        card.classList.toggle('current-turn');
        updateCosmeticsPreview();
    });
    document.getElementById('cosmetics-test-guess')?.addEventListener('click', () => {
        const c = cosmeticsState.userCosmetics || {};
        playGuessEffect(c.guess_effect || 'classic', document.getElementById('cosmetics-guess-form'));
    });
    document.getElementById('cosmetics-test-elim')?.addEventListener('click', () => {
        const c = cosmeticsState.userCosmetics || {};
        playEliminationEffect('cosmetics_preview', c.elimination_effect || 'classic');
    });
    document.getElementById('cosmetics-test-victory')?.addEventListener('click', () => {
        const c = cosmeticsState.userCosmetics || {};
        playVictoryEffect(c.victory_effect || 'classic', document.getElementById('cosmetics-victory-container'));
    });
    updateCosmeticsPreview();
});
