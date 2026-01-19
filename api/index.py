"""Vercel serverless function for Embeddle API with Upstash Redis storage."""

import json
import hashlib
import hmac
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

# Import security modules with graceful fallback
# These provide enhanced security features but the app can run without them
_SECURITY_MODULES_AVAILABLE = False
try:
    from security.rate_limiter import (
        RateLimitConfig,
        check_rate_limit_strict,
        check_embedding_rate_limit,
        get_combined_identifier,
        RateLimitResult,
    )
    from security.validators import (
        validate_request_body_size,
        get_request_size_limit,
        REQUEST_SIZE_LIMITS,
    )
    from security.auth import (
        constant_time_compare,
        generate_oauth_state,
        revoke_token as revoke_jwt_token,
        is_token_revoked,
    )
    from security.monitoring import (
        SecurityEventType,
        log_security_event,
        log_auth_success,
        log_auth_failure,
        log_rate_limit_hit,
        log_rate_limit_blocked,
        log_webhook_event,
        log_admin_action,
        log_suspicious_input,
    )
    from security.env_validator import validate_required_env_vars, print_env_status
    _SECURITY_MODULES_AVAILABLE = True
except ImportError as e:
    print(f"[SECURITY] Security modules not available: {e}")
    # Provide fallback implementations
    def constant_time_compare(a: str, b: str) -> bool:
        return hmac.compare_digest(a.encode(), b.encode())
    
    def is_token_revoked(jti: str) -> bool:
        return False
    
    def revoke_jwt_token(jti: str, ttl: int = None) -> bool:
        return False
    
    def log_security_event(*args, **kwargs):
        pass
    
    def log_auth_success(*args, **kwargs):
        pass
    
    def log_auth_failure(*args, **kwargs):
        pass
    
    def log_rate_limit_hit(*args, **kwargs):
        pass
    
    def log_rate_limit_blocked(*args, **kwargs):
        pass
    
    def log_webhook_event(*args, **kwargs):
        pass
    
    def log_admin_action(*args, **kwargs):
        pass
    
    def log_suspicious_input(*args, **kwargs):
        pass
    
    def check_rate_limit_secure(*args, **kwargs):
        return True


# ============== INPUT VALIDATION ==============

# Validation patterns
GAME_CODE_PATTERN = re.compile(r'^[A-Z0-9]{6}$')
PLAYER_ID_PATTERN = re.compile(r'^[a-f0-9]{32}$')  # 128 bits (32 hex chars) for better entropy
PLAYER_NAME_PATTERN = re.compile(r'^[a-zA-Z0-9_ ]{1,20}$')
WORD_PATTERN = re.compile(r'^[a-zA-Z]{2,30}$')
# AI player IDs: ai_{difficulty}_{8-char-hex} - e.g., ai_rookie_a1b2c3d4
AI_PLAYER_ID_PATTERN = re.compile(r'^ai_[a-z0-9-]+_[a-f0-9]{8}$')


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


def sanitize_ai_player_id(player_id: str) -> Optional[str]:
    """Validate AI player ID format. Returns None if invalid."""
    if not player_id:
        return None
    player_id = player_id.lower().strip()
    if not AI_PLAYER_ID_PATTERN.match(player_id):
        return None
    return player_id


def sanitize_player_name(name: str) -> Optional[str]:
    """Sanitize player name. Returns None if invalid."""
    if not name:
        return None
    name = name.strip()
    if not PLAYER_NAME_PATTERN.match(name):
        return None
    # Block reserved name "admin"
    if name.lower() == 'admin':
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


# ============== USERNAME VALIDATION ==============

# Username pattern: 3-20 characters, alphanumeric, underscores, hyphens
USERNAME_PATTERN = re.compile(r'^[a-zA-Z0-9_-]{3,20}$')

# Reserved usernames that cannot be used
RESERVED_USERNAMES = {
    'admin', 'administrator', 'system', 'embeddle', 'mod', 'moderator',
    'support', 'help', 'bot', 'official', 'staff', 'dev', 'developer',
    'anonymous', 'guest', 'null', 'undefined', 'api', 'root', 'user'
}

# Load profanity list
def _load_profanity_list() -> set:
    """Load profanity words from profanity.json."""
    try:
        profanity_path = Path(__file__).parent / "profanity.json"
        if profanity_path.exists():
            with open(profanity_path) as f:
                words = json.load(f)
                return {w.lower() for w in words if isinstance(w, str)}
    except Exception as e:
        print(f"[WARNING] Failed to load profanity list: {e}")
    return set()

PROFANITY_LIST = _load_profanity_list()


def contains_profanity(text: str) -> bool:
    """Check if text contains any profanity words (as substrings)."""
    if not text:
        return False
    text_lower = text.lower()
    for word in PROFANITY_LIST:
        if word in text_lower:
            return True
    return False


def validate_username(username: str) -> tuple[bool, str]:
    """
    Validate a username.
    
    Returns:
        (is_valid, error_message) - error_message is empty if valid
    """
    if not username:
        return False, "Username is required"
    
    username = username.strip()
    
    # Check length
    if len(username) < 3:
        return False, "Username must be at least 3 characters"
    if len(username) > 20:
        return False, "Username must be at most 20 characters"
    
    # Check pattern (alphanumeric, underscores, hyphens)
    if not USERNAME_PATTERN.match(username):
        return False, "Username can only contain letters, numbers, underscores, and hyphens"
    
    # Check reserved words
    if username.lower() in RESERVED_USERNAMES:
        return False, "This username is reserved"
    
    # Check profanity
    if contains_profanity(username):
        return False, "Username contains inappropriate language"
    
    return True, ""


def is_username_available(username: str) -> bool:
    """Check if a username is available (not taken by another user)."""
    redis = get_redis()
    if not redis:
        return False
    try:
        existing = redis.get(f"username:{username.lower()}")
        return existing is None
    except Exception:
        return False


def reserve_username(username: str, user_id: str) -> bool:
    """Reserve a username for a user. Returns True if successful."""
    redis = get_redis()
    if not redis:
        return False
    try:
        # Use SETNX to atomically check and set (only if not exists)
        key = f"username:{username.lower()}"
        result = redis.setnx(key, user_id)
        return bool(result)
    except Exception as e:
        print(f"[ERROR] Failed to reserve username: {e}")
        return False


def release_username(username: str, user_id: str) -> bool:
    """Release a username reservation. Only releases if owned by user_id."""
    redis = get_redis()
    if not redis:
        return False
    try:
        key = f"username:{username.lower()}"
        current_owner = redis.get(key)
        if current_owner == user_id:
            redis.delete(key)
            return True
        return False
    except Exception:
        return False


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
WORD_CHANGE_SAMPLE_SIZE = CONFIG.get("game", {}).get("word_change_sample_size", 10)
WORDS_PER_PLAYER = int((CONFIG.get("game", {}) or {}).get("words_per_player", 18) or 18)
WORDS_PER_PLAYER = max(1, min(50, WORDS_PER_PLAYER))

# Presence settings (spectator counts, etc.)
PRESENCE_TTL_SECONDS = int((CONFIG.get("presence", {}) or {}).get("ttl_seconds", 15) or 15)

# Ranked settings (ELO/MMR)
RANKED_INITIAL_MMR = int((CONFIG.get("ranked", {}) or {}).get("initial_mmr", 1000) or 1000)
RANKED_K_FACTOR = float((CONFIG.get("ranked", {}) or {}).get("k_factor", 30) or 30)
RANKED_PLACEMENT_K_FACTOR = float((CONFIG.get("ranked", {}) or {}).get("placement_k_factor", 200) or 200)
RANKED_PLACEMENT_GAMES = int((CONFIG.get("ranked", {}) or {}).get("placement_games", 5) or 5)
RANKED_PROVISIONAL_GAMES = int((CONFIG.get("ranked", {}) or {}).get("provisional_games", 20) or 20)
RANKED_PROVISIONAL_K_FACTOR = float((CONFIG.get("ranked", {}) or {}).get("provisional_k_factor", 100) or 100)
# K-factor decay: K decays over time but never below this minimum
RANKED_K_FACTOR_MIN = float((CONFIG.get("ranked", {}) or {}).get("k_factor_min", 16) or 16)
# Decay rate: how much K decreases per game after provisional period
RANKED_K_FACTOR_DECAY_RATE = float((CONFIG.get("ranked", {}) or {}).get("k_factor_decay_rate", 0.5) or 0.5)
# Participation bonus: small flat MMR bonus per game to make elo slightly positive-sum
# This prevents rating deflation and rewards active play
RANKED_PARTICIPATION_BONUS = float((CONFIG.get("ranked", {}) or {}).get("participation_bonus", 4.0) or 4.0)

# Time control settings (chess clock model)
TIME_CONTROLS_CONFIG = CONFIG.get("time_controls", {})
RANKED_TIME_CONTROL = TIME_CONTROLS_CONFIG.get("ranked", {"initial_time": 180, "increment": 5})
QUICKPLAY_TIME_CONTROL = {"initial_time": 300, "increment": 5}  # 5 min + 5s for quick play
CASUAL_TIME_PRESETS = TIME_CONTROLS_CONFIG.get("casual_presets", {
    "bullet": {"initial_time": 60, "increment": 5},
    "blitz": {"initial_time": 120, "increment": 10},
    "rapid": {"initial_time": 300, "increment": 15},
    "classical": {"initial_time": 600, "increment": 30},
    "none": {"initial_time": 0, "increment": 0},
})

# Word selection time limits
WORD_SELECTION_TIME_CONFIG = TIME_CONTROLS_CONFIG.get("word_selection_time", {"ranked": 30, "casual": 60})
WORD_SELECTION_TIME_RANKED = int(WORD_SELECTION_TIME_CONFIG.get("ranked", 30))
WORD_SELECTION_TIME_CASUAL = int(WORD_SELECTION_TIME_CONFIG.get("casual", 60))

def get_word_selection_time(is_ranked: bool) -> int:
    """Get word selection time limit in seconds."""
    return WORD_SELECTION_TIME_RANKED if is_ranked else WORD_SELECTION_TIME_CASUAL

def get_time_control(is_ranked: bool, preset: str = "rapid", is_quickplay: bool = False) -> dict:
    """Get time control settings for a game (chess clock model)."""
    if is_ranked:
        return {
            "initial_time": int(RANKED_TIME_CONTROL.get("initial_time", 180)),
            "increment": int(RANKED_TIME_CONTROL.get("increment", 5)),
        }
    if is_quickplay:
        return {
            "initial_time": int(QUICKPLAY_TIME_CONTROL.get("initial_time", 300)),
            "increment": int(QUICKPLAY_TIME_CONTROL.get("increment", 5)),
        }
    # Private lobbies use presets
    preset_config = CASUAL_TIME_PRESETS.get(preset, CASUAL_TIME_PRESETS.get("rapid", {}))
    return {
        "initial_time": int(preset_config.get("initial_time", 300)),
        "increment": int(preset_config.get("increment", 15)),
    }

# Embedding settings
EMBEDDING_MODEL = CONFIG.get("embedding", {}).get("model", "text-embedding-3-small")
EMBEDDING_CACHE_SECONDS = CONFIG.get("embedding", {}).get("cache_expiry_seconds", 86400)

# Load pre-generated themes from individual JSON files in api/themes/ directory
def load_themes():
    """Load all themes from api/themes/ directory."""
    themes_dir = Path(__file__).parent / "themes"
    registry_path = themes_dir / "theme_registry.json"
    
    themes = {}
    
    # Load from registry if it exists
    if registry_path.exists():
        try:
            with open(registry_path) as f:
                registry = json.load(f)
            for entry in registry.get("themes", []):
                theme_file = themes_dir / entry.get("file", "")
                if theme_file.exists():
                    try:
                        with open(theme_file) as f:
                            theme_data = json.load(f)
                        theme_name = theme_data.get("name", entry.get("name", ""))
                        if theme_name and theme_data.get("words"):
                            themes[theme_name] = theme_data["words"]
                    except Exception as e:
                        print(f"Error loading theme file {theme_file}: {e}")
        except Exception as e:
            print(f"Error loading theme registry: {e}")
    
    # Fallback: load from legacy themes.json if themes/ directory is empty
    if not themes:
        legacy_path = Path(__file__).parent / "themes.json"
        if legacy_path.exists():
            try:
                with open(legacy_path) as f:
                    themes = json.load(f)
            except Exception as e:
                print(f"Error loading legacy themes.json: {e}")
    
    return themes


PREGENERATED_THEMES = load_themes()
# THEME_CATEGORIES contains all available themes (no rotation)
THEME_CATEGORIES = list(PREGENERATED_THEMES.keys()) if PREGENERATED_THEMES else CONFIG.get("theme_categories", [])

# Backwards-compatible theme aliases:
# Old lobbies can have theme names persisted in Redis that no longer exist in api/themes.json.
# Map them to the closest current theme so /start doesn't fail with an empty word list.
THEME_ALIASES = {}

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
# SECURITY: Explicit opt-out for development only - requires setting env var to skip verification
KOFI_SKIP_VERIFICATION = env_bool('KOFI_SKIP_VERIFICATION', False)

# Default cosmetics for new users
DEFAULT_COSMETICS = {
    "card_border": "classic",
    "name_color": "default",
    "badge": "none",
    "victory_effect": "classic",
    "profile_title": "none",
    "profile_avatar": "default",
}

# Cosmetics schema version for stored user cosmetics payload.
COSMETICS_SCHEMA_VERSION = 3

# Map category keys stored on users -> catalog keys in api/cosmetics.json
COSMETIC_CATEGORY_TO_CATALOG_KEY = {
    'card_border': 'card_borders',
    'name_color': 'name_colors',
    'badge': 'badges',
    'victory_effect': 'victory_effects',
    'profile_title': 'profile_titles',
    'profile_avatar': 'profile_avatars',
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

# ============== AI PLAYER CONFIGURATION ==============

# AI Personality types - each affects playstyle
AI_PERSONALITY_TYPES = ["aggressive", "cautious", "chaotic", "methodical", "opportunist"]

# Personality modifiers (applied on top of difficulty settings)
AI_PERSONALITY_CONFIG = {
    "aggressive": {
        "description": "Targets leaders, takes risks",
        "targeting_boost": 0.15,           # More likely to target
        "self_leak_tolerance": 0.05,       # Willing to leak more
        "target_preference": "leader",     # Prefers players doing well
        "random_chance_mod": -0.1,         # Less random guessing
        "think_time_mod": 0.8,             # Thinks faster (impatient)
    },
    "cautious": {
        "description": "Defensive, avoids self-leak",
        "targeting_boost": -0.1,           # Less aggressive targeting
        "self_leak_tolerance": -0.08,      # Very careful about leaking
        "target_preference": "safe",       # Targets already-exposed players
        "random_chance_mod": 0.05,         # Slightly more random (safer)
        "think_time_mod": 1.3,             # Thinks longer (careful)
    },
    "chaotic": {
        "description": "Unpredictable, random streaks",
        "targeting_boost": 0.0,
        "self_leak_tolerance": 0.02,
        "target_preference": "random",     # Random target selection
        "random_chance_mod": 0.2,          # Much more random
        "think_time_mod": 0.7,             # Quick decisions
    },
    "methodical": {
        "description": "Systematic elimination",
        "targeting_boost": 0.05,
        "self_leak_tolerance": -0.03,
        "target_preference": "weakest",    # Focuses on nearly-eliminated players
        "random_chance_mod": -0.05,        # Slightly less random
        "think_time_mod": 1.1,             # Deliberate pace
    },
    "opportunist": {
        "description": "Exploits weak players",
        "targeting_boost": 0.1,
        "self_leak_tolerance": 0.0,
        "target_preference": "vulnerable", # Targets high-danger players
        "random_chance_mod": -0.08,
        "think_time_mod": 0.95,
    },
}

# AI Timing configuration - fast response times for snappy gameplay
AI_TIMING_CONFIG = {
    "rookie": {
        "base_think_ms": (50, 150),          # Fast response
        "strategic_think_ms": (80, 200),     # Slightly longer for decisions
        "hesitation_chance": 0.1,            # Rare hesitation
        "hesitation_ms": (20, 50),           # Brief pause
    },
    "analyst": {
        "base_think_ms": (40, 120),
        "strategic_think_ms": (60, 180),
        "hesitation_chance": 0.08,
        "hesitation_ms": (15, 40),
    },
    "field-agent": {
        "base_think_ms": (30, 100),
        "strategic_think_ms": (50, 150),
        "hesitation_chance": 0.05,
        "hesitation_ms": (10, 30),
    },
    "spymaster": {
        "base_think_ms": (25, 80),
        "strategic_think_ms": (40, 120),
        "hesitation_chance": 0.03,
        "hesitation_ms": (8, 25),
    },
    "ghost": {
        "base_think_ms": (20, 60),           # Very quick
        "strategic_think_ms": (30, 100),
        "hesitation_chance": 0.01,
        "hesitation_ms": (5, 20),
    },
}

# AI Mistake configuration - makes AIs feel more human
AI_MISTAKE_CONFIG = {
    "rookie": {
        "miss_obvious_target": 0.25,        # Fails to follow up on good clues
        "overconfident_guess": 0.20,        # Guesses too-similar words (self-leak)
        "repeat_bad_strategy": 0.15,        # Keeps targeting wrong player
        "panic_mistake": 0.40,              # Makes bad choices under pressure
        "forget_clue": 0.20,                # Ignores recent high-similarity info
    },
    "analyst": {
        "miss_obvious_target": 0.15,
        "overconfident_guess": 0.12,
        "repeat_bad_strategy": 0.10,
        "panic_mistake": 0.25,
        "forget_clue": 0.12,
    },
    "field-agent": {
        "miss_obvious_target": 0.10,
        "overconfident_guess": 0.10,
        "repeat_bad_strategy": 0.08,
        "panic_mistake": 0.18,
        "forget_clue": 0.08,
    },
    "spymaster": {
        "miss_obvious_target": 0.05,
        "overconfident_guess": 0.08,
        "repeat_bad_strategy": 0.04,
        "panic_mistake": 0.12,
        "forget_clue": 0.05,
    },
    "ghost": {
        "miss_obvious_target": 0.03,
        "overconfident_guess": 0.06,
        "repeat_bad_strategy": 0.02,
        "panic_mistake": 0.08,
        "forget_clue": 0.02,
    },
}

# AI Chat messages for different situations
AI_CHAT_MESSAGES = {
    "near_miss": [
        "So close!", "Hmm interesting...", "👀", "Getting warmer...",
        "Ooh that was close", "Almost!", "🤔", "Noted...",
    ],
    "got_eliminated": [
        "GG", "Well played!", "😅", "You got me", "Nice one",
        "Ouch", "Fair enough", "👏", "I knew it...",
    ],
    "eliminated_someone": [
        "Got you!", "Sorry not sorry", "💀", "Gotcha!",
        "Too easy", "😎", "Bye bye", "Called it",
    ],
    "panic_mode": [
        "😰", "This is fine...", "Uh oh", "🙈",
        "Getting hot in here", "Sweating a bit", "",  # Sometimes silent
    ],
    "good_guess": [
        "Nice guess!", "Good one", "👍", "Clever",
        "Didn't see that coming", "Ooh smart", "",
    ],
    "game_start": [
        "Good luck everyone!", "Let's go!", "Ready!", "🎯",
        "May the best spy win", "Bring it on", "",
    ],
    "thinking": [
        "Hmm...", "Let me think...", "🤔", "Interesting...",
        "", "", "",  # Often silent while thinking
    ],
}

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
        "panic_danger": "critical",      # rookie basically doesn't "panic"
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
    "nemesis": {
        "name_prefix": "Nemesis",
        "strategic_chance": 1.0,            # ALWAYS strategic, never random
        "word_selection": "isolated",        # Semantic isolation strategy
        "targeting_strength": 0.95,          # Near-perfect targeting
        "min_target_similarity": 0.35,       # Acts on weaker signals
        "delay_range": (4, 8),               # Deliberate pacing
        "badge": "🤖",
        "self_leak_soft_max": 0.65,          # Very strict leak avoidance
        "self_leak_hard_max": 0.80,          # Hard cutoff lower
        "panic_danger": "safe",              # Never panics (always calculated)
        "panic_aggression_boost": 0.0,       # No emotional response
        "candidate_pool": 15,                # Reduced for speed (was 30)
        "clue_words_per_target": 5,          # Uses more intel
        "makes_mistakes": False,             # No human-like errors
        "has_personality": False,            # No personality modifiers
        "uses_bluffing": False,              # No deception (pure optimization)
        "word_change_threshold": 0.55,       # Changes word at lower danger
        "always_change_on_elimination": True,
        "tracks_opponent_patterns": True,
        "uses_information_gain": True,
    },
}

# AI name suffixes for variety
AI_NAME_SUFFIXES = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta"]


def generate_ai_player_id(difficulty: str) -> str:
    """Generate a unique AI player ID."""
    return f"ai_{difficulty}_{secrets.token_hex(4)}"


