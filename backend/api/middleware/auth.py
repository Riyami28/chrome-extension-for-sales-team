import structlog
from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from config import settings
from db.supabase_client import verify_token

log = structlog.get_logger()

UNPROTECTED_PATHS = {"/health", "/api/v1/llm/health", "/api/auth/login", "/api/auth/refresh", "/docs", "/openapi.json"}

# Local-dev stub user injected when DEV_MODE=true.
# Role is intentionally "sales_rep" (not "admin") — the bypass is for auth
# plumbing only, not for privilege escalation. Flip to "admin" locally if you
# need to test admin endpoints, but never leave it elevated in a shared env.
_DEV_USER = {
    "id": "00000000-0000-0000-0000-000000000000",
    "email": "dev@local",
    "name": "Dev User",
    "role": "sales_rep",
}


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path in UNPROTECTED_PATHS or request.method == "OPTIONS":
            return await call_next(request)

        if settings.dev_mode:
            log.warning(
                "auth.dev_mode_bypass",
                path=request.url.path,
                method=request.method,
                stub_user=_DEV_USER["email"],
            )
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
