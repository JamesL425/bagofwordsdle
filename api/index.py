"""Vercel serverless function for Bagofwordsdle API with Upstash Redis storage."""

import json
import os
import secrets
import string
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import numpy as np
from openai import OpenAI
from wordfreq import word_frequency
from upstash_redis import Redis

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
ELIMINATION_THRESHOLD = CONFIG.get("game", {}).get("elimination_threshold", 0.95)
GAME_EXPIRY_SECONDS = CONFIG.get("game", {}).get("game_expiry_seconds", 7200)

# Embedding settings
EMBEDDING_MODEL = CONFIG.get("embedding", {}).get("model", "text-embedding-3-small")
EMBEDDING_CACHE_SECONDS = CONFIG.get("embedding", {}).get("cache_expiry_seconds", 86400)

# Theme categories for LLM generation
THEME_CATEGORIES = CONFIG.get("theme_categories", ["Animals", "Food", "Sports", "Nature", "Technology"])

# Initialize clients lazily
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


def generate_theme_words(category: str) -> dict:
    """Use LLM to generate theme words for a category."""
    import random
    
    # Check cache first
    redis = get_redis()
    cache_key = f"theme:{category.lower().replace(' ', '_')}"
    cached = redis.get(cache_key)
    if cached:
        cached_data = json.loads(cached)
        # Return a random subset of cached words for variety
        words = cached_data.get('words', [])
        if len(words) > 50:
            words = random.sample(words, 50)
        return {"name": category, "words": words}
    
    # Generate with LLM
    client = get_openai_client()
    
    prompt = f"""Generate exactly 60 common, single English words related to the theme "{category}".

Rules:
- Only single words (no phrases, no spaces, no hyphens)
- Common words that most people would know
- Mix of easy and slightly harder words
- No proper nouns (no brand names, no specific places)
- Words should be 3-12 letters long

Return ONLY a JSON array of lowercase words, nothing else. Example format:
["word1", "word2", "word3"]"""

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.8,
            max_tokens=500,
        )
        
        content = response.choices[0].message.content.strip()
        # Parse the JSON array
        words = json.loads(content)
        
        # Clean and validate words
        clean_words = []
        for word in words:
            word = word.lower().strip()
            if word.isalpha() and 2 <= len(word) <= 15:
                clean_words.append(word)
        
        # Cache for 1 hour (themes can be reused)
        if clean_words:
            redis.setex(cache_key, 3600, json.dumps({"words": clean_words}))
        
        return {"name": category, "words": clean_words[:50]}
    
    except Exception as e:
        print(f"Error generating theme: {e}")
        # Fallback to a simple default
        return {"name": category, "words": []}


def get_random_theme() -> dict:
    """Get a random theme with LLM-generated words."""
    import random
    category = random.choice(THEME_CATEGORIES)
    return generate_theme_words(category)


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
        return json.loads(data)
    return {
        "name": name,
        "wins": 0,
        "games_played": 0,
        "total_guesses": 0,
        "total_similarity": 0.0,
    }


def save_player_stats(name: str, stats: dict):
    """Save player stats."""
    redis = get_redis()
    key = f"stats:{name.lower()}"
    # Stats never expire
    redis.set(key, json.dumps(stats))
    # Also add to leaderboard set
    redis.sadd("leaderboard:players", name.lower())


def update_game_stats(game: dict):
    """Update stats for all players after a game ends."""
    winner_id = game.get('winner')
    
    for player in game['players']:
        stats = get_player_stats(player['name'])
        stats['games_played'] += 1
        
        if player['id'] == winner_id:
            stats['wins'] += 1
        
        # Calculate average closeness from this player's guesses
        for entry in game.get('history', []):
            if entry['guesser_id'] == player['id']:
                stats['total_guesses'] += 1
                # Get the max similarity to other players (not self)
                other_sims = [
                    sim for pid, sim in entry['similarities'].items() 
                    if pid != player['id']
                ]
                if other_sims:
                    stats['total_similarity'] += max(other_sims)
        
        save_player_stats(player['name'], stats)


