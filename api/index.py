"""Vercel serverless function for Embeddle API with Upstash Redis storage."""

import json
import hashlib
import os
import re
import html
import secrets
import string
import time
import urllib.parse
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import jwt
import numpy as np
import requests
from openai import OpenAI
from wordfreq import word_frequency
from upstash_redis import Redis
from upstash_ratelimit import Ratelimit, FixedWindow


# ============== INPUT VALIDATION ==============

# Validation patterns
GAME_CODE_PATTERN = re.compile(r'^[A-Z0-9]{6}$')
PLAYER_ID_PATTERN = re.compile(r'^[a-f0-9]{16}$')
PLAYER_NAME_PATTERN = re.compile(r'^[a-zA-Z0-9_ ]{1,20}$')
WORD_PATTERN = re.compile(r'^[a-zA-Z]{2,30}$')


def sanitize_game_code(code: str) -> Optional[str]:
    """Validate and sanitize game code. Returns None if invalid."""
    if not code:
        return None
    code = code.upper().strip()
    if not GAME_CODE_PATTERN.match(code):
        return None
    return code


def sanitize_player_id(player_id: str) -> Optional[str]:
    """Validate player ID format. Returns None if invalid."""
    if not player_id:
        return None
    player_id = player_id.lower().strip()
    if not PLAYER_ID_PATTERN.match(player_id):
        return None
    return player_id


def sanitize_player_name(name: str, allow_admin: bool = False) -> Optional[str]:
    """Sanitize player name. Returns None if invalid."""
    if not name:
        return None
    name = name.strip()
    if not PLAYER_NAME_PATTERN.match(name):
        return None
    # Prevent non-admin users from using reserved names
    if not allow_admin and name.lower() == 'admin':
        return None
    # HTML escape to prevent XSS when displayed
    return html.escape(name)


def sanitize_word(word: str) -> Optional[str]:
    """Sanitize word input. Returns None if invalid."""
    if not word:
        return None
    word = word.lower().strip()
    if not WORD_PATTERN.match(word):
        return None
    return word

# ============== CONFIG ==============

def load_config():
    config_path = Path(__file__).parent / "config.json"
    if config_path.exists():
        with open(config_path) as f:
            return json.load(f)
    return {}

CONFIG = load_config()

def env_bool(name: str, default: bool = False) -> bool:
    """Parse common truthy/falsey env var values."""
    value = os.getenv(name)
    if value is None:
        return default
    value = value.strip().lower()
    if value == '':
        return default
    return value in ('1', 'true', 'yes', 'y', 'on')


def parse_bool(value, default: bool = False) -> bool:
    """Parse a loose boolean value from request bodies/config."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        try:
            return float(value) != 0.0
        except Exception:
            return default
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ('1', 'true', 'yes', 'y', 'on'):
            return True
        if v in ('0', 'false', 'no', 'n', 'off', ''):
            return False
    return default


def sanitize_visibility(value: str, default: str = "private") -> str:
    """Sanitize lobby visibility. Returns 'public' or 'private'."""
    v = str(value or "").strip().lower()
    if v == "public":
        return "public"
    if v == "private":
        return "private"
    return default if default in ("public", "private") else "private"

# Game settings
MIN_PLAYERS = CONFIG.get("game", {}).get("min_players", 3)
MAX_PLAYERS = CONFIG.get("game", {}).get("max_players", 4)
GAME_EXPIRY_SECONDS = CONFIG.get("game", {}).get("game_expiry_seconds", 7200)
LOBBY_EXPIRY_SECONDS = CONFIG.get("game", {}).get("lobby_expiry_seconds", 600)
WORD_CHANGE_SAMPLE_SIZE = CONFIG.get("game", {}).get("word_change_sample_size", 6)
WORDS_PER_PLAYER = int((CONFIG.get("game", {}) or {}).get("words_per_player", 18) or 18)
WORDS_PER_PLAYER = max(1, min(50, WORDS_PER_PLAYER))

# Presence settings (spectator counts, etc.)
PRESENCE_TTL_SECONDS = int((CONFIG.get("presence", {}) or {}).get("ttl_seconds", 15) or 15)

# Ranked settings (ELO/MMR)
RANKED_INITIAL_MMR = int((CONFIG.get("ranked", {}) or {}).get("initial_mmr", 1000) or 1000)
RANKED_K_FACTOR = float((CONFIG.get("ranked", {}) or {}).get("k_factor", 32) or 32)

# Embedding settings
EMBEDDING_MODEL = CONFIG.get("embedding", {}).get("model", "text-embedding-3-small")
EMBEDDING_CACHE_SECONDS = CONFIG.get("embedding", {}).get("cache_expiry_seconds", 86400)

# Load pre-generated themes from JSON file
def load_themes():
    themes_path = Path(__file__).parent / "themes.json"
    if themes_path.exists():
        with open(themes_path) as f:
            return json.load(f)
    return {}

PREGENERATED_THEMES = load_themes()
THEME_CATEGORIES = list(PREGENERATED_THEMES.keys()) if PREGENERATED_THEMES else CONFIG.get("theme_categories", [])

# Backwards-compatible theme aliases:
# Old lobbies can have theme names persisted in Redis that no longer exist in api/themes.json.
# Map them to the closest current theme so /start doesn't fail with an empty word list.
THEME_ALIASES = {
    "science & space": "Space Adventure",
    "music & instruments": "Music & Concerts",
    "movies & tv shows": "Superheroes & Comics",
    "movies & entertainment": "Superheroes & Comics",
    "superheroes": "Superheroes & Comics",
    "food & cooking": "Kitchen Chaos",
    "sports & games": "Video Games",
    "technology & gadgets": "Internet & Memes",
    "ocean & marine life": "Pirates & Treasure",
    "beach & summer": "Pirates & Treasure",
    "history & ancient civilizations": "Mythology & Legends",
    "history & ancient": "Mythology & Legends",
}

# Load cosmetics catalog
def load_cosmetics_catalog():
    cosmetics_path = Path(__file__).parent / "cosmetics.json"
    if cosmetics_path.exists():
        with open(cosmetics_path) as f:
            return json.load(f)
    return {}

COSMETICS_CATALOG = load_cosmetics_catalog()

# Load profanity word list (server-side chat filtering)
def load_profanity_words():
    profanity_path = Path(__file__).parent / "profanity.json"
    if profanity_path.exists():
        try:
            with open(profanity_path) as f:
                data = json.load(f)
            if isinstance(data, dict):
                data = data.get("words", [])
            if isinstance(data, list):
                return [str(w).strip().lower() for w in data if str(w).strip()]
        except Exception:
            return []
    return []


PROFANITY_WORDS = set(load_profanity_words())


def filter_profanity(text: str) -> str:
    """Mask profane words in a message (best-effort)."""
    if not text or not PROFANITY_WORDS:
        return text
    # Replace alphabetic tokens that match a banned word exactly (case-insensitive)
    def _repl(match):
        token = match.group(0)
        if token.lower() in PROFANITY_WORDS:
            return '*' * len(token)
        return token
    return re.sub(r"[A-Za-z]{2,}", _repl, text)

# Cosmetics monetization (feature-flagged)
# For now the paywall is disabled; flip this later via env var or config.
COSMETICS_PAYWALL_ENABLED = env_bool(
    "COSMETICS_PAYWALL_ENABLED",
    CONFIG.get("cosmetics", {}).get("paywall_enabled", False),
)

# Cosmetics unlock-all (feature-flagged)
# When enabled, premium + progression gating are bypassed (useful during early development).
COSMETICS_UNLOCK_ALL = env_bool(
    "COSMETICS_UNLOCK_ALL",
    CONFIG.get("cosmetics", {}).get("unlock_all", False),
)

# Ko-fi webhook verification token
KOFI_VERIFICATION_TOKEN = os.getenv('KOFI_VERIFICATION_TOKEN', '')

# Default cosmetics for new users
DEFAULT_COSMETICS = {
    "card_border": "classic",
    "card_background": "default",
    "name_color": "default",
    "badge": "none",
    "elimination_effect": "classic",
    "guess_effect": "classic",
    "turn_indicator": "classic",
    "victory_effect": "classic",
    "matrix_color": "classic",
    "particle_overlay": "none",
    "seasonal_theme": "none",
    "alt_background": "matrix"
}

# Cosmetics schema version for stored user cosmetics payload.
COSMETICS_SCHEMA_VERSION = 2

# Map category keys stored on users -> catalog keys in api/cosmetics.json
COSMETIC_CATEGORY_TO_CATALOG_KEY = {
    'card_border': 'card_borders',
    'card_background': 'card_backgrounds',
    'name_color': 'name_colors',
    'badge': 'badges',
    'elimination_effect': 'elimination_effects',
    'guess_effect': 'guess_effects',
    'turn_indicator': 'turn_indicators',
    'victory_effect': 'victory_effects',
    'matrix_color': 'matrix_colors',
    'particle_overlay': 'particle_overlays',
    'seasonal_theme': 'seasonal_themes',
    'alt_background': 'alt_backgrounds',
}

# Legacy cosmetic ID migrations for hard restarts.
# NOTE: Badge remaps are handled conditionally (supporter vs non-supporter) at runtime.
LEGACY_COSMETIC_ID_MAP = {
    'card_background': {
        'starfield': 'default',
    },
    'guess_effect': {
        'data_stream': 'classic',
        'fire_trail': 'classic',
        'ice_crystals': 'classic',
        'glitch_pulse': 'classic',
    },
    'victory_effect': {
        'glitch_victory': 'classic',
        'matrix_cascade': 'classic',
    },
    'badge': {
        # v1 supporter-style badges -> v2 supporter badge (coffee) when allowed
        'star': 'coffee',
        'heart': 'coffee',
        'crown': 'coffee',
        'lightning': 'coffee',
        'flame': 'coffee',
    },
}

# Default stats stored on authenticated (Google) users.
# NOTE: Unlock progression uses the mp_* fields (multiplayer-only).
DEFAULT_USER_STATS = {
    "wins": 0,
    "games_played": 0,
    "eliminations": 0,
    "times_eliminated": 0,
    "total_guesses": 0,
    "win_streak": 0,
    "best_streak": 0,
    # Multiplayer-only progression (used for cosmetics unlocks)
    "mp_games_played": 0,
    "mp_wins": 0,
    "mp_eliminations": 0,
    "mp_times_eliminated": 0,
    # Ranked (ELO/MMR)
    "mmr": int((CONFIG.get("ranked", {}) or {}).get("initial_mmr", 1000) or 1000),
    "peak_mmr": int((CONFIG.get("ranked", {}) or {}).get("initial_mmr", 1000) or 1000),
    "ranked_games": 0,
    "ranked_wins": 0,
    "ranked_losses": 0,
}

# ============== DAILY STREAK SYSTEM ==============
#
# Streak fields stored on authenticated users.
# Streaks reward consecutive daily play with escalating bonuses.

DEFAULT_STREAK = {
    "streak_count": 0,           # Current consecutive days
    "streak_last_date": "",      # Last date user played (YYYY-MM-DD UTC)
    "longest_streak": 0,         # All-time longest streak
    "streak_claimed_today": False,  # Whether daily streak bonus was claimed today
}

# Streak bonus configuration
STREAK_BASE_CREDITS = 15  # Base credits for daily login
STREAK_MULTIPLIERS = {
    1: 1.0,    # Day 1: 15 credits
    2: 1.5,    # Day 2: 22 credits
    3: 2.0,    # Day 3: 30 credits
    4: 2.0,    # Day 4: 30 credits
    5: 2.5,    # Day 5: 37 credits
    6: 2.5,    # Day 6: 37 credits
    7: 3.0,    # Day 7: 45 credits (weekly milestone)
    14: 4.0,   # Day 14: 60 credits (2-week milestone)
    30: 5.0,   # Day 30: 75 credits (monthly milestone)
    60: 6.0,   # Day 60: 90 credits
    100: 8.0,  # Day 100: 120 credits
}

# Milestone bonuses (one-time bonus at these streak counts)
STREAK_MILESTONE_BONUSES = {
    7: 100,    # 1 week: +100 bonus
    14: 200,   # 2 weeks: +200 bonus
    30: 500,   # 1 month: +500 bonus
    60: 1000,  # 2 months: +1000 bonus
    100: 2000, # 100 days: +2000 bonus
}

# ============== DAILY QUESTS / ECONOMY ==============
#
# These fields live on authenticated (Google) user records stored in Redis as JSON.
# Guests (name-only) do not have persistent server-side state.
#
# NOTE: "credits" is intentionally generic so we can rename it in the UI later.
DEFAULT_WALLET = {
    "credits": 0,
}

# Stored as: { "<category_key>": ["<cosmetic_id>", ...] }
# Example: { "card_border": ["border_synthwave"] }
DEFAULT_OWNED_COSMETICS = {}

# Stored as: { "date": "YYYY-MM-DD", "quests": [ ... ] }
DEFAULT_DAILY_QUESTS = {
    "date": "",
    "quests": [],
}

def new_daily_quests_state() -> dict:
    """Return a fresh default daily-quests payload (avoid shared list references)."""
    return {"date": "", "quests": []}

# Admin sessions (admin_local) are not stored as normal users, but we keep best-effort
# economy state in Redis so admin can test daily quests and the shop.
ADMIN_ECONOMY_KEY = "admin_economy"
ADMIN_ECONOMY_TTL_SECONDS = 3600

# ============== AI PLAYER CONFIGURATION ==============

# AI difficulty settings
#
# NOTE: Difficulty keys are persisted in saved game state; changing keys can affect in-flight games.
AI_DIFFICULTY_CONFIG = {
    # --- New 5-tier spy-themed difficulties (used by the UI) ---
    "rookie": {
        "name_prefix": "Rookie",
        "strategic_chance": 0.18,        # mostly random
        "word_selection": "random",
        "targeting_strength": 0.25,      # weak follow-up
        "min_target_similarity": 0.6,    # needs a very strong clue to chase
        "delay_range": (1, 3),
        "badge": "🤖",
        # Defense/risk knobs (used by ai_choose_guess)
        "self_leak_soft_max": 0.92,
        "self_leak_hard_max": 0.98,
        "panic_danger": "critical",      # rookie basically doesn't “panic”
        "panic_aggression_boost": 0.05,
        "candidate_pool": 8,
        "clue_words_per_target": 1,
    },
    "analyst": {
        "name_prefix": "Analyst",
        "strategic_chance": 0.45,
        "word_selection": "avoid_common",
        "targeting_strength": 0.45,
        "min_target_similarity": 0.5,
        "delay_range": (2, 4),
        "badge": "🤖",
        "self_leak_soft_max": 0.85,
        "self_leak_hard_max": 0.95,
        "panic_danger": "high",
        "panic_aggression_boost": 0.15,
        "candidate_pool": 12,
        "clue_words_per_target": 2,
    },
    "field-agent": {
        "name_prefix": "Agent",
        "strategic_chance": 0.6,
        "word_selection": "avoid_common",
        "targeting_strength": 0.6,
        "min_target_similarity": 0.48,
        "delay_range": (2, 5),
        "badge": "🤖",
        "self_leak_soft_max": 0.82,
        "self_leak_hard_max": 0.93,
        "panic_danger": "medium",
        "panic_aggression_boost": 0.22,
        "candidate_pool": 15,
        "clue_words_per_target": 2,
    },
    "spymaster": {
        "name_prefix": "Spymaster",
        "strategic_chance": 0.72,
        "word_selection": "obscure",
        "targeting_strength": 0.72,
        "min_target_similarity": 0.45,
        "delay_range": (3, 6),
        "badge": "🤖",
        "self_leak_soft_max": 0.78,
        "self_leak_hard_max": 0.9,
        "panic_danger": "medium",
        "panic_aggression_boost": 0.28,
        "candidate_pool": 18,
        "clue_words_per_target": 3,
    },
    "ghost": {
        "name_prefix": "Ghost",
        "strategic_chance": 0.82,
        "word_selection": "obscure",
        "targeting_strength": 0.82,
        "min_target_similarity": 0.42,
        "delay_range": (3, 7),
        "badge": "🤖",
        "self_leak_soft_max": 0.74,
        "self_leak_hard_max": 0.88,
        "panic_danger": "low",
        "panic_aggression_boost": 0.35,
        "candidate_pool": 20,
        "clue_words_per_target": 3,
    },
}

# AI name suffixes for variety
AI_NAME_SUFFIXES = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta"]


def generate_ai_player_id(difficulty: str) -> str:
    """Generate a unique AI player ID."""
    return f"ai_{difficulty}_{secrets.token_hex(4)}"


def create_ai_player(difficulty: str, existing_names: list) -> dict:
    """Create an AI player with the specified difficulty."""
    default_cfg = AI_DIFFICULTY_CONFIG.get("rookie") or {}
    config = AI_DIFFICULTY_CONFIG.get(difficulty, default_cfg)
    
    # Generate unique name
    used_suffixes = set()
    for name in existing_names:
        for suffix in AI_NAME_SUFFIXES:
            if suffix in name:
                used_suffixes.add(suffix)
    
    available_suffixes = [s for s in AI_NAME_SUFFIXES if s not in used_suffixes]
    suffix = available_suffixes[0] if available_suffixes else secrets.choice(AI_NAME_SUFFIXES)
    
    name = f"{config['name_prefix']}-{suffix}"
    
    # Give different difficulties distinct “agent” vibes in the UI
    ai_cosmetics_by_difficulty = {
        "rookie": {"card_border": "classic", "card_background": "default", "name_color": "default"},
        "analyst": {"card_border": "ice", "card_background": "gradient_ice", "name_color": "ice"},
        "field-agent": {"card_border": "fire", "card_background": "matrix_code", "name_color": "fire"},
        "spymaster": {"card_border": "gold_elite", "card_background": "circuit_board", "name_color": "gold"},
        "ghost": {"card_border": "electric", "card_background": "starfield", "name_color": "shadow"},
    }
    selected_cosmetics = ai_cosmetics_by_difficulty.get(difficulty, ai_cosmetics_by_difficulty["rookie"])

    return {
        "id": generate_ai_player_id(difficulty),
        "name": name,
        "difficulty": difficulty,
        "is_ai": True,
        "secret_word": None,
        "secret_embedding": None,
        "is_alive": True,
        "can_change_word": False,
        "word_pool": [],
        "is_ready": True,  # AI is always ready
        "cosmetics": {
            "card_border": selected_cosmetics["card_border"],
            "card_background": selected_cosmetics["card_background"],
            "name_color": selected_cosmetics["name_color"],
            "badge": config["badge"],
        },
        "ai_memory": {
            "high_similarity_targets": {},  # player_id -> [(word, similarity)]
            "guessed_words": [],
        },
    }


def ai_select_secret_word(ai_player: dict, word_pool: list) -> str:
    """AI selects a secret word based on difficulty."""
    import random
    
    difficulty = ai_player.get("difficulty", "rookie")
    default_cfg = AI_DIFFICULTY_CONFIG.get("rookie") or {}
    config = AI_DIFFICULTY_CONFIG.get(difficulty, default_cfg)
    selection_mode = config.get("word_selection", "random")
    
    if not word_pool:
        return None
    
    try:
        if selection_mode == "random":
            return random.choice(word_pool)
        
        elif selection_mode == "avoid_common":
            # Sort by word frequency (less common = better) and pick from bottom half
            words_with_freq = [(w, word_frequency(w.lower(), 'en')) for w in word_pool]
            words_with_freq.sort(key=lambda x: x[1])
            # Pick from the less common half
            less_common = words_with_freq[:len(words_with_freq)//2 + 1]
            return random.choice(less_common)[0]
        
        elif selection_mode == "obscure":
            # Pick from the least common 10% of words (harder to guess)
            words_with_freq = [(w, word_frequency(w.lower(), 'en')) for w in word_pool]
            words_with_freq.sort(key=lambda x: x[1])
            obscure_count = max(1, len(words_with_freq)//10)
            obscure_words = words_with_freq[:obscure_count]
            return random.choice(obscure_words)[0]
        
        return random.choice(word_pool)
    except Exception as e:
        print(f"Error in ai_select_secret_word: {e}")
        # Fallback to random selection
        return random.choice(word_pool)


def ai_update_memory(ai_player: dict, guess_word: str, similarities: dict, game: dict):
    """Update AI's memory after a guess is made."""
    memory = ai_player.get("ai_memory", {})
    if "guessed_words" not in memory:
        memory["guessed_words"] = []
    if "high_similarity_targets" not in memory:
        memory["high_similarity_targets"] = {}
    
    memory["guessed_words"].append(guess_word.lower())
    
    # Track high similarities for targeting
    for player_id, sim in similarities.items():
        if player_id == ai_player["id"]:
            continue
        # Only track if player is still alive
        player = next((p for p in game["players"] if p["id"] == player_id), None)
        if player and player.get("is_alive", True):
            if player_id not in memory["high_similarity_targets"]:
                memory["high_similarity_targets"][player_id] = []
            memory["high_similarity_targets"][player_id].append((guess_word, sim))
            # Keep only top 5 similarities per player
            memory["high_similarity_targets"][player_id].sort(key=lambda x: x[1], reverse=True)
            memory["high_similarity_targets"][player_id] = memory["high_similarity_targets"][player_id][:5]
    
    ai_player["ai_memory"] = memory


def ai_find_best_target(ai_player: dict, game: dict) -> Optional[dict]:
    """Find the best target player based on AI memory."""
    memory = ai_player.get("ai_memory", {})
    targets = memory.get("high_similarity_targets", {})
    
    if not targets:
        return None
    
    best_target = None
    best_score = 0
    
    for player_id, sims in targets.items():
        # Check if player is still alive
        player = next((p for p in game["players"] if p["id"] == player_id), None)
        # In singleplayer, bots should target each other too (no "team vs human" behavior)
        if not player or not player.get("is_alive", True):
            continue
        
        if sims:
            # Calculate a weighted score: highest similarity matters most
            top_sim = sims[0][1] if sims else 0
            avg_sim = sum(s[1] for s in sims) / len(sims) if sims else 0
            score = top_sim * 0.7 + avg_sim * 0.3
            
            if score > best_score:
                best_score = score
                best_target = {
                    "player_id": player_id,
                    "player_name": player["name"],
                    "top_word": sims[0][0] if sims else None,
                    "top_similarity": top_sim,
                    "score": score,
                }
    
    return best_target


def ai_find_similar_words(target_word: str, theme_words: list, guessed_words: list, count: int = 5) -> list:
    """Find words in theme that are semantically similar to target word using embeddings."""
    try:
        target_embedding = get_embedding(target_word)
        
        candidates = []
        for word in theme_words:
            if word.lower() in [g.lower() for g in guessed_words]:
                continue
            
            word_embedding = get_embedding(word)
            sim = cosine_similarity(target_embedding, word_embedding)
            candidates.append((word, sim))
        
        # Sort by similarity and return top candidates
        candidates.sort(key=lambda x: x[1], reverse=True)
        return [c[0] for c in candidates[:count]]
    
    except Exception as e:
        print(f"Error finding similar words: {e}")
        return []


def _ai_last_word_change_index(game: dict, player_id: str) -> int:
    """
    Return the history index after the player's last word change. If never changed, return 0.
    This mirrors the frontend's "ignore clues before word change" behavior.
    """
    try:
        idx_after = 0
        history = game.get("history", []) or []
        for idx, entry in enumerate(history):
            if entry.get("type") == "word_change" and entry.get("player_id") == player_id:
                idx_after = idx + 1
        return idx_after
    except Exception:
        return 0


def _ai_top_guesses_since_change(game: dict, target_player_id: str, k: int = 3) -> list:
    """Return top-k guesses (word, similarity) for a target since their last word change."""
    history = game.get("history", []) or []
    start = _ai_last_word_change_index(game, target_player_id)
    scored = []
    for idx, entry in enumerate(history):
        if idx < start:
            continue
        if entry.get("type") == "word_change":
            continue
        sims = entry.get("similarities") or {}
        if target_player_id not in sims:
            continue
        w = entry.get("word")
        if not w:
            continue
        try:
            sim = float(sims[target_player_id])
        except Exception:
            continue
        scored.append((str(w), sim))
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[: max(0, int(k or 0))]


def _ai_danger_score(top_guesses: list) -> float:
    """
    Danger score based on top 3 public similarities since last word change.
    Mirrors frontend: top1*0.6 + top2*0.25 + top3*0.15
    """
    if not top_guesses:
        return 0.0
    weights = [0.6, 0.25, 0.15]
    score = 0.0
    for i, g in enumerate(top_guesses[:3]):
        try:
            score += float(g[1]) * float(weights[i])
        except Exception:
            continue
    return float(score)


