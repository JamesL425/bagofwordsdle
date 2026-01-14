"""
Embedding Service
Handles OpenAI embedding calls with caching
"""

import os
import json
import hashlib
from typing import Optional, List
import numpy as np

# Embedding settings
EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_CACHE_SECONDS = 86400  # 24 hours

# Lazy-initialized OpenAI client
_openai_client = None


def get_openai_client():
    """Get OpenAI client singleton."""
    global _openai_client
    if _openai_client is None:
        from openai import OpenAI
        _openai_client = OpenAI()
    return _openai_client


def _cache_key(word: str) -> str:
    """Generate cache key for embedding."""
    return f"emb:{hashlib.md5(word.lower().encode()).hexdigest()}"


def get_embedding(word: str) -> List[float]:
    """
    Get embedding for a word, using cache if available.
    
    Args:
        word: The word to get embedding for
        
    Returns:
        List of floats representing the embedding vector
    """
    from ..data.redis_client import get_redis
    
    word_lower = word.lower().strip()
    cache_key = _cache_key(word_lower)
    
    # Try cache first
    redis = get_redis()
    if redis:
        try:
            cached = redis.get(cache_key)
            if cached:
                return json.loads(cached)
        except Exception:
            pass
    
    # Call OpenAI API
    client = get_openai_client()
    response = client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=word_lower,
    )
    embedding = response.data[0].embedding
    
    # Cache the result
    if redis:
        try:
            redis.setex(cache_key, EMBEDDING_CACHE_SECONDS, json.dumps(embedding))
        except Exception:
            pass
    
    return embedding


def cosine_similarity(embedding1: List[float], embedding2: List[float]) -> float:
    """
    Calculate cosine similarity between two embeddings.
    
    Args:
        embedding1: First embedding vector
        embedding2: Second embedding vector
        
    Returns:
        Cosine similarity score between -1 and 1
    """
    a = np.array(embedding1)
    b = np.array(embedding2)
    
    dot_product = np.dot(a, b)
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    
    if norm_a == 0 or norm_b == 0:
        return 0.0
    
    return float(dot_product / (norm_a * norm_b))


def batch_get_embeddings(words: List[str]) -> dict:
    """
    Get embeddings for multiple words efficiently.
    
    Args:
        words: List of words to get embeddings for
        
    Returns:
        Dict mapping words to their embeddings
    """
    from ..data.redis_client import get_redis
    
    result = {}
    to_fetch = []
    
    # Check cache for each word
    redis = get_redis()
    for word in words:
        word_lower = word.lower().strip()
        cache_key = _cache_key(word_lower)
        
        if redis:
            try:
                cached = redis.get(cache_key)
                if cached:
                    result[word_lower] = json.loads(cached)
                    continue
            except Exception:
                pass
        
        to_fetch.append(word_lower)
    
    # Fetch remaining from API
    if to_fetch:
        client = get_openai_client()
        response = client.embeddings.create(
            model=EMBEDDING_MODEL,
            input=to_fetch,
        )
        
        for i, embedding_data in enumerate(response.data):
            word = to_fetch[i]
            embedding = embedding_data.embedding
            result[word] = embedding
            
            # Cache
            if redis:
                try:
                    cache_key = _cache_key(word)
                    redis.setex(cache_key, EMBEDDING_CACHE_SECONDS, json.dumps(embedding))
                except Exception:
                    pass
    
    return result

