"""
AI Service
AI player logic for singleplayer mode
"""

import random
import secrets
from typing import Optional, List, Dict, Any
from wordfreq import word_frequency

from .embedding_service import get_embedding, cosine_similarity

# AI difficulty configurations
AI_DIFFICULTY_CONFIG = {
    "rookie": {
        "name_prefix": "Rookie",
        "strategic_chance": 0.18,
        "word_selection": "random",
        "targeting_strength": 0.25,
        "min_target_similarity": 0.6,
        "delay_range": (1, 3),
        "badge": "🤖",
        "self_leak_soft_max": 0.92,
        "self_leak_hard_max": 0.98,
        "panic_danger": "critical",
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
        "candidate_pool": 30,                # Evaluates more options
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

AI_NAME_SUFFIXES = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta"]


def generate_ai_player_id(difficulty: str) -> str:
    """Generate a unique AI player ID."""
    return f"ai_{difficulty}_{secrets.token_hex(4)}"


def create_ai_player(difficulty: str, existing_names: List[str]) -> dict:
    """Create an AI player with the specified difficulty."""
    default_cfg = AI_DIFFICULTY_CONFIG.get("rookie", {})
    config = AI_DIFFICULTY_CONFIG.get(difficulty, default_cfg)
    
    # Generate unique name
    used_suffixes = set()
    for name in existing_names:
        for suffix in AI_NAME_SUFFIXES:
            if suffix in name:
                used_suffixes.add(suffix)
    
    available_suffixes = [s for s in AI_NAME_SUFFIXES if s not in used_suffixes]
    suffix = available_suffixes[0] if available_suffixes else random.choice(AI_NAME_SUFFIXES)
    
    name = f"{config['name_prefix']}-{suffix}"
    
    # Cosmetics based on difficulty
    ai_cosmetics = {
        "rookie": {"card_border": "classic", "card_background": "default", "name_color": "default"},
        "analyst": {"card_border": "ice", "card_background": "gradient_ice", "name_color": "ice"},
        "field-agent": {"card_border": "fire", "card_background": "matrix_code", "name_color": "fire"},
        "spymaster": {"card_border": "gold_elite", "card_background": "circuit_board", "name_color": "gold"},
        "ghost": {"card_border": "electric", "card_background": "starfield", "name_color": "shadow"},
        "nemesis": {"card_border": "void", "card_background": "void", "name_color": "void"},
    }
    selected_cosmetics = ai_cosmetics.get(difficulty, ai_cosmetics["rookie"])

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
        "is_ready": True,
        "cosmetics": {
            "card_border": selected_cosmetics["card_border"],
            "card_background": selected_cosmetics["card_background"],
            "name_color": selected_cosmetics["name_color"],
            "badge": config["badge"],
        },
        "ai_memory": {
            "high_similarity_targets": {},
            "guessed_words": [],
        },
    }


def ai_select_secret_word(ai_player: dict, word_pool: List[str]) -> Optional[str]:
    """AI selects a secret word based on difficulty."""
    difficulty = ai_player.get("difficulty", "rookie")
    config = AI_DIFFICULTY_CONFIG.get(difficulty, AI_DIFFICULTY_CONFIG["rookie"])
    selection_mode = config.get("word_selection", "random")
    
    if not word_pool:
        return None
    
    try:
        if selection_mode == "random":
            return random.choice(word_pool)
        
        elif selection_mode == "avoid_common":
            words_with_freq = [(w, word_frequency(w.lower(), 'en')) for w in word_pool]
            words_with_freq.sort(key=lambda x: x[1])
            less_common = words_with_freq[:len(words_with_freq)//2 + 1]
            return random.choice(less_common)[0]
        
        elif selection_mode == "obscure":
            words_with_freq = [(w, word_frequency(w.lower(), 'en')) for w in word_pool]
            words_with_freq.sort(key=lambda x: x[1])
            obscure_count = max(1, len(words_with_freq)//10)
            obscure_words = words_with_freq[:obscure_count]
            return random.choice(obscure_words)[0]
        
        return random.choice(word_pool)
    except Exception as e:
        print(f"Error in ai_select_secret_word: {e}")
        return random.choice(word_pool)


def ai_update_memory(ai_player: dict, guess_word: str, similarities: dict, game: dict):
    """Update AI's memory after a guess is made."""
    memory = ai_player.get("ai_memory", {})
    if "guessed_words" not in memory:
        memory["guessed_words"] = []
    if "high_similarity_targets" not in memory:
        memory["high_similarity_targets"] = {}
    
    memory["guessed_words"].append(guess_word.lower())
    
    for player_id, sim in similarities.items():
        if player_id == ai_player["id"]:
            continue
        player = next((p for p in game["players"] if p["id"] == player_id), None)
        if player and player.get("is_alive", True):
            if player_id not in memory["high_similarity_targets"]:
                memory["high_similarity_targets"][player_id] = []
            memory["high_similarity_targets"][player_id].append((guess_word, sim))
            memory["high_similarity_targets"][player_id].sort(key=lambda x: x[1], reverse=True)
            memory["high_similarity_targets"][player_id] = memory["high_similarity_targets"][player_id][:5]
    
    ai_player["ai_memory"] = memory


def ai_find_similar_words(target_word: str, theme_words: List[str], guessed_words: List[str], count: int = 5) -> List[str]:
    """Find words in theme semantically similar to target word.
    
    Note: guessed_words parameter is kept for API compatibility but no longer used for filtering.
    Bots should be able to re-guess words because players may have changed their words.
    """
    try:
        target_embedding = get_embedding(target_word)
        
        candidates = []
        for word in theme_words:
            word_embedding = get_embedding(word)
            sim = cosine_similarity(target_embedding, word_embedding)
            candidates.append((word, sim))
        
        candidates.sort(key=lambda x: x[1], reverse=True)
        return [c[0] for c in candidates[:count]]
    
    except Exception as e:
        print(f"Error finding similar words: {e}")
        return []


def ai_choose_guess(ai_player: dict, game: dict) -> Optional[str]:
    """AI chooses a word to guess based on difficulty and game state."""
    difficulty = ai_player.get("difficulty", "rookie")
    config = AI_DIFFICULTY_CONFIG.get(difficulty, AI_DIFFICULTY_CONFIG["rookie"])
    
    theme_words = game.get("theme", {}).get("words", [])
    memory = ai_player.get("ai_memory", {})
    guessed_words = memory.get("guessed_words", [])
    my_secret = (ai_player.get("secret_word") or "").lower().strip()
    
    # Build available words - allow re-guessing words that were guessed before
    # because players may have changed their words or new players might be vulnerable
    # Only exclude our own secret word
    available_words = []
    for w in theme_words:
        wl = str(w).lower()
        if my_secret and wl == my_secret:
            continue
        available_words.append(w)
    
    if not available_words:
        return None
    
    strategic_chance = float(config.get("strategic_chance", 0.15))
    
    # Strategic guess
    if random.random() < strategic_chance:
        targets = memory.get("high_similarity_targets", {})
        if targets:
            best_target = None
            best_score = 0
            
            for player_id, sims in targets.items():
                player = next((p for p in game["players"] if p["id"] == player_id), None)
                if not player or not player.get("is_alive", True):
                    continue
                
                if sims:
                    top_sim = sims[0][1] if sims else 0
                    avg_sim = sum(s[1] for s in sims) / len(sims) if sims else 0
                    score = top_sim * 0.7 + avg_sim * 0.3
                    
                    if score > best_score:
                        best_score = score
                        best_target = {"top_word": sims[0][0] if sims else None}
            
            if best_target and best_target["top_word"]:
                similar = ai_find_similar_words(
                    best_target["top_word"],
                    available_words,
                    guessed_words,
                    count=5
                )
                if similar:
                    return random.choice(similar[:3])
    
    # Random guess
    return random.choice(available_words)


def ai_change_word(ai_player: dict, game: dict) -> Optional[str]:
    """AI changes their secret word when given the opportunity."""
    word_pool = ai_player.get("word_pool", [])
    guessed_words = [e.get("word", "").lower() for e in game.get("history", []) if e.get("word")]
    
    available = [w for w in word_pool if w.lower() not in guessed_words]
    if not available:
        return ai_player.get("secret_word")
    
    return ai_select_secret_word(ai_player, available)

