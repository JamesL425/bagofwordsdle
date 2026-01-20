"""
Singleplayer Routes
Handles singleplayer game creation and AI opponent management

This module handles:
- Creating singleplayer games
- Adding/removing AI opponents
- AI turn processing
- AI word selection and changes
"""

from typing import Tuple, Any, Optional, Dict, List

from ..data.game_repository import load_game, save_game
from ..services.ai_service import (
    create_ai_player,
    ai_select_secret_word,
    ai_choose_guess,
    ai_change_word,
    ai_update_memory,
    AI_DIFFICULTY_CONFIG,
)


# ============== CONFIGURATION ==============

# Valid AI difficulties
VALID_DIFFICULTIES = list(AI_DIFFICULTY_CONFIG.keys())

# Default AI difficulty
DEFAULT_DIFFICULTY = "rookie"

# Maximum AI players per game
MAX_AI_PLAYERS = 5


# ============== ROUTE HANDLERS ==============

def handle_singleplayer_routes(
    handler,
    method: str,
    path: str,
    body: Dict[str, Any],
    player_id: str,
    session_token: str,
) -> Optional[Tuple[int, Any]]:
    """
    Route handler for singleplayer endpoints.
    
    Args:
        handler: HTTP request handler instance
        method: HTTP method
        path: Request path
        body: Request body
        player_id: Validated player ID
        session_token: Session token for validation
        
    Returns:
        Tuple of (status_code, response_body) or None if not handled
    """
    
    # POST /api/singleplayer - Create singleplayer game
    if path == '/api/singleplayer' and method == 'POST':
        return _handle_create_singleplayer(body)
    
    # Routes that require a game code
    if not path.startswith('/api/singleplayer/'):
        return None
    
    parts = path.split('/')
    if len(parts) < 4:
        return None
    
    code = parts[3].upper()
    action = parts[4] if len(parts) > 4 else None
    
    # Load game
    game = load_game(code)
    if not game:
        return 404, {"detail": "Game not found"}
    
    if not game.get('is_singleplayer'):
        return 400, {"detail": "Not a singleplayer game"}
    
    # GET /api/singleplayer/{code} - Get game state
    if action is None and method == 'GET':
        return _handle_get_singleplayer_game(game, player_id)
    
    # POST /api/singleplayer/{code}/add-ai - Add AI player
    if action == 'add-ai' and method == 'POST':
        return _handle_add_ai(game, body, player_id)
    
    # POST /api/singleplayer/{code}/remove-ai - Remove AI player
    if action == 'remove-ai' and method == 'POST':
        return _handle_remove_ai(game, body, player_id)
    
    # POST /api/singleplayer/{code}/start - Start game
    if action == 'start' and method == 'POST':
        return _handle_start_singleplayer(game, player_id)
    
    # POST /api/singleplayer/{code}/ai-turn - Process AI turn
    if action == 'ai-turn' and method == 'POST':
        return _handle_ai_turn(game, player_id)
    
    # POST /api/singleplayer/{code}/ai-word-pick - AI picks word
    if action == 'ai-word-pick' and method == 'POST':
        return _handle_ai_word_pick(game, player_id)
    
    # POST /api/singleplayer/{code}/ai-word-change - AI changes word
    if action == 'ai-word-change' and method == 'POST':
        return _handle_ai_word_change(game, player_id)
    
    return None  # Not handled


# ============== HANDLER IMPLEMENTATIONS ==============

def _handle_create_singleplayer(body: Dict[str, Any]) -> Tuple[int, Any]:
    """Create a new singleplayer game."""
    from ..services.game_service import generate_game_code, generate_player_id
    from ..services.theme_service import select_random_theme_options
    import time
    
    difficulty = body.get('difficulty', DEFAULT_DIFFICULTY)
    if difficulty not in VALID_DIFFICULTIES:
        difficulty = DEFAULT_DIFFICULTY
    
    code = generate_game_code()
    
    # Create game
    game = {
        "code": code,
        "status": "lobby",
        "visibility": "private",
        "is_ranked": False,
        "is_singleplayer": True,
        "players": [],
        "max_players": 6,
        "min_players": 2,
        "theme": None,
        "theme_options": select_random_theme_options(3),
        "theme_votes": {},
        "history": [],
        "current_turn": 0,
        "host_id": None,
        "created_at": time.time(),
        "default_ai_difficulty": difficulty,
    }
    
    save_game(code, game)
    
    return 200, {
        "code": code,
        "default_difficulty": difficulty,
    }


