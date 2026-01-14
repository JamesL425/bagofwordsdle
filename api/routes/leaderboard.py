"""
Leaderboard Routes
Handles leaderboard endpoints
"""

from typing import Tuple, Any


def handle_leaderboard_routes(handler, method: str, path: str, body: dict) -> Tuple[int, Any]:
    """
    Route handler for leaderboard endpoints.
    
    Returns:
        Tuple of (status_code, response_body)
    """
    from ..data import get_leaderboard, get_ranked_leaderboard
    
    # GET /api/leaderboard - Get casual leaderboard
    if path == "/api/leaderboard" and method == "GET":
        leaderboard_type = handler.get_query_param("type") or "alltime"
        players = get_leaderboard(leaderboard_type)
        return 200, {"players": players}
    
    # GET /api/leaderboard/ranked - Get ranked leaderboard
    if path == "/api/leaderboard/ranked" and method == "GET":
        players = get_ranked_leaderboard()
        return 200, {"players": players}
    
    return None  # Not handled

