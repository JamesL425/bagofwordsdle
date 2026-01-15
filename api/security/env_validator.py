"""
Environment Variable Validation Module

Validates that all required environment variables are set
before the application starts, preventing runtime errors
from missing configuration.
"""

import os
import sys
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass


@dataclass
class EnvVarConfig:
    """Configuration for an environment variable."""
    name: str
    required: bool = True
    description: str = ""
    default: Optional[str] = None
    sensitive: bool = True  # Don't log the value
    validator: Optional[callable] = None


# Required environment variables
REQUIRED_ENV_VARS: List[EnvVarConfig] = [
    EnvVarConfig(
        name="OPENAI_API_KEY",
        required=True,
        description="OpenAI API key for embedding generation",
        sensitive=True,
    ),
    EnvVarConfig(
        name="UPSTASH_REDIS_REST_URL",
        required=True,
        description="Upstash Redis REST API URL",
        sensitive=False,
    ),
    EnvVarConfig(
        name="UPSTASH_REDIS_REST_TOKEN",
        required=True,
        description="Upstash Redis REST API token",
        sensitive=True,
    ),
    EnvVarConfig(
        name="GOOGLE_CLIENT_ID",
        required=True,
        description="Google OAuth client ID",
        sensitive=False,
    ),
    EnvVarConfig(
        name="GOOGLE_CLIENT_SECRET",
        required=True,
        description="Google OAuth client secret",
        sensitive=True,
    ),
    EnvVarConfig(
        name="JWT_SECRET",
        required=True,
        description="Secret key for JWT token signing (min 32 chars recommended)",
        sensitive=True,
        validator=lambda v: len(v) >= 32,
    ),
]

# Optional but recommended environment variables
OPTIONAL_ENV_VARS: List[EnvVarConfig] = [
    EnvVarConfig(
        name="KOFI_VERIFICATION_TOKEN",
        required=False,
        description="Ko-fi webhook verification token (required for donations)",
        sensitive=True,
    ),
    EnvVarConfig(
        name="ADMIN_EMAILS",
        required=False,
        description="Comma-separated list of admin email addresses",
        sensitive=False,
    ),
    EnvVarConfig(
        name="SITE_URL",
        required=False,
        description="Base URL of the site (for OAuth redirects)",
        sensitive=False,
    ),
    EnvVarConfig(
        name="OAUTH_REDIRECT_URI",
        required=False,
        description="Explicit OAuth redirect URI",
        sensitive=False,
    ),
    EnvVarConfig(
        name="SESSION_TOKEN_SECRET",
        required=False,
        description="Secret for signing game session tokens (defaults to JWT_SECRET)",
        sensitive=True,
    ),
    EnvVarConfig(
        name="KOFI_SKIP_VERIFICATION",
        required=False,
        description="Set to 'true' to skip Ko-fi webhook verification (development only)",
        sensitive=False,
    ),
]


def validate_env_var(config: EnvVarConfig) -> Tuple[bool, Optional[str]]:
    """
    Validate a single environment variable.
    
    Returns:
        Tuple of (is_valid, error_message)
    """
    value = os.getenv(config.name)
    
    if value is None or value.strip() == "":
        if config.required:
            return False, f"Missing required environment variable: {config.name}"
        return True, None
    
    if config.validator:
        try:
            if not config.validator(value):
                return False, f"Invalid value for {config.name}: validation failed"
        except Exception as e:
            return False, f"Invalid value for {config.name}: {e}"
    
    return True, None


def validate_required_env_vars(
    strict: bool = True,
    include_optional: bool = False,
) -> Tuple[bool, List[str]]:
    """
    Validate all required environment variables.
    
    Args:
        strict: If True, raise RuntimeError on missing vars (production behavior)
        include_optional: If True, also validate optional vars
    
    Returns:
        Tuple of (all_valid, list_of_error_messages)
    """
    errors: List[str] = []
    warnings: List[str] = []
    
    # Check if we're in production
    is_production = os.getenv('VERCEL_ENV') == 'production'
    
    # Validate required vars
    for config in REQUIRED_ENV_VARS:
        is_valid, error = validate_env_var(config)
        if not is_valid:
            if is_production or strict:
                errors.append(error)
            else:
                warnings.append(f"[DEV WARNING] {error}")
    
    # Validate optional vars if requested
    if include_optional:
        for config in OPTIONAL_ENV_VARS:
            is_valid, error = validate_env_var(config)
            if not is_valid and error:
                warnings.append(f"[OPTIONAL] {error}")
    
    # Log warnings
    for warning in warnings:
        print(f"[SECURITY] {warning}")
    
    # In production, fail hard on missing required vars
    if errors:
        for error in errors:
            print(f"[SECURITY ERROR] {error}")
        
        if strict and is_production:
            raise RuntimeError(
                f"Missing required environment variables: {', '.join(e.split(':')[0] for e in errors)}"
            )
    
    return len(errors) == 0, errors


def get_env_status() -> Dict[str, Dict[str, any]]:
    """
    Get status of all environment variables (for admin debugging).
    
    Returns dict with var names and their status (set/unset, not values).
    """
    status = {}
    
    for config in REQUIRED_ENV_VARS + OPTIONAL_ENV_VARS:
        value = os.getenv(config.name)
        is_set = value is not None and value.strip() != ""
        
        status[config.name] = {
            "is_set": is_set,
            "required": config.required,
            "description": config.description,
            "valid": validate_env_var(config)[0] if is_set else None,
        }
    
    return status


def print_env_status():
    """Print environment variable status to console."""
    status = get_env_status()
    
    print("\n[SECURITY] Environment Variable Status:")
    print("-" * 60)
    
    for name, info in status.items():
        req_str = "REQUIRED" if info["required"] else "optional"
        set_str = "✓ SET" if info["is_set"] else "✗ MISSING"
        valid_str = ""
        if info["is_set"] and info["valid"] is not None:
            valid_str = " (valid)" if info["valid"] else " (INVALID)"
        
        print(f"  {name}: {set_str}{valid_str} [{req_str}]")
    
    print("-" * 60)


# Auto-validate on module import in production
if os.getenv('VERCEL_ENV') == 'production':
    try:
        validate_required_env_vars(strict=True)
    except RuntimeError as e:
        print(f"[SECURITY FATAL] {e}")
        # Don't exit here - let Vercel handle the error

