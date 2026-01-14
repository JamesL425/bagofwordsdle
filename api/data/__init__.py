"""
Data Layer Module
Re-exports all data access modules
"""

from .redis_client import get_redis, is_redis_configured
from .game_repository import (
    save_game,
    load_game,
    delete_game,
    game_exists,
    touch_presence,
    get_spectator_count,
    get_public_lobbies,
    get_spectateable_games,
)
from .user_repository import (
    get_user_by_id,
    get_user_by_email,
    save_user,
    get_player_stats,
    save_player_stats,
    update_leaderboard,
    get_leaderboard,
    get_ranked_leaderboard,
)

__all__ = [
    # Redis client
    "get_redis",
    "is_redis_configured",
    # Game repository
    "save_game",
    "load_game",
    "delete_game",
    "game_exists",
    "touch_presence",
    "get_spectator_count",
    "get_public_lobbies",
    "get_spectateable_games",
    # User repository
    "get_user_by_id",
    "get_user_by_email",
    "save_user",
    "get_player_stats",
    "save_player_stats",
    "update_leaderboard",
    "get_leaderboard",
    "get_ranked_leaderboard",
]

