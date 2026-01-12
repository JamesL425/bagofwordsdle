"""Vercel serverless function for Bagofwordsdle API."""

import json
import os
import secrets
import string
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
from http.server import BaseHTTPRequestHandler

import numpy as np
from openai import OpenAI, RateLimitError, APIError
from wordfreq import word_frequency

# Initialize OpenAI client lazily
_client = None

def get_openai_client():
    global _client
    if _client is None:
        _client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return _client


# ============== MODELS ==============

class GameStatus(str, Enum):
    WAITING = "waiting"
    PLAYING = "playing"
    FINISHED = "finished"


@dataclass
class Player:
    id: str
    name: str
    secret_word: str
    secret_embedding: list[float] = field(default_factory=list)
    is_alive: bool = True
    can_change_word: bool = False

    def to_dict(self, viewer_id: str) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "secret_word": self.secret_word if self.id == viewer_id else None,
            "is_alive": self.is_alive,
            "can_change_word": self.can_change_word if self.id == viewer_id else None,
        }


@dataclass
class GuessResult:
    guesser_id: str
    guesser_name: str
    word: str
    similarities: dict
    eliminations: list

    def to_dict(self) -> dict:
        return {
            "guesser_id": self.guesser_id,
            "guesser_name": self.guesser_name,
            "word": self.word,
            "similarities": self.similarities,
            "eliminations": self.eliminations,
        }


@dataclass 
class Game:
    code: str
    host_id: str
    players: list = field(default_factory=list)
    current_turn: int = 0
    status: GameStatus = GameStatus.WAITING
    winner: Optional[str] = None
    history: list = field(default_factory=list)

    def get_player(self, player_id: str):
        for player in self.players:
            if player.id == player_id:
                return player
        return None

    def get_current_player(self):
        if not self.players or self.status != GameStatus.PLAYING:
            return None
        return self.players[self.current_turn]

    def get_alive_players(self):
        return [p for p in self.players if p.is_alive]

    def advance_turn(self):
        if self.status != GameStatus.PLAYING:
            return
        alive_players = self.get_alive_players()
        if len(alive_players) <= 1:
            self.status = GameStatus.FINISHED
            if alive_players:
                self.winner = alive_players[0].id
            return
        num_players = len(self.players)
        next_turn = (self.current_turn + 1) % num_players
        while not self.players[next_turn].is_alive:
            next_turn = (next_turn + 1) % num_players
        self.current_turn = next_turn

    def to_dict(self, viewer_id: str) -> dict:
        current_player = self.get_current_player()
        return {
            "code": self.code,
            "host_id": self.host_id,
            "players": [p.to_dict(viewer_id) for p in self.players],
            "current_turn": self.current_turn,
            "current_player_id": current_player.id if current_player else None,
            "status": self.status.value,
            "winner": self.winner,
            "history": [h.to_dict() for h in self.history],
        }


# ============== STORAGE ==============
# WARNING: This resets on each serverless invocation!
# For production, use Vercel KV or Upstash Redis
games: dict = {}


def generate_game_code() -> str:
    chars = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(6))


def generate_player_id() -> str:
    return secrets.token_hex(8)


# ============== EMBEDDINGS ==============

embedding_cache: dict = {}


def is_valid_word(word: str) -> bool:
    word_lower = word.lower().strip()
    if not word_lower.isalpha():
        return False
    if len(word_lower) < 2:
        return False
    freq = word_frequency(word_lower, 'en')
    return freq > 0


def get_embedding(word: str) -> list:
    word_lower = word.lower().strip()
    if word_lower in embedding_cache:
        return embedding_cache[word_lower]
    
    client = get_openai_client()
    response = client.embeddings.create(
        model="text-embedding-3-small",
        input=word_lower,
    )
    embedding = response.data[0].embedding
    embedding_cache[word_lower] = embedding
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


# ============== CONSTANTS ==============

