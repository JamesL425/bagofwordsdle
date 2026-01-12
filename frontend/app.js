/**
 * Bagofwordsdle - Client Application
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
    wordPool: null,  // This player's assigned words
    allThemeWords: null,  // Full theme word list
};

// DOM Elements
const screens = {
    home: document.getElementById('home-screen'),
    join: document.getElementById('join-screen'),
    lobby: document.getElementById('lobby-screen'),
    game: document.getElementById('game-screen'),
    gameover: document.getElementById('gameover-screen'),
    leaderboard: document.getElementById('leaderboard-screen'),
};

// Utility functions
function showScreen(screenName) {
    Object.values(screens).forEach(screen => screen.classList.remove('active'));
    screens[screenName].classList.add('active');
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
    const data = await response.json();
    
    if (!response.ok) {
        throw new Error(data.detail || 'An error occurred');
    }
    
    return data;
}

// Screen: Home
document.getElementById('create-game-btn').addEventListener('click', async () => {
    try {
        const data = await apiCall('/api/games', 'POST');
        gameState.code = data.code;
        gameState.theme = data.theme;
        
        // For creator, fetch their word pool
        const themeData = await apiCall(`/api/games/${data.code}/theme`);
        console.log('Theme data:', themeData);
        gameState.wordPool = themeData.word_pool;
        gameState.allThemeWords = themeData.theme.words;
        
        // Update UI for create mode
        document.getElementById('join-screen-title').textContent = 'Create Game';
        document.getElementById('join-submit-btn').textContent = 'Create & Join';
        document.getElementById('game-code').value = data.code;
        document.getElementById('game-code').readOnly = true;
        document.getElementById('game-code-group').style.display = 'none';
        
        // Show word pool (not full theme)
        displayWordPool(themeData.theme.name, themeData.word_pool);
        
        showScreen('join');
    } catch (error) {
        console.error('Create game error:', error);
        showError(error.message);
    }
});

document.getElementById('join-game-btn').addEventListener('click', () => {
    // Update UI for join mode
    document.getElementById('join-screen-title').textContent = 'Join Game';
    document.getElementById('join-submit-btn').textContent = 'Join';
    document.getElementById('game-code').value = '';
    document.getElementById('game-code').readOnly = false;
    document.getElementById('game-code-group').style.display = 'block';
    
    // Hide theme until code is entered
    document.getElementById('theme-display').classList.add('hidden');
    gameState.theme = null;
    gameState.wordPool = null;
    
    showScreen('join');
});

// Fetch theme when game code is entered
document.getElementById('game-code').addEventListener('blur', async () => {
    const code = document.getElementById('game-code').value.trim().toUpperCase();
    if (code.length === 6 && !document.getElementById('game-code').readOnly) {
        try {
            const data = await apiCall(`/api/games/${code}/theme`);
            gameState.theme = data.theme;
            gameState.wordPool = data.word_pool;
            gameState.allThemeWords = data.theme.words;
            gameState.code = code;
            displayWordPool(data.theme.name, data.word_pool);
        } catch (error) {
            document.getElementById('theme-display').classList.add('hidden');
        }
    }
});

function displayWordPool(themeName, wordPool) {
    console.log('displayWordPool called:', themeName, wordPool);
    
    document.getElementById('theme-name').textContent = themeName || 'Loading...';
    
    const wordsContainer = document.getElementById('theme-words');
    wordsContainer.innerHTML = '';
    
    if (!wordPool || wordPool.length === 0) {
        wordsContainer.innerHTML = '<span class="theme-word" style="color: var(--text-muted);">Generating words...</span>';
        document.getElementById('theme-display').classList.remove('hidden');
        return;
    }
    
    // Sort words alphabetically
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

function displayTheme(theme) {
    // Legacy function - now redirects to displayWordPool
    if (theme && theme.words) {
        displayWordPool(theme.name, theme.words);
    }
}

// Leaderboard
document.getElementById('show-leaderboard-btn').addEventListener('click', async () => {
    await loadLeaderboard();
    showScreen('leaderboard');
});

document.getElementById('back-from-leaderboard-btn').addEventListener('click', () => {
    showScreen('home');
});

async function loadLeaderboard() {
    try {
        const data = await apiCall('/api/leaderboard');
        const tbody = document.getElementById('leaderboard-body');
        const emptyMsg = document.getElementById('leaderboard-empty');
        
        tbody.innerHTML = '';
        
        if (!data.players || data.players.length === 0) {
            emptyMsg.classList.remove('hidden');
            return;
        }
        
        emptyMsg.classList.add('hidden');
        
        data.players.forEach((player, index) => {
            const rank = index + 1;
            const rankClass = rank <= 3 ? `rank-${rank}` : '';
            const winRate = player.games_played > 0 
                ? ((player.wins / player.games_played) * 100).toFixed(0) 
                : '0';
            const avgCloseness = player.avg_closeness 
                ? (player.avg_closeness * 100).toFixed(1) 
                : '0.0';
            
            const row = document.createElement('tr');
            row.innerHTML = `
                <td class="rank ${rankClass}">#${rank}</td>
                <td class="player-name">${player.name}</td>
                <td class="stat">${player.wins}</td>
                <td class="stat">${player.games_played}</td>
                <td class="stat win-rate">${winRate}%</td>
                <td class="stat closeness">${avgCloseness}%</td>
            `;
            tbody.appendChild(row);
        });
    } catch (error) {
        console.error('Failed to load leaderboard:', error);
        document.getElementById('leaderboard-empty').classList.remove('hidden');
        document.getElementById('leaderboard-empty').textContent = 'Failed to load leaderboard.';
    }
}

// Screen: Join
document.getElementById('back-home-btn').addEventListener('click', () => {
    gameState.code = null;
    showScreen('home');
});

document.getElementById('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const code = document.getElementById('game-code').value.trim().toUpperCase();
    const name = document.getElementById('player-name').value.trim();
    const secretWord = document.getElementById('secret-word').value.trim();
    
    if (!code || !name || !secretWord) {
        showError('Please fill in all fields');
        return;
    }
    
    try {
        const data = await apiCall(`/api/games/${code}/join`, 'POST', {
            name,
            secret_word: secretWord,
        });
        
        gameState.code = code;
        gameState.playerId = data.player_id;
        gameState.playerName = name;
        
        document.getElementById('player-name').value = '';
        document.getElementById('secret-word').value = '';
        
        showLobby();
    } catch (error) {
        showError(error.message);
    }
});

// Screen: Lobby
function showLobby() {
    document.getElementById('lobby-code').textContent = gameState.code;
    showScreen('lobby');
    startPolling();
}

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

function updateLobby(game) {
    const playersContainer = document.getElementById('lobby-players');
    playersContainer.innerHTML = '';
    
    game.players.forEach(player => {
        const isHost = player.id === game.host_id;
        const div = document.createElement('div');
        div.className = `player-item${isHost ? ' host' : ''}`;
        div.innerHTML = `
            <div class="player-avatar">${player.name.charAt(0).toUpperCase()}</div>
            <span>${player.name}${player.id === gameState.playerId ? ' (you)' : ''}</span>
        `;
        playersContainer.appendChild(div);
    });
    
    document.getElementById('player-count').textContent = game.players.length;
    
    // Update theme display in lobby
    if (game.theme && game.theme.name) {
        document.getElementById('lobby-theme-name').textContent = game.theme.name;
    }
    
    gameState.isHost = game.host_id === gameState.playerId;
    const startBtn = document.getElementById('start-game-btn');
    startBtn.disabled = !gameState.isHost || game.players.length < 3;
    startBtn.textContent = gameState.isHost ? 'Start Game' : 'Waiting for host...';
}

// Screen: Game
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
    
    updatePlayersGrid(game);
    updateTurnIndicator(game);
    
    const isMyTurn = game.current_player_id === gameState.playerId && myPlayer?.is_alive;
    const guessInput = document.getElementById('guess-input');
    const guessForm = document.getElementById('guess-form');
    guessInput.disabled = !isMyTurn;
    guessForm.querySelector('button').disabled = !isMyTurn;
    
    if (isMyTurn) {
        guessInput.focus();
    }
    
    updateHistory(game);
}

// Toggle wordlist visibility
document.getElementById('toggle-wordlist-btn').addEventListener('click', () => {
    const wordlist = document.getElementById('game-wordlist');
    const btn = document.getElementById('toggle-wordlist-btn');
    
    if (wordlist.classList.contains('hidden')) {
        // Populate and show
        wordlist.innerHTML = '';
        if (gameState.allThemeWords && gameState.allThemeWords.length > 0) {
            const sortedWords = [...gameState.allThemeWords].sort();
            sortedWords.forEach(word => {
                const wordEl = document.createElement('span');
                wordEl.className = 'theme-word';
                wordEl.textContent = word;
                wordlist.appendChild(wordEl);
            });
        }
        wordlist.classList.remove('hidden');
        btn.textContent = 'Hide Words';
    } else {
        wordlist.classList.add('hidden');
        btn.textContent = 'Show All Words';
    }
});

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
    
    game.players.forEach(player => {
        const isCurrentTurn = player.id === game.current_player_id;
        const isYou = player.id === gameState.playerId;
        
        const div = document.createElement('div');
        div.className = `player-card${isCurrentTurn ? ' current-turn' : ''}${!player.is_alive ? ' eliminated' : ''}${isYou ? ' is-you' : ''}`;
        
        // Check if this player recently changed their word
        const hasChangedWord = wordChangeAfterIndex[player.id] !== undefined;
        
        // Build top guesses HTML
        let topGuessesHtml = '';
        const topGuesses = topGuessesPerPlayer[player.id];
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
    
    document.getElementById('gameover-title').textContent = isWinner ? '🏆 You Won!' : 'Game Over!';
    document.getElementById('gameover-message').textContent = winner 
        ? `${winner.name} is the last one standing!`
        : 'The game has ended.';
    
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
    };
    showScreen('home');
});

// Polling
function startPolling() {
    if (gameState.pollingInterval) {
        clearInterval(gameState.pollingInterval);
    }
    
    pollGameState();
    gameState.pollingInterval = setInterval(pollGameState, 2000);
}

function stopPolling() {
    if (gameState.pollingInterval) {
        clearInterval(gameState.pollingInterval);
        gameState.pollingInterval = null;
    }
}

async function pollGameState() {
    if (!gameState.code || !gameState.playerId) return;
    
    try {
        const game = await apiCall(`/api/games/${gameState.code}?player_id=${gameState.playerId}`);
        
        if (game.status === 'waiting') {
            updateLobby(game);
        } else if (game.status === 'playing') {
            if (screens.lobby.classList.contains('active')) {
                showGame(game);
            } else {
                updateGame(game);
            }
        } else if (game.status === 'finished') {
            stopPolling();
            showGameOver(game);
        }
    } catch (error) {
        console.error('Polling error:', error);
    }
}

// Initialize
showScreen('home');
