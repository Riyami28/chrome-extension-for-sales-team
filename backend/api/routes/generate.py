import json
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from agents.orchestrator import AgentOrchestrator
from models import GenerationRequest
from rbac.roles import require_permission

router = APIRouter()
orchestrator = AgentOrchestrator()


@router.post("/generate")
async def generate(request: Request, body: GenerationRequest):
    user = request.state.user
    require_permission(user["role"], "generate:create")

    async def stream():
        async for event in orchestrator.run(body):
            yield json.dumps(event) + "\n"

    return StreamingResponse(
        stream(),
        media_type="application/x-ndjson",
        headers={"X-Content-Type-Options": "nosniff"},
    )
