/**
 * EMBEDDLE - Daily Ops System
 * Handles daily quests, currency, streaks, and shop purchases
 */

// Daily ops state
let dailyState = {
    panelOpen: false,
    wallet: { credits: 0 },
    quests: [],
    weeklyQuests: [],
    ownedCosmetics: {},
    date: '',
    loading: false,
    // Streak data
    streak: {
        streak_count: 0,
        streak_last_date: '',
        longest_streak: 0,
        streak_claimed_today: false,
    },
    streakCreditsEarned: 0,
    streakMilestoneBonus: 0,
    streakBroken: false,
    streakInfo: {
        current_daily_credits: 15,
        next_multiplier_day: null,
        next_multiplier_credits: 15,
        next_milestone_day: null,
        next_milestone_bonus: 0,
    },
};

// ============ PANEL TOGGLE ============

function toggleDailyPanel() {
    dailyState.panelOpen = !dailyState.panelOpen;
    const panel = document.getElementById('daily-panel');
    if (panel) {
        panel.classList.toggle('open', dailyState.panelOpen);
    }
    if (dailyState.panelOpen) {
        loadDaily();
    }
}

function closeDailyPanel() {
    dailyState.panelOpen = false;
    const panel = document.getElementById('daily-panel');
    if (panel) panel.classList.remove('open');
}

// ============ LOAD DAILY DATA ============

// Track previous quest states for completion detection
let previousQuestStates = {};

async function loadDaily() {
    if (typeof gameState === 'undefined' || !gameState.authToken) {
        renderDailyNoAuth();
        return;
    }
    
    if (dailyState.loading) return;
    dailyState.loading = true;
    
    try {
        const response = await fetch(`${API_BASE}/api/user/daily`, {
            headers: { 'Authorization': `Bearer ${gameState.authToken}` }
        });
        
        if (!response.ok) {
            throw new Error('Failed to load daily data');
        }
        
        const data = await response.json();
        
        // Store previous quest states before updating
        const oldQuests = [...(dailyState.quests || []), ...(dailyState.weeklyQuests || [])];
        oldQuests.forEach(q => {
            previousQuestStates[q.id] = {
                progress: q.progress || 0,
                target: q.target || 1,
                completed: (q.progress || 0) >= (q.target || 1),
                claimed: q.claimed || false
            };
        });
        
        dailyState.wallet = data.wallet || { credits: 0 };
        dailyState.quests = data.quests || [];
        dailyState.weeklyQuests = data.weekly_quests || [];
        dailyState.date = data.date || '';
        dailyState.ownedCosmetics = data.owned_cosmetics || {};
        
        // Streak data
        dailyState.streak = data.streak || {
            streak_count: 0,
            streak_last_date: '',
            longest_streak: 0,
            streak_claimed_today: false,
        };
        dailyState.streakCreditsEarned = data.streak_credits_earned || 0;
        dailyState.streakMilestoneBonus = data.streak_milestone_bonus || 0;
        dailyState.streakBroken = data.streak_broken || false;
        dailyState.streakInfo = data.streak_info || {
            current_daily_credits: 15,
            next_multiplier_day: null,
            next_multiplier_credits: 15,
            next_milestone_day: null,
            next_milestone_bonus: 0,
        };
        
        // Check for newly completed quests (for animation)
        const newlyCompletedQuests = [];
        const allQuests = [...dailyState.quests, ...dailyState.weeklyQuests];
        allQuests.forEach(q => {
            const prev = previousQuestStates[q.id];
            const nowCompleted = (q.progress || 0) >= (q.target || 1);
            const wasCompleted = prev?.completed || false;
            
            if (nowCompleted && !wasCompleted && !q.claimed) {
                newlyCompletedQuests.push(q.id);
            }
        });
        
        renderDailyPanel();
        
        // Trigger completion animations for newly completed quests
        if (newlyCompletedQuests.length > 0) {
            setTimeout(() => {
                triggerQuestCompletionAnimations(newlyCompletedQuests);
            }, 100);
        }
        
        // Update home stats bar
        if (typeof updateHomeStatsBar === 'function') {
            updateHomeStatsBar();
        }
        
        // Show streak notification if credits were earned
        if (dailyState.streakCreditsEarned > 0) {
            let msg = `🔥 Day ${dailyState.streak.streak_count} streak! +${dailyState.streakCreditsEarned} credits`;
            if (dailyState.streakMilestoneBonus > 0) {
                msg += ` +${dailyState.streakMilestoneBonus} milestone bonus!`;
            }
            showSuccess(msg);
        } else if (dailyState.streakBroken) {
            showError('Streak broken! Start a new streak today.');
        }
    } catch (e) {
        console.error('Failed to load daily data:', e);
        renderDailyError();
    } finally {
        dailyState.loading = false;
    }
}

