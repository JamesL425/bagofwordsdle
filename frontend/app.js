/**
 * EMBEDDLE - Client Application
 */

const API_BASE = window.location.origin;

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
};

// ============ LOGIN SYSTEM ============
function initLogin() {
    const savedName = localStorage.getItem('embeddle_name');
    if (savedName) {
        setLoggedIn(savedName);
    }
}

function setLoggedIn(name) {
    gameState.playerName = name;
    localStorage.setItem('embeddle_name', name);
    
    document.getElementById('login-box').classList.add('hidden');
    document.getElementById('logged-in-box').classList.remove('hidden');
    document.getElementById('logged-in-name').textContent = name.toUpperCase();
}

function logout() {
    gameState.playerName = null;
    localStorage.removeItem('embeddle_name');
    
    document.getElementById('login-box').classList.remove('hidden');
    document.getElementById('logged-in-box').classList.add('hidden');
    document.getElementById('login-name').value = '';
}

document.getElementById('login-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const name = e.target.value.trim();
        if (name) {
            setLoggedIn(name);
        }
    }
});

document.getElementById('logout-btn').addEventListener('click', logout);

// DOM Elements
const screens = {
    home: document.getElementById('home-screen'),
    join: document.getElementById('join-screen'),
    lobby: document.getElementById('lobby-screen'),
    game: document.getElementById('game-screen'),
    gameover: document.getElementById('gameover-screen'),
};

// Utility functions
function showScreen(screenName) {
    Object.values(screens).forEach(screen => {
        if (screen) screen.classList.remove('active');
    });
    if (screens[screenName]) screens[screenName].classList.add('active');
}

function showError(message) {
    alert(message);
}

async function apiCall(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
    };
    
    if (body) {
        options.body = JSON.stringify(body);
    }
    
    const response = await fetch(`${API_BASE}${endpoint}`, options);
    
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
        throw new Error('Server error - please try again');
    }
    
    const data = await response.json();
    
    if (!response.ok) {
        throw new Error(data.detail || 'An error occurred');
    }
    
    return data;
}

// ============ HOME SCREEN ============

