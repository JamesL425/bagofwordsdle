"""
Services Module
Re-exports all service modules
"""

from .embedding_service import (
    get_embedding,
    cosine_similarity,
    batch_get_embeddings,
)

from .ai_service import (
    AI_DIFFICULTY_CONFIG,
    create_ai_player,
    ai_select_secret_word,
    ai_update_memory,
    ai_find_similar_words,
    ai_choose_guess,
    ai_change_word,
)

from .economy_service import (
    get_user_credits,
    add_user_credits,
    check_and_update_streak,
    get_next_streak_info,
    user_owns_cosmetic,
    grant_owned_cosmetic,
    generate_daily_quests,
    generate_weekly_quests,
)

from .game_service import (
    generate_game_code,
    generate_player_id,
    create_game,
    add_player,
    remove_player,
    set_player_word,
    advance_turn,
    eliminate_player,
    check_game_over,
    get_game_for_player,
)

__all__ = [
    # Embedding service
    "get_embedding",
    "cosine_similarity",
    "batch_get_embeddings",
    # AI service
    "AI_DIFFICULTY_CONFIG",
    "create_ai_player",
    "ai_select_secret_word",
    "ai_update_memory",
    "ai_find_similar_words",
    "ai_choose_guess",
    "ai_change_word",
    # Economy service
    "get_user_credits",
    "add_user_credits",
    "check_and_update_streak",
    "get_next_streak_info",
    "user_owns_cosmetic",
    "grant_owned_cosmetic",
    "generate_daily_quests",
    "generate_weekly_quests",
    # Game service
    "generate_game_code",
    "generate_player_id",
    "create_game",
    "add_player",
    "remove_player",
    "set_player_word",
    "advance_turn",
    "eliminate_player",
    "check_game_over",
    "get_game_for_player",
]

