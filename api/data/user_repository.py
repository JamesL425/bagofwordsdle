"""
User Repository
CRUD operations for user data in Redis
"""

import json
import time
from typing import Optional, Dict, Any, List
from .redis_client import get_redis


def _user_key(user_id: str) -> str:
    """Generate Redis key for a user."""
    return f"user:{user_id}"


def _user_email_key(email: str) -> str:
    """Generate Redis key for email lookup."""
    return f"user_email:{email.lower()}"


def _stats_key(name: str) -> str:
    """Generate Redis key for player stats."""
    return f"stats:{name.lower()}"


def _weekly_leaderboard_key() -> str:
    """Generate Redis key for weekly leaderboard."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    # Week starts on Monday
    start = now - __import__('datetime').timedelta(days=now.weekday())
    return f"leaderboard:weekly:{start.strftime('%Y-%m-%d')}"


def get_user_by_id(user_id: str) -> Optional[dict]:
    """Get user by ID."""
    redis = get_redis()
    if not redis:
        return None
    try:
        data = redis.get(_user_key(user_id))
        return json.loads(data) if data else None
    except Exception as e:
        print(f"[DATA] Failed to get user {user_id}: {e}")
        return None


def get_user_by_email(email: str) -> Optional[dict]:
    """Get user by email."""
    redis = get_redis()
    if not redis:
        return None
    try:
        user_id = redis.get(_user_email_key(email))
        if not user_id:
            return None
        return get_user_by_id(user_id)
    except Exception as e:
        print(f"[DATA] Failed to get user by email: {e}")
        return None


def save_user(user: dict) -> bool:
    """Save user data to Redis."""
    redis = get_redis()
    if not redis:
        return False
    try:
        user_id = user.get("id")
        if not user_id:
            return False
        
        redis.set(_user_key(user_id), json.dumps(user))
        
        # Also update email index if present
        email = user.get("email")
        if email:
            redis.set(_user_email_key(email), user_id)
        
        return True
    except Exception as e:
        print(f"[DATA] Failed to save user: {e}")
        return False


def get_player_stats(name: str) -> dict:
    """Get player stats by name."""
    redis = get_redis()
    if not redis:
        return {}
    try:
        data = redis.get(_stats_key(name))
        return json.loads(data) if data else {}
    except Exception:
        return {}


def save_player_stats(name: str, stats: dict) -> bool:
    """Save player stats."""
    redis = get_redis()
    if not redis:
        return False
    try:
        redis.set(_stats_key(name), json.dumps(stats))
        return True
    except Exception as e:
        print(f"[DATA] Failed to save player stats: {e}")
        return False


def update_leaderboard(name: str, wins: int, weekly_wins: int = 0) -> bool:
    """Update leaderboard scores."""
    redis = get_redis()
    if not redis:
        return False
    try:
        # All-time leaderboard
        redis.zadd("leaderboard:alltime", {name.lower(): wins})
        
        # Weekly leaderboard
        if weekly_wins > 0:
            weekly_key = _weekly_leaderboard_key()
            redis.zadd(weekly_key, {name.lower(): weekly_wins})
            # Expire weekly leaderboard after 8 days
            redis.expire(weekly_key, 8 * 24 * 3600)
        
        return True
    except Exception as e:
        print(f"[DATA] Failed to update leaderboard: {e}")
        return False


def get_leaderboard(leaderboard_type: str = "alltime", limit: int = 50) -> List[dict]:
    """Get leaderboard entries."""
    redis = get_redis()
    if not redis:
        return []
    
    try:
        if leaderboard_type == "weekly":
            key = _weekly_leaderboard_key()
        else:
            key = "leaderboard:alltime"
        
        # Get top players by score (descending)
        results = redis.zrevrange(key, 0, limit - 1, withscores=True)
        
        players = []
        for name, score in results:
            stats = get_player_stats(name)
            players.append({
                "name": stats.get("display_name", name),
                "wins": int(score) if leaderboard_type == "alltime" else stats.get("wins", 0),
                "weekly_wins": int(score) if leaderboard_type == "weekly" else 0,
                "games_played": stats.get("games_played", 0),
            })
        
        return players
    except Exception as e:
        print(f"[DATA] Failed to get leaderboard: {e}")
        return []


def get_ranked_leaderboard(limit: int = 50) -> List[dict]:
    """Get ranked leaderboard by MMR."""
    redis = get_redis()
    if not redis:
        return []
    
    try:
        # Get top players by MMR
        results = redis.zrevrange("leaderboard:ranked", 0, limit - 1, withscores=True)
        
        players = []
        for name, mmr in results:
            stats = get_player_stats(name)
            players.append({
                "name": stats.get("display_name", name),
                "mmr": int(mmr),
                "peak_mmr": stats.get("peak_mmr", int(mmr)),
                "ranked_games": stats.get("ranked_games", 0),
                "ranked_wins": stats.get("ranked_wins", 0),
                "ranked_losses": stats.get("ranked_losses", 0),
            })
        
        return players
    except Exception as e:
        print(f"[DATA] Failed to get ranked leaderboard: {e}")
        return []