// Load open lobbies on page load and refresh
async function loadLobbies() {
    const container = document.getElementById('open-lobbies');
    try {
        const data = await apiCall('/api/lobbies');
        
        if (data.lobbies.length === 0) {
            container.innerHTML = '<p class="no-lobbies">No open lobbies. Create one!</p>';
        } else {
            container.innerHTML = data.lobbies.map(lobby => `
                <div class="lobby-item" data-code="${lobby.code}">
                    <div class="lobby-info-row">
                        <span class="lobby-code">${lobby.code}</span>
                        <span class="lobby-players">${lobby.player_count}/${lobby.max_players} players</span>
                    </div>
                    <button class="btn btn-small btn-secondary join-lobby-btn" data-code="${lobby.code}">Join</button>
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

function joinLobbyPrompt(code) {
    if (!gameState.playerName) {
        showError('Enter your callsign first (top right)');
        document.getElementById('login-name').focus();
        return;
    }
    joinLobby(code, gameState.playerName);
}

document.getElementById('create-game-btn').addEventListener('click', async () => {
    if (!gameState.playerName) {
        showError('Enter your callsign first (top right)');
        document.getElementById('login-name').focus();
        return;
    }
    
    try {
        const data = await apiCall('/api/games', 'POST');
        gameState.code = data.code;
        
        // Join the lobby we just created
        await joinLobby(data.code, gameState.playerName);
    } catch (error) {
        showError(error.message);
    }
});

document.getElementById('refresh-lobbies-btn')?.addEventListener('click', loadLobbies);

// Load lobbies on page load
loadLobbies();

// ============ JOIN LOBBY ============

async function joinLobby(code, name) {
    try {
        const data = await apiCall(`/api/games/${code}/join`, 'POST', { name });
        
        gameState.code = code;
        gameState.playerId = data.player_id;
        gameState.playerName = name;
        gameState.isHost = data.is_host;
        
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
                <span class="player-name">${p.name}${p.id === gameState.playerId ? ' (you)' : ''}</span>
                ${p.id === data.host_id ? '<span class="host-badge">Host</span>' : ''}
            </div>
        `).join('');
        
        document.getElementById('player-count').textContent = data.players.length;
        
        // Update theme voting
        updateThemeVoting(data.theme_options, data.theme_votes);
        
        // Show/hide host controls
        const hostControls = document.getElementById('host-controls');
        if (gameState.isHost) {
            hostControls.classList.remove('hidden');
            document.getElementById('start-game-btn').disabled = data.players.length < 2;
        } else {
            hostControls.classList.add('hidden');
        }
        
        // Check if game started
        if (data.status === 'playing') {
            clearInterval(gameState.pollingInterval);
            gameState.theme = data.theme;
            gameState.allThemeWords = data.theme?.words || [];
            showWordSelectionOrGame(data);
        }
    } catch (error) {
        console.error('Lobby update error:', error);
    }
}

function updateThemeVoting(options, votes) {
    const container = document.getElementById('theme-vote-options');
    if (!container || !options) return;
    
    container.innerHTML = options.map(theme => {
        const voteCount = votes[theme]?.length || 0;
        const isMyVote = votes[theme]?.includes(gameState.playerId);
        return `
            <button class="btn theme-vote-btn ${isMyVote ? 'voted' : ''}" data-theme="${theme}">
                <span class="theme-name">${theme}</span>
                <span class="vote-count">${voteCount} vote${voteCount !== 1 ? 's' : ''}</span>
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

function showWordSelectionOrGame(data) {
    const myPlayer = data.players.find(p => p.id === gameState.playerId);
    
    if (!myPlayer.secret_word) {
        // Need to pick a word
        showWordSelection(data);
    } else {
        // Already have a word, go to game
        gameState.wordPool = myPlayer.word_pool || [];
        showScreen('game');
        startGamePolling();
    }
}

function showWordSelection(data) {
    // Show join screen for word selection
    document.getElementById('join-screen-title').textContent = 'Pick Your Secret Word';
    document.getElementById('join-submit-btn').textContent = 'Start Playing';
    document.getElementById('game-code-group').style.display = 'none';
    document.getElementById('player-name').value = gameState.playerName;
    document.getElementById('player-name').readOnly = true;
    document.querySelector('#join-form .form-group:nth-child(2)').style.display = 'none';
    
    // Show word pool
    displayWordPool(data.theme?.name, data.theme?.words || []);
    
    showScreen('join');
}

// Screen: Join (for word selection after game starts)
document.getElementById('back-home-btn').addEventListener('click', () => {
    gameState.code = null;
    showScreen('home');
    loadLobbies();
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
    try {
        await apiCall(`/api/games/${gameState.code}/start`, 'POST', {
            player_id: gameState.playerId,
        });
    } catch (error) {
        showError(error.message);
    }
});

document.getElementById('leave-lobby-btn')?.addEventListener('click', () => {
    if (gameState.pollingInterval) {
        clearInterval(gameState.pollingInterval);
    }
    gameState.code = null;
    gameState.playerId = null;
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
            showWordSelection(game);
            return;
        }
        
        updateGame(game);
    } catch (error) {
        console.error('Game poll error:', error);
    }
}

function showGame(game) {
    showScreen('game');
    updateGame(game);
}

function updateGame(game) {
    const myPlayer = game.players.find(p => p.id === gameState.playerId);
    if (myPlayer) {
        document.getElementById('your-secret-word').textContent = myPlayer.secret_word || '???';
        
        const changeWordContainer = document.getElementById('change-word-container');
        const wordPoolOptions = document.getElementById('word-pool-options');
        
        if (myPlayer.can_change_word) {
            changeWordContainer.classList.remove('hidden');
            
            // Show word pool options (excluding guessed words)
            const guessedWords = new Set(game.history
                .filter(e => e.word)
                .map(e => e.word.toLowerCase()));
            
            const availableWords = (myPlayer.word_pool || gameState.wordPool || [])
                .filter(w => !guessedWords.has(w.toLowerCase()));
            
            if (wordPoolOptions) {
                wordPoolOptions.innerHTML = '';
                availableWords.sort().forEach(word => {
                    const wordEl = document.createElement('span');
                    wordEl.className = 'word-pool-option';
                    wordEl.textContent = word;
                    wordEl.addEventListener('click', () => {
                        document.getElementById('new-word-input').value = word;
                    });
                    wordPoolOptions.appendChild(wordEl);
                });
            }
        } else {
            changeWordContainer.classList.add('hidden');
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
    const isMyTurn = game.current_player_id === gameState.playerId && myPlayer?.is_alive && !game.waiting_for_word_change;
    const guessInput = document.getElementById('guess-input');
    const guessForm = document.getElementById('guess-form');
    guessInput.disabled = !isMyTurn;
    guessForm.querySelector('button').disabled = !isMyTurn;
    
    if (isMyTurn && !game.waiting_for_word_change) {
        guessInput.focus();
    }
    
    updateHistory(game);
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
        if (entry.type === 'word_change') return;  // Skip word change entries
        
        game.players.forEach(player => {
            // Skip if this guess was before the player's word change
            const changeIndex = wordChangeAfterIndex[player.id];
            if (changeIndex !== undefined && index < changeIndex) {
                return;  // This guess was before their word change, ignore it
            }
            
            const sim = entry.similarities[player.id];
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
        
        const div = document.createElement('div');
        div.className = `player-card${isCurrentTurn ? ' current-turn' : ''}${!player.is_alive ? ' eliminated' : ''}${isYou ? ' is-you' : ''}`;
        
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
        
        // Build top guesses HTML
        let topGuessesHtml = '';
        if (topGuesses && topGuesses.length > 0) {
            topGuessesHtml = '<div class="top-guesses">';
            topGuesses.forEach(guess => {
                const simClass = getSimilarityClass(guess.similarity);
                topGuessesHtml += `
                    <div class="top-guess">
                        <span class="guess-word">${guess.word}</span>
                        <span class="guess-sim ${simClass}">${(guess.similarity * 100).toFixed(0)}%</span>
                    </div>
                `;
            });
            topGuessesHtml += '</div>';
        } else if (hasChangedWord && player.is_alive) {
            topGuessesHtml = '<div class="word-changed-note">Word changed!</div>';
        }
        
        div.innerHTML = `
            ${dangerHtml}
            <div class="name">${player.name}${isYou ? ' (you)' : ''}</div>
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
        turnText.textContent = `Waiting for ${currentPlayer?.name || '...'} to guess...`;
    }
}

function updateHistory(game) {
    const historyLog = document.getElementById('history-log');
    historyLog.innerHTML = '';
    
    [...game.history].reverse().forEach(entry => {
        const div = document.createElement('div');
        div.className = 'history-entry';
        
        // Handle word change entries
        if (entry.type === 'word_change') {
            div.className = 'history-entry word-change-entry';
            div.innerHTML = `
                <div class="word-change-notice">
                    <span class="change-icon">🔄</span>
                    <span><strong>${entry.player_name}</strong> changed their secret word!</span>
                </div>
            `;
            historyLog.appendChild(div);
            return;
        }
        
        let simsHtml = '';
        game.players.forEach(player => {
            const sim = entry.similarities[player.id];
            if (sim !== undefined) {
                const simClass = getSimilarityClass(sim);
                simsHtml += `
                    <div class="sim-badge">
                        <span>${player.name}</span>
                        <span class="score ${simClass}">${(sim * 100).toFixed(0)}%</span>
                    </div>
                `;
            }
        });
        
        let eliminationHtml = '';
        if (entry.eliminations && entry.eliminations.length > 0) {
            const eliminatedNames = entry.eliminations.map(id => {
                const p = game.players.find(pl => pl.id === id);
                return p ? p.name : 'Unknown';
            });
            eliminationHtml = `<div class="elimination">Eliminated: ${eliminatedNames.join(', ')}</div>`;
        }
        
        div.innerHTML = `
            <div class="header">
                <span class="guesser">${entry.guesser_name}</span>
                <span class="word">"${entry.word}"</span>
            </div>
            <div class="similarities">${simsHtml}</div>
            ${eliminationHtml}
        `;
        historyLog.appendChild(div);
    });
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
    
    try {
        await apiCall(`/api/games/${gameState.code}/guess`, 'POST', {
            player_id: gameState.playerId,
            word,
        });
        guessInput.value = '';
    } catch (error) {
        showError(error.message);
    }
}

// Change word - also handle Enter key
document.getElementById('change-word-btn').addEventListener('click', async () => {
    await submitWordChange();
});

document.getElementById('new-word-input').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        await submitWordChange();
    }
});

