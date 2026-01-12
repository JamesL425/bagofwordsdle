/**
 * EMBEDDLE - Cosmetics System
 * Handles cosmetic effects, backgrounds, and visual customizations
 */

// Cosmetics state
let cosmeticsState = {
    catalog: null,
    userCosmetics: null,
    isDonor: false,
    panelOpen: false,
};

// ============ COSMETICS CATALOG ============

async function loadCosmeticsCatalog() {
    try {
        const response = await fetch(`${API_BASE}/api/cosmetics`);
        if (response.ok) {
            const data = await response.json();
            cosmeticsState.catalog = data.catalog;
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
            applyPersonalCosmetics();
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
    
    const isDonor = cosmeticsState.isDonor;
    const equipped = cosmeticsState.userCosmetics || {};
    
    let html = '';
    
    // Donor status banner
    if (!isDonor) {
        html += `
            <div class="cosmetics-banner">
                <p>🔒 Donate to unlock all cosmetics!</p>
                <a href="https://ko-fi.com/embeddle" target="_blank" class="btn btn-primary btn-small">☕ Support on Ko-fi</a>
            </div>
        `;
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
        html += renderCosmeticCategory(key, catalogKey, label, equipped, isDonor);
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
        html += renderCosmeticCategory(key, catalogKey, label, equipped, isDonor);
    });
    
    content.innerHTML = html;
    
    // Add click handlers
    content.querySelectorAll('.cosmetic-option').forEach(el => {
        el.addEventListener('click', () => {
            const cat = el.dataset.category;
            const id = el.dataset.id;
            if (!el.classList.contains('locked')) {
                equipCosmetic(cat, id);
            } else if (!isDonor) {
                showError('Donate to unlock premium cosmetics!');
            }
        });
    });
}

function renderCosmeticCategory(key, catalogKey, label, equipped, isDonor) {
    const items = cosmeticsState.catalog[catalogKey] || {};
    const currentId = equipped[key] || Object.keys(items)[0];
    
    let html = `<div class="cosmetic-category"><label>${label}</label><div class="cosmetic-options">`;
    
    Object.entries(items).forEach(([id, item]) => {
        const isEquipped = id === currentId;
        const isLocked = item.premium && !isDonor;
        const icon = item.icon || '';
        
        html += `
            <div class="cosmetic-option ${isEquipped ? 'equipped' : ''} ${isLocked ? 'locked' : ''}" 
                 data-category="${key}" data-id="${id}" title="${item.description}">
                ${icon ? `<span class="cosmetic-icon">${icon}</span>` : ''}
                <span class="cosmetic-name">${item.name}</span>
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
        coffee: '☕', star: '⭐', diamond: '💎', heart: '❤️',
        crown: '👑', lightning: '⚡', flame: '🔥'
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

function playGuessEffect(effectId) {
    const form = document.getElementById('guess-form');
    if (!form) return;
    
    const effect = effectId || 'classic';
    form.classList.add(`guess-${effect}`);
    
    setTimeout(() => {
        form.classList.remove(`guess-${effect}`);
    }, 800);
}

function playVictoryEffect(effectId) {
    const container = document.getElementById('confetti-container');
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
            createConfetti(); // Use existing confetti
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
    const chars = '💰🪙⭐✨💎';
    for (let i = 0; i < 60; i++) {
        const coin = document.createElement('div');
        coin.className = 'gold-particle';
        coin.textContent = chars[Math.floor(Math.random() * chars.length)];
        coin.style.left = Math.random() * 100 + '%';
        coin.style.animationDelay = Math.random() * 2 + 's';
        container.appendChild(coin);
    }
    setTimeout(() => container.innerHTML = '', 4000);
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
});
