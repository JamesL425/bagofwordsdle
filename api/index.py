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

# Load pre-generated themes from JSON file
def load_themes():
    themes_path = Path(__file__).parent / "themes.json"
    if themes_path.exists():
        with open(themes_path) as f:
            return json.load(f)
    return {}

PREGENERATED_THEMES = load_themes()
THEME_CATEGORIES = list(PREGENERATED_THEMES.keys()) if PREGENERATED_THEMES else CONFIG.get("theme_categories", [])

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


def get_theme_words(category: str) -> dict:
    """Get pre-generated theme words for a category."""
    words = PREGENERATED_THEMES.get(category, [])
    return {"name": category, "words": words}


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
            
            import random
            
            # Get all theme words and words already assigned to other players
            all_theme_words = game.get('theme', {}).get('words', [])
            assigned_words = set()
            for p in game['players']:
                assigned_words.update(p.get('word_pool', []))
            
            # Available words = all words not yet assigned to any player
            available_words = [w for w in all_theme_words if w.lower() not in {x.lower() for x in assigned_words}]
            
            # Give the next player a random 30 from available (unassigned) words
            if len(available_words) > 25:
                next_player_pool = random.sample(available_words, 25)
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
            
            # Reveal all words if game is finished
            game_finished = game['status'] == 'finished'
            
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
                "theme": {
                    "name": game.get('theme', {}).get('name', ''),
                    "words": game.get('theme', {}).get('words', []),  # Full word list for guessing reference
                },
                "waiting_for_word_change": game.get('waiting_for_word_change'),
            }
            
            for p in game['players']:
                player_data = {
                    "id": p['id'],
                    "name": p['name'],
                    # Reveal all words when game is finished, otherwise only show your own
                    "secret_word": p['secret_word'] if (p['id'] == player_id or game_finished) else None,
                    "is_alive": p['is_alive'],
                    "can_change_word": p.get('can_change_word', False) if p['id'] == player_id else None,
                }
                # Include this player's word pool if it's them
                if p['id'] == player_id:
                    player_data['word_pool'] = p.get('word_pool', [])
                response['players'].append(player_data)
            
            return self._send_json(response)

        self._send_error("Not found", 404)

    def do_POST(self):
        path = self.path.split('?')[0]
        body = self._get_body()

        # POST /api/games - Create game (returns 3 theme options)
        if path == '/api/games':
            import random
            
            code = generate_game_code()
            
            # Make sure code is unique
            while load_game(code):
                code = generate_game_code()
            
            # Pick 3 random theme categories for the creator to choose from
            theme_options = random.sample(THEME_CATEGORIES, min(3, len(THEME_CATEGORIES)))
            
            # Create game without theme yet (will be set when creator chooses)
            game = {
                "code": code,
                "host_id": "",
                "players": [],
                "current_turn": 0,
                "status": "choosing_theme",  # New status
                "winner": None,
                "history": [],
                "theme": None,  # Will be set after creator chooses
                "theme_options": theme_options,  # Store the options
            }
            save_game(code, game)
            return self._send_json({
                "code": code,
                "theme_options": theme_options,
            })

        # POST /api/games/{code}/theme - Set the theme (creator chooses)
        if '/theme' in path and path.startswith('/api/games/') and path.count('/') == 4:
            code = path.split('/')[3].upper()
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
            
            import random
            
            # Get all theme words and words already assigned to other players
            all_theme_words = game.get('theme', {}).get('words', [])
            assigned_words = set()
            for p in game['players']:
                assigned_words.update(w.lower() for w in p.get('word_pool', []))
            
            # Check if the word is in the theme and not already taken
            if all_theme_words and secret_word.lower() not in [w.lower() for w in all_theme_words]:
                return self._send_error("Please choose a word from the theme", 400)
            
            if secret_word.lower() in assigned_words:
                return self._send_error("That word is already taken by another player", 400)
            
            # Available words = all words not yet assigned to any player
            available_words = [w for w in all_theme_words if w.lower() not in assigned_words]
            
            # Give this player a random 25 from unassigned words (for future word changes)
            if len(available_words) > 25:
                player_word_pool = random.sample(available_words, 25)
            else:
                player_word_pool = available_words
            
            # Make sure their chosen word is in their pool
            if secret_word.lower() not in [w.lower() for w in player_word_pool]:
                player_word_pool.append(secret_word.lower())
            
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
                "word_pool": sorted(player_word_pool),  # Store their distinct pool
            }
            game['players'].append(player)
            
            if len(game['players']) == 1:
                game['host_id'] = player_id
            
            save_game(code, game)
            return self._send_json({
                "player_id": player_id, 
                "theme": {"name": game.get('theme', {}).get('name', ''), "words": all_theme_words},
                "word_pool": player_word_pool,
            })

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
            
            # Check if game is paused waiting for word change
            if game.get('waiting_for_word_change'):
                waiting_player = next((p for p in game['players'] if p['id'] == game['waiting_for_word_change']), None)
                waiting_name = waiting_player['name'] if waiting_player else 'Someone'
                return self._send_error(f"Waiting for {waiting_name} to change their word", 400)
            
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
                return self._send_error(f"API error: {str(e)}", 503)
            
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
            code = path.split('/')[3].upper()
            game = load_game(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game['status'] != 'playing':
                return self._send_error("Game not in progress", 400)
            
            player_id = body.get('player_id', '')
            
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

        self._send_error("Not found", 404)