def create_ai_player(difficulty: str, existing_names: list) -> dict:
    """Create an AI player with the specified difficulty and random personality."""
    import random
    
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
    
    # Assign a random personality (Nemesis has no personality)
    if config.get("has_personality") is False or difficulty == "nemesis":
        personality = None
    else:
        personality = random.choice(AI_PERSONALITY_TYPES)
    
    # Give different difficulties distinct "agent" vibes in the UI
    ai_cosmetics_by_difficulty = {
        "rookie": {"card_border": "classic", "name_color": "default", "badge": "none"},
        "analyst": {"card_border": "classic", "name_color": "cyan", "badge": "star"},
        "field-agent": {"card_border": "neon_glow", "name_color": "fire", "badge": "hunter"},
        "spymaster": {"card_border": "gold_elite", "name_color": "gold", "badge": "rank_gold"},
        "ghost": {"card_border": "fire", "name_color": "cyan", "badge": "hunter"},
        "nemesis": {"card_border": "void_pulse", "name_color": "void_text", "badge": "dragon"},
    }
    selected_cosmetics = ai_cosmetics_by_difficulty.get(difficulty, ai_cosmetics_by_difficulty["rookie"])

    return {
        "id": generate_ai_player_id(difficulty),
        "name": name,
        "difficulty": difficulty,
        "personality": personality,
        "is_ai": True,
        "secret_word": None,
        "secret_embedding": None,
        "is_alive": True,
        "can_change_word": False,
        "word_pool": [],
        "is_ready": True,  # AI is always ready
        "cosmetics": {
            "card_border": selected_cosmetics["card_border"],
            "name_color": selected_cosmetics["name_color"],
            "badge": selected_cosmetics.get("badge", config["badge"]),
        },
        "ai_memory": {
            "high_similarity_targets": {},  # player_id -> [(word, similarity)]
            "guessed_words": [],
            "grudges": {},                   # player_id -> grudge_strength (0-1)
            "streak": 0,                     # positive = hot streak, negative = cold streak
            "last_guess_quality": None,      # "good", "bad", "neutral"
            "adaptation_notes": {},          # player_id -> observed patterns
        },
        "ai_state": {
            "is_panicking": False,
            "confidence": 0.5,               # 0-1, affects decision making
            "last_think_time_ms": 0,
            "pending_chat": None,            # Message to send after turn
        },
    }


# ============== NEMESIS AI FUNCTIONS ==============

def _ai_select_isolated_word(word_pool: list) -> str:
    """
    Nemesis word selection: pick the most semantically isolated word.
    
    This finds words that are "semantic islands" - they have low average similarity
    to other words in the pool, making them hard to triangulate.
    
    Score = -avg_similarity - 0.5 * max_similarity (lower is better)
    
    Uses pre-computed theme similarity matrix when available for O(1) lookups.
    """
    import random
    
    if not word_pool or len(word_pool) == 1:
        return word_pool[0] if word_pool else None
    
    try:
        # Fast path: use pre-computed similarity matrix if available
        similarity_matrix = game.get('theme_similarity_matrix') if game else None
        if similarity_matrix:
            isolation_scores = []
            for word in word_pool:
                word_lower = word.lower()
                word_sims = similarity_matrix.get(word_lower, {})
                if not word_sims:
                    continue
                
                similarities = []
                for other_word in word_pool:
                    if other_word.lower() == word_lower:
                        continue
                    sim = word_sims.get(other_word.lower(), 0.5)
                    similarities.append(sim)
                
                if similarities:
                    avg_sim = sum(similarities) / len(similarities)
                    max_sim = max(similarities)
                    isolation_score = avg_sim + 0.5 * max_sim
                    isolation_scores.append((word, isolation_score))
            
            if isolation_scores:
                isolation_scores.sort(key=lambda x: x[1])
                top_isolated = isolation_scores[:min(3, len(isolation_scores))]
                return random.choice(top_isolated)[0]
        
        # Fallback: use cached embeddings from Redis
        embeddings = {}
        for word in word_pool:
            try:
                embeddings[word] = get_embedding(word)
            except Exception:
                continue
        
        if len(embeddings) < 2:
            return random.choice(word_pool)
        
        # Calculate isolation score for each word
        isolation_scores = []
        words_list = list(embeddings.keys())
        
        for word in words_list:
            word_emb = embeddings[word]
            similarities = []
            
            for other_word in words_list:
                if other_word == word:
                    continue
                other_emb = embeddings[other_word]
                sim = cosine_similarity(word_emb, other_emb)
                similarities.append(sim)
            
            if similarities:
                avg_sim = sum(similarities) / len(similarities)
                max_sim = max(similarities)
                # Lower score = more isolated = better for defense
                isolation_score = avg_sim + 0.5 * max_sim
                isolation_scores.append((word, isolation_score))
        
        if not isolation_scores:
            return random.choice(word_pool)
        
        # Sort by isolation score (lower = more isolated)
        isolation_scores.sort(key=lambda x: x[1])
        
        # Pick from the top 3 most isolated words (slight randomness to avoid predictability)
        top_isolated = isolation_scores[:min(3, len(isolation_scores))]
        return random.choice(top_isolated)[0]
        
    except Exception as e:
        print(f"Error in _ai_select_isolated_word: {e}")
        return random.choice(word_pool)


def _ai_select_counter_intel_word(ai_player: dict, game: dict, word_pool: list) -> str:
    """
    Nemesis counter-intelligence word selection for word changes.
    
    Picks a new word that is:
    1. Maximally distant from all previous high-similarity guesses against it
    2. Semantically isolated (low connectivity to theme)
    
    Uses pre-computed theme similarity matrix when available for O(1) lookups.
    """
    import random
    
    if not word_pool:
        return None
    
    if len(word_pool) == 1:
        return word_pool[0]
    
    try:
        # Get the high-similarity guesses that opponents have made against us
        ai_id = ai_player.get("id")
        dangerous_words = []
        
        for entry in game.get("history", []):
            if entry.get("type") == "word_change":
                continue
            sims = entry.get("similarities", {})
            if ai_id in sims and sims[ai_id] > 0.5:
                word = entry.get("word")
                if word:
                    dangerous_words.append((word, sims[ai_id]))
        
        # Fast path: use pre-computed similarity matrix if available
        similarity_matrix = game.get('theme_similarity_matrix') if game else None
        if similarity_matrix:
            word_scores = []
            for word in word_pool:
                word_lower = word.lower()
                word_sims = similarity_matrix.get(word_lower, {})
                if not word_sims:
                    continue
                
                # Distance from dangerous words
                danger_distance = 0
                if dangerous_words:
                    for dword, dsim in dangerous_words:
                        sim_to_danger = word_sims.get(dword.lower(), 0.5)
                        danger_distance += (1 - sim_to_danger) * dsim
                    danger_distance /= len(dangerous_words)
                else:
                    danger_distance = 0.5
                
                # Isolation score
                isolation_sims = []
                for other_word in word_pool:
                    if other_word.lower() == word_lower:
                        continue
                    isolation_sims.append(word_sims.get(other_word.lower(), 0.5))
                
                if isolation_sims:
                    avg_sim = sum(isolation_sims) / len(isolation_sims)
                    max_sim = max(isolation_sims)
                    isolation_score = avg_sim + 0.5 * max_sim
                else:
                    isolation_score = 0.5
                
                # Combined score: maximize danger distance, minimize isolation
                combined_score = danger_distance * 0.6 - isolation_score * 0.4
                word_scores.append((word, combined_score))
            
            if word_scores:
                word_scores.sort(key=lambda x: x[1], reverse=True)
                top_words = word_scores[:min(3, len(word_scores))]
                return random.choice(top_words)[0]
        
        # Fallback: use cached embeddings from Redis
        pool_embeddings = {}
        for word in word_pool:
            try:
                pool_embeddings[word] = get_embedding(word)
            except Exception:
                continue
        
        if not pool_embeddings:
            return random.choice(word_pool)
        
        # Get embeddings for dangerous words
        danger_embeddings = []
        for dword, dsim in dangerous_words:
            try:
                danger_embeddings.append((get_embedding(dword), dsim))
            except Exception:
                continue
        
        # Score each word in pool
        word_scores = []
        for word, word_emb in pool_embeddings.items():
            # Distance from dangerous words (weighted by how dangerous they were)
            danger_distance = 0
            if danger_embeddings:
                for danger_emb, danger_sim in danger_embeddings:
                    sim_to_danger = cosine_similarity(word_emb, danger_emb)
                    # Higher distance from danger = better
                    # Weight by how close the dangerous guess was
                    danger_distance += (1 - sim_to_danger) * danger_sim
                danger_distance /= len(danger_embeddings)
            else:
                danger_distance = 0.5  # Neutral if no dangerous guesses
            
            # Isolation score (same as _ai_select_isolated_word)
            isolation_sims = []
            for other_word, other_emb in pool_embeddings.items():
                if other_word == word:
                    continue
                isolation_sims.append(cosine_similarity(word_emb, other_emb))
            
            if isolation_sims:
                avg_sim = sum(isolation_sims) / len(isolation_sims)
                max_sim = max(isolation_sims)
                isolation_score = 1 - (avg_sim + 0.5 * max_sim)  # Higher = more isolated
            else:
                isolation_score = 0.5
            
            # Combined score: prioritize distance from danger, then isolation
            total_score = danger_distance * 0.6 + isolation_score * 0.4
            word_scores.append((word, total_score))
        
        if not word_scores:
            return random.choice(word_pool)
        
        # Pick the best word (highest score)
        word_scores.sort(key=lambda x: x[1], reverse=True)
        return word_scores[0][0]
        
    except Exception as e:
        print(f"Error in _ai_select_counter_intel_word: {e}")
        return random.choice(word_pool)


def _nemesis_init_beliefs(ai_player: dict, game: dict):
    """
    Initialize Bayesian belief tracking for Nemesis.
    
    For each opponent, maintain a probability distribution over their possible words.
    Initially uniform over their word pool (or theme words if pool unknown).
    """
    memory = ai_player.get("ai_memory", {})
    if "nemesis_beliefs" not in memory:
        memory["nemesis_beliefs"] = {}
    
    beliefs = memory["nemesis_beliefs"]
    theme_words = game.get("theme", {}).get("words", [])
    
    for player in game.get("players", []):
        pid = player.get("id")
        if pid == ai_player.get("id"):
            continue
        if not player.get("is_alive", True):
            continue
        if pid not in beliefs:
            # Initialize uniform distribution over theme words
            # In practice, we don't know their pool, so use theme words
            word_count = len(theme_words)
            if word_count > 0:
                uniform_prob = 1.0 / word_count
                beliefs[pid] = {w.lower(): uniform_prob for w in theme_words}
            else:
                beliefs[pid] = {}
    
    memory["nemesis_beliefs"] = beliefs
    ai_player["ai_memory"] = memory


def _nemesis_update_beliefs(ai_player: dict, game: dict, guess_word: str, similarities: dict):
    """
    Update Bayesian beliefs based on observed similarity scores.
    
    For each opponent, update P(word | observations) using the similarity
    between the guess and each possible word.
    """
    import math
    
    memory = ai_player.get("ai_memory", {})
    beliefs = memory.get("nemesis_beliefs", {})
    
    if not beliefs:
        _nemesis_init_beliefs(ai_player, game)
        beliefs = memory.get("nemesis_beliefs", {})
    
    # Get cached embeddings from Redis
    theme_embeddings = get_theme_embeddings(game)
    guess_lower = guess_word.lower()
    guess_embedding = theme_embeddings.get(guess_lower)
    if not guess_embedding:
        try:
            guess_embedding = get_embedding(guess_word, game)
        except Exception:
            return
    
    for player_id, observed_sim in similarities.items():
        if player_id == ai_player.get("id"):
            continue
        if player_id not in beliefs:
            continue
        
        player_beliefs = beliefs[player_id]
        if not player_beliefs:
            continue
        
        # Bayesian update: P(word | obs) ∝ P(obs | word) * P(word)
        # P(obs | word) = likelihood that we'd see this similarity if word is their secret
        # We model this as a Gaussian centered on the expected similarity
        
        new_beliefs = {}
        total_prob = 0.0
        
        for word, prior_prob in player_beliefs.items():
            word_embedding = theme_embeddings.get(word.lower())
            if not word_embedding:
                new_beliefs[word] = prior_prob
                total_prob += prior_prob
                continue
            
            expected_sim = cosine_similarity(guess_embedding, word_embedding)
            
            # Likelihood: how well does observed similarity match expected?
            # Use Gaussian likelihood with sigma=0.15
            sigma = 0.15
            diff = observed_sim - expected_sim
            likelihood = math.exp(-(diff ** 2) / (2 * sigma ** 2))
            
            posterior = prior_prob * likelihood
            new_beliefs[word] = posterior
            total_prob += posterior
        
        # Normalize
        if total_prob > 0:
            for word in new_beliefs:
                new_beliefs[word] /= total_prob
        
        beliefs[player_id] = new_beliefs
    
    memory["nemesis_beliefs"] = beliefs
    ai_player["ai_memory"] = memory


def _nemesis_get_top_candidates(ai_player: dict, player_id: str, k: int = 5) -> list:
    """
    Get the top k most likely words for a player based on current beliefs.
    
    Returns list of (word, probability) tuples sorted by probability.
    """
    memory = ai_player.get("ai_memory", {})
    beliefs = memory.get("nemesis_beliefs", {})
    
    player_beliefs = beliefs.get(player_id, {})
    if not player_beliefs:
        return []
    
    sorted_beliefs = sorted(player_beliefs.items(), key=lambda x: x[1], reverse=True)
    return sorted_beliefs[:k]


def _nemesis_calculate_entropy(probabilities: dict) -> float:
    """Calculate Shannon entropy of a probability distribution."""
    import math
    
    entropy = 0.0
    for prob in probabilities.values():
        if prob > 0:
            entropy -= prob * math.log2(prob)
    return entropy


def _nemesis_expected_info_gain(ai_player: dict, game: dict, guess_word: str, 
                                 available_words: list) -> float:
    """
    Calculate expected information gain from making a guess.
    
    FAST VERSION: Uses a heuristic based on how well the guess word
    discriminates between high-probability and low-probability candidates
    in our beliefs. Uses cached embeddings for speed.
    """
    memory = ai_player.get("ai_memory", {})
    beliefs = memory.get("nemesis_beliefs", {})
    
    if not beliefs:
        return 0.0
    
    # Get cached embeddings from Redis
    theme_embeddings = get_theme_embeddings(game)
    guess_lower = guess_word.lower()
    guess_embedding = theme_embeddings.get(guess_lower)
    if not guess_embedding:
        try:
            guess_embedding = get_embedding(guess_word, game)
        except Exception:
            return 0.0
    
    total_info_gain = 0.0
    
    for player in game.get("players", []):
        pid = player.get("id")
        if pid == ai_player.get("id"):
            continue
        if not player.get("is_alive", True):
            continue
        if pid not in beliefs:
            continue
        
        player_beliefs = beliefs[pid]
        if not player_beliefs:
            continue
        
        # Fast heuristic: measure variance in similarities to top candidates
        # High variance = good discriminating power = high info gain
        top_candidates = sorted(player_beliefs.items(), key=lambda x: x[1], reverse=True)[:5]
        if not top_candidates:
            continue
        
        similarities = []
        for word, prob in top_candidates:
            word_emb = theme_embeddings.get(word.lower())
            if not word_emb:
                continue
            sim = cosine_similarity(guess_embedding, word_emb)
            similarities.append(sim)
        
        if len(similarities) >= 2:
            # Variance of similarities indicates discrimination power
            mean_sim = sum(similarities) / len(similarities)
            variance = sum((s - mean_sim) ** 2 for s in similarities) / len(similarities)
            total_info_gain += variance * 10  # Scale up for scoring
    
    return total_info_gain


def _nemesis_calculate_elimination_prob(ai_player: dict, game: dict, 
                                         guess_word: str) -> dict:
    """
    Calculate probability that a guess will eliminate each opponent.
    
    Returns dict of player_id -> probability of elimination.
    """
    memory = ai_player.get("ai_memory", {})
    beliefs = memory.get("nemesis_beliefs", {})
    
    elimination_probs = {}
    guess_lower = guess_word.lower()
    
    for player in game.get("players", []):
        pid = player.get("id")
        if pid == ai_player.get("id"):
            continue
        if not player.get("is_alive", True):
            continue
        
        player_beliefs = beliefs.get(pid, {})
        
        # Probability of elimination = probability that guess IS their word
        elim_prob = player_beliefs.get(guess_lower, 0.0)
        elimination_probs[pid] = elim_prob
    
    return elimination_probs


def _nemesis_score_guess(ai_player: dict, game: dict, guess_word: str,
                         available_words: list) -> float:
    """
    Calculate total score for a guess using Nemesis strategy.
    
    Score combines:
    - Expected information gain (learning about opponents)
    - Elimination probability (chance of direct kill)
    - Self-leak penalty (risk of revealing our word)
    - Threat assessment (priority for dangerous opponents)
    """
    config = AI_DIFFICULTY_CONFIG.get("nemesis", {})
    
    # Information gain component
    info_gain = _nemesis_expected_info_gain(ai_player, game, guess_word, available_words)
    
    # Elimination probability
    elim_probs = _nemesis_calculate_elimination_prob(ai_player, game, guess_word)
    total_elim_prob = sum(elim_probs.values())
    
    # Threat-weighted elimination (prioritize eliminating players targeting us)
    threat_weighted_elim = 0.0
    for pid, elim_prob in elim_probs.items():
        threat_level = _nemesis_get_threat_level(ai_player, game, pid)
        threat_weighted_elim += elim_prob * (1 + threat_level)
    
    # Self-leak penalty (use cached embeddings)
    self_sim = _ai_self_similarity(ai_player, guess_word, game)
    if self_sim is None:
        self_sim = 0.0
    
    soft_max = float(config.get("self_leak_soft_max", 0.65))
    hard_max = float(config.get("self_leak_hard_max", 0.80))
    
    if self_sim > hard_max:
        leak_penalty = 10.0  # Severe penalty
    elif self_sim > soft_max:
        leak_penalty = (self_sim - soft_max) * 5.0
    else:
        leak_penalty = 0.0
    
    # Combined score
    # Weights tuned for aggressive but safe play
    score = (
        info_gain * 0.3 +           # Learning value
        total_elim_prob * 2.0 +      # Direct elimination value
        threat_weighted_elim * 1.0 - # Threat-weighted bonus
        leak_penalty                 # Safety penalty
    )
    
    return score


def _nemesis_get_threat_level(ai_player: dict, game: dict, opponent_id: str) -> float:
    """
    Calculate threat level of an opponent (how dangerous they are to us).
    
    Threat level based on:
    - How often they target us
    - Their highest similarity against us
    - Their elimination count (skill indicator)
    - Their health (healthy = more dangerous)
    """
    ai_id = ai_player.get("id")
    history = game.get("history", [])
    
    # Count how often they've targeted us (high similarity guesses)
    targeting_count = 0
    max_sim_against_us = 0.0
    their_eliminations = 0
    total_their_guesses = 0
    
    for entry in history:
        if entry.get("type") == "word_change":
            continue
        
        guesser_id = entry.get("guesser_id")
        sims = entry.get("similarities", {})
        elims = entry.get("eliminations", [])
        
        if guesser_id == opponent_id:
            total_their_guesses += 1
            their_eliminations += len(elims)
            
            sim_against_us = sims.get(ai_id, 0)
            if sim_against_us > 0.5:
                targeting_count += 1
            max_sim_against_us = max(max_sim_against_us, sim_against_us)
    
    # Calculate targeting rate
    targeting_rate = targeting_count / max(1, total_their_guesses)
    
    # Get opponent's vulnerability (inverse of their health)
    opponent = next((p for p in game.get("players", []) if p.get("id") == opponent_id), None)
    if opponent:
        opp_danger = _ai_danger_score(_ai_top_guesses_since_change(game, opponent_id, k=3))
        health = 1 - opp_danger  # Higher danger = lower health
    else:
        health = 0.5
    
    # Combined threat level
    threat = (
        targeting_rate * 0.4 +
        max_sim_against_us * 0.3 +
        min(1.0, their_eliminations * 0.1) * 0.2 +
        health * 0.1
    )
    
    return threat