// Skip word change button
document.getElementById('skip-word-change-btn').addEventListener('click', async () => {
    try {
        await apiCall(`/api/games/${gameState.code}/skip-word-change`, 'POST', {
            player_id: gameState.playerId,
        });
    } catch (error) {
        showError(error.message);
    }
});

async function submitWordChange() {
    const newWord = document.getElementById('new-word-input').value.trim();
    
    if (!newWord) {
        showError('Please enter a new word');
        return;
    }
    
    try {
        await apiCall(`/api/games/${gameState.code}/change-word`, 'POST', {
            player_id: gameState.playerId,
            new_word: newWord,
        });
        document.getElementById('new-word-input').value = '';
    } catch (error) {
        showError(error.message);
    }
}

// Screen: Game Over
function showGameOver(game) {
    showScreen('gameover');
    
    const winner = game.players.find(p => p.id === game.winner);
    const isWinner = game.winner === gameState.playerId;
    
    // Show trophy animation for winner
    const trophyIcon = document.getElementById('trophy-icon');
    if (trophyIcon) {
        trophyIcon.textContent = isWinner ? '🏆' : '🎮';
    }
    
    document.getElementById('gameover-title').textContent = isWinner ? 'Victory!' : 'Game Over!';
    document.getElementById('gameover-message').textContent = winner 
        ? `${winner.name} is the last one standing!`
        : 'The game has ended.';
    
    // Create confetti for winner
    if (isWinner) {
        createConfetti();
    }
    
    // Show all players' secret words
    const revealedWords = document.getElementById('revealed-words');
    revealedWords.innerHTML = '<h3>Secret Words Revealed</h3>';
    
    game.players.forEach(player => {
        const isWinnerPlayer = player.id === game.winner;
        const div = document.createElement('div');
        div.className = `revealed-word-item${isWinnerPlayer ? ' winner' : ''}${!player.is_alive ? ' eliminated' : ''}`;
        div.innerHTML = `
            <span class="player-name">${player.name}${isWinnerPlayer ? ' 👑' : ''}</span>
            <span class="player-word">${player.secret_word || '???'}</span>
        `;
        revealedWords.appendChild(div);
    });
}

function createConfetti() {
    const container = document.getElementById('confetti-container');
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
    gameState.code = null;
    gameState.playerId = null;
    showScreen('home');
    loadLobbies();
});

document.getElementById('play-again-btn').addEventListener('click', () => {
    stopPolling();
    gameState = {
        code: null,
        playerId: null,
        playerName: null,
        isHost: false,
        pollingInterval: null,
        theme: null,
        wordPool: null,
        allThemeWords: null,
        myVote: null,
    };
    showScreen('home');
    loadLobbies();
});

// Cleanup old polling functions
function stopPolling() {
    if (gameState.pollingInterval) {
        clearInterval(gameState.pollingInterval);
        gameState.pollingInterval = null;
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
        
        ctx.fillStyle = '#00ff41';
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

// Initialize
initLogin();
initMatrixRain();
showScreen('home');
