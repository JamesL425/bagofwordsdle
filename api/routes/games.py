"""
Games Routes
Handles game CRUD and gameplay endpoints
"""

import json
from typing import Optional, Tuple, Any


def handle_games_routes(handler, method: str, path: str, body: dict) -> Tuple[int, Any]:
    """
    Route handler for game-related endpoints.
    
    Returns:
        Tuple of (status_code, response_body)
    """
    # Import here to avoid circular imports
    from ..data import load_game, save_game, get_public_lobbies, get_spectateable_games
    from ..services import (
        create_game, add_player, remove_player, 
        set_player_word, advance_turn, eliminate_player,
        check_game_over, get_game_for_player, get_embedding, cosine_similarity
    )
    
    # GET /api/lobbies - List public lobbies
    if path == "/api/lobbies" and method == "GET":
        mode = handler.get_query_param("mode")
        lobbies = get_public_lobbies(mode)
        return 200, {"lobbies": lobbies}
    
    # GET /api/spectateable - List spectateable games
    if path == "/api/spectateable" and method == "GET":
        games = get_spectateable_games()
        return 200, {"games": games}
    
    # POST /api/games - Create a new game
    if path == "/api/games" and method == "POST":
        visibility = body.get("visibility", "private")
        is_ranked = body.get("is_ranked", False)
        
        game = create_game(visibility=visibility, is_ranked=is_ranked)
        return 200, {"code": game["code"]}
    
    # Game-specific routes
    if path.startswith("/api/games/"):
        parts = path.split("/")
        if len(parts) >= 4:
            code = parts[3].upper()
            action = parts[4] if len(parts) > 4 else None
            
            return handle_game_action(handler, method, code, action, body)
    
    return None  # Not handled