def _handle_get_singleplayer_game(
    game: Dict[str, Any],
    player_id: str
) -> Tuple[int, Any]:
    """Get singleplayer game state."""
    # Build sanitized response
    players = []
    for p in game['players']:
        player_data = {
            "id": p['id'],
            "name": p['name'],
            "is_ai": p.get('is_ai', False),
            "difficulty": p.get('difficulty'),
            "is_alive": p.get('is_alive', True),
            "has_word": bool(p.get('secret_word')),
            "is_ready": p.get('is_ready', False),
            "cosmetics": p.get('cosmetics', {}),
        }
        
        # Include own secret word
        if p['id'] == player_id:
            player_data['secret_word'] = p.get('secret_word')
            player_data['word_pool'] = p.get('word_pool', [])
            player_data['can_change_word'] = p.get('can_change_word', False)
            player_data['word_change_options'] = p.get('word_change_options', [])
        
        # Include revealed words for eliminated players
        if not p.get('is_alive', True):
            player_data['secret_word'] = p.get('secret_word')
        
        players.append(player_data)
    
    current_player_id = None
    if game['players'] and game['status'] == 'playing':
        current_idx = game.get('current_turn', 0) % len(game['players'])
        current_player_id = game['players'][current_idx]['id']
    
    return 200, {
        "code": game['code'],
        "status": game['status'],
        "players": players,
        "theme": game.get('theme'),
        "theme_options": game.get('theme_options', []),
        "theme_votes": game.get('theme_votes', {}),
        "history": game.get('history', []),
        "current_player_id": current_player_id,
        "current_turn": game.get('current_turn', 0),
        "host_id": game.get('host_id'),
        "is_singleplayer": True,
        "waiting_for_word_change": game.get('waiting_for_word_change'),
        "winner": game.get('winner'),
    }


def _handle_add_ai(
    game: Dict[str, Any],
    body: Dict[str, Any],
    player_id: str
) -> Tuple[int, Any]:
    """Add an AI player to the game."""
    if game['status'] != 'lobby':
        return 400, {"detail": "Game already started"}
    
    # Check if requester is host
    if game.get('host_id') != player_id:
        return 403, {"detail": "Only host can add AI players"}
    
    # Count AI players
    ai_count = sum(1 for p in game['players'] if p.get('is_ai'))
    if ai_count >= MAX_AI_PLAYERS:
        return 400, {"detail": f"Maximum {MAX_AI_PLAYERS} AI players allowed"}
    
    if len(game['players']) >= game['max_players']:
        return 400, {"detail": "Game is full"}
    
    difficulty = body.get('difficulty', game.get('default_ai_difficulty', DEFAULT_DIFFICULTY))
    if difficulty not in VALID_DIFFICULTIES:
        difficulty = DEFAULT_DIFFICULTY
    
    # Create AI player
    existing_names = [p['name'] for p in game['players']]
    ai_player = create_ai_player(difficulty, existing_names)
    
    game['players'].append(ai_player)
    save_game(game['code'], game)
    
    return 200, {
        "ai_id": ai_player['id'],
        "ai_name": ai_player['name'],
        "difficulty": difficulty,
    }


def _handle_remove_ai(
    game: Dict[str, Any],
    body: Dict[str, Any],
    player_id: str
) -> Tuple[int, Any]:
    """Remove an AI player from the game."""
    if game['status'] != 'lobby':
        return 400, {"detail": "Game already started"}
    
    if game.get('host_id') != player_id:
        return 403, {"detail": "Only host can remove AI players"}
    
    ai_id = body.get('ai_id', '')
    if not ai_id:
        return 400, {"detail": "AI ID required"}
    
    # Find and remove AI
    original_count = len(game['players'])
    game['players'] = [p for p in game['players'] if p['id'] != ai_id or not p.get('is_ai')]
    
    if len(game['players']) == original_count:
        return 404, {"detail": "AI player not found"}
    
    save_game(game['code'], game)
    
    return 200, {"ok": True}


def _handle_start_singleplayer(
    game: Dict[str, Any],
    player_id: str
) -> Tuple[int, Any]:
    """Start a singleplayer game."""
    if game['status'] != 'lobby':
        return 400, {"detail": "Game already started"}
    
    if game.get('host_id') != player_id:
        return 403, {"detail": "Only host can start the game"}
    
    if len(game['players']) < game['min_players']:
        return 400, {"detail": f"Need at least {game['min_players']} players"}
    
    # Move to word selection phase
    game['status'] = 'word_selection'
    save_game(game['code'], game)
    
    return 200, {"status": "word_selection"}


