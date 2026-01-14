"""
Economy Service
Credits, daily quests, shop, and streak management
"""

import hashlib
import random
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, List, Any

from ..data.redis_client import get_redis
from ..data.user_repository import save_user

# Default values
DEFAULT_WALLET = {"credits": 0}
DEFAULT_OWNED_COSMETICS = {}
DEFAULT_STREAK = {
    "streak_count": 0,
    "streak_last_date": "",
    "longest_streak": 0,
    "streak_claimed_today": False,
}

# Streak configuration
STREAK_BASE_CREDITS = 15
STREAK_MULTIPLIERS = {
    1: 1.0, 2: 1.5, 3: 2.0, 4: 2.0, 5: 2.5, 6: 2.5, 7: 3.0,
    14: 4.0, 30: 5.0, 60: 6.0, 100: 8.0,
}
STREAK_MILESTONE_BONUSES = {
    7: 100, 14: 200, 30: 500, 60: 1000, 100: 2000,
}


def utc_today_str() -> str:
    """Get today's date in UTC as YYYY-MM-DD."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def utc_yesterday_str() -> str:
    """Get yesterday's date in UTC as YYYY-MM-DD."""
    yesterday = datetime.now(timezone.utc) - timedelta(days=1)
    return yesterday.strftime("%Y-%m-%d")


def get_week_start_str() -> str:
    """Get the start of the current week (Monday) as YYYY-MM-DD."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=now.weekday())
    return start.strftime("%Y-%m-%d")


def normalize_wallet(wallet) -> dict:
    """Normalize wallet data."""
    if not isinstance(wallet, dict):
        return {**DEFAULT_WALLET}
    return {
        "credits": int(wallet.get("credits", 0)),
    }


def normalize_streak(streak) -> dict:
    """Normalize streak data."""
    if not isinstance(streak, dict):
        return {**DEFAULT_STREAK}
    return {
        "streak_count": int(streak.get("streak_count", 0)),
        "streak_last_date": str(streak.get("streak_last_date", "")),
        "longest_streak": int(streak.get("longest_streak", 0)),
        "streak_claimed_today": bool(streak.get("streak_claimed_today", False)),
    }


def get_user_credits(user: dict) -> int:
    """Get user's credit balance."""
    wallet = user.get("wallet", {})
    return int(wallet.get("credits", 0))


def add_user_credits(user: dict, delta: int, persist: bool = True) -> int:
    """Add or subtract credits from user."""
    if "wallet" not in user:
        user["wallet"] = {**DEFAULT_WALLET}
    
    current = int(user["wallet"].get("credits", 0))
    new_balance = max(0, current + delta)
    user["wallet"]["credits"] = new_balance
    
    if persist:
        save_user(user)
    
    return new_balance


def get_streak_multiplier(streak_count: int) -> float:
    """Get credit multiplier for current streak."""
    multiplier = 1.0
    for day, mult in sorted(STREAK_MULTIPLIERS.items()):
        if streak_count >= day:
            multiplier = mult
        else:
            break
    return multiplier


def get_streak_milestone_bonus(streak_count: int) -> int:
    """Get milestone bonus if applicable."""
    return STREAK_MILESTONE_BONUSES.get(streak_count, 0)


def check_and_update_streak(user: dict, persist: bool = True) -> dict:
    """
    Check and update user's streak status.
    Returns dict with streak info and any credits earned.
    """
    streak = normalize_streak(user.get("streak", {}))
    today = utc_today_str()
    yesterday = utc_yesterday_str()
    last_date = streak["streak_last_date"]
    
    result = {
        "streak": streak,
        "credits_earned": 0,
        "milestone_bonus": 0,
        "streak_broken": False,
    }
    
    # Already claimed today
    if last_date == today and streak.get("streak_claimed_today"):
        user["streak"] = streak
        return result
    
    # Calculate new streak
    if last_date == yesterday:
        # Continue streak
        streak["streak_count"] += 1
    elif last_date == today:
        # Same day, no change
        pass
    else:
        # Streak broken
        if streak["streak_count"] > 0:
            result["streak_broken"] = True
        streak["streak_count"] = 1
    
    # Update longest streak
    if streak["streak_count"] > streak["longest_streak"]:
        streak["longest_streak"] = streak["streak_count"]
    
    # Calculate credits
    if last_date != today:
        multiplier = get_streak_multiplier(streak["streak_count"])
        base_credits = int(STREAK_BASE_CREDITS * multiplier)
        milestone = get_streak_milestone_bonus(streak["streak_count"])
        
        result["credits_earned"] = base_credits
        result["milestone_bonus"] = milestone
        
        total = base_credits + milestone
        add_user_credits(user, total, persist=False)
        
        streak["streak_last_date"] = today
        streak["streak_claimed_today"] = True
    
    user["streak"] = streak
    result["streak"] = streak
    
    if persist:
        save_user(user)
    
    return result