def _nemesis_choose_guess(ai_player: dict, game: dict) -> str:
    """
    Nemesis guess selection using information-theoretic optimization.
    
    Evaluates all candidate words and picks the one with highest score.
    """
    import random
    
    theme_words = game.get("theme", {}).get("words", [])
    my_secret = (ai_player.get("secret_word") or "").lower().strip()
    config = AI_DIFFICULTY_CONFIG.get("nemesis", {})
    
    # Initialize beliefs if needed
    _nemesis_init_beliefs(ai_player, game)
    
    # Get stale guessed words (guessed but no word_change since)
    stale_guessed = _get_stale_guessed_words(game)
    
    # Build available words - prefer words that haven't been guessed or are reguessable
    available_words = []
    deprioritized_words = []
    for w in theme_words:
        wl = w.lower()
        if wl == my_secret:
            continue
        if wl in stale_guessed:
            deprioritized_words.append(w)
        else:
            available_words.append(w)
    
    # If all words have been guessed (rare), fall back to deprioritized
    if not available_words:
        available_words = deprioritized_words
    
    if not available_words:
        return None
    
    # Get candidate pool size
    pool_size = int(config.get("candidate_pool", 30))
    
    # For efficiency, evaluate a sample of candidates
    if len(available_words) > pool_size:
        # Prioritize words that are likely to be opponents' secrets
        candidates = _nemesis_get_priority_candidates(ai_player, game, available_words, pool_size)
    else:
        candidates = available_words
    
    # Score each candidate
    best_word = None
    best_score = float('-inf')
    
    for word in candidates:
        score = _nemesis_score_guess(ai_player, game, word, available_words)
        if score > best_score:
            best_score = score
            best_word = word
    
    return best_word if best_word else random.choice(available_words)


def _nemesis_get_priority_candidates(ai_player: dict, game: dict, 
                                      available_words: list, count: int) -> list:
    """
    Get priority candidate words for evaluation.
    
    Prioritizes:
    1. Words with high probability of being opponents' secrets
    2. Words similar to high-scoring guesses (using cached embeddings)
    3. Random sample for exploration
    """
    import random
    
    memory = ai_player.get("ai_memory", {})
    beliefs = memory.get("nemesis_beliefs", {})
    theme_embeddings = get_theme_embeddings(game)
    
    priority_words = set()
    
    # Add top candidates from beliefs
    for pid, player_beliefs in beliefs.items():
        top_words = sorted(player_beliefs.items(), key=lambda x: x[1], reverse=True)[:10]
        for word, prob in top_words:
            if word in [w.lower() for w in available_words]:
                # Find original casing
                for aw in available_words:
                    if aw.lower() == word:
                        priority_words.add(aw)
                        break
    
    # Add words similar to recent high-similarity guesses (using cached embeddings)
    for player in game.get("players", []):
        pid = player.get("id")
        if pid == ai_player.get("id"):
            continue
        top_guesses = _ai_top_guesses_since_change(game, pid, k=3)
        for word, sim in top_guesses:
            if sim > 0.5:
                # Find similar words using cached embeddings
                word_emb = theme_embeddings.get(word.lower())
                if not word_emb:
                    continue
                for aw in available_words[:50]:  # Sample for efficiency
                    aw_emb = theme_embeddings.get(aw.lower())
                    if aw_emb and cosine_similarity(word_emb, aw_emb) > 0.6:
                        priority_words.add(aw)
    
    # Fill remaining with random sample
    remaining = count - len(priority_words)
    if remaining > 0:
        other_words = [w for w in available_words if w not in priority_words]
        if other_words:
            priority_words.update(random.sample(other_words, min(remaining, len(other_words))))
    
    return list(priority_words)[:count]


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
        
        elif selection_mode == "isolated":
            # Nemesis strategy: pick words that are semantically isolated
            # (hard to triangulate because similar words don't exist in theme)
            return _ai_select_isolated_word(word_pool)
        
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
    
    # For Nemesis, also update Bayesian beliefs
    difficulty = ai_player.get("difficulty", "rookie")
    if difficulty == "nemesis":
        _nemesis_update_beliefs(ai_player, game, guess_word, similarities)


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


def ai_find_similar_words(target_word: str, theme_words: list, guessed_words: list, count: int = 5, game: dict = None) -> list:
    """Find words in theme that are semantically similar to target word using embeddings.
    
    Note: guessed_words parameter is kept for API compatibility but no longer used for filtering.
    Bots should be able to re-guess words because players may have changed their words.
    
    Uses pre-computed similarity matrix for O(1) lookups when available.
    """
    try:
        target_lower = target_word.lower()
        
        # Fast path: use pre-computed similarity matrix
        matrix = game.get('theme_similarity_matrix') if game else None
        if matrix and target_lower in matrix:
            candidates = []
            for word in theme_words:
                word_lower = word.lower()
                sim = matrix[target_lower].get(word_lower, 0)
                candidates.append((word, sim))
            candidates.sort(key=lambda x: x[1], reverse=True)
            return [c[0] for c in candidates[:count]]
        
        # Fallback: use cached embeddings (shouldn't happen often if matrix is pre-computed)
        theme_embeddings = get_theme_embeddings(game) if game else {}
        
        target_embedding = theme_embeddings.get(target_lower)
        if not target_embedding:
            target_embedding = get_embedding(target_word, game)
        
        candidates = []
        for word in theme_words:
            word_lower = word.lower()
            word_embedding = theme_embeddings.get(word_lower)
            if not word_embedding:
                word_embedding = get_embedding(word, game)
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


def _get_reguessable_words(game: dict) -> set:
    """
    Return set of previously-guessed words that are worth re-guessing.
    A word is reguessable if any player changed their word since that word was last guessed.
    """
    history = game.get('history', []) or []
    
    # Find last guess index for each word
    last_guessed_at = {}
    for idx, entry in enumerate(history):
        if entry.get('type') != 'word_change':
            word = (entry.get('word') or '').lower()
            if word:
                last_guessed_at[word] = idx
    
    # Find word change indices
    word_change_indices = [
        idx for idx, entry in enumerate(history)
        if entry.get('type') == 'word_change'
    ]
    
    # A word is reguessable if any word_change happened after it was guessed
    reguessable = set()
    for word, guess_idx in last_guessed_at.items():
        if any(wc_idx > guess_idx for wc_idx in word_change_indices):
            reguessable.add(word)
    
    return reguessable


def _get_stale_guessed_words(game: dict) -> set:
    """
    Return set of previously-guessed words that should be deprioritized.
    These are words that were guessed but no word_change has happened since.
    """
    history = game.get('history', []) or []
    
    # Find all guessed words
    all_guessed = set()
    for entry in history:
        if entry.get('type') != 'word_change':
            word = (entry.get('word') or '').lower()
            if word:
                all_guessed.add(word)
    
    # Get reguessable words
    reguessable = _get_reguessable_words(game)
    
    # Stale = guessed but not reguessable
    return all_guessed - reguessable


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


def _ai_self_similarity(ai_player: dict, word: str, game: dict = None) -> Optional[float]:
    """Cosine similarity between a candidate guess and the AI's own secret embedding."""
    try:
        my_secret = (ai_player.get("secret_word") or "").lower().strip()
        word_lower = word.lower()
        
        # Fast path: use pre-computed similarity matrix
        if game and my_secret:
            matrix = game.get('theme_similarity_matrix')
            if matrix and my_secret in matrix:
                sim = matrix[my_secret].get(word_lower)
                if sim is not None:
                    return float(sim)
        
        # Fallback: compute similarity from embeddings (lookup from cache)
        if not my_secret:
            return None
        
        try:
            secret_emb = get_embedding(my_secret)
        except Exception:
            # Legacy fallback: use stored embedding if cache miss
            secret_emb = ai_player.get("secret_embedding")
        
        if not secret_emb:
            return None
        
        # Try cached embedding first
        if game:
            theme_embeddings = get_theme_embeddings(game)
            emb = theme_embeddings.get(word_lower)
            if emb:
                return float(cosine_similarity(emb, secret_emb))
        
        emb = get_embedding(word, game)
        return float(cosine_similarity(emb, secret_emb))
    except Exception:
        return None


# ============== AI REALISM HELPERS ==============

def _ai_get_personality_modifiers(ai_player: dict) -> dict:
    """Get personality modifiers for an AI player."""
    difficulty = ai_player.get("difficulty", "rookie")
    config = AI_DIFFICULTY_CONFIG.get(difficulty, {})
    
    # Nemesis has no personality - return neutral modifiers
    if config.get("has_personality") is False or difficulty == "nemesis":
        return {
            "random_chance_mod": 0.0,
            "targeting_boost": 0.0,
            "self_leak_tolerance": 0.0,
            "think_time_mod": 1.0,
        }
    
    personality = ai_player.get("personality", "methodical")
    return AI_PERSONALITY_CONFIG.get(personality, AI_PERSONALITY_CONFIG["methodical"])


def _ai_calculate_think_time(ai_player: dict, is_strategic: bool, is_panicking: bool) -> int:
    """Calculate how long the AI should 'think' before making a move (in ms)."""
    import random
    
    difficulty = ai_player.get("difficulty", "rookie")
    timing = AI_TIMING_CONFIG.get(difficulty, AI_TIMING_CONFIG["rookie"])
    personality_mods = _ai_get_personality_modifiers(ai_player)
    
    # Base think time range
    if is_strategic:
        min_ms, max_ms = timing["strategic_think_ms"]
    else:
        min_ms, max_ms = timing["base_think_ms"]
    
    # Apply personality modifier
    think_mod = personality_mods.get("think_time_mod", 1.0)
    min_ms = int(min_ms * think_mod)
    max_ms = int(max_ms * think_mod)
    
    # Panicking makes you either faster (rushed) or slower (frozen)
    if is_panicking:
        if random.random() < 0.6:
            # Rushed - faster
            min_ms = int(min_ms * 0.6)
            max_ms = int(max_ms * 0.7)
        else:
            # Frozen - slower
            min_ms = int(min_ms * 1.3)
            max_ms = int(max_ms * 1.5)
    
    # Add hesitation chance
    hesitation_chance = timing.get("hesitation_chance", 0.1)
    hesitation_ms = 0
    if random.random() < hesitation_chance:
        h_min, h_max = timing.get("hesitation_ms", (100, 400))
        hesitation_ms = random.randint(h_min, h_max)
    
    base_time = random.randint(min_ms, max_ms)
    return base_time + hesitation_ms


def _ai_should_make_mistake(ai_player: dict, mistake_type: str, is_panicking: bool = False) -> bool:
    """Check if the AI should make a specific type of mistake."""
    import random
    
    difficulty = ai_player.get("difficulty", "rookie")
    
    # Nemesis never makes mistakes
    if difficulty == "nemesis":
        return False
    
    config = AI_DIFFICULTY_CONFIG.get(difficulty, {})
    if config.get("makes_mistakes") is False:
        return False
    
    mistakes = AI_MISTAKE_CONFIG.get(difficulty, AI_MISTAKE_CONFIG["rookie"])
    
    base_chance = mistakes.get(mistake_type, 0.0)
    
    # Panic increases mistake chance
    if is_panicking and mistake_type == "panic_mistake":
        base_chance = min(0.9, base_chance * 1.5)
    elif is_panicking:
        base_chance = min(0.8, base_chance * 1.2)
    
    # Personality affects some mistakes
    personality_mods = _ai_get_personality_modifiers(ai_player)
    if mistake_type == "overconfident_guess" and personality_mods.get("self_leak_tolerance", 0) > 0:
        base_chance = min(0.5, base_chance * 1.3)  # Aggressive types more prone
    
    # Streak affects mistakes - cold streak increases mistakes
    memory = ai_player.get("ai_memory", {})
    streak = memory.get("streak", 0)
    if streak < -2:  # Cold streak
        base_chance = min(0.6, base_chance * 1.2)
    elif streak > 2:  # Hot streak - fewer mistakes
        base_chance = base_chance * 0.7
    
    return random.random() < base_chance


def _ai_update_streak(ai_player: dict, guess_result: str):
    """Update AI's hot/cold streak based on guess outcome."""
    memory = ai_player.get("ai_memory", {})
    streak = memory.get("streak", 0)
    
    if guess_result == "elimination":
        streak = min(5, streak + 2)  # Big boost for elimination
    elif guess_result == "high_similarity":
        streak = min(5, streak + 1)  # Small boost for good guess
    elif guess_result == "low_similarity":
        streak = max(-5, streak - 1)  # Penalty for bad guess
    elif guess_result == "got_eliminated":
        streak = -3  # Reset to cold on being eliminated
    
    memory["streak"] = streak
    memory["last_guess_quality"] = guess_result
    ai_player["ai_memory"] = memory


def _ai_update_grudge(ai_player: dict, attacker_id: str, similarity: float):
    """Update grudge against a player who targeted this AI."""
    memory = ai_player.get("ai_memory", {})
    grudges = memory.get("grudges", {})
    
    # High similarity attacks build grudge
    if similarity > 0.6:
        current_grudge = grudges.get(attacker_id, 0.0)
        grudge_increase = (similarity - 0.5) * 0.5  # 0.6 sim = +0.05, 0.9 sim = +0.2
        grudges[attacker_id] = min(1.0, current_grudge + grudge_increase)
    
    # Grudges decay slightly over time
    for pid in list(grudges.keys()):
        if pid != attacker_id:
            grudges[pid] = max(0, grudges[pid] - 0.05)
    
    memory["grudges"] = grudges
    ai_player["ai_memory"] = memory


