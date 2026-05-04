from pydantic import BaseModel
from typing import Optional, Any, Literal
from enum import Enum


class ICPRole(str, Enum):
    CFO = "cfo"
    CTO = "cto"
    COO = "coo"
    VP_SALES = "vp_sales"
    VP_ENGINEERING = "vp_engineering"
    CEO = "ceo"
    PROCUREMENT = "procurement"
    CUSTOM = "custom"


class ActionType(str, Enum):
    GENERATE_NEW = "generate_new"
    UPDATE_SECTION = "update_section"
    ADD_SLIDE = "add_slide"
    REFINE_CONTENT = "refine_content"
    MAKE_ICP_FRIENDLY = "make_icp_friendly"
    ADD_ROI_SLIDE = "add_roi_slide"
    SIMPLIFY = "simplify"
    MAKE_TECHNICAL = "make_technical"


class OutputType(str, Enum):
    GOOGLE_SLIDES = "google_slides"
    GOOGLE_DOC = "google_doc"
    PDF = "pdf"
    NOTION = "notion"


class CompanyContext(BaseModel):
    name: str
    domain: Optional[str] = None
    industry: Optional[str] = None
    size: Optional[str] = None
    detected_from: Optional[str] = None
    logo_url: Optional[str] = None
    primary_color: Optional[str] = None


class DocumentState(BaseModel):
    url: str
    doc_id: Optional[str] = None
    doc_type: Literal["slides", "docs", "notion", "unknown"] = "unknown"
    current_content: Optional[list] = None
    selected_text: Optional[str] = None


class GenerationRequest(BaseModel):
    company: CompanyContext
    icp_role: ICPRole
    use_case: str
    action_type: ActionType
    output_type: OutputType
    current_document: Optional[DocumentState] = None
    selected_section: Optional[str] = None
    user_instruction: Optional[str] = None
    live_mode: bool = False


class AgentResult(BaseModel):
    agent: str
    status: Literal["pass", "fail", "warning"]
    output: Any
    issues: Optional[list[str]] = None
    confidence: float = 1.0


class PipelineResult(BaseModel):
    request_id: str
    agents: list[AgentResult]
    final_output: dict
    metadata: dict
