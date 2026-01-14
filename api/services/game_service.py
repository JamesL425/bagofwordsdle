"""
Game Service
Core game logic and operations
"""

import secrets
import string
from typing import Optional, List, Dict, Any

from ..data import save_game, load_game, delete_game


def generate_game_code() -> str:
    """Generate a unique 6-character game code."""
    return ''.join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(6))


def generate_player_id() -> str:
    """Generate a unique 16-character player ID."""
    return secrets.token_hex(8)


def create_game(visibility: str = "private", is_ranked: bool = False, is_singleplayer: bool = False) -> dict:
    """Create a new game."""
    code = generate_game_code()
    
    game = {
        "code": code,
        "status": "lobby",
        "visibility": visibility,
        "is_ranked": is_ranked,
        "is_singleplayer": is_singleplayer,
        "players": [],
        "max_players": 4,
        "min_players": 3,
        "theme": None,
        "theme_options": [],
        "theme_votes": {},
        "history": [],
        "current_player_index": 0,
        "current_player_id": None,
        "all_words_set": False,
        "waiting_for_word_change": None,
        "host_id": None,
        "created_at": __import__('time').time(),
    }
    
    save_game(code, game)
    return game


def add_player(game: dict, name: str, cosmetics: dict = None) -> dict:
    """Add a player to a game."""
    player_id = generate_player_id()
    
    player = {
        "id": player_id,
        "name": name,
        "is_ai": False,
        "secret_word": None,
        "secret_embedding": None,
        "is_alive": True,
        "can_change_word": False,
        "word_pool": [],
        "is_ready": False,
        "cosmetics": cosmetics or {},
    }
    
    game["players"].append(player)
    
    # First player is host
    if len(game["players"]) == 1:
        game["host_id"] = player_id
    
    save_game(game["code"], game)
    return player


def remove_player(game: dict, player_id: str) -> bool:
    """Remove a player from a game."""
    game["players"] = [p for p in game["players"] if p["id"] != player_id]
    
    # Update host if needed
    if game["host_id"] == player_id and game["players"]:
        game["host_id"] = game["players"][0]["id"]
    
    save_game(game["code"], game)
    return True


def set_player_word(game: dict, player_id: str, word: str, embedding: List[float]) -> bool:
    """Set a player's secret word."""
    player = next((p for p in game["players"] if p["id"] == player_id), None)
    if not player:
        return False
    
    player["secret_word"] = word
    player["secret_embedding"] = embedding
    player["is_ready"] = True
    
    # Check if all players have words
    all_set = all(p.get("secret_word") for p in game["players"])
    game["all_words_set"] = all_set
    
    save_game(game["code"], game)
    return True


def advance_turn(game: dict) -> str:
    """Advance to the next player's turn."""
    alive_players = [p for p in game["players"] if p.get("is_alive", True)]
    if not alive_players:
        return None
    
    current_idx = game.get("current_player_index", 0)
    
    # Find next alive player
    for i in range(len(game["players"])):
        next_idx = (current_idx + 1 + i) % len(game["players"])
        next_player = game["players"][next_idx]
        if next_player.get("is_alive", True):
            game["current_player_index"] = next_idx
            game["current_player_id"] = next_player["id"]
            break
    
    save_game(game["code"], game)
    return game["current_player_id"]


def eliminate_player(game: dict, player_id: str) -> bool:
    """Eliminate a player from the game."""
    player = next((p for p in game["players"] if p["id"] == player_id), None)
    if not player:
        return False
    
    player["is_alive"] = False
    player["can_change_word"] = False
    
    save_game(game["code"], game)
    return True


def check_game_over(game: dict) -> Optional[dict]:
    """Check if the game is over and return winner info."""
    alive_players = [p for p in game["players"] if p.get("is_alive", True)]
    
    if len(alive_players) <= 1:
        game["status"] = "finished"
        winner = alive_players[0] if alive_players else None
        game["winner_id"] = winner["id"] if winner else None
        game["winner_name"] = winner["name"] if winner else None
        save_game(game["code"], game)
        return {
            "finished": True,
            "winner": winner,
        }
    
    return None


def get_game_for_player(game: dict, player_id: str) -> dict:
    """Get game state sanitized for a specific player."""
    is_player = any(p["id"] == player_id for p in game["players"])
    
    # Hide other players' secret words and embeddings
    sanitized_players = []
    for p in game["players"]:
        player_data = {
            "id": p["id"],
            "name": p["name"],
            "is_ai": p.get("is_ai", False),
            "is_alive": p.get("is_alive", True),
            "has_word": bool(p.get("secret_word")),
            "cosmetics": p.get("cosmetics", {}),
            "can_change_word": p.get("can_change_word", False),
        }
        
        # Include own secret word
        if p["id"] == player_id:
            player_data["secret_word"] = p.get("secret_word")
            player_data["word_pool"] = p.get("word_pool", [])
            player_data["word_change_options"] = p.get("word_change_options", [])
        
        # Include revealed words for eliminated players
        if not p.get("is_alive", True):
            player_data["secret_word"] = p.get("secret_word")
        
        sanitized_players.append(player_data)
    
    return {
        "code": game["code"],
        "status": game["status"],
        "players": sanitized_players,
        "theme": game.get("theme"),
        "theme_options": game.get("theme_options", []),
        "theme_votes": game.get("theme_votes", {}),
        "history": game.get("history", []),
        "current_player_id": game.get("current_player_id"),
        "all_words_set": game.get("all_words_set", False),
        "waiting_for_word_change": game.get("waiting_for_word_change"),
        "is_host": game.get("host_id") == player_id,
        "is_ranked": game.get("is_ranked", False),
        "is_singleplayer": game.get("is_singleplayer", False),
    }