def handle_game_action(handler, method: str, code: str, action: Optional[str], body: dict) -> Tuple[int, Any]:
    """Handle actions on a specific game."""
    from ..data import load_game, save_game, touch_presence, get_spectator_count
    from ..services import (
        add_player, remove_player, set_player_word,
        advance_turn, eliminate_player, check_game_over,
        get_game_for_player, get_embedding, cosine_similarity
    )
    
    game = load_game(code)
    if not game:
        return 404, {"detail": "Game not found"}
    
    # GET /api/games/:code - Get game state
    if action is None and method == "GET":
        player_id = handler.get_query_param("player_id")
        if player_id:
            return 200, get_game_for_player(game, player_id)
        return 200, {"code": game["code"], "status": game["status"]}
    
    # GET /api/games/:code/spectate - Get game for spectating
    if action == "spectate" and method == "GET":
        spectator_count = get_spectator_count(code)
        result = get_game_for_player(game, None)
        result["spectator_count"] = spectator_count
        return 200, result
    
    # POST /api/games/:code/spectate - Record spectator presence
    if action == "spectate" and method == "POST":
        spectator_id = body.get("spectator_id")
        if spectator_id:
            touch_presence(code, "spectator", spectator_id)
        return 200, {"ok": True}
    
    # POST /api/games/:code/join - Join a game
    if action == "join" and method == "POST":
        name = body.get("name", "").strip()
        if not name:
            return 400, {"detail": "Name is required"}
        
        if game["status"] != "lobby":
            return 400, {"detail": "Game already started"}
        
        if len(game["players"]) >= game["max_players"]:
            return 400, {"detail": "Game is full"}
        
        # Check for duplicate names
        if any(p["name"].lower() == name.lower() for p in game["players"]):
            return 400, {"detail": "Name already taken"}
        
        cosmetics = body.get("cosmetics", {})
        player = add_player(game, name, cosmetics)
        
        return 200, {
            "player_id": player["id"],
            "is_host": game["host_id"] == player["id"],
        }
    
    # POST /api/games/:code/leave - Leave a game
    if action == "leave" and method == "POST":
        player_id = body.get("player_id")
        if not player_id:
            return 400, {"detail": "Player ID required"}
        
        remove_player(game, player_id)
        # Return full game state for immediate UI update
        return 200, get_game_for_player(game, player_id)
    
    # POST /api/games/:code/start - Start the game (host only)
    if action == "start" and method == "POST":
        from ..services import batch_get_embeddings
        import threading
        
        player_id = body.get("player_id")
        if game["host_id"] != player_id:
            return 403, {"detail": "Only host can start the game"}
        
        if len(game["players"]) < game["min_players"]:
            return 400, {"detail": f"Need at least {game['min_players']} players"}
        
        game["status"] = "playing"
        
        # Set first player
        if game["players"]:
            game["current_player_id"] = game["players"][0]["id"]
            game["current_player_index"] = 0
        
        # Pre-cache theme embeddings in background thread
        # This warms the cache so lookups during gameplay are fast
        theme_words = game.get('theme', {}).get('words', [])
        if theme_words:
            def precache_embeddings():
                try:
                    batch_get_embeddings(theme_words)
                except Exception as e:
                    print(f"Theme embedding pre-cache error (start): {e}")
            threading.Thread(target=precache_embeddings, daemon=True).start()
        
        save_game(code, game)
        # Return full game state for immediate UI update
        return 200, get_game_for_player(game, player_id)
    
    # POST /api/games/:code/set-word - Set secret word
    if action == "set-word" and method == "POST":
        player_id = body.get("player_id")
        secret_word = body.get("secret_word", "").strip().lower()
        
        if not secret_word:
            return 400, {"detail": "Word is required"}
        
        player = next((p for p in game["players"] if p["id"] == player_id), None)
        if not player:
            return 404, {"detail": "Player not found"}
        
        # Ensure embedding is cached (should already be from /start)
        try:
            get_embedding(secret_word)
        except Exception as e:
            return 500, {"detail": f"Failed to get embedding: {str(e)}"}
        
        set_player_word(game, player_id, secret_word, None)  # No embedding needed
        # Return full game state for immediate UI update
        return 200, get_game_for_player(game, player_id)
    
    # POST /api/games/:code/guess - Submit a guess
    if action == "guess" and method == "POST":
        player_id = body.get("player_id")
        word = body.get("word", "").strip().lower()
        
        if not word:
            return 400, {"detail": "Word is required"}
        
        if game["current_player_id"] != player_id:
            return 400, {"detail": "Not your turn"}
        
        # Validate word is in theme (required - all guesses must be theme words)
        theme_words = game.get('theme', {}).get('words', [])
        theme_words_lower = {w.lower() for w in theme_words}
        if word not in theme_words_lower:
            return 400, {"detail": "Please select a word from the theme"}
        
        # Calculate similarities using pre-computed matrix
        similarities = {}
        eliminations = []
        matrix = game.get('theme_similarity_matrix')
        
        if not matrix:
            return 500, {"detail": "Game not properly initialized"}
        
        for player in game["players"]:
            if not player.get("is_alive", True):
                continue
            secret_word = player.get("secret_word")
            if not secret_word:
                continue
            
            secret_lower = secret_word.lower()
            
            # Use pre-computed similarity matrix (guaranteed to have all theme words)
            sim = matrix.get(word, {}).get(secret_lower)
            if sim is not None:
                similarities[player["id"]] = round(sim, 4)
                if sim >= 0.9:
                    eliminations.append(player["id"])
                    eliminate_player(game, player["id"])
        
        # Add to history
        guesser = next((p for p in game["players"] if p["id"] == player_id), None)
        game["history"].append({
            "type": "guess",
            "word": word,
            "guesser_id": player_id,
            "guesser_name": guesser["name"] if guesser else "Unknown",
            "similarities": similarities,
            "eliminations": eliminations,
        })
        
        # Check game over
        result = check_game_over(game)
        
        # Advance turn if game continues
        if not result:
            advance_turn(game)
        
        save_game(code, game)
        
        # Return full game state for immediate UI update
        # Include elimination info for toast notifications
        response = get_game_for_player(game, player_id)
        response["eliminations"] = [{"id": eid, "name": next((p["name"] for p in game["players"] if p["id"] == eid), "Unknown")} for eid in eliminations]
        response["game_over"] = result is not None
        return 200, response
    
    # POST /api/games/:code/vote - Vote for theme
    if action == "vote" and method == "POST":
        player_id = body.get("player_id")
        theme = body.get("theme")
        
        if not theme:
            return 400, {"detail": "Theme is required"}
        
        game["theme_votes"][player_id] = theme
        save_game(code, game)
        
        # Return full game state for immediate UI update
        return 200, get_game_for_player(game, player_id)
    
    return 404, {"detail": "Unknown action"}

