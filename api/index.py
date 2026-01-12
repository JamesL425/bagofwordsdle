"""Vercel serverless function for Embeddle API with Upstash Redis storage."""

import json
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


def sanitize_player_name(name: str) -> Optional[str]:
    """Sanitize player name. Returns None if invalid."""
    if not name:
        return None
    name = name.strip()
    if not PLAYER_NAME_PATTERN.match(name):
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

# Game settings
MIN_PLAYERS = CONFIG.get("game", {}).get("min_players", 3)
MAX_PLAYERS = CONFIG.get("game", {}).get("max_players", 4)
GAME_EXPIRY_SECONDS = CONFIG.get("game", {}).get("game_expiry_seconds", 7200)
LOBBY_EXPIRY_SECONDS = CONFIG.get("game", {}).get("lobby_expiry_seconds", 600)

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

# Load cosmetics catalog
def load_cosmetics_catalog():
    cosmetics_path = Path(__file__).parent / "cosmetics.json"
    if cosmetics_path.exists():
        with open(cosmetics_path) as f:
            return json.load(f)
    return {}

COSMETICS_CATALOG = load_cosmetics_catalog()

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
    words = PREGENERATED_THEMES.get(category, [])
    return {"name": category, "words": words}


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
    protocol = 'https' if 'vercel' in base_url else 'http'
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
        'stats': {
            'wins': 0,
            'games_played': 0,
            'eliminations': 0,
            'times_eliminated': 0,
            'total_guesses': 0,
            'win_streak': 0,
            'best_streak': 0,
        }
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
    """Get user's equipped cosmetics with defaults for missing fields."""
    cosmetics = user.get('cosmetics', {})
    # Merge with defaults to ensure all fields exist
    result = DEFAULT_COSMETICS.copy()
    result.update(cosmetics)
    return result


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
    if item.get('premium', False) and not is_donor and not is_admin:
        return False
    return True


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


def update_game_stats(game: dict):
    """Update stats for all players after a game ends."""
    winner_id = game.get('winner')
    
    # Count eliminations per player
    eliminations_by_player = {}
    eliminated_players = set()
    
    for entry in game.get('history', []):
        if entry.get('type') == 'word_change':
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


