from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from db.supabase_client import verify_token

UNPROTECTED_PATHS = {"/health", "/api/auth/login", "/api/auth/refresh", "/docs", "/openapi.json"}


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path in UNPROTECTED_PATHS or request.method == "OPTIONS":
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
