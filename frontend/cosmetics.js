/**
 * EMBEDDLE - Cosmetics System (Simplified)
 * Handles cosmetic effects and visual customizations
 * Categories: Card Borders, Badges, Name Colors, Victory Effects, Profile Titles
 */

// API base URL - defined here since this is the first script to load
const API_BASE = window.location.origin;

// Cosmetics state
let cosmeticsState = {
    catalog: null,
    userCosmetics: null,
    ownedCosmetics: {},  // For shop-purchased cosmetics
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
            cosmeticsState.ownedCosmetics = data.owned_cosmetics || {};
            if (typeof data.paywall_enabled === 'boolean') {
                cosmeticsState.paywallEnabled = data.paywall_enabled;
            }
            if (typeof data.unlock_all === 'boolean') {
                cosmeticsState.unlockAll = data.unlock_all;
            }
            updateCosmeticsPreview();
        }
    } catch (e) {
        console.error('Failed to load user cosmetics:', e);
    }
}

async function equipCosmetic(category, cosmeticId) {
    if (typeof gameState === 'undefined' || !gameState.authToken) {
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
                <a href="https://ko-fi.com/embeddle" target="_blank" class="btn btn-primary btn-small">☕ Support on Ko-fi</a>
            </div>
        `;
    } else if (cosmeticsState.isAdmin) {
        html += `<div class="cosmetics-banner donor">👑 Admin Access - All cosmetics unlocked</div>`;
    } else {
        html += `<div class="cosmetics-banner donor">✓ Thank you for supporting Embeddle!</div>`;
    }
    
    // All 8 categories (including new guess effects and backgrounds)
    const categories = [
        ['card_border', 'card_borders', 'Card Border'],
        ['badge', 'badges', 'Badge'],
        ['name_color', 'name_colors', 'Name Color'],
        ['guess_effect', 'guess_effects', 'Guess Effect'],
        ['custom_background', 'custom_backgrounds', 'Background'],
        ['victory_effect', 'victory_effects', 'Victory Effect'],
        ['profile_title', 'profile_titles', 'Profile Title'],
        ['profile_avatar', 'profile_avatars', 'Profile Avatar'],
    ];
    
    categories.forEach(([key, catalogKey, label]) => {
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
                const isPremium = el.dataset.premium === 'true';
                
                if (isPremium && cosmeticsState.paywallEnabled && !hasFullAccess) {
                    showPremiumUnlockPrompt(el.dataset.name || 'this item');
                } else if (reason) {
                    showError(reason);
                } else {
                    showError('Locked');
                }
            }
        });
    });

    updateCosmeticsPreview();
}

// Show a nicer prompt for premium items
function showPremiumUnlockPrompt(itemName) {
    let prompt = document.getElementById('premium-unlock-prompt');
    if (!prompt) {
        prompt = document.createElement('div');
        prompt.id = 'premium-unlock-prompt';
        prompt.className = 'premium-unlock-prompt';
        prompt.innerHTML = `
            <div class="premium-prompt-content">
                <p class="premium-prompt-title">🔒 Supporter Exclusive</p>
                <p class="premium-prompt-text"><span class="premium-item-name"></span> is available to Ko-fi supporters!</p>
                <a href="https://ko-fi.com/embeddle" target="_blank" rel="noopener" class="btn btn-small btn-support">☕ Unlock All Premium</a>
                <button class="btn btn-ghost btn-tiny premium-prompt-close">×</button>
            </div>
        `;
        document.body.appendChild(prompt);
        
        prompt.querySelector('.premium-prompt-close').addEventListener('click', () => {
            prompt.classList.remove('show');
        });
        
        prompt.addEventListener('click', (e) => {
            if (e.target === prompt) {
                prompt.classList.remove('show');
            }
        });
    }
    
    prompt.querySelector('.premium-item-name').textContent = itemName;
    prompt.classList.add('show');
    
    setTimeout(() => {
        prompt.classList.remove('show');
    }, 5000);
}

function formatRequirement(req, stats) {
    const metric = req?.metric;
    const min = Number(req?.min || 0);
    const have = Number(stats?.[metric] || 0);
    const labels = {
        mp_games_played: 'games',
        mp_wins: 'wins',
        mp_eliminations: 'eliminations',
        mp_times_eliminated: 'deaths',
        peak_mmr: 'MMR',
    };
    const shortLabels = {
        mp_games_played: '🎮',
        mp_wins: '🏆',
        mp_eliminations: '⚔️',
        mp_times_eliminated: '💀',
        peak_mmr: '📈',
    };
    const metricLabel = labels[metric] || metric || 'progress';
    const shortLabel = shortLabels[metric] || '';
    return { metric, min, have, metricLabel, shortLabel };
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
    const titleHtml = typeof getTitleHtml === 'function' ? getTitleHtml(c) : '';
    nameEl.innerHTML = `YOU${badgeHtml}${titleHtml}`;
    
    // Apply custom background
    applyCustomBackground(c.custom_background || 'default');
}

// Apply custom background to body
function applyCustomBackground(backgroundId) {
    document.body.dataset.background = backgroundId || 'default';
}

// Get the guess effect class for the guess bar
function getGuessEffectClass(cosmetics) {
    const effect = cosmetics?.guess_effect || 'classic';
    return `guess-${effect}`;
}

// Play guess effect animation
function playGuessEffect(guessBar, cosmetics) {
    if (!guessBar) return;
    const effectClass = getGuessEffectClass(cosmetics);
    // Remove any existing guess effect classes
    guessBar.classList.forEach(cls => {
        if (cls.startsWith('guess-')) guessBar.classList.remove(cls);
    });
    // Add the new effect class
    guessBar.classList.add(effectClass);
    // Remove after animation completes
    setTimeout(() => {
        guessBar.classList.remove(effectClass);
    }, 700);
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
        
        // Check shop-priced cosmetics: must be owned unless admin/unlockAll
        const price = parseInt(item.price || 0, 10);
        const isShopItem = price > 0 && !item.premium;
        const ownedList = (cosmeticsState.ownedCosmetics || {})[key] || [];
        const isOwned = Array.isArray(ownedList) && ownedList.includes(id);
        const isShopLocked = isShopItem && !isOwned && !(cosmeticsState.isAdmin || cosmeticsState.unlockAll);
        
        const isLocked = isPremiumLocked || isReqLocked || isShopLocked;
        const icon = item.icon || '';

        let lockReason = '';
        let progressHtml = '';
        if (isPremiumLocked) {
            lockReason = 'Donate to unlock premium cosmetics!';
        } else if (isShopLocked) {
            lockReason = `Purchase in Shop (${price} credits)`;
        } else if (isReqLocked && reqInfo.unmet) {
            const r = reqInfo.unmet;
            lockReason = `Unlock at ${r.min} ${r.metricLabel}`;
            progressHtml = `<span class="cosmetic-progress">${r.shortLabel} ${r.have}/${r.min}</span>`;
        }

        const titleParts = [item.description].filter(Boolean);
        if (isReqLocked && reqInfo.all.length) {
            const detail = reqInfo.all
                .map(p => `${p.have}/${p.min} ${p.metricLabel}`)
                .join(' + ');
            titleParts.push(`Unlock: ${detail}`);
        }
        if (isPremiumLocked) titleParts.push('🔒 Supporter exclusive');
        if (isShopLocked) titleParts.push(`💰 Shop: ${price} credits`);
        
        // Show price badge for shop items
        let priceHtml = '';
        if (isShopItem && !isOwned && !(cosmeticsState.isAdmin || cosmeticsState.unlockAll)) {
            priceHtml = `<span class="cosmetic-price">${price}¢</span>`;
        }
        
        html += `
            <div class="cosmetic-option ${isEquipped ? 'equipped' : ''} ${isLocked ? 'locked' : ''}" 
                 data-category="${key}" data-id="${id}" data-lock-reason="${lockReason}" 
                 data-premium="${item.premium ? 'true' : 'false'}" data-name="${item.name}"
                 title="${titleParts.join(' — ')}">
                ${icon ? `<span class="cosmetic-icon">${icon}</span>` : ''}
                <span class="cosmetic-name">${item.name}</span>
                ${progressHtml}
                ${priceHtml}
                ${isLocked ? '<span class="lock-icon">🔒</span>' : ''}
            </div>
        `;
    });
    
    html += '</div></div>';
    return html;
}

// ============ PLAYER CARD COSMETICS ============

function getPlayerCardClasses(cosmetics) {
    if (!cosmetics) return '';
    const classes = [];
    if (cosmetics.card_border && cosmetics.card_border !== 'classic') {
        classes.push(`border-${cosmetics.card_border}`);
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
        star: '⭐',
        hunter: '⚔️',
        rank_gold: '🥇',
        rank_diamond: '🔷',
        dragon: '🐉',
        infinity: '♾️',
    };
    if (!badges[cosmetics.badge]) return '';
    
    // Special styling for admin infinity badge
    if (cosmetics.badge === 'infinity') {
        return `<span class="player-badge player-badge-infinity">${badges[cosmetics.badge]}</span>`;
    }
    return `<span class="player-badge">${badges[cosmetics.badge]}</span>`;
}

function getTitleHtml(cosmetics) {
    if (!cosmetics || !cosmetics.profile_title || cosmetics.profile_title === 'none') return '';
    const catalog = cosmeticsState.catalog;
    if (catalog && catalog.profile_titles && catalog.profile_titles[cosmetics.profile_title]) {
        const titleData = catalog.profile_titles[cosmetics.profile_title];
        const titleText = titleData.text || titleData.name || '';
        if (titleText) {
            const specialClass = cosmetics.profile_title === 'the_creator' ? ' title-the-creator' : '';
            return `<span class="player-title${specialClass}">${titleText}</span>`;
        }
    }
    return '';
}

// ============ VICTORY EFFECTS ============

function playVictoryEffect(effectId, targetEl = null) {
    const container = targetEl || document.getElementById('confetti-container');
    if (!container) return;
    
    const effect = effectId || 'classic';
    container.dataset.effect = effect;
    
    switch (effect) {
        case 'fireworks':
            createFireworksEffect(container);
            break;
        case 'gold_rain':
            createGoldRainEffect(container);
            break;
        case 'champion_crown':
            createChampionCrownEffect(container);
            break;
        case 'dragon_roar':
            createDragonRoarEffect(container);
            break;
        case 'aurora':
            createAuroraEffect(container);
            break;
        case 'sakura':
            createSakuraEffect(container);
            break;
        case 'big_bang':
            createBigBangEffect(container);
            break;
        default:
            if (typeof createConfetti === 'function') {
                createConfetti(container);
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

        const size = Math.floor(10 + Math.random() * 14);
        const opacity = (0.55 + Math.random() * 0.45).toFixed(2);
        const duration = (1.8 + Math.random() * 2.6).toFixed(2);
        const delay = (Math.random() * 0.8).toFixed(2);

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

function createChampionCrownEffect(container) {
    container.innerHTML = '';
    
    const crown = document.createElement('div');
    crown.className = 'champion-crown';
    crown.textContent = '👑';
    container.appendChild(crown);
    
    if (typeof createConfetti === 'function') {
        setTimeout(() => createConfetti(container), 500);
    }
    
    setTimeout(() => container.innerHTML = '', 4000);
}

function createDragonRoarEffect(container) {
    container.innerHTML = '';
    
    const dragon = document.createElement('div');
    dragon.className = 'dragon-fly';
    dragon.textContent = '🐉';
    container.appendChild(dragon);
    
    for (let i = 0; i < 10; i++) {
        setTimeout(() => {
            const fire = document.createElement('div');
            fire.className = 'firework';
            fire.style.left = (10 + i * 8) + '%';
            fire.style.top = (40 + Math.random() * 20) + '%';
            fire.style.background = '#ff4500';
            container.appendChild(fire);
            setTimeout(() => fire.remove(), 800);
        }, 300 + i * 150);
    }
    
    setTimeout(() => container.innerHTML = '', 3500);
}

function createAuroraEffect(container) {
    container.innerHTML = '';
    
    for (let i = 0; i < 3; i++) {
        const wave = document.createElement('div');
        wave.className = 'aurora-wave';
        wave.style.opacity = (0.2 + i * 0.1);
        wave.style.animationDelay = (i * 0.5) + 's';
        wave.style.background = i === 0 ? 
            'linear-gradient(180deg, rgba(0, 255, 127, 0.2), transparent)' :
            i === 1 ? 
            'linear-gradient(180deg, rgba(138, 43, 226, 0.2), transparent)' :
            'linear-gradient(180deg, rgba(0, 191, 255, 0.2), transparent)';
        container.appendChild(wave);
    }
    
    for (let i = 0; i < 20; i++) {
        const star = document.createElement('div');
        star.style.position = 'absolute';
        star.style.left = Math.random() * 100 + '%';
        star.style.top = Math.random() * 60 + '%';
        star.style.width = '3px';
        star.style.height = '3px';
        star.style.borderRadius = '50%';
        star.style.background = '#fff';
        star.style.animation = 'sparkleFloat 2s ease-in-out infinite';
        star.style.animationDelay = (Math.random() * 2) + 's';
        container.appendChild(star);
    }
    
    setTimeout(() => container.innerHTML = '', 4000);
}

function createSakuraEffect(container) {
    container.innerHTML = '';
    const height = container.clientHeight || window.innerHeight || 800;
    const fallDistance = (height + 40) + 'px';
    
    // Add ambient pink glow
    const glow = document.createElement('div');
    glow.className = 'sakura-glow';
    container.appendChild(glow);
    
    // Spawn cherry blossom petals - more petals for better visibility
    const petalCount = 70;
    const petals = ['🌸', '🌸', '🌸', '🌸', '💮', '🏵️']; // Cherry blossoms with occasional variations
    
    for (let i = 0; i < petalCount; i++) {
        const petal = document.createElement('div');
        petal.className = 'sakura-petal';
        petal.textContent = petals[Math.floor(Math.random() * petals.length)];
        
        const size = (1.2 + Math.random() * 1.2).toFixed(2);
        const duration = (3 + Math.random() * 3).toFixed(2);
        const delay = (Math.random() * 2).toFixed(2);
        const drift = (-80 + Math.random() * 160).toFixed(0);
        const rotation = (360 + Math.random() * 1080).toFixed(0);
        
        petal.style.left = Math.random() * 100 + '%';
        petal.style.setProperty('--size', `${size}rem`);
        petal.style.setProperty('--duration', `${duration}s`);
        petal.style.setProperty('--delay', `${delay}s`);
        petal.style.setProperty('--drift', `${drift}px`);
        petal.style.setProperty('--rotation', `${rotation}deg`);
        petal.style.setProperty('--fall-distance', fallDistance);
        
        container.appendChild(petal);
    }
    
    setTimeout(() => container.innerHTML = '', 6500);
}

function createBigBangEffect(container) {
    container.innerHTML = '';
    
    // Initial blinding flash
    const flash = document.createElement('div');
    flash.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: #ffffff;
        opacity: 0;
        animation: bigBangFlash 0.8s ease-out forwards;
        z-index: 100;
    `;
    container.appendChild(flash);
    
    // Singularity core - the point of creation
    setTimeout(() => {
        const singularity = document.createElement('div');
        singularity.className = 'big-bang-singularity';
        container.appendChild(singularity);
    }, 100);
    
    // Main expanding universe
    setTimeout(() => {
        const bang = document.createElement('div');
        bang.className = 'big-bang-effect';
        container.appendChild(bang);
    }, 200);
    
    // Cosmic strings - energy lines radiating outward
    const stringCount = 24;
    for (let i = 0; i < stringCount; i++) {
        setTimeout(() => {
            const string = document.createElement('div');
            string.className = 'big-bang-string';
            const angle = (360 / stringCount) * i;
            const length = 200 + Math.random() * 400;
            string.style.setProperty('--angle', `${angle}deg`);
            string.style.setProperty('--length', `${length}px`);
            string.style.setProperty('--delay', `${Math.random() * 0.3}s`);
            container.appendChild(string);
        }, 300 + i * 20);
    }
    
    // Expanding ring shockwaves
    const ringColors = ['#ffffff', '#ffd700', '#ff8c00', '#ff4500', '#ff00ff', '#8b00ff', '#00ffff', '#0066ff'];
    for (let i = 0; i < ringColors.length; i++) {
        setTimeout(() => {
            const ring = document.createElement('div');
            ring.style.cssText = `
                position: absolute;
                top: 50%;
                left: 50%;
                width: 10px;
                height: 10px;
                border-radius: 50%;
                border: ${4 - i * 0.3}px solid ${ringColors[i]};
                transform: translate(-50%, -50%);
                animation: bigBangRing ${2.5 + i * 0.2}s ease-out forwards;
                box-shadow: 0 0 20px ${ringColors[i]}, inset 0 0 20px ${ringColors[i]};
                opacity: ${1 - i * 0.08};
            `;
            container.appendChild(ring);
        }, 300 + i * 120);
    }
    
    // Galaxy spiral particles
    setTimeout(() => {
        const galaxyColors = ['#ffffff', '#ffd700', '#ff00ff', '#00ffff', '#ff4500', '#00ff88', '#ff66aa'];
        const particleCount = 150;
        
        for (let i = 0; i < particleCount; i++) {
            const particle = document.createElement('div');
            particle.className = 'big-bang-galaxy-particle';
            const color = galaxyColors[Math.floor(Math.random() * galaxyColors.length)];
            const size = 2 + Math.random() * 6;
            const rotation = 360 + Math.random() * 1080; // 1-3 full rotations
            const distance = 100 + Math.random() * 500;
            const duration = 2 + Math.random() * 2;
            const delay = Math.random() * 0.5;
            
            particle.style.setProperty('--color', color);
            particle.style.setProperty('--size', `${size}px`);
            particle.style.setProperty('--rotation', `${rotation}deg`);
            particle.style.setProperty('--distance', `${distance}px`);
            particle.style.setProperty('--duration', `${duration}s`);
            particle.style.setProperty('--delay', `${delay}s`);
            
            container.appendChild(particle);
        }
    }, 500);
    
    // Nebula clouds forming
    setTimeout(() => {
        const nebulaColors = [
            'rgba(138, 43, 226, 0.5)',  // Purple
            'rgba(0, 255, 255, 0.4)',    // Cyan
            'rgba(255, 0, 128, 0.4)',    // Pink
            'rgba(0, 100, 255, 0.4)',    // Blue
            'rgba(255, 100, 0, 0.3)',    // Orange
        ];
        
        for (let i = 0; i < nebulaColors.length; i++) {
            const nebula = document.createElement('div');
            nebula.className = 'big-bang-nebula';
            nebula.style.setProperty('--nebula-color', nebulaColors[i]);
            nebula.style.setProperty('--rotation', `${i * 72}deg`);
            nebula.style.setProperty('--duration', `${3 + i * 0.5}s`);
            nebula.style.setProperty('--delay', `${0.8 + i * 0.2}s`);
            nebula.style.setProperty('--final-size', `${300 + i * 100}px`);
            container.appendChild(nebula);
        }
    }, 600);
    
    // Star formation at the end - new stars being born
    setTimeout(() => {
        const starColors = ['#ffffff', '#ffd700', '#ff88aa', '#88ffff', '#ffaa44'];
        const starCount = 80;
        
        for (let i = 0; i < starCount; i++) {
            const star = document.createElement('div');
            star.className = 'big-bang-star';
            const color = starColors[Math.floor(Math.random() * starColors.length)];
            const size = 2 + Math.random() * 5;
            const angle = Math.random() * Math.PI * 2;
            const distance = 50 + Math.random() * 400;
            const tx = Math.cos(angle) * distance;
            const ty = Math.sin(angle) * distance;
            const duration = 2 + Math.random() * 1.5;
            const delay = Math.random() * 0.8;
            
            star.style.setProperty('--color', color);
            star.style.setProperty('--size', `${size}px`);
            star.style.setProperty('--tx', `${tx}px`);
            star.style.setProperty('--ty', `${ty}px`);
            star.style.setProperty('--duration', `${duration}s`);
            star.style.setProperty('--delay', `${delay}s`);
            
            container.appendChild(star);
        }
    }, 1200);
    
    // Final cosmic dust settling
    setTimeout(() => {
        const dustCount = 100;
        for (let i = 0; i < dustCount; i++) {
            const dust = document.createElement('div');
            const size = 1 + Math.random() * 3;
            const x = Math.random() * 100;
            const y = Math.random() * 100;
            const opacity = 0.3 + Math.random() * 0.5;
            const duration = 3 + Math.random() * 2;
            
            dust.style.cssText = `
                position: absolute;
                left: ${x}%;
                top: ${y}%;
                width: ${size}px;
                height: ${size}px;
                background: #ffffff;
                border-radius: 50%;
                opacity: 0;
                animation: cosmicDustSettle ${duration}s ease-out forwards;
                box-shadow: 0 0 ${size * 2}px rgba(255, 255, 255, ${opacity});
            `;
            container.appendChild(dust);
        }
    }, 2000);
    
    setTimeout(() => container.innerHTML = '', 7000);
}

// Add the cosmic dust settle animation via JS (since it's dynamic)
if (!document.getElementById('big-bang-dynamic-styles')) {
    const style = document.createElement('style');
    style.id = 'big-bang-dynamic-styles';
    style.textContent = `
        @keyframes cosmicDustSettle {
            0% { opacity: 0; transform: scale(0); }
            30% { opacity: 1; transform: scale(1.5); }
            100% { opacity: 0; transform: scale(0.5); }
        }
    `;
    document.head.appendChild(style);
}

// Initialize cosmetics
loadCosmeticsCatalog();

// Preview/test harness
document.getElementById('cosmetics-test-turn')?.addEventListener('click', () => {
    const card = document.getElementById('cosmetics-preview-card');
    if (!card) return;
    card.classList.toggle('current-turn');
    updateCosmeticsPreview();
});
document.getElementById('cosmetics-test-guess')?.addEventListener('click', () => {
    const guessForm = document.getElementById('cosmetics-guess-form');
    const c = cosmeticsState.userCosmetics || {};
    playGuessEffect(guessForm, c);
});
document.getElementById('cosmetics-test-elim')?.addEventListener('click', () => {
    const card = document.getElementById('cosmetics-preview-card');
    if (!card) return;
    // Briefly add elimination effect class
    card.classList.add('elim-glitch');
    setTimeout(() => card.classList.remove('elim-glitch'), 800);
});
document.getElementById('cosmetics-test-victory')?.addEventListener('click', () => {
    const c = cosmeticsState.userCosmetics || {};
    playVictoryEffect(c.victory_effect || 'classic', document.getElementById('cosmetics-victory-container'));
});
updateCosmeticsPreview();
