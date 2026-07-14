from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import config, db
from .routers import admin_users, auth, bookmarks, meetings, org, participants, projects, settings, usage

app = FastAPI(title="Notie", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(admin_users.router, prefix="/api/admin/users", tags=["admin-users"])
app.include_router(projects.router, prefix="/api/projects", tags=["projects"])
# Backward compatibility for older frontend bundles that still call the admin-prefixed URL.
app.include_router(projects.router, prefix="/api/admin/projects", tags=["projects-compat"])
app.include_router(participants.router, prefix="/api/participants", tags=["participants"])
app.include_router(meetings.router, prefix="/api/meetings", tags=["meetings"])
app.include_router(bookmarks.router, prefix="/api", tags=["bookmarks"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])
app.include_router(usage.router, prefix="/api/usage", tags=["usage"])
app.include_router(org.router, prefix="/api", tags=["org"])


@app.get("/api/health")
def health() -> dict:
    from .services import gemini_stt

    return {
        "ok": True,
        "stt_engine": gemini_stt.get_engine(),
    }


# 프론트엔드 프로덕션 빌드가 있으면 함께 서빙 (npm run build 후 단일 서버 운용 가능)
_dist = config.ROOT_DIR / "frontend" / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="frontend")
