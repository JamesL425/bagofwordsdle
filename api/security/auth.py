"""
Authentication and Authorization Module

Provides:
- JWT token creation and verification
- Token refresh mechanism
- Token revocation list
- Reusable auth decorators
"""

import os
import time
import secrets
import hashlib
import hmac
from typing import Optional, Dict, Any, Callable, Tuple
from dataclasses import dataclass
from functools import wraps

import jwt


# ============== CONFIGURATION ==============

# JWT Configuration
JWT_ALGORITHM = 'HS256'
JWT_EXPIRY_HOURS = 24 * 7  # 1 week
JWT_REFRESH_THRESHOLD_HOURS = 24  # Refresh if less than 24h remaining

# Token revocation TTL (keep revoked tokens in list until they would have expired anyway)
TOKEN_REVOCATION_TTL_SECONDS = JWT_EXPIRY_HOURS * 3600

# Admin emails - loaded from environment
_admin_emails: Optional[set] = None


def _get_jwt_secret() -> str:
    """
    Get JWT secret from environment.
    
    SECURITY: This will raise an error if JWT_SECRET is not set,
    preventing the application from running with an insecure default.
    """
    secret = os.getenv('JWT_SECRET')
    if not secret:
        # In development, we can use a fallback, but log a warning
        if os.getenv('VERCEL_ENV', 'development') == 'development':
            print("[SECURITY WARNING] JWT_SECRET not set. Using insecure development secret.")
            return "INSECURE_DEV_SECRET_DO_NOT_USE_IN_PRODUCTION"
        raise RuntimeError("JWT_SECRET environment variable is required in production")
    return secret


def _get_admin_emails() -> set:
    """Get admin emails from environment. No fallback - require explicit configuration."""
    global _admin_emails
    if _admin_emails is None:
        # Try environment variable first
        env_admins = os.getenv('ADMIN_EMAILS', '')
        if env_admins:
            _admin_emails = {e.strip().lower() for e in env_admins.split(',') if e.strip()}
        else:
            # SECURITY: No hardcoded fallback - require explicit configuration
            _admin_emails = set()
    return _admin_emails


# ============== REDIS HELPERS ==============

_redis_client = None


def _get_redis():
    """Get Redis client (lazy initialization)."""
    global _redis_client
    if _redis_client is None:
        try:
            from upstash_redis import Redis
            _redis_client = Redis(
                url=os.getenv("UPSTASH_REDIS_REST_URL"),
                token=os.getenv("UPSTASH_REDIS_REST_TOKEN"),
            )
        except Exception as e:
            print(f"[SECURITY] Failed to initialize Redis for auth: {e}")
            return None
    return _redis_client


# ============== JWT FUNCTIONS ==============

@dataclass
class TokenPayload:
    """Decoded JWT token payload."""
    sub: str  # User ID
    email: str
    name: str
    avatar: str
    iat: int  # Issued at
    exp: int  # Expiry
    jti: str  # JWT ID (for revocation)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'sub': self.sub,
            'email': self.email,
            'name': self.name,
            'avatar': self.avatar,
            'iat': self.iat,
            'exp': self.exp,
            'jti': self.jti,
        }


def create_jwt_token(user_data: Dict[str, Any], custom_expiry_hours: Optional[int] = None) -> str:
    """
    Create a JWT token for authenticated user.
    
    Args:
        user_data: Dict with 'id', 'email', 'name', 'avatar' keys
        custom_expiry_hours: Optional custom expiry (default: JWT_EXPIRY_HOURS)
    
    Returns:
        Encoded JWT token string
    """
    expiry_hours = custom_expiry_hours or JWT_EXPIRY_HOURS
    now = int(time.time())
    
    # Generate unique token ID for revocation tracking
    jti = secrets.token_hex(16)
    
    payload = {
        'sub': user_data['id'],
        'email': user_data.get('email', ''),
        'name': user_data.get('name', ''),
        'avatar': user_data.get('avatar', ''),
        'iat': now,
        'exp': now + (expiry_hours * 3600),
        'jti': jti,
    }
    
    return jwt.encode(payload, _get_jwt_secret(), algorithm=JWT_ALGORITHM)


def verify_jwt_token(token: str) -> Optional[Dict[str, Any]]:
    """
    Verify and decode a JWT token.
    
    Returns None if:
    - Token is invalid or expired
    - Token has been revoked
    - Token signature doesn't match
    """
    try:
        payload = jwt.decode(token, _get_jwt_secret(), algorithms=[JWT_ALGORITHM])
        
        # Check if token has been revoked
        jti = payload.get('jti')
        if jti and is_token_revoked(jti):
            return None
        
        return payload
        
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None
    except Exception as e:
        print(f"[SECURITY] JWT verification error: {e}")
        return None