// Trigger animations for newly completed quests
function triggerQuestCompletionAnimations(questIds) {
    questIds.forEach((questId, index) => {
        setTimeout(() => {
            const questCard = document.querySelector(`.daily-quest .quest-claim-btn[data-quest-id="${questId}"]`)?.closest('.daily-quest');
            if (questCard) {
                // Add pulse animation
                questCard.classList.add('just-completed');
                
                // Add bounce to status text
                const statusText = questCard.querySelector('.quest-status-text');
                if (statusText) {
                    statusText.classList.add('bounce-in');
                }
                
                // Create mini confetti on the quest card
                createQuestConfetti(questCard);
                
                // Play sound
                if (typeof playQuestCompleteSfx === 'function') {
                    playQuestCompleteSfx();
                }
                
                // Remove animation classes after they complete
                setTimeout(() => {
                    questCard.classList.remove('just-completed');
                    if (statusText) statusText.classList.remove('bounce-in');
                }, 800);
            }
        }, index * 200); // Stagger animations
    });
}

// Create mini confetti effect on quest card
function createQuestConfetti(questCard) {
    const rect = questCard.getBoundingClientRect();
    const container = document.createElement('div');
    container.className = 'quest-confetti';
    container.style.position = 'fixed';
    container.style.left = rect.left + 'px';
    container.style.top = rect.top + 'px';
    container.style.width = rect.width + 'px';
    container.style.height = rect.height + 'px';
    container.style.pointerEvents = 'none';
    container.style.zIndex = '9999';
    
    const colors = ['#00ff41', '#ffd700', '#00d4ff', '#ff6b6b', '#a855f7'];
    
    for (let i = 0; i < 15; i++) {
        const piece = document.createElement('div');
        piece.className = 'quest-confetti-piece';
        piece.style.left = (Math.random() * 100) + '%';
        piece.style.top = '50%';
        piece.style.background = colors[Math.floor(Math.random() * colors.length)];
        piece.style.animationDelay = (Math.random() * 0.3) + 's';
        container.appendChild(piece);
    }
    
    document.body.appendChild(container);
    setTimeout(() => container.remove(), 1200);
}

// ============ CLAIM QUEST ============

