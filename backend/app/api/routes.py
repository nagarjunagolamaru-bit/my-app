from urllib.parse import quote, urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.session import get_db
from app.models import User
from app.schemas.auth import LoginRequest, LoginResponse, UserRead
from app.schemas.auth import GoogleAuthRequest
from app.schemas.chat import (
    ChatHistoryResponse,
    ChatMessageRead,
    ChatRequest,
    ChatResponse,
    ChatThreadCreateRequest,
    ChatThreadRead,
    ChatThreadsResponse,
    ChatThreadUpdateRequest,
)
from app.services.auth_service import (
    authenticate_google_employee,
    authenticate_employee,
    create_access_token,
    get_current_user,
    register_employee,
)
from app.services.chat_service import (
    chat_with_thread,
    create_thread,
    delete_thread,
    get_chat_history,
    get_thread_messages,
    list_threads,
    update_thread_title,
)

router = APIRouter()


def build_frontend_redirect(error: str | None = None, token: str | None = None) -> str:
    base = settings.effective_frontend_origin
    if token:
        return f'{base}/?auth_token={quote(token)}'
    if error:
        return f'{base}/?auth_error={quote(error)}'
    return base


def is_api_key_error(message: str) -> bool:
    lowered = message.lower()
    return any(
        token in lowered
        for token in [
            'invalid api key',
            'incorrect api key',
            'invalid_request_error',
            '401',
            'authentication',
        ]
    )


@router.post('/chat', response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatResponse:
    try:
        answer = await chat_with_thread(db, current_user, request.message, request.thread_id)
        return ChatResponse(reply=answer)
    except Exception as exc:
        detail = str(exc)
        if is_api_key_error(detail):
            return ChatResponse(
                reply=(
                    'Demo assistant response: the configured LLM API key is missing or invalid. '
                    'Please update backend/.env with a valid LLM API key to get real responses.'
                )
            )
        raise HTTPException(status_code=502, detail=detail) from exc


@router.post('/auth/login', response_model=LoginResponse)
async def login(request: LoginRequest, db: AsyncSession = Depends(get_db)) -> LoginResponse:
    user = await authenticate_employee(db, request.email, request.password)
    token = create_access_token(user.id, user.email)
    return LoginResponse(access_token=token, user=UserRead.model_validate(user))


@router.post('/auth/signup', response_model=LoginResponse)
async def signup(request: LoginRequest, db: AsyncSession = Depends(get_db)) -> LoginResponse:
    user = await register_employee(db, request.email, request.password)
    token = create_access_token(user.id, user.email)
    return LoginResponse(access_token=token, user=UserRead.model_validate(user))


@router.post('/auth/google', response_model=LoginResponse)
async def google_auth(request: GoogleAuthRequest, db: AsyncSession = Depends(get_db)) -> LoginResponse:
    user = await authenticate_google_employee(db, request.id_token)
    token = create_access_token(user.id, user.email)
    return LoginResponse(access_token=token, user=UserRead.model_validate(user))


@router.get('/auth/google/start')
async def google_auth_start() -> RedirectResponse:
    client_id = settings.effective_google_oauth_client_id
    if not client_id:
        raise HTTPException(status_code=503, detail='Google login is not configured on the server.')

    redirect_uri = settings.effective_google_oauth_redirect_uri
    params = {
        'client_id': client_id,
        'redirect_uri': redirect_uri,
        'response_type': 'code',
        'scope': 'openid email profile',
        'access_type': 'offline',
        'prompt': 'select_account',
    }
    url = f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}"
    return RedirectResponse(url=url)