def _handle_ai_turn(
    game: Dict[str, Any],
    player_id: str
) -> Tuple[int, Any]:
    """Process an AI player's turn."""
    if game['status'] != 'playing':
        return 400, {"detail": "Game not in playing state"}
    
    # Get current player
    current_idx = game.get('current_turn', 0) % len(game['players'])
    current_player = game['players'][current_idx]
    
    if not current_player.get('is_ai'):
        return 400, {"detail": "Current player is not AI"}
    
    if not current_player.get('is_alive', True):
        # Skip dead AI, advance turn
        _advance_turn(game)
        save_game(game['code'], game)
        return 200, {"skipped": True, "reason": "ai_eliminated"}
    
    # AI chooses a guess (always from theme words)
    guess_word = ai_choose_guess(current_player, game)
    
    if not guess_word:
        # AI couldn't choose, skip turn
        _advance_turn(game)
        save_game(game['code'], game)
        return 200, {"skipped": True, "reason": "no_valid_guess"}
    
    guess_lower = guess_word.lower()
    
    # Calculate similarities using pre-computed matrix
    similarities = {}
    eliminations = []
    matrix = game.get('theme_similarity_matrix')
    
    if not matrix:
        _advance_turn(game)
        save_game(game['code'], game)
        return 200, {"skipped": True, "reason": "no_similarity_matrix"}
    
    for p in game['players']:
        if not p.get('is_alive', True):
            continue
        
        secret_word = p.get('secret_word')
        if not secret_word:
            continue
        
        secret_lower = secret_word.lower()
        
        # Use pre-computed similarity matrix (guaranteed to have all theme words)
        sim = matrix.get(guess_lower, {}).get(secret_lower)
        if sim is not None:
            similarities[p['id']] = round(sim, 4)
            if guess_lower == secret_lower or sim >= 0.99:
                eliminations.append(p['id'])
                p['is_alive'] = False
    
    # Update AI memory
    ai_update_memory(current_player, guess_word, similarities, game)
    
    # Add to history
    game['history'].append({
        "type": "guess",
        "word": guess_word,
        "guesser_id": current_player['id'],
        "guesser_name": current_player['name'],
        "similarities": similarities,
        "eliminations": eliminations,
    })
    
    # Handle eliminations
    if eliminations and current_player.get('is_alive', True):
        current_player['can_change_word'] = True
        game['waiting_for_word_change'] = current_player['id']
    
    # Check for game over
    alive_players = [p for p in game['players'] if p.get('is_alive', True)]
    if len(alive_players) <= 1:
        game['status'] = 'finished'
        if alive_players:
            game['winner'] = {
                'id': alive_players[0]['id'],
                'name': alive_players[0]['name'],
            }
    elif not game.get('waiting_for_word_change'):
        _advance_turn(game)
    
    save_game(game['code'], game)
    
    return 200, {
        "guess": guess_word,
        "similarities": similarities,
        "eliminations": eliminations,
        "game_over": game['status'] == 'finished',
    }


def _handle_ai_word_pick(
    game: Dict[str, Any],
    player_id: str
) -> Tuple[int, Any]:
    """Have AI players pick their secret words."""
    if game['status'] != 'word_selection':
        return 400, {"detail": "Not in word selection phase"}
    
    ai_picks = []
    
    for player in game['players']:
        if not player.get('is_ai'):
            continue
        if player.get('secret_word'):
            continue  # Already has word
        
        word_pool = player.get('word_pool', [])
        if not word_pool:
            continue
        
        # AI selects word
        selected = ai_select_secret_word(player, word_pool)
        if selected:
            player['secret_word'] = selected
            player['is_ready'] = True
            ai_picks.append({
                'id': player['id'],
                'name': player['name'],
            })
    
    save_game(game['code'], game)
    
    return 200, {"ai_picks": ai_picks}


def _handle_ai_word_change(
    game: Dict[str, Any],
    player_id: str
) -> Tuple[int, Any]:
    """Have AI change their word after elimination."""
    waiting_id = game.get('waiting_for_word_change')
    if not waiting_id:
        return 400, {"detail": "No word change pending"}
    
    # Find the AI player
    ai_player = next((p for p in game['players'] if p['id'] == waiting_id), None)
    if not ai_player:
        return 404, {"detail": "Player not found"}
    
    if not ai_player.get('is_ai'):
        return 400, {"detail": "Player is not AI"}
    
    if not ai_player.get('can_change_word'):
        return 400, {"detail": "AI cannot change word"}
    
    # AI decides whether to change
    new_word = ai_change_word(ai_player, game)
    
    if new_word and new_word != ai_player.get('secret_word'):
        old_word = ai_player.get('secret_word')
        ai_player['secret_word'] = new_word
        
        game['history'].append({
            "type": "word_change",
            "player_id": ai_player['id'],
            "player_name": ai_player['name'],
            "changed": True,
        })
    
    # Clear word change state
    ai_player['can_change_word'] = False
    game['waiting_for_word_change'] = None
    
    # Advance turn
    _advance_turn(game)
    
    save_game(game['code'], game)
    
    return 200, {"changed": new_word != ai_player.get('secret_word')}


# ============== HELPERS ==============

def _advance_turn(game: Dict[str, Any]) -> None:
    """Advance to the next alive player's turn."""
    if not game['players']:
        return
    
    num_players = len(game['players'])
    current = game.get('current_turn', 0)
    
    # Find next alive player
    for i in range(num_players):
        next_idx = (current + 1 + i) % num_players
        if game['players'][next_idx].get('is_alive', True):
            game['current_turn'] = next_idx
            return
    
    # No alive players found (shouldn't happen)
    game['current_turn'] = (current + 1) % num_players

