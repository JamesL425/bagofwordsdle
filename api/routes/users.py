"""
Users Routes
Handles user profile, cosmetics, and daily ops endpoints
"""

from typing import Tuple, Any


def handle_users_routes(handler, method: str, path: str, body: dict) -> Tuple[int, Any]:
    """
    Route handler for user-related endpoints.
    
    Returns:
        Tuple of (status_code, response_body)
    """
    from ..data import get_user_by_id, save_user, get_player_stats
    from ..services import (
        check_and_update_streak, get_next_streak_info,
        get_user_credits, add_user_credits,
        user_owns_cosmetic, grant_owned_cosmetic,
        generate_daily_quests, generate_weekly_quests
    )
    from .auth import verify_jwt_token
    
    # GET /api/user/cosmetics - Get user's cosmetics
    if path == "/api/user/cosmetics" and method == "GET":
        token = handler.get_auth_token()
        if not token:
            return 401, {"detail": "Not authenticated"}
        
        user_data = verify_jwt_token(token)
        if not user_data:
            return 401, {"detail": "Invalid token"}
        
        user = get_user_by_id(user_data.get("sub"))
        if not user:
            return 404, {"detail": "User not found"}
        
        return 200, {
            "cosmetics": user.get("cosmetics", {}),
            "owned_cosmetics": user.get("owned_cosmetics", {}),
            "is_donor": user.get("is_donor", False),
            "is_admin": user.get("is_admin", False),
        }
    
    # POST /api/cosmetics/equip - Equip a cosmetic
    if path == "/api/cosmetics/equip" and method == "POST":
        token = handler.get_auth_token()
        if not token:
            return 401, {"detail": "Not authenticated"}
        
        user_data = verify_jwt_token(token)
        if not user_data:
            return 401, {"detail": "Invalid token"}
        
        user = get_user_by_id(user_data.get("sub"))
        if not user:
            return 404, {"detail": "User not found"}
        
        category = body.get("category")
        cosmetic_id = body.get("cosmetic_id")
        
        if not category or not cosmetic_id:
            return 400, {"detail": "Category and cosmetic_id required"}
        
        if "cosmetics" not in user:
            user["cosmetics"] = {}
        
        user["cosmetics"][category] = cosmetic_id
        save_user(user)
        
        return 200, {"cosmetics": user["cosmetics"]}
    
    # GET /api/user/daily - Get daily ops data
    if path == "/api/user/daily" and method == "GET":
        token = handler.get_auth_token()
        if not token:
            return 401, {"detail": "Not authenticated"}
        
        user_data = verify_jwt_token(token)
        if not user_data:
            return 401, {"detail": "Invalid token"}
        
        user = get_user_by_id(user_data.get("sub"))
        if not user:
            return 404, {"detail": "User not found"}
        
        # Check and update streak
        streak_result = check_and_update_streak(user)
        streak_info = get_next_streak_info(streak_result["streak"]["streak_count"])
        
        # Get or generate daily quests
        from ..services.economy_service import utc_today_str, get_week_start_str
        today = utc_today_str()
        week_start = get_week_start_str()
        
        daily_quests = user.get("daily_quests", {})
        if daily_quests.get("date") != today:
            daily_quests = {
                "date": today,
                "quests": generate_daily_quests(user, today),
            }
            user["daily_quests"] = daily_quests
            save_user(user)
        
        weekly_quests = user.get("weekly_quests", {})
        if weekly_quests.get("week_start") != week_start:
            weekly_quests = {
                "week_start": week_start,
                "quests": generate_weekly_quests(user, week_start),
            }
            user["weekly_quests"] = weekly_quests
            save_user(user)
        
        return 200, {
            "wallet": user.get("wallet", {"credits": 0}),
            "quests": daily_quests.get("quests", []),
            "weekly_quests": weekly_quests.get("quests", []),
            "date": today,
            "owned_cosmetics": user.get("owned_cosmetics", {}),
            "streak": streak_result["streak"],
            "streak_credits_earned": streak_result["credits_earned"],
            "streak_milestone_bonus": streak_result["milestone_bonus"],
            "streak_broken": streak_result["streak_broken"],
            "streak_info": streak_info,
        }
    
    # POST /api/user/daily/claim - Claim a quest reward
    if path == "/api/user/daily/claim" and method == "POST":
        token = handler.get_auth_token()
        if not token:
            return 401, {"detail": "Not authenticated"}
        
        user_data = verify_jwt_token(token)
        if not user_data:
            return 401, {"detail": "Invalid token"}
        
        user = get_user_by_id(user_data.get("sub"))
        if not user:
            return 404, {"detail": "User not found"}
        
        quest_id = body.get("quest_id")
        quest_type = body.get("quest_type", "daily")
        
        if not quest_id:
            return 400, {"detail": "Quest ID required"}
        
        # Find the quest
        if quest_type == "weekly":
            quests = user.get("weekly_quests", {}).get("quests", [])
        else:
            quests = user.get("daily_quests", {}).get("quests", [])
        
        quest = next((q for q in quests if q["id"] == quest_id), None)
        if not quest:
            return 404, {"detail": "Quest not found"}
        
        if quest.get("claimed"):
            return 400, {"detail": "Quest already claimed"}
        
        if quest.get("progress", 0) < quest.get("target", 1):
            return 400, {"detail": "Quest not complete"}
        
        # Claim reward
        reward = quest.get("reward_credits", 0)
        add_user_credits(user, reward, persist=False)
        quest["claimed"] = True
        save_user(user)
        
        return 200, {
            "wallet": user.get("wallet", {"credits": 0}),
            "reward_credits": reward,
        }
    
    # POST /api/shop/purchase - Purchase a cosmetic
    if path == "/api/shop/purchase" and method == "POST":
        token = handler.get_auth_token()
        if not token:
            return 401, {"detail": "Not authenticated"}
        
        user_data = verify_jwt_token(token)
        if not user_data:
            return 401, {"detail": "Invalid token"}
        
        user = get_user_by_id(user_data.get("sub"))
        if not user:
            return 404, {"detail": "User not found"}
        
        category = body.get("category")
        cosmetic_id = body.get("cosmetic_id")
        
        if not category or not cosmetic_id:
            return 400, {"detail": "Category and cosmetic_id required"}
        
        # Check if already owned
        if user_owns_cosmetic(user, category, cosmetic_id):
            return 400, {"detail": "Already owned"}
        
        # Get price from catalog (would need to load cosmetics.json)
        # For now, use a placeholder
        price = 100  # TODO: Get actual price from catalog
        
        if get_user_credits(user) < price:
            return 400, {"detail": "Not enough credits"}
        
        # Deduct credits and grant cosmetic
        add_user_credits(user, -price, persist=False)
        grant_owned_cosmetic(user, category, cosmetic_id, persist=True)
        
        return 200, {
            "wallet": user.get("wallet", {"credits": 0}),
            "owned_cosmetics": user.get("owned_cosmetics", {}),
        }
    
    # GET /api/profile/:name - Get player profile
    if path.startswith("/api/profile/") and method == "GET":
        name = path.split("/")[-1]
        if not name:
            return 400, {"detail": "Name required"}
        
        import urllib.parse
        name = urllib.parse.unquote(name)
        
        stats = get_player_stats(name)
        
        return 200, {
            "name": stats.get("display_name", name),
            "wins": stats.get("wins", 0),
            "games_played": stats.get("games_played", 0),
            "eliminations": stats.get("eliminations", 0),
            "win_rate": round(stats.get("wins", 0) / max(1, stats.get("games_played", 1)) * 100),
            "best_streak": stats.get("best_streak", 0),
            "ranked": {
                "mmr": stats.get("mmr"),
                "peak_mmr": stats.get("peak_mmr"),
                "ranked_wins": stats.get("ranked_wins", 0),
                "ranked_losses": stats.get("ranked_losses", 0),
            } if stats.get("mmr") else None,
        }
    
    return None  # Not handled