@router.get('/auth/google/callback', name='google_auth_callback')
async def google_auth_callback(
    code: str | None = None,
    error: str | None = None,
    db: AsyncSession = Depends(get_db),
) -> RedirectResponse:
    if error:
        return RedirectResponse(url=build_frontend_redirect(error=error))

    if not code:
        return RedirectResponse(url=build_frontend_redirect(error='Missing authorization code.'))

    client_id = settings.effective_google_oauth_client_id
    client_secret = settings.GOOGLE_OAUTH_CLIENT_SECRET
    if not client_id or not client_secret:
        return RedirectResponse(url=build_frontend_redirect(error='Google login is not configured on the server.'))

    redirect_uri = settings.effective_google_oauth_redirect_uri

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            token_response = await client.post(
                'https://oauth2.googleapis.com/token',
                data={
                    'code': code,
                    'client_id': client_id,
                    'client_secret': client_secret,
                    'redirect_uri': redirect_uri,
                    'grant_type': 'authorization_code',
                },
            )
        payload = token_response.json()
    except Exception:
        return RedirectResponse(url=build_frontend_redirect(error='Failed to reach Google token endpoint.'))

    if token_response.status_code != 200:
        detail = str(payload.get('error_description') or payload.get('error') or 'Token exchange failed.')
        return RedirectResponse(url=build_frontend_redirect(error=detail))

    id_token = payload.get('id_token')
    if not id_token:
        return RedirectResponse(url=build_frontend_redirect(error='Google token response missing id_token.'))

    try:
        user = await authenticate_google_employee(db, id_token)
    except HTTPException as exc:
        return RedirectResponse(url=build_frontend_redirect(error=str(exc.detail)))

    token = create_access_token(user.id, user.email)
    return RedirectResponse(url=build_frontend_redirect(token=token))


@router.get('/auth/google/config')
async def google_auth_config() -> dict[str, str | bool | None]:
    client_id = settings.effective_google_oauth_client_id
    expected_origin = settings.effective_frontend_origin
    redirect_uri = settings.effective_google_oauth_redirect_uri
    return {
        'enabled': bool(client_id),
        'client_id': client_id,
        'expected_origin': expected_origin,
        'redirect_uri': redirect_uri,
    }


@router.get('/auth/me', response_model=UserRead)
async def me(current_user: User = Depends(get_current_user)) -> UserRead:
    return UserRead.model_validate(current_user)


@router.get('/chats', response_model=ChatHistoryResponse)
async def list_chats(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatHistoryResponse:
    messages = await get_chat_history(db, current_user)
    payload = [ChatMessageRead.model_validate(message) for message in messages]
    return ChatHistoryResponse(messages=payload)


@router.get('/threads', response_model=ChatThreadsResponse)
async def get_threads(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatThreadsResponse:
    threads = await list_threads(db, current_user)
    payload = [ChatThreadRead.model_validate(thread) for thread in threads]
    return ChatThreadsResponse(threads=payload)


@router.post('/threads', response_model=ChatThreadRead)
async def create_chat_thread(
    request: ChatThreadCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatThreadRead:
    thread = await create_thread(db, current_user, request.title)
    return ChatThreadRead.model_validate(thread)


@router.patch('/threads/{thread_id}', response_model=ChatThreadRead)
async def rename_chat_thread(
    thread_id: int,
    request: ChatThreadUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatThreadRead:
    thread = await update_thread_title(db, current_user, thread_id, request.title)
    if thread is None:
        raise HTTPException(status_code=404, detail='Thread not found.')
    return ChatThreadRead.model_validate(thread)


@router.delete('/threads/{thread_id}')
async def remove_chat_thread(
    thread_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, bool]:
    removed = await delete_thread(db, current_user, thread_id)
    if not removed:
        raise HTTPException(status_code=404, detail='Thread not found.')
    return {'ok': True}


@router.get('/threads/{thread_id}/messages', response_model=ChatHistoryResponse)
async def get_messages_for_thread(
    thread_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatHistoryResponse:
    messages = await get_thread_messages(db, current_user, thread_id)
    payload = [ChatMessageRead.model_validate(message) for message in messages]
    return ChatHistoryResponse(messages=payload)
