"""
RBAC — Role definitions and permission checks.

Roles:
  admin       — full access
  designer    — can manage Design System assets
  pmm         — can manage Brand Voice & Tone
  sales_rep   — can generate and use content
  viewer      — read-only
"""

from enum import Enum
from fastapi import HTTPException, status


class Role(str, Enum):
    ADMIN = "admin"
    DESIGNER = "designer"
    PMM = "pmm"
    SALES_REP = "sales_rep"
    VIEWER = "viewer"


PERMISSIONS: dict[str, list[Role]] = {
    # Generation
    "generate:create": [Role.ADMIN, Role.SALES_REP, Role.PMM, Role.DESIGNER],
    "generate:read": [Role.ADMIN, Role.SALES_REP, Role.PMM, Role.DESIGNER, Role.VIEWER],

    # Design System
    "design_system:read": [Role.ADMIN, Role.DESIGNER, Role.PMM, Role.SALES_REP, Role.VIEWER],
    "design_system:write": [Role.ADMIN, Role.DESIGNER],
    "design_system:delete": [Role.ADMIN, Role.DESIGNER],

    # Brand Voice
    "brand_voice:read": [Role.ADMIN, Role.DESIGNER, Role.PMM, Role.SALES_REP, Role.VIEWER],
    "brand_voice:write": [Role.ADMIN, Role.PMM],
    "brand_voice:delete": [Role.ADMIN, Role.PMM],

    # ICP Profiles
    "icp:read": [Role.ADMIN, Role.SALES_REP, Role.PMM, Role.DESIGNER, Role.VIEWER],
    "icp:write": [Role.ADMIN, Role.PMM],

    # Assets (internal docs, case studies)
    "assets:upload": [Role.ADMIN, Role.DESIGNER, Role.PMM],
    "assets:read": [Role.ADMIN, Role.DESIGNER, Role.PMM, Role.SALES_REP],
    "assets:delete": [Role.ADMIN],

    # User management
    "users:read": [Role.ADMIN],
    "users:write": [Role.ADMIN],
    "users:assign_role": [Role.ADMIN],

    # Admin panel
    "admin:access": [Role.ADMIN, Role.DESIGNER, Role.PMM],
}


def require_permission(user_role: str, permission: str) -> None:
    """Raise 403 if user_role does not have the required permission."""
    allowed_roles = PERMISSIONS.get(permission, [])
    if Role(user_role) not in allowed_roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Role '{user_role}' does not have permission: {permission}",
        )


def has_permission(user_role: str, permission: str) -> bool:
    allowed_roles = PERMISSIONS.get(permission, [])
    try:
        return Role(user_role) in allowed_roles
    except ValueError:
        return False
