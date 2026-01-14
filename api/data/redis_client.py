"""
Redis Client Module
Centralized Redis connection management
"""

import os
from typing import Optional
from functools import lru_cache

# Lazy-initialized Redis client
_redis_client = None


def get_redis():
    """Get Redis client singleton."""
    global _redis_client
    if _redis_client is None:
        try:
            from upstash_redis import Redis
            _redis_client = Redis(
                url=os.getenv("UPSTASH_REDIS_REST_URL"),
                token=os.getenv("UPSTASH_REDIS_REST_TOKEN"),
            )
        except Exception as e:
            print(f"[DATA] Failed to initialize Redis: {e}")
            return None
    return _redis_client


def get_redis_url() -> Optional[str]:
    """Get Redis URL from environment."""
    return os.getenv("UPSTASH_REDIS_REST_URL")


def get_redis_token() -> Optional[str]:
    """Get Redis token from environment."""
    return os.getenv("UPSTASH_REDIS_REST_TOKEN")


def is_redis_configured() -> bool:
    """Check if Redis is properly configured."""
    return bool(get_redis_url() and get_redis_token())

