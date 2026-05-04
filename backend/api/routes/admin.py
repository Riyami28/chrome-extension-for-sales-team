from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from db.supabase_client import supabase_client
from rbac.roles import require_permission, Role

router = APIRouter()


class BrandVoiceUpdate(BaseModel):
    tone_adjectives: list[str]
    avoid_words: list[str]
    messaging_framework: dict
    icp_tone_overrides: dict = {}


class UserRoleUpdate(BaseModel):
    user_id: str
    role: Role


@router.get("/brand-voice")
async def get_brand_voice(request: Request):
    user = request.state.user
    require_permission(user["role"], "brand_voice:read")
    result = supabase_client().table("brand_voice").select("*").order("created_at", desc=True).limit(1).execute()
    return result.data[0] if result.data else {}


@router.put("/brand-voice")
async def update_brand_voice(request: Request, body: BrandVoiceUpdate):
    user = request.state.user
    require_permission(user["role"], "brand_voice:write")

    result = supabase_client().table("brand_voice").insert({
        "tone_adjectives": body.tone_adjectives,
        "avoid_words": body.avoid_words,
        "messaging_framework": body.messaging_framework,
        "icp_tone_overrides": body.icp_tone_overrides,
        "updated_by": user["id"],
    }).execute()

    return result.data[0]


@router.get("/users")
async def list_users(request: Request):
    user = request.state.user
    require_permission(user["role"], "users:read")
    result = supabase_client().table("user_profiles").select("id, email, name, role, created_at").execute()
    return {"users": result.data}


@router.patch("/users/role")
async def update_user_role(request: Request, body: UserRoleUpdate):
    user = request.state.user
    require_permission(user["role"], "users:assign_role")

    result = (
        supabase_client()
        .table("user_profiles")
        .update({"role": body.role})
        .eq("id", body.user_id)
        .execute()
    )

    if not result.data:
        raise HTTPException(404, "User not found")

    return result.data[0]
