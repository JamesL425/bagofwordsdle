"""
Game Repository
CRUD operations for game data in Redis
"""

import json
from typing import Optional, Dict, Any, List
from .redis_client import get_redis

# Game expiry settings
GAME_EXPIRY_SECONDS = 7200  # 2 hours
LOBBY_EXPIRY_SECONDS = 600  # 10 minutes
PRESENCE_TTL_SECONDS = 15


def _game_key(code: str) -> str:
    """Generate Redis key for a game."""
    return f"game:{code}"


def _presence_key(code: str, kind: str) -> str:
    """Generate Redis key for presence tracking."""
    return f"presence:{kind}:{code}"


def save_game(code: str, game_data: dict) -> bool:
    """Save game data to Redis."""
    redis = get_redis()
    if not redis:
        return False
    try:
        redis.setex(_game_key(code), GAME_EXPIRY_SECONDS, json.dumps(game_data))
        return True
    except Exception as e:
        print(f"[DATA] Failed to save game {code}: {e}")
        return False


def load_game(code: str) -> Optional[dict]:
    """Load game data from Redis."""
    redis = get_redis()
    if not redis:
        return None
    try:
        data = redis.get(_game_key(code))
        return json.loads(data) if data else None
    except Exception as e:
        print(f"[DATA] Failed to load game {code}: {e}")
        return None


def delete_game(code: str) -> bool:
    """Delete game data from Redis."""
    redis = get_redis()
    if not redis:
        return False
    try:
        redis.delete(_game_key(code))
        return True
    except Exception as e:
        print(f"[DATA] Failed to delete game {code}: {e}")
        return False


def game_exists(code: str) -> bool:
    """Check if a game exists."""
    redis = get_redis()
    if not redis:
        return False
    try:
        return redis.exists(_game_key(code)) > 0
    except Exception:
        return False


def touch_presence(code: str, kind: str, member: str) -> bool:
    """Update presence for a member in a game."""
    redis = get_redis()
    if not redis:
        return False
    try:
        import time
        key = _presence_key(code, kind)
        now = int(time.time())
        cutoff = now - PRESENCE_TTL_SECONDS
        
        # Remove stale entries
        redis.zremrangebyscore(key, 0, cutoff)
        # Add/update this member
        redis.zadd(key, {member: now})
        redis.expire(key, PRESENCE_TTL_SECONDS * 2)
        return True
    except Exception as e:
        print(f"[DATA] Failed to touch presence: {e}")
        return False


def get_spectator_count(code: str) -> int:
    """Get count of active spectators for a game."""
    redis = get_redis()
    if not redis:
        return 0
    try:
        import time
        key = _presence_key(code, "spectator")
        now = int(time.time())
        cutoff = now - PRESENCE_TTL_SECONDS
        
        # Remove stale entries
        redis.zremrangebyscore(key, 0, cutoff)
        count = redis.zcard(key)
        return int(count) if count else 0
    except Exception:
        return 0


def get_public_lobbies(mode: Optional[str] = None) -> List[dict]:
    """Get list of public lobbies."""
    redis = get_redis()
    if not redis:
        return []
    
    try:
        # Scan for lobby keys
        lobbies = []
        cursor = 0
        while True:
            cursor, keys = redis.scan(cursor, match="game:*", count=100)
            for key in keys:
                try:
                    data = redis.get(key)
                    if not data:
                        continue
                    game = json.loads(data)
                    
                    # Filter criteria
                    if game.get("status") != "lobby":
                        continue
                    if game.get("visibility") != "public":
                        continue
                    if game.get("is_singleplayer"):
                        continue
                    
                    # Mode filter
                    if mode == "ranked" and not game.get("is_ranked"):
                        continue
                    if mode == "unranked" and game.get("is_ranked"):
                        continue
                    
                    lobbies.append({
                        "code": game.get("code"),
                        "player_count": len(game.get("players", [])),
                        "max_players": game.get("max_players", 4),
                        "is_ranked": game.get("is_ranked", False),
                    })
                except Exception:
                    continue
            
            if cursor == 0:
                break
        
        return lobbies
    except Exception as e:
        print(f"[DATA] Failed to get lobbies: {e}")
        return []


def get_spectateable_games() -> List[dict]:
    """Get list of games available for spectating."""
    redis = get_redis()
    if not redis:
        return []
    
    try:
        games = []
        cursor = 0
        while True:
            cursor, keys = redis.scan(cursor, match="game:*", count=100)
            for key in keys:
                try:
                    data = redis.get(key)
                    if not data:
                        continue
                    game = json.loads(data)
                    
                    # Only show active public games
                    if game.get("status") not in ("playing", "lobby"):
                        continue
                    if game.get("visibility") != "public":
                        continue
                    if game.get("is_singleplayer"):
                        continue
                    
                    code = game.get("code")
                    games.append({
                        "code": code,
                        "status": game.get("status"),
                        "player_count": len(game.get("players", [])),
                        "max_players": game.get("max_players", 4),
                        "is_ranked": game.get("is_ranked", False),
                        "spectator_count": get_spectator_count(code),
                    })
                except Exception:
                    continue
            
            if cursor == 0:
                break
        
        return games
    except Exception as e:
        print(f"[DATA] Failed to get spectateable games: {e}")
        return []

