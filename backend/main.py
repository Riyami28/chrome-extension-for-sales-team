from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import structlog

from api.routes import generate, assets, admin, auth, llm, stt, zoho
from api.middleware.auth import AuthMiddleware
from db.supabase_client import init_supabase
from rag.vector_store import init_vector_store
from config import settings

log = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("startup", service="clientlens-backend")
    if settings.dev_mode:
        log.critical(
            "DEV_MODE is ENABLED — JWT verification is bypassed. "
            "All requests are authenticated as a stub sales_rep user. "
            "Never run this in production."
        )
    await init_supabase()
    await init_vector_store()
    yield
    log.info("shutdown")


app = FastAPI(
    title="ClientLens – Sales Copilot API",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS: in production only the listed origins get credentialed access.
# In dev_mode the regex also admits any chrome-extension:// caller and any
# localhost port — extension IDs differ per unpacked load, making an explicit
# list impractical until the build is uploaded to the Chrome Web Store.
# `allow_credentials` is limited to dev_mode: the regex includes
# http://localhost:\d+ which would allow any local HTTP server to make
# credentialed requests if we set it unconditionally.
_cors_kwargs: dict = dict(
    allow_origins=settings.allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
if settings.dev_mode:
    _cors_kwargs["allow_origin_regex"] = r"^(chrome-extension://[a-z]{32}|http://localhost:\d+)$"
    _cors_kwargs["allow_credentials"] = True
else:
    _cors_kwargs["allow_credentials"] = False

app.add_middleware(CORSMiddleware, **_cors_kwargs)

app.add_middleware(AuthMiddleware)

app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(generate.router, prefix="/api", tags=["generate"])
app.include_router(assets.router, prefix="/api/assets", tags=["assets"])
app.include_router(admin.router, prefix="/admin", tags=["admin"])
# LLM proxy — replaces direct provider calls from the extension. Closes part of #1.
app.include_router(llm.router, prefix="/api", tags=["llm"])
# STT token proxy — mints short-lived Deepgram keys so the API key stays server-side.
app.include_router(stt.router, prefix="/api", tags=["stt"])
# Zoho CRM OAuth refresh proxy — keeps client_secret server-side. Closes #33.
app.include_router(zoho.router, prefix="/api", tags=["zoho"])


@app.get("/health")
async def health():
    return {"status": "ok", "service": "clientlens-backend"}
