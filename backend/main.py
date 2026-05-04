from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import structlog

from api.routes import generate, assets, admin, auth
from api.middleware.auth import AuthMiddleware
from db.supabase_client import init_supabase
from rag.vector_store import init_vector_store
from config import settings

log = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("startup", service="clientlens-backend")
    await init_supabase()
    await init_vector_store()
    yield
    log.info("shutdown")


app = FastAPI(
    title="ClientLens – Sales Copilot API",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(AuthMiddleware)

app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(generate.router, prefix="/api", tags=["generate"])
app.include_router(assets.router, prefix="/api/assets", tags=["assets"])
app.include_router(admin.router, prefix="/admin", tags=["admin"])


@app.get("/health")
async def health():
    return {"status": "ok", "service": "clientlens-backend"}
