import uuid
from fastapi import APIRouter, Request, UploadFile, File, Form, HTTPException
from db.supabase_client import supabase_client
from rag.retriever import upsert_document, delete_document
from rbac.roles import require_permission
import structlog

router = APIRouter()
log = structlog.get_logger()

ASSET_NAMESPACE_MAP = {
    "design_system": "brand_guidelines",
    "brand_voice": "brand_guidelines",
    "case_study": "case_studies",
    "product_doc": "product_docs",
    "metrics": "metrics",
    "competitor_intel": "competitor_intel",
}

PERMISSION_MAP = {
    "design_system": "design_system:write",
    "brand_voice": "brand_voice:write",
    "case_study": "assets:upload",
    "product_doc": "assets:upload",
    "metrics": "assets:upload",
    "competitor_intel": "assets:upload",
}


@router.post("/upload")
async def upload_asset(
    request: Request,
    file: UploadFile = File(...),
    type: str = Form(...),
):
    user = request.state.user
    permission = PERMISSION_MAP.get(type, "assets:upload")
    require_permission(user["role"], permission)

    if type not in ASSET_NAMESPACE_MAP:
        raise HTTPException(400, f"Unknown asset type: {type}")

    content = await file.read()
    text_content = content.decode("utf-8", errors="ignore")

    # Store file in Supabase Storage
    file_id = str(uuid.uuid4())
    path = f"{type}/{file_id}/{file.filename}"

    supabase_client().storage.from_("assets").upload(path, content)

    # Chunk and index in vector store
    chunks = _chunk_text(text_content, chunk_size=1000, overlap=200)
    namespace = ASSET_NAMESPACE_MAP[type]

    for i, chunk in enumerate(chunks):
        await upsert_document(
            doc_id=f"{file_id}_chunk_{i}",
            text=chunk,
            namespace=namespace,
            metadata={
                "source": file.filename or "unknown",
                "asset_type": type,
                "file_id": file_id,
                "chunk_index": i,
                "uploaded_by": user["id"],
            },
        )

    # Record in DB
    supabase_client().table("assets").insert({
        "id": file_id,
        "name": file.filename,
        "type": type,
        "storage_path": path,
        "chunk_count": len(chunks),
        "uploaded_by": user["id"],
        "namespace": namespace,
    }).execute()

    log.info("asset.uploaded", type=type, file=file.filename, chunks=len(chunks))
    return {"id": file_id, "chunks_indexed": len(chunks), "status": "indexed"}


@router.get("/list")
async def list_assets(request: Request, type: str | None = None):
    user = request.state.user
    require_permission(user["role"], "assets:read")

    query = supabase_client().table("assets").select("*").order("created_at", desc=True)
    if type:
        query = query.eq("type", type)

    result = query.execute()
    return {"assets": result.data}


@router.delete("/{asset_id}")
async def delete_asset(request: Request, asset_id: str):
    user = request.state.user
    require_permission(user["role"], "assets:delete")

    asset = supabase_client().table("assets").select("*").eq("id", asset_id).single().execute()
    if not asset.data:
        raise HTTPException(404, "Asset not found")

    a = asset.data

    # Delete from vector store
    namespace = ASSET_NAMESPACE_MAP.get(a["type"], "product_docs")
    for i in range(a.get("chunk_count", 0)):
        await delete_document(f"{asset_id}_chunk_{i}", namespace)

    # Delete from storage
    supabase_client().storage.from_("assets").remove([a["storage_path"]])

    # Delete from DB
    supabase_client().table("assets").delete().eq("id", asset_id).execute()

    return {"deleted": asset_id}


def _chunk_text(text: str, chunk_size: int = 1000, overlap: int = 200) -> list[str]:
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        start += chunk_size - overlap
    return chunks