async function claimQuest(questId, questType = 'daily') {
    if (typeof gameState === 'undefined' || !gameState.authToken) {
        showError('Please sign in with Google to claim quests');
        return;
    }
    
    // Find the button and quest card for animation
    const btn = document.querySelector(`.quest-claim-btn[data-quest-id="${questId}"]`);
    const questCard = btn?.closest('.daily-quest');
    
    // Add claiming animation to button
    if (btn) {
        btn.classList.add('claiming');
        btn.textContent = '...';
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/user/daily/claim`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${gameState.authToken}`
            },
            body: JSON.stringify({ quest_id: questId, quest_type: questType })
        });
        
        if (!response.ok) {
            const err = await response.json();
            showError(err.detail || 'Failed to claim quest');
            if (btn) {
                btn.classList.remove('claiming');
                btn.textContent = 'CLAIM';
            }
            return;
        }
        
        const data = await response.json();
        const rewardCredits = data.reward_credits || 0;
        dailyState.wallet = data.wallet || dailyState.wallet;
        
        // Update the quest in local state
        const questList = questType === 'weekly' ? dailyState.weeklyQuests : dailyState.quests;
        const quest = questList.find(q => q.id === questId);
        if (quest) {
            quest.claimed = true;
        }
        
        // ============ CLAIM SUCCESS ANIMATION ============
        
        // Show success state on button
        if (btn) {
            btn.classList.remove('claiming');
            btn.classList.add('claimed-success');
            btn.textContent = '✓';
            
            // Create floating credits animation
            createFloatingCredits(btn, rewardCredits);
        }
        
        // Play quest complete sound
        if (typeof playQuestCompleteSfx === 'function') {
            playQuestCompleteSfx();
        }
        
        // Add claim complete animation to card
        if (questCard) {
            setTimeout(() => {
                questCard.classList.add('claim-complete');
            }, 300);
        }
        
        // Re-render panel after animation completes
        setTimeout(() => {
            renderDailyPanel();
        }, 800);
        
        showSuccess(`+${rewardCredits} credits!`);
    } catch (e) {
        console.error('Failed to claim quest:', e);
        showError('Failed to claim quest');
        if (btn) {
            btn.classList.remove('claiming');
            btn.textContent = 'CLAIM';
        }
    }
}

// Create floating credits animation
function createFloatingCredits(sourceEl, amount) {
    if (!sourceEl) return;
    
    const rect = sourceEl.getBoundingClientRect();
    const floater = document.createElement('div');
    floater.className = 'credits-float';
    floater.textContent = `+${amount}`;
    floater.style.position = 'fixed';
    floater.style.left = (rect.left + rect.width / 2) + 'px';
    floater.style.top = rect.top + 'px';
    floater.style.transform = 'translateX(-50%)';
    
    document.body.appendChild(floater);
    
    // Remove after animation
    setTimeout(() => floater.remove(), 1500);
}

// ============ PURCHASE COSMETIC ============

async function purchaseCosmetic(category, cosmeticId) {
    if (typeof gameState === 'undefined' || !gameState.authToken) {
        showError('Please sign in with Google to purchase cosmetics');
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/shop/purchase`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${gameState.authToken}`
            },
            body: JSON.stringify({ category, cosmetic_id: cosmeticId })
        });
        
        if (!response.ok) {
            const err = await response.json();
            showError(err.detail || 'Failed to purchase cosmetic');
            return;
        }
        
        const data = await response.json();
        dailyState.wallet = data.wallet || dailyState.wallet;
        dailyState.ownedCosmetics = data.owned_cosmetics || dailyState.ownedCosmetics;
        
        renderDailyPanel();
        
        // Refresh cosmetics panel so newly-owned item becomes equippable
        if (typeof loadUserCosmetics === 'function') {
            loadUserCosmetics();
        }
        if (typeof updateCosmeticsPanel === 'function') {
            updateCosmeticsPanel();
        }
        
        showSuccess('Cosmetic purchased!');
    } catch (e) {
        console.error('Failed to purchase cosmetic:', e);
        showError('Failed to purchase cosmetic');
    }
}

async function purchaseBundle(bundleId) {
    if (typeof gameState === 'undefined' || !gameState.authToken) {
        showError('Please sign in with Google to purchase bundles');
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/shop/purchase-bundle`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${gameState.authToken}`
            },
            body: JSON.stringify({ bundle_id: bundleId })
        });
        
        if (!response.ok) {
            const err = await response.json();
            showError(err.detail || 'Failed to purchase bundle');
            return;
        }
        
        const data = await response.json();
        dailyState.wallet = data.wallet || dailyState.wallet;
        dailyState.ownedCosmetics = data.owned_cosmetics || dailyState.ownedCosmetics;
        
        renderDailyPanel();
        
        // Refresh cosmetics panel so newly-owned items become equippable
        if (typeof loadUserCosmetics === 'function') {
            loadUserCosmetics();
        }
        if (typeof updateCosmeticsPanel === 'function') {
            updateCosmeticsPanel();
        }
        
        showSuccess('Bundle purchased! All items added to your collection.');
    } catch (e) {
        console.error('Failed to purchase bundle:', e);
        showError('Failed to purchase bundle');
    }
}