def get_next_streak_info(streak_count: int) -> dict:
    """Get info about upcoming streak milestones."""
    current_mult = get_streak_multiplier(streak_count)
    current_credits = int(STREAK_BASE_CREDITS * current_mult)
    
    # Find next multiplier increase
    next_mult_day = None
    next_mult_credits = current_credits
    for day in sorted(STREAK_MULTIPLIERS.keys()):
        if day > streak_count:
            next_mult_day = day
            next_mult_credits = int(STREAK_BASE_CREDITS * STREAK_MULTIPLIERS[day])
            break
    
    # Find next milestone
    next_milestone_day = None
    next_milestone_bonus = 0
    for day in sorted(STREAK_MILESTONE_BONUSES.keys()):
        if day > streak_count:
            next_milestone_day = day
            next_milestone_bonus = STREAK_MILESTONE_BONUSES[day]
            break
    
    return {
        "current_daily_credits": current_credits,
        "next_multiplier_day": next_mult_day,
        "next_multiplier_credits": next_mult_credits,
        "next_milestone_day": next_milestone_day,
        "next_milestone_bonus": next_milestone_bonus,
    }


def user_owns_cosmetic(user: dict, category_key: str, cosmetic_id: str) -> bool:
    """Check if user owns a specific cosmetic."""
    owned = user.get("owned_cosmetics", {}).get(category_key, [])
    return cosmetic_id in owned


def grant_owned_cosmetic(user: dict, category_key: str, cosmetic_id: str, persist: bool = True) -> bool:
    """Grant a cosmetic to user."""
    if "owned_cosmetics" not in user:
        user["owned_cosmetics"] = {}
    if category_key not in user["owned_cosmetics"]:
        user["owned_cosmetics"][category_key] = []
    
    if cosmetic_id not in user["owned_cosmetics"][category_key]:
        user["owned_cosmetics"][category_key].append(cosmetic_id)
        if persist:
            save_user(user)
        return True
    return False


def _daily_rng(seed_text: str):
    """Create deterministic RNG for daily content."""
    seed = int(hashlib.md5(seed_text.encode()).hexdigest(), 16) % (2**32)
    return random.Random(seed)


def generate_daily_quests(user: dict, date_str: str) -> List[dict]:
    """Generate daily quests for a user."""
    user_id = user.get("id", "anonymous")
    rng = _daily_rng(f"{date_str}:{user_id}:daily")
    
    quest_templates = [
        {"metric": "games_played", "targets": [1, 2, 3], "rewards": [10, 20, 30], "title": "Play Games", "desc": "Play {target} game(s)"},
        {"metric": "wins", "targets": [1, 2], "rewards": [25, 50], "title": "Win Games", "desc": "Win {target} game(s)"},
        {"metric": "eliminations", "targets": [1, 3, 5], "rewards": [15, 30, 50], "title": "Eliminate Players", "desc": "Eliminate {target} player(s)"},
        {"metric": "guesses", "targets": [5, 10, 20], "rewards": [10, 20, 35], "title": "Make Guesses", "desc": "Make {target} guess(es)"},
    ]
    
    # Select 3 random quests
    selected = rng.sample(quest_templates, min(3, len(quest_templates)))
    
    quests = []
    for i, template in enumerate(selected):
        target_idx = rng.randint(0, len(template["targets"]) - 1)
        target = template["targets"][target_idx]
        reward = template["rewards"][target_idx]
        
        quests.append({
            "id": f"daily_{date_str}_{i}",
            "title": template["title"],
            "description": template["desc"].format(target=target),
            "metric": template["metric"],
            "target": target,
            "progress": 0,
            "reward_credits": reward,
            "claimed": False,
        })
    
    return quests


def generate_weekly_quests(user: dict, week_start: str) -> List[dict]:
    """Generate weekly quests for a user."""
    user_id = user.get("id", "anonymous")
    rng = _daily_rng(f"{week_start}:{user_id}:weekly")
    
    quest_templates = [
        {"metric": "games_played", "targets": [7, 14], "rewards": [100, 200], "title": "Weekly Player", "desc": "Play {target} games this week"},
        {"metric": "wins", "targets": [3, 5, 7], "rewards": [150, 250, 400], "title": "Weekly Winner", "desc": "Win {target} games this week"},
        {"metric": "eliminations", "targets": [10, 20], "rewards": [100, 200], "title": "Weekly Hunter", "desc": "Eliminate {target} players this week"},
    ]
    
    # Select 2 weekly quests
    selected = rng.sample(quest_templates, min(2, len(quest_templates)))
    
    quests = []
    for i, template in enumerate(selected):
        target_idx = rng.randint(0, len(template["targets"]) - 1)
        target = template["targets"][target_idx]
        reward = template["rewards"][target_idx]
        
        quests.append({
            "id": f"weekly_{week_start}_{i}",
            "title": template["title"],
            "description": template["desc"].format(target=target),
            "metric": template["metric"],
            "target": target,
            "progress": 0,
            "reward_credits": reward,
            "claimed": False,
        })
    
    return quests