def get_leaderboard() -> list:
    """Get all players sorted by wins."""
    redis = get_redis()
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
            players.append(stats)
    
    # Sort by wins (desc), then win rate (desc), then games played (desc)
    players.sort(key=lambda p: (
        p['wins'], 
        p['wins'] / p['games_played'] if p['games_played'] > 0 else 0,
        p['games_played']
    ), reverse=True)
    
    return players


# ============== HANDLER ==============

class handler(BaseHTTPRequestHandler):
    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
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
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
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

        # GET /api/leaderboard
        if path == '/api/leaderboard':
            players = get_leaderboard()
            return self._send_json({"players": players})

        # GET /api/games/{code}/theme - Get theme for a game (before joining)
        if path.endswith('/theme') and path.startswith('/api/games/'):
            code = path.split('/')[3].upper()
            game = load_game(code)
            if not game:
                return self._send_error("Game not found", 404)
            return self._send_json({"theme": game.get('theme', {})})

        # GET /api/games/{code}
        if path.startswith('/api/games/') and path.count('/') == 3:
            code = path.split('/')[3].upper()
            player_id = query.get('player_id', '')
            
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
            
            # Build response with hidden words
            response = {
                "code": game['code'],
                "host_id": game['host_id'],
                "players": [],
                "current_turn": game['current_turn'],
                "current_player_id": game['players'][game['current_turn']]['id'] if game['status'] == 'playing' and game['players'] else None,
                "status": game['status'],
                "winner": game.get('winner'),
                "history": game.get('history', []),
                "theme": game.get('theme', {}),
            }
            
            for p in game['players']:
                response['players'].append({
                    "id": p['id'],
                    "name": p['name'],
                    "secret_word": p['secret_word'] if p['id'] == player_id else None,
                    "is_alive": p['is_alive'],
                    "can_change_word": p.get('can_change_word', False) if p['id'] == player_id else None,
                })
            
            return self._send_json(response)

        self._send_error("Not found", 404)

    def do_POST(self):
        path = self.path.split('?')[0]
        body = self._get_body()

        # POST /api/games - Create game
        if path == '/api/games':
            code = generate_game_code()
            
            # Make sure code is unique
            while load_game(code):
                code = generate_game_code()
            
            # Get a random theme for this game
            theme = get_random_theme()
            
            game = {
                "code": code,
                "host_id": "",
                "players": [],
                "current_turn": 0,
                "status": "waiting",
                "winner": None,
                "history": [],
                "theme": {
                    "name": theme.get("name", "General"),
                    "words": theme.get("words", []),
                },
            }
            save_game(code, game)
            return self._send_json({
                "code": code, 
                "player_id": "",
                "theme": game["theme"],
            })

        # POST /api/games/{code}/join
        if '/join' in path:
            code = path.split('/')[3].upper()
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game['status'] != 'waiting':
                return self._send_error("Game has already started", 400)
            if len(game['players']) >= MAX_PLAYERS:
                return self._send_error("Game is full", 400)
            
            name = body.get('name', '').strip()
            secret_word = body.get('secret_word', '').strip()
            
            if not name or not secret_word:
                return self._send_error("Name and secret word required", 400)
            
            if any(p['name'].lower() == name.lower() for p in game['players']):
                return self._send_error("Name already taken", 400)
            
            # Check if word is in the theme
            theme_words = game.get('theme', {}).get('words', [])
            if theme_words and not is_word_in_theme(secret_word, theme_words):
                theme_name = game.get('theme', {}).get('name', 'the theme')
                return self._send_error(f"Word must be from the {theme_name} theme. Check the word list!", 400)
            
            # Check if word is already taken by another player
            if any(p['secret_word'].lower() == secret_word.lower() for p in game['players']):
                return self._send_error("That word is already taken by another player", 400)
            
            try:
                embedding = get_embedding(secret_word)
            except Exception as e:
                return self._send_error(f"API error: {str(e)}", 503)
            
            player_id = generate_player_id()
            player = {
                "id": player_id,
                "name": name,
                "secret_word": secret_word.lower(),
                "secret_embedding": embedding,
                "is_alive": True,
                "can_change_word": False,
            }
            game['players'].append(player)
            
            if len(game['players']) == 1:
                game['host_id'] = player_id
            
            save_game(code, game)
            return self._send_json({"player_id": player_id, "theme": game.get('theme', {})})

        # POST /api/games/{code}/start
        if '/start' in path:
            code = path.split('/')[3].upper()
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            
            player_id = body.get('player_id', '')
            if game['host_id'] != player_id:
                return self._send_error("Only the host can start", 403)
            if game['status'] != 'waiting':
                return self._send_error("Game already started", 400)
            if len(game['players']) < MIN_PLAYERS:
                return self._send_error(f"Need at least {MIN_PLAYERS} players", 400)
            
            game['status'] = 'playing'
            game['current_turn'] = 0
            save_game(code, game)
            return self._send_json({"status": "started"})

        # POST /api/games/{code}/guess
        if '/guess' in path:
            code = path.split('/')[3].upper()
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game['status'] != 'playing':
                return self._send_error("Game not in progress", 400)
            
            player_id = body.get('player_id', '')
            word = body.get('word', '').strip()
            
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
                return self._send_error(f"API error: {str(e)}", 503)
            
            similarities = {}
            for p in game['players']:
                sim = cosine_similarity(guess_embedding, p['secret_embedding'])
                similarities[p['id']] = round(sim, 2)
            
            eliminations = []
            for p in game['players']:
                if p['id'] != player_id and p['is_alive']:
                    if similarities.get(p['id'], 0) >= ELIMINATION_THRESHOLD:
                        p['is_alive'] = False
                        eliminations.append(p['id'])
            
            if eliminations:
                player['can_change_word'] = True
            
            # Record history
            history_entry = {
                "guesser_id": player['id'],
                "guesser_name": player['name'],
                "word": word.lower(),
                "similarities": similarities,
                "eliminations": eliminations,
            }
            game['history'].append(history_entry)
            
            # Advance turn
            alive_players = [p for p in game['players'] if p['is_alive']]
            game_over = False
            if len(alive_players) <= 1:
                game['status'] = 'finished'
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
            })

        # POST /api/games/{code}/change-word
        if '/change-word' in path:
            code = path.split('/')[3].upper()
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game['status'] != 'playing':
                return self._send_error("Game not in progress", 400)
            
            player_id = body.get('player_id', '')
            new_word = body.get('new_word', '').strip()
            
            player = None
            for p in game['players']:
                if p['id'] == player_id:
                    player = p
                    break
            
            if not player:
                return self._send_error("You are not in this game", 403)
            if not player.get('can_change_word', False):
                return self._send_error("You don't have a word change", 400)
            
            # Check if word is in the theme
            theme_words = game.get('theme', {}).get('words', [])
            if theme_words and not is_word_in_theme(new_word, theme_words):
                theme_name = game.get('theme', {}).get('name', 'the theme')
                return self._send_error(f"Word must be from the {theme_name} theme", 400)
            
            # Check if word is already taken by another player
            if any(p['secret_word'].lower() == new_word.lower() and p['id'] != player_id for p in game['players']):
                return self._send_error("That word is already taken by another player", 400)
            
            try:
                embedding = get_embedding(new_word)
            except Exception as e:
                return self._send_error(f"API error: {str(e)}", 503)
            
            player['secret_word'] = new_word.lower()
            player['secret_embedding'] = embedding
            player['can_change_word'] = False
            
            save_game(code, game)
            return self._send_json({"status": "word_changed"})

        self._send_error("Not found", 404)
