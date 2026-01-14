/**
 * EMBEDDLE - Cosmetics System
 * Handles cosmetic effects, backgrounds, and visual customizations
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
            applyPersonalCosmetics();
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
        if (isShopLocked) titleParts.push(`Shop: ${price} credits`);
        
        // Show price badge for shop items
        let priceHtml = '';
        if (isShopItem && !isOwned && !(cosmeticsState.isAdmin || cosmeticsState.unlockAll)) {
            priceHtml = `<span class="cosmetic-price">${price}¢</span>`;
        }
        
        html += `
            <div class="cosmetic-option ${isEquipped ? 'equipped' : ''} ${isLocked ? 'locked' : ''}" 
                 data-category="${key}" data-id="${id}" data-lock-reason="${lockReason}" title="${titleParts.join(' — ')}">
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
        sunset: '#ff6b35',
    };
    document.documentElement.style.setProperty('--matrix-color', colors[colorId] || colors.classic);
}

function applyAltBackground(bgId) {
    document.body.dataset.background = bgId;
}

function applyParticleOverlay(particleId) {
    document.body.dataset.particles = particleId;
}

// ============ SEASONAL: SPOOKY FLOATING GHOST ============

let spookyGhostAnim = {
    rafId: null,
    current: null,
    next: null,
    switchAt: 0,
    blendStart: 0,
    blendMs: 0,
};

function prefersReducedMotion() {
    try {
        return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
        return false;
    }
}

function rand(min, max) {
    return min + Math.random() * (max - min);
}

function easeInOutSine(t) {
    // 0..1 -> 0..1
    return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

function getSpookyGhostSizePx() {
    const w = window.innerWidth || 800;
    const h = window.innerHeight || 600;
    const minDim = Math.min(w, h);
    // Responsive size: big enough to read as "ghost", but not overwhelming
    return Math.max(160, Math.min(320, Math.round(minDim * 0.28)));
}

function makeGhostParams(startMs) {
    const twoPi = Math.PI * 2;
    const w1 = rand(0.6, 0.85);
    return {
        startMs,
        // Smooth but "random" curve comes from mixing 2 sine waves with random speeds/phases
        w1,
        w2: 1 - w1,
        sx1: rand(0.02, 0.05) * twoPi,  // rad/sec
        sx2: rand(0.06, 0.13) * twoPi,
        sy1: rand(0.02, 0.05) * twoPi,
        sy2: rand(0.06, 0.13) * twoPi,
        phx1: rand(0, twoPi),
        phx2: rand(0, twoPi),
        phy1: rand(0, twoPi),
        phy2: rand(0, twoPi),
        // Independent bob/tilt for "cute float"
        sRot: rand(0.18, 0.32) * twoPi,
        sRot2: rand(0.06, 0.12) * twoPi,
        pRot: rand(0, twoPi),
        pRot2: rand(0, twoPi),
        sScale: rand(0.14, 0.26) * twoPi,
        pScale: rand(0, twoPi),
    };
}

function ghostPose(params, ts) {
    const w = window.innerWidth || 800;
    const h = window.innerHeight || 600;
    const size = getSpookyGhostSizePx();
    const margin = 18; // keep away from edges
    const ax = Math.max(0, (w - size) / 2 - margin);
    const ay = Math.max(0, (h - size) / 2 - margin);

    const t = Math.max(0, (ts - params.startMs) / 1000);
    const xNorm = params.w1 * Math.sin(params.sx1 * t + params.phx1) + params.w2 * Math.sin(params.sx2 * t + params.phx2);
    const yNorm = params.w1 * Math.sin(params.sy1 * t + params.phy1) + params.w2 * Math.sin(params.sy2 * t + params.phy2);

    const x = (w / 2) + ax * xNorm;
    const y = (h / 2) + ay * yNorm;

    const rot = (6 * Math.sin(params.sRot * t + params.pRot)) + (2.5 * Math.sin(params.sRot2 * t + params.pRot2));
    const scale = 1 + (0.06 * Math.sin(params.sScale * t + params.pScale));

    return { x, y, rot, scale, size };
}

function setSpookyGhostCSS({ x, y, rot, scale, size }) {
    document.body.style.setProperty('--spooky-ghost-x', `${x}px`);
    document.body.style.setProperty('--spooky-ghost-y', `${y}px`);
    document.body.style.setProperty('--spooky-ghost-rot', `${rot}deg`);
    document.body.style.setProperty('--spooky-ghost-scale', `${scale}`);
    document.body.style.setProperty('--spooky-ghost-size', `${size}px`);
}

function clearSpookyGhostCSS() {
    document.body.style.removeProperty('--spooky-ghost-x');
    document.body.style.removeProperty('--spooky-ghost-y');
    document.body.style.removeProperty('--spooky-ghost-rot');
    document.body.style.removeProperty('--spooky-ghost-scale');
    document.body.style.removeProperty('--spooky-ghost-size');
}

function stopSpookyGhostAnimation() {
    if (spookyGhostAnim.rafId) {
        cancelAnimationFrame(spookyGhostAnim.rafId);
    }
    spookyGhostAnim.rafId = null;
    spookyGhostAnim.current = null;
    spookyGhostAnim.next = null;
    spookyGhostAnim.switchAt = 0;
    spookyGhostAnim.blendStart = 0;
    spookyGhostAnim.blendMs = 0;
    clearSpookyGhostCSS();
}

function startSpookyGhostAnimation() {
    // Avoid double loops
    if (spookyGhostAnim.rafId) return;

    // Respect reduced motion: show a static ghost and stop.
    if (prefersReducedMotion()) {
        const w = window.innerWidth || 800;
        const h = window.innerHeight || 600;
        const size = getSpookyGhostSizePx();
        setSpookyGhostCSS({ x: w * 0.72, y: h * 0.22, rot: 0, scale: 1, size });
        return;
    }

    const now = performance.now();
    spookyGhostAnim.current = makeGhostParams(now);
    spookyGhostAnim.switchAt = now + rand(24000, 42000);

    const tick = (ts) => {
        if (document.body.dataset.seasonal !== 'spooky') {
            stopSpookyGhostAnimation();
            return;
        }

        // If user flips reduced-motion on mid-flight, stop animating.
        if (prefersReducedMotion()) {
            stopSpookyGhostAnimation();
            const w = window.innerWidth || 800;
            const h = window.innerHeight || 600;
            const size = getSpookyGhostSizePx();
            setSpookyGhostCSS({ x: w * 0.72, y: h * 0.22, rot: 0, scale: 1, size });
            return;
        }

        // Periodically reroll the curve, but blend smoothly so it never teleports.
        if (!spookyGhostAnim.next && ts >= spookyGhostAnim.switchAt) {
            spookyGhostAnim.next = makeGhostParams(ts);
            spookyGhostAnim.blendStart = ts;
            spookyGhostAnim.blendMs = rand(4500, 7500);
        }

        const p1 = spookyGhostAnim.current;
        const pose1 = ghostPose(p1, ts);

        let pose = pose1;
        if (spookyGhostAnim.next) {
            const tBlend = Math.min(1, Math.max(0, (ts - spookyGhostAnim.blendStart) / spookyGhostAnim.blendMs));
            const a = easeInOutSine(tBlend);
            const pose2 = ghostPose(spookyGhostAnim.next, ts);
            pose = {
                x: pose1.x * (1 - a) + pose2.x * a,
                y: pose1.y * (1 - a) + pose2.y * a,
                rot: pose1.rot * (1 - a) + pose2.rot * a,
                scale: pose1.scale * (1 - a) + pose2.scale * a,
                size: pose1.size * (1 - a) + pose2.size * a,
            };

            if (tBlend >= 1) {
                spookyGhostAnim.current = spookyGhostAnim.next;
                spookyGhostAnim.next = null;
                spookyGhostAnim.switchAt = ts + rand(24000, 42000);
                spookyGhostAnim.blendStart = 0;
                spookyGhostAnim.blendMs = 0;
            }
        }

        setSpookyGhostCSS(pose);
        spookyGhostAnim.rafId = requestAnimationFrame(tick);
    };

    spookyGhostAnim.rafId = requestAnimationFrame(tick);
}

function applySeasonalTheme(seasonalId) {
    document.body.dataset.seasonal = seasonalId;
    if (seasonalId === 'spooky') {
        startSpookyGhostAnimation();
    } else {
        stopSpookyGhostAnimation();
    }
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
        star: '⭐',
        rookie: '🔰',
        hunter: '⚔️',
        assassin: '🗡️',
        executioner: '☠️',
        victor: '🎖️',
        champion: '🏆',
        legend: '👑',
        veteran: '🎗️',
        rank_bronze: '🥉',
        rank_silver: '🥈',
        rank_gold: '🥇',
        rank_platinum: '💠',
        rank_diamond: '🔷',
        skull: '💀',
        ghost: '👻',
        rocket: '🚀',
        // Shop badges
        hacker: '💻',
        ghost_protocol: '🕵️',
        overlord: '🦅',
        dragon: '🐉',
        alien: '👽',
        // Legacy v1 IDs (kept so old game states still render)
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
        case 'supernova':
            createSupernovaEffect(container);
            break;
        case 'champion_crown':
            createChampionCrownEffect(container);
            break;
        case 'nuclear':
            createNuclearEffect(container);
            break;
        case 'matrix_cascade':
            createMatrixCascadeEffect(container);
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

function createSupernovaEffect(container) {
    container.innerHTML = '';
    const nova = document.createElement('div');
    nova.className = 'supernova';
    container.appendChild(nova);
    setTimeout(() => container.innerHTML = '', 2000);
}

function createChampionCrownEffect(container) {
    container.innerHTML = '';
    
    // Create crown emoji that descends
    const crown = document.createElement('div');
    crown.className = 'champion-crown';
    crown.textContent = '👑';
    container.appendChild(crown);
    
    // Also add some confetti
    if (typeof createConfetti === 'function') {
        setTimeout(() => createConfetti(container), 500);
    }
    
    setTimeout(() => container.innerHTML = '', 4000);
}

function createNuclearEffect(container) {
    container.innerHTML = '';
    
    // Create mushroom cloud stem
    const stem = document.createElement('div');
    stem.className = 'nuclear-stem';
    container.appendChild(stem);
    
    // Create mushroom cloud top
    const cloud = document.createElement('div');
    cloud.className = 'nuclear-cloud';
    container.appendChild(cloud);
    
    setTimeout(() => container.innerHTML = '', 2500);
}

function createMatrixCascadeEffect(container) {
    container.innerHTML = '';
    const height = container.clientHeight || window.innerHeight || 800;
    const fallDistance = (height + 40) + 'px';
    const chars = '01アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン';
    
    for (let i = 0; i < 100; i++) {
        const char = document.createElement('div');
        char.className = 'matrix-cascade-char';
        char.textContent = chars[Math.floor(Math.random() * chars.length)];
        
        const duration = (1.5 + Math.random() * 2).toFixed(2);
        const opacity = (0.5 + Math.random() * 0.5).toFixed(2);
        const delay = (Math.random() * 1).toFixed(2);
        
        char.style.left = Math.random() * 100 + '%';
        char.style.setProperty('--dur', `${duration}s`);
        char.style.setProperty('--opacity', opacity);
        char.style.setProperty('--fall-distance', fallDistance);
        char.style.animationDelay = `${delay}s`;
        
        container.appendChild(char);
    }
    
    setTimeout(() => container.innerHTML = '', 4000);
}

// Initialize cosmetics - attach directly since script is loaded at end of body
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