// ============ RENDER FUNCTIONS ============

function renderDailyNoAuth() {
    const creditsEl = document.getElementById('daily-credits');
    const streakEl = document.getElementById('daily-streak');
    const questsEl = document.getElementById('daily-quests');
    const shopEl = document.getElementById('daily-shop');
    
    if (creditsEl) creditsEl.textContent = '0';
    if (streakEl) streakEl.innerHTML = '<div class="streak-display"><span class="streak-icon">🔥</span><span class="streak-count">0</span></div>';
    if (questsEl) questsEl.innerHTML = '<div class="daily-empty">Sign in with Google to access daily quests.</div>';
    if (shopEl) shopEl.innerHTML = '<div class="daily-empty">Sign in with Google to access the shop.</div>';
}

function renderDailyError() {
    const questsEl = document.getElementById('daily-quests');
    const shopEl = document.getElementById('daily-shop');
    
    if (questsEl) questsEl.innerHTML = '<div class="daily-empty">Failed to load quests. Try again later.</div>';
    if (shopEl) shopEl.innerHTML = '<div class="daily-empty">Failed to load shop. Try again later.</div>';
}

function renderDailyPanel() {
    renderDailyCredits();
    renderDailyStreak();
    renderDailyQuests();
    renderWeeklyQuests();
    renderDailyShop();
}

function renderDailyCredits() {
    const creditsEl = document.getElementById('daily-credits');
    if (creditsEl) {
        creditsEl.textContent = dailyState.wallet.credits || 0;
    }
}

function renderDailyStreak() {
    const container = document.getElementById('daily-streak');
    if (!container) return;
    
    const streak = dailyState.streak;
    const info = dailyState.streakInfo;
    const count = streak.streak_count || 0;
    const longest = streak.longest_streak || 0;
    
    // Determine streak tier for styling
    let tierClass = 'streak-tier-1';
    if (count >= 100) tierClass = 'streak-tier-5';
    else if (count >= 30) tierClass = 'streak-tier-4';
    else if (count >= 14) tierClass = 'streak-tier-3';
    else if (count >= 7) tierClass = 'streak-tier-2';
    
    let html = `
        <div class="streak-display ${tierClass}">
            <div class="streak-main">
                <span class="streak-icon">🔥</span>
                <span class="streak-count">${count}</span>
                <span class="streak-label">day${count !== 1 ? 's' : ''}</span>
            </div>
            <div class="streak-details">
                <div class="streak-detail">
                    <span class="streak-detail-label">Daily bonus:</span>
                    <span class="streak-detail-value">+${info.current_daily_credits || 15}¢</span>
                </div>
                <div class="streak-detail">
                    <span class="streak-detail-label">Best streak:</span>
                    <span class="streak-detail-value">${longest} days</span>
                </div>
    `;
    
    // Show next milestone
    if (info.next_milestone_day) {
        const daysUntil = info.next_milestone_day - count;
        html += `
                <div class="streak-detail streak-milestone">
                    <span class="streak-detail-label">Next milestone:</span>
                    <span class="streak-detail-value">Day ${info.next_milestone_day} (+${info.next_milestone_bonus}¢)</span>
                </div>
                <div class="streak-progress-container">
                    <div class="streak-progress-bar">
                        <div class="streak-progress-fill" style="width: ${Math.min(100, (count / info.next_milestone_day) * 100)}%"></div>
                    </div>
                    <span class="streak-progress-text">${daysUntil} day${daysUntil !== 1 ? 's' : ''} to go</span>
                </div>
        `;
    }
    
    // Show next multiplier increase
    if (info.next_multiplier_day && info.next_multiplier_day !== info.next_milestone_day) {
        html += `
                <div class="streak-detail">
                    <span class="streak-detail-label">Day ${info.next_multiplier_day}:</span>
                    <span class="streak-detail-value">+${info.next_multiplier_credits}¢/day</span>
                </div>
        `;
    }
    
    html += `
            </div>
        </div>
    `;
    
    container.innerHTML = html;
}

