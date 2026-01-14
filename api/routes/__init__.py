"""
Routes Module
Modular route handlers for the API
"""

from .games import handle_games_routes
from .auth import handle_auth_routes
from .users import handle_users_routes
from .leaderboard import handle_leaderboard_routes

__all__ = [
    "handle_games_routes",
    "handle_auth_routes",
    "handle_users_routes",
    "handle_leaderboard_routes",
]