ELIMINATION_THRESHOLD = 0.95
MIN_PLAYERS = 3
MAX_PLAYERS = 4


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

        # GET /api/games/{code}
        if path.startswith('/api/games/') and path.count('/') == 3:
            code = path.split('/')[3].upper()
            player_id = query.get('player_id', '')
            
            game = games.get(code)
            if not game:
                return self._send_error("Game not found", 404)
            
            player = game.get_player(player_id)
            if not player:
                return self._send_error("You are not in this game", 403)
            
            return self._send_json(game.to_dict(player_id))

        self._send_error("Not found", 404)

    def do_POST(self):
        path = self.path.split('?')[0]
        body = self._get_body()

        # POST /api/games - Create game
        if path == '/api/games':
            code = generate_game_code()
            while code in games:
                code = generate_game_code()
            game = Game(code=code, host_id="")
            games[code] = game
            return self._send_json({"code": code, "player_id": ""})

        # POST /api/games/{code}/join
        if '/join' in path:
            code = path.split('/')[3].upper()
            game = games.get(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game.status != GameStatus.WAITING:
                return self._send_error("Game has already started", 400)
            if len(game.players) >= MAX_PLAYERS:
                return self._send_error("Game is full", 400)
            
            name = body.get('name', '').strip()
            secret_word = body.get('secret_word', '').strip()
            
            if not name or not secret_word:
                return self._send_error("Name and secret word required", 400)
            
            if any(p.name.lower() == name.lower() for p in game.players):
                return self._send_error("Name already taken", 400)
            
            if not is_valid_word(secret_word):
                return self._send_error("Please enter a valid English word", 400)
            
            try:
                embedding = get_embedding(secret_word)
            except Exception as e:
                return self._send_error(f"API error: {str(e)}", 503)
            
            player_id = generate_player_id()
            player = Player(
                id=player_id,
                name=name,
                secret_word=secret_word.lower(),
                secret_embedding=embedding,
            )
            game.players.append(player)
            
            if len(game.players) == 1:
                game.host_id = player_id
            
            return self._send_json({"player_id": player_id})

        # POST /api/games/{code}/start
        if '/start' in path:
            code = path.split('/')[3].upper()
            game = games.get(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            
            player_id = body.get('player_id', '')
            if game.host_id != player_id:
                return self._send_error("Only the host can start", 403)
            if game.status != GameStatus.WAITING:
                return self._send_error("Game already started", 400)
            if len(game.players) < MIN_PLAYERS:
                return self._send_error(f"Need at least {MIN_PLAYERS} players", 400)
            
            game.status = GameStatus.PLAYING
            game.current_turn = 0
            return self._send_json({"status": "started"})

        # POST /api/games/{code}/guess
        if '/guess' in path:
            code = path.split('/')[3].upper()
            game = games.get(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game.status != GameStatus.PLAYING:
                return self._send_error("Game not in progress", 400)
            
            player_id = body.get('player_id', '')
            word = body.get('word', '').strip()
            
            player = game.get_player(player_id)
            if not player:
                return self._send_error("You are not in this game", 403)
            if not player.is_alive:
                return self._send_error("You have been eliminated", 400)
            
            current = game.get_current_player()
            if not current or current.id != player_id:
                return self._send_error("It's not your turn", 400)
            
            if not is_valid_word(word):
                return self._send_error("Please enter a valid English word", 400)
            
            try:
                guess_embedding = get_embedding(word)
            except Exception as e:
                return self._send_error(f"API error: {str(e)}", 503)
            
            similarities = {}
            for p in game.players:
                sim = cosine_similarity(guess_embedding, p.secret_embedding)
                similarities[p.id] = round(sim, 2)
            
            eliminations = []
            for p in game.players:
                if p.id != player_id and p.is_alive:
                    if similarities.get(p.id, 0) >= ELIMINATION_THRESHOLD:
                        p.is_alive = False
                        eliminations.append(p.id)
            
            if eliminations:
                player.can_change_word = True
            
            result = GuessResult(
                guesser_id=player.id,
                guesser_name=player.name,
                word=word.lower(),
                similarities=similarities,
                eliminations=eliminations,
            )
            game.history.append(result)
            game.advance_turn()
            
            return self._send_json({
                "similarities": similarities,
                "eliminations": eliminations,
                "game_over": game.status == GameStatus.FINISHED,
                "winner": game.winner,
            })

        # POST /api/games/{code}/change-word
        if '/change-word' in path:
            code = path.split('/')[3].upper()
            game = games.get(code)
            
            if not game:
                return self._send_error("Game not found", 404)
            if game.status != GameStatus.PLAYING:
                return self._send_error("Game not in progress", 400)
            
            player_id = body.get('player_id', '')
            new_word = body.get('new_word', '').strip()
            
            player = game.get_player(player_id)
            if not player:
                return self._send_error("You are not in this game", 403)
            if not player.can_change_word:
                return self._send_error("You don't have a word change", 400)
            if not is_valid_word(new_word):
                return self._send_error("Please enter a valid English word", 400)
            
            try:
                embedding = get_embedding(new_word)
            except Exception as e:
                return self._send_error(f"API error: {str(e)}", 503)
            
            player.secret_word = new_word.lower()
            player.secret_embedding = embedding
            player.can_change_word = False
            
            return self._send_json({"status": "word_changed"})

        self._send_error("Not found", 404)
