from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from config import settings
from db.supabase_client import verify_token

UNPROTECTED_PATHS = {"/health", "/api/v1/llm/health", "/api/auth/login", "/api/auth/refresh", "/docs", "/openapi.json"}

# Local-dev stub user. The extension's sign-in flow (chrome.identity) never
# produces a Supabase JWT (gap in the original auth wiring), so for local
# testing we accept unauthenticated calls when DEV_MODE=true and inject this
# user. Re-enable real JWT verification by leaving DEV_MODE unset in prod.
_DEV_USER = {
    "id": "00000000-0000-0000-0000-000000000000",
    "email": "dev@local",
    "name": "Dev User",
    "role": "admin",
}


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path in UNPROTECTED_PATHS or request.method == "OPTIONS":
            return await call_next(request)

        if settings.dev_mode:
            request.state.user = _DEV_USER
            return await call_next(request)

        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return JSONResponse({"detail": "Missing or invalid Authorization header"}, status_code=401)

        token = auth_header.removeprefix("Bearer ").strip()
        user = await verify_token(token)

        if not user:
            return JSONResponse({"detail": "Invalid or expired token"}, status_code=401)

        request.state.user = user
        return await call_next(request)
