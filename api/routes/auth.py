"""
Auth Routes
Handles authentication endpoints (OAuth, JWT)
"""

import os
import json
import jwt
import time
from typing import Tuple, Any


# JWT settings
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "dev-secret-key-change-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 24 * 7  # 1 week


def handle_auth_routes(handler, method: str, path: str, body: dict) -> Tuple[int, Any]:
    """
    Route handler for authentication endpoints.
    
    Returns:
        Tuple of (status_code, response_body)
    """
    from ..data import get_user_by_id, get_user_by_email, save_user
    
    # GET /api/auth/me - Get current user
    if path == "/api/auth/me" and method == "GET":
        token = handler.get_auth_token()
        if not token:
            return 401, {"detail": "Not authenticated"}
        
        user_data = verify_jwt_token(token)
        if not user_data:
            return 401, {"detail": "Invalid token"}
        
        user_id = user_data.get("sub")
        user = get_user_by_id(user_id)
        
        if not user:
            return 404, {"detail": "User not found"}
        
        return 200, {
            "id": user["id"],
            "name": user.get("name", "Unknown"),
            "email": user.get("email"),
            "avatar": user.get("avatar"),
            "is_admin": user.get("is_admin", False),
            "is_donor": user.get("is_donor", False),
            "stats": user.get("stats", {}),
        }
    
    # GET /api/auth/google - Initiate Google OAuth
    if path == "/api/auth/google" and method == "GET":
        client_id = os.getenv("GOOGLE_CLIENT_ID")
        if not client_id:
            return 500, {"detail": "Google OAuth not configured"}
        
        redirect_uri = get_oauth_redirect_uri(handler)
        state = generate_oauth_state()
        
        auth_url = (
            f"https://accounts.google.com/o/oauth2/v2/auth"
            f"?client_id={client_id}"
            f"&redirect_uri={redirect_uri}"
            f"&response_type=code"
            f"&scope=openid%20email%20profile"
            f"&state={state}"
        )
        
        return 302, {"redirect": auth_url}
    
    # GET /api/auth/google/callback - Handle OAuth callback
    if path == "/api/auth/google/callback" and method == "GET":
        code = handler.get_query_param("code")
        error = handler.get_query_param("error")
        
        if error:
            return 302, {"redirect": f"/?auth_error={error}"}
        
        if not code:
            return 302, {"redirect": "/?auth_error=no_code"}
        
        try:
            # Exchange code for tokens
            tokens = exchange_google_code(code, handler)
            if not tokens:
                return 302, {"redirect": "/?auth_error=token_exchange_failed"}
            
            # Get user info
            user_info = get_google_user_info(tokens["access_token"])
            if not user_info:
                return 302, {"redirect": "/?auth_error=user_info_failed"}
            
            # Get or create user
            user = get_or_create_user(user_info)
            
            # Create JWT
            token = create_jwt_token({"sub": user["id"], "email": user.get("email")})
            
            return 302, {"redirect": f"/?auth_token={token}"}
            
        except Exception as e:
            print(f"[AUTH] OAuth error: {e}")
            return 302, {"redirect": f"/?auth_error=oauth_failed"}
    
    # POST /api/auth/admin - Admin login
    if path == "/api/auth/admin" and method == "POST":
        password = body.get("password")
        admin_password = os.getenv("ADMIN_PASSWORD")
        
        if not admin_password:
            return 403, {"detail": "Admin login not configured"}
        
        if password != admin_password:
            return 403, {"detail": "Invalid password"}
        
        token = create_jwt_token({"sub": "admin_local", "is_admin": True})
        
        return 200, {"token": token}
    
    return None  # Not handled


def create_jwt_token(payload: dict, expiry_hours: int = None) -> str:
    """Create a JWT token."""
    exp = int(time.time()) + (expiry_hours or JWT_EXPIRY_HOURS) * 3600
    token_payload = {
        **payload,
        "exp": exp,
        "iat": int(time.time()),
    }
    return jwt.encode(token_payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def verify_jwt_token(token: str) -> dict:
    """Verify and decode a JWT token."""
    try:
        return jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def generate_oauth_state() -> str:
    """Generate a random OAuth state parameter."""
    import secrets
    return secrets.token_urlsafe(32)


def get_oauth_redirect_uri(handler) -> str:
    """Get the OAuth redirect URI."""
    base_url = os.getenv("VERCEL_URL", "localhost:3000")
    protocol = "https" if "vercel" in base_url else "http"
    return f"{protocol}://{base_url}/api/auth/google/callback"


def exchange_google_code(code: str, handler) -> dict:
    """Exchange authorization code for tokens."""
    import requests
    
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    redirect_uri = get_oauth_redirect_uri(handler)
    
    response = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }
    )
    
    if response.status_code != 200:
        return None
    
    return response.json()


def get_google_user_info(access_token: str) -> dict:
    """Get user info from Google."""
    import requests
    
    response = requests.get(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        headers={"Authorization": f"Bearer {access_token}"}
    )
    
    if response.status_code != 200:
        return None
    
    return response.json()


def get_or_create_user(google_user: dict) -> dict:
    """Get or create a user from Google user info."""
    from ..data import get_user_by_email, save_user
    import secrets
    
    email = google_user.get("email", "").lower()
    
    # Check for existing user
    existing = get_user_by_email(email)
    if existing:
        # Update avatar if changed
        if google_user.get("picture") != existing.get("avatar"):
            existing["avatar"] = google_user.get("picture")
            save_user(existing)
        return existing
    
    # Create new user
    user = {
        "id": secrets.token_hex(16),
        "email": email,
        "name": google_user.get("name", email.split("@")[0]),
        "avatar": google_user.get("picture"),
        "is_admin": False,
        "is_donor": False,
        "created_at": int(time.time()),
        "stats": {},
        "cosmetics": {},
        "wallet": {"credits": 0},
        "streak": {},
    }
    
    save_user(user)
    return user

