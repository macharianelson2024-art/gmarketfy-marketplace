import logging
from firebase_admin import auth

logger = logging.getLogger(__name__)


def authenticate_firebase_user(request):
    """Identical contract to the order-payments authenticator."""
    auth_header = request.headers.get("Authorization")

    if not auth_header:
        return {"authenticated": False, "message": "Authorization token is required"}
    if not auth_header.startswith("Bearer "):
        return {"authenticated": False, "message": "Invalid authorization format"}

    id_token = auth_header.split("Bearer ", 1)[1]

    try:
        decoded_token = auth.verify_id_token(id_token)
        return {"authenticated": True, "user": decoded_token}
    except auth.InvalidIdTokenError:
        return {"authenticated": False, "message": "Invalid Firebase ID token"}
    except auth.ExpiredIdTokenError:
        return {"authenticated": False, "message": "Firebase ID token has expired"}
    except Exception:
        logger.exception("Unexpected error verifying Firebase token")
        return {"authenticated": False, "message": "Authentication failed"}