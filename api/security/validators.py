"""
Centralized Input Validation Module

Provides unified validation and sanitization for all user inputs
with consistent error handling and security logging.
"""

import re
import html
import hashlib
from typing import Optional, Pattern, Callable, Any, Tuple
from dataclasses import dataclass


@dataclass
class ValidationResult:
    """Result of a validation operation."""
    is_valid: bool
    value: Optional[str]
    error: Optional[str] = None


class Validators:
    """
    Centralized validation patterns and methods.
    
    All patterns are compiled once for performance.
    """
    
    # Game code: 6 uppercase alphanumeric characters
    GAME_CODE = re.compile(r'^[A-Z0-9]{6}$')
    
    # Player ID: 32 lowercase hex characters (128 bits for better entropy)
    PLAYER_ID = re.compile(r'^[a-f0-9]{32}$')
    
    # Player name: 1-20 alphanumeric, underscore, space
    PLAYER_NAME = re.compile(r'^[a-zA-Z0-9_ ]{1,20}$')
    
    # Word: 2-30 alphabetic characters only
    WORD = re.compile(r'^[a-zA-Z]{2,30}$')
    
    # Chat message: printable ASCII, 1-200 chars
    CHAT_MESSAGE = re.compile(r'^[\x20-\x7E]{1,200}$')
    
    # Email: basic email validation
    EMAIL = re.compile(r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$')
    
    # JWT token: base64url encoded segments
    JWT_TOKEN = re.compile(r'^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
    
    # Hex string (for various IDs)
    HEX_STRING = re.compile(r'^[a-fA-F0-9]+$')
    
    # Theme name: alphanumeric with spaces and common punctuation
    THEME_NAME = re.compile(r'^[a-zA-Z0-9 &\-\']{1,50}$')
    
    # Cosmetic ID: lowercase alphanumeric with underscores
    COSMETIC_ID = re.compile(r'^[a-z0-9_]{1,50}$')
    
    # Quest ID: alphanumeric with underscores
    QUEST_ID = re.compile(r'^[a-zA-Z0-9_]{1,50}$')
    
    # Reserved names that cannot be used
    RESERVED_NAMES = frozenset(['admin', 'system', 'embeddle', 'moderator', 'mod', 'bot'])
    
    @classmethod
    def validate(
        cls,
        value: Any,
        pattern: Pattern,
        transform: Optional[Callable[[str], str]] = None,
        max_length: Optional[int] = None,
        min_length: int = 1,
    ) -> ValidationResult:
        """
        Validate and optionally transform a value.
        
        Args:
            value: Value to validate
            pattern: Compiled regex pattern
            transform: Optional transformation function (e.g., str.lower)
            max_length: Maximum allowed length
            min_length: Minimum required length
        
        Returns:
            ValidationResult with is_valid, sanitized value, and error message
        """
        if value is None:
            return ValidationResult(False, None, "Value is required")
        
        if not isinstance(value, str):
            try:
                value = str(value)
            except Exception:
                return ValidationResult(False, None, "Invalid value type")
        
        # Strip whitespace
        value = value.strip()
        
        # Length checks
        if len(value) < min_length:
            return ValidationResult(False, None, f"Value must be at least {min_length} characters")
        
        if max_length and len(value) > max_length:
            return ValidationResult(False, None, f"Value must be at most {max_length} characters")
        
        # Apply transformation before pattern check if specified
        if transform:
            try:
                value = transform(value)
            except Exception:
                return ValidationResult(False, None, "Value transformation failed")
        
        # Pattern validation
        if not pattern.match(value):
            return ValidationResult(False, None, "Value contains invalid characters")
        
        return ValidationResult(True, value, None)


# Convenience functions for common validations

def sanitize_game_code(code: Any) -> Optional[str]:
    """
    Validate and sanitize game code.
    
    Returns uppercase 6-char alphanumeric code or None if invalid.
    """
    result = Validators.validate(
        code,
        Validators.GAME_CODE,
        transform=str.upper,
        max_length=6,
        min_length=6,
    )
    return result.value if result.is_valid else None


def sanitize_player_id(player_id: Any) -> Optional[str]:
    """
    Validate player ID format.
    
    Returns lowercase 32-char hex string or None if invalid.
    """
    result = Validators.validate(
        player_id,
        Validators.PLAYER_ID,
        transform=str.lower,
        max_length=32,
        min_length=32,
    )
    return result.value if result.is_valid else None


def sanitize_player_name(name: Any, allow_admin: bool = False) -> Optional[str]:
    """
    Sanitize player name.
    
    Returns HTML-escaped name or None if invalid.
    Blocks reserved names unless allow_admin is True.
    """
    result = Validators.validate(
        name,
        Validators.PLAYER_NAME,
        max_length=20,
        min_length=1,
    )
    
    if not result.is_valid or result.value is None:
        return None
    
    # Check reserved names
    if not allow_admin and result.value.lower() in Validators.RESERVED_NAMES:
        return None
    
    # HTML escape to prevent XSS
    return html.escape(result.value)


def sanitize_word(word: Any) -> Optional[str]:
    """
    Sanitize word input.
    
    Returns lowercase alphabetic word or None if invalid.
    """
    result = Validators.validate(
        word,
        Validators.WORD,
        transform=str.lower,
        max_length=30,
        min_length=2,
    )
    return result.value if result.is_valid else None


def sanitize_chat_message(message: Any, max_length: int = 200) -> Optional[str]:
    """
    Sanitize chat message.
    
    Returns cleaned message or None if invalid.
    Removes control characters and enforces length limit.
    """
    if message is None:
        return None
    
    if not isinstance(message, str):
        try:
            message = str(message)
        except Exception:
            return None
    
    # Strip and limit length
    message = message.strip()[:max_length]
    
    if not message:
        return None
    
    # Remove control characters (keep printable ASCII and common unicode)
    message = re.sub(r'[\x00-\x1F\x7F]', '', message)
    
    if not message:
        return None
    
    return message


def sanitize_email(email: Any) -> Optional[str]:
    """
    Sanitize email address.
    
    Returns lowercase email or None if invalid.
    """
    result = Validators.validate(
        email,
        Validators.EMAIL,
        transform=str.lower,
        max_length=254,
        min_length=5,
    )
    return result.value if result.is_valid else None


def sanitize_cosmetic_id(cosmetic_id: Any) -> Optional[str]:
    """
    Sanitize cosmetic ID.
    
    Returns lowercase cosmetic ID or None if invalid.
    """
    result = Validators.validate(
        cosmetic_id,
        Validators.COSMETIC_ID,
        transform=str.lower,
        max_length=50,
        min_length=1,
    )
    return result.value if result.is_valid else None


def sanitize_theme_name(theme: Any) -> Optional[str]:
    """
    Sanitize theme name.
    
    Returns theme name or None if invalid.
    """
    result = Validators.validate(
        theme,
        Validators.THEME_NAME,
        max_length=50,
        min_length=1,
    )
    return result.value if result.is_valid else None


def validate_request_body_size(
    content_length: int,
    max_size: int = 10240,  # 10KB default
) -> Tuple[bool, str]:
    """
    Validate request body size.
    
    Args:
        content_length: Content-Length header value
        max_size: Maximum allowed size in bytes
    
    Returns:
        Tuple of (is_valid, error_message)
    """
    if content_length <= 0:
        return True, ""  # Empty body is OK
    
    if content_length > max_size:
        return False, f"Request body too large. Maximum size is {max_size} bytes."
    
    return True, ""


def hash_for_lookup(value: str) -> str:
    """
    Create a hash suitable for database lookups.
    
    Used for things like email-to-user mapping where we don't
    want to store plaintext emails as keys.
    """
    return hashlib.sha256(value.lower().encode()).hexdigest()


# Request body size limits by endpoint type
REQUEST_SIZE_LIMITS = {
    "general": 10240,      # 10KB
    "chat": 1024,          # 1KB
    "game_action": 5120,   # 5KB
    "webhook": 65536,      # 64KB (Ko-fi webhooks can be larger)
    "auth": 2048,          # 2KB
}


def get_request_size_limit(endpoint_type: str) -> int:
    """Get the request body size limit for an endpoint type."""
    return REQUEST_SIZE_LIMITS.get(endpoint_type, REQUEST_SIZE_LIMITS["general"])