def _ai_danger_level(score: float) -> str:
    # Returns: 'safe', 'low', 'medium', 'high', 'critical'
    try:
        s = float(score)
    except Exception:
        s = 0.0
    if s < 0.3:
        return "safe"
    if s < 0.45:
        return "low"
    if s < 0.6:
        return "medium"
    if s < 0.75:
        return "high"
    return "critical"


def _ai_is_panic(danger_level: str, panic_threshold: str) -> bool:
    """Return True if danger_level is >= panic_threshold (ordered)."""
    order = {"safe": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
    return order.get(danger_level, 0) >= order.get(panic_threshold, 4)


def _ai_self_similarity(ai_player: dict, word: str) -> Optional[float]:
    """Cosine similarity between a candidate guess and the AI's own secret embedding."""
    try:
        secret_emb = ai_player.get("secret_embedding")
        if not secret_emb:
            return None
        emb = get_embedding(word)
        return float(cosine_similarity(emb, secret_emb))
    except Exception:
        return None


def ai_choose_guess(ai_player: dict, game: dict) -> Optional[str]:
    """AI chooses a word to guess based on difficulty and game state."""
    import random
    
    difficulty = ai_player.get("difficulty", "rookie")
    default_cfg = AI_DIFFICULTY_CONFIG.get("rookie") or {}
    config = AI_DIFFICULTY_CONFIG.get(difficulty, default_cfg)
    
    theme_words = game.get("theme", {}).get("words", [])
    memory = ai_player.get("ai_memory", {})
    guessed_words = memory.get("guessed_words", [])
    my_secret = (ai_player.get("secret_word") or "").lower().strip()
    
    # Get all words that haven't been guessed yet
    guessed_lower = {str(g).lower() for g in (guessed_words or [])}
    available_words = []
    for w in theme_words:
        wl = str(w).lower()
        if wl in guessed_lower:
            continue
        # Never guess your own secret word (huge self-leak)
        if my_secret and wl == my_secret:
            continue
        available_words.append(w)
    
    if not available_words:
        return None
    
    # Compute self-danger (how close others are to guessing us) from public history
    my_top = _ai_top_guesses_since_change(game, ai_player.get("id"), k=3)
    my_danger_score = _ai_danger_score(my_top)
    my_danger_level = _ai_danger_level(my_danger_score)

    # Decide if this should be a strategic guess (and boost when threatened)
    strategic_chance = float(config.get("strategic_chance", 0.15) or 0.15)
    targeting_strength = float(config.get("targeting_strength", 0.2) or 0.2)
    min_target_similarity = float(config.get("min_target_similarity", 0.3) or 0.3)

    panic_threshold = str(config.get("panic_danger", "high") or "high")
    panic = _ai_is_panic(my_danger_level, panic_threshold)
    if panic:
        strategic_chance = min(0.98, strategic_chance + float(config.get("panic_aggression_boost", 0.2) or 0.2))
        targeting_strength = min(0.98, targeting_strength + float(config.get("panic_aggression_boost", 0.2) or 0.2) * 0.6)

    # Self-leak controls: avoid guesses too close to our own secret unless panic forces our hand
    soft_max = float(config.get("self_leak_soft_max", 0.85) or 0.85)
    hard_max = float(config.get("self_leak_hard_max", 0.95) or 0.95)
    if panic:
        # In panic, relax leak avoidance a bit: you're willing to “bleed” to secure a word change
        soft_max = min(0.99, soft_max + 0.05)
        hard_max = min(0.995, hard_max + 0.03)

    # Cache self-sim values for this turn (avoid repeated embedding lookups)
    _self_sim_cache = {}

    def get_self_sim(word: str) -> Optional[float]:
        wl = str(word).lower()
        if wl in _self_sim_cache:
            return _self_sim_cache[wl]
        sim = _ai_self_similarity(ai_player, wl)
        _self_sim_cache[wl] = sim
        return sim

    # Helper: choose candidate words with low self-leak, fallback if needed
    def pick_low_leak(candidates: list) -> Optional[str]:
        if not candidates:
            return None
        # First pass: enforce hard_max
        ok = []
        for w in candidates:
            sim = get_self_sim(w)
            if sim is None:
                ok.append(w)
                continue
            if sim <= hard_max:
                ok.append(w)
        if ok:
            candidates = ok

        # Second pass: prefer <= soft_max but don't hard-fail
        scored = []
        for w in candidates:
            sim = get_self_sim(w)
            # Lower similarity-to-self is better (less leak)
            leak = sim if sim is not None else 0.0
            penalty = 0.0
            if sim is not None and sim > soft_max:
                penalty = (sim - soft_max) * 10.0
            scored.append((w, penalty, leak))
        scored.sort(key=lambda x: (x[1], x[2]))
        # Add a bit of personality noise so AIs aren't identical
        top_n = min(len(scored), 3 if not panic else 2)
        return str(random.choice(scored[:top_n])[0])
    
    if random.random() < strategic_chance:
        # Strategic guess: try to find words similar to high-similarity targets
        #
        # If we're in danger, prioritize targets who are already “vulnerable” (high danger score)
        target = None

        def best_target_from_history(prefer_vulnerable: bool) -> Optional[dict]:
            best = None
            best_score = -1.0
            for p in game.get("players", []) or []:
                if not p or p.get("id") == ai_player.get("id"):
                    continue
                if not p.get("is_alive", True):
                    continue
                top3 = _ai_top_guesses_since_change(game, p.get("id"), k=3)
                if not top3:
                    continue
                top_sim = float(top3[0][1]) if top3 else 0.0
                avg_sim = sum(float(x[1]) for x in top3) / float(len(top3)) if top3 else 0.0
                score = (top_sim * 0.7 + avg_sim * 0.3)
                if prefer_vulnerable:
                    # vulnerability is essentially the opponent's danger score
                    score = _ai_danger_score(top3)
                if score > best_score:
                    best_score = score
                    best = {
                        "player_id": p.get("id"),
                        "player_name": p.get("name"),
                        "top_word": top3[0][0] if top3 else None,
                        "top_similarity": top_sim,
                        "score": score,
                    }
            return best

        if panic:
            target = best_target_from_history(prefer_vulnerable=True)
        if target is None:
            # Prefer word-change-aware targeting from public history
            target = best_target_from_history(prefer_vulnerable=False) or ai_find_best_target(ai_player, game)
        
        if target and target["top_word"] and target["top_similarity"] > min_target_similarity:
            # Find words similar to the word that got high similarity.
            # We also avoid repeating globally-guessed words and avoid leaking our own secret.
            pool_size = int(config.get("candidate_pool", 12) or 12)
            clue_k = int(config.get("clue_words_per_target", 1) or 1)
            target_id = target.get("player_id")
            clues = _ai_top_guesses_since_change(game, target_id, k=max(1, min(3, clue_k))) if target_id else []
            if not clues:
                clues = [(target["top_word"], float(target.get("top_similarity") or 0.5))]

            combined_scores = {}
            combined_list_max = max(5, min(25, pool_size))
            for clue_word, clue_sim in clues:
                # Rank theme words near each clue word
                sim_list = ai_find_similar_words(
                    clue_word,
                    available_words,
                    guessed_words,
                    count=combined_list_max,
                )
                if not sim_list:
                    continue
                try:
                    w = float(clue_sim)
                except Exception:
                    w = 0.5
                denom = float(len(sim_list)) if sim_list else 1.0
                for rank, cand in enumerate(sim_list):
                    # rank 0 is best; convert to [0..1] weight
                    rscore = (denom - float(rank)) / denom
                    combined_scores[cand] = combined_scores.get(cand, 0.0) + (w * rscore)

            similar_words = [w for (w, _) in sorted(combined_scores.items(), key=lambda x: x[1], reverse=True)]
            
            if similar_words:
                # Higher targeting strength = more likely to pick the most similar word
                # but still apply self-leak avoidance.
                if random.random() < targeting_strength:
                    pick = pick_low_leak(similar_words[: max(3, pool_size // 2)])
                    if pick:
                        return pick
                pick = pick_low_leak(similar_words[: max(3, min(10, pool_size))])
                if pick:
                    return pick
    
    # Random guess from available words
    # Even on random guesses, avoid self-leak when possible.
    # Don't evaluate the full theme every time; sample a reasonable set.
    pool_size = int(config.get("candidate_pool", 12) or 12)
    sample_n = max(8, min(len(available_words), pool_size * (2 if panic else 1)))
    sample = random.sample(available_words, sample_n) if sample_n < len(available_words) else available_words
    pick = pick_low_leak(sample)
    if pick:
        return pick
    return str(random.choice(available_words))


def ai_change_word(ai_player: dict, game: dict) -> Optional[str]:
    """AI chooses a new secret word after eliminating someone."""
    word_pool = ai_player.get("word_pool", [])
    guessed_words = [e.get("word", "").lower() for e in game.get("history", []) if e.get("word")]
    
    # Filter out guessed words from pool
    available_words = [w for w in word_pool if w.lower() not in guessed_words]
    
    if not available_words:
        return None
    
    return ai_select_secret_word(ai_player, available_words)


def process_ai_turn(game: dict, ai_player: dict) -> Optional[dict]:
    """Process an AI player's turn and return the guess result."""
    import random
    
    if not ai_player.get("is_ai") or not ai_player.get("is_alive"):
        return None
    
    # Choose a guess
    guess_word = ai_choose_guess(ai_player, game)
    if not guess_word:
        return None
    
    # Get embedding and calculate similarities
    try:
        guess_embedding = get_embedding(guess_word)
    except Exception as e:
        print(f"AI embedding error: {e}")
        return None
    
    similarities = {}
    for p in game["players"]:
        if p.get("secret_embedding"):
            sim = cosine_similarity(guess_embedding, p["secret_embedding"])
            similarities[p["id"]] = round(sim, 2)
    
    # Check for eliminations
    eliminations = []
    for p in game["players"]:
        if p["id"] != ai_player["id"] and p.get("is_alive"):
            if guess_word.lower() == p.get("secret_word", "").lower():
                p["is_alive"] = False
                eliminations.append(p["id"])
    
    # If AI eliminated someone, they can change their word
    if eliminations:
        ai_player["can_change_word"] = True
    
    # Update AI memory
    ai_update_memory(ai_player, guess_word, similarities, game)
    
    # Also update other AI players' memories
    for p in game["players"]:
        if p.get("is_ai") and p["id"] != ai_player["id"]:
            ai_update_memory(p, guess_word, similarities, game)
    
    # Record history
    history_entry = {
        "guesser_id": ai_player["id"],
        "guesser_name": ai_player["name"],
        "word": guess_word.lower(),
        "similarities": similarities,
        "eliminations": eliminations,
    }
    game["history"].append(history_entry)
    
    return {
        "word": guess_word,
        "similarities": similarities,
        "eliminations": eliminations,
    }


def process_ai_word_change(game: dict, ai_player: dict) -> bool:
    """Process AI word change after elimination."""
    import random
    
    if not ai_player.get("can_change_word"):
        return False
    
    difficulty = ai_player.get("difficulty", "rookie")
    config = AI_DIFFICULTY_CONFIG.get(difficulty, AI_DIFFICULTY_CONFIG.get("rookie", {}))

    # Strategic word change: if we're in danger, strongly prefer changing to reset opponents' intel.
    my_top = _ai_top_guesses_since_change(game, ai_player.get("id"), k=3)
    my_danger_score = _ai_danger_score(my_top)
    my_danger_level = _ai_danger_level(my_danger_score)
    panic_threshold = str(config.get("panic_danger", "high") or "high")
    panic = _ai_is_panic(my_danger_level, panic_threshold)

    # Baseline chance (keeps some variety/fun)
    change_prob = 0.7
    if my_danger_level == "safe":
        change_prob = 0.55
    elif my_danger_level == "low":
        change_prob = 0.65
    elif my_danger_level == "medium":
        change_prob = 0.78
    elif my_danger_level == "high":
        change_prob = 0.9
    elif my_danger_level == "critical":
        change_prob = 0.97
    if panic:
        change_prob = max(change_prob, 0.92)

    if random.random() < change_prob:
        new_word = ai_change_word(ai_player, game)
        if new_word:
            try:
                embedding = get_embedding(new_word)
                ai_player["secret_word"] = new_word.lower()
                ai_player["secret_embedding"] = embedding
                
                # Record word change in history
                game["history"].append({
                    "type": "word_change",
                    "player_id": ai_player["id"],
                    "player_name": ai_player["name"],
                })
            except Exception as e:
                print(f"AI word change error: {e}")
    
    ai_player["can_change_word"] = False
    return True


# Initialise clients lazily
_openai_client = None
_redis_client = None


def get_openai_client():
    global _openai_client
    if _openai_client is None:
        _openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return _openai_client


def get_redis():
    global _redis_client
    if _redis_client is None:
        _redis_client = Redis(
            url=os.getenv("UPSTASH_REDIS_REST_URL"),
            token=os.getenv("UPSTASH_REDIS_REST_TOKEN"),
        )
    return _redis_client


# ============== RATE LIMITING ==============

# Rate limiters (lazy initialized)
_ratelimit_general = None
_ratelimit_game_create = None
_ratelimit_join = None
_ratelimit_guess = None
_ratelimit_chat = None


def get_ratelimit_general():
    """General rate limiter: 60 requests/minute per IP."""
    global _ratelimit_general
    if _ratelimit_general is None:
        _ratelimit_general = Ratelimit(
            redis=get_redis(),
            limiter=FixedWindow(max_requests=60, window=60),
            prefix="ratelimit:general",
        )
    return _ratelimit_general


def get_ratelimit_game_create():
    """Game creation rate limiter: 5 games/minute per IP."""
    global _ratelimit_game_create
    if _ratelimit_game_create is None:
        _ratelimit_game_create = Ratelimit(
            redis=get_redis(),
            limiter=FixedWindow(max_requests=5, window=60),
            prefix="ratelimit:create",
        )
    return _ratelimit_game_create


def get_ratelimit_join():
    """Join rate limiter: 10 joins/minute per IP."""
    global _ratelimit_join
    if _ratelimit_join is None:
        _ratelimit_join = Ratelimit(
            redis=get_redis(),
            limiter=FixedWindow(max_requests=10, window=60),
            prefix="ratelimit:join",
        )
    return _ratelimit_join


def get_ratelimit_guess():
    """Guess rate limiter: 30 guesses/minute per IP."""
    global _ratelimit_guess
    if _ratelimit_guess is None:
        _ratelimit_guess = Ratelimit(
            redis=get_redis(),
            limiter=FixedWindow(max_requests=30, window=60),
            prefix="ratelimit:guess",
        )
    return _ratelimit_guess


def get_ratelimit_chat():
    """Chat rate limiter: 20 messages/minute per player."""
    global _ratelimit_chat
    if _ratelimit_chat is None:
        _ratelimit_chat = Ratelimit(
            redis=get_redis(),
            limiter=FixedWindow(max_requests=20, window=60),
            prefix="ratelimit:chat",
        )
    return _ratelimit_chat


def check_rate_limit(limiter, identifier: str) -> bool:
    """Returns True if request is allowed, False if rate limited."""
    try:
        result = limiter.limit(identifier)
        return result.allowed
    except Exception:
        # If rate limiting fails, allow the request (fail open)
        return True


def get_client_ip(headers) -> str:
    """Extract client IP from headers."""
    # X-Forwarded-For may contain multiple IPs; take the first one
    forwarded = headers.get('X-Forwarded-For', '')
    if forwarded:
        return forwarded.split(',')[0].strip()
    # Fallback to X-Real-IP
    real_ip = headers.get('X-Real-IP', '')
    if real_ip:
        return real_ip.strip()
    return 'unknown'


def get_theme_words(category: str) -> dict:
    """Get pre-generated theme words for a category."""
    def _sanitize_theme_words(raw_words: list) -> list:
        cleaned = []
        seen = set()
        for w in (raw_words or []):
            token = str(w or "").strip().lower()
            if not token:
                continue
            # Only allow words that match the game's input validation (letters only, 2-30 chars)
            if not WORD_PATTERN.match(token):
                continue
            # Remove profane words from playable pools (chat filter is separate)
            if token in PROFANITY_WORDS:
                continue
            if token in seen:
                continue
            seen.add(token)
            cleaned.append(token)
        return cleaned

    requested = str(category or "").strip()
    key = requested
    if key not in PREGENERATED_THEMES:
        alias = THEME_ALIASES.get(requested.lower())
        if alias and alias in PREGENERATED_THEMES:
            key = alias
        elif PREGENERATED_THEMES:
            # Deterministic fallback for unknown themes (should be rare; mainly old lobbies).
            key = next(iter(PREGENERATED_THEMES.keys()))

    words = _sanitize_theme_words(PREGENERATED_THEMES.get(key, []))
    return {"name": key or requested, "words": words}


# ============== AUTHENTICATION (Google OAuth) ==============

# OAuth Configuration
GOOGLE_CLIENT_ID = os.getenv('GOOGLE_CLIENT_ID', '')
ADMIN_PASSWORD = os.getenv('ADMIN_PASSWORD', '')
GOOGLE_CLIENT_SECRET = os.getenv('GOOGLE_CLIENT_SECRET', '')
JWT_SECRET = os.getenv('JWT_SECRET', secrets.token_hex(32))
JWT_ALGORITHM = 'HS256'
JWT_EXPIRY_HOURS = 24 * 7  # 1 week

# OAuth URLs
GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'

OAUTH_STATE_TTL_SECONDS = int(os.getenv('OAUTH_STATE_TTL_SECONDS', str(CONFIG.get("oauth", {}).get("state_ttl_seconds", 600))))


def get_request_base_url(headers) -> str:
    """Best-effort base URL for the current request (behind proxies like Vercel)."""
    proto = (headers.get('X-Forwarded-Proto') or 'https').split(',')[0].strip().lower()
    host = (headers.get('X-Forwarded-Host') or headers.get('Host') or '').split(',')[0].strip()
    if proto not in ('http', 'https'):
        proto = 'https'
    if host.startswith('localhost') or host.startswith('127.0.0.1'):
        proto = 'http'
    if not host:
        site_url = os.getenv('SITE_URL', '').rstrip('/')
        if site_url:
            return site_url
        return 'http://localhost:3000'
    return f"{proto}://{host}"


def get_oauth_redirect_uri() -> str:
    """Get the OAuth callback URL based on environment."""
    # Use explicit OAUTH_REDIRECT_URI if set, otherwise construct from SITE_URL or VERCEL_URL
    explicit_uri = os.getenv('OAUTH_REDIRECT_URI')
    if explicit_uri:
        return explicit_uri
    
    # Prefer SITE_URL (production domain) over VERCEL_URL (deployment-specific)
    site_url = os.getenv('SITE_URL', '')
    if site_url:
        # Remove trailing slash if present
        site_url = site_url.rstrip('/')
        return f"{site_url}/api/auth/callback"
    
    # Fallback to VERCEL_URL (deployment-specific, not recommended for OAuth)
    base_url = os.getenv('VERCEL_URL', 'localhost:3000')
    # Default to https unless localhost
    protocol = 'http' if base_url.startswith(('localhost', '127.0.0.1')) else 'https'
    return f"{protocol}://{base_url}/api/auth/callback"


def create_jwt_token(user_data: dict) -> str:
    """Create a JWT token for authenticated user."""
    payload = {
        'sub': user_data['id'],
        'email': user_data.get('email', ''),
        'name': user_data.get('name', ''),
        'avatar': user_data.get('avatar', ''),
        'iat': int(time.time()),
        'exp': int(time.time()) + (JWT_EXPIRY_HOURS * 3600),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_jwt_token(token: str) -> Optional[dict]:
    """Verify and decode a JWT token. Returns None if invalid."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


# Admin emails that automatically get donor status
ADMIN_EMAILS = [
    'jamesleung425@gmail.com',
]

def get_or_create_user(google_user: dict) -> dict:
    """Get existing user or create new one from Google user data."""
    redis = get_redis()
    user_id = f"google_{google_user['id']}"
    user_key = f"user:{user_id}"
    
    user_email = google_user.get('email', '').lower()
    is_admin = user_email in [e.lower() for e in ADMIN_EMAILS]
    
    # Check if user exists
    existing = redis.get(user_key)
    if existing:
        user = json.loads(existing)
        # Update name/avatar in case they changed
        user['name'] = google_user.get('name', user['name'])
        user['avatar'] = google_user.get('picture', user.get('avatar', ''))
        # Ensure cosmetics field exists for existing users
        if 'cosmetics' not in user:
            user['cosmetics'] = DEFAULT_COSMETICS.copy()
        if 'cosmetics_version' not in user:
            user['cosmetics_version'] = 1
        # Ensure stats exist (and include new mp_* fields)
        if 'stats' not in user or not isinstance(user.get('stats'), dict):
            user['stats'] = DEFAULT_USER_STATS.copy()
        else:
            merged = DEFAULT_USER_STATS.copy()
            merged.update(user.get('stats', {}))
            user['stats'] = merged
        # Ensure economy fields exist (daily quests + currency + owned cosmetics)
        if 'wallet' not in user or not isinstance(user.get('wallet'), dict):
            user['wallet'] = DEFAULT_WALLET.copy()
        else:
            # Best-effort sanitize credits
            try:
                credits = int((user.get('wallet') or {}).get('credits', 0) or 0)
            except Exception:
                credits = 0
            if credits < 0:
                credits = 0
            user['wallet'] = {"credits": credits}
        if 'owned_cosmetics' not in user or not isinstance(user.get('owned_cosmetics'), dict):
            user['owned_cosmetics'] = {}
        if 'daily_quests' not in user or not isinstance(user.get('daily_quests'), dict):
            user['daily_quests'] = new_daily_quests_state()
        if 'is_donor' not in user:
            user['is_donor'] = False
        # Auto-grant donor status to admins
        if is_admin and not user.get('is_donor'):
            user['is_donor'] = True
            user['donation_date'] = int(time.time())
        redis.set(user_key, json.dumps(user))
        return user
    
    # Create new user
    user = {
        'id': user_id,
        'email': google_user.get('email', ''),
        'name': google_user.get('name', 'Anonymous'),
        'avatar': google_user.get('picture', ''),
        'created_at': int(time.time()),
        'is_donor': is_admin,  # Admins start as donors
        'donation_date': int(time.time()) if is_admin else None,
        'cosmetics': DEFAULT_COSMETICS.copy(),
        'cosmetics_version': COSMETICS_SCHEMA_VERSION,
        'stats': DEFAULT_USER_STATS.copy(),
        'wallet': DEFAULT_WALLET.copy(),
        'owned_cosmetics': {},
        'daily_quests': new_daily_quests_state(),
    }
    redis.set(user_key, json.dumps(user))
    
    # Add to users set for leaderboard
    redis.sadd('users:all', user_id)
    
    # Also index by email for Ko-fi webhook lookup
    if google_user.get('email'):
        redis.set(f"email_to_user:{google_user['email'].lower()}", user_id)
    
    return user


def get_user_by_id(user_id: str) -> Optional[dict]:
    """Get user by ID."""
    redis = get_redis()
    user_key = f"user:{user_id}"
    data = redis.get(user_key)
    if data:
        return json.loads(data)
    return None


def save_user(user: dict):
    """Save user data."""
    redis = get_redis()
    user_key = f"user:{user['id']}"
    redis.set(user_key, json.dumps(user))


def get_user_by_email(email: str) -> Optional[dict]:
    """Get user by email address (for Ko-fi webhook)."""
    redis = get_redis()
    user_id = redis.get(f"email_to_user:{email.lower()}")
    if user_id:
        return get_user_by_id(user_id)
    return None


def get_user_cosmetics(user: dict) -> dict:
    """
    Get user's equipped cosmetics with defaults for missing fields.

    Also performs schema migration + enforcement so:
    - removed/renamed cosmetics are mapped or reset
    - premium cosmetics can't be used by non-donors when paywall is enabled
    - grind-locked cosmetics can't be used without meeting requirements
    """
    if not isinstance(user, dict):
        return DEFAULT_COSMETICS.copy()

    cosmetics = user.get('cosmetics', {})
    if not isinstance(cosmetics, dict):
        cosmetics = {}

    # Merge with defaults to ensure all fields exist
    result = DEFAULT_COSMETICS.copy()
    result.update(cosmetics)

    # Track whether we need to persist a migrated/sanitized payload
    changed = False

    # Ensure schema version exists and is current
    try:
        stored_version = int(user.get('cosmetics_version', 1) or 1)
    except Exception:
        stored_version = 1
    if stored_version != COSMETICS_SCHEMA_VERSION:
        user['cosmetics_version'] = COSMETICS_SCHEMA_VERSION
        changed = True

    is_donor = bool(user.get('is_donor', False))
    is_admin = bool(user.get('is_admin', False))
    user_stats = get_user_stats(user)
    owned_cosmetics = (ensure_user_economy(user, persist=False).get("owned_cosmetics") or {}) if isinstance(user, dict) else {}

    for category_key, catalog_key in COSMETIC_CATEGORY_TO_CATALOG_KEY.items():
        desired = result.get(category_key, DEFAULT_COSMETICS.get(category_key))

        item = get_cosmetic_item(catalog_key, desired)
        if not item:
            # Try legacy ID mapping (for hard restarts)
            mapped = (LEGACY_COSMETIC_ID_MAP.get(category_key) or {}).get(desired)
            if mapped:
                # If we mapped into a supporter badge, only keep it when allowed.
                if (
                    category_key == 'badge'
                    and mapped == 'coffee'
                    and COSMETICS_PAYWALL_ENABLED
                    and not (is_donor or is_admin)
                ):
                    mapped = 'none'
                desired = mapped
                item = get_cosmetic_item(catalog_key, desired)

            # If still invalid, reset to default
            if not item:
                desired = DEFAULT_COSMETICS.get(category_key)
                item = get_cosmetic_item(catalog_key, desired)

            result[category_key] = desired
            changed = True

        # Enforce premium gating (feature-flagged)
        if (
            item
            and COSMETICS_PAYWALL_ENABLED
            and not COSMETICS_UNLOCK_ALL
            and item.get('premium', False)
            and not (is_donor or is_admin)
        ):
            fallback = DEFAULT_COSMETICS.get(category_key)
            if result.get(category_key) != fallback:
                result[category_key] = fallback
                changed = True
            continue

        # Enforce shop ownership gating (priced cosmetics must be purchased)
        if item and not (is_admin or COSMETICS_UNLOCK_ALL):
            try:
                price = int(item.get('price', 0) or 0)
            except Exception:
                price = 0
            if price > 0:
                owned_list = owned_cosmetics.get(category_key, [])
                if not isinstance(owned_list, list) or desired not in owned_list:
                    fallback = DEFAULT_COSMETICS.get(category_key)
                    if result.get(category_key) != fallback:
                        result[category_key] = fallback
                        changed = True
                    continue

        # Enforce progression gating (always on)
        if item and not (is_admin or COSMETICS_UNLOCK_ALL):
            unmet = get_unmet_cosmetic_requirement(item, user_stats)
            if unmet:
                fallback = DEFAULT_COSMETICS.get(category_key)
                if result.get(category_key) != fallback:
                    result[category_key] = fallback
                    changed = True
                continue

    if changed:
        user['cosmetics'] = result
        save_user(user)

    return result


def get_user_stats(user: dict) -> dict:
    """Get authenticated user's stats with defaults for missing fields."""
    stats = user.get('stats', {})
    result = DEFAULT_USER_STATS.copy()
    if isinstance(stats, dict):
        result.update(stats)
    return result


def _normalize_wallet(wallet) -> dict:
    """Best-effort normalize wallet payload."""
    if not isinstance(wallet, dict):
        wallet = {}
    try:
        credits = int(wallet.get('credits', 0) or 0)
    except Exception:
        credits = 0
    if credits < 0:
        credits = 0
    return {"credits": credits}


def _normalize_owned_cosmetics(owned) -> dict:
    """Normalize owned cosmetics to {category_key: [cosmetic_id, ...]}."""
    if not isinstance(owned, dict):
        return {}
    result = {}
    for k, v in owned.items():
        if not isinstance(k, str):
            continue
        # Only keep known cosmetic category keys
        if k not in COSMETIC_CATEGORY_TO_CATALOG_KEY:
            continue
        if not isinstance(v, list):
            continue
        seen = set()
        cleaned = []
        for item in v:
            if not isinstance(item, str):
                continue
            cid = item.strip()
            if not cid:
                continue
            if cid in seen:
                continue
            seen.add(cid)
            cleaned.append(cid)
        if cleaned:
            result[k] = cleaned
    return result


def _normalize_daily_quests_state(state) -> dict:
    """Normalize daily quest state payload shape (does not validate quest contents)."""
    if not isinstance(state, dict):
        return new_daily_quests_state()
    date = state.get('date', '')
    if not isinstance(date, str):
        date = ''
    quests = state.get('quests', [])
    if not isinstance(quests, list):
        quests = []
    return {"date": date, "quests": quests}


def ensure_user_economy(user: dict, persist: bool = True) -> dict:
    """
    Ensure economy fields exist and are normalized on an authenticated user record.

    Returns a dict containing wallet/owned_cosmetics/daily_quests (normalized).
    """
    if not isinstance(user, dict):
        return {
            "wallet": DEFAULT_WALLET.copy(),
            "owned_cosmetics": {},
            "daily_quests": new_daily_quests_state(),
        }

    changed = False

    wallet_norm = _normalize_wallet(user.get('wallet', {}))
    if user.get('wallet') != wallet_norm:
        user['wallet'] = wallet_norm
        changed = True

    owned_norm = _normalize_owned_cosmetics(user.get('owned_cosmetics', {}))
    # Only compare dicts; if original isn't dict, it's definitely changed
    if not isinstance(user.get('owned_cosmetics'), dict) or user.get('owned_cosmetics') != owned_norm:
        user['owned_cosmetics'] = owned_norm
        changed = True

    daily_norm = _normalize_daily_quests_state(user.get('daily_quests'))
    if not isinstance(user.get('daily_quests'), dict) or user.get('daily_quests') != daily_norm:
        user['daily_quests'] = daily_norm
        changed = True

    if changed and persist:
        save_user(user)

    return {
        "wallet": wallet_norm,
        "owned_cosmetics": owned_norm,
        "daily_quests": daily_norm,
    }


def get_user_credits(user: dict) -> int:
    econ = ensure_user_economy(user, persist=False)
    try:
        return int((econ.get('wallet') or {}).get('credits', 0) or 0)
    except Exception:
        return 0


def add_user_credits(user: dict, delta: int, persist: bool = True) -> int:
    econ = ensure_user_economy(user, persist=False)
    try:
        delta_int = int(delta or 0)
    except Exception:
        delta_int = 0
    credits = get_user_credits(user)
    new_credits = credits + delta_int
    if new_credits < 0:
        new_credits = 0
    user['wallet'] = {"credits": int(new_credits)}
    if persist:
        save_user(user)
    return int(new_credits)


def user_owns_cosmetic(user: dict, category_key: str, cosmetic_id: str) -> bool:
    if not isinstance(category_key, str) or not isinstance(cosmetic_id, str):
        return False
    econ = ensure_user_economy(user, persist=False)
    owned = econ.get('owned_cosmetics') or {}
    items = owned.get(category_key, [])
    if not isinstance(items, list):
        return False
    return cosmetic_id in items


def grant_owned_cosmetic(user: dict, category_key: str, cosmetic_id: str, persist: bool = True) -> bool:
    """Mark a cosmetic as owned for a user. Returns True if it changed."""
    if not isinstance(user, dict):
        return False
    if not isinstance(category_key, str) or not isinstance(cosmetic_id, str):
        return False
    category_key = category_key.strip()
    cosmetic_id = cosmetic_id.strip()
    if not category_key or not cosmetic_id:
        return False
    if category_key not in COSMETIC_CATEGORY_TO_CATALOG_KEY:
        return False

    econ = ensure_user_economy(user, persist=False)
    owned = econ.get('owned_cosmetics') or {}
    current = owned.get(category_key, [])
    if not isinstance(current, list):
        current = []
    if cosmetic_id in current:
        return False
    current.append(cosmetic_id)
    owned[category_key] = current
    user['owned_cosmetics'] = _normalize_owned_cosmetics(owned)
    if persist:
        save_user(user)
    return True


def load_admin_economy_user(redis: "Redis") -> dict:
    """Load admin_local economy state from Redis and return a user-like dict (not stored as user:{id})."""
    state = {}
    try:
        raw = redis.get(ADMIN_ECONOMY_KEY)
        if raw:
            loaded = json.loads(raw)
            if isinstance(loaded, dict):
                state = loaded
    except Exception:
        state = {}

    admin_user = {
        "id": "admin_local",
        "is_admin": True,
        "is_donor": True,
        "stats": DEFAULT_USER_STATS.copy(),
        "wallet": state.get("wallet"),
        "owned_cosmetics": state.get("owned_cosmetics"),
        "daily_quests": state.get("daily_quests"),
    }

    ensure_user_economy(admin_user, persist=False)
    # Default admin wallet: generous balance for testing
    if get_user_credits(admin_user) <= 0:
        admin_user["wallet"] = {"credits": 999999}
    return admin_user


def save_admin_economy_user(redis: "Redis", admin_user: dict):
    """Persist admin_local economy state to Redis (best-effort)."""
    if not isinstance(admin_user, dict):
        return
    econ = ensure_user_economy(admin_user, persist=False)
    payload = {
        "wallet": econ.get("wallet") or {"credits": 0},
        "owned_cosmetics": econ.get("owned_cosmetics") or {},
        "daily_quests": econ.get("daily_quests") or new_daily_quests_state(),
    }
    try:
        redis.set(ADMIN_ECONOMY_KEY, json.dumps(payload), ex=ADMIN_ECONOMY_TTL_SECONDS)
    except Exception:
        try:
            redis.set(ADMIN_ECONOMY_KEY, json.dumps(payload))
        except Exception:
            pass


def utc_today_str() -> str:
    """Return today's date as YYYY-MM-DD in UTC."""
    return time.strftime('%Y-%m-%d', time.gmtime())


def utc_yesterday_str() -> str:
    """Return yesterday's date as YYYY-MM-DD in UTC."""
    yesterday = time.time() - 86400
    return time.strftime('%Y-%m-%d', time.gmtime(yesterday))


# ============== STREAK SYSTEM FUNCTIONS ==============

def _normalize_streak(streak) -> dict:
    """Normalize streak data to expected shape."""
    if not isinstance(streak, dict):
        streak = {}
    try:
        count = int(streak.get('streak_count', 0) or 0)
    except Exception:
        count = 0
    if count < 0:
        count = 0
    
    last_date = streak.get('streak_last_date', '')
    if not isinstance(last_date, str):
        last_date = ''
    
    try:
        longest = int(streak.get('longest_streak', 0) or 0)
    except Exception:
        longest = 0
    if longest < 0:
        longest = 0
    if count > longest:
        longest = count
    
    claimed = bool(streak.get('streak_claimed_today', False))
    
    return {
        "streak_count": count,
        "streak_last_date": last_date,
        "longest_streak": longest,
        "streak_claimed_today": claimed,
    }


def get_user_streak(user: dict) -> dict:
    """Get user's streak data with defaults."""
    if not isinstance(user, dict):
        return DEFAULT_STREAK.copy()
    return _normalize_streak(user.get('streak', {}))


def get_streak_multiplier(streak_count: int) -> float:
    """Get the credit multiplier for a given streak count."""
    if streak_count <= 0:
        return 1.0
    # Find the highest applicable multiplier
    best_mult = 1.0
    for threshold, mult in sorted(STREAK_MULTIPLIERS.items()):
        if streak_count >= threshold:
            best_mult = mult
        else:
            break
    return best_mult


def get_streak_milestone_bonus(streak_count: int) -> int:
    """Get one-time milestone bonus for reaching a streak count (0 if not a milestone)."""
    return STREAK_MILESTONE_BONUSES.get(streak_count, 0)


def check_and_update_streak(user: dict, persist: bool = True) -> dict:
    """
    Check and update user's daily streak. Call this when user plays a game or opens daily ops.
    
    Returns a dict with:
    - streak: updated streak data
    - credits_earned: credits earned from streak bonus (0 if already claimed today)
    - milestone_bonus: one-time milestone bonus (0 if not applicable)
    - is_new_day: True if this is a new day for the streak
    - streak_broken: True if streak was reset due to missing a day
    """
    if not isinstance(user, dict):
        return {
            "streak": DEFAULT_STREAK.copy(),
            "credits_earned": 0,
            "milestone_bonus": 0,
            "is_new_day": False,
            "streak_broken": False,
        }
    
    today = utc_today_str()
    yesterday = utc_yesterday_str()
    
    streak = get_user_streak(user)
    last_date = streak.get('streak_last_date', '')
    current_count = streak.get('streak_count', 0)
    longest = streak.get('longest_streak', 0)
    claimed_today = streak.get('streak_claimed_today', False)
    
    credits_earned = 0
    milestone_bonus = 0
    is_new_day = False
    streak_broken = False
    
    if last_date == today:
        # Already played today - no change to streak
        pass
    elif last_date == yesterday:
        # Consecutive day! Increment streak
        is_new_day = True
        current_count += 1
        claimed_today = False  # Reset claim status for new day
        if current_count > longest:
            longest = current_count
    elif last_date == '':
        # First time playing
        is_new_day = True
        current_count = 1
        claimed_today = False
        if current_count > longest:
            longest = current_count
    else:
        # Streak broken - reset to 1
        is_new_day = True
        streak_broken = current_count > 1
        current_count = 1
        claimed_today = False
    
    # Calculate credits if not already claimed today
    if is_new_day and not claimed_today:
        multiplier = get_streak_multiplier(current_count)
        credits_earned = int(STREAK_BASE_CREDITS * multiplier)
        milestone_bonus = get_streak_milestone_bonus(current_count)
        claimed_today = True
        
        # Add credits to wallet
        ensure_user_economy(user, persist=False)
        wallet = user.get('wallet', {})
        if not isinstance(wallet, dict):
            wallet = {}
        try:
            current_credits = int(wallet.get('credits', 0) or 0)
        except Exception:
            current_credits = 0
        wallet['credits'] = current_credits + credits_earned + milestone_bonus
        user['wallet'] = wallet
    
    # Update streak data
    streak = {
        "streak_count": current_count,
        "streak_last_date": today,
        "longest_streak": longest,
        "streak_claimed_today": claimed_today,
    }
    user['streak'] = streak
    
    if persist:
        save_user(user)
    
    return {
        "streak": streak,
        "credits_earned": credits_earned,
        "milestone_bonus": milestone_bonus,
        "is_new_day": is_new_day,
        "streak_broken": streak_broken,
    }


def get_next_streak_info(streak_count: int) -> dict:
    """Get info about the next streak milestone/bonus."""
    current_mult = get_streak_multiplier(streak_count)
    current_credits = int(STREAK_BASE_CREDITS * current_mult)
    
    # Find next multiplier increase
    next_mult_day = None
    next_mult_credits = current_credits
    for threshold in sorted(STREAK_MULTIPLIERS.keys()):
        if threshold > streak_count:
            next_mult_day = threshold
            next_mult_credits = int(STREAK_BASE_CREDITS * STREAK_MULTIPLIERS[threshold])
            break
    
    # Find next milestone bonus
    next_milestone_day = None
    next_milestone_bonus = 0
    for threshold in sorted(STREAK_MILESTONE_BONUSES.keys()):
        if threshold > streak_count:
            next_milestone_day = threshold
            next_milestone_bonus = STREAK_MILESTONE_BONUSES[threshold]
            break
    
    return {
        "current_daily_credits": current_credits,
        "next_multiplier_day": next_mult_day,
        "next_multiplier_credits": next_mult_credits,
        "next_milestone_day": next_milestone_day,
        "next_milestone_bonus": next_milestone_bonus,
    }


def _daily_rng(seed_text: str):
    """Deterministic RNG for daily content across serverless invocations."""
    import random
    digest = hashlib.sha256(seed_text.encode('utf-8')).digest()
    seed_int = int.from_bytes(digest[:8], 'big', signed=False)
    return random.Random(seed_int)


def _build_daily_quest(date_str: str, category: str, metric: str, target: int, reward_credits: int, title: str, description: str, quest_type: str = "daily") -> dict:
    try:
        target_int = int(target or 0)
    except Exception:
        target_int = 0
    try:
        reward_int = int(reward_credits or 0)
    except Exception:
        reward_int = 0
    if target_int < 0:
        target_int = 0
    if reward_int < 0:
        reward_int = 0
    quest_id = f"{date_str}:{metric}:{target_int}:{quest_type}"
    return {
        "id": quest_id,
        "category": str(category or ""),
        "metric": str(metric or ""),
        "title": str(title or ""),
        "description": str(description or ""),
        "target": int(target_int),
        "progress": 0,
        "reward_credits": int(reward_int),
        "claimed": False,
        "quest_type": quest_type,  # "daily" or "weekly"
    }


def get_week_start_str() -> str:
    """Return the start of the current week (Monday) as YYYY-MM-DD in UTC."""
    import datetime
    now = datetime.datetime.utcnow()
    # Monday = 0, Sunday = 6
    days_since_monday = now.weekday()
    monday = now - datetime.timedelta(days=days_since_monday)
    return monday.strftime('%Y-%m-%d')


def generate_daily_quests_for_user(user: dict, date_str: str) -> list:
    """
    Generate a deterministic-but-random daily quest set for a user for a given UTC date.
    Now includes enhanced quest categories and scaling based on player experience.
    """
    uid = str((user or {}).get('id', '') or '')
    rng = _daily_rng(f"{uid}:{date_str}:daily_quests:v2")
    
    # Get user stats for difficulty scaling
    stats = get_user_stats(user)
    try:
        total_games = int(stats.get('mp_games_played', 0) or 0)
    except Exception:
        total_games = 0
    
    # Determine player tier for quest difficulty
    # New players (0-10 games) get easier quests
    # Mid players (11-50 games) get normal quests
    # Veterans (50+ games) get harder quests with better rewards
    if total_games <= 10:
        tier = "new"
        tier_mult = 0.7  # Easier targets
        reward_mult = 0.8  # Slightly lower rewards
    elif total_games <= 50:
        tier = "mid"
        tier_mult = 1.0
        reward_mult = 1.0
    else:
        tier = "veteran"
        tier_mult = 1.3  # Harder targets
        reward_mult = 1.25  # Better rewards

    # Base categories always present
    categories = ["engagement", "combat", "victory"]
    
    # Get user streak for streak quests
    streak = get_user_streak(user)
    streak_count = streak.get('streak_count', 0)

    # Optional ranked wildcard (only if user has played ranked before)
    try:
        ranked_games = int(stats.get('ranked_games', 0) or 0)
    except Exception:
        ranked_games = 0
    ranked_eligible = ranked_games > 0

    if ranked_eligible:
        # 25% chance to include a ranked quest
        if rng.random() < 0.25:
            replace_idx = int(rng.random() * len(categories))
            categories[replace_idx] = "ranked"
    
    # 20% chance for a challenge quest (special objectives)
    if rng.random() < 0.20:
        replace_idx = int(rng.random() * len(categories))
        categories[replace_idx] = "challenge"
    
    # Quest definitions with tier scaling
    def scale_target(base: int) -> int:
        return max(1, int(base * tier_mult))
    
    def scale_reward(base: int) -> int:
        return max(10, int(base * reward_mult))

    defs = {
        "engagement": [
            ("mp_games", scale_target(2), scale_reward(35), "RUN OPERATIONS", "Play 2 multiplayer games"),
            ("mp_games", scale_target(3), scale_reward(55), "FIELD WORK", "Play 3 multiplayer games"),
            ("mp_games", scale_target(4), scale_reward(75), "FULL SHIFT", "Play 4 multiplayer games"),
        ],
        "combat": [
            ("mp_elims", scale_target(2), scale_reward(45), "TARGET PRACTICE", "Get 2 eliminations"),
            ("mp_elims", scale_target(4), scale_reward(70), "HUNTER MODE", "Get 4 eliminations"),
            ("mp_elims", scale_target(6), scale_reward(95), "EXECUTION ORDER", "Get 6 eliminations"),
        ],
        "victory": [
            ("mp_wins", 1, scale_reward(85), "SECURE THE WIN", "Win 1 multiplayer game"),
            ("mp_wins", scale_target(2), scale_reward(140), "DOMINATE", "Win 2 multiplayer games"),
        ],
        "ranked": [
            ("ranked_games", 1, scale_reward(90), "RANKED DEPLOYMENT", "Play 1 ranked game"),
            ("ranked_wins", 1, scale_reward(160), "RANKED VICTORY", "Win 1 ranked game"),
        ],
        "challenge": [
            ("mp_elims_single", 2, scale_reward(120), "DOUBLE KILL", "Get 2+ eliminations in one game"),
            ("mp_elims_single", 3, scale_reward(200), "TRIPLE THREAT", "Get 3+ eliminations in one game"),
            ("mp_first_elim", 1, scale_reward(80), "FIRST BLOOD", "Get the first elimination in a game"),
            ("mp_flawless", 1, scale_reward(250), "FLAWLESS", "Win without being eliminated"),
        ],
    }

    quests = []
    for cat in categories:
        options = defs.get(cat) or []
        if not options:
            continue
        metric, target, reward, title, desc = rng.choice(options)
        quests.append(_build_daily_quest(date_str, cat, metric, target, reward, title, desc, "daily"))

    # Guarantee stable ordering
    quests.sort(key=lambda q: (q.get('category', ''), q.get('metric', ''), int(q.get('target', 0) or 0)))
    return quests


def generate_weekly_quests_for_user(user: dict, week_start: str) -> list:
    """
    Generate weekly quests for a user. These persist for 7 days and have higher rewards.
    """
    uid = str((user or {}).get('id', '') or '')
    rng = _daily_rng(f"{uid}:{week_start}:weekly_quests:v1")
    
    # Get user stats
    stats = get_user_stats(user)
    try:
        total_games = int(stats.get('mp_games_played', 0) or 0)
    except Exception:
        total_games = 0
    
    # Tier multiplier
    if total_games <= 10:
        reward_mult = 0.8
    elif total_games <= 50:
        reward_mult = 1.0
    else:
        reward_mult = 1.25
    
    def scale_reward(base: int) -> int:
        return max(50, int(base * reward_mult))
    
    # Weekly quest definitions (higher targets, much higher rewards)
    weekly_options = [
        ("mp_games", 10, scale_reward(300), "WEEKLY OPS", "Play 10 games this week"),
        ("mp_games", 15, scale_reward(500), "DEDICATED AGENT", "Play 15 games this week"),
        ("mp_wins", 5, scale_reward(400), "WEEKLY CHAMPION", "Win 5 games this week"),
        ("mp_wins", 8, scale_reward(650), "WEEKLY DOMINATOR", "Win 8 games this week"),
        ("mp_elims", 15, scale_reward(350), "WEEKLY HUNTER", "Get 15 eliminations this week"),
        ("mp_elims", 25, scale_reward(550), "WEEKLY EXECUTIONER", "Get 25 eliminations this week"),
    ]
    
    # Check if user plays ranked
    try:
        ranked_games = int(stats.get('ranked_games', 0) or 0)
    except Exception:
        ranked_games = 0
    
    if ranked_games > 0:
        weekly_options.extend([
            ("ranked_games", 5, scale_reward(450), "RANKED WEEK", "Play 5 ranked games this week"),
            ("ranked_wins", 3, scale_reward(600), "RANKED DOMINATION", "Win 3 ranked games this week"),
        ])
    
    # Pick 2 weekly quests
    quests = []
    chosen = rng.sample(weekly_options, min(2, len(weekly_options)))
    for metric, target, reward, title, desc in chosen:
        quests.append(_build_daily_quest(week_start, "weekly", metric, target, reward, title, desc, "weekly"))
    
    return quests


def ensure_weekly_quests(user: dict, persist: bool = True) -> list:
    """Ensure user has weekly quests for the current week."""
    if not isinstance(user, dict):
        return []
    
    week_start = get_week_start_str()
    weekly_state = user.get('weekly_quests', {})
    
    if not isinstance(weekly_state, dict):
        weekly_state = {}
    
    if weekly_state.get('week_start') != week_start:
        # Generate new weekly quests
        weekly_quests = generate_weekly_quests_for_user(user, week_start)
        weekly_state = {
            "week_start": week_start,
            "quests": weekly_quests,
        }
        user['weekly_quests'] = weekly_state
        if persist:
            save_user(user)
    
    return weekly_state.get('quests', [])


def _is_valid_daily_quests_state(state: dict) -> bool:
    if not isinstance(state, dict):
        return False
    if not isinstance(state.get('date', ''), str):
        return False
    quests = state.get('quests', [])
    if not isinstance(quests, list) or not quests:
        return False
    for q in quests:
        if not isinstance(q, dict):
            return False
        if not q.get('id') or not q.get('metric'):
            return False
        if 'target' not in q or 'progress' not in q or 'reward_credits' not in q:
            return False
        if 'claimed' not in q:
            return False
    return True


def ensure_daily_quests_today(user: dict, persist: bool = True) -> dict:
    """Ensure the user has a daily quest set for today (UTC), generating if needed."""
    ensure_user_economy(user, persist=False)
    today = utc_today_str()
    state = _normalize_daily_quests_state((user or {}).get('daily_quests'))

    if state.get('date') != today or not _is_valid_daily_quests_state(state):
        state = {"date": today, "quests": generate_daily_quests_for_user(user, today)}
        user['daily_quests'] = state
        if persist:
            save_user(user)

    return state


def apply_daily_quest_progress(user: dict, deltas: dict, persist: bool = True) -> dict:
    """
    Apply per-metric progress deltas to the user's daily quests (today only).
    Deltas example: {\"mp_games\": 1, \"mp_elims\": 2}
    """
    if not isinstance(user, dict):
        return new_daily_quests_state()
    if not isinstance(deltas, dict) or not deltas:
        return ensure_daily_quests_today(user, persist=persist)

    state = ensure_daily_quests_today(user, persist=False)
    quests = state.get('quests', [])
    if not isinstance(quests, list):
        quests = []

    changed = False
    for q in quests:
        if not isinstance(q, dict):
            continue
        metric = q.get('metric')
        if not metric or metric not in deltas:
            continue
        try:
            inc = int(deltas.get(metric, 0) or 0)
        except Exception:
            inc = 0
        if inc <= 0:
            continue
        try:
            progress = int(q.get('progress', 0) or 0)
        except Exception:
            progress = 0
        try:
            target = int(q.get('target', 0) or 0)
        except Exception:
            target = 0
        if target <= 0:
            continue
        new_progress = progress + inc
        if new_progress > target:
            new_progress = target
        if new_progress != progress:
            q['progress'] = int(new_progress)
            changed = True

    if changed:
        user['daily_quests'] = state
        if persist:
            save_user(user)

    return state


def get_visible_cosmetics(user: dict) -> dict:
    """Get only the cosmetics that are visible to other players."""
    cosmetics = get_user_cosmetics(user)
    return {
        "card_border": cosmetics.get("card_border", "classic"),
        "card_background": cosmetics.get("card_background", "default"),
        "name_color": cosmetics.get("name_color", "default"),
        "badge": cosmetics.get("badge", "none"),
        "elimination_effect": cosmetics.get("elimination_effect", "classic"),
        "guess_effect": cosmetics.get("guess_effect", "classic"),
        "turn_indicator": cosmetics.get("turn_indicator", "classic"),
        "victory_effect": cosmetics.get("victory_effect", "classic"),
    }


def validate_cosmetic(category: str, cosmetic_id: str, is_donor: bool, is_admin: bool = False) -> bool:
    """Validate that a cosmetic exists and user can use it."""
    if category not in COSMETICS_CATALOG:
        return False
    category_items = COSMETICS_CATALOG[category]
    if cosmetic_id not in category_items:
        return False
    item = category_items[cosmetic_id]
    # Admins can use all cosmetics, non-donors can only use non-premium cosmetics
    if COSMETICS_PAYWALL_ENABLED and not COSMETICS_UNLOCK_ALL and item.get('premium', False) and not is_donor and not is_admin:
        return False
    return True


COSMETIC_REQUIREMENT_LABELS = {
    "mp_games_played": "multiplayer games",
    "mp_wins": "multiplayer wins",
    "mp_eliminations": "multiplayer eliminations",
    "mp_times_eliminated": "multiplayer times eliminated",
    "peak_mmr": "peak MMR",
}


def get_cosmetic_item(catalog_key: str, cosmetic_id: str) -> Optional[dict]:
    """Get a cosmetic item from the catalog, or None if it doesn't exist."""
    category_items = COSMETICS_CATALOG.get(catalog_key)
    if not isinstance(category_items, dict):
        return None
    item = category_items.get(cosmetic_id)
    return item if isinstance(item, dict) else None


def get_unmet_cosmetic_requirement(item: dict, user_stats: dict) -> Optional[dict]:
    """Return the first unmet requirement dict, or None if all are met."""
    reqs = item.get('requirements')
    if not reqs:
        return None
    if not isinstance(reqs, list):
        return None
    for req in reqs:
        if not isinstance(req, dict):
            continue
        metric = req.get('metric')
        if not metric or not isinstance(metric, str):
            continue
        try:
            min_value = int(req.get('min', 0))
        except Exception:
            continue
        have_value = user_stats.get(metric, 0)
        try:
            have_value = int(have_value)
        except Exception:
            have_value = 0
        if have_value < min_value:
            return {
                "metric": metric,
                "min": min_value,
                "have": have_value,
            }
    return None


# ============== HELPERS ==============

def generate_game_code() -> str:
    chars = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(6))


def generate_player_id() -> str:
    return secrets.token_hex(8)


def is_valid_word(word: str) -> bool:
    word_lower = word.lower().strip()
    if not word_lower.isalpha():
        return False
    if len(word_lower) < 2:
        return False
    freq = word_frequency(word_lower, 'en')
    return freq > 0


def is_word_in_theme(word: str, theme_words: list) -> bool:
    """Check if a word is in the theme's allowed words list."""
    if not theme_words:
        return True  # No theme restriction
    word_lower = word.lower().strip()
    # Normalize theme words for comparison
    normalized_theme = [w.lower().strip() for w in theme_words]
    return word_lower in normalized_theme


def build_word_change_options(player: dict, game: dict) -> list:
    """
    Build a random sample of words offered when a player earns a word change.
    The sample is stored in game state so it remains stable across refresh/polling.
    """
    import random

    pool = player.get('word_pool', []) or (game.get('theme', {}) or {}).get('words', [])

    guessed_words = set()
    for entry in game.get('history', []):
        w = entry.get('word')
        if w:
            guessed_words.add(str(w).lower())

    available = [w for w in pool if str(w).lower() not in guessed_words]

    if not available:
        # Fallback: allow keeping current word if nothing else is available
        current = player.get('secret_word')
        return [current] if current else []

    if len(available) <= WORD_CHANGE_SAMPLE_SIZE:
        return sorted(available)

    return sorted(random.sample(available, WORD_CHANGE_SAMPLE_SIZE))


def get_embedding(word: str) -> list:
    word_lower = word.lower().strip()
    
    # Check Redis cache first
    redis = get_redis()
    cache_key = f"emb:{word_lower}"
    cached = redis.get(cache_key)
    if cached:
        return json.loads(cached)
    
    client = get_openai_client()
    response = client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=word_lower,
    )
    embedding = response.data[0].embedding
    
    # Cache embedding
    redis.setex(cache_key, EMBEDDING_CACHE_SECONDS, json.dumps(embedding))
    return embedding


def cosine_similarity(embedding1, embedding2) -> float:
    vec1 = np.array(embedding1)
    vec2 = np.array(embedding2)
    dot_product = np.dot(vec1, vec2)
    norm1 = np.linalg.norm(vec1)
    norm2 = np.linalg.norm(vec2)
    if norm1 == 0 or norm2 == 0:
        return 0.0
    return float(dot_product / (norm1 * norm2))


# ============== GAME STORAGE ==============

def save_game(code: str, game_data: dict):
    redis = get_redis()
    redis.setex(f"game:{code}", GAME_EXPIRY_SECONDS, json.dumps(game_data))


def load_game(code: str) -> Optional[dict]:
    redis = get_redis()
    data = redis.get(f"game:{code}")
    if data:
        return json.loads(data)
    return None


def delete_game(code: str):
    redis = get_redis()
    redis.delete(f"game:{code}")


# ============== PRESENCE (SPECTATORS) ==============

def _presence_key(code: str, kind: str) -> str:
    return f"presence:{code}:{kind}"


def touch_presence(code: str, kind: str, member: str):
    """Record a presence heartbeat for a member (player_id or spectator_id)."""
    try:
        if not code or not member:
            return
        now = float(time.time())
        cutoff = now - float(PRESENCE_TTL_SECONDS)
        redis = get_redis()
        key = _presence_key(code, kind)
        redis.zadd(key, {member: now})
        # Best-effort prune of old entries
        redis.zremrangebyscore(key, 0, cutoff)
    except Exception:
        # Presence is best-effort; never fail the request
        return


def get_spectator_count(code: str) -> int:
    """Return the number of active spectators for a game (best-effort)."""
    try:
        now = float(time.time())
        cutoff = now - float(PRESENCE_TTL_SECONDS)
        redis = get_redis()
        # Prune both sets so they don't grow unbounded
        redis.zremrangebyscore(_presence_key(code, "players"), 0, cutoff)
        redis.zremrangebyscore(_presence_key(code, "spectators"), 0, cutoff)
        val = redis.zcard(_presence_key(code, "spectators"))
        try:
            return int(val or 0)
        except Exception:
            return 0
    except Exception:
        return 0


# ============== PLAYER STATS ==============

def get_player_stats(name: str) -> dict:
    """Get stats for a player by name."""
    redis = get_redis()
    key = f"stats:{name.lower()}"
    data = redis.get(key)
    if data:
        stats = json.loads(data)
        # Ensure all new fields exist for backwards compatibility
        stats.setdefault('eliminations', 0)
        stats.setdefault('times_eliminated', 0)
        stats.setdefault('win_streak', 0)
        stats.setdefault('best_streak', 0)
        return stats
    return {
        "name": name,
        "wins": 0,
        "games_played": 0,
        "total_guesses": 0,
        "total_similarity": 0.0,
        "eliminations": 0,
        "times_eliminated": 0,
        "win_streak": 0,
        "best_streak": 0,
    }


def save_player_stats(name: str, stats: dict):
    """Save player stats."""
    redis = get_redis()
    key = f"stats:{name.lower()}"
    # Stats never expire
    redis.set(key, json.dumps(stats))
    # Also add to leaderboard set
    redis.sadd("leaderboard:players", name.lower())
    
    # Update weekly leaderboard (sorted sets)
    week_key = get_weekly_leaderboard_key()
    redis.zadd(f"leaderboard:weekly:{week_key}", {name.lower(): stats.get('wins', 0)})


def get_weekly_leaderboard_key() -> str:
    """Get the key for the current week's leaderboard."""
    import datetime
    today = datetime.date.today()
    # Get the Monday of the current week
    monday = today - datetime.timedelta(days=today.weekday())
    return monday.strftime('%Y-%m-%d')


def _ranked_elimination_index(game: dict) -> dict:
    """
    Build a mapping of player_id -> history index where they were eliminated/forfeited.
    Players not present in the map are considered to have survived to the end.
    """
    elim_at = {}
    history = game.get('history', []) or []
    for idx, entry in enumerate(history):
        etype = entry.get('type')
        if etype == 'word_change':
            continue
        if etype == 'forfeit':
            pid = entry.get('player_id')
            if pid and pid not in elim_at:
                elim_at[pid] = idx
            continue
        eliminations = entry.get('eliminations') or []
        if isinstance(eliminations, list) and eliminations:
            for pid in eliminations:
                if pid and pid not in elim_at:
                    elim_at[pid] = idx
    return elim_at


def apply_ranked_mmr_updates(game: dict):
    """
    Apply multi-player Elo/MMR updates for ranked games (Google-auth only).

    Uses pairwise outcomes derived from elimination order in game.history.
    Idempotent best-effort: guarded by game['ranked_processed'] and a Redis setnx key.
    """
    if not isinstance(game, dict):
        return
    if not bool(game.get('is_ranked', False)):
        return

    code = game.get('code') or ''
    redis = get_redis()
    result_key = f"ranked:{code}:mmr_result"

    def _attach_saved_result():
        """Best-effort: attach previously computed ranked MMR results to the game dict."""
        try:
            raw = redis.get(result_key)
            if not raw:
                return
            if isinstance(raw, bytes):
                raw = raw.decode()
            data = json.loads(raw)
            if isinstance(data, dict):
                game['ranked_mmr'] = data
        except Exception:
            return

    # If already processed, still try to attach saved results (for robustness against concurrent saves)
    if game.get('ranked_processed'):
        if not game.get('ranked_mmr'):
            _attach_saved_result()
        return

    # Best-effort Redis guard to avoid double-processing across concurrent finish events
    try:
        guard_key = f"ranked:{code}:mmr_processed"
        if hasattr(redis, 'setnx'):
            ok = redis.setnx(guard_key, "1")
            if not ok:
                # Already processed elsewhere; attach saved results so we don't overwrite them on save.
                _attach_saved_result()
                game['ranked_processed'] = True
                return
            try:
                redis.expire(guard_key, GAME_EXPIRY_SECONDS)
            except Exception:
                pass
    except Exception:
        # If guard fails, fall back to in-game flag only
        pass

    # Prefer a frozen participant snapshot (set at match start) so forfeits/leaves don't
    # shrink the rating pool mid-match.
    snapshot = game.get('ranked_participants')
    players = snapshot if isinstance(snapshot, list) and snapshot else (game.get('players', []) or [])
    winner_pid = game.get('winner')

    # Ranked participants: authenticated humans only (skip admin_local and AIs)
    participants = []
    for p in players:
        if not isinstance(p, dict):
            continue
        if p.get('is_ai'):
            continue
        uid = p.get('auth_user_id')
        if not uid or uid == 'admin_local':
            continue
        participants.append(p)

    if len(participants) < 2:
        game['ranked_processed'] = True
        return

    elim_at = _ranked_elimination_index(game)
    history_len = len(game.get('history', []) or [])

    # Ranking value: later elimination is better; winner gets a large value
    rank_value = {}
    for p in participants:
        pid = p.get('id')
        if pid == winner_pid:
            rank_value[pid] = history_len + 10_000
        else:
            rank_value[pid] = elim_at.get(pid, history_len + 9_000)

    # Load users and current ratings
    user_map = {}
    rating = {}
    for p in participants:
        uid = p.get('auth_user_id')
        user = get_user_by_id(uid)
        if not user:
            continue
        stats = get_user_stats(user)
        try:
            mmr = int(stats.get('mmr', RANKED_INITIAL_MMR) or RANKED_INITIAL_MMR)
        except Exception:
            mmr = RANKED_INITIAL_MMR
        user_map[uid] = user
        rating[uid] = float(mmr)

    # If we couldn't load at least 2 users, skip
    if len(rating) < 2:
        game['ranked_processed'] = True
        return

    # Map uid -> pid for rank comparisons
    uid_to_pid = {p.get('auth_user_id'): p.get('id') for p in participants if p.get('auth_user_id') in rating}
    uids = list(uid_to_pid.keys())
    n = len(uids)
    if n < 2:
        game['ranked_processed'] = True
        return

    deltas = {uid: 0.0 for uid in uids}

    def expected(ra: float, rb: float) -> float:
        return 1.0 / (1.0 + (10.0 ** ((rb - ra) / 400.0)))

    # Pairwise accumulation
    for i in range(n):
        for j in range(i + 1, n):
            ui = uids[i]
            uj = uids[j]
            pi = uid_to_pid[ui]
            pj = uid_to_pid[uj]
            ri = rating[ui]
            rj = rating[uj]

            ei = expected(ri, rj)
            ej = 1.0 - ei

            vi = rank_value.get(pi, 0)
            vj = rank_value.get(pj, 0)
            if vi > vj:
                si, sj = 1.0, 0.0
            elif vi < vj:
                si, sj = 0.0, 1.0
            else:
                si, sj = 0.5, 0.5

            deltas[ui] += (si - ei)
            deltas[uj] += (sj - ej)

    scale = float(RANKED_K_FACTOR) / float(max(1, n - 1))

    # Apply updates + persist
    # Also record per-game deltas so the frontend can show MMR change on the game-over screen.
    mmr_result_by_pid = {}
    for uid in uids:
        user = user_map.get(uid)
        if not user:
            continue
        old = rating[uid]
        new = old + (scale * deltas.get(uid, 0.0))
        try:
            new_int = int(round(new))
        except Exception:
            new_int = int(old)
        if new_int < 0:
            new_int = 0

        try:
            old_int = int(round(old))
        except Exception:
            old_int = int(new_int)
        delta_int = int(new_int - old_int)

        u_stats = get_user_stats(user)
        u_stats['mmr'] = new_int
        try:
            prev_peak = int(u_stats.get('peak_mmr', new_int) or new_int)
        except Exception:
            prev_peak = new_int
        u_stats['peak_mmr'] = max(prev_peak, new_int)

        u_stats['ranked_games'] = int(u_stats.get('ranked_games', 0) or 0) + 1

        pid = uid_to_pid.get(uid)
        if pid and pid == winner_pid:
            u_stats['ranked_wins'] = int(u_stats.get('ranked_wins', 0) or 0) + 1
        else:
            u_stats['ranked_losses'] = int(u_stats.get('ranked_losses', 0) or 0) + 1

        user['stats'] = u_stats
        save_user(user)

        # Update ranked leaderboard zset
        try:
            redis.zadd("leaderboard:mmr", {uid: new_int})
        except Exception:
            pass

        pid = uid_to_pid.get(uid)
        if pid:
            mmr_result_by_pid[str(pid)] = {
                "uid": str(uid),
                "old": int(old_int),
                "new": int(new_int),
                "delta": int(delta_int),
            }

    game['ranked_processed'] = True
    if mmr_result_by_pid:
        game['ranked_mmr'] = mmr_result_by_pid
        # Persist results in Redis so concurrent finish requests can attach them reliably.
        try:
            redis.setex(result_key, GAME_EXPIRY_SECONDS, json.dumps(mmr_result_by_pid))
        except Exception:
            try:
                redis.set(result_key, json.dumps(mmr_result_by_pid))
            except Exception:
                pass


def update_game_stats(game: dict):
    """Update stats for all players after a game ends."""
    winner_id = game.get('winner')
    is_multiplayer = not bool(game.get('is_singleplayer'))
    is_ranked = bool(game.get('is_ranked', False)) and is_multiplayer
    
    # Count eliminations per player
    eliminations_by_player = {}
    eliminated_players = set()
    
    for entry in game.get('history', []):
        if entry.get('type') == 'word_change':
            continue
        if entry.get('type') == 'forfeit':
            pid = entry.get('player_id')
            if pid:
                eliminated_players.add(pid)
            continue
        guesser_id = entry.get('guesser_id')
        if guesser_id and entry.get('eliminations'):
            eliminations_by_player[guesser_id] = eliminations_by_player.get(guesser_id, 0) + len(entry['eliminations'])
            eliminated_players.update(entry['eliminations'])
    
    for player in game['players']:
        stats = get_player_stats(player['name'])
        stats['games_played'] += 1
        
        # Track eliminations
        stats['eliminations'] = stats.get('eliminations', 0) + eliminations_by_player.get(player['id'], 0)
        
        # Track times eliminated
        if player['id'] in eliminated_players:
            stats['times_eliminated'] = stats.get('times_eliminated', 0) + 1
        
        if player['id'] == winner_id:
            stats['wins'] += 1
            # Update win streak
            stats['win_streak'] = stats.get('win_streak', 0) + 1
            if stats['win_streak'] > stats.get('best_streak', 0):
                stats['best_streak'] = stats['win_streak']
        else:
            # Reset win streak on loss
            stats['win_streak'] = 0
        
        # Calculate average closeness from this player's guesses
        for entry in game.get('history', []):
            # Skip word_change entries which don't have guesser_id
            if entry.get('type') == 'word_change':
                continue
            if entry.get('guesser_id') == player['id']:
                stats['total_guesses'] += 1
                # Get the max similarity to other players (not self)
                similarities = entry.get('similarities', {})
                other_sims = [
                    sim for pid, sim in similarities.items() 
                    if pid != player['id']
                ]
                if other_sims:
                    stats['total_similarity'] += max(other_sims)
        
        save_player_stats(player['name'], stats)

        # Multiplayer-only: also update authenticated user's mp_* stats for cosmetics unlocks.
        if is_multiplayer:
            auth_user_id = player.get('auth_user_id')
            if auth_user_id and auth_user_id != 'admin_local':
                auth_user = get_user_by_id(auth_user_id)
                if auth_user:
                    u_stats = get_user_stats(auth_user)
                    u_stats['mp_games_played'] = u_stats.get('mp_games_played', 0) + 1
                    elim_count = eliminations_by_player.get(player['id'], 0) or 0
                    u_stats['mp_eliminations'] = u_stats.get('mp_eliminations', 0) + elim_count
                    if player['id'] == winner_id:
                        u_stats['mp_wins'] = u_stats.get('mp_wins', 0) + 1
                    if player['id'] in eliminated_players:
                        u_stats['mp_times_eliminated'] = u_stats.get('mp_times_eliminated', 0) + 1
                    auth_user['stats'] = u_stats

                    # Daily quests progress (credits awarded on claim).
                    deltas = {
                        "mp_games": 1,
                        "mp_elims": int(elim_count or 0),
                    }
                    if player['id'] == winner_id:
                        deltas["mp_wins"] = 1
                    if is_ranked:
                        deltas["ranked_games"] = 1
                        if player['id'] == winner_id:
                            deltas["ranked_wins"] = 1
                    apply_daily_quest_progress(auth_user, deltas, persist=False)

                    save_user(auth_user)

    # Ranked: update MMR once per finished game (best-effort + idempotent flag)
    if is_ranked:
        try:
            apply_ranked_mmr_updates(game)
        except Exception as e:
            print(f"Ranked MMR update error: {e}")


def get_leaderboard(leaderboard_type: str = 'alltime') -> list:
    """Get all players sorted by wins.
    
    Args:
        leaderboard_type: 'alltime' or 'weekly'
    """
    redis = get_redis()
    
    if leaderboard_type == 'weekly':
        # Get weekly leaderboard from sorted set
        week_key = get_weekly_leaderboard_key()
        weekly_data = redis.zrevrange(f"leaderboard:weekly:{week_key}", 0, 99, withscores=True)
        
        if not weekly_data:
            return []
        
        players = []
        for name, wins in weekly_data:
            stats = get_player_stats(name)
            if stats['games_played'] > 0:
                stats['weekly_wins'] = int(wins)
                stats['avg_closeness'] = (
                    stats['total_similarity'] / stats['total_guesses'] 
                    if stats['total_guesses'] > 0 else 0
                )
                stats['win_rate'] = stats['wins'] / stats['games_played'] if stats['games_played'] > 0 else 0
                players.append(stats)
        return players
    
    # All-time leaderboard
    player_names = redis.smembers("leaderboard:players")
    
    if not player_names:
        return []
    
    players = []
    for name in player_names:
        stats = get_player_stats(name)
        if stats['games_played'] > 0:
            stats['avg_closeness'] = (
                stats['total_similarity'] / stats['total_guesses'] 
                if stats['total_guesses'] > 0 else 0
            )
            stats['win_rate'] = stats['wins'] / stats['games_played'] if stats['games_played'] > 0 else 0
            players.append(stats)
    
    # Sort by wins (desc), then win rate (desc), then games played (desc)
    players.sort(key=lambda p: (
        p['wins'], 
        p['win_rate'],
        p['games_played']
    ), reverse=True)
    
    return players[:100]  # Limit to top 100


# ============== HANDLER ==============

# Allowed origins for CORS
ALLOWED_ORIGINS = [
    'https://embeddle.vercel.app',
    'https://www.embeddle.com',
]

# Allow localhost in development
DEV_MODE = os.getenv('VERCEL_ENV', 'development') == 'development'
# When enabled, include extra debug context in some error responses.
DEBUG_ERRORS = env_bool("DEBUG_ERRORS", (CONFIG.get("debug", {}) or {}).get("errors", False))
DEBUG_ERROR_TTL_SECONDS = int(os.getenv("DEBUG_ERROR_TTL_SECONDS", "3600"))


class handler(BaseHTTPRequestHandler):
    def _get_auth_payload(self) -> Optional[dict]:
        """Return decoded JWT payload for the request, or None if not authenticated."""
        auth_header = self.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return None
        token = auth_header[7:]
        return verify_jwt_token(token)

    def _get_auth_user_id(self) -> Optional[str]:
        """Convenience wrapper to get the authenticated user id (JWT sub)."""
        payload = self._get_auth_payload()
        if payload and isinstance(payload, dict):
            return payload.get('sub')
        return None

    def _is_admin_request(self) -> bool:
        """Best-effort check if the request is from an admin user."""
        try:
            payload = self._get_auth_payload()
            if not payload or not isinstance(payload, dict):
                return False
            sub = str(payload.get('sub') or '')
            if sub == 'admin_local':
                return True
            email = str(payload.get('email') or '').strip().lower()
            if not email:
                return False
            admin_emails = [str(e).strip().lower() for e in (ADMIN_EMAILS or [])]
            return email in admin_emails
        except Exception:
            return False

    def _debug_allowed(self) -> bool:
        """Return True if we can safely return debug details to this client."""
        return bool(DEBUG_ERRORS or self._is_admin_request())

    def _get_cors_origin(self):
        """Get the appropriate CORS origin header value."""
        origin = self.headers.get('Origin', '')
        if origin in ALLOWED_ORIGINS:
            return origin
        # Allow localhost in development
        if DEV_MODE and origin.startswith('http://localhost:'):
            return origin
        # Default to first allowed origin (or empty for security)
        return ALLOWED_ORIGINS[0] if ALLOWED_ORIGINS else ''

    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        # CORS headers - restricted to allowed origins
        cors_origin = self._get_cors_origin()
        if cors_origin:
            self.send_header('Access-Control-Allow-Origin', cors_origin)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Allow-Credentials', 'true')
        # Security headers
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('X-XSS-Protection', '1; mode=block')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _send_error(self, message, status=400):
        self._send_json({"detail": message}, status)

    def _get_body(self):
        """
        Best-effort JSON body parser.

        IMPORTANT: Always returns a dict to avoid attribute errors (many handlers do body.get(...)).
        If parsing fails (invalid JSON / unexpected content-type), returns {} instead of crashing.
        """
        try:
            content_length = int(self.headers.get('Content-Length', 0))
        except Exception:
            content_length = 0
        if not content_length:
            return {}

        try:
            raw = self.rfile.read(content_length)
        except Exception:
            return {}
        if not raw:
            return {}

        content_type = (self.headers.get('Content-Type', '') or '').lower()

        # Support form-encoded bodies as a fallback (prevents serverless crashes on accidental form submits)
        if 'application/x-www-form-urlencoded' in content_type:
            try:
                parsed = urllib.parse.parse_qs(raw.decode('utf-8', errors='ignore'))
                return {k: (v[0] if isinstance(v, list) and len(v) == 1 else v) for k, v in parsed.items()}
            except Exception:
                return {}

        # Default: JSON
        try:
            data = json.loads(raw)
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

    def do_OPTIONS(self):
        self.send_response(200)
        cors_origin = self._get_cors_origin()
        if cors_origin:
            self.send_header('Access-Control-Allow-Origin', cors_origin)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        # Allow Authorization so authenticated requests work cross-origin if needed.
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Allow-Credentials', 'true')
        self.send_header('Access-Control-Max-Age', '86400')
        self.end_headers()

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        query = {}
        if '?' in self.path:
            query_string = self.path.split('?', 1)[1]
            # Properly URL-decode query params (important for OAuth `code` param)
            query = dict(urllib.parse.parse_qsl(query_string, keep_blank_values=True))

        # Get client IP for rate limiting
        client_ip = get_client_ip(self.headers)

        # ============== CLIENT CONFIG ==============
        # GET /api/client-config - Lightweight config the frontend can use (audio, etc.)
        if path == '/api/client-config':
            bgm_cfg = (CONFIG.get('audio', {}) or {}).get('background_music', {}) or {}
            sfx_cfg = (CONFIG.get('audio', {}) or {}).get('sfx', {}) or {}
            enabled = bool(bgm_cfg.get('enabled', True))
            track = str(bgm_cfg.get('track', '/manwithaplan.mp3') or '/manwithaplan.mp3')
            volume_raw = bgm_cfg.get('volume', 0.12)
            try:
                volume = float(volume_raw)
            except Exception:
                volume = 0.12
            volume = max(0.0, min(1.0, volume))
            return self._send_json({
                "audio": {
                    "background_music": {
                        "enabled": enabled,
                        "track": track,
                        "volume": volume,
                    },
                    # Placeholder for future asset-based SFX (frontend currently uses WebAudio tones).
                    "sfx": sfx_cfg,
                }
            })

        # ============== DEBUG (ADMIN ONLY) ==============
        # GET /api/debug/chat-error?id=cd8a9e33
        if path == '/api/debug/chat-error':
            if not self._debug_allowed():
                return self._send_error("Not authorized", 403)
            error_id = str(query.get('id', '') or query.get('error_id', '') or '').strip().lower()
            if not re.match(r'^[a-f0-9]{8}$', error_id):
                return self._send_error("Invalid error id", 400)
            try:
                redis = get_redis()
                raw = redis.get(f"debug:chat_error:{error_id}")
            except Exception:
                raw = None
            if not raw:
                return self._send_error("Not found", 404)
            if isinstance(raw, bytes):
                try:
                    raw = raw.decode()
                except Exception:
                    raw = str(raw)
            try:
                data = json.loads(raw)
            except Exception:
                data = {"raw": str(raw)}
            return self._send_json({
                "error_id": error_id,
                "debug": data,
            })

        # ============== AUTH ENDPOINTS ==============

        # GET /api/auth/google - Redirect to Google OAuth
        if path == '/api/auth/google':
            if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
                return self._send_error("OAuth not configured", 500)
            
            # Compute redirect URI for THIS request origin and persist it in a short-lived state
            request_base = get_request_base_url(self.headers)
            redirect_uri = os.getenv('OAUTH_REDIRECT_URI') or f"{request_base}/api/auth/callback"

            state = None
            try:
                state = secrets.token_urlsafe(24)
                get_redis().setex(
                    f"oauth_state:{state}",
                    OAUTH_STATE_TTL_SECONDS,
                    json.dumps({
                        "redirect_uri": redirect_uri,
                        "return_to": request_base,
                        "created_at": int(time.time()),
                    }),
                )
            except Exception as e:
                print(f"OAuth state store failed: {e}")
                state = None

            params = {
                'client_id': GOOGLE_CLIENT_ID,
                'redirect_uri': redirect_uri,
                'response_type': 'code',
                'scope': 'openid email profile',
                'access_type': 'offline',
                'prompt': 'consent',
            }
            if state:
                params['state'] = state
            auth_url = f"{GOOGLE_AUTH_URL}?{urllib.parse.urlencode(params)}"
            
            self.send_response(302)
            self.send_header('Location', auth_url)
            self.end_headers()
            return

        # GET /api/auth/callback - Handle OAuth callback
        if path == '/api/auth/callback':
            code = query.get('code', '')
            error = query.get('error', '')
            state = query.get('state', '')

            # Recover redirect_uri used in the auth request to avoid redirect-uri mismatch.
            # Also recover the frontend base URL to redirect back to.
            redirect_uri = get_oauth_redirect_uri()
            return_to = ''
            if state:
                try:
                    redis = get_redis()
                    raw = redis.get(f"oauth_state:{state}")
                    if raw:
                        data = json.loads(raw)
                        redirect_uri = data.get('redirect_uri') or redirect_uri
                        return_to = data.get('return_to') or ''
                        redis.delete(f"oauth_state:{state}")
                except Exception as e:
                    print(f"OAuth state load failed: {e}")

            def _redirect_frontend(params: dict):
                qs = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None and v != ''})
                if return_to:
                    target = return_to.rstrip('/') + '/?' + qs
                else:
                    target = '/?' + qs
                self.send_response(302)
                self.send_header('Location', target)
                self.end_headers()
            
            if error:
                return _redirect_frontend({
                    'auth_error': error,
                    'auth_error_description': query.get('error_description', ''),
                })
            
            if not code:
                return self._send_error("No authorization code provided", 400)
            
            try:
                if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
                    return _redirect_frontend({'auth_error': 'oauth_not_configured'})

                # Exchange code for tokens
                token_response = requests.post(GOOGLE_TOKEN_URL, data={
                    'client_id': GOOGLE_CLIENT_ID,
                    'client_secret': GOOGLE_CLIENT_SECRET,
                    'code': code,
                    'grant_type': 'authorization_code',
                    'redirect_uri': redirect_uri,
                }, timeout=10)
                
                if not token_response.ok:
                    print(f"Token exchange failed: {token_response.status_code} - {token_response.text}")
                    print(f"Redirect URI used: {redirect_uri}")
                    google_error = ''
                    google_error_description = ''
                    try:
                        err = token_response.json()
                        google_error = err.get('error', '')
                        google_error_description = err.get('error_description', '')
                    except Exception:
                        pass
                    return _redirect_frontend({
                        'auth_error': 'token_exchange_failed',
                        'auth_error_status': str(token_response.status_code),
                        'google_error': google_error,
                        'google_error_description': google_error_description,
                    })
                
                tokens = token_response.json()
                access_token = tokens.get('access_token')
                
                # Get user info from Google
                userinfo_response = requests.get(
                    GOOGLE_USERINFO_URL,
                    headers={'Authorization': f'Bearer {access_token}'}
                    , timeout=10
                )
                
                if not userinfo_response.ok:
                    print(f"User info failed: {userinfo_response.text}")
                    return _redirect_frontend({
                        'auth_error': 'userinfo_failed',
                        'auth_error_status': str(userinfo_response.status_code),
                    })
                
                google_user = userinfo_response.json()
                
                # Create or get user
                user = get_or_create_user(google_user)
                
                # Create JWT token
                jwt_token = create_jwt_token(user)
                
                # Redirect to frontend with token
                return _redirect_frontend({'auth_token': jwt_token})
                
            except Exception as e:
                print(f"OAuth callback error: {e}")
                return _redirect_frontend({'auth_error': 'callback_failed'})

        # GET /api/auth/me - Get current user info
        if path == '/api/auth/me':
            auth_header = self.headers.get('Authorization', '')
            if not auth_header.startswith('Bearer '):
                return self._send_error("Not authenticated", 401)
            
            token = auth_header[7:]  # Remove 'Bearer ' prefix
            payload = verify_jwt_token(token)
            
            if not payload:
                return self._send_error("Invalid or expired token", 401)
            
            # Handle admin user specially (not stored in Redis)
            if payload['sub'] == 'admin_local':
                return self._send_json({
                    'id': 'admin_local',
                    'name': 'Admin',
                    'email': 'admin@embeddle.io',
                    'avatar': '',
                    'stats': DEFAULT_USER_STATS.copy(),
                    'is_donor': True,
                    'is_admin': True,
                    'cosmetics': DEFAULT_COSMETICS.copy(),
                })
            
            user = get_user_by_id(payload['sub'])
            if not user:
                return self._send_error("User not found", 404)
            
            return self._send_json({
                'id': user['id'],
                'name': user['name'],
                'email': user.get('email', ''),
                'avatar': user.get('avatar', ''),
                'stats': get_user_stats(user),
                'is_donor': user.get('is_donor', False),
                'is_admin': user.get('is_admin', False),
                'cosmetics': get_user_cosmetics(user),
            })

        # GET /api/cosmetics - Get cosmetics catalog
        if path == '/api/cosmetics':
            return self._send_json({
                "catalog": COSMETICS_CATALOG,
                "paywall_enabled": COSMETICS_PAYWALL_ENABLED,
                "unlock_all": COSMETICS_UNLOCK_ALL,
            })

        # GET /api/user/cosmetics - Get current user's cosmetics
        if path == '/api/user/cosmetics':
            auth_header = self.headers.get('Authorization', '')
            if not auth_header.startswith('Bearer '):
                return self._send_error("Not authenticated", 401)
            
            token = auth_header[7:]
            payload = verify_jwt_token(token)
            
            if not payload:
                return self._send_error("Invalid or expired token", 401)
            
            # Handle admin user specially (not stored in Redis)
            if payload['sub'] == 'admin_local':
                # Get admin cosmetics from Redis if they exist
                redis = get_redis()
                existing = redis.get('admin_cosmetics')
                admin_cosmetics = json.loads(existing) if existing else DEFAULT_COSMETICS.copy()
                admin_user = load_admin_economy_user(redis)
                econ = ensure_user_economy(admin_user, persist=False)
                
                return self._send_json({
                    'is_donor': True,
                    'is_admin': True,
                    'cosmetics': admin_cosmetics,
                    'owned_cosmetics': econ.get('owned_cosmetics') or {},
                    'paywall_enabled': COSMETICS_PAYWALL_ENABLED,
                    'unlock_all': COSMETICS_UNLOCK_ALL,
                })
            
            user = get_user_by_id(payload['sub'])
            if not user:
                return self._send_error("User not found", 404)
            
            econ = ensure_user_economy(user, persist=False)
            
            return self._send_json({
                'is_donor': user.get('is_donor', False),
                'is_admin': user.get('is_admin', False),
                'cosmetics': get_user_cosmetics(user),
                'owned_cosmetics': econ.get('owned_cosmetics') or {},
                'paywall_enabled': COSMETICS_PAYWALL_ENABLED,
                'unlock_all': COSMETICS_UNLOCK_ALL,
            })

        # GET /api/user/daily - Get daily quests + weekly quests + currency + owned cosmetics + streak
        if path == '/api/user/daily':
            auth_header = self.headers.get('Authorization', '')
            if not auth_header.startswith('Bearer '):
                return self._send_error("Not authenticated", 401)

            token = auth_header[7:]
            payload = verify_jwt_token(token)

            if not payload:
                return self._send_error("Invalid or expired token", 401)

            # Handle admin user specially (not stored in Redis as user:{id})
            if payload.get('sub') == 'admin_local':
                redis = get_redis()
                admin_user = load_admin_economy_user(redis)
                daily_state = ensure_daily_quests_today(admin_user, persist=False)
                admin_user['daily_quests'] = daily_state
                weekly_quests = ensure_weekly_quests(admin_user, persist=False)
                # Check/update streak for admin
                streak_result = check_and_update_streak(admin_user, persist=False)
                save_admin_economy_user(redis, admin_user)
                econ = ensure_user_economy(admin_user, persist=False)
                streak_info = get_next_streak_info(streak_result['streak'].get('streak_count', 0))
                return self._send_json({
                    "date": daily_state.get("date", ""),
                    "quests": daily_state.get("quests", []),
                    "weekly_quests": weekly_quests,
                    "wallet": econ.get("wallet") or {"credits": 0},
                    "owned_cosmetics": econ.get("owned_cosmetics") or {},
                    "streak": streak_result['streak'],
                    "streak_credits_earned": streak_result['credits_earned'],
                    "streak_milestone_bonus": streak_result['milestone_bonus'],
                    "streak_broken": streak_result['streak_broken'],
                    "streak_info": streak_info,
                })

            user = get_user_by_id(payload.get('sub', ''))
            if not user:
                return self._send_error("User not found", 404)

            econ = ensure_user_economy(user, persist=True)
            daily_state = ensure_daily_quests_today(user, persist=True)
            weekly_quests = ensure_weekly_quests(user, persist=True)
            # Check/update streak
            streak_result = check_and_update_streak(user, persist=True)
            streak_info = get_next_streak_info(streak_result['streak'].get('streak_count', 0))

            return self._send_json({
                "date": daily_state.get("date", ""),
                "quests": daily_state.get("quests", []),
                "weekly_quests": weekly_quests,
                "wallet": user.get('wallet') or {"credits": 0},  # Use updated wallet with streak credits
                "owned_cosmetics": econ.get("owned_cosmetics") or {},
                "streak": streak_result['streak'],
                "streak_credits_earned": streak_result['credits_earned'],
                "streak_milestone_bonus": streak_result['milestone_bonus'],
                "streak_broken": streak_result['streak_broken'],
                "streak_info": streak_info,
            })

        # GET /api/lobbies - List open lobbies
        if path == '/api/lobbies':
            # Rate limit: 30/min for lobby listing
            if not check_rate_limit(get_ratelimit_general(), f"lobbies:{client_ip}"):
                return self._send_error("Too many requests. Please wait.", 429)
            try:
                redis = get_redis()
                keys = redis.keys("game:*")
                lobbies = []
                current_time = time.time()

                # Optional filter: ?mode=ranked|unranked
                mode = (query.get('mode', '') or '').strip().lower()
                want_ranked = None
                if mode == 'ranked':
                    want_ranked = True
                elif mode == 'unranked':
                    want_ranked = False
                
                for key in keys:
                    game_data = redis.get(key)
                    if game_data:
                        game = json.loads(game_data)
                        # Never list singleplayer lobbies
                        if game.get('is_singleplayer'):
                            continue

                        visibility = game.get('visibility', 'public')
                        is_ranked = bool(game.get('is_ranked', False))

                        # Public listing only
                        if visibility != 'public':
                            continue

                        # Optional ranked/unranked filter
                        if want_ranked is not None and is_ranked != want_ranked:
                            continue

                        # Only show waiting lobbies that aren't full and not expired
                        if game.get('status') == 'waiting' and len(game.get('players', [])) < MAX_PLAYERS:
                            # Check if lobby has expired
                            created_at = game.get('created_at', current_time)
                            if current_time - created_at > LOBBY_EXPIRY_SECONDS:
                                # Delete expired lobby
                                redis.delete(key)
                                continue
                            
                            # Get winning theme from votes
                            votes = game.get('theme_votes', {})
                            winning_theme = max(votes.keys(), key=lambda k: len(votes[k])) if votes else None
                            lobbies.append({
                                "code": game['code'],
                                "player_count": len(game.get('players', [])),
                                "max_players": MAX_PLAYERS,
                                "theme_options": game.get('theme_options', []),
                                "winning_theme": winning_theme,
                                "visibility": visibility,
                                "is_ranked": is_ranked,
                            })
                return self._send_json({"lobbies": lobbies})
            except Exception as e:
                print(f"Error loading lobbies: {e}")  # Log server-side only
                return self._send_error("Failed to load lobbies. Please try again.", 500)

        # GET /api/spectateable - List public, non-finished multiplayer games that can be spectated
        if path == '/api/spectateable':
            # Rate limit: 30/min for listing
            if not check_rate_limit(get_ratelimit_general(), f"spectateable:{client_ip}"):
                return self._send_error("Too many requests. Please wait.", 429)
            try:
                redis = get_redis()
                keys = redis.keys("game:*")
                games = []
                now = float(time.time())

                for key in keys:
                    game_data = redis.get(key)
                    if not game_data:
                        continue
                    game = json.loads(game_data)

                    # Only list public multiplayer games (never leak private codes or solo games)
                    if game.get('visibility', 'public') != 'public':
                        continue
                    if game.get('is_singleplayer'):
                        continue

                    status = game.get('status', '')
                    if status == 'finished':
                        continue

                    # Apply lobby expiry to waiting games, same as /api/lobbies
                    if status == 'waiting':
                        created_at = float(game.get('created_at', now) or now)
                        if now - created_at > float(LOBBY_EXPIRY_SECONDS):
                            try:
                                delete_game(game.get('code', ''))
                            except Exception:
                                pass
                            continue

                    code = game.get('code', '')
                    if not code:
                        continue

                    games.append({
                        "code": code,
                        "status": status,
                        "player_count": len(game.get('players', []) or []),
                        "max_players": MAX_PLAYERS,
                        "is_ranked": bool(game.get('is_ranked', False)),
                        "spectator_count": get_spectator_count(code),
                    })

                # Sort: playing first, then word_selection, then waiting; then by player count desc
                order = {"playing": 0, "word_selection": 1, "waiting": 2}
                games.sort(key=lambda g: (order.get(g.get("status", ""), 9), -(g.get("player_count", 0) or 0), g.get("code", "")))

                return self._send_json({"games": games[:100]})
            except Exception as e:
                print(f"Error loading spectateable games: {e}")
                return self._send_error("Failed to load games. Please try again.", 500)

        # GET /api/leaderboard
        if path == '/api/leaderboard':
            # Rate limit: 30/min for leaderboard
            if not check_rate_limit(get_ratelimit_general(), f"leaderboard:{client_ip}"):
                return self._send_error("Too many requests. Please wait.", 429)
            
            # Support ?type=weekly or ?type=alltime (default)
            leaderboard_type = query.get('type', 'alltime')
            if leaderboard_type not in ('alltime', 'weekly'):
                leaderboard_type = 'alltime'
            
            players = get_leaderboard(leaderboard_type)
            return self._send_json({
                "players": players,
                "type": leaderboard_type,
                "week": get_weekly_leaderboard_key() if leaderboard_type == 'weekly' else None,
            })

        # GET /api/leaderboard/ranked - Ranked MMR leaderboard (Google users)
        if path == '/api/leaderboard/ranked':
            # Rate limit: 30/min for leaderboard
            if not check_rate_limit(get_ratelimit_general(), f"leaderboard_ranked:{client_ip}"):
                return self._send_error("Too many requests. Please wait.", 429)

            redis = get_redis()
            try:
                data = redis.zrevrange("leaderboard:mmr", 0, 99, withscores=True) or []
            except Exception:
                data = []

            players = []
            rank = 1
            for uid, score in data:
                if isinstance(uid, bytes):
                    try:
                        uid = uid.decode()
                    except Exception:
                        continue
                try:
                    mmr = int(score)
                except Exception:
                    try:
                        mmr = int(float(score))
                    except Exception:
                        mmr = 0

                user = get_user_by_id(uid)
                if not user:
                    continue
                stats = get_user_stats(user)
                players.append({
                    "rank": rank,
                    "id": user.get('id'),
                    "name": user.get('name'),
                    "avatar": user.get('avatar', ''),
                    "mmr": int(stats.get('mmr', mmr) or mmr),
                    "peak_mmr": int(stats.get('peak_mmr', mmr) or mmr),
                    "ranked_games": int(stats.get('ranked_games', 0) or 0),
                    "ranked_wins": int(stats.get('ranked_wins', 0) or 0),
                    "ranked_losses": int(stats.get('ranked_losses', 0) or 0),
                })
                rank += 1

            return self._send_json({
                "players": players,
                "type": "ranked",
            })

        # GET /api/games/{code}/theme - Get theme for a game (before joining)
        if path.endswith('/theme') and path.startswith('/api/games/'):
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            if not game:
                return self._send_error("Game not found", 404)
            
            import random
            
            # Get all theme words and ALL words already in any player's pool
            all_theme_words = game.get('theme', {}).get('words', [])
            assigned_words = set()
            for p in game['players']:
                # Exclude ALL words from existing players' pools
                assigned_words.update(w.lower() for w in p.get('word_pool', []))
            
            # Available words = all words not yet in any player's pool
            available_words = [w for w in all_theme_words if w.lower() not in assigned_words]
            
            # Give the next player a random pool from available (unassigned) words
            if len(available_words) >= WORDS_PER_PLAYER:
                next_player_pool = random.sample(available_words, WORDS_PER_PLAYER)
            else:
                next_player_pool = available_words
            
            return self._send_json({
                "theme": {
                    "name": game.get('theme', {}).get('name', ''),
                    "words": all_theme_words,  # Full list for reference during game
                },
                "word_pool": sorted(next_player_pool),  # This player's available words (sorted for display)
            })

        # GET /api/games/{code}/spectate - Spectator view (no player_id required)
        if path.endswith('/spectate') and path.startswith('/api/games/'):
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            if not game:
                return self._send_error("Game not found", 404)

            # Spectator presence heartbeat (best-effort)
            spectator_id = sanitize_player_id(query.get('spectator_id', ''))
            if spectator_id:
                touch_presence(code, "spectators", spectator_id)
            spectator_count = get_spectator_count(code)
            
            try:
                game_finished = game['status'] == 'finished'
                all_words_set = all(p.get('secret_word') for p in game.get('players', [])) if game.get('players') else False
                
                current_player_id = None
                if game['status'] == 'playing' and game.get('players') and all_words_set:
                    current_player_id = game['players'][game['current_turn']]['id']
                
                theme_data = game.get('theme') or {}
                
                # Build vote info with player names (for lobbies)
                theme_votes = game.get('theme_votes', {})
                theme_votes_with_names = {}
                for theme, voter_ids in theme_votes.items():
                    voters = []
                    for vid in voter_ids:
                        voter = next((p for p in game.get('players', []) if p['id'] == vid), None)
                        if voter:
                            voters.append({"id": vid, "name": voter['name']})
                    theme_votes_with_names[theme] = voters
                
                response = {
                    "code": game['code'],
                    "host_id": game.get('host_id', ''),
                    "players": [],
                    "current_turn": game.get('current_turn', 0),
                    "current_player_id": current_player_id,
                    "status": game.get('status', ''),
                    "winner": game.get('winner'),
                    "history": game.get('history', []),
                    "visibility": game.get('visibility', 'public'),
                    "is_ranked": bool(game.get('is_ranked', False)),
                    "spectator_count": spectator_count,
                    "theme": {
                        "name": theme_data.get('name', ''),
                        "words": theme_data.get('words', []),
                    },
                    "waiting_for_word_change": game.get('waiting_for_word_change'),
                    "theme_options": game.get('theme_options', []),
                    "theme_votes": theme_votes_with_names,
                    "all_words_set": all_words_set,
                    "ready_count": sum(1 for p in game.get('players', []) if p.get('is_ready', False)),
                    "is_singleplayer": game.get('is_singleplayer', False),
                    "is_spectator": True,
                }
                
                for p in game.get('players', []):
                    response['players'].append({
                        "id": p.get('id'),
                        "name": p.get('name'),
                        "secret_word": p.get('secret_word') if game_finished else None,
                        "has_word": bool(p.get('secret_word')),
                        "is_alive": p.get('is_alive', True),
                        "is_ready": p.get('is_ready', False),
                        "cosmetics": p.get('cosmetics', {}),
                        "is_ai": p.get('is_ai', False),
                        "difficulty": p.get('difficulty'),
                    })
                
                return self._send_json(response)
            except Exception as e:
                print(f"Error building spectate response: {e}")
                return self._send_error("Failed to load game. Please try again.", 500)

        # GET /api/games/{code}/chat - Fetch chat messages after a message id
        if path.endswith('/chat') and path.startswith('/api/games/'):
            try:
                # Rate limit: 60/min (general)
                if not check_rate_limit(get_ratelimit_general(), f"chat_get:{client_ip}"):
                    return self._send_error("Too many requests. Please wait.", 429)

                code = sanitize_game_code(path.split('/')[3])
                if not code:
                    return self._send_error("Invalid game code format", 400)

                # Game must exist (chat is scoped to the game)
                game = load_game(code)
                if not game:
                    return self._send_error("Game not found", 404)

                after_raw = query.get('after', '0')
                try:
                    after_id = int(after_raw)
                except Exception:
                    after_id = 0
                if after_id < 0:
                    after_id = 0

                limit_raw = query.get('limit', '50')
                try:
                    limit = int(limit_raw)
                except Exception:
                    limit = 50
                limit = max(1, min(200, limit))

                redis = get_redis()
                key = f"chat:{code}"

                # Primary storage: sorted-set `chat:{code}` (atomic appends).
                zset_messages = []
                try:
                    raw = redis.zrange(key, 0, -1) or []
                except Exception:
                    raw = []

                for item in raw:
                    if not item:
                        continue
                    # Some clients may return (member, score) pairs
                    if isinstance(item, (list, tuple)) and len(item) == 2:
                        item = item[0]
                    if isinstance(item, bytes):
                        try:
                            item = item.decode()
                        except Exception:
                            continue
                    msg = None
                    # Some Upstash clients may already deserialize JSON into dicts
                    if isinstance(item, dict):
                        # If this looks like our payload, accept directly.
                        if 'text' in item and ('sender_id' in item or 'sender_name' in item):
                            msg = item
                        # Or if wrapped, unwrap common shapes
                        elif 'member' in item:
                            item = item.get('member')
                        elif 'value' in item:
                            item = item.get('value')
                    if msg is None:
                        try:
                            if isinstance(item, bytes):
                                item = item.decode()
                            if isinstance(item, str):
                                msg = json.loads(item)
                            else:
                                # Last resort: stringify and attempt JSON parse
                                msg = json.loads(str(item))
                        except Exception:
                            msg = None
                    if isinstance(msg, dict):
                        zset_messages.append(msg)

                # Fallback storage: messages stored on the game object (when zadd fails in some envs).
                game_messages = []
                try:
                    gm = game.get('chat_messages', [])
                    if isinstance(gm, list):
                        for m in gm:
                            if isinstance(m, dict):
                                game_messages.append(m)
                except Exception:
                    game_messages = []

                # Merge + dedupe by id (and keep order by id/ts).
                merged = []
                seen_ids = set()
                for msg in (zset_messages + game_messages):
                    try:
                        mid = int(msg.get('id', 0) or 0)
                    except Exception:
                        mid = 0
                    # If id is missing, fall back to a tuple key; but normally all messages have ids.
                    key_id = mid if mid else (msg.get('ts'), msg.get('sender_id'), msg.get('text'))
                    if key_id in seen_ids:
                        continue
                    seen_ids.add(key_id)
                    merged.append(msg)

                def _sort_key(m):
                    try:
                        mid = int(m.get('id', 0) or 0)
                    except Exception:
                        mid = 0
                    try:
                        ts = int(m.get('ts', 0) or 0)
                    except Exception:
                        ts = 0
                    return (mid, ts)

                merged.sort(key=_sort_key)

                messages = []
                last_id = after_id
                for msg in merged:
                    try:
                        mid = int(msg.get('id', 0) or 0)
                    except Exception:
                        mid = 0
                    if mid <= after_id:
                        continue
                    messages.append(msg)
                    if mid > last_id:
                        last_id = mid
                    if len(messages) >= limit:
                        break

                return self._send_json({"messages": messages, "last_id": last_id})
            except Exception as e:
                print(f"Chat fetch error: {e}")
                return self._send_error("Failed to load chat. Please try again.", 500)

        # GET /api/games/{code}/replay - Get full replay data for a finished game
        if path.endswith('/replay') and path.startswith('/api/games/'):
            parts = path.split('/')
            if len(parts) != 5:
                return self._send_error("Invalid path", 400)
            
            code = sanitize_game_code(parts[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            if not game:
                return self._send_error("Game not found", 404)
            
            # Only allow replay for finished games
            if game.get('status') != 'finished':
                return self._send_error("Game is not finished yet", 400)
            
            # Get theme info
            theme_data = game.get('theme') or {}
            
            # Build player info (with revealed words for finished games)
            players = []
            for p in game.get('players', []):
                players.append({
                    "id": p.get('id'),
                    "name": p.get('name'),
                    "secret_word": p.get('secret_word'),
                    "is_alive": p.get('is_alive', True),
                    "is_ai": p.get('is_ai', False),
                    "cosmetics": p.get('cosmetics', {}),
                })
            
            # Build replay data
            replay_data = {
                "code": game['code'],
                "theme": {
                    "name": theme_data.get('name', ''),
                },
                "players": players,
                "winner": game.get('winner'),
                "history": game.get('history', []),
                "is_ranked": bool(game.get('is_ranked', False)),
                "created_at": game.get('created_at'),
                "finished_at": game.get('finished_at', game.get('created_at')),
            }
            
            return self._send_json(replay_data)

        # GET /api/games/{code}
        if path.startswith('/api/games/') and path.count('/') == 3:
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            player_id = sanitize_player_id(query.get('player_id', ''))
            if not player_id:
                return self._send_error("Invalid player ID format", 400)
            
            game = load_game(code)
            if not game:
                return self._send_error("Game not found", 404)
            
            # Check player exists
            player = None
            for p in game['players']:
                if p['id'] == player_id:
                    player = p
                    break
            
            if not player:
                return self._send_error("You are not in this game", 403)

            # Player presence heartbeat (best-effort)
            touch_presence(code, "players", player_id)
            spectator_count = get_spectator_count(code)
            
            try:
                # Reveal all words if game is finished
                game_finished = game['status'] == 'finished'
                
                # Check if all players have set their words (for playing status)
                all_words_set = all(p.get('secret_word') for p in game['players']) if game['players'] else False
                
                # Determine current player (only if all words are set)
                current_player_id = None
                if game['status'] == 'playing' and game['players'] and all_words_set:
                    current_player_id = game['players'][game['current_turn']]['id']
                
                # Safely get theme data
                theme_data = game.get('theme') or {}
                
                # Build vote info with player names
                theme_votes = game.get('theme_votes', {})
                theme_votes_with_names = {}
                for theme, voter_ids in theme_votes.items():
                    voters = []
                    for vid in voter_ids:
                        voter = next((p for p in game['players'] if p['id'] == vid), None)
                        if voter:
                            voters.append({"id": vid, "name": voter['name']})
                    theme_votes_with_names[theme] = voters
                
                # Count ready players
                ready_count = sum(1 for p in game['players'] if p.get('is_ready', False))
                
                # Build response with hidden words
                response = {
                    "code": game['code'],
                    "host_id": game['host_id'],
                    "players": [],
                    "current_turn": game['current_turn'],
                    "current_player_id": current_player_id,
                    "status": game['status'],
                    "winner": game.get('winner'),
                    "history": game.get('history', []),
                    "visibility": game.get('visibility', 'public'),
                    "is_ranked": bool(game.get('is_ranked', False)),
                    "spectator_count": spectator_count,
                    "theme": {
                        "name": theme_data.get('name', ''),
                        "words": theme_data.get('words', []),
                    },
                    "waiting_for_word_change": game.get('waiting_for_word_change'),
                    "theme_options": game.get('theme_options', []),
                    "theme_votes": theme_votes_with_names,
                    "all_words_set": all_words_set,
                    "ready_count": ready_count,
                    "is_singleplayer": game.get('is_singleplayer', False),
                }

                # Ranked: include per-game MMR results on finished games (so clients can display deltas).
                ranked_mmr = game.get('ranked_mmr') if isinstance(game.get('ranked_mmr'), dict) else None
                
                for p in game['players']:
                    player_data = {
                        "id": p['id'],
                        "name": p['name'],
                        # Reveal all words when game is finished, otherwise only show your own
                        "secret_word": p['secret_word'] if (p['id'] == player_id or game_finished) else None,
                        "has_word": bool(p.get('secret_word')),  # Show if they've picked a word
                        "is_alive": p['is_alive'],
                        "can_change_word": p.get('can_change_word', False) if p['id'] == player_id else None,
                        "is_ready": p.get('is_ready', False),
                        "cosmetics": p.get('cosmetics', {}),  # Include cosmetics for all players
                        "is_ai": p.get('is_ai', False),  # Include AI flag
                        "difficulty": p.get('difficulty'),  # Include AI difficulty
                    }
                    if game_finished and bool(game.get('is_ranked', False)) and ranked_mmr:
                        mmr_entry = ranked_mmr.get(str(p.get('id')))
                        if isinstance(mmr_entry, dict):
                            player_data['mmr_before'] = mmr_entry.get('old')
                            player_data['mmr'] = mmr_entry.get('new')
                            player_data['mmr_delta'] = mmr_entry.get('delta')
                    # Include this player's word pool if it's them
                    if p['id'] == player_id:
                        player_data['word_pool'] = p.get('word_pool', [])
                        if p.get('word_change_options') is not None:
                            player_data['word_change_options'] = p.get('word_change_options', [])
                    response['players'].append(player_data)
                
                return self._send_json(response)
            except Exception as e:
                print(f"Error building game response: {e}")  # Log server-side only
                return self._send_error("Failed to load game. Please try again.", 500)

        self._send_error("Not found", 404)

    def do_POST(self):
        path = self.path.split('?')[0]
        body = self._get_body()

        # Get client IP for rate limiting
        client_ip = get_client_ip(self.headers)

        # POST /api/auth/admin - Admin login with password
        if path == '/api/auth/admin':
            if not ADMIN_PASSWORD:
                return self._send_error("Admin login not configured", 500)
            
            # Sanitize and validate password
            password = body.get('password', '')
            if not isinstance(password, str):
                return self._send_error("Invalid password format", 400)
            
            # Limit password length to prevent DoS
            password = password[:100]
            
            # Rate limit admin login attempts: 5/min per IP
            if not check_rate_limit(get_ratelimit_game_create(), client_ip):
                return self._send_error("Too many login attempts. Please wait.", 429)
            
            # Use constant-time comparison to prevent timing attacks
            import hmac
            if not hmac.compare_digest(password, ADMIN_PASSWORD):
                return self._send_error("Invalid password", 401)
            
            # Create admin user data
            admin_user = {
                'id': 'admin_local',
                'email': 'admin@embeddle.io',
                'name': 'Admin',
                'avatar': '',
                'is_admin': True,
                'is_donor': True,
                'cosmetics': DEFAULT_COSMETICS.copy(),
            }
            
            # Create JWT token
            jwt_token = create_jwt_token(admin_user)
            
            return self._send_json({
                'token': jwt_token,
                'user': admin_user,
            })

        # POST /api/games - Create lobby with theme voting
        if path == '/api/games':
            # Rate limit: 5 games/min per IP
            if not check_rate_limit(get_ratelimit_game_create(), client_ip):
                return self._send_error("Too many game creations. Please wait.", 429)
            
            import random

            # Lobby metadata (defaults tuned for friend-code flow)
            requested_visibility = sanitize_visibility(body.get('visibility', 'private'), default='private')
            requested_ranked = parse_bool(body.get('is_ranked', False), default=False)

            # Ranked requires Google auth; also force public visibility
            auth_user_id = self._get_auth_user_id()
            if requested_ranked:
                if not auth_user_id:
                    return self._send_error("Ranked games require Google sign-in", 401)
                requested_visibility = 'public'
            
            code = generate_game_code()
            
            # Make sure code is unique
            while load_game(code):
                code = generate_game_code()
            
            # Pick 3 random theme categories for voting
            theme_options = random.sample(THEME_CATEGORIES, min(3, len(THEME_CATEGORIES)))
            
            # Create lobby with theme voting
            game = {
                "code": code,
                "host_id": "",
                "players": [],
                "current_turn": 0,
                "status": "waiting",  # Directly in waiting state
                "winner": None,
                "history": [],
                "theme": None,  # Will be set when game starts based on votes
                "theme_options": theme_options,
                "theme_votes": {opt: [] for opt in theme_options},  # Track votes per theme
                "created_at": time.time(),  # For lobby expiry
                "visibility": requested_visibility,
                "is_ranked": bool(requested_ranked),
                "created_by_user_id": auth_user_id if requested_ranked else (auth_user_id or None),
            }
            save_game(code, game)
            return self._send_json({
                "code": code,
                "theme_options": theme_options,
                "visibility": requested_visibility,
                "is_ranked": bool(requested_ranked),
            })

        # POST /api/challenge/create - Create a challenge link with pre-configured settings
        if path == '/api/challenge/create':
            # Rate limit: 10 challenges/min per IP
            if not check_rate_limit(get_ratelimit_game_create(), client_ip):
                return self._send_error("Too many challenge creations. Please wait.", 429)
            
            import random
            
            # Get challenger info
            auth_user_id = self._get_auth_user_id()
            challenger_name = body.get('challenger_name', 'Anonymous')
            if not isinstance(challenger_name, str):
                challenger_name = 'Anonymous'
            challenger_name = challenger_name.strip()[:20] or 'Anonymous'
            
            # Challenge settings
            theme = body.get('theme', None)
            if theme and theme not in THEME_CATEGORIES:
                theme = None
            
            # Generate challenge ID
            challenge_id = ''.join(random.choices('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', k=8))
            
            # Store challenge in Redis
            redis = get_redis()
            challenge_data = {
                "id": challenge_id,
                "challenger_name": challenger_name,
                "challenger_user_id": auth_user_id,
                "theme": theme,  # Pre-selected theme (or None for voting)
                "created_at": time.time(),
            }
            
            # Challenges expire after 7 days
            redis.set(f"challenge:{challenge_id}", json.dumps(challenge_data), ex=604800)
            
            return self._send_json({
                "challenge_id": challenge_id,
                "challenge_url": f"/challenge/{challenge_id}",
            })
        
        # GET /api/challenge/{id} - Get challenge details
        if path.startswith('/api/challenge/') and len(path.split('/')) == 4:
            challenge_id = path.split('/')[3].upper()
            
            redis = get_redis()
            challenge_data = redis.get(f"challenge:{challenge_id}")
            
            if not challenge_data:
                return self._send_error("Challenge not found or expired", 404)
            
            challenge = json.loads(challenge_data)
            
            return self._send_json({
                "id": challenge['id'],
                "challenger_name": challenge['challenger_name'],
                "theme": challenge.get('theme'),
                "created_at": challenge.get('created_at'),
            })
        
        # POST /api/challenge/{id}/accept - Accept a challenge and create a game
        if path.startswith('/api/challenge/') and path.endswith('/accept'):
            parts = path.split('/')
            if len(parts) != 5:
                return self._send_error("Invalid challenge path", 400)
            
            challenge_id = parts[3].upper()
            
            # Rate limit
            if not check_rate_limit(get_ratelimit_game_create(), client_ip):
                return self._send_error("Too many requests. Please wait.", 429)
            
            redis = get_redis()
            challenge_data = redis.get(f"challenge:{challenge_id}")
            
            if not challenge_data:
                return self._send_error("Challenge not found or expired", 404)
            
            challenge = json.loads(challenge_data)
            
            import random
            
            # Create a new game for this challenge
            code = generate_game_code()
            while load_game(code):
                code = generate_game_code()
            
            # If theme is pre-selected, use it; otherwise use voting
            theme = challenge.get('theme')
            if theme and theme in THEME_CATEGORIES:
                theme_options = [theme]
                theme_votes = {theme: []}
            else:
                theme_options = random.sample(THEME_CATEGORIES, min(3, len(THEME_CATEGORIES)))
                theme_votes = {opt: [] for opt in theme_options}
            
            game = {
                "code": code,
                "host_id": "",
                "players": [],
                "current_turn": 0,
                "status": "waiting",
                "winner": None,
                "history": [],
                "theme": theme if theme else None,
                "theme_options": theme_options,
                "theme_votes": theme_votes,
                "created_at": time.time(),
                "visibility": "private",
                "is_ranked": False,
                "challenge_id": challenge_id,
                "challenger_name": challenge.get('challenger_name'),
            }
            save_game(code, game)
            
            return self._send_json({
                "code": code,
                "theme_options": theme_options,
                "challenger_name": challenge.get('challenger_name'),
            })

        # POST /api/singleplayer - Create singleplayer lobby
        if path == '/api/singleplayer':
            # Rate limit: 5 games/min per IP
            if not check_rate_limit(get_ratelimit_game_create(), client_ip):
                return self._send_error("Too many game creations. Please wait.", 429)
            
            import random
            
            code = generate_game_code()
            
            # Make sure code is unique
            while load_game(code):
                code = generate_game_code()

            # Offer 3 theme options to choose from (host picks via "vote" UI)
            theme_options = random.sample(THEME_CATEGORIES, min(3, len(THEME_CATEGORIES)))
            
            # Create singleplayer lobby
            game = {
                "code": code,
                "host_id": "",
                "players": [],
                "current_turn": 0,
                "status": "waiting",
                "winner": None,
                "history": [],
                "theme": None,  # Set on start based on selection
                "theme_options": theme_options,
                "theme_votes": {opt: [] for opt in theme_options},
                "created_at": time.time(),
                "is_singleplayer": True,  # Mark as singleplayer game
                "visibility": "private",
                "is_ranked": False,
            }
            save_game(code, game)
            return self._send_json({
                "code": code,
                "theme_options": theme_options,
                "is_singleplayer": True,
                "visibility": "private",
                "is_ranked": False,
            })

        # POST /api/games/{code}/add-ai - Add AI player to singleplayer lobby
        if '/add-ai' in path and path.startswith('/api/games/'):
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if not game.get('is_singleplayer'):
                return self._send_error("Can only add AI to singleplayer games", 400)
            if game['status'] != 'waiting':
                return self._send_error("Game has already started", 400)
            if len(game['players']) >= MAX_PLAYERS:
                return self._send_error("Game is full", 400)
            
            player_id = body.get('player_id', '')
            # Allow AI player IDs or sanitized human player IDs
            if not player_id.startswith('ai_'):
                player_id = sanitize_player_id(player_id)
            if not player_id:
                return self._send_error("Invalid player ID format", 400)
            
            # Verify requester is the host
            if game['host_id'] != player_id:
                return self._send_error("Only the host can add AI players", 403)
            
            difficulty = body.get('difficulty', 'rookie')
            if difficulty not in AI_DIFFICULTY_CONFIG:
                allowed = ", ".join(["rookie", "analyst", "field-agent", "spymaster", "ghost"])
                return self._send_error(f"Invalid difficulty. Choose: {allowed}", 400)
            
            # Create AI player
            existing_names = [p['name'] for p in game['players']]
            ai_player = create_ai_player(difficulty, existing_names)
            
            game['players'].append(ai_player)
            save_game(code, game)
            
            return self._send_json({
                "status": "ai_added",
                "ai_player": {
                    "id": ai_player["id"],
                    "name": ai_player["name"],
                    "difficulty": ai_player["difficulty"],
                    "is_ai": True,
                },
            })

        # POST /api/games/{code}/remove-ai - Remove AI player from singleplayer lobby
        if '/remove-ai' in path and path.startswith('/api/games/'):
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if not game.get('is_singleplayer'):
                return self._send_error("Can only remove AI from singleplayer games", 400)
            if game['status'] != 'waiting':
                return self._send_error("Game has already started", 400)
            
            player_id = body.get('player_id', '')
            # Allow AI player IDs or sanitized human player IDs
            if not player_id.startswith('ai_'):
                player_id = sanitize_player_id(player_id)
            if not player_id:
                return self._send_error("Invalid player ID format", 400)
            
            # Verify requester is the host
            if game['host_id'] != player_id:
                return self._send_error("Only the host can remove AI players", 403)
            
            ai_id = body.get('ai_id', '')
            if not ai_id or not ai_id.startswith('ai_'):
                return self._send_error("Invalid AI player ID", 400)
            
            # Find and remove AI player
            ai_player = next((p for p in game['players'] if p['id'] == ai_id), None)
            if not ai_player:
                return self._send_error("AI player not found", 404)
            if not ai_player.get('is_ai'):
                return self._send_error("Cannot remove human players", 400)
            
            game['players'] = [p for p in game['players'] if p['id'] != ai_id]
            save_game(code, game)
            
            return self._send_json({
                "status": "ai_removed",
                "removed_id": ai_id,
            })

        # POST /api/games/{code}/vote - Vote for a theme
        if '/vote' in path and path.startswith('/api/games/'):
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game['status'] != 'waiting':
                return self._send_error("Voting is closed", 400)
            
            player_id = sanitize_player_id(body.get('player_id', ''))
            if not player_id:
                return self._send_error("Invalid player ID format", 400)
            
            theme = body.get('theme', '').strip()
            
            if theme not in game.get('theme_options', []):
                return self._send_error("Invalid theme", 400)
            
            # Remove player's previous vote (if any)
            for t in game.get('theme_votes', {}):
                if player_id in game['theme_votes'][t]:
                    game['theme_votes'][t].remove(player_id)
            
            # Add new vote
            if theme not in game['theme_votes']:
                game['theme_votes'][theme] = []
            game['theme_votes'][theme].append(player_id)
            
            save_game(code, game)
            return self._send_json({"status": "voted", "theme_votes": game['theme_votes']})

        # POST /api/games/{code}/theme - Set the theme (creator chooses)
        if '/theme' in path and path.startswith('/api/games/') and path.count('/') == 4:
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game['status'] != 'choosing_theme':
                return self._send_error("Theme already chosen", 400)
            
            chosen_theme = body.get('theme', '').strip()
            
            # Validate the chosen theme is one of the options
            if chosen_theme not in game.get('theme_options', []):
                return self._send_error("Invalid theme choice", 400)
            
            # Get pre-generated words for the chosen theme
            theme = get_theme_words(chosen_theme)
            
            game['theme'] = {
                "name": theme.get("name", chosen_theme),
                "words": theme.get("words", []),
            }
            game['status'] = 'waiting'  # Now waiting for players
            del game['theme_options']  # Clean up
            
            save_game(code, game)
            return self._send_json({
                "theme": game['theme'],
            })

        # POST /api/games/{code}/leave - Leave lobby / forfeit in-game
        if '/leave' in path and path.startswith('/api/games/'):
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)

            game = load_game(code)
            if not game:
                return self._send_error("Game not found", 404)

            player_id = sanitize_player_id(body.get('player_id', ''))
            if not player_id:
                return self._send_error("Invalid player ID format", 400)

            player = next((p for p in game.get('players', []) if p.get('id') == player_id), None)
            if not player:
                return self._send_error("You are not in this game", 403)

            is_ranked = bool(game.get('is_ranked', False))
            if is_ranked:
                token_user_id = self._get_auth_user_id()
                if not token_user_id:
                    return self._send_error("Ranked games require Google sign-in", 401)
                if (player.get('auth_user_id') or '') != token_user_id:
                    return self._send_error("Not authorized for this player", 403)

            status = game.get('status')
            is_singleplayer = bool(game.get('is_singleplayer', False))

            # Singleplayer QoL: allow "soft leave" so players can go join other games and later resume.
            # By default, leaving a singleplayer game does NOT forfeit. If the client explicitly passes
            # {"forfeit": true}, we treat it as an intentional solo forfeit and delete the run.
            if is_singleplayer:
                wants_forfeit = False
                try:
                    if isinstance(body, dict) and 'forfeit' in body:
                        wants_forfeit = parse_bool(body.get('forfeit', False), default=False)
                except Exception:
                    wants_forfeit = False

                if wants_forfeit:
                    try:
                        delete_game(code)
                    except Exception:
                        pass
                    return self._send_json({
                        "status": "left",
                        "forfeit": True,
                        "deleted": True,
                        "is_singleplayer": True,
                        "game_status": status,
                    })

                # Soft leave: keep the game and player state intact.
                # Best-effort refresh expiry so it survives the hop.
                try:
                    save_game(code, game)
                except Exception:
                    pass
                return self._send_json({
                    "status": "left",
                    "forfeit": False,
                    "preserved": True,
                    "is_singleplayer": True,
                    "game_status": status,
                })

            # Lobby / word selection: remove the player from the game
            if status in ('waiting', 'word_selection'):
                # Ranked fairness: once the match has progressed to word selection, leaving counts as a forfeit
                # for MMR purposes (so remaining players' Elo/MMR still reflects the full lobby).
                if is_ranked and status == 'word_selection':
                    game.setdefault('history', []).append({
                        "type": "forfeit",
                        "player_id": player.get('id'),
                        "player_name": player.get('name'),
                        "word": player.get('secret_word'),
                    })

                game['players'] = [p for p in game.get('players', []) if p.get('id') != player_id]

                # Clear any pause flags just in case
                if game.get('waiting_for_word_change') == player_id:
                    game['waiting_for_word_change'] = None

                # Reassign host if needed
                if game.get('host_id') == player_id:
                    game['host_id'] = game['players'][0]['id'] if game.get('players') else ''

                if not game.get('players'):
                    # Delete empty game
                    try:
                        delete_game(code)
                    except Exception:
                        pass
                    return self._send_json({"status": "left", "deleted": True})

                # Ranked: if someone forfeits during word selection and only one player remains,
                # finish immediately so the remaining player still gets the win/MMR.
                if is_ranked and status == 'word_selection':
                    alive_players = [p for p in game.get('players', []) if p.get('is_alive', True)]
                    if len(alive_players) <= 1:
                        game['status'] = 'finished'
                        game['waiting_for_word_change'] = None
                        game['winner'] = alive_players[0]['id'] if alive_players else None
                        update_game_stats(game)
                        save_game(code, game)
                        return self._send_json({
                            "status": "left",
                            "forfeit": True,
                            "game_over": True,
                            "winner": game.get('winner'),
                        })

                save_game(code, game)
                resp = {"status": "left", "deleted": False, "host_id": game.get('host_id')}
                if is_ranked and status == 'word_selection':
                    resp["forfeit"] = True
                return self._send_json(resp)

            # In-game: forfeit => mark eliminated, advance turn if needed
            if status == 'playing':
                if not player.get('is_alive', True):
                    return self._send_json({"status": "left", "forfeit": True, "already_eliminated": True})

                player['is_alive'] = False

                # If they were the blocker for word change, unblock the game.
                if game.get('waiting_for_word_change') == player_id:
                    game['waiting_for_word_change'] = None
                    # They can no longer change word (they left)
                    player['can_change_word'] = False
                    player.pop('word_change_options', None)

                # Record forfeit in history (used for ranked placement ordering)
                game.setdefault('history', []).append({
                    "type": "forfeit",
                    "player_id": player.get('id'),
                    "player_name": player.get('name'),
                    # Reveal the forfeiter's word so other players can see it immediately.
                    # (Normal eliminations already reveal via the guessed word in history.)
                    "word": player.get('secret_word'),
                })

                # If it was their turn, advance to next alive player
                try:
                    current = game.get('players', [])[game.get('current_turn', 0)]
                except Exception:
                    current = None

                alive_players = [p for p in game.get('players', []) if p.get('is_alive')]
                if len(alive_players) <= 1:
                    game['status'] = 'finished'
                    game['waiting_for_word_change'] = None
                    game['winner'] = alive_players[0]['id'] if alive_players else None
                    update_game_stats(game)
                    save_game(code, game)
                    return self._send_json({
                        "status": "left",
                        "forfeit": True,
                        "game_over": True,
                        "winner": game.get('winner'),
                    })

                if current and current.get('id') == player_id:
                    num_players = len(game.get('players', []))
                    next_turn = (int(game.get('current_turn', 0)) + 1) % max(1, num_players)
                    # Skip eliminated players
                    while num_players > 0 and not game['players'][next_turn].get('is_alive'):
                        next_turn = (next_turn + 1) % num_players
                    game['current_turn'] = next_turn

                save_game(code, game)
                return self._send_json({
                    "status": "left",
                    "forfeit": True,
                    "game_over": False,
                })

            # Finished/unknown status: just acknowledge
            return self._send_json({"status": "left", "forfeit": False, "game_status": status})

        # POST /api/games/{code}/chat - Send a chat message (lobby or in-game)
        if '/chat' in path and path.startswith('/api/games/'):
            try:
                code = sanitize_game_code(path.split('/')[3])
                if not code:
                    return self._send_error("Invalid game code format", 400)

                # Rate limit: 20 messages/min per player (best-effort)
                player_id = sanitize_player_id(body.get('player_id', ''))
                if not player_id:
                    return self._send_error("Invalid player ID format", 400)
                if not check_rate_limit(get_ratelimit_chat(), f"{code}:{player_id}"):
                    return self._send_error("Too many messages. Please wait.", 429)

                game = load_game(code)
                if not game:
                    return self._send_error("Game not found", 404)

                # Must be a participant (no spectator chat for now)
                player = next((p for p in game.get('players', []) if p.get('id') == player_id), None)
                if not player:
                    return self._send_error("You are not in this game", 403)

                message = body.get('message', body.get('text', ''))
                if not isinstance(message, str):
                    return self._send_error("Invalid message", 400)
                # Normalize and bound
                message = message.strip()
                if not message:
                    return self._send_error("Message cannot be empty", 400)
                message = message[:200]
                # Drop control chars
                message = re.sub(r"[\x00-\x1F\x7F]", "", message)
                # Profanity filter (mask)
                message = filter_profanity(message)

                redis = get_redis()
                chat_key = f"chat:{code}"

                # Monotonic message id (fallback to timestamp if INCR unavailable)
                msg_id = None
                try:
                    msg_id = int(redis.incr(f"chat:{code}:id"))
                except Exception:
                    msg_id = int(time.time() * 1000)
                # Ensure monotonic vs any fallback-stored messages on the game object
                try:
                    last_game_id = int(game.get('chat_last_id', 0) or 0)
                except Exception:
                    last_game_id = 0
                if msg_id <= last_game_id:
                    msg_id = last_game_id + 1

                payload = {
                    "id": msg_id,
                    "ts": int(time.time() * 1000),
                    "sender_id": player_id,
                    "sender_name": player.get('name', ''),
                    "text": message,
                }

                try:
                    redis.zadd(chat_key, {json.dumps(payload): msg_id})
                    # Best-effort trim to last 200 messages
                    try:
                        redis.zremrangebyrank(chat_key, 0, -201)
                    except Exception:
                        pass
                    # Best-effort keep chat aligned with game expiry
                    try:
                        redis.expire(chat_key, GAME_EXPIRY_SECONDS)
                    except Exception:
                        pass
                except Exception as e:
                    err_id = secrets.token_hex(4)
                    print(f"Chat write error [{err_id}]: {e}")
                    # Fallback: store chat messages on the game object (uses setex, which is already used everywhere).
                    try:
                        msgs = game.get('chat_messages', [])
                        if not isinstance(msgs, list):
                            msgs = []
                        msgs.append(payload)
                        if len(msgs) > 200:
                            msgs = msgs[-200:]
                        game['chat_messages'] = msgs
                        # Track last id for monotonicity on subsequent fallback writes
                        try:
                            prev = int(game.get('chat_last_id', 0) or 0)
                        except Exception:
                            prev = 0
                        game['chat_last_id'] = max(prev, msg_id)
                        save_game(code, game)
                    except Exception as e2:
                        err2_id = secrets.token_hex(4)
                        print(f"Chat fallback write error [{err2_id}]: {e2}")
                        resp = {
                            "detail": "Failed to send message. Please try again.",
                            "error_id": err2_id,
                            "error_code": "CHAT_FALLBACK_WRITE_ERROR",
                        }
                        debug_payload = {
                            "where": "chat_fallback_write",
                            "type": type(e2).__name__,
                            "error": str(e2)[:500],
                        }
                        # Always store server-side so we can retrieve by error_id later (admin/debug endpoint).
                        try:
                            redis.setex(
                                f"debug:chat_error:{err2_id}",
                                DEBUG_ERROR_TTL_SECONDS,
                                json.dumps(debug_payload),
                            )
                        except Exception:
                            pass
                        # Optionally attach debug to response for admin/debug clients
                        if self._debug_allowed():
                            resp["debug"] = debug_payload
                        return self._send_json(resp, 500)

                return self._send_json({"message": payload})
            except Exception as e:
                err_id = secrets.token_hex(4)
                print(f"Chat handler error [{err_id}]: {e}")
                resp = {
                    "detail": "Failed to send message. Please try again.",
                    "error_id": err_id,
                    "error_code": "CHAT_HANDLER_ERROR",
                }
                import traceback
                debug_payload = {
                    "where": "chat_handler",
                    "type": type(e).__name__,
                    "error": str(e)[:500],
                    "trace": traceback.format_exc(limit=8),
                }
                # Always store server-side so we can retrieve by error_id later (admin/debug endpoint).
                try:
                    redis = get_redis()
                    redis.setex(
                        f"debug:chat_error:{err_id}",
                        DEBUG_ERROR_TTL_SECONDS,
                        json.dumps(debug_payload),
                    )
                except Exception:
                    pass
                # Optionally attach debug to response for admin/debug clients
                if self._debug_allowed():
                    resp["debug"] = debug_payload
                return self._send_json(resp, 500)

        # POST /api/games/{code}/join - Join lobby (just name, no word yet)
        if '/join' in path and '/set-word' not in path:
            # Rate limit: 10 joins/min per IP
            if not check_rate_limit(get_ratelimit_join(), client_ip):
                return self._send_error("Too many join attempts. Please wait.", 429)
            
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)

            is_ranked = bool(game.get('is_ranked', False))

            # Determine authenticated user (prefer JWT; keep body field for backwards compatibility)
            token_user_id = self._get_auth_user_id()
            auth_user_id = token_user_id or (body.get('auth_user_id', '') if isinstance(body.get('auth_user_id', ''), str) else '')

            # Ranked games require JWT-authenticated identity
            if is_ranked and not token_user_id:
                return self._send_error("Ranked games require Google sign-in", 401)
            if is_ranked:
                auth_user_id = token_user_id  # Never trust body for ranked
            
            # Check if user is admin (allow "admin" name for actual admin)
            is_admin_user = auth_user_id == 'admin_local'
            
            name = sanitize_player_name(body.get('name', ''), allow_admin=is_admin_user)
            if not name:
                return self._send_error("Invalid name. Use only letters, numbers, underscores, and spaces (1-20 chars)", 400)
            
            # Get user cosmetics if authenticated
            user_cosmetics = None
            if auth_user_id:
                if is_admin_user:
                    # Get admin cosmetics from Redis
                    redis = get_redis()
                    existing = redis.get('admin_cosmetics')
                    admin_cosmetics = json.loads(existing) if existing else DEFAULT_COSMETICS.copy()
                    user_cosmetics = admin_cosmetics
                else:
                    auth_user = get_user_by_id(auth_user_id)
                    if auth_user:
                        user_cosmetics = get_visible_cosmetics(auth_user)
            
            # Check if player is trying to rejoin
            existing_player = None
            if is_ranked and auth_user_id:
                existing_player = next((p for p in game.get('players', []) if p.get('auth_user_id') == auth_user_id), None)
            else:
                existing_player = next((p for p in game.get('players', []) if p.get('name', '').lower() == name.lower()), None)
            if existing_player:
                # Update cosmetics if provided
                if user_cosmetics:
                    existing_player['cosmetics'] = user_cosmetics
                # Allow renaming on rejoin when authenticated
                if auth_user_id:
                    existing_player['auth_user_id'] = auth_user_id
                existing_player['name'] = name
                save_game(code, game)
                # Allow rejoin - return their player_id
                return self._send_json({
                    "player_id": existing_player['id'],
                    "game_code": code,
                    "is_host": existing_player['id'] == game['host_id'],
                    "rejoined": True,
                    "theme_options": game.get('theme_options', []),
                    "theme_votes": game.get('theme_votes', {}),
                    "visibility": game.get('visibility', 'public'),
                    "is_ranked": bool(game.get('is_ranked', False)),
                })
            
            if game['status'] != 'waiting':
                return self._send_error("Game has already started", 400)
            if len(game['players']) >= MAX_PLAYERS:
                return self._send_error("Game is full", 400)

            # For ranked: keep display names unique (auth identity is what matters, but UI clarity helps)
            if is_ranked:
                existing_names = {str(p.get('name', '')).lower() for p in game.get('players', [])}
                if name.lower() in existing_names:
                    base = name
                    # Try _2.._99 suffixes while staying within 20 chars
                    found = None
                    for n in range(2, 100):
                        suffix = f"_{n}"
                        keep = max(1, 20 - len(suffix))
                        candidate = (base[:keep] + suffix)
                        if candidate.lower() not in existing_names and PLAYER_NAME_PATTERN.match(candidate):
                            found = html.escape(candidate)
                            break
                    if not found:
                        return self._send_error("Name already taken in this ranked lobby", 409)
                    name = found
            
            player_id = generate_player_id()
            player = {
                "id": player_id,
                "name": name,
                "secret_word": None,  # Will be set later
                "secret_embedding": None,
                "is_alive": True,
                "can_change_word": False,
                "word_pool": [],  # Will be assigned when game starts
                "is_ready": False,  # Ready status for lobby
                "cosmetics": user_cosmetics or {},  # Player's visible cosmetics
                "auth_user_id": auth_user_id or None,  # Ranked identity / cosmetics linkage
            }
            game['players'].append(player)
            
            if len(game['players']) == 1:
                game['host_id'] = player_id
            
            save_game(code, game)
            return self._send_json({
                "player_id": player_id,
                "game_code": code,
                "is_host": player_id == game['host_id'],
                "theme_options": game.get('theme_options', []),
                "theme_votes": game.get('theme_votes', {}),
                "visibility": game.get('visibility', 'public'),
                "is_ranked": bool(game.get('is_ranked', False)),
            })

        # POST /api/games/{code}/ready - Toggle ready status
        if '/ready' in path and path.startswith('/api/games/'):
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game['status'] != 'waiting':
                return self._send_error("Game has already started", 400)
            
            player_id = sanitize_player_id(body.get('player_id', ''))
            if not player_id:
                return self._send_error("Invalid player ID format", 400)
            
            player = next((p for p in game['players'] if p['id'] == player_id), None)
            if not player:
                return self._send_error("You are not in this game", 403)
            
            # Toggle ready status
            player['is_ready'] = not player.get('is_ready', False)
            
            save_game(code, game)
            return self._send_json({
                "is_ready": player['is_ready'],
            })

        # POST /api/games/{code}/set-word - Set secret word (during word selection)
        if '/set-word' in path:
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game['status'] not in ['word_selection', 'playing']:
                return self._send_error("Not in word selection phase", 400)
            
            player_id = sanitize_player_id(body.get('player_id', ''))
            if not player_id:
                return self._send_error("Invalid player ID format", 400)
            
            secret_word = sanitize_word(body.get('secret_word', ''))
            if not secret_word:
                return self._send_error("Invalid word. Use only letters (2-30 chars)", 400)
            
            player = next((p for p in game['players'] if p['id'] == player_id), None)
            if not player:
                return self._send_error("You are not in this game", 403)
            if player.get('secret_word'):
                return self._send_error("You already set your word", 400)
            
            # Validate against player's assigned word pool
            player_word_pool = player.get('word_pool', [])
            if player_word_pool and secret_word.lower() not in [w.lower() for w in player_word_pool]:
                return self._send_error("Please choose a word from your word pool", 400)
            
            try:
                embedding = get_embedding(secret_word)
            except Exception as e:
                print(f"Embedding error for set-word: {e}")  # Log server-side only
                return self._send_error("Word processing service unavailable. Please try again.", 503)
            
            player['secret_word'] = secret_word.lower()
            player['secret_embedding'] = embedding
            
            save_game(code, game)
            return self._send_json({
                "status": "word_set",
                "word_pool": player['word_pool'],
            })

        # POST /api/games/{code}/start - Move from lobby to word selection
        if '/start' in path and '/begin' not in path:
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            
            player_id = sanitize_player_id(body.get('player_id', ''))
            if not player_id:
                return self._send_error("Invalid player ID format", 400)
            
            if game['host_id'] != player_id:
                return self._send_error("Only the host can start", 403)
            if game['status'] != 'waiting':
                return self._send_error("Game already started", 400)
            
            # Check if host is admin (can bypass min players) or if it's singleplayer
            host_player = next((p for p in game['players'] if p['id'] == player_id), None)
            is_admin_host = host_player and host_player.get('auth_user_id') == 'admin_local'
            is_singleplayer = game.get('is_singleplayer', False)
            
            # Singleplayer needs at least 2 players (1 human + 1 AI)
            if is_singleplayer:
                if len(game['players']) < 2:
                    return self._send_error("Add at least 1 AI opponent", 400)
            elif len(game['players']) < MIN_PLAYERS and not is_admin_host:
                return self._send_error(f"Need at least {MIN_PLAYERS} players", 400)

            # Ranked: snapshot participants at match start so later forfeits/leaves don't shrink the rating pool.
            # This lets remaining players gain/lose MMR as if the forfeiter stayed in the match.
            if bool(game.get('is_ranked', False)) and not bool(game.get('is_singleplayer', False)):
                try:
                    existing = game.get('ranked_participants')
                    if not isinstance(existing, list) or not existing:
                        rp = []
                        for p in (game.get('players', []) or []):
                            if not isinstance(p, dict):
                                continue
                            if p.get('is_ai'):
                                continue
                            uid = p.get('auth_user_id')
                            if not uid or uid == 'admin_local':
                                continue
                            rp.append({
                                "id": p.get('id'),
                                "name": p.get('name'),
                                "auth_user_id": uid,
                            })
                        if rp:
                            game['ranked_participants'] = rp
                except Exception:
                    pass
            
            import random
            
            # Determine theme from votes/options if available (singleplayer now also uses this).
            votes = game.get('theme_votes', {}) or {}
            theme_options = game.get('theme_options', []) or []

            if theme_options:
                # Build weighted list: each theme appears once per vote
                weighted_themes = []
                for theme_name in theme_options:
                    vote_count = len(votes.get(theme_name, []))
                    weighted_themes.extend([theme_name] * max(vote_count, 0))

                if not weighted_themes:
                    weighted_themes = theme_options.copy()

                winning_theme = random.choice(weighted_themes)
                theme = get_theme_words(winning_theme)
                game['theme'] = {
                    "name": theme.get("name", winning_theme),
                    "words": theme.get("words", []),
                }
            else:
                # Backwards-compatible fallback: singleplayer games created before theme options existed already have a theme.
                if not game.get('theme') or not game['theme'].get('words'):
                    winning_theme = random.choice(THEME_CATEGORIES) if THEME_CATEGORIES else 'Animals'
                    theme = get_theme_words(winning_theme)
                    game['theme'] = {
                        "name": theme.get("name", winning_theme),
                        "words": theme.get("words", []),
                    }

            all_words = game['theme'].get('words', [])
            
            # Assign distinct word pools to each player (WORDS_PER_PLAYER words each, no overlap)
            # NOTE: We intentionally fail closed if the theme is too small, because overlaps are not allowed.
            unique_words = []
            seen_words = set()
            for w in (all_words or []):
                token = str(w or "").strip().lower()
                if not token:
                    continue
                if token in seen_words:
                    continue
                seen_words.add(token)
                unique_words.append(token)
            all_words = unique_words

            required = WORDS_PER_PLAYER * len(game.get('players', []) or [])
            if required and len(all_words) < required:
                theme_name = (game.get('theme', {}) or {}).get('name', 'Unknown')
                return self._send_error(
                    f"Theme '{theme_name}' does not have enough words for this lobby. "
                    f"Need {required} unique words ({WORDS_PER_PLAYER} per player), but only have {len(all_words)}.",
                    400,
                )

            shuffled_words = all_words.copy()
            random.shuffle(shuffled_words)

            for i, p in enumerate(game.get('players', []) or []):
                start_idx = i * WORDS_PER_PLAYER
                end_idx = start_idx + WORDS_PER_PLAYER
                pool = shuffled_words[start_idx:end_idx]
                p['word_pool'] = sorted(pool)
            
            # Move to word selection phase (not playing yet)
            game['status'] = 'word_selection'
            game['current_turn'] = 0
            save_game(code, game)
            return self._send_json({"status": "word_selection", "theme": game['theme']['name']})

        # POST /api/games/{code}/begin - Start the actual game after word selection
        if '/begin' in path:
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            
            player_id = sanitize_player_id(body.get('player_id', ''))
            if not player_id:
                return self._send_error("Invalid player ID format", 400)
            
            if game['host_id'] != player_id:
                return self._send_error("Only the host can begin", 403)
            if game['status'] != 'word_selection':
                return self._send_error("Game not in word selection phase", 400)

            # Singleplayer safety: if AIs haven't picked yet, pick them now (fallback for slow clients / many AIs)
            if game.get('is_singleplayer'):
                for p in game.get('players', []):
                    if not p.get('is_ai'):
                        continue
                    if p.get('secret_word') and p.get('secret_embedding'):
                        continue
                    pool = p.get('word_pool', []) or game.get('theme', {}).get('words', [])
                    if not pool:
                        continue
                    selected_word = ai_select_secret_word(p, pool)
                    if not selected_word:
                        continue
                    try:
                        embedding = get_embedding(selected_word)
                        p['secret_word'] = selected_word.lower()
                        p['secret_embedding'] = embedding
                    except Exception as e:
                        print(f"AI word selection error (begin): {e}")
            
            # Check all players have set their words
            not_ready = [p['name'] for p in game['players'] if not p.get('secret_word')]
            if not_ready:
                return self._send_error(f"Waiting for: {', '.join(not_ready)}", 400)
            
            # Randomize turn order for multiplayer so the host doesn't always go first.
            # (Singleplayer stays deterministic: the human host starts.)
            if not game.get('is_singleplayer'):
                import random
                random.shuffle(game['players'])
                game['current_turn'] = 0

            game['status'] = 'playing'
            save_game(code, game)
            return self._send_json({"status": "playing"})

        # POST /api/games/{code}/ai-pick-words - Singleplayer: have AIs pick their secret words
        if '/ai-pick-words' in path and path.startswith('/api/games/'):
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            if not game:
                return self._send_error("Game not found", 404)
            if not game.get('is_singleplayer'):
                return self._send_error("Not a singleplayer game", 400)
            if game.get('status') != 'word_selection':
                return self._send_error("AI can only pick words during word selection", 400)
            
            player_id = sanitize_player_id(body.get('player_id', ''))
            if not player_id:
                return self._send_error("Invalid player ID format", 400)
            if game.get('host_id') != player_id:
                return self._send_error("Only the host can trigger AI word selection", 403)

            max_to_pick = body.get('max_to_pick', 3)
            try:
                max_to_pick = int(max_to_pick)
            except Exception:
                max_to_pick = 3
            max_to_pick = max(1, min(max_to_pick, 10))
            
            picked = 0
            errors = 0
            for p in game.get('players', []):
                if picked >= max_to_pick:
                    break
                if not p.get('is_ai'):
                    continue
                if p.get('secret_word') and p.get('secret_embedding'):
                    continue
                pool = p.get('word_pool', []) or game.get('theme', {}).get('words', [])
                if not pool:
                    continue
                selected_word = ai_select_secret_word(p, pool)
                if not selected_word:
                    continue
                try:
                    embedding = get_embedding(selected_word)
                    p['secret_word'] = selected_word.lower()
                    p['secret_embedding'] = embedding
                    picked += 1
                except Exception as e:
                    errors += 1
                    print(f"AI word selection error: {e}")
            
            save_game(code, game)
            return self._send_json({
                "status": "ai_words_picked",
                "picked": picked,
                "errors": errors,
            })

        # POST /api/games/{code}/ai-step - Singleplayer: process exactly ONE AI turn
        if '/ai-step' in path and path.startswith('/api/games/'):
            # Rate limit: reuse guess limiter (AI can only act when it's their turn)
            if not check_rate_limit(get_ratelimit_guess(), f"ai_step:{client_ip}"):
                return self._send_error("Too many requests. Please wait.", 429)
            
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            if not game:
                return self._send_error("Game not found", 404)
            if not game.get('is_singleplayer'):
                return self._send_error("Not a singleplayer game", 400)
            if game.get('status') != 'playing':
                return self._send_error("Game not in progress", 400)
            
            # Respect word-change pauses
            if game.get('waiting_for_word_change'):
                waiting_player = next((p for p in game['players'] if p['id'] == game['waiting_for_word_change']), None)
                waiting_name = waiting_player['name'] if waiting_player else 'Someone'
                return self._send_error(f"Waiting for {waiting_name} to change their word", 400)
            
            player_id = sanitize_player_id(body.get('player_id', ''))
            if not player_id:
                return self._send_error("Invalid player ID format", 400)
            if game.get('host_id') != player_id:
                return self._send_error("Only the host can trigger AI turns", 403)
            
            # Ensure it's actually an AI's turn
            if not game.get('players'):
                return self._send_error("No players in game", 400)
            
            current_ai = game['players'][game['current_turn']]
            if not current_ai.get('is_ai'):
                return self._send_error("Not an AI turn", 400)
            if not current_ai.get('is_alive'):
                return self._send_error("AI is eliminated", 400)
            
            # Process a single AI turn (guess + history + eliminations)
            ai_result = process_ai_turn(game, current_ai)
            if not ai_result:
                return self._send_error("AI failed to make a move", 500)
            
            # If AI eliminated someone, auto-handle its word change immediately
            word_changed = False
            if ai_result.get('eliminations') and current_ai.get('can_change_word'):
                word_changed = process_ai_word_change(game, current_ai)
            
            # Advance turn / check for game over
            alive_players = [p for p in game['players'] if p.get('is_alive')]
            game_over = False
            if len(alive_players) <= 1:
                game['status'] = 'finished'
                game_over = True
                if alive_players:
                    game['winner'] = alive_players[0]['id']
                update_game_stats(game)
            else:
                num_players = len(game['players'])
                next_turn = (game['current_turn'] + 1) % num_players
                while not game['players'][next_turn].get('is_alive'):
                    next_turn = (next_turn + 1) % num_players
                game['current_turn'] = next_turn
            
            save_game(code, game)
            return self._send_json({
                "status": "ai_step",
                "ai_player_id": current_ai.get('id'),
                "ai_player_name": current_ai.get('name'),
                "word": ai_result.get('word'),
                "eliminations": ai_result.get('eliminations', []),
                "word_changed": word_changed,
                "game_over": game_over,
                "winner": game.get('winner'),
            })

        # POST /api/games/{code}/guess
        if '/guess' in path:
            # Rate limit: 30 guesses/min per IP
            if not check_rate_limit(get_ratelimit_guess(), client_ip):
                return self._send_error("Too many guesses. Please wait.", 429)
            
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game['status'] != 'playing':
                return self._send_error("Game not in progress", 400)
            
            # Check if game is paused waiting for word change
            if game.get('waiting_for_word_change'):
                waiting_player = next((p for p in game['players'] if p['id'] == game['waiting_for_word_change']), None)
                waiting_name = waiting_player['name'] if waiting_player else 'Someone'
                return self._send_error(f"Waiting for {waiting_name} to change their word", 400)
            
            player_id = sanitize_player_id(body.get('player_id', ''))
            if not player_id:
                return self._send_error("Invalid player ID format", 400)
            
            word = sanitize_word(body.get('word', ''))
            if not word:
                return self._send_error("Invalid word. Use only letters (2-30 chars)", 400)
            
            player = None
            player_idx = -1
            for i, p in enumerate(game['players']):
                if p['id'] == player_id:
                    player = p
                    player_idx = i
                    break
            
            if not player:
                return self._send_error("You are not in this game", 403)
            if not player['is_alive']:
                return self._send_error("You have been eliminated", 400)
            
            current_player = game['players'][game['current_turn']]
            if current_player['id'] != player_id:
                return self._send_error("It's not your turn", 400)
            
            if not is_valid_word(word):
                return self._send_error("Please enter a valid English word", 400)
            
            try:
                guess_embedding = get_embedding(word)
            except Exception as e:
                print(f"Embedding error for guess: {e}")  # Log server-side only
                return self._send_error("Word processing service unavailable. Please try again.", 503)
            
            similarities = {}
            for p in game['players']:
                sim = cosine_similarity(guess_embedding, p['secret_embedding'])
                similarities[p['id']] = round(sim, 2)
            
            # Eliminate players whose exact word was guessed
            eliminations = []
            for p in game['players']:
                if p['id'] != player_id and p['is_alive']:
                    if word.lower() == p['secret_word'].lower():
                        p['is_alive'] = False
                        eliminations.append(p['id'])
            
            if eliminations:
                player['can_change_word'] = True
                game['waiting_for_word_change'] = player_id  # Pause game until word is changed
            
            # Record history
            history_entry = {
                "guesser_id": player['id'],
                "guesser_name": player['name'],
                "word": word.lower(),
                "similarities": similarities,
                "eliminations": eliminations,
            }
            game['history'].append(history_entry)

            # If the player earned a word change, offer a random sample of allowed words (including their current
            # word only if it happens to be in the sample). Store on the player so it persists across refresh.
            if eliminations:
                try:
                    player['word_change_options'] = build_word_change_options(player, game)
                except Exception as e:
                    print(f"Error building word change options: {e}")
            
            # Update AI memories with this guess (for singleplayer games)
            if game.get('is_singleplayer'):
                for p in game['players']:
                    if p.get('is_ai'):
                        ai_update_memory(p, word, similarities, game)
            
            # Advance turn (but game is paused if waiting for word change)
            alive_players = [p for p in game['players'] if p['is_alive']]
            game_over = False
            
            if len(alive_players) <= 1:
                game['status'] = 'finished'
                game['waiting_for_word_change'] = None  # Clear pause
                game_over = True
                if alive_players:
                    game['winner'] = alive_players[0]['id']
                # Update leaderboard stats
                update_game_stats(game)
            else:
                num_players = len(game['players'])
                next_turn = (game['current_turn'] + 1) % num_players
                while not game['players'][next_turn]['is_alive']:
                    next_turn = (next_turn + 1) % num_players
                game['current_turn'] = next_turn
            
            save_game(code, game)
            
            response = {
                "similarities": similarities,
                "eliminations": eliminations,
                "game_over": game_over,
                "winner": game.get('winner'),
                "waiting_for_word_change": game.get('waiting_for_word_change'),
            }
            
            return self._send_json(response)

        # POST /api/games/{code}/change-word
        if '/change-word' in path:
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game['status'] != 'playing':
                return self._send_error("Game not in progress", 400)
            
            player_id = sanitize_player_id(body.get('player_id', ''))
            if not player_id:
                return self._send_error("Invalid player ID format", 400)
            
            new_word = sanitize_word(body.get('new_word', ''))
            if not new_word:
                return self._send_error("Invalid word. Use only letters (2-30 chars)", 400)
            
            player = None
            for p in game['players']:
                if p['id'] == player_id:
                    player = p
                    break
            
            if not player:
                return self._send_error("You are not in this game", 403)
            if not player.get('can_change_word', False):
                return self._send_error("You don't have a word change", 400)
            
            # Validate the word is a real English word
            if not is_valid_word(new_word):
                return self._send_error("Please enter a valid English word", 400)
            
            # Check if word is in this player's word pool
            player_pool = player.get('word_pool', [])
            if player_pool and new_word.lower() not in [w.lower() for w in player_pool]:
                return self._send_error("Please choose a word from your word pool", 400)

            # If we offered a random sample for this word change, enforce it.
            offered = player.get('word_change_options')
            if offered:
                offered_lower = [str(w).lower() for w in offered]
                if new_word.lower() not in offered_lower:
                    return self._send_error("Please choose a word from the offered sample", 400)
            
            # Check if word has been guessed before
            guessed_words = set()
            for entry in game.get('history', []):
                guessed_words.add(entry.get('word', '').lower())
            if new_word.lower() in guessed_words:
                return self._send_error("That word has already been guessed! Pick a different one.", 400)
            
            try:
                embedding = get_embedding(new_word)
            except Exception as e:
                print(f"Embedding error for change-word: {e}")  # Log server-side only
                return self._send_error("Word processing service unavailable. Please try again.", 503)
            
            player['secret_word'] = new_word.lower()
            player['secret_embedding'] = embedding
            player['can_change_word'] = False
            player.pop('word_change_options', None)
            
            # Clear the waiting state - game can continue
            game['waiting_for_word_change'] = None
            
            # Add a history entry noting the word change
            history_entry = {
                "type": "word_change",
                "player_id": player['id'],
                "player_name": player['name'],
            }
            game['history'].append(history_entry)
            
            save_game(code, game)
            return self._send_json({"status": "word_changed"})

        # POST /api/games/{code}/skip-word-change - Skip changing word
        if '/skip-word-change' in path:
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game['status'] != 'playing':
                return self._send_error("Game not in progress", 400)
            
            player_id = sanitize_player_id(body.get('player_id', ''))
            if not player_id:
                return self._send_error("Invalid player ID format", 400)
            
            player = None
            for p in game['players']:
                if p['id'] == player_id:
                    player = p
                    break
            
            if not player:
                return self._send_error("You are not in this game", 403)
            if not player.get('can_change_word', False):
                return self._send_error("You don't have a word change to skip", 400)

            # If we offered a random sample, allow keeping the current word only if it's in the sample.
            offered = player.get('word_change_options')
            if offered:
                current_word = (player.get('secret_word') or '').lower()
                offered_lower = [str(w).lower() for w in offered]
                if current_word not in offered_lower:
                    return self._send_error("You must pick a new word from the offered sample", 400)
            
            # Clear the ability and waiting state
            player['can_change_word'] = False
            game['waiting_for_word_change'] = None
            player.pop('word_change_options', None)

            # Record a word-change event even if the player keeps the same word, so it behaves like a re-encryption
            game['history'].append({
                "type": "word_change",
                "player_id": player['id'],
                "player_name": player['name'],
            })
            
            save_game(code, game)
            return self._send_json({"status": "skipped"})

        # POST /api/user/daily/claim - Claim a completed daily or weekly quest for credits
        if path == '/api/user/daily/claim':
            auth_header = self.headers.get('Authorization', '')
            if not auth_header.startswith('Bearer '):
                return self._send_error("Not authenticated", 401)

            token = auth_header[7:]
            payload = verify_jwt_token(token)
            if not payload:
                return self._send_error("Invalid or expired token", 401)

            quest_id = body.get('quest_id', '')
            if not isinstance(quest_id, str) or not quest_id.strip():
                return self._send_error("quest_id required", 400)
            quest_id = quest_id.strip()
            
            quest_type = body.get('quest_type', 'daily')
            if quest_type not in ('daily', 'weekly'):
                quest_type = 'daily'

            # Admin user: store economy separately
            if payload.get('sub') == 'admin_local':
                redis = get_redis()
                admin_user = load_admin_economy_user(redis)
                
                if quest_type == 'weekly':
                    weekly_quests = ensure_weekly_quests(admin_user, persist=False)
                    quests = weekly_quests
                else:
                    daily_state = ensure_daily_quests_today(admin_user, persist=False)
                    quests = daily_state.get('quests', [])
                
                if not isinstance(quests, list):
                    quests = []

                quest = next((q for q in quests if isinstance(q, dict) and q.get('id') == quest_id), None)
                if not quest:
                    return self._send_error("Quest not found", 404)

                try:
                    progress = int(quest.get('progress', 0) or 0)
                    target = int(quest.get('target', 0) or 0)
                    reward = int(quest.get('reward_credits', 0) or 0)
                except Exception:
                    progress, target, reward = 0, 0, 0

                if target <= 0 or progress < target:
                    return self._send_error("Quest not completed yet", 400)
                if bool(quest.get('claimed', False)):
                    return self._send_error("Quest already claimed", 400)

                quest['claimed'] = True
                add_user_credits(admin_user, reward, persist=False)
                
                if quest_type == 'weekly':
                    admin_user['weekly_quests'] = {"week_start": get_week_start_str(), "quests": quests}
                else:
                    admin_user['daily_quests'] = daily_state
                    
                save_admin_economy_user(redis, admin_user)
                econ = ensure_user_economy(admin_user, persist=False)
                return self._send_json({
                    "status": "claimed",
                    "reward_credits": reward,
                    "wallet": econ.get("wallet") or {"credits": 0},
                })

            user = get_user_by_id(payload.get('sub', ''))
            if not user:
                return self._send_error("User not found", 404)

            ensure_user_economy(user, persist=False)
            
            if quest_type == 'weekly':
                weekly_quests = ensure_weekly_quests(user, persist=False)
                quests = weekly_quests
            else:
                daily_state = ensure_daily_quests_today(user, persist=False)
                quests = daily_state.get('quests', [])
            
            if not isinstance(quests, list):
                quests = []

            quest = next((q for q in quests if isinstance(q, dict) and q.get('id') == quest_id), None)
            if not quest:
                return self._send_error("Quest not found", 404)

            try:
                progress = int(quest.get('progress', 0) or 0)
                target = int(quest.get('target', 0) or 0)
                reward = int(quest.get('reward_credits', 0) or 0)
            except Exception:
                progress, target, reward = 0, 0, 0

            if target <= 0 or progress < target:
                return self._send_error("Quest not completed yet", 400)
            if bool(quest.get('claimed', False)):
                return self._send_error("Quest already claimed", 400)

            quest['claimed'] = True
            add_user_credits(user, reward, persist=False)
            
            if quest_type == 'weekly':
                user['weekly_quests'] = {"week_start": get_week_start_str(), "quests": quests}
            else:
                user['daily_quests'] = daily_state
                
            save_user(user)
            econ = ensure_user_economy(user, persist=False)
            return self._send_json({
                "status": "claimed",
                "reward_credits": reward,
                "wallet": econ.get("wallet") or {"credits": 0},
            })

        # POST /api/shop/purchase - Purchase a cosmetic with credits (shop exclusives)
        if path == '/api/shop/purchase':
            auth_header = self.headers.get('Authorization', '')
            if not auth_header.startswith('Bearer '):
                return self._send_error("Not authenticated", 401)

            token = auth_header[7:]
            payload = verify_jwt_token(token)
            if not payload:
                return self._send_error("Invalid or expired token", 401)

            category = body.get('category', '')
            cosmetic_id = body.get('cosmetic_id', '')
            if not isinstance(category, str) or not isinstance(cosmetic_id, str):
                return self._send_error("category and cosmetic_id required", 400)
            category = category.strip()
            cosmetic_id = cosmetic_id.strip()
            if not category or not cosmetic_id:
                return self._send_error("category and cosmetic_id required", 400)

            catalog_key = COSMETIC_CATEGORY_TO_CATALOG_KEY.get(category)
            if not catalog_key:
                return self._send_error("Invalid category", 400)

            item = get_cosmetic_item(catalog_key, cosmetic_id)
            if not item:
                return self._send_error("Invalid cosmetic", 400)

            # Shop does not sell premium cosmetics (donation-only)
            if bool(item.get('premium', False)):
                return self._send_error("Premium cosmetics cannot be purchased with credits", 403)

            try:
                price = int(item.get('price', 0) or 0)
            except Exception:
                price = 0
            if price <= 0:
                return self._send_error("This item is not for sale", 400)

            # Admin user: store economy separately
            if payload.get('sub') == 'admin_local':
                redis = get_redis()
                admin_user = load_admin_economy_user(redis)

                if user_owns_cosmetic(admin_user, category, cosmetic_id):
                    econ = ensure_user_economy(admin_user, persist=False)
                    return self._send_json({
                        "status": "already_owned",
                        "wallet": econ.get("wallet") or {"credits": 0},
                        "owned_cosmetics": econ.get("owned_cosmetics") or {},
                    })

                credits = get_user_credits(admin_user)
                if credits < price:
                    return self._send_error("Not enough credits", 403)

                add_user_credits(admin_user, -price, persist=False)
                grant_owned_cosmetic(admin_user, category, cosmetic_id, persist=False)
                save_admin_economy_user(redis, admin_user)
                econ = ensure_user_economy(admin_user, persist=False)
                return self._send_json({
                    "status": "purchased",
                    "wallet": econ.get("wallet") or {"credits": 0},
                    "owned_cosmetics": econ.get("owned_cosmetics") or {},
                })

            user = get_user_by_id(payload.get('sub', ''))
            if not user:
                return self._send_error("User not found", 404)

            ensure_user_economy(user, persist=False)

            if user_owns_cosmetic(user, category, cosmetic_id):
                econ = ensure_user_economy(user, persist=False)
                return self._send_json({
                    "status": "already_owned",
                    "wallet": econ.get("wallet") or {"credits": 0},
                    "owned_cosmetics": econ.get("owned_cosmetics") or {},
                })

            credits = get_user_credits(user)
            if credits < price:
                return self._send_error("Not enough credits", 403)

            add_user_credits(user, -price, persist=False)
            grant_owned_cosmetic(user, category, cosmetic_id, persist=False)
            save_user(user)
            econ = ensure_user_economy(user, persist=False)
            return self._send_json({
                "status": "purchased",
                "wallet": econ.get("wallet") or {"credits": 0},
                "owned_cosmetics": econ.get("owned_cosmetics") or {},
            })

        # POST /api/cosmetics/equip - Equip a cosmetic
        if path == '/api/cosmetics/equip':
            auth_header = self.headers.get('Authorization', '')
            if not auth_header.startswith('Bearer '):
                return self._send_error("Not authenticated", 401)
            
            token = auth_header[7:]
            payload = verify_jwt_token(token)
            
            if not payload:
                return self._send_error("Invalid or expired token", 401)
            
            category = body.get('category', '')
            cosmetic_id = body.get('cosmetic_id', '')
            
            if not category or not cosmetic_id:
                return self._send_error("Category and cosmetic_id required", 400)

            # Map category names to cosmetics keys
            category_map = {
                'card_border': 'card_borders',
                'card_background': 'card_backgrounds',
                'name_color': 'name_colors',
                'badge': 'badges',
                'elimination_effect': 'elimination_effects',
                'guess_effect': 'guess_effects',
                'turn_indicator': 'turn_indicators',
                'victory_effect': 'victory_effects',
                'matrix_color': 'matrix_colors',
                'particle_overlay': 'particle_overlays',
                'seasonal_theme': 'seasonal_themes',
                'alt_background': 'alt_backgrounds',
            }
            
            catalog_key = category_map.get(category)
            if not catalog_key:
                return self._send_error("Invalid category", 400)
            
            item = get_cosmetic_item(catalog_key, cosmetic_id)
            if not item:
                return self._send_error("Invalid cosmetic", 400)
            
            # Handle admin user specially - store cosmetics in Redis with short expiry
            if payload['sub'] == 'admin_local':
                redis = get_redis()
                admin_cosmetics_key = 'admin_cosmetics'
                
                # Get existing admin cosmetics or start fresh
                existing = redis.get(admin_cosmetics_key)
                if existing:
                    admin_cosmetics = json.loads(existing)
                else:
                    admin_cosmetics = DEFAULT_COSMETICS.copy()
                
                # Update the selected category
                admin_cosmetics[category] = cosmetic_id
                
                # Save with 1 hour expiry
                redis.set(admin_cosmetics_key, json.dumps(admin_cosmetics), ex=3600)
                
                return self._send_json({
                    "status": "equipped",
                    "cosmetics": admin_cosmetics,
                })
            
            user = get_user_by_id(payload['sub'])
            if not user:
                return self._send_error("User not found", 404)
            
            if not category or not cosmetic_id:
                return self._send_error("Category and cosmetic_id required", 400)
            
            is_donor = user.get('is_donor', False)
            is_admin = user.get('is_admin', False)

            # Premium gating (feature-flagged)
            if COSMETICS_PAYWALL_ENABLED and not COSMETICS_UNLOCK_ALL and item.get('premium', False) and not is_donor and not is_admin:
                return self._send_error("Donate to unlock premium cosmetics!", 403)
            
            # Progression gating (always on): requirements are multiplayer-only stats (mp_*)
            if not (is_admin or COSMETICS_UNLOCK_ALL):
                unmet = get_unmet_cosmetic_requirement(item, get_user_stats(user))
                if unmet:
                    label = COSMETIC_REQUIREMENT_LABELS.get(unmet['metric'], unmet['metric'])
                    return self._send_error(
                        f"Locked: requires {unmet['min']} {label} ({unmet['have']}/{unmet['min']})",
                        403,
                    )

            # Shop ownership gating: priced cosmetics must be purchased before equipping
            if not (is_admin or COSMETICS_UNLOCK_ALL):
                try:
                    price = int(item.get('price', 0) or 0)
                except Exception:
                    price = 0
                if price > 0 and not user_owns_cosmetic(user, category, cosmetic_id):
                    return self._send_error(f"Locked: purchase in Shop ({price} credits)", 403)
            
            # Update user's cosmetics
            if 'cosmetics' not in user:
                user['cosmetics'] = DEFAULT_COSMETICS.copy()
            user['cosmetics'][category] = cosmetic_id
            
            save_user(user)
            return self._send_json({
                "status": "equipped",
                "cosmetics": get_user_cosmetics(user),
            })

        # POST /api/webhooks/kofi - Handle Ko-fi donation webhooks
        if path == '/api/webhooks/kofi':
            # Ko-fi sends data as form-urlencoded with a 'data' field containing JSON
            try:
                # The body should contain a 'data' field with JSON
                kofi_data = body.get('data')
                if isinstance(kofi_data, str):
                    kofi_data = json.loads(kofi_data)
                elif not kofi_data:
                    kofi_data = body  # Fallback to direct body
                
                # Verify the webhook token if configured
                if KOFI_VERIFICATION_TOKEN:
                    received_token = kofi_data.get('verification_token', '')
                    if received_token != KOFI_VERIFICATION_TOKEN:
                        print(f"Ko-fi webhook: Invalid verification token")
                        return self._send_error("Invalid verification token", 403)
                
                # Get donor email
                donor_email = kofi_data.get('email', '').lower().strip()
                if not donor_email:
                    print(f"Ko-fi webhook: No email provided")
                    return self._send_json({"status": "ok", "message": "No email to process"})
                
                # Look up user by email
                user = get_user_by_email(donor_email)
                if not user:
                    # Store pending donation for when user signs up
                    redis = get_redis()
                    redis.set(f"pending_donation:{donor_email}", json.dumps({
                        'amount': kofi_data.get('amount', '0'),
                        'timestamp': int(time.time()),
                        'message': kofi_data.get('message', ''),
                    }))
                    print(f"Ko-fi webhook: Stored pending donation for {donor_email}")
                    return self._send_json({"status": "ok", "message": "Pending donation stored"})
                
                # Mark user as donor
                user['is_donor'] = True
                user['donation_date'] = int(time.time())
                user['donation_amount'] = kofi_data.get('amount', '0')
                save_user(user)
                
                print(f"Ko-fi webhook: Marked {donor_email} as donor")
                return self._send_json({"status": "ok", "message": "Donor status updated"})
                
            except Exception as e:
                print(f"Ko-fi webhook error: {e}")
                return self._send_error("Webhook processing failed", 500)

        self._send_error("Not found", 404)