function renderDailyQuests() {
    const container = document.getElementById('daily-quests');
    if (!container) return;
    
    if (!dailyState.quests || dailyState.quests.length === 0) {
        container.innerHTML = '<div class="daily-empty">No quests available.</div>';
        return;
    }
    
    let html = '';
    for (const quest of dailyState.quests) {
        const progress = quest.progress || 0;
        const target = quest.target || 1;
        const completed = progress >= target;
        const claimed = quest.claimed || false;
        const reward = quest.reward_credits || 0;
        const progressPct = Math.min(100, Math.round((progress / target) * 100));
        
        let statusClass = '';
        let statusText = '';
        let actionHtml = '';
        
        if (claimed) {
            statusClass = 'claimed';
            statusText = '✓ CLAIMED';
        } else if (completed) {
            statusClass = 'completed';
            statusText = 'READY';
            actionHtml = `<button class="btn btn-small btn-primary quest-claim-btn" data-quest-id="${quest.id}">CLAIM +${reward}</button>`;
        } else {
            statusClass = 'in-progress';
            statusText = `${progress}/${target}`;
        }
        
        html += `
            <div class="daily-quest ${statusClass}">
                <div class="quest-info">
                    <div class="quest-title">${escapeHtml(quest.title || 'Quest')}</div>
                    <div class="quest-desc">${escapeHtml(quest.description || '')}</div>
                    <div class="quest-progress-bar">
                        <div class="quest-progress-fill" style="width: ${progressPct}%"></div>
                    </div>
                </div>
                <div class="quest-status">
                    <span class="quest-status-text">${statusText}</span>
                    ${actionHtml}
                    ${!claimed && !completed ? `<span class="quest-reward">+${reward}</span>` : ''}
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
    
    // Add click handlers for claim buttons
    container.querySelectorAll('.quest-claim-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const questId = btn.dataset.questId;
            if (questId) claimQuest(questId);
        });
    });
}

function renderWeeklyQuests() {
    const container = document.getElementById('weekly-quests');
    if (!container) return;
    
    if (!dailyState.weeklyQuests || dailyState.weeklyQuests.length === 0) {
        container.innerHTML = '<div class="daily-empty">No weekly quests available.</div>';
        return;
    }
    
    let html = '';
    for (const quest of dailyState.weeklyQuests) {
        const progress = quest.progress || 0;
        const target = quest.target || 1;
        const completed = progress >= target;
        const claimed = quest.claimed || false;
        const reward = quest.reward_credits || 0;
        const progressPct = Math.min(100, Math.round((progress / target) * 100));
        
        let statusClass = '';
        let statusText = '';
        let actionHtml = '';
        
        if (claimed) {
            statusClass = 'claimed';
            statusText = '✓ CLAIMED';
        } else if (completed) {
            statusClass = 'completed';
            statusText = 'READY';
            actionHtml = `<button class="btn btn-small btn-primary quest-claim-btn weekly-quest-claim" data-quest-id="${quest.id}" data-quest-type="weekly">CLAIM +${reward}</button>`;
        } else {
            statusClass = 'in-progress';
            statusText = `${progress}/${target}`;
        }
        
        html += `
            <div class="daily-quest weekly-quest ${statusClass}">
                <div class="quest-info">
                    <div class="quest-title">${escapeHtml(quest.title || 'Quest')} <span class="quest-badge weekly">WEEKLY</span></div>
                    <div class="quest-desc">${escapeHtml(quest.description || '')}</div>
                    <div class="quest-progress-bar weekly-progress">
                        <div class="quest-progress-fill" style="width: ${progressPct}%"></div>
                    </div>
                </div>
                <div class="quest-status">
                    <span class="quest-status-text">${statusText}</span>
                    ${actionHtml}
                    ${!claimed && !completed ? `<span class="quest-reward weekly-reward">+${reward}</span>` : ''}
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
    
    // Add click handlers for weekly claim buttons
    container.querySelectorAll('.weekly-quest-claim').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const questId = btn.dataset.questId;
            if (questId) claimQuest(questId, 'weekly');
        });
    });
}