def refresh_jwt_token(token: str) -> Optional[str]:
    """
    Refresh a JWT token if it's close to expiry.
    
    Returns new token if refresh is needed and successful, None otherwise.
    """
    payload = verify_jwt_token(token)
    if not payload:
        return None
    
    # Check if refresh is needed
    exp = payload.get('exp', 0)
    now = int(time.time())
    remaining_hours = (exp - now) / 3600
    
    if remaining_hours > JWT_REFRESH_THRESHOLD_HOURS:
        return None  # No refresh needed
    
    # Revoke old token
    old_jti = payload.get('jti')
    if old_jti:
        revoke_token(old_jti, exp - now)
    
    # Create new token
    user_data = {
        'id': payload.get('sub'),
        'email': payload.get('email', ''),
        'name': payload.get('name', ''),
        'avatar': payload.get('avatar', ''),
    }
    
    return create_jwt_token(user_data)


def revoke_token(jti: str, ttl_seconds: Optional[int] = None) -> bool:
    """
    Add a token to the revocation list.
    
    Args:
        jti: JWT ID to revoke
        ttl_seconds: How long to keep in revocation list (default: TOKEN_REVOCATION_TTL_SECONDS)
    
    Returns:
        True if successfully revoked, False otherwise
    """
    redis = _get_redis()
    if not redis:
        print("[SECURITY] Cannot revoke token: Redis unavailable")
        return False
    
    try:
        ttl = ttl_seconds or TOKEN_REVOCATION_TTL_SECONDS
        redis.setex(f"revoked_token:{jti}", ttl, "1")
        return True
    except Exception as e:
        print(f"[SECURITY] Failed to revoke token: {e}")
        return False


def is_token_revoked(jti: str, fail_closed: bool = True) -> bool:
    """
    Check if a token has been revoked.
    
    Args:
        jti: JWT ID to check
        fail_closed: If True (default), return True (revoked) when Redis is unavailable.
                    This is the secure default for security-critical operations.
    """
    redis = _get_redis()
    if not redis:
        # If Redis is unavailable, fail based on security requirements
        if fail_closed:
            return True  # Assume revoked for security
        return False
    
    try:
        return redis.exists(f"revoked_token:{jti}") > 0
    except Exception:
        if fail_closed:
            return True
        return False


# ============== USER HELPERS ==============

@dataclass
class AuthenticatedUser:
    """Represents an authenticated user from JWT."""
    id: str
    email: str
    name: str
    avatar: str
    is_admin: bool
    token_payload: Dict[str, Any]


def get_current_user(headers: Dict[str, str]) -> Optional[AuthenticatedUser]:
    """
    Extract and validate user from request headers.
    
    Args:
        headers: Request headers dict
    
    Returns:
        AuthenticatedUser if valid token present, None otherwise
    """
    auth_header = headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return None
    
    token = auth_header[7:]
    payload = verify_jwt_token(token)
    
    if not payload:
        return None
    
    user_id = payload.get('sub', '')
    email = payload.get('email', '').lower()
    
    # Check admin status (email-based only)
    is_admin = email in _get_admin_emails()
    
    return AuthenticatedUser(
        id=user_id,
        email=email,
        name=payload.get('name', ''),
        avatar=payload.get('avatar', ''),
        is_admin=is_admin,
        token_payload=payload,
    )


def is_admin_user(headers: Dict[str, str]) -> bool:
    """Check if request is from an admin user."""
    user = get_current_user(headers)
    return user is not None and user.is_admin


# ============== DECORATORS ==============

def require_auth(send_error_func: Callable):
    """
    Decorator factory that requires valid JWT authentication.
    
    Usage:
        @require_auth(self._send_error)
        def handle_protected_endpoint(self, user: AuthenticatedUser):
            ...
    
    Args:
        send_error_func: Function to call to send error response
    """
    def decorator(handler: Callable):
        @wraps(handler)
        def wrapper(self, *args, **kwargs):
            user = get_current_user(dict(self.headers))
            if not user:
                return send_error_func("Authentication required", 401)
            return handler(self, user, *args, **kwargs)
        return wrapper
    return decorator


def require_admin(send_error_func: Callable):
    """
    Decorator factory that requires admin privileges.
    
    Usage:
        @require_admin(self._send_error)
        def handle_admin_endpoint(self, user: AuthenticatedUser):
            ...
    """
    def decorator(handler: Callable):
        @wraps(handler)
        def wrapper(self, *args, **kwargs):
            user = get_current_user(dict(self.headers))
            if not user:
                return send_error_func("Authentication required", 401)
            if not user.is_admin:
                return send_error_func("Admin access required", 403)
            return handler(self, user, *args, **kwargs)
        return wrapper
    return decorator


# ============== OAUTH HELPERS ==============

def generate_oauth_state() -> str:
    """Generate a secure random state for OAuth flow."""
    return secrets.token_urlsafe(32)


def constant_time_compare(a: str, b: str) -> bool:
    """
    Constant-time string comparison to prevent timing attacks.
    
    Used for OAuth state validation.
    """
    return hmac.compare_digest(a.encode(), b.encode())

