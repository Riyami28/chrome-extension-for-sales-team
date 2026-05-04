from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from db.supabase_client import supabase_client

router = APIRouter()


class LoginRequest(BaseModel):
    email: str
    password: str


@router.post("/login")
async def login(body: LoginRequest):
    try:
        result = supabase_client().auth.sign_in_with_password({
            "email": body.email,
            "password": body.password,
        })
        if not result.session:
            raise HTTPException(401, "Invalid credentials")

        # Fetch profile with role
        profile = (
            supabase_client()
            .table("user_profiles")
            .select("id, email, name, role")
            .eq("id", result.user.id)
            .single()
            .execute()
        )

        return {
            "access_token": result.session.access_token,
            "refresh_token": result.session.refresh_token,
            "user": profile.data,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(401, str(e)) from e