function renderDailyShop() {
    const container = document.getElementById('daily-shop');
    if (!container) return;
    
    // Get shop items from cosmetics catalog (items with price > 0)
    if (!cosmeticsState.catalog) {
        container.innerHTML = '<div class="daily-empty">Loading shop...</div>';
        return;
    }
    
    const shopItems = [];
    const categoryMap = {
        'card_borders': 'card_border',
        'card_backgrounds': 'card_background',
        'name_colors': 'name_color',
        'badges': 'badge',
        'elimination_effects': 'elimination_effect',
        'guess_effects': 'guess_effect',
        'turn_indicators': 'turn_indicator',
        'victory_effects': 'victory_effect',
        'matrix_colors': 'matrix_color',
        'particle_overlays': 'particle_overlay',
        'seasonal_themes': 'seasonal_theme',
        'alt_backgrounds': 'alt_background',
    };
    
    for (const [catalogKey, items] of Object.entries(cosmeticsState.catalog)) {
        // Skip bundles - handled separately
        if (catalogKey === 'bundles') continue;
        
        const categoryKey = categoryMap[catalogKey];
        if (!categoryKey) continue;
        
        for (const [itemId, item] of Object.entries(items)) {
            const price = parseInt(item.price || 0, 10);
            if (price > 0 && !item.premium) {
                const owned = isOwnedCosmetic(categoryKey, itemId);
                shopItems.push({
                    categoryKey,
                    catalogKey,
                    itemId,
                    item,
                    price,
                    owned,
                });
            }
        }
    }
    
    // Group by category for display
    const byCategory = {};
    for (const si of shopItems) {
        if (!byCategory[si.categoryKey]) {
            byCategory[si.categoryKey] = [];
        }
        byCategory[si.categoryKey].push(si);
    }
    
    const categoryLabels = {
        'card_border': 'Card Border',
        'card_background': 'Card Background',
        'name_color': 'Name Color',
        'badge': 'Badge',
        'elimination_effect': 'Elimination Effect',
        'guess_effect': 'Guess Effect',
        'turn_indicator': 'Turn Indicator',
        'victory_effect': 'Victory Effect',
        'matrix_color': 'Matrix Color',
        'particle_overlay': 'Particles',
        'seasonal_theme': 'Seasonal',
        'alt_background': 'Background',
    };
    
    let html = '';
    
    // Render bundles first (featured section) - ROTATING DAILY
    const bundles = cosmeticsState.catalog.bundles || {};
    const bundleIds = Object.keys(bundles);
    if (bundleIds.length > 0) {
        // Get today's featured bundles (rotate based on day of year)
        const today = new Date();
        const dayOfYear = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24));
        
        // Show 2 bundles per day, rotating through all bundles
        const bundlesPerDay = 2;
        const startIndex = (dayOfYear * bundlesPerDay) % bundleIds.length;
        
        // Select today's featured bundles
        const featuredBundleIds = [];
        for (let i = 0; i < Math.min(bundlesPerDay, bundleIds.length); i++) {
            const idx = (startIndex + i) % bundleIds.length;
            featuredBundleIds.push(bundleIds[idx]);
        }
        
        html += `<div class="shop-category shop-bundles"><div class="shop-category-label">🎁 TODAY'S BUNDLES (Save Credits!)</div>`;
        for (const bundleId of featuredBundleIds) {
            const bundle = bundles[bundleId];
            const price = parseInt(bundle.price || 0, 10);
            const value = parseInt(bundle.value || 0, 10);
            const canAfford = dailyState.wallet.credits >= price;
            const savings = value - price;
            
            // Check if user owns all items in bundle
            const contents = bundle.contents || {};
            const ownsAll = Object.entries(contents).every(([cat, id]) => isOwnedCosmetic(cat, id));
            
            let btnHtml = '';
            if (ownsAll) {
                btnHtml = '<span class="shop-owned">✓ OWNED</span>';
            } else if (canAfford) {
                btnHtml = `<button class="btn btn-small btn-primary shop-bundle-btn" data-bundle-id="${bundleId}">${price} ¢</button>`;
            } else {
                btnHtml = `<span class="shop-price locked">${price} ¢</span>`;
            }
            
            html += `
                <div class="shop-item bundle-item ${ownsAll ? 'owned' : ''} ${!canAfford && !ownsAll ? 'locked' : ''}">
                    <div class="shop-item-info">
                        <span class="shop-item-name">${escapeHtml(bundle.name || bundleId)}</span>
                        <span class="shop-item-desc">${escapeHtml(bundle.description || '')}</span>
                        ${savings > 0 ? `<span class="bundle-savings">Save ${savings} ¢</span>` : ''}
                    </div>
                    <div class="shop-item-action">
                        ${btnHtml}
                    </div>
                </div>
            `;
        }
        html += '</div>';
    }
    
    // Render regular items
    for (const [catKey, items] of Object.entries(byCategory)) {
        html += `<div class="shop-category"><div class="shop-category-label">${categoryLabels[catKey] || catKey}</div>`;
        for (const si of items) {
            const canAfford = dailyState.wallet.credits >= si.price;
            const icon = si.item.icon || '';
            
            let btnHtml = '';
            if (si.owned) {
                btnHtml = '<span class="shop-owned">✓ OWNED</span>';
            } else if (canAfford) {
                btnHtml = `<button class="btn btn-small btn-primary shop-buy-btn" data-category="${si.categoryKey}" data-id="${si.itemId}">${si.price} ¢</button>`;
            } else {
                btnHtml = `<span class="shop-price locked">${si.price} ¢</span>`;
            }
            
            html += `
                <div class="shop-item ${si.owned ? 'owned' : ''} ${!canAfford && !si.owned ? 'locked' : ''}">
                    <div class="shop-item-info">
                        ${icon ? `<span class="shop-item-icon">${icon}</span>` : ''}
                        <span class="shop-item-name">${escapeHtml(si.item.name || si.itemId)}</span>
                    </div>
                    <div class="shop-item-action">
                        ${btnHtml}
                    </div>
                </div>
            `;
        }
        html += '</div>';
    }
    
    if (html === '') {
        container.innerHTML = '<div class="daily-empty">No items in shop.</div>';
        return;
    }
    
    container.innerHTML = html;
    
    // Add click handlers for buy buttons
    container.querySelectorAll('.shop-buy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const category = btn.dataset.category;
            const id = btn.dataset.id;
            if (category && id) purchaseCosmetic(category, id);
        });
    });
    
    // Add click handlers for bundle buttons
    container.querySelectorAll('.shop-bundle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const bundleId = btn.dataset.bundleId;
            if (bundleId) purchaseBundle(bundleId);
        });
    });
}

function isOwnedCosmetic(categoryKey, cosmeticId) {
    const owned = dailyState.ownedCosmetics[categoryKey];
    if (!Array.isArray(owned)) return false;
    return owned.includes(cosmeticId);
}

// Helper to escape HTML (if not already defined)
function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ============ INIT ============

// Event listeners are attached in app.js to ensure consistent loading order

// Expose for external calls (e.g., after game ends)
window.loadDaily = loadDaily;
window.toggleDailyPanel = toggleDailyPanel;
window.closeDailyPanel = closeDailyPanel;
