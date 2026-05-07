import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router as api_router
from app.core.config import settings
from app.db.session import init_models

app = FastAPI(title=settings.APP_NAME, version=settings.APP_VERSION)
logger = logging.getLogger(__name__)

frontend_origin = settings.effective_frontend_origin
allowed_origins = list(
    {
        frontend_origin,
        'http://localhost:4173',
        'http://127.0.0.1:4173',
        'http://localhost:5173',
        'http://127.0.0.1:5173',
    }
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=r'^https?://(localhost|127\.0\.0\.1)(:\d+)?$',
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

app.include_router(api_router, prefix='/api')


@app.on_event('startup')
async def on_startup() -> None:
    try:
        await init_models()
    except Exception as exc:
        logger.warning('Database initialization skipped on startup: %s', exc)