class handler(BaseHTTPRequestHandler):
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
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
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
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length:
            return json.loads(self.rfile.read(content_length))
        return {}

    def do_OPTIONS(self):
        self.send_response(200)
        cors_origin = self._get_cors_origin()
        if cors_origin:
            self.send_header('Access-Control-Allow-Origin', cors_origin)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Credentials', 'true')
        self.send_header('Access-Control-Max-Age', '86400')
        self.end_headers()

    def do_GET(self):
        path = self.path.split('?')[0]
        query = {}
        if '?' in self.path:
            query_string = self.path.split('?')[1]
            for param in query_string.split('&'):
                if '=' in param:
                    key, value = param.split('=', 1)
                    query[key] = value

        # Get client IP for rate limiting
        client_ip = get_client_ip(self.headers)

        # ============== AUTH ENDPOINTS ==============

        # GET /api/auth/google - Redirect to Google OAuth
        if path == '/api/auth/google':
            if not GOOGLE_CLIENT_ID:
                return self._send_error("OAuth not configured", 500)
            
            redirect_uri = get_oauth_redirect_uri()
            params = {
                'client_id': GOOGLE_CLIENT_ID,
                'redirect_uri': redirect_uri,
                'response_type': 'code',
                'scope': 'openid email profile',
                'access_type': 'offline',
                'prompt': 'consent',
            }
            auth_url = f"{GOOGLE_AUTH_URL}?{urllib.parse.urlencode(params)}"
            
            self.send_response(302)
            self.send_header('Location', auth_url)
            self.end_headers()
            return

        # GET /api/auth/debug - Debug OAuth configuration (temporary)
        if path == '/api/auth/debug':
            redirect_uri = get_oauth_redirect_uri()
            return self._send_json({
                'redirect_uri': redirect_uri,
                'client_id_set': bool(GOOGLE_CLIENT_ID),
                'client_secret_set': bool(GOOGLE_CLIENT_SECRET),
                'site_url': os.getenv('SITE_URL', ''),
                'vercel_url': os.getenv('VERCEL_URL', ''),
            })

        # GET /api/auth/admin?password=XXX - Admin login with password
        if path == '/api/auth/admin':
            password = query.get('password', '')
            
            if not ADMIN_PASSWORD:
                return self._send_error("Admin login not configured", 500)
            
            if not password or password != ADMIN_PASSWORD:
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
            
            # Redirect to frontend with token
            self.send_response(302)
            self.send_header('Location', f'/?auth_token={jwt_token}')
            self.end_headers()
            return

        # GET /api/auth/callback - Handle OAuth callback
        if path == '/api/auth/callback':
            code = query.get('code', '')
            error = query.get('error', '')
            
            if error:
                # Redirect to frontend with error
                self.send_response(302)
                self.send_header('Location', '/?auth_error=' + urllib.parse.quote(error))
                self.end_headers()
                return
            
            if not code:
                return self._send_error("No authorization code provided", 400)
            
            try:
                # Exchange code for tokens
                redirect_uri = get_oauth_redirect_uri()
                token_response = requests.post(GOOGLE_TOKEN_URL, data={
                    'client_id': GOOGLE_CLIENT_ID,
                    'client_secret': GOOGLE_CLIENT_SECRET,
                    'code': code,
                    'grant_type': 'authorization_code',
                    'redirect_uri': redirect_uri,
                })
                
                if not token_response.ok:
                    print(f"Token exchange failed: {token_response.status_code} - {token_response.text}")
                    print(f"Redirect URI used: {redirect_uri}")
                    self.send_response(302)
                    self.send_header('Location', '/?auth_error=token_exchange_failed')
                    self.end_headers()
                    return
                
                tokens = token_response.json()
                access_token = tokens.get('access_token')
                
                # Get user info from Google
                userinfo_response = requests.get(
                    GOOGLE_USERINFO_URL,
                    headers={'Authorization': f'Bearer {access_token}'}
                )
                
                if not userinfo_response.ok:
                    print(f"User info failed: {userinfo_response.text}")
                    self.send_response(302)
                    self.send_header('Location', '/?auth_error=userinfo_failed')
                    self.end_headers()
                    return
                
                google_user = userinfo_response.json()
                
                # Create or get user
                user = get_or_create_user(google_user)
                
                # Create JWT token
                jwt_token = create_jwt_token(user)
                
                # Redirect to frontend with token
                self.send_response(302)
                self.send_header('Location', f'/?auth_token={jwt_token}')
                self.end_headers()
                return
                
            except Exception as e:
                print(f"OAuth callback error: {e}")
                self.send_response(302)
                self.send_header('Location', '/?auth_error=callback_failed')
                self.end_headers()
                return

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
            
            return self._send_json({
                'id': user['id'],
                'name': user['name'],
                'email': user.get('email', ''),
                'avatar': user.get('avatar', ''),
                'stats': user.get('stats', {}),
                'is_donor': user.get('is_donor', False),
                'cosmetics': get_user_cosmetics(user),
            })

        # GET /api/cosmetics - Get cosmetics catalog
        if path == '/api/cosmetics':
            return self._send_json({
                "catalog": COSMETICS_CATALOG,
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
            
            return self._send_json({
                'is_donor': user.get('is_donor', False),
                'is_admin': user.get('is_admin', False),
                'cosmetics': get_user_cosmetics(user),
            })

        # GET /api/lobbies - List open lobbies
        if path == '/api/lobbies':
            # Rate limit: 30/min for lobby listing
            if not check_rate_limit(get_ratelimit_general(), f"lobbies:{client_ip}"):
                return self._send_error("Too many requests. Please wait.", 429)
            try:
                import time
                redis = get_redis()
                keys = redis.keys("game:*")
                lobbies = []
                current_time = time.time()
                
                for key in keys:
                    game_data = redis.get(key)
                    if game_data:
                        game = json.loads(game_data)
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
                            })
                return self._send_json({"lobbies": lobbies})
            except Exception as e:
                print(f"Error loading lobbies: {e}")  # Log server-side only
                return self._send_error("Failed to load lobbies. Please try again.", 500)

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
            
            # Give the next player a random 20 from available (unassigned) words
            if len(available_words) > 20:
                next_player_pool = random.sample(available_words, 20)
            else:
                next_player_pool = available_words
            
            return self._send_json({
                "theme": {
                    "name": game.get('theme', {}).get('name', ''),
                    "words": all_theme_words,  # Full list for reference during game
                },
                "word_pool": sorted(next_player_pool),  # This player's available words (sorted for display)
            })

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
                    "theme": {
                        "name": theme_data.get('name', ''),
                        "words": theme_data.get('words', []),
                    },
                    "waiting_for_word_change": game.get('waiting_for_word_change'),
                    "theme_options": game.get('theme_options', []),
                    "theme_votes": theme_votes_with_names,
                    "all_words_set": all_words_set,
                    "ready_count": ready_count,
                }
                
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
                    }
                    # Include this player's word pool if it's them
                    if p['id'] == player_id:
                        player_data['word_pool'] = p.get('word_pool', [])
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

        # POST /api/games - Create lobby with theme voting
        if path == '/api/games':
            # Rate limit: 5 games/min per IP
            if not check_rate_limit(get_ratelimit_game_create(), client_ip):
                return self._send_error("Too many game creations. Please wait.", 429)
            
            import random
            import time
            
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
            }
            save_game(code, game)
            return self._send_json({
                "code": code,
                "theme_options": theme_options,
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
            
            name = sanitize_player_name(body.get('name', ''))
            if not name:
                return self._send_error("Invalid name. Use only letters, numbers, underscores, and spaces (1-20 chars)", 400)
            
            # Get user cosmetics if authenticated
            user_cosmetics = None
            auth_user_id = body.get('auth_user_id', '')
            if auth_user_id:
                auth_user = get_user_by_id(auth_user_id)
                if auth_user:
                    user_cosmetics = get_visible_cosmetics(auth_user)
            
            # Check if player is trying to rejoin
            existing_player = next((p for p in game['players'] if p['name'].lower() == name.lower()), None)
            if existing_player:
                # Update cosmetics if provided
                if user_cosmetics:
                    existing_player['cosmetics'] = user_cosmetics
                    save_game(code, game)
                # Allow rejoin - return their player_id
                return self._send_json({
                    "player_id": existing_player['id'],
                    "game_code": code,
                    "is_host": existing_player['id'] == game['host_id'],
                    "rejoined": True,
                    "theme_options": game.get('theme_options', []),
                    "theme_votes": game.get('theme_votes', {}),
                })
            
            if game['status'] != 'waiting':
                return self._send_error("Game has already started", 400)
            if len(game['players']) >= MAX_PLAYERS:
                return self._send_error("Game is full", 400)
            
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
            if len(game['players']) < MIN_PLAYERS:
                return self._send_error(f"Need at least {MIN_PLAYERS} players", 400)
            
            # Determine winning theme from votes (weighted random)
            import random
            votes = game.get('theme_votes', {})
            theme_options = game.get('theme_options', ['Animals'])
            
            if votes:
                # Build weighted list: each theme appears once per vote
                weighted_themes = []
                for theme_name in theme_options:
                    vote_count = len(votes.get(theme_name, []))
                    # Give at least 1 weight to each theme so unvoted themes have a chance
                    weight = max(vote_count, 0)
                    weighted_themes.extend([theme_name] * weight)
                
                # If no votes at all, equal weight
                if not weighted_themes:
                    weighted_themes = theme_options.copy()
                
                winning_theme = random.choice(weighted_themes)
            else:
                # Fallback to random choice if no votes
                winning_theme = random.choice(theme_options)
            
            # Set the theme
            theme = get_theme_words(winning_theme)
            all_words = theme.get("words", [])
            game['theme'] = {
                "name": theme.get("name", winning_theme),
                "words": all_words,
            }
            
            # Assign distinct word pools to each player (20 words each, no overlap)
            shuffled_words = all_words.copy()
            random.shuffle(shuffled_words)
            
            words_per_player = 20
            for i, p in enumerate(game['players']):
                start_idx = i * words_per_player
                end_idx = start_idx + words_per_player
                p['word_pool'] = sorted(shuffled_words[start_idx:end_idx])
            
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
            
            # Check all players have set their words
            not_ready = [p['name'] for p in game['players'] if not p.get('secret_word')]
            if not_ready:
                return self._send_error(f"Waiting for: {', '.join(not_ready)}", 400)
            
            game['status'] = 'playing'
            save_game(code, game)
            return self._send_json({"status": "playing"})

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
            
            return self._send_json({
                "similarities": similarities,
                "eliminations": eliminations,
                "game_over": game_over,
                "winner": game.get('winner'),
                "waiting_for_word_change": game.get('waiting_for_word_change'),
            })

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
            
            # Clear the ability and waiting state
            player['can_change_word'] = False
            game['waiting_for_word_change'] = None
            
            save_game(code, game)
            return self._send_json({"status": "skipped"})

        # POST /api/cosmetics/equip - Equip a cosmetic
        if path == '/api/cosmetics/equip':
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
            
            is_donor = user.get('is_donor', False)
            is_admin = user.get('is_admin', False)
            if not validate_cosmetic(catalog_key, cosmetic_id, is_donor, is_admin):
                if cosmetic_id in COSMETICS_CATALOG.get(catalog_key, {}):
                    return self._send_error("Donate to unlock premium cosmetics!", 403)
                return self._send_error("Invalid cosmetic", 400)
            
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