def _ai_select_target_by_personality(ai_player: dict, game: dict, available_targets: list) -> Optional[dict]:
    """Select a target based on AI personality preference."""
    import random
    
    if not available_targets:
        return None
    
    personality_mods = _ai_get_personality_modifiers(ai_player)
    preference = personality_mods.get("target_preference", "random")
    memory = ai_player.get("ai_memory", {})
    grudges = memory.get("grudges", {})
    
    # Check for grudge override (personality-independent revenge)
    if grudges:
        max_grudge_id = max(grudges.keys(), key=lambda k: grudges[k])
        if grudges[max_grudge_id] > 0.5:
            # Strong grudge - 40% chance to target them instead
            if random.random() < 0.4:
                grudge_target = next((t for t in available_targets if t.get("player_id") == max_grudge_id), None)
                if grudge_target:
                    return grudge_target
    
    if preference == "random":
        return random.choice(available_targets)
    
    elif preference == "leader":
        # Target player with most eliminations (or first in turn order as proxy)
        # For now, just pick the one with highest danger to others
        return max(available_targets, key=lambda t: t.get("score", 0))
    
    elif preference == "safe":
        # Target already-exposed players (high danger score)
        exposed = [t for t in available_targets if t.get("top_similarity", 0) > 0.65]
        if exposed:
            return random.choice(exposed)
        return random.choice(available_targets)
    
    elif preference == "weakest":
        # Target player closest to elimination (highest danger)
        return max(available_targets, key=lambda t: t.get("top_similarity", 0))
    
    elif preference == "vulnerable":
        # Same as weakest but with some randomness
        sorted_targets = sorted(available_targets, key=lambda t: t.get("top_similarity", 0), reverse=True)
        top_half = sorted_targets[:max(1, len(sorted_targets) // 2)]
        return random.choice(top_half)
    
    return random.choice(available_targets)


def _ai_maybe_bluff(ai_player: dict, game: dict, available_words: list) -> Optional[str]:
    """Occasionally guess a word near own secret to mislead opponents."""
    import random
    
    difficulty = ai_player.get("difficulty", "rookie")
    config = AI_DIFFICULTY_CONFIG.get(difficulty, {})
    
    # Nemesis never bluffs - pure optimization only
    if config.get("uses_bluffing") is False or difficulty == "nemesis":
        return None
    
    personality_mods = _ai_get_personality_modifiers(ai_player)
    
    # Only higher difficulties bluff, and only certain personalities
    bluff_base_chance = {
        "rookie": 0.0,
        "analyst": 0.03,
        "field-agent": 0.06,
        "spymaster": 0.10,
        "ghost": 0.15,
    }.get(difficulty, 0.0)
    
    # Cautious personalities don't bluff; aggressive ones bluff more
    if personality_mods.get("self_leak_tolerance", 0) < 0:
        bluff_base_chance = 0  # Cautious won't bluff
    elif personality_mods.get("self_leak_tolerance", 0) > 0:
        bluff_base_chance *= 1.5  # Aggressive bluffs more
    
    if random.random() >= bluff_base_chance:
        return None
    
    # Find words moderately similar to own secret (not too close, not too far)
    my_secret = ai_player.get("secret_word", "")
    if not my_secret:
        return None
    
    try:
        # Look up embedding from cache (or legacy stored embedding)
        try:
            my_embedding = get_embedding(my_secret)
        except Exception:
            my_embedding = ai_player.get("secret_embedding")
        
        if not my_embedding:
            return None
        
        # Use cached embeddings if available
        theme_embeddings = get_theme_embeddings(game)
        
        bluff_candidates = []
        for word in available_words[:30]:  # Sample for performance
            word_emb = theme_embeddings.get(word.lower())
            if not word_emb:
                word_emb = get_embedding(word, game)
            sim = cosine_similarity(my_embedding, word_emb)
            # Sweet spot: 0.5-0.75 similarity (close enough to mislead, not too close to self-eliminate)
            if 0.5 < sim < 0.75:
                bluff_candidates.append((word, sim))
        
        if bluff_candidates:
            # Pick one randomly from the bluff candidates
            return random.choice(bluff_candidates)[0]
    except Exception:
        pass
    
    return None


def _ai_adapt_to_player(ai_player: dict, game: dict, player_id: str):
    """Track patterns in a player's behavior for adaptation."""
    memory = ai_player.get("ai_memory", {})
    adaptation = memory.get("adaptation_notes", {})
    
    if player_id not in adaptation:
        adaptation[player_id] = {
            "guess_patterns": [],
            "word_change_count": 0,
            "avg_similarity_received": 0.0,
            "samples": 0,
        }
    
    # Analyze recent history for this player
    history = game.get("history", [])
    player_guesses = [h for h in history if h.get("guesser_id") == player_id]
    
    if player_guesses:
        # Track their targeting patterns
        recent = player_guesses[-5:]
        my_id = ai_player.get("id")
        targeted_me = sum(1 for g in recent if g.get("similarities", {}).get(my_id, 0) > 0.5)
        adaptation[player_id]["targeting_me_rate"] = targeted_me / len(recent) if recent else 0
    
    memory["adaptation_notes"] = adaptation
    ai_player["ai_memory"] = memory


def _ai_generate_chat_message(ai_player: dict, trigger: str, context: dict = None) -> Optional[str]:
    """Generate a contextual chat message for the AI."""
    import random
    
    messages = AI_CHAT_MESSAGES.get(trigger, [])
    if not messages:
        return None
    
    # Higher difficulties chat less (more stoic)
    difficulty = ai_player.get("difficulty", "rookie")
    chat_chance = {
        "rookie": 0.6,
        "analyst": 0.45,
        "field-agent": 0.35,
        "spymaster": 0.25,
        "ghost": 0.15,
    }.get(difficulty, 0.3)
    
    # Personality affects chat frequency
    personality = ai_player.get("personality", "methodical")
    if personality == "chaotic":
        chat_chance *= 1.5
    elif personality == "cautious":
        chat_chance *= 0.7
    
    if random.random() >= chat_chance:
        return None
    
    message = random.choice(messages)
    return message if message else None  # Empty strings mean silence


def _ai_update_confidence(ai_player: dict, event: str, value: float = 0.0):
    """Update AI's confidence level based on game events."""
    ai_state = ai_player.get("ai_state", {})
    confidence = ai_state.get("confidence", 0.5)
    
    if event == "made_elimination":
        confidence = min(1.0, confidence + 0.15)
    elif event == "high_similarity_guess":
        confidence = min(1.0, confidence + 0.05)
    elif event == "low_similarity_guess":
        confidence = max(0.1, confidence - 0.05)
    elif event == "got_targeted":
        # Value is the similarity of the attack
        confidence = max(0.1, confidence - value * 0.2)
    elif event == "danger_increased":
        confidence = max(0.1, confidence - 0.1)
    
    ai_state["confidence"] = confidence
    ai_player["ai_state"] = ai_state


def ai_choose_guess(ai_player: dict, game: dict) -> Optional[str]:
    """AI chooses a word to guess. Fast and simple.
    
    Strategy:
    - Look at game history for high-similarity clues
    - Pick words similar to those clues
    - Avoid guessing own secret word
    - Avoid guessing words that have already been guessed
    - Higher difficulty = smarter targeting
    """
    import random
    
    difficulty = ai_player.get("difficulty", "rookie")
    default_cfg = AI_DIFFICULTY_CONFIG.get("rookie") or {}
    config = AI_DIFFICULTY_CONFIG.get(difficulty, default_cfg)
    
    # Nemesis uses completely different strategy
    if difficulty == "nemesis":
        return _nemesis_choose_guess(ai_player, game)
    
    theme_words = game.get("theme", {}).get("words", [])
    my_secret = (ai_player.get("secret_word") or "").lower().strip()
    matrix = game.get('theme_similarity_matrix', {})
    
    # Get all previously guessed words from history
    guessed_words = set()
    for entry in game.get('history', []):
        word = entry.get('word', '').lower()
        if word:
            guessed_words.add(word)
    
    # Build available words (exclude own secret and already guessed words)
    available_words = [w for w in theme_words 
                       if w.lower() != my_secret and w.lower() not in guessed_words]
    if not available_words:
        return None
    
    strategic_chance = float(config.get("strategic_chance", 0.15))
    
    # Strategic guess: find best target from history
    if random.random() < strategic_chance and matrix:
        # Look at recent history for high-similarity guesses against opponents
        best_clue = None
        best_sim = 0.0
        
        for entry in reversed(game.get("history", [])[-20:]):
            word = entry.get("word", "").lower()
            sims = entry.get("similarities", {})
            for pid, sim in sims.items():
                # Skip self
                if pid == ai_player.get("id"):
                    continue
                # Check if this player is still alive
                player = next((p for p in game["players"] if p["id"] == pid and p.get("is_alive")), None)
                if player and sim > best_sim:
                    best_sim = sim
                    best_clue = word
        
        # If we found a good clue, pick a similar word
        if best_clue and best_sim > 0.4 and best_clue in matrix:
            # Get words similar to the clue
            clue_sims = matrix[best_clue]
            candidates = []
            for w in available_words:
                wl = w.lower()
                if wl == best_clue:
                    continue  # Don't repeat the exact clue
                sim = clue_sims.get(wl, 0)
                candidates.append((w, sim))
            
            if candidates:
                candidates.sort(key=lambda x: x[1], reverse=True)
                # Pick from top candidates with some randomness
                top_n = min(5, len(candidates))
                return random.choice(candidates[:top_n])[0]
    
    # Random guess
    return random.choice(available_words)


def ai_change_word(ai_player: dict, game: dict) -> Optional[str]:
    """AI chooses a new secret word after eliminating someone.
    
    If the AI's original word pool is exhausted, regenerate a fresh sample from the theme.
    Excludes current secret words of OTHER players AND previously guessed words.
    """
    import random
    
    # Get current secret words of OTHER players
    current_secrets = set()
    ai_id = ai_player.get("id")
    for p in game.get("players", []):
        if p.get("id") != ai_id and p.get("secret_word"):
            current_secrets.add(p["secret_word"].lower())
    
    # Get all previously guessed words from history
    guessed_words = set()
    for entry in game.get('history', []):
        word = entry.get('word', '').lower()
        if word:
            guessed_words.add(word)
    
    # First try: use AI's existing word pool, filtered to exclude current secrets and guessed words
    word_pool = ai_player.get("word_pool", [])
    available_words = [w for w in word_pool 
                       if w.lower() not in current_secrets and w.lower() not in guessed_words]
    
    # If pool exhausted, regenerate from theme
    if not available_words:
        all_theme_words = (game.get("theme", {}) or {}).get("words", [])
        available_words = [w for w in all_theme_words 
                          if w.lower() not in current_secrets and w.lower() not in guessed_words]
        
        # Update AI's word pool with a fresh sample
        if len(available_words) > WORDS_PER_PLAYER:
            new_pool = random.sample(available_words, WORDS_PER_PLAYER)
            ai_player["word_pool"] = sorted(new_pool)
            available_words = new_pool
    
    if not available_words:
        return None
    
    return ai_select_secret_word(ai_player, available_words)


def process_ai_turn(game: dict, ai_player: dict) -> Optional[dict]:
    """Process an AI player's turn and return the guess result.
    
    Includes:
    - Dynamic thinking time calculation
    - Streak and confidence updates
    - Grudge tracking
    - Chat message generation
    """
    import random
    
    if not ai_player.get("is_ai") or not ai_player.get("is_alive"):
        return None
    
    ai_state = ai_player.get("ai_state", {})
    
    # Choose a guess
    guess_word = ai_choose_guess(ai_player, game)
    if not guess_word:
        return None
    
    guess_lower = guess_word.lower()
    
    # Calculate similarities - use pre-computed matrix for speed
    similarities = {}
    matrix = game.get('theme_similarity_matrix')
    
    for p in game["players"]:
        secret = p.get("secret_word", "").lower()
        if not secret:
            continue
        
        # Fast path: use matrix
        if matrix and guess_lower in matrix:
            sim = matrix[guess_lower].get(secret)
            if sim is not None:
                similarities[p["id"]] = round(sim, 4)
                continue
        
        # Fallback: compute from embeddings (should be rare)
        guess_emb = p.get("_guess_emb")
        if not guess_emb:
            try:
                guess_emb = get_embedding(guess_word)
            except Exception:
                continue
        
        # Look up secret embedding from cache
        try:
            secret_emb = get_embedding(secret)
        except Exception:
            # Legacy fallback
            secret_emb = p.get("secret_embedding")
        
        if secret_emb:
            sim = cosine_similarity(guess_emb, secret_emb)
            similarities[p["id"]] = round(sim, 4)
    
    # Check for eliminations
    eliminations = []
    for p in game["players"]:
        if p["id"] != ai_player["id"] and p.get("is_alive"):
            if guess_lower == p.get("secret_word", "").lower():
                p["is_alive"] = False
                eliminations.append(p["id"])
    
    # If AI eliminated someone, they can change their word
    if eliminations:
        ai_player["can_change_word"] = True
    
    # Record history
    history_entry = {
        "guesser_id": ai_player["id"],
        "guesser_name": ai_player["name"],
        "word": guess_lower,
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

    # Nemesis ALWAYS changes word and uses counter-intelligence strategy
    if difficulty == "nemesis":
        # Get available words
        word_pool = ai_player.get("word_pool", [])
        current_secrets = set()
        ai_id = ai_player.get("id")
        for p in game.get("players", []):
            if p.get("id") != ai_id and p.get("secret_word"):
                current_secrets.add(p["secret_word"].lower())
        
        # Get all previously guessed words from history
        guessed_words = set()
        for entry in game.get('history', []):
            word = entry.get('word', '').lower()
            if word:
                guessed_words.add(word)
        
        available_words = [w for w in word_pool 
                          if w.lower() not in current_secrets and w.lower() not in guessed_words]
        
        # If pool exhausted, regenerate from theme
        if not available_words:
            all_theme_words = (game.get("theme", {}) or {}).get("words", [])
            available_words = [w for w in all_theme_words 
                              if w.lower() not in current_secrets and w.lower() not in guessed_words]
            if len(available_words) > WORDS_PER_PLAYER:
                new_pool = random.sample(available_words, WORDS_PER_PLAYER)
                ai_player["word_pool"] = sorted(new_pool)
                available_words = new_pool
        
        if available_words:
            # Use counter-intelligence word selection
            new_word = _ai_select_counter_intel_word(ai_player, game, available_words)
            if new_word:
                try:
                    get_embedding(new_word)  # Ensure cached
                    ai_player["secret_word"] = new_word.lower()
                    
                    # Record word change in history
                    game["history"].append({
                        "type": "word_change",
                        "player_id": ai_player["id"],
                        "player_name": ai_player["name"],
                    })
                    
                    # Reset beliefs about us since we changed word
                    # (opponents' intel is now stale)
                except Exception as e:
                    print(f"Nemesis word change error: {e}")
        
        ai_player["can_change_word"] = False
        return True

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
                get_embedding(new_word)  # Ensure cached
                ai_player["secret_word"] = new_word.lower()
                
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

# Rate limiters (lazy initialized) - kept for backwards compatibility
# New code should use security.rate_limiter module
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
    """Game creation rate limiter: 3 games/minute per IP (reduced from 5)."""
    global _ratelimit_game_create
    if _ratelimit_game_create is None:
        _ratelimit_game_create = Ratelimit(
            redis=get_redis(),
            limiter=FixedWindow(max_requests=3, window=60),
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
    """Chat rate limiter: 15 messages/minute per player (reduced from 20)."""
    global _ratelimit_chat
    if _ratelimit_chat is None:
        _ratelimit_chat = Ratelimit(
            redis=get_redis(),
            limiter=FixedWindow(max_requests=15, window=60),
            prefix="ratelimit:chat",
        )
    return _ratelimit_chat


def check_rate_limit(limiter, identifier: str) -> bool:
    """Returns True if request is allowed, False if rate limited."""
    try:
        result = limiter.limit(identifier)
        return result.allowed
    except Exception:
        # SECURITY: Changed from fail-open to fail-closed for critical endpoints
        # For non-critical endpoints, we still fail open to maintain availability
        return True


def check_rate_limit_secure(config_name: str, identifier: str, client_ip: str = None) -> bool:
    """
    Secure rate limit check with fail-closed behavior and monitoring.
    
    Use this for security-critical endpoints.
    """
    allowed, metadata = check_rate_limit_strict(config_name, identifier, fail_closed=True)
    
    if not allowed:
        # Log rate limit event
        if metadata.get("result") == "blocked":
            log_rate_limit_blocked(
                client_ip or identifier,
                config_name,
                metadata.get("blocked_until", 0) - int(time.time()),
            )
        else:
            log_rate_limit_hit(client_ip or identifier, config_name)
    
    return allowed


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
GOOGLE_CLIENT_SECRET = os.getenv('GOOGLE_CLIENT_SECRET', '')

# JWT Configuration - SECURITY: Require JWT_SECRET in production
def _get_jwt_secret() -> str:
    """Get JWT secret with strict production requirements."""
    secret = os.getenv('JWT_SECRET')
    if not secret:
        # SECURITY: Fail hard in production
        if os.getenv('VERCEL_ENV') == 'production':
            raise RuntimeError("JWT_SECRET environment variable is required in production")
        # Development: use insecure fallback with clear warning
        print("[SECURITY WARNING] JWT_SECRET not set. Using insecure development secret.")
        return "INSECURE_DEV_SECRET_DO_NOT_USE_IN_PRODUCTION"
    if len(secret) < 32:
        print("[SECURITY WARNING] JWT_SECRET should be at least 32 characters.")
    return secret

JWT_SECRET = _get_jwt_secret()
JWT_ALGORITHM = 'HS256'
JWT_EXPIRY_HOURS = 24 * 7  # 1 week
JWT_REFRESH_THRESHOLD_HOURS = 24  # Refresh if less than 24h remaining

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


def create_jwt_token(user_data: dict, custom_expiry_hours: Optional[int] = None) -> str:
    """Create a JWT token for authenticated user with jti for revocation."""
    expiry_hours = custom_expiry_hours or JWT_EXPIRY_HOURS
    now = int(time.time())
    # Generate unique token ID for revocation tracking
    jti = secrets.token_hex(16)
    payload = {
        'sub': user_data['id'],
        'email': user_data.get('email', ''),
        'name': user_data.get('name', ''),
        'avatar': user_data.get('avatar', ''),
        'iat': now,
        'exp': now + (expiry_hours * 3600),
        'jti': jti,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_jwt_token(token: str) -> Optional[dict]:
    """Verify and decode a JWT token. Returns None if invalid or revoked."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        # Check if token has been revoked
        jti = payload.get('jti')
        if jti and is_token_revoked(jti):
            return None
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def refresh_jwt_token_if_needed(token: str) -> Optional[str]:
    """Refresh a JWT token if it's close to expiry. Returns new token or None."""
    payload = verify_jwt_token(token)
    if not payload:
        return None
    
    # Check if refresh is needed
    exp = payload.get('exp', 0)
    now = int(time.time())
    remaining_hours = (exp - now) / 3600
    
    if remaining_hours > JWT_REFRESH_THRESHOLD_HOURS:
        return None  # No refresh needed
    
    # Revoke old token
    old_jti = payload.get('jti')
    if old_jti:
        revoke_jwt_token(old_jti, exp - now)
    
    # Create new token
    user_data = {
        'id': payload.get('sub'),
        'email': payload.get('email', ''),
        'name': payload.get('name', ''),
        'avatar': payload.get('avatar', ''),
    }
    return create_jwt_token(user_data)


# ============== SESSION TOKEN SYSTEM ==============
# Session tokens prevent player impersonation (IDOR vulnerability)
# Each player gets a signed token when joining that must be provided with all game actions

SESSION_TOKEN_SECRET = os.getenv('SESSION_TOKEN_SECRET', '') or JWT_SECRET
SESSION_TOKEN_EXPIRY_HOURS = 24  # Session tokens valid for 24 hours


def generate_session_token(player_id: str, game_code: str) -> str:
    """
    Generate an HMAC-signed session token for a player in a game.
    
    Token format: {player_id}:{game_code}:{timestamp}:{signature}
    The signature covers player_id, game_code, and timestamp to prevent tampering.
    """
    timestamp = int(time.time())
    payload = f"{player_id}:{game_code}:{timestamp}"
    signature = hmac.new(
        SESSION_TOKEN_SECRET.encode(),
        payload.encode(),
        hashlib.sha256
    ).hexdigest()[:32]
    return f"{payload}:{signature}"


def verify_session_token(token: str, player_id: str, game_code: str) -> bool:
    """
    Verify that a session token is valid for the given player and game.
    
    Checks:
    1. Token structure is valid
    2. Player ID matches
    3. Game code matches
    4. Signature is valid (constant-time comparison)
    5. Token has not expired
    
    Returns True if valid, False otherwise.
    """
    if not token or not player_id or not game_code:
        return False
    
    try:
        parts = token.split(':')
        if len(parts) != 4:
            return False
        
        token_player_id, token_game_code, token_timestamp, token_signature = parts
        
        # Verify player ID and game code match
        if token_player_id != player_id:
            return False
        if token_game_code.upper() != game_code.upper():
            return False
        
        # Verify timestamp is valid and not expired
        try:
            timestamp = int(token_timestamp)
        except ValueError:
            return False
        
        now = int(time.time())
        token_age_hours = (now - timestamp) / 3600
        if token_age_hours > SESSION_TOKEN_EXPIRY_HOURS:
            return False
        if timestamp > now + 60:  # Allow 60 seconds clock skew, but not future tokens
            return False
        
        # Recompute signature and verify (constant-time comparison)
        payload = f"{token_player_id}:{token_game_code}:{token_timestamp}"
        expected_signature = hmac.new(
            SESSION_TOKEN_SECRET.encode(),
            payload.encode(),
            hashlib.sha256
        ).hexdigest()[:32]
        
        if not constant_time_compare(token_signature, expected_signature):
            return False
        
        return True
        
    except Exception as e:
        print(f"[SECURITY] Session token verification error: {e}")
        return False


# Admin emails that automatically get donor status
# SECURITY: Load from environment variable in production
def _get_admin_emails() -> list:
    """Get admin emails from environment. No fallback - require explicit configuration."""
    env_admins = os.getenv('ADMIN_EMAILS', '')
    if env_admins:
        return [e.strip().lower() for e in env_admins.split(',') if e.strip()]
    # SECURITY: No hardcoded fallback - require explicit configuration
    return []

ADMIN_EMAILS = _get_admin_emails()

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
        # Always update is_admin flag based on current ADMIN_EMAILS (re-check on each login)
        user['is_admin'] = is_admin
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
        'username': None,  # Custom username, set by user after first login
        'avatar': google_user.get('picture', ''),
        'created_at': int(time.time()),
        'is_admin': is_admin,  # Admin status from ADMIN_EMAILS env var
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


def get_user_display_name(user: dict) -> str:
    """Get user's display name (username if set, otherwise Google name)."""
    if not user:
        return 'Anonymous'
    return user.get('username') or user.get('name', 'Anonymous')


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
            # Invalid cosmetic ID, reset to default
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

        # Enforce admin-only gating (always on)
        if item and item.get('admin_only', False) and not is_admin:
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

    # Helper to generate description with actual target value
    def desc_games(n): return f"Play {n} multiplayer game{'s' if n != 1 else ''}"
    def desc_elims(n): return f"Get {n} elimination{'s' if n != 1 else ''}"
    def desc_wins(n): return f"Win {n} multiplayer game{'s' if n != 1 else ''}"
    
    # Pre-calculate scaled targets for descriptions
    engagement_targets = [scale_target(2), scale_target(3), scale_target(4)]
    combat_targets = [scale_target(2), scale_target(4), scale_target(6)]
    victory_targets = [1, scale_target(2)]
    
    defs = {
        "engagement": [
            ("mp_games", engagement_targets[0], scale_reward(35), "RUN OPERATIONS", desc_games(engagement_targets[0])),
            ("mp_games", engagement_targets[1], scale_reward(55), "FIELD WORK", desc_games(engagement_targets[1])),
            ("mp_games", engagement_targets[2], scale_reward(75), "FULL SHIFT", desc_games(engagement_targets[2])),
        ],
        "combat": [
            ("mp_elims", combat_targets[0], scale_reward(45), "TARGET PRACTICE", desc_elims(combat_targets[0])),
            ("mp_elims", combat_targets[1], scale_reward(70), "HUNTER MODE", desc_elims(combat_targets[1])),
            ("mp_elims", combat_targets[2], scale_reward(95), "EXECUTION ORDER", desc_elims(combat_targets[2])),
        ],
        "victory": [
            ("mp_wins", victory_targets[0], scale_reward(85), "SECURE THE WIN", desc_wins(victory_targets[0])),
            ("mp_wins", victory_targets[1], scale_reward(140), "DOMINATE", desc_wins(victory_targets[1])),
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


def apply_weekly_quest_progress(user: dict, deltas: dict, persist: bool = True) -> list:
    """
    Apply per-metric progress deltas to the user's weekly quests.
    Deltas example: {\"mp_games\": 1, \"mp_elims\": 2}
    """
    if not isinstance(user, dict):
        return []
    if not isinstance(deltas, dict) or not deltas:
        return ensure_weekly_quests(user, persist=persist)

    quests = ensure_weekly_quests(user, persist=False)
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
        week_start = get_week_start_str()
        user['weekly_quests'] = {"week_start": week_start, "quests": quests}
        if persist:
            save_user(user)

    return quests


def get_visible_cosmetics(user: dict) -> dict:
    """Get only the cosmetics that are visible to other players."""
    cosmetics = get_user_cosmetics(user)
    return {
        "card_border": cosmetics.get("card_border", "classic"),
        "name_color": cosmetics.get("name_color", "default"),
        "badge": cosmetics.get("badge", "none"),
        "victory_effect": cosmetics.get("victory_effect", "classic"),
        "profile_title": cosmetics.get("profile_title", "none"),
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
    return secrets.token_hex(16)  # 128 bits (32 hex chars) for better entropy


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
    
    Generates a fresh sample of WORD_CHANGE_SAMPLE_SIZE words from the full theme.
    Excludes current secret words of OTHER players AND previously guessed words.
    """
    import random
    
    # Get full theme words
    all_theme_words = (game.get('theme', {}) or {}).get('words', [])
    
    if not all_theme_words:
        # Fallback: allow keeping current word if nothing else is available
        current = player.get('secret_word')
        return [current] if current else []
    
    # Get current secret words of OTHER players
    player_id = player.get('id')
    current_secrets = set()
    for p in game.get('players', []):
        if p.get('id') != player_id and p.get('secret_word'):
            current_secrets.add(p['secret_word'].lower())
    
    # Get all previously guessed words from history
    guessed_words = set()
    for entry in game.get('history', []):
        word = entry.get('word', '').lower()
        if word:
            guessed_words.add(word)
    
    # Filter to exclude current secrets of other players AND guessed words
    available = [w for w in all_theme_words 
                 if w.lower() not in current_secrets and w.lower() not in guessed_words]
    
    if not available:
        # Fallback: allow keeping current word
        current = player.get('secret_word')
        return [current] if current else []
    
    if len(available) <= WORD_CHANGE_SAMPLE_SIZE:
        return sorted(available)
    
    return sorted(random.sample(available, WORD_CHANGE_SAMPLE_SIZE))


def get_embedding(word: str, game: dict = None) -> list:
    """Get embedding for a word from Redis cache (game parameter kept for API compatibility)."""
    word_lower = word.lower().strip()
    
    # Check Redis cache
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


def batch_get_embeddings(words: list, max_retries: int = 2) -> dict:
    """
    Get embeddings for multiple words efficiently using batch API.
    Returns dict mapping lowercase words to their embeddings.
    
    Uses Redis mget for batch cache lookups (1 HTTP call instead of N).
    """
    result = {}
    redis = get_redis()
    
    # Normalize all words
    normalized_words = []
    seen = set()
    for word in words:
        word_lower = word.lower().strip()
        if word_lower and word_lower not in seen:
            normalized_words.append(word_lower)
            seen.add(word_lower)
    
    if not normalized_words:
        return result
    
    # Batch cache lookup using mget (1 HTTP call for all words)
    cache_keys = [f"emb:{w}" for w in normalized_words]
    to_fetch = []
    
    try:
        cached_values = redis.mget(*cache_keys)
        for i, cached in enumerate(cached_values):
            word = normalized_words[i]
            if cached:
                try:
                    result[word] = json.loads(cached)
                except Exception:
                    to_fetch.append(word)
            else:
                to_fetch.append(word)
    except Exception:
        # Fallback: all words need fetching
        to_fetch = normalized_words
    
    # Batch fetch remaining from API with retry logic
    if to_fetch:
        retries = 0
        while to_fetch and retries <= max_retries:
            try:
                client = get_openai_client()
                # OpenAI batch limit is typically 2048 inputs, but chunk for safety
                batch_size = 100
                to_cache = {}  # Collect for batch cache write
                
                for i in range(0, len(to_fetch), batch_size):
                    batch = to_fetch[i:i + batch_size]
                    response = client.embeddings.create(
                        model=EMBEDDING_MODEL,
                        input=batch,
                    )
                    
                    for j, embedding_data in enumerate(response.data):
                        word = batch[j]
                        embedding = embedding_data.embedding
                        result[word] = embedding
                        to_cache[f"emb:{word}"] = json.dumps(embedding)
                
                # Batch cache write using mset (1 HTTP call)
                if to_cache:
                    try:
                        redis.mset(to_cache)
                    except Exception:
                        pass
                
                # Verify all words were fetched
                to_fetch = [w for w in to_fetch if w not in result]
                if not to_fetch:
                    break
                    
            except Exception as e:
                print(f"Batch embedding error (attempt {retries + 1}): {e}")
                retries += 1
                if retries <= max_retries:
                    import time
                    time.sleep(0.5 * retries)  # Exponential backoff
        
        # Log if some words still missing after retries
        if to_fetch:
            print(f"Warning: Failed to fetch embeddings for {len(to_fetch)} words after {max_retries + 1} attempts")
    
    return result


def get_theme_embeddings(game: dict) -> dict:
    """
    Get all theme word embeddings from Redis cache.
    Returns dict mapping lowercase words to their embeddings.
    
    Embeddings are cached in Redis during game start, so this is fast.
    """
    theme_words = game.get('theme', {}).get('words', [])
    if not theme_words:
        return {}
    
    result = {}
    redis = get_redis()
    
    for word in theme_words:
        word_lower = word.lower().strip()
        if not word_lower:
            continue
        cache_key = f"emb:{word_lower}"
        try:
            cached = redis.get(cache_key)
            if cached:
                result[word_lower] = json.loads(cached)
        except Exception:
            pass
    
    return result


def precompute_theme_similarities(game: dict, theme_embeddings: dict) -> dict:
    """
    Pre-compute similarity matrix for all theme words using vectorized numpy operations.
    Returns dict mapping word -> {word: similarity} for O(1) lookups.
    """
    words = list(theme_embeddings.keys())
    if not words:
        return {}
    
    # Stack all embeddings into a matrix for vectorized computation
    embeddings_matrix = np.array([theme_embeddings[w] for w in words])
    
    # Normalize all vectors (for cosine similarity)
    norms = np.linalg.norm(embeddings_matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1  # Avoid division by zero
    normalized = embeddings_matrix / norms
    
    # Compute all pairwise similarities at once: (n x d) @ (d x n) = (n x n)
    similarity_matrix = np.dot(normalized, normalized.T)
    
    # Convert to dict format
    matrix = {}
    for i, w1 in enumerate(words):
        matrix[w1] = {}
        for j, w2 in enumerate(words):
            matrix[w1][w2] = round(float(similarity_matrix[i, j]), 4)
    
    return matrix


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
        print(f"[RANKED DEBUG] apply_ranked_mmr_updates: game is not a dict")
        return
    if not bool(game.get('is_ranked', False)):
        print(f"[RANKED DEBUG] apply_ranked_mmr_updates: game is not ranked (is_ranked={game.get('is_ranked')})")
        return
    
    code = game.get('code') or ''
    print(f"[RANKED DEBUG] Processing ranked game {code}")
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
        print(f"[RANKED DEBUG] Game {code} already processed (ranked_processed=True)")
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
                print(f"[RANKED DEBUG] Game {code} already processed (Redis guard key exists)")
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

    # Ranked participants: authenticated humans only (skip AIs)
    participants = []
    for p in players:
        if not isinstance(p, dict):
            continue
        if p.get('is_ai'):
            continue
        uid = p.get('auth_user_id')
        if not uid:
            continue
        participants.append(p)

    print(f"[RANKED DEBUG] Game {code} has {len(participants)} authenticated participants")

    if len(participants) < 2:
        # Even if we can't do MMR calculations (not enough human players),
        # still increment ranked_games for the solo human participant
        # so placement progress (0/5) is tracked correctly.
        print(f"[RANKED DEBUG] Game {code} has < 2 participants, updating stats without MMR calc")
        for p in participants:
            uid = p.get('auth_user_id')
            if not uid:
                continue
            user = get_user_by_id(uid)
            if not user:
                continue
            u_stats = get_user_stats(user)
            u_stats['ranked_games'] = int(u_stats.get('ranked_games', 0) or 0) + 1
            pid = p.get('id')
            if pid and pid == winner_pid:
                u_stats['ranked_wins'] = int(u_stats.get('ranked_wins', 0) or 0) + 1
            else:
                u_stats['ranked_losses'] = int(u_stats.get('ranked_losses', 0) or 0) + 1
            user['stats'] = u_stats
            save_user(user)
            
            # Also update leaderboard zset so player appears after placement
            try:
                current_mmr = int(u_stats.get('mmr', RANKED_INITIAL_MMR) or RANKED_INITIAL_MMR)
                redis.zadd("leaderboard:mmr", {uid: current_mmr})
            except Exception as e:
                print(f"Failed to update ranked leaderboard for {uid}: {e}")
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
    pre_game_ranked_games = {}  # Track ranked_games BEFORE this match for placement K-factor
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
        # Store ranked_games count before this match (used for placement K-factor)
        try:
            pre_game_ranked_games[uid] = int(stats.get('ranked_games', 0) or 0)
        except Exception:
            pre_game_ranked_games[uid] = 0

    # If we couldn't load at least 2 users, still update stats for loaded users
    if len(rating) < 2:
        print(f"[RANKED DEBUG] Game {code} couldn't load 2+ users (loaded {len(rating)}), updating stats without MMR calc")
        # Update ranked_games for any users we did load
        for uid, user in user_map.items():
            u_stats = get_user_stats(user)
            u_stats['ranked_games'] = int(u_stats.get('ranked_games', 0) or 0) + 1
            # Find pid from participants
            pid = None
            for p in participants:
                if p.get('auth_user_id') == uid:
                    pid = p.get('id')
                    break
            if pid and pid == winner_pid:
                u_stats['ranked_wins'] = int(u_stats.get('ranked_wins', 0) or 0) + 1
            else:
                u_stats['ranked_losses'] = int(u_stats.get('ranked_losses', 0) or 0) + 1
            user['stats'] = u_stats
            save_user(user)
            
            # Also update leaderboard zset so player appears after placement
            try:
                current_mmr = int(u_stats.get('mmr', RANKED_INITIAL_MMR) or RANKED_INITIAL_MMR)
                redis.zadd("leaderboard:mmr", {uid: current_mmr})
            except Exception as e:
                print(f"Failed to update ranked leaderboard for {uid}: {e}")
        game['ranked_processed'] = True
        return

    # Map uid -> pid for rank comparisons
    uid_to_pid = {p.get('auth_user_id'): p.get('id') for p in participants if p.get('auth_user_id') in rating}
    uids = list(uid_to_pid.keys())
    n = len(uids)
    if n < 2:
        print(f"[RANKED DEBUG] Game {code} has < 2 uids after mapping ({n}), returning early")
        game['ranked_processed'] = True
        return
    
    print(f"[RANKED DEBUG] Game {code} processing MMR for {n} players")

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

    # Apply updates + persist
    # Also record per-game deltas so the frontend can show MMR change on the game-over screen.
    # Use per-player K-factor: higher for placement players (< RANKED_PLACEMENT_GAMES)
    mmr_result_by_pid = {}
    for uid in uids:
        user = user_map.get(uid)
        if not user:
            continue
        
        # Determine K-factor based on games played (before this match)
        # Placement (0-4 games): highest K-factor for fast calibration
        # Provisional (5-19 games): medium K-factor as rating stabilizes
        # Established (20+ games): K decays over time but never below minimum
        games_before = pre_game_ranked_games.get(uid, 0)
        if games_before < RANKED_PLACEMENT_GAMES:
            k_factor = RANKED_PLACEMENT_K_FACTOR
        elif games_before < RANKED_PROVISIONAL_GAMES:
            k_factor = RANKED_PROVISIONAL_K_FACTOR
        else:
            # K decays from base K factor, losing decay_rate per game after provisional
            games_after_provisional = games_before - RANKED_PROVISIONAL_GAMES
            k_factor = max(
                RANKED_K_FACTOR_MIN,
                RANKED_K_FACTOR - (games_after_provisional * RANKED_K_FACTOR_DECAY_RATE)
            )
        scale = float(k_factor) / float(max(1, n - 1))
        
        old = rating[uid]
        new = old + (scale * deltas.get(uid, 0.0)) + RANKED_PARTICIPATION_BONUS
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
        print(f"[RANKED DEBUG] Updated user {uid}: ranked_games={u_stats.get('ranked_games')}, mmr={u_stats.get('mmr')}, delta={delta_int}")

        # Update ranked leaderboard zset
        try:
            redis.zadd("leaderboard:mmr", {uid: new_int})
        except Exception as e:
            print(f"Failed to update ranked leaderboard for {uid}: {e}")

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
        print(f"[RANKED DEBUG] Game {code} finished processing, mmr_result_by_pid={mmr_result_by_pid}")
        # Persist results in Redis so concurrent finish requests can attach them reliably.
        try:
            redis.setex(result_key, GAME_EXPIRY_SECONDS, json.dumps(mmr_result_by_pid))
        except Exception:
            try:
                redis.set(result_key, json.dumps(mmr_result_by_pid))
            except Exception:
                pass
    else:
        print(f"[RANKED DEBUG] Game {code} finished processing but no mmr_result_by_pid")


def update_game_stats(game: dict):
    """Update stats for all players after a game ends."""
    winner_id = game.get('winner')
    is_multiplayer = not bool(game.get('is_singleplayer'))
    is_ranked = bool(game.get('is_ranked', False)) and is_multiplayer
    
    print(f"[RANKED DEBUG] update_game_stats called: is_ranked={is_ranked}, is_multiplayer={is_multiplayer}, winner={winner_id}")
    
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
        # Skip bots and guest players - they shouldn't appear on leaderboards
        if player.get('is_ai'):
            continue
        if not player.get('auth_user_id'):
            continue
        
        # Only update casual leaderboard stats for multiplayer CASUAL games (not solo, not ranked)
        # Ranked games have their own separate stats tracked via apply_ranked_mmr_updates
        if is_multiplayer and not is_ranked:
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

        # Update authenticated user's mp_* stats for cosmetics unlocks (for ALL multiplayer games)
        if is_multiplayer:
            auth_user_id = player.get('auth_user_id')
            if auth_user_id:
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
                    apply_weekly_quest_progress(auth_user, deltas, persist=False)

                    save_user(auth_user)

    # Ranked: update MMR once per finished game (best-effort + idempotent flag)
    if is_ranked:
        try:
            apply_ranked_mmr_updates(game)
        except Exception as e:
            import traceback
            print(f"Ranked MMR update error: {e}")
            print(f"Ranked MMR update traceback: {traceback.format_exc()}")


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


# ============== MATCHMAKING QUEUE SYSTEM ==============

# Queue configuration
QUEUE_EXPIRY_SECONDS = 300  # 5 minutes max in queue
QUEUE_QUICK_PLAY_TIMEOUT = 30  # 30 seconds before filling with AI
QUEUE_MATCH_SIZE = 4  # Fixed 4-player matches
QUEUE_MIN_CASUAL_GAMES_FOR_RANKED = 5  # Minimum casual games before ranked

# MMR range expansion for ranked matchmaking
RANKED_MMR_RANGE_INITIAL = 100
RANKED_MMR_RANGE_EXPANSIONS = [
    (30, 200),   # After 30s: +/- 200
    (60, 300),   # After 60s: +/- 300
    (90, 400),   # After 90s: +/- 400
    (120, 500),  # After 120s: +/- 500 (max)
]
RANKED_MMR_RANGE_MAX = 500


def _queue_key(mode: str) -> str:
    """Get Redis key for a queue mode."""
    return f"queue:{mode}"


def _queue_data_key(mode: str, player_id: str) -> str:
    """Get Redis key for player queue data."""
    return f"queue_data:{mode}:{player_id}"


def _queue_match_key(player_id: str) -> str:
    """Get Redis key for match notification."""
    return f"queue_match:{player_id}"


def get_mmr_range_for_wait_time(wait_seconds: float) -> int:
    """Get the MMR range based on how long the player has been waiting."""
    mmr_range = RANKED_MMR_RANGE_INITIAL
    for threshold_seconds, expanded_range in RANKED_MMR_RANGE_EXPANSIONS:
        if wait_seconds >= threshold_seconds:
            mmr_range = expanded_range
    return min(mmr_range, RANKED_MMR_RANGE_MAX)


def join_matchmaking_queue(
    mode: str,
    player_id: str,
    player_name: str,
    auth_user_id: Optional[str] = None,
    mmr: int = 1000,
    cosmetics: Optional[dict] = None,
) -> dict:
    """
    Add a player to the matchmaking queue.
    
    Args:
        mode: 'quick_play' or 'ranked'
        player_id: Unique player ID for this session
        player_name: Display name
        auth_user_id: Authenticated user ID (required for ranked)
        mmr: Player's MMR (used for ranked matching)
        cosmetics: Player's equipped cosmetics
    
    Returns:
        dict with queue status
    """
    redis = get_redis()
    now = time.time()
    
    queue_key = _queue_key(mode)
    data_key = _queue_data_key(mode, player_id)
    
    # Store player data
    player_data = {
        "player_id": player_id,
        "player_name": player_name,
        "auth_user_id": auth_user_id,
        "mmr": mmr,
        "cosmetics": cosmetics or {},
        "joined_at": now,
    }
    
    # For quick_play, sort by join time (FIFO)
    # For ranked, sort by MMR for skill-based matching
    score = now if mode == "quick_play" else mmr
    
    try:
        # Add to sorted set
        redis.zadd(queue_key, {player_id: score})
        # Store player data
        redis.setex(data_key, QUEUE_EXPIRY_SECONDS, json.dumps(player_data))
        # Set queue expiry
        redis.expire(queue_key, QUEUE_EXPIRY_SECONDS)
        
        return {
            "status": "queued",
            "mode": mode,
            "position": redis.zrank(queue_key, player_id) or 0,
            "queue_size": redis.zcard(queue_key) or 0,
        }
    except Exception as e:
        print(f"[QUEUE] Error joining queue: {e}")
        return {"status": "error", "message": "Failed to join queue"}


def leave_matchmaking_queue(mode: str, player_id: str) -> bool:
    """Remove a player from the matchmaking queue."""
    redis = get_redis()
    
    try:
        queue_key = _queue_key(mode)
        data_key = _queue_data_key(mode, player_id)
        match_key = _queue_match_key(player_id)
        
        redis.zrem(queue_key, player_id)
        redis.delete(data_key)
        redis.delete(match_key)
        return True
    except Exception as e:
        print(f"[QUEUE] Error leaving queue: {e}")
        return False


def get_queue_status(mode: str, player_id: str) -> dict:
    """
    Get a player's queue status and check for matches.
    
    This is called on poll and triggers the matching logic.
    """
    redis = get_redis()
    now = time.time()
    
    # Check if player was matched
    match_key = _queue_match_key(player_id)
    try:
        match_data = redis.get(match_key)
        if match_data:
            if isinstance(match_data, bytes):
                match_data = match_data.decode()
            match_info = json.loads(match_data)
            # Clear the match notification
            redis.delete(match_key)
            return {
                "status": "matched",
                "game_code": match_info.get("game_code"),
                "player_id": match_info.get("player_id"),
                "session_token": match_info.get("session_token"),
                "mode": mode,
            }
    except Exception as e:
        print(f"[QUEUE] Error checking match: {e}")
    
    queue_key = _queue_key(mode)
    data_key = _queue_data_key(mode, player_id)
    
    # Check if still in queue
    try:
        rank = redis.zrank(queue_key, player_id)
        if rank is None:
            return {"status": "not_in_queue", "mode": mode}
    except Exception:
        return {"status": "not_in_queue", "mode": mode}
    
    # Get player data
    try:
        raw_data = redis.get(data_key)
        if not raw_data:
            return {"status": "not_in_queue", "mode": mode}
        if isinstance(raw_data, bytes):
            raw_data = raw_data.decode()
        player_data = json.loads(raw_data)
    except Exception:
        return {"status": "not_in_queue", "mode": mode}
    
    joined_at = player_data.get("joined_at", now)
    wait_time = now - joined_at
    queue_size = redis.zcard(queue_key) or 0
    
    # Try to find a match
    match_result = try_create_match(mode, player_id, wait_time)
    if match_result:
        # Get our session token from the match notification
        match_key = _queue_match_key(player_id)
        try:
            match_data = redis.get(match_key)
            if match_data:
                if isinstance(match_data, bytes):
                    match_data = match_data.decode()
                match_info = json.loads(match_data)
                redis.delete(match_key)
                return {
                    "status": "matched",
                    "game_code": match_info.get("game_code"),
                    "player_id": match_info.get("player_id"),
                    "session_token": match_info.get("session_token"),
                    "mode": mode,
                }
        except Exception:
            pass
        # Fallback if notification not found
        return {
            "status": "matched",
            "game_code": match_result.get("game_code"),
            "mode": mode,
        }
    
    # Still waiting
    response = {
        "status": "waiting",
        "mode": mode,
        "position": rank,
        "queue_size": queue_size,
        "wait_time": int(wait_time),
    }
    
    # Add MMR range info for ranked
    if mode == "ranked":
        response["mmr_range"] = get_mmr_range_for_wait_time(wait_time)
        response["player_mmr"] = player_data.get("mmr", 1000)
    
    return response


def try_create_match(mode: str, requesting_player_id: str, wait_time: float) -> Optional[dict]:
    """
    Attempt to create a match from the queue.
    
    For quick_play: FIFO matching, fills with AI after timeout
    For ranked: MMR-based matching, never adds AI
    
    Returns match info if created, None otherwise.
    """
    redis = get_redis()
    now = time.time()
    
    queue_key = _queue_key(mode)
    
    if mode == "quick_play":
        return _try_quick_play_match(redis, queue_key, requesting_player_id, wait_time, now)
    elif mode == "ranked":
        return _try_ranked_match(redis, queue_key, requesting_player_id, wait_time, now)
    
    return None


def _get_queue_players(redis, queue_key: str, mode: str) -> list:
    """Get all players in queue with their data."""
    try:
        # Get all player IDs from queue
        if mode == "quick_play":
            player_ids = redis.zrange(queue_key, 0, -1)
        else:
            # For ranked, get with scores (MMR)
            player_ids = redis.zrange(queue_key, 0, -1)
        
        if not player_ids:
            return []
        
        players = []
        for pid in player_ids:
            if isinstance(pid, bytes):
                pid = pid.decode()
            data_key = _queue_data_key(mode, pid)
            raw = redis.get(data_key)
            if raw:
                if isinstance(raw, bytes):
                    raw = raw.decode()
                try:
                    data = json.loads(raw)
                    data["player_id"] = pid
                    players.append(data)
                except Exception:
                    pass
        
        return players
    except Exception as e:
        print(f"[QUEUE] Error getting queue players: {e}")
        return []


def _try_quick_play_match(redis, queue_key: str, requesting_player_id: str, wait_time: float, now: float) -> Optional[dict]:
    """
    Try to create a quick play match.
    
    - If 4+ players: create match with first 4
    - If 30s timeout with 2-3 players: fill with AI
    - If 30s timeout with 1 player: fill with 3 AI
    """
    players = _get_queue_players(redis, queue_key, "quick_play")
    
    if len(players) >= QUEUE_MATCH_SIZE:
        # Have enough players - create match with first 4 (FIFO)
        players.sort(key=lambda p: p.get("joined_at", now))
        match_players = players[:QUEUE_MATCH_SIZE]
        return _create_match_from_queue(redis, "quick_play", match_players, ai_fill=0)
    
    # Check if timeout reached
    if wait_time >= QUEUE_QUICK_PLAY_TIMEOUT and len(players) >= 1:
        # Find the requesting player
        requesting_player = next((p for p in players if p.get("player_id") == requesting_player_id), None)
        if not requesting_player:
            return None
        
        # Check if requesting player has been waiting long enough
        player_wait = now - requesting_player.get("joined_at", now)
        if player_wait >= QUEUE_QUICK_PLAY_TIMEOUT:
            # Create match with available players + AI fill
            players.sort(key=lambda p: p.get("joined_at", now))
            match_players = players[:QUEUE_MATCH_SIZE]
            ai_fill = QUEUE_MATCH_SIZE - len(match_players)
            return _create_match_from_queue(redis, "quick_play", match_players, ai_fill=ai_fill)
    
    return None


def _try_ranked_match(redis, queue_key: str, requesting_player_id: str, wait_time: float, now: float) -> Optional[dict]:
    """
    Try to create a ranked match.
    
    - Groups players by MMR range
    - Expands range over time
    - Never adds AI - waits until 4 humans found
    """
    players = _get_queue_players(redis, queue_key, "ranked")
    
    if len(players) < QUEUE_MATCH_SIZE:
        return None
    
    # Find the requesting player
    requesting_player = next((p for p in players if p.get("player_id") == requesting_player_id), None)
    if not requesting_player:
        return None
    
    player_mmr = requesting_player.get("mmr", 1000)
    player_wait = now - requesting_player.get("joined_at", now)
    mmr_range = get_mmr_range_for_wait_time(player_wait)
    
    # Find players within MMR range of the requesting player
    candidates = []
    for p in players:
        p_mmr = p.get("mmr", 1000)
        if abs(p_mmr - player_mmr) <= mmr_range:
            candidates.append(p)
    
    if len(candidates) < QUEUE_MATCH_SIZE:
        return None
    
    # Check if all candidates are within range of each other
    # Find the best group of 4 with tightest MMR spread
    best_group = None
    best_spread = float('inf')
    
    # Simple greedy approach: sort by MMR and take consecutive groups
    candidates.sort(key=lambda p: p.get("mmr", 1000))
    
    for i in range(len(candidates) - QUEUE_MATCH_SIZE + 1):
        group = candidates[i:i + QUEUE_MATCH_SIZE]
        mmrs = [p.get("mmr", 1000) for p in group]
        spread = max(mmrs) - min(mmrs)
        
        # Check if requesting player is in this group
        if requesting_player_id not in [p.get("player_id") for p in group]:
            continue
        
        # Check if all players in group are within each other's expanded range
        all_compatible = True
        for p in group:
            p_wait = now - p.get("joined_at", now)
            p_range = get_mmr_range_for_wait_time(p_wait)
            for other in group:
                if abs(p.get("mmr", 1000) - other.get("mmr", 1000)) > p_range:
                    all_compatible = False
                    break
            if not all_compatible:
                break
        
        if all_compatible and spread < best_spread:
            best_spread = spread
            best_group = group
    
    if best_group:
        return _create_match_from_queue(redis, "ranked", best_group, ai_fill=0)
    
    return None


def _create_match_from_queue(redis, mode: str, players: list, ai_fill: int = 0) -> Optional[dict]:
    """
    Create a game from matched queue players.
    
    Args:
        redis: Redis client
        mode: 'quick_play' or 'ranked'
        players: List of player data dicts
        ai_fill: Number of AI players to add (quick_play only)
    """
    import random
    
    try:
        # Generate game code
        code = ''.join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(6))
        
        # Select random themes for voting
        available_themes = list(PREGENERATED_THEMES.keys())
        theme_options = random.sample(available_themes, min(3, len(available_themes)))
        
        # Determine time control
        is_ranked = mode == "ranked"
        is_quickplay = mode == "quick_play"
        time_control = get_time_control(is_ranked, "rapid", is_quickplay)
        
        # Create game
        game = {
            "code": code,
            "status": "waiting",
            "visibility": "public",
            "is_ranked": is_ranked,
            "is_singleplayer": False,
            "players": [],
            "current_turn": 0,
            "history": [],
            "theme": None,
            "theme_options": theme_options,
            "theme_votes": {},
            "host_id": None,
            "created_at": time.time(),
            "time_control": time_control,
            "word_selection_time": get_word_selection_time(is_ranked),
            "from_matchmaking": True,
            "matchmaking_mode": mode,
        }
        
        # Add human players
        for i, p_data in enumerate(players):
            player_id = p_data.get("player_id")
            session_token = generate_session_token(player_id, code)
            
            player = {
                "id": player_id,
                "name": p_data.get("player_name", f"Player{i+1}"),
                "secret_word": None,
                "is_alive": True,
                "is_ai": False,
                "is_ready": False,
                "cosmetics": p_data.get("cosmetics", {}),
                "time_remaining": time_control.get("initial_time", 0),
                "session_token": session_token,
            }
            
            # Add auth user ID if present
            if p_data.get("auth_user_id"):
                player["auth_user_id"] = p_data["auth_user_id"]
            
            game["players"].append(player)
            
            # First player is host
            if i == 0:
                game["host_id"] = player_id
        
        # Add AI players if needed (quick_play only)
        if ai_fill > 0 and mode == "quick_play":
            ai_difficulties = ["field-agent", "analyst", "spymaster", "rookie"]
            for i in range(ai_fill):
                difficulty = ai_difficulties[i % len(ai_difficulties)]
                ai_id = f"ai_{difficulty}_{secrets.token_hex(4)}"
                ai_config = AI_DIFFICULTY_CONFIG.get(difficulty, AI_DIFFICULTY_CONFIG.get("field-agent", {}))
                ai_name = f"{ai_config.get('name_prefix', 'AI')} {secrets.token_hex(2).upper()}"
                
                ai_player = {
                    "id": ai_id,
                    "name": ai_name,
                    "secret_word": None,
                    "is_alive": True,
                    "is_ai": True,
                    "ai_difficulty": difficulty,
                    "is_ready": False,
                    "cosmetics": {},
                    "time_remaining": time_control.get("initial_time", 0),
                }
                game["players"].append(ai_player)
        
        # Save game
        save_game(code, game)
        
        # Notify all players of the match
        queue_key = _queue_key(mode)
        for p_data in players:
            player_id = p_data.get("player_id")
            match_key = _queue_match_key(player_id)
            
            # Find player's session token
            player_in_game = next((p for p in game["players"] if p["id"] == player_id), None)
            session_token = player_in_game.get("session_token", "") if player_in_game else ""
            
            match_info = {
                "game_code": code,
                "player_id": player_id,
                "session_token": session_token,
            }
            redis.setex(match_key, 60, json.dumps(match_info))
            
            # Remove from queue
            redis.zrem(queue_key, player_id)
            data_key = _queue_data_key(mode, player_id)
            redis.delete(data_key)
        
        print(f"[QUEUE] Created {mode} match {code} with {len(players)} players + {ai_fill} AI")
        
        return {"game_code": code}
    
    except Exception as e:
        print(f"[QUEUE] Error creating match: {e}")
        import traceback
        print(f"[QUEUE] Traceback: {traceback.format_exc()}")
        return None


def check_ranked_eligibility(user: dict) -> tuple[bool, str]:
    """
    Check if a user is eligible for ranked matchmaking.
    
    Returns:
        (is_eligible, error_message)
    """
    if not user:
        return False, "Sign in with Google to play ranked"
    
    stats = get_user_stats(user)
    mp_games = stats.get("mp_games_played", 0)
    
    if mp_games < QUEUE_MIN_CASUAL_GAMES_FOR_RANKED:
        remaining = QUEUE_MIN_CASUAL_GAMES_FOR_RANKED - mp_games
        return False, f"Play {remaining} more casual game{'s' if remaining != 1 else ''} to unlock ranked"
    
    return True, ""


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
        """Best-effort check if the request is from an admin user (by email)."""
        try:
            payload = self._get_auth_payload()
            if not payload or not isinstance(payload, dict):
                return False
            email = str(payload.get('email') or '').strip().lower()
            if not email:
                return False
            admin_emails = [str(e).strip().lower() for e in (ADMIN_EMAILS or [])]
            return email in admin_emails
        except Exception:
            return False

    def _debug_allowed(self) -> bool:
        """Return True if we can safely return debug details to this client."""
        # SECURITY: In production, only admins can see debug info to prevent information leakage
        if os.getenv('VERCEL_ENV') == 'production':
            return self._is_admin_request()
        # In development, respect DEBUG_ERRORS setting or admin status
        return bool(DEBUG_ERRORS or self._is_admin_request())

    def _validate_player_session(self, body: dict, game_code: str) -> tuple:
        """
        Validate player session token from request body.
        
        Returns:
            (player_id, None) if valid
            (None, error_message) if invalid
        """
        player_id = body.get('player_id', '')
        session_token = body.get('session_token', '')
        
        # Validate player ID format (human or AI)
        if player_id.startswith('ai_'):
            validated_id = sanitize_ai_player_id(player_id)
            # AI players don't need session tokens - they're server-controlled
            if not validated_id:
                return None, "Invalid AI player ID format"
            return validated_id, None
        else:
            validated_id = sanitize_player_id(player_id)
            if not validated_id:
                return None, "Invalid player ID format"
        
        # SECURITY: Require valid session token for human players
        if not session_token:
            return None, "Session token required"
        
        if not verify_session_token(session_token, validated_id, game_code):
            return None, "Invalid or expired session token"
        
        return validated_id, None

    def _get_cors_origin(self):
        """Get the appropriate CORS origin header value."""
        origin = self.headers.get('Origin', '')
        if origin in ALLOWED_ORIGINS:
            return origin
        # Allow localhost in development
        if DEV_MODE and origin.startswith('http://localhost:'):
            return origin
        # SECURITY: Don't set CORS header for unknown origins (prevents confused deputy attacks)
        return ''

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

    def _build_game_response(self, game: dict, player_id: str, code: str) -> dict:
        """Build a standard game response for a player. Used by GET /api/games/{code} and POST endpoints."""
        try:
            game_finished = game['status'] == 'finished'
            all_words_set = all(p.get('secret_word') for p in game['players']) if game['players'] else False
            
            current_player_id = None
            if game['status'] == 'playing' and game['players'] and all_words_set:
                current_player_id = game['players'][game['current_turn']]['id']
            
            theme_data = game.get('theme') or {}
            theme_votes = game.get('theme_votes', {})
            theme_votes_with_names = {}
            for theme, voter_ids in theme_votes.items():
                voters = []
                for vid in voter_ids:
                    voter = next((p for p in game['players'] if p['id'] == vid), None)
                    if voter:
                        voters.append({"id": vid, "name": voter['name']})
                theme_votes_with_names[theme] = voters
            
            ready_count = sum(1 for p in game['players'] if p.get('is_ready', False))
            spectator_count = get_spectator_count(code)
            
            # Time control (chess clock model)
            time_control = game.get('time_control', {})
            initial_time = int(time_control.get('initial_time', 0) or 0)
            increment = int(time_control.get('increment', 0) or 0)
            
            # Calculate current player's time remaining
            current_player_time = None
            turn_started_at = game.get('turn_started_at')
            if initial_time > 0 and game['status'] == 'playing' and not game.get('waiting_for_word_change'):
                current_player = game['players'][game['current_turn']] if game['players'] else None
                if current_player and turn_started_at:
                    stored_time = current_player.get('time_remaining', initial_time)
                    elapsed = time.time() - turn_started_at
                    current_player_time = max(0, stored_time - elapsed)
            
            # Calculate word selection time remaining
            word_selection_time_remaining = None
            word_selection_started_at = game.get('word_selection_started_at')
            word_selection_time = game.get('word_selection_time', 0)
            if game['status'] == 'word_selection' and word_selection_started_at and word_selection_time > 0:
                elapsed = time.time() - word_selection_started_at
                word_selection_time_remaining = max(0, word_selection_time - elapsed)
            
            # Calculate word change time remaining (15 seconds to pick a new word after elimination)
            WORD_CHANGE_TIME_LIMIT = 30
            word_change_time_remaining = None
            word_change_started_at = game.get('word_change_started_at')
            if game.get('waiting_for_word_change') and word_change_started_at:
                elapsed = time.time() - word_change_started_at
                word_change_time_remaining = max(0, WORD_CHANGE_TIME_LIMIT - elapsed)
            
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
                "time_control": {
                    "initial_time": initial_time,
                    "increment": increment,
                },
                "current_player_time": current_player_time,
                "turn_started_at": turn_started_at,
                "word_selection_time": word_selection_time,
                "word_selection_time_remaining": word_selection_time_remaining,
                "word_change_time_remaining": word_change_time_remaining,
            }

            ranked_mmr = game.get('ranked_mmr') if isinstance(game.get('ranked_mmr'), dict) else None
            is_ranked_game = bool(game.get('is_ranked', False))
            
            for p in game['players']:
                # Calculate this player's time remaining
                player_time = p.get('time_remaining')
                if player_time is not None and p['id'] == current_player_id and turn_started_at:
                    # Current player's time is ticking
                    elapsed = time.time() - turn_started_at
                    player_time = max(0, player_time - elapsed)
                
                player_data = {
                    "id": p['id'],
                    "name": p['name'],
                    "secret_word": p['secret_word'] if (p['id'] == player_id or game_finished) else None,
                    "has_word": bool(p.get('secret_word')),
                    "is_alive": p['is_alive'],
                    "can_change_word": p.get('can_change_word', False) if p['id'] == player_id else None,
                    "is_ready": p.get('is_ready', False),
                    "cosmetics": p.get('cosmetics', {}),
                    "is_ai": p.get('is_ai', False),
                    "difficulty": p.get('difficulty'),
                    "time_remaining": player_time,
                }
                if game_finished and is_ranked_game and ranked_mmr:
                    mmr_entry = ranked_mmr.get(str(p.get('id')))
                    if isinstance(mmr_entry, dict):
                        player_data['mmr_before'] = mmr_entry.get('old')
                        player_data['mmr'] = mmr_entry.get('new')
                        player_data['mmr_delta'] = mmr_entry.get('delta')
                # Include MMR display info for ranked games (during game, not just at end)
                if is_ranked_game and not p.get('is_ai'):
                    auth_uid = p.get('auth_user_id')
                    if auth_uid:
                        try:
                            u = get_user_by_id(auth_uid)
                            if u:
                                u_stats = get_user_stats(u)
                                player_data['mmr_display'] = {
                                    'mmr': int(u_stats.get('mmr', 1000) or 1000),
                                    'ranked_games': int(u_stats.get('ranked_games', 0) or 0),
                                }
                        except Exception:
                            pass
                if p['id'] == player_id:
                    player_data['word_pool'] = p.get('word_pool', [])
                    if p.get('word_change_options') is not None:
                        player_data['word_change_options'] = p.get('word_change_options', [])
                response['players'].append(player_data)
            
            return response
        except Exception as e:
            print(f"Error building game response: {e}")
            return None

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

            # Helper to redirect back to frontend with error/success params
            def _redirect_frontend(params: dict, return_to: str = ''):
                qs = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None and v != ''})
                # SECURITY: Validate return_to against allowed origins to prevent open redirect
                if return_to:
                    valid_return = False
                    for allowed in ALLOWED_ORIGINS:
                        if return_to.startswith(allowed):
                            valid_return = True
                            break
                    # Also allow localhost in dev mode
                    if DEV_MODE and return_to.startswith('http://localhost:'):
                        valid_return = True
                    if not valid_return:
                        print(f"[SECURITY] OAuth callback: rejecting untrusted return_to URL: {return_to[:100]}")
                        return_to = ''  # Fall back to relative redirect
                
                if return_to:
                    target = return_to.rstrip('/') + '/?' + qs
                else:
                    target = '/?' + qs
                self.send_response(302)
                self.send_header('Location', target)
                self.end_headers()

            # SECURITY: State parameter is MANDATORY to prevent CSRF attacks
            if not state:
                print("[SECURITY] OAuth callback: missing state parameter")
                return _redirect_frontend({'auth_error': 'missing_state'})

            # Validate and consume the state token (single-use)
            redirect_uri = get_oauth_redirect_uri()
            return_to = ''
            try:
                redis = get_redis()
                raw = redis.get(f"oauth_state:{state}")
                if not raw:
                    print(f"[SECURITY] OAuth callback: invalid or expired state token")
                    return _redirect_frontend({'auth_error': 'invalid_state'})
                data = json.loads(raw)
                redirect_uri = data.get('redirect_uri') or redirect_uri
                return_to = data.get('return_to') or ''
                # SECURITY: Delete state immediately (single-use token)
                redis.delete(f"oauth_state:{state}")
            except Exception as e:
                print(f"[SECURITY] OAuth state validation failed: {e}")
                return _redirect_frontend({'auth_error': 'state_validation_failed'})
            
            if error:
                return _redirect_frontend({
                    'auth_error': error,
                    'auth_error_description': query.get('error_description', ''),
                }, return_to)
            
            if not code:
                return _redirect_frontend({'auth_error': 'no_code'}, return_to)
            
            try:
                if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
                    return _redirect_frontend({'auth_error': 'oauth_not_configured'}, return_to)

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
                    }, return_to)
                
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
                    }, return_to)
                
                google_user = userinfo_response.json()
                
                # Create or get user
                user = get_or_create_user(google_user)
                
                # Create JWT token
                jwt_token = create_jwt_token(user)
                
                # Redirect to frontend with token
                return _redirect_frontend({'auth_token': jwt_token}, return_to)
                
            except Exception as e:
                print(f"OAuth callback error: {e}")
                return _redirect_frontend({'auth_error': 'callback_failed'}, return_to)

        # GET /api/auth/me - Get current user info
        if path == '/api/auth/me':
            auth_header = self.headers.get('Authorization', '')
            if not auth_header.startswith('Bearer '):
                return self._send_error("Not authenticated", 401)
            
            token = auth_header[7:]  # Remove 'Bearer ' prefix
            payload = verify_jwt_token(token)
            
            if not payload:
                return self._send_error("Invalid or expired token", 401)
            
            user = get_user_by_id(payload['sub'])
            if not user:
                return self._send_error("User not found", 404)
            
            username = user.get('username')
            
            return self._send_json({
                'id': user['id'],
                'name': user['name'],
                'username': username,
                'needs_username': username is None,  # True if user hasn't set a username yet
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

        # GET /api/queue/status - Get queue status and check for matches
        if path == '/api/queue/status':
            mode = (query.get('mode', '') or '').strip().lower()
            player_id = (query.get('player_id', '') or '').strip()
            
            if mode not in ('quick_play', 'ranked'):
                return self._send_error("Invalid mode. Use 'quick_play' or 'ranked'", 400)
            
            if not player_id:
                return self._send_error("player_id required", 400)
            
            # Validate player_id format
            validated_id = sanitize_player_id(player_id)
            if not validated_id:
                return self._send_error("Invalid player_id format", 400)
            
            status = get_queue_status(mode, validated_id)
            return self._send_json(status)

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
                
                # Skip non-Google authenticated users (bots, etc.)
                if not uid.startswith('google_'):
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
                
                # Filter out unplaced players (must complete placement games to appear on leaderboard)
                ranked_games = int(stats.get('ranked_games', 0) or 0)
                if ranked_games < RANKED_PLACEMENT_GAMES:
                    continue
                
                players.append({
                    "rank": rank,
                    "id": user.get('id'),
                    "name": get_user_display_name(user),
                    "avatar": user.get('avatar', ''),
                    "mmr": int(stats.get('mmr', mmr) or mmr),
                    "peak_mmr": int(stats.get('peak_mmr', mmr) or mmr),
                    "ranked_games": ranked_games,
                    "ranked_wins": int(stats.get('ranked_wins', 0) or 0),
                    "ranked_losses": int(stats.get('ranked_losses', 0) or 0),
                })
                rank += 1

            return self._send_json({
                "players": players,
                "type": "ranked",
            })

        # GET /api/profile/:name - Get player profile and stats
        if path.startswith('/api/profile/'):
            # Rate limit: 30/min for profile lookups
            if not check_rate_limit(get_ratelimit_general(), f"profile:{client_ip}"):
                return self._send_error("Too many requests. Please wait.", 429)
            
            player_name = path[len('/api/profile/'):]
            if not player_name:
                return self._send_error("Player name required", 400)
            
            # URL decode the name
            player_name = urllib.parse.unquote(player_name)
            
            # Get casual stats by name
            stats = get_player_stats(player_name)
            
            # Check if this player has a linked Google account (search users)
            redis = get_redis()
            user_data = None
            ranked_stats = None
            created_at = None
            
            # Try to find a Google user with this name
            all_user_ids = redis.smembers('users:all') or []
            for uid in all_user_ids:
                if isinstance(uid, bytes):
                    try:
                        uid = uid.decode()
                    except Exception:
                        continue
                user = get_user_by_id(uid)
                if user and user.get('name', '').lower() == player_name.lower():
                    user_data = user
                    created_at = user.get('created_at')
                    u_stats = get_user_stats(user)
                    if u_stats.get('ranked_games', 0) > 0:
                        ranked_stats = {
                            "mmr": int(u_stats.get('mmr', 1000) or 1000),
                            "peak_mmr": int(u_stats.get('peak_mmr', 1000) or 1000),
                            "ranked_games": int(u_stats.get('ranked_games', 0) or 0),
                            "ranked_wins": int(u_stats.get('ranked_wins', 0) or 0),
                            "ranked_losses": int(u_stats.get('ranked_losses', 0) or 0),
                        }
                    break
            
            # Calculate win rate
            games = stats.get('games_played', 0)
            wins = stats.get('wins', 0)
            win_rate = round((wins / games * 100), 1) if games > 0 else 0
            
            # Get cosmetics from user if available
            cosmetics = None
            badge = None
            avatar = None
            custom_avatar = None
            if user_data:
                cosmetics = user_data.get('cosmetics', {})
                badge = cosmetics.get('badge') if cosmetics.get('badge') != 'none' else None
                # Check for custom emoji avatar
                profile_avatar = cosmetics.get('profile_avatar', 'default')
                if profile_avatar and profile_avatar != 'default':
                    # Load avatar icon from cosmetics catalog
                    try:
                        with open(os.path.join(os.path.dirname(__file__), 'cosmetics.json'), 'r') as f:
                            catalog = json.load(f)
                        avatar_data = catalog.get('profile_avatars', {}).get(profile_avatar, {})
                        custom_avatar = avatar_data.get('icon', '')
                    except Exception:
                        pass
                # Fall back to Google avatar if no custom avatar
                if not custom_avatar:
                    avatar = user_data.get('avatar', '')
            
            return self._send_json({
                "name": stats.get('name', player_name),
                "wins": wins,
                "games_played": games,
                "win_rate": win_rate,
                "eliminations": stats.get('eliminations', 0),
                "times_eliminated": stats.get('times_eliminated', 0),
                "best_streak": stats.get('best_streak', 0),
                "created_at": created_at,  # None if not a Google user
                "has_google_account": user_data is not None,
                "avatar": avatar,
                "custom_avatar": custom_avatar,  # Emoji avatar (takes precedence over Google avatar)
                "badge": badge,
                "cosmetics": cosmetics,
                "ranked": ranked_stats,
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
                
                # Time control (chess clock model) for spectators
                time_control = game.get('time_control', {})
                initial_time = int(time_control.get('initial_time', 0) or 0)
                increment = int(time_control.get('increment', 0) or 0)
                
                current_player_time = None
                turn_started_at = game.get('turn_started_at')
                if initial_time > 0 and game['status'] == 'playing' and not game.get('waiting_for_word_change'):
                    current_p = game['players'][game['current_turn']] if game.get('players') else None
                    if current_p and turn_started_at:
                        stored_time = current_p.get('time_remaining', initial_time)
                        elapsed = time.time() - turn_started_at
                        current_player_time = max(0, stored_time - elapsed)
                
                # Calculate word selection time remaining
                word_selection_time_remaining = None
                word_selection_started_at = game.get('word_selection_started_at')
                word_selection_time = game.get('word_selection_time', 0)
                if game['status'] == 'word_selection' and word_selection_started_at and word_selection_time > 0:
                    elapsed = time.time() - word_selection_started_at
                    word_selection_time_remaining = max(0, word_selection_time - elapsed)
                
                # Calculate word change time remaining (15 seconds to pick a new word after elimination)
                WORD_CHANGE_TIME_LIMIT = 30
                word_change_time_remaining = None
                word_change_started_at = game.get('word_change_started_at')
                if game.get('waiting_for_word_change') and word_change_started_at:
                    elapsed = time.time() - word_change_started_at
                    word_change_time_remaining = max(0, WORD_CHANGE_TIME_LIMIT - elapsed)
                
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
                    "time_control": {
                        "initial_time": initial_time,
                        "increment": increment,
                    },
                    "current_player_time": current_player_time,
                    "turn_started_at": turn_started_at,
                    "word_selection_time": word_selection_time,
                    "word_selection_time_remaining": word_selection_time_remaining,
                    "word_change_time_remaining": word_change_time_remaining,
                }
                
                for p in game.get('players', []):
                    # Calculate this player's time remaining
                    player_time = p.get('time_remaining')
                    if player_time is not None and p.get('id') == current_player_id and turn_started_at:
                        elapsed = time.time() - turn_started_at
                        player_time = max(0, player_time - elapsed)
                    
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
                        "time_remaining": player_time,
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
                
                # Time control (chess clock model)
                time_control = game.get('time_control', {})
                initial_time = int(time_control.get('initial_time', 0) or 0)
                increment = int(time_control.get('increment', 0) or 0)
                
                # Calculate current player's time remaining
                current_player_time = None
                turn_started_at = game.get('turn_started_at')
                if initial_time > 0 and game['status'] == 'playing' and not game.get('waiting_for_word_change'):
                    current_p = game['players'][game['current_turn']] if game['players'] else None
                    if current_p and turn_started_at:
                        stored_time = current_p.get('time_remaining', initial_time)
                        elapsed = time.time() - turn_started_at
                        current_player_time = max(0, stored_time - elapsed)
                
                # Calculate word selection time remaining
                word_selection_time_remaining = None
                word_selection_started_at = game.get('word_selection_started_at')
                word_selection_time = game.get('word_selection_time', 0)
                if game['status'] == 'word_selection' and word_selection_started_at and word_selection_time > 0:
                    elapsed = time.time() - word_selection_started_at
                    word_selection_time_remaining = max(0, word_selection_time - elapsed)
                
                # Calculate word change time remaining (15 seconds to pick a new word after elimination)
                WORD_CHANGE_TIME_LIMIT = 30
                word_change_time_remaining = None
                word_change_started_at = game.get('word_change_started_at')
                if game.get('waiting_for_word_change') and word_change_started_at:
                    elapsed = time.time() - word_change_started_at
                    word_change_time_remaining = max(0, WORD_CHANGE_TIME_LIMIT - elapsed)
                
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
                    "time_control": {
                        "initial_time": initial_time,
                        "increment": increment,
                    },
                    "current_player_time": current_player_time,
                    "turn_started_at": turn_started_at,
                    "word_selection_time": word_selection_time,
                    "word_selection_time_remaining": word_selection_time_remaining,
                    "word_change_time_remaining": word_change_time_remaining,
                }

                # Ranked: include per-game MMR results on finished games (so clients can display deltas).
                ranked_mmr = game.get('ranked_mmr') if isinstance(game.get('ranked_mmr'), dict) else None
                is_ranked_game = bool(game.get('is_ranked', False))
                
                for p in game['players']:
                    # Calculate this player's time remaining
                    player_time = p.get('time_remaining')
                    if player_time is not None and p['id'] == current_player_id and turn_started_at:
                        # Current player's time is ticking
                        elapsed = time.time() - turn_started_at
                        player_time = max(0, player_time - elapsed)
                    
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
                        "time_remaining": player_time,
                    }
                    if game_finished and is_ranked_game and ranked_mmr:
                        mmr_entry = ranked_mmr.get(str(p.get('id')))
                        if isinstance(mmr_entry, dict):
                            player_data['mmr_before'] = mmr_entry.get('old')
                            player_data['mmr'] = mmr_entry.get('new')
                            player_data['mmr_delta'] = mmr_entry.get('delta')
                    # Include MMR display info for ranked games (during game, not just at end)
                    if is_ranked_game and not p.get('is_ai'):
                        auth_uid = p.get('auth_user_id')
                        if auth_uid:
                            try:
                                u = get_user_by_id(auth_uid)
                                if u:
                                    u_stats = get_user_stats(u)
                                    player_data['mmr_display'] = {
                                        'mmr': int(u_stats.get('mmr', 1000) or 1000),
                                        'ranked_games': int(u_stats.get('ranked_games', 0) or 0),
                                    }
                            except Exception:
                                pass
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

        # POST /api/queue/join - Join matchmaking queue
        if path == '/api/queue/join':
            # Rate limit: 10/min for queue joins
            if not check_rate_limit(get_ratelimit_general(), f"queue_join:{client_ip}"):
                return self._send_error("Too many requests. Please wait.", 429)
            
            mode = (body.get('mode', '') or '').strip().lower()
            player_name = (body.get('player_name', '') or '').strip()
            
            if mode not in ('quick_play', 'ranked'):
                return self._send_error("Invalid mode. Use 'quick_play' or 'ranked'", 400)
            
            if not player_name:
                return self._send_error("player_name required", 400)
            
            # Sanitize player name
            sanitized_name = sanitize_player_name(player_name)
            if not sanitized_name:
                return self._send_error("Invalid player name", 400)
            
            # Generate a player ID for this queue session
            player_id = secrets.token_hex(16)
            
            # Get auth info
            auth_user_id = self._get_auth_user_id()
            auth_user = None
            mmr = RANKED_INITIAL_MMR
            cosmetics = {}
            
            if auth_user_id:
                auth_user = get_user_by_id(auth_user_id)
                if auth_user:
                    stats = get_user_stats(auth_user)
                    mmr = stats.get('mmr', RANKED_INITIAL_MMR)
                    cosmetics = get_user_cosmetics(auth_user)
            
            # Ranked eligibility check
            if mode == 'ranked':
                if not auth_user_id:
                    return self._send_error("Sign in with Google to play ranked", 401)
                
                if not auth_user:
                    return self._send_error("User not found", 404)
                
                is_eligible, error_msg = check_ranked_eligibility(auth_user)
                if not is_eligible:
                    return self._send_json({
                        "status": "ineligible",
                        "message": error_msg,
                        "games_required": QUEUE_MIN_CASUAL_GAMES_FOR_RANKED,
                        "games_played": get_user_stats(auth_user).get('mp_games_played', 0),
                    }, 403)
            
            # Join queue
            result = join_matchmaking_queue(
                mode=mode,
                player_id=player_id,
                player_name=sanitized_name,
                auth_user_id=auth_user_id,
                mmr=mmr,
                cosmetics=cosmetics,
            )
            
            # Include player_id in response so client can poll status
            result["player_id"] = player_id
            
            return self._send_json(result)

        # POST /api/queue/leave - Leave matchmaking queue
        if path == '/api/queue/leave':
            mode = (body.get('mode', '') or '').strip().lower()
            player_id = (body.get('player_id', '') or '').strip()
            
            if mode not in ('quick_play', 'ranked'):
                return self._send_error("Invalid mode", 400)
            
            if not player_id:
                return self._send_error("player_id required", 400)
            
            validated_id = sanitize_player_id(player_id)
            if not validated_id:
                return self._send_error("Invalid player_id format", 400)
            
            success = leave_matchmaking_queue(mode, validated_id)
            return self._send_json({"status": "left" if success else "error"})

        # POST /api/games - Create lobby with theme voting
        if path == '/api/games':
            # Rate limit: 5 games/min per IP
            if not check_rate_limit(get_ratelimit_game_create(), client_ip):
                return self._send_error("Too many game creations. Please wait.", 429)
            
            import random

            # Lobby metadata (defaults tuned for friend-code flow)
            requested_visibility = sanitize_visibility(body.get('visibility', 'private'), default='private')
            requested_ranked = parse_bool(body.get('is_ranked', False), default=False)
            
            # Time control preset for casual games (ignored for ranked)
            time_control_preset = str(body.get('time_control', 'rapid') or 'rapid').lower()
            if time_control_preset not in CASUAL_TIME_PRESETS:
                time_control_preset = 'rapid'

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
            
            # Get time control settings
            time_control = get_time_control(requested_ranked, time_control_preset)
            
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
                "time_control": time_control,
                "turn_started_at": None,  # Set when game starts playing
            }
            save_game(code, game)
            return self._send_json({
                "code": code,
                "theme_options": theme_options,
                "visibility": requested_visibility,
                "is_ranked": bool(requested_ranked),
                "time_control": time_control,
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
                "time_control": get_time_control(False, "default"),
                "turn_started_at": None,
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
                "time_control": get_time_control(False, "none"),  # No time limit in singleplayer
                "turn_started_at": None,
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
            
            # SECURITY: Validate player session token
            player_id, session_error = self._validate_player_session(body, code)
            if session_error:
                return self._send_error(session_error, 403)
            
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
            
            # SECURITY: Validate player session token
            player_id, session_error = self._validate_player_session(body, code)
            if session_error:
                return self._send_error(session_error, 403)
            
            # Verify requester is the host
            if game['host_id'] != player_id:
                return self._send_error("Only the host can remove AI players", 403)
            
            ai_id = sanitize_ai_player_id(body.get('ai_id', ''))
            if not ai_id:
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
            
            # SECURITY: Validate player session token
            player_id, session_error = self._validate_player_session(body, code)
            if session_error:
                return self._send_error(session_error, 403)
            
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
            
            # Return immediately with updated votes, save in background
            response_votes = game['theme_votes']
            
            # Fire-and-forget save (don't block response)
            import threading
            def save_async():
                try:
                    save_game(code, game)
                except Exception as e:
                    print(f"Async vote save error: {e}")
            threading.Thread(target=save_async, daemon=True).start()
            
            return self._send_json({"status": "voted", "theme_votes": response_votes})

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

            # SECURITY: Validate player session token
            player_id, session_error = self._validate_player_session(body, code)
            if session_error:
                return self._send_error(session_error, 403)

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

                # SECURITY: Validate player session token
                player_id, session_error = self._validate_player_session(body, code)
                if session_error:
                    return self._send_error(session_error, 403)

                # Rate limit: 20 messages/min per player (best-effort)
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

            # SECURITY: Determine authenticated user from JWT only (no body fallback to prevent identity spoofing)
            token_user_id = self._get_auth_user_id()
            auth_user_id = token_user_id

            # Ranked games require JWT-authenticated identity
            if is_ranked and not token_user_id:
                return self._send_error("Ranked games require Google sign-in", 401)
            if is_ranked:
                auth_user_id = token_user_id  # Never trust body for ranked
            
            name = sanitize_player_name(body.get('name', ''))
            if not name:
                return self._send_error("Invalid name. Use only letters, numbers, underscores, and spaces (1-20 chars)", 400)
            
            # Get user cosmetics if authenticated
            user_cosmetics = None
            if auth_user_id:
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
                # Generate new session token for rejoin
                session_token = generate_session_token(existing_player['id'], code)
                # Allow rejoin - return their player_id
                return self._send_json({
                    "player_id": existing_player['id'],
                    "session_token": session_token,
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
            # Generate session token for new player
            session_token = generate_session_token(player_id, code)
            return self._send_json({
                "player_id": player_id,
                "session_token": session_token,
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
            
            # SECURITY: Validate player session token
            player_id, session_error = self._validate_player_session(body, code)
            if session_error:
                return self._send_error(session_error, 403)
            
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
            
            # SECURITY: Validate player session token
            player_id, session_error = self._validate_player_session(body, code)
            if session_error:
                return self._send_error(session_error, 403)
            
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
            
            # Word is from player's pool, which came from theme words pre-cached in /start
            # No need to verify embedding exists - it's guaranteed to be in cache
            
            player['secret_word'] = secret_word.lower()
            # NOTE: We don't store secret_embedding anymore - it's in Redis cache as emb:{word}
            
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
            
            # SECURITY: Validate player session token
            player_id, session_error = self._validate_player_session(body, code)
            if session_error:
                return self._send_error(session_error, 403)
            
            if game['host_id'] != player_id:
                return self._send_error("Only the host can start", 403)
            if game['status'] != 'waiting':
                return self._send_error("Game already started", 400)
            
            # Check if it's singleplayer
            is_singleplayer = game.get('is_singleplayer', False)
            
            # Singleplayer needs at least 2 players (1 human + 1 AI)
            if is_singleplayer:
                if len(game['players']) < 2:
                    return self._send_error("Add at least 1 AI opponent", 400)
            elif len(game['players']) < MIN_PLAYERS:
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
                            if not uid:
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
            game['word_selection_started_at'] = time.time()  # Start word selection timer
            game['word_selection_time'] = get_word_selection_time(bool(game.get('is_ranked', False)))
            
            # Pre-cache theme embeddings in Redis BLOCKING
            # This ensures word selection is instant (cache hits only)
            theme_words = game.get('theme', {}).get('words', [])
            if theme_words:
                try:
                    batch_get_embeddings(theme_words)
                except Exception as e:
                    print(f"Theme embedding pre-cache error (start): {e}")
            
            # Save game state (fire-and-forget to reduce latency)
            theme_name = game['theme']['name']
            import threading
            def save_async():
                try:
                    save_game(code, game)
                except Exception as e:
                    print(f"Async start save error: {e}")
            threading.Thread(target=save_async, daemon=True).start()
            
            return self._send_json({"status": "word_selection", "theme": theme_name})

        # POST /api/games/{code}/begin - Start the actual game after word selection
        if '/begin' in path:
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            
            # SECURITY: Validate player session token
            player_id, session_error = self._validate_player_session(body, code)
            if session_error:
                return self._send_error(session_error, 403)
            
            if game['host_id'] != player_id:
                return self._send_error("Only the host can begin", 403)
            if game['status'] != 'word_selection':
                return self._send_error(f"Game not in word selection phase (status={game['status']})", 400)

            # Singleplayer safety: if AIs haven't picked yet, pick them now (fallback for slow clients / many AIs)
            if game.get('is_singleplayer'):
                for p in game.get('players', []):
                    if not p.get('is_ai'):
                        continue
                    if p.get('secret_word'):
                        continue
                    pool = p.get('word_pool', []) or game.get('theme', {}).get('words', [])
                    if not pool:
                        continue
                    selected_word = ai_select_secret_word(p, pool)
                    if not selected_word:
                        continue
                    try:
                        get_embedding(selected_word)  # Ensure it's cached
                        p['secret_word'] = selected_word.lower()
                    except Exception as e:
                        print(f"AI word selection error (begin): {e}")
            
            # Check all players have set their words
            not_ready = [p['name'] for p in game['players'] if not p.get('secret_word')]
            if not_ready:
                print(f"[BEGIN DEBUG] Game {code} not ready - waiting for: {not_ready}")
                print(f"[BEGIN DEBUG] Players: {[(p['name'], bool(p.get('secret_word'))) for p in game['players']]}")
                return self._send_error(f"Waiting for: {', '.join(not_ready)}", 400)
            
            # Randomize turn order for multiplayer so the host doesn't always go first.
            # (Singleplayer stays deterministic: the human host starts.)
            if not game.get('is_singleplayer'):
                import random
                random.shuffle(game['players'])
                game['current_turn'] = 0

            # Initialize time_remaining for all players (chess clock model)
            time_control = game.get('time_control', {})
            initial_time = int(time_control.get('initial_time', 0) or 0)
            for p in game['players']:
                p['time_remaining'] = initial_time

            # Embeddings should already be cached from /start phase
            # Pre-compute similarity matrix in background if not already done
            # (This is fast if embeddings are cached, ~100ms for 100 words)
            theme_words = game.get('theme', {}).get('words', [])
            if theme_words and not game.get('theme_similarity_matrix'):
                import threading
                def compute_similarity_matrix():
                    try:
                        theme_embeddings = batch_get_embeddings(theme_words)
                        if theme_embeddings:
                            matrix = precompute_theme_similarities(game, theme_embeddings)
                            # Update game state with matrix (need to reload/save)
                            g = load_game(code)
                            if g and not g.get('theme_similarity_matrix'):
                                g['theme_similarity_matrix'] = matrix
                                save_game(code, g)
                    except Exception as e:
                        print(f"Theme similarity matrix error: {e}")
                threading.Thread(target=compute_similarity_matrix, daemon=True).start()

            game['status'] = 'playing'
            game['turn_started_at'] = time.time()  # Start the turn timer
            save_game(code, game)
            return self._send_json({"status": "playing"})

        # POST /api/games/{code}/word-selection-timeout - Auto-assign random words when time expires
        if '/word-selection-timeout' in path and path.startswith('/api/games/'):
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game['status'] != 'word_selection':
                return self._send_error("Game not in word selection phase", 400)
            
            # Verify the word selection time has actually expired (server-authoritative)
            word_selection_started_at = game.get('word_selection_started_at')
            word_selection_time = game.get('word_selection_time', 0)
            
            if not word_selection_started_at or word_selection_time <= 0:
                return self._send_error("No word selection timer for this game", 400)
            
            elapsed = time.time() - word_selection_started_at
            # Allow 2 second grace period for network latency
            if elapsed < word_selection_time - 2:
                return self._send_json({
                    "timeout": False,
                    "time_remaining": word_selection_time - elapsed,
                    "message": "Word selection time has not expired yet",
                })
            
            import random
            
            # Auto-assign random words to players who haven't picked
            auto_assigned = []
            for p in game['players']:
                if p.get('secret_word'):
                    continue  # Already has a word
                
                # For AI players, use their AI selection logic
                if p.get('is_ai'):
                    pool = p.get('word_pool', []) or game.get('theme', {}).get('words', [])
                    if pool:
                        selected_word = ai_select_secret_word(p, pool)
                        if selected_word:
                            try:
                                get_embedding(selected_word)  # Ensure cached
                                p['secret_word'] = selected_word.lower()
                                auto_assigned.append({"id": p['id'], "name": p['name'], "is_ai": True})
                            except Exception as e:
                                print(f"AI word selection error (timeout): {e}")
                    continue
                
                # For human players, pick a random word from their pool
                pool = p.get('word_pool', [])
                if pool:
                    selected_word = random.choice(pool)
                    try:
                        get_embedding(selected_word)  # Ensure cached
                        p['secret_word'] = selected_word.lower()
                        auto_assigned.append({"id": p['id'], "name": p['name'], "is_ai": False})
                    except Exception as e:
                        print(f"Auto-assign word error (timeout): {e}")
            
            save_game(code, game)
            
            # Check if all players now have words
            all_ready = all(p.get('secret_word') for p in game['players'])
            
            return self._send_json({
                "timeout": True,
                "auto_assigned": auto_assigned,
                "all_ready": all_ready,
            })

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
            
            # SECURITY: Validate player session token
            player_id, session_error = self._validate_player_session(body, code)
            if session_error:
                return self._send_error(session_error, 403)
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
                if p.get('secret_word'):
                    continue
                pool = p.get('word_pool', []) or game.get('theme', {}).get('words', [])
                if not pool:
                    continue
                selected_word = ai_select_secret_word(p, pool)
                if not selected_word:
                    continue
                try:
                    get_embedding(selected_word)  # Ensure cached
                    p['secret_word'] = selected_word.lower()
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

        # POST /api/games/{code}/ai-step - Singleplayer: process ALL AI turns until human turn or game over
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
            
            # SECURITY: Validate player session token
            player_id, session_error = self._validate_player_session(body, code)
            if session_error:
                return self._send_error(session_error, 403)
            if game.get('host_id') != player_id:
                return self._send_error("Only the host can trigger AI turns", 403)
            
            # Ensure it's actually an AI's turn
            if not game.get('players'):
                return self._send_error("No players in game", 400)
            
            current_player = game['players'][game['current_turn']]
            if not current_player.get('is_ai'):
                return self._send_error("Not an AI turn", 400)
            
            # Process ALL AI turns until it's human's turn or game over
            max_ai_turns = len(game['players']) * 2  # Safety limit
            turns_processed = 0
            
            while turns_processed < max_ai_turns:
                current_ai = game['players'][game['current_turn']]
                
                # Stop if not AI turn
                if not current_ai.get('is_ai'):
                    break
                
                # Skip dead AI
                if not current_ai.get('is_alive'):
                    num_players = len(game['players'])
                    next_turn = (game['current_turn'] + 1) % num_players
                    while not game['players'][next_turn].get('is_alive'):
                        next_turn = (next_turn + 1) % num_players
                    game['current_turn'] = next_turn
                    continue
                
                # Process AI turn
                ai_result = process_ai_turn(game, current_ai)
                if not ai_result:
                    break
                
                turns_processed += 1
                
                # If AI eliminated someone, auto-handle its word change immediately
                if ai_result.get('eliminations') and current_ai.get('can_change_word'):
                    process_ai_word_change(game, current_ai)
                
                # Check for game over
                alive_players = [p for p in game['players'] if p.get('is_alive')]
                if len(alive_players) <= 1:
                    game['status'] = 'finished'
                    if alive_players:
                        game['winner'] = alive_players[0]['id']
                    update_game_stats(game)
                    break
                
                # Advance turn
                num_players = len(game['players'])
                next_turn = (game['current_turn'] + 1) % num_players
                while not game['players'][next_turn].get('is_alive'):
                    next_turn = (next_turn + 1) % num_players
                game['current_turn'] = next_turn
                game['turn_started_at'] = time.time()
            
            save_game(code, game)
            
            # Return full game state
            game_response = self._build_game_response(game, player_id, code)
            if game_response:
                return self._send_json(game_response)
            
            return self._send_json({"status": "ai_step_batch", "turns_processed": turns_processed})

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
            
            # SECURITY: Validate player session token
            player_id, session_error = self._validate_player_session(body, code)
            if session_error:
                return self._send_error(session_error, 403)
            
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
                # Look up secret embedding from cache (not stored in player object)
                secret_word = p.get('secret_word')
                if not secret_word:
                    continue
                try:
                    secret_emb = get_embedding(secret_word)
                    sim = cosine_similarity(guess_embedding, secret_emb)
                    similarities[p['id']] = round(sim, 4)
                except Exception:
                    # Fallback to stored embedding if cache miss (legacy games)
                    if p.get('secret_embedding'):
                        sim = cosine_similarity(guess_embedding, p['secret_embedding'])
                        similarities[p['id']] = round(sim, 4)
            
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
                game['word_change_started_at'] = time.time()  # Start 30-second word change timer
            
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
            
            # Update AI memories and reactions with this guess (for singleplayer games)
            ai_reactions = []
            if game.get('is_singleplayer'):
                for p in game['players']:
                    if p.get('is_ai'):
                        ai_update_memory(p, word, similarities, game)
                        
                        # Track grudges against the guesser
                        their_sim = similarities.get(p['id'], 0)
                        if their_sim > 0.5:
                            _ai_update_grudge(p, player_id, their_sim)
                            _ai_update_confidence(p, "got_targeted", their_sim)
                        
                        # Generate AI reactions
                        if p['id'] in eliminations:
                            # AI got eliminated - generate reaction
                            _ai_update_streak(p, "got_eliminated")
                            chat_msg = _ai_generate_chat_message(p, "got_eliminated")
                            if chat_msg:
                                ai_reactions.append({
                                    "ai_name": p.get('name', 'AI'),
                                    "message": chat_msg,
                                })
                        elif their_sim > 0.65:
                            # Near miss - AI might react
                            chat_msg = _ai_generate_chat_message(p, "near_miss")
                            if chat_msg:
                                ai_reactions.append({
                                    "ai_name": p.get('name', 'AI'),
                                    "message": chat_msg,
                                })
            
            # Advance turn (but game is paused if waiting for word change)
            alive_players = [p for p in game['players'] if p['is_alive']]
            game_over = False
            
            # Deduct elapsed time from current player and add increment (chess clock)
            time_control = game.get('time_control', {})
            increment = int(time_control.get('increment', 0) or 0)
            turn_started_at = game.get('turn_started_at')
            if turn_started_at and player.get('time_remaining') is not None:
                elapsed = time.time() - turn_started_at
                player['time_remaining'] = max(0, player['time_remaining'] - elapsed + increment)
            
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
                # Reset turn timer for new player (unless waiting for word change)
                if not game.get('waiting_for_word_change'):
                    game['turn_started_at'] = time.time()
            
            save_game(code, game)
            
            # Return full game state to avoid client needing a second fetch
            game_response = self._build_game_response(game, player_id, code)
            if game_response:
                # Include AI reactions if any (singleplayer only)
                if ai_reactions:
                    game_response['ai_reactions'] = ai_reactions
                return self._send_json(game_response)
            
            # Fallback to minimal response if helper fails
            response = {
                "similarities": similarities,
                "eliminations": eliminations,
                "game_over": game_over,
                "winner": game.get('winner'),
                "waiting_for_word_change": game.get('waiting_for_word_change'),
            }
            if ai_reactions:
                response['ai_reactions'] = ai_reactions
            
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
            
            # SECURITY: Validate player session token
            player_id, session_error = self._validate_player_session(body, code)
            if session_error:
                return self._send_error(session_error, 403)
            
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
            
            # If we offered a random sample for this word change, enforce it (takes priority over word pool).
            offered = player.get('word_change_options')
            if offered:
                offered_lower = [str(w).lower() for w in offered]
                if new_word.lower() not in offered_lower:
                    return self._send_error("Please choose a word from the offered sample", 400)
            else:
                # No word_change_options - fall back to checking the player's word pool
                player_pool = player.get('word_pool', [])
                if player_pool and new_word.lower() not in [w.lower() for w in player_pool]:
                    return self._send_error("Please choose a word from your word pool", 400)
            
            # Check if word has been guessed before
            guessed_words = set()
            for entry in game.get('history', []):
                guessed_words.add(entry.get('word', '').lower())
            if new_word.lower() in guessed_words:
                return self._send_error("That word has already been guessed! Pick a different one.", 400)
            
            try:
                get_embedding(new_word)  # Ensure cached
            except Exception as e:
                print(f"Embedding error for change-word: {e}")  # Log server-side only
                return self._send_error("Word processing service unavailable. Please try again.", 503)
            
            player['secret_word'] = new_word.lower()
            player['can_change_word'] = False
            player.pop('word_change_options', None)
            
            # Clear the waiting state - game can continue
            game['waiting_for_word_change'] = None
            game.pop('word_change_started_at', None)  # Clear word change timer
            # Reset turn timer since the game was paused for word change
            game['turn_started_at'] = time.time()
            
            # Add a history entry noting the word change
            history_entry = {
                "type": "word_change",
                "player_id": player['id'],
                "player_name": player['name'],
            }
            game['history'].append(history_entry)
            
            save_game(code, game)
            
            # Return full game state to avoid client needing a second fetch
            game_response = self._build_game_response(game, player_id, code)
            if game_response:
                return self._send_json(game_response)
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
            
            # SECURITY: Validate player session token
            player_id, session_error = self._validate_player_session(body, code)
            if session_error:
                return self._send_error(session_error, 403)
            
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
            game.pop('word_change_started_at', None)  # Clear word change timer
            # Reset turn timer since the game was paused for word change
            game['turn_started_at'] = time.time()

            # Record a word-change event even if the player keeps the same word, so it behaves like a re-encryption
            game['history'].append({
                "type": "word_change",
                "player_id": player['id'],
                "player_name": player['name'],
            })
            
            save_game(code, game)
            
            # Return full game state to avoid client needing a second fetch
            game_response = self._build_game_response(game, player_id, code)
            if game_response:
                return self._send_json(game_response)
            return self._send_json({"status": "skipped"})

        # POST /api/games/{code}/word-change-timeout - Auto-select random word when 15 seconds expires
        if '/word-change-timeout' in path and path.startswith('/api/games/'):
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game['status'] != 'playing':
                return self._send_error("Game not in progress", 400)
            
            waiting_player_id = game.get('waiting_for_word_change')
            if not waiting_player_id:
                return self._send_error("No word change in progress", 400)
            
            # Verify the word change time has actually expired (server-authoritative)
            WORD_CHANGE_TIME_LIMIT = 30
            word_change_started_at = game.get('word_change_started_at')
            
            if not word_change_started_at:
                return self._send_error("No word change timer for this game", 400)
            
            elapsed = time.time() - word_change_started_at
            # Allow 2 second grace period for network latency
            if elapsed < WORD_CHANGE_TIME_LIMIT - 2:
                return self._send_json({
                    "timeout": False,
                    "time_remaining": WORD_CHANGE_TIME_LIMIT - elapsed,
                    "message": "Word change time has not expired yet",
                })
            
            import random
            
            # Find the player who needs to change their word
            player = None
            for p in game['players']:
                if p['id'] == waiting_player_id:
                    player = p
                    break
            
            if not player:
                return self._send_error("Waiting player not found", 400)
            
            if not player.get('can_change_word'):
                # Already changed or skipped - clear state and continue
                game['waiting_for_word_change'] = None
                game.pop('word_change_started_at', None)
                game['turn_started_at'] = time.time()
                save_game(code, game)
                return self._send_json({"status": "already_changed"})
            
            # Get the offered options (or fall back to word pool)
            offered = player.get('word_change_options')
            if offered:
                available = [str(w) for w in offered]
            else:
                available = player.get('word_pool', [])
            
            # Filter out guessed words
            guessed_words = set()
            for entry in game.get('history', []):
                guessed_words.add(entry.get('word', '').lower())
            available = [w for w in available if w.lower() not in guessed_words]
            
            if not available:
                # Fallback: keep current word
                new_word = player.get('secret_word', '')
            else:
                new_word = random.choice(available)
            
            # Update the player's word
            if new_word and new_word.lower() != (player.get('secret_word') or '').lower():
                try:
                    get_embedding(new_word)  # Ensure cached
                    player['secret_word'] = new_word.lower()
                except Exception as e:
                    print(f"Embedding error for word-change-timeout: {e}")
                    # Keep current word on error
            
            player['can_change_word'] = False
            player.pop('word_change_options', None)
            
            # Clear the waiting state - game can continue
            game['waiting_for_word_change'] = None
            game.pop('word_change_started_at', None)
            game['turn_started_at'] = time.time()
            
            # Record a word-change event
            game['history'].append({
                "type": "word_change",
                "player_id": player['id'],
                "player_name": player['name'],
                "auto_selected": True,  # Mark as auto-selected due to timeout
            })
            
            save_game(code, game)
            
            return self._send_json({
                "status": "auto_selected",
                "timeout": True,
            })

        # POST /api/games/{code}/timeout - Handle turn timeout (chess clock - always eliminates)
        if '/timeout' in path and path.startswith('/api/games/'):
            code = sanitize_game_code(path.split('/')[3])
            if not code:
                return self._send_error("Invalid game code format", 400)
            
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game['status'] != 'playing':
                return self._send_error("Game not in progress", 400)
            if game.get('waiting_for_word_change'):
                return self._send_error("Game paused for word change", 400)
            
            # Check time control settings
            time_control = game.get('time_control', {})
            initial_time = int(time_control.get('initial_time', 0) or 0)
            
            if initial_time <= 0:
                return self._send_error("No time limit for this game", 400)
            
            # Get the current player
            current_turn_idx = game.get('current_turn', 0)
            if current_turn_idx >= len(game['players']):
                return self._send_error("Invalid turn index", 400)
            
            timed_out_player = game['players'][current_turn_idx]
            if not timed_out_player.get('is_alive'):
                return self._send_error("Current player is not alive", 400)
            
            # Calculate actual time remaining (chess clock model)
            turn_started_at = game.get('turn_started_at')
            player_time = timed_out_player.get('time_remaining', 0)
            if turn_started_at:
                elapsed = time.time() - turn_started_at
                player_time = player_time - elapsed
            
            # Allow 2 second grace period for network latency
            if player_time > 2:
                return self._send_json({
                    "timeout": False,
                    "time_remaining": player_time,
                    "message": "Turn has not expired yet",
                })
            
            # Set time to 0 (they ran out)
            timed_out_player['time_remaining'] = 0
            
            # Record timeout in history
            history_entry = {
                "type": "timeout",
                "player_id": timed_out_player['id'],
                "player_name": timed_out_player['name'],
            }
            game['history'].append(history_entry)
            
            # Always eliminate on timeout (chess clock rules)
            timed_out_player['is_alive'] = False
            
            # Check for game over
            alive_players = [p for p in game['players'] if p.get('is_alive')]
            game_over = False
            if len(alive_players) <= 1:
                game['status'] = 'finished'
                game_over = True
                if alive_players:
                    game['winner'] = alive_players[0]['id']
                update_game_stats(game)
            else:
                # Advance to next alive player
                num_players = len(game['players'])
                next_turn = (current_turn_idx + 1) % num_players
                while not game['players'][next_turn].get('is_alive'):
                    next_turn = (next_turn + 1) % num_players
                game['current_turn'] = next_turn
                game['turn_started_at'] = time.time()
            
            save_game(code, game)
            
            # Return full game state
            player_id = sanitize_player_id(body.get('player_id', ''))
            game_response = self._build_game_response(game, player_id or timed_out_player['id'], code)
            if game_response:
                game_response['timeout'] = True
                game_response['timed_out_player'] = {
                    "id": timed_out_player['id'],
                    "name": timed_out_player['name'],
                }
                return self._send_json(game_response)
            
            return self._send_json({
                "timeout": True,
                "timed_out_player": {
                    "id": timed_out_player['id'],
                    "name": timed_out_player['name'],
                },
                "game_over": game_over,
            })

        # POST /api/user/username - Set or update username
        if path == '/api/user/username':
            auth_header = self.headers.get('Authorization', '')
            if not auth_header.startswith('Bearer '):
                return self._send_error("Not authenticated", 401)

            token = auth_header[7:]
            payload = verify_jwt_token(token)
            if not payload:
                return self._send_error("Invalid or expired token", 401)

            user = get_user_by_id(payload.get('sub', ''))
            if not user:
                return self._send_error("User not found", 404)

            new_username = body.get('username', '')
            if not isinstance(new_username, str):
                return self._send_error("Username must be a string", 400)
            
            new_username = new_username.strip()
            
            # Validate username
            is_valid, error_msg = validate_username(new_username)
            if not is_valid:
                return self._send_error(error_msg, 400)
            
            # Check if user already has this username (case-insensitive)
            current_username = user.get('username')
            if current_username and current_username.lower() == new_username.lower():
                return self._send_json({
                    "success": True,
                    "username": current_username,
                    "message": "Username unchanged"
                })
            
            # Check availability
            if not is_username_available(new_username):
                return self._send_error("This username is already taken", 409)
            
            # Release old username if exists
            if current_username:
                release_username(current_username, user['id'])
            
            # Reserve new username
            if not reserve_username(new_username, user['id']):
                return self._send_error("Failed to reserve username. Please try again.", 500)
            
            # Update user record
            user['username'] = new_username
            save_user(user)
            
            return self._send_json({
                "success": True,
                "username": new_username,
            })

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

        # POST /api/shop/purchase-bundle - Purchase a cosmetic bundle
        if path == '/api/shop/purchase-bundle':
            auth_header = self.headers.get('Authorization', '')
            if not auth_header.startswith('Bearer '):
                return self._send_error("Not authenticated", 401)

            token = auth_header[7:]
            payload = verify_jwt_token(token)
            if not payload:
                return self._send_error("Invalid or expired token", 401)

            bundle_id = body.get('bundle_id', '')
            if not isinstance(bundle_id, str) or not bundle_id.strip():
                return self._send_error("bundle_id required", 400)
            bundle_id = bundle_id.strip()

            # Get bundle from catalog
            bundles = COSMETICS_CATALOG.get('bundles', {})
            bundle = bundles.get(bundle_id)
            if not bundle:
                return self._send_error("Invalid bundle", 400)

            try:
                price = int(bundle.get('price', 0) or 0)
            except Exception:
                price = 0
            if price <= 0:
                return self._send_error("This bundle is not for sale", 400)

            contents = bundle.get('contents', {})
            if not contents:
                return self._send_error("Bundle has no contents", 400)

            user = get_user_by_id(payload.get('sub', ''))
            if not user:
                return self._send_error("User not found", 404)

            ensure_user_economy(user, persist=False)

            credits = get_user_credits(user)
            if credits < price:
                return self._send_error("Not enough credits", 403)

            # Grant all items in bundle
            for cat_key, cosmetic_id in contents.items():
                if not user_owns_cosmetic(user, cat_key, cosmetic_id):
                    grant_owned_cosmetic(user, cat_key, cosmetic_id, persist=False)

            add_user_credits(user, -price, persist=False)
            save_user(user)
            econ = ensure_user_economy(user, persist=False)
            return self._send_json({
                "status": "purchased",
                "bundle_id": bundle_id,
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

            catalog_key = COSMETIC_CATEGORY_TO_CATALOG_KEY.get(category)
            if not catalog_key:
                return self._send_error("Invalid category", 400)
            
            item = get_cosmetic_item(catalog_key, cosmetic_id)
            if not item:
                return self._send_error("Invalid cosmetic", 400)
            
            user = get_user_by_id(payload['sub'])
            if not user:
                return self._send_error("User not found", 404)
            
            if not category or not cosmetic_id:
                return self._send_error("Category and cosmetic_id required", 400)
            
            is_donor = user.get('is_donor', False)
            is_admin = user.get('is_admin', False)

            # Admin-only gating (always enforced)
            if item.get('admin_only', False) and not is_admin:
                return self._send_error("This legendary cosmetic is admin-only!", 403)

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
            client_ip = get_client_ip(self.headers)
            
            # Ko-fi sends data as form-urlencoded with a 'data' field containing JSON
            try:
                # The body should contain a 'data' field with JSON
                kofi_data = body.get('data')
                if isinstance(kofi_data, str):
                    kofi_data = json.loads(kofi_data)
                elif not kofi_data:
                    kofi_data = body  # Fallback to direct body
                
                # SECURITY: Verify the webhook token
                # In production, this is REQUIRED to prevent spoofed donations
                is_production = os.getenv('VERCEL_ENV') == 'production'
                received_token = kofi_data.get('verification_token', '')
                
                if KOFI_VERIFICATION_TOKEN:
                    # Use constant-time comparison to prevent timing attacks
                    if not constant_time_compare(received_token, KOFI_VERIFICATION_TOKEN):
                        log_webhook_event(client_ip, "kofi", False, {"reason": "invalid_token"})
                        print(f"Ko-fi webhook: Invalid verification token from {client_ip}")
                        return self._send_error("Invalid verification token", 403)
                elif not KOFI_SKIP_VERIFICATION:
                    # SECURITY: Default to requiring verification - explicit opt-out required
                    log_webhook_event(client_ip, "kofi", False, {"reason": "no_token_configured"})
                    print(f"[SECURITY ERROR] Ko-fi webhook received but KOFI_VERIFICATION_TOKEN not configured")
                    return self._send_error("Webhook verification not configured", 500)
                else:
                    # Explicit skip enabled - warn but allow (development only)
                    print(f"[SECURITY WARNING] Ko-fi webhook verification explicitly skipped via KOFI_SKIP_VERIFICATION")
                
                # Get donor email
                donor_email = kofi_data.get('email', '').lower().strip()
                if not donor_email:
                    log_webhook_event(client_ip, "kofi", True, {"status": "no_email"})
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
                    log_webhook_event(client_ip, "kofi", True, {"status": "pending", "email_hash": hashlib.sha256(donor_email.encode()).hexdigest()[:8]})
                    print(f"Ko-fi webhook: Stored pending donation for {donor_email}")
                    return self._send_json({"status": "ok", "message": "Pending donation stored"})
                
                # Mark user as donor
                user['is_donor'] = True
                user['donation_date'] = int(time.time())
                user['donation_amount'] = kofi_data.get('amount', '0')
                save_user(user)
                
                log_webhook_event(client_ip, "kofi", True, {"status": "processed", "user_id": user.get('id', '')[:16]})
                print(f"Ko-fi webhook: Marked {donor_email} as donor")
                return self._send_json({"status": "ok", "message": "Donor status updated"})
                
            except Exception as e:
                log_webhook_event(client_ip, "kofi", False, {"reason": "exception", "error": str(e)[:100]})
                print(f"Ko-fi webhook error: {e}")
                return self._send_error("Webhook processing failed", 500)

        self._send_error("Not found", 404)
