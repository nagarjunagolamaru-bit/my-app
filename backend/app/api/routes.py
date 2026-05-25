import logging
import json
from urllib.parse import quote, urlencode
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

from app.core.config import settings
from app.db.session import get_db
from app.models import User, ChatThread
from app.schemas.auth import LoginRequest, LoginResponse, UserRead
from app.schemas.auth import GoogleAuthRequest
from app.schemas.chat import (
    CodeSnippetAttachmentCreateRequest,
    ChatAttachmentRead,
    ChatHistoryResponse,
    ChatMessageRead,
    ChatRequest,
    ChatResponse,
    ChatThreadCreateRequest,
    ChatThreadRead,
    ChatThreadsResponse,
    ChatThreadUpdateRequest,
    FormulaAttachmentCreateRequest,
    PDFUploadResponse,
    PDFDocumentRead,
    SpreadsheetConnectRequest,
    SpreadsheetDatasetResponse,
    SpreadsheetQueryRequest,
    SpreadsheetQueryResponse,
    ResearchDigestFinalResponse,
    ResearchDigestRequest,
    ThreadDocumentsResponse,
    RAGChatRequest,
)
from app.schemas.game import GameMoveRequest, GameStartRequest, TicTacToeStateResponse
from app.schemas.support import (
    SupportNotificationEvent,
    SupportStatusCallbackRequest,
    SupportTicketCreateRequest,
    SupportTicketListResponse,
    SupportTicketResponse,
    SupportWorkflowHealthResponse,
)
from app.services.auth_service import (
    authenticate_google_employee,
    authenticate_employee,
    create_access_token,
    get_current_user,
    register_employee,
)
from app.services.chat_service import (
    ImageGenerationQuotaExceededError,
    ImageGenerationRateLimitError,
    chat_with_thread,
    chat_with_thread_database,
    chat_with_thread_spreadsheet,
    clear_thread_memory,
    create_code_snippet_attachment,
    create_formula_attachment,
    create_thread,
    create_uploaded_attachment,
    delete_thread,
    get_attachment_by_id,
    get_attachment_file_path,
    get_attachments_for_messages,
    get_gemini_image_healthcheck,
    get_chat_history,
    get_thread_messages,
    list_threads,
    save_chat_pair,
    update_thread_title,
)
from app.services.research_digest_service import (
    ResearchDigestError,
    stream_research_digest,
)
from app.services.spreadsheet_service import (
    SpreadsheetAgentError,
    connect_google_sheet,
    dataset_preview,
    load_dataset_from_attachment,
    ask_spreadsheet_question,
)
from app.services.tictactoe_service import TicTacToeError, tictactoe_manager
from app.services.n8n_support_service import (
    SupportAutomationError,
    create_support_ticket_via_n8n,
    get_support_workflow_health,
    list_support_tickets,
    notification_broker,
    process_status_callback,
)

router = APIRouter()


@router.post('/game/start', response_model=TicTacToeStateResponse)
async def start_tic_tac_toe_game(
    request: GameStartRequest,
    current_user: User = Depends(get_current_user),
) -> TicTacToeStateResponse:
    try:
        return await tictactoe_manager.start_game(
            current_user.id,
            human_starts=request.human_starts,
            difficulty=request.difficulty,
        )
    except TicTacToeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get('/game/state', response_model=TicTacToeStateResponse)
async def get_tic_tac_toe_state(
    current_user: User = Depends(get_current_user),
) -> TicTacToeStateResponse:
    try:
        return await tictactoe_manager.get_state(current_user.id)
    except TicTacToeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post('/game/move', response_model=TicTacToeStateResponse)
async def make_tic_tac_toe_move(
    request: GameMoveRequest,
    current_user: User = Depends(get_current_user),
) -> TicTacToeStateResponse:
    try:
        return await tictactoe_manager.make_human_move(current_user.id, request.cell_index)
    except TicTacToeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post('/game/reset', response_model=TicTacToeStateResponse)
async def reset_tic_tac_toe_game(
    request: GameStartRequest,
    current_user: User = Depends(get_current_user),
) -> TicTacToeStateResponse:
    try:
        return await tictactoe_manager.reset_game(
            current_user.id,
            human_starts=request.human_starts,
            difficulty=request.difficulty,
        )
    except TicTacToeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post('/research-digest/stream')
async def research_digest_stream(
    request: ResearchDigestRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> StreamingResponse:
    if not request.topic.strip():
        raise HTTPException(status_code=400, detail='Research topic is required.')

    async def event_stream():
        final_digest = ''
        final_topic = request.topic.strip()

        try:
            async for payload in stream_research_digest(final_topic, request.max_iterations):
                if payload.get('type') == 'final':
                    final_digest = str(payload.get('digest') or '')
                    final_topic = str(payload.get('topic') or final_topic)

                event_type = 'progress' if payload.get('type') == 'progress' else 'final'
                yield f'event: {event_type}\n'
                yield f'data: {json.dumps(payload)}\n\n'

            if final_digest:
                await save_chat_pair(
                    db,
                    current_user.id,
                    f'Research topic: {final_topic}',
                    final_digest,
                    thread_id=request.thread_id,
                )
        except ResearchDigestError as exc:
            payload = {'type': 'error', 'message': str(exc)}
            yield 'event: error\n'
            yield f'data: {json.dumps(payload)}\n\n'
        except Exception as exc:
            payload = {'type': 'error', 'message': f'Research digest failed: {exc}'}
            yield 'event: error\n'
            yield f'data: {json.dumps(payload)}\n\n'

    return StreamingResponse(event_stream(), media_type='text/event-stream')


@router.post('/research-digest', response_model=ResearchDigestFinalResponse)
async def research_digest(
    request: ResearchDigestRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ResearchDigestFinalResponse:
    final_payload: dict[str, object] | None = None
    async for payload in stream_research_digest(request.topic, request.max_iterations):
        if payload.get('type') == 'final':
            final_payload = payload

    if final_payload is None:
        raise HTTPException(status_code=500, detail='Research digest did not produce a final result.')

    digest = str(final_payload.get('digest') or '')
    topic = str(final_payload.get('topic') or request.topic)
    papers = list(final_payload.get('papers') or [])

    await save_chat_pair(
        db,
        current_user.id,
        f'Research topic: {topic}',
        digest,
        thread_id=request.thread_id,
    )

    return ResearchDigestFinalResponse(topic=topic, digest=digest, papers=papers)


@router.post('/support/tickets', response_model=SupportTicketResponse)
async def create_support_ticket(
    request: SupportTicketCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SupportTicketResponse:
    try:
        ticket, message = await create_support_ticket_via_n8n(
            db,
            current_user,
            request.issue_summary,
            request.issue_description,
            request.thread_id,
        )
        return serialize_support_ticket(ticket, message=message)
    except SupportAutomationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get('/support/tickets', response_model=SupportTicketListResponse)
async def get_support_tickets(
    thread_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SupportTicketListResponse:
    tickets = await list_support_tickets(db, current_user.id, thread_id)
    payload = [serialize_support_ticket(ticket) for ticket in tickets]
    return SupportTicketListResponse(tickets=payload)


@router.get('/support/workflow-health', response_model=SupportWorkflowHealthResponse)
async def get_support_workflow_status(
    current_user: User = Depends(get_current_user),
) -> SupportWorkflowHealthResponse:
    del current_user
    health = await get_support_workflow_health()
    return SupportWorkflowHealthResponse(**health)


@router.post('/support/tickets/status-callback')
async def support_ticket_status_callback(
    request: SupportStatusCallbackRequest,
    x_callback_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    expected = settings.N8N_SUPPORT_CALLBACK_TOKEN.strip()
    if expected and x_callback_token != expected:
        raise HTTPException(status_code=401, detail='Invalid callback token.')

    try:
        await process_status_callback(
            db,
            request.ticket_id,
            request.status,
            request.message,
            request.category,
            request.priority,
        )
        return {'ok': True}
    except SupportAutomationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get('/support/notifications/stream')
async def support_notification_stream(
    current_user: User = Depends(get_current_user),
) -> StreamingResponse:
    async def event_stream():
        # Initial heartbeat confirms that the stream is connected.
        connected = SupportNotificationEvent(
            event_type='connected',
            ticket_id='-',
            status='connected',
            message='Support notification stream connected.',
            timestamp=datetime.utcnow(),
        )
        yield 'event: connected\n'
        yield f'data: {connected.model_dump_json()}\n\n'

        async for event in notification_broker.subscribe(current_user.id):
            payload = event.model_dump_json()
            yield 'event: support_notification\n'
            yield f'data: {payload}\n\n'

    return StreamingResponse(event_stream(), media_type='text/event-stream')


def serialize_message(
    message,
    attachments_map: dict[int, list],
) -> ChatMessageRead:
    attachment_payload = [
        ChatAttachmentRead.model_validate(attachment) for attachment in attachments_map.get(message.id, [])
    ]
    return ChatMessageRead(
        id=message.id,
        role=message.role,
        content=message.content,
        created_at=message.created_at,
        attachments=attachment_payload,
    )


def serialize_support_ticket(ticket, message: str | None = None) -> SupportTicketResponse:
    return SupportTicketResponse(
        ticket_id=ticket.ticket_id,
        user_name=ticket.user_name,
        user_email=ticket.user_email,
        issue_summary=ticket.issue_summary,
        issue_description=ticket.issue_description,
        category=ticket.category,
        priority=ticket.priority,
        status=ticket.status,
        created_at=ticket.created_at,
        updated_at=ticket.updated_at,
        message=message or 'Your ticket has been created successfully.',
    )


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


def is_budget_exceeded_error(message: str) -> bool:
    lowered = message.lower()
    return 'budget has been exceeded' in lowered or 'max budget' in lowered or 'budgetexceeded' in lowered


@router.post('/chat', response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatResponse:
    try:
        if request.mode in {'database', 'db'}:
            if not request.database_url:
                raise HTTPException(
                    status_code=400,
                    detail='Database mode requires database_url in the request body.',
                )

            answer_text, answer_attachments = await chat_with_thread_database(
                db,
                current_user,
                request.message,
                request.thread_id,
                request.database_url,
            )
            return ChatResponse(
                reply=answer_text,
                attachments=[ChatAttachmentRead.model_validate(attachment) for attachment in answer_attachments],
            )

        if request.mode in {'spreadsheet', 'sheet'}:
            answer_text, answer_attachments = await chat_with_thread_spreadsheet(
                db,
                current_user,
                request.message,
                request.thread_id,
                request.attachment_ids,
                request.google_sheet_url,
                request.sheet_name,
            )
            return ChatResponse(
                reply=answer_text,
                attachments=[ChatAttachmentRead.model_validate(attachment) for attachment in answer_attachments],
            )

        # Check if thread has documents and inject RAG context
        enhanced_message = request.message
        
        if request.thread_id:
            from app.models import PDFDocument
            from app.ai.rag import get_rag_service
            
            # Check if thread has any documents
            stmt = select(PDFDocument).where(
                (PDFDocument.thread_id == request.thread_id) &
                (PDFDocument.user_id == current_user.id) &
                (PDFDocument.status == 'ready')
            )
            result = await db.execute(stmt)
            documents = result.scalars().all()
            
            # If documents exist, inject RAG context
            if documents:
                rag_service = get_rag_service()
                rag_context = await rag_service.build_rag_context(request.message, request.thread_id)
                if rag_context:
                    enhanced_message = f"{rag_context}\n\nUser Question: {request.message}"
                    logger.info(
                        f"RAG context injected for thread {request.thread_id}: "
                        f"{len(rag_context)} chars from {len(documents)} document(s)"
                    )
                else:
                    logger.warning(
                        f"No RAG context returned for thread {request.thread_id} "
                        f"despite {len(documents)} document(s) present"
                    )
            else:
                logger.debug(f"No ready documents for thread {request.thread_id}")
        
        answer_text, answer_attachments = await chat_with_thread(
            db,
            current_user,
            enhanced_message,
            request.thread_id,
            request.attachment_ids,
            force_image_generation=request.mode == 'image',
        )
        return ChatResponse(
            reply=answer_text,
            attachments=[ChatAttachmentRead.model_validate(attachment) for attachment in answer_attachments],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ImageGenerationQuotaExceededError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except ImageGenerationRateLimitError as exc:
        raise HTTPException(
            status_code=429,
            detail=str(exc),
            headers={'Retry-After': '10'},
        ) from exc
    except Exception as exc:
        detail = str(exc)
        if is_budget_exceeded_error(detail):
            raise HTTPException(
                status_code=402,
                detail=(
                    'The LiteLLM proxy budget has been exceeded. '
                    'Please contact your administrator to increase the budget limit in the LiteLLM proxy settings.'
                ),
            ) from exc
        if is_api_key_error(detail):
            return ChatResponse(
                reply=(
                    'Demo assistant response: the configured LLM API key is missing or invalid. '
                    'Please update backend/.env with a valid LLM API key to get real responses.'
                )
            )
        raise HTTPException(status_code=502, detail=detail) from exc


@router.post('/spreadsheets/upload', response_model=SpreadsheetDatasetResponse)
async def upload_spreadsheet(
    thread_id: int = Form(...),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SpreadsheetDatasetResponse:
    raw = await file.read()
    file_name = file.filename or ''
    lower_name = file_name.lower()
    if not (lower_name.endswith('.csv') or lower_name.endswith('.xlsx')):
        raise HTTPException(status_code=400, detail='Only CSV and XLSX files are accepted.')

    try:
        attachment = await create_uploaded_attachment(
            db,
            current_user,
            thread_id,
            file_name,
            file.content_type,
            raw,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        load_dataset_from_attachment(
            current_user.id,
            thread_id,
            file_name,
            raw,
        )
        preview = dataset_preview(current_user.id, thread_id)
    except SpreadsheetAgentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    _ = attachment
    return SpreadsheetDatasetResponse(**preview)


@router.post('/spreadsheets/google-sheet', response_model=SpreadsheetDatasetResponse)
async def connect_spreadsheet_google_sheet(
    request: SpreadsheetConnectRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SpreadsheetDatasetResponse:
    thread = await db.get(ChatThread, request.thread_id)
    if not thread or thread.user_id != current_user.id:
        raise HTTPException(status_code=404, detail='Thread not found.')

    try:
        connect_google_sheet(current_user.id, request.thread_id, request.google_sheet_url)
        preview = dataset_preview(current_user.id, request.thread_id)
    except SpreadsheetAgentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return SpreadsheetDatasetResponse(**preview)


@router.post('/spreadsheets/query', response_model=SpreadsheetQueryResponse)
async def query_spreadsheet(
    request: SpreadsheetQueryRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SpreadsheetQueryResponse:
    thread = await db.get(ChatThread, request.thread_id)
    if not thread or thread.user_id != current_user.id:
        raise HTTPException(status_code=404, detail='Thread not found.')

    try:
        answer = await ask_spreadsheet_question(
            current_user.id,
            request.thread_id,
            request.question,
            request.sheet_name,
        )
    except SpreadsheetAgentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return SpreadsheetQueryResponse(answer=answer)


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


@router.get('/health/gemini-image')
async def gemini_image_health(
    current_user: User = Depends(get_current_user),
) -> dict[str, bool | str]:
    _ = current_user
    health = await get_gemini_image_healthcheck()
    return health


@router.get('/chats', response_model=ChatHistoryResponse)
async def list_chats(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatHistoryResponse:
    messages = await get_chat_history(db, current_user)
    attachments_map = await get_attachments_for_messages(db, current_user.id, [message.id for message in messages])
    payload = [serialize_message(message, attachments_map) for message in messages]
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
    attachments_map = await get_attachments_for_messages(db, current_user.id, [message.id for message in messages])
    payload = [serialize_message(message, attachments_map) for message in messages]
    return ChatHistoryResponse(messages=payload)


@router.delete('/threads/{thread_id}/memory')
async def reset_thread_memory(
    thread_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, bool]:
    cleared = await clear_thread_memory(db, current_user, thread_id)
    if not cleared:
        raise HTTPException(status_code=404, detail='Thread not found.')
    return {'ok': True}


@router.post('/attachments/upload', response_model=ChatAttachmentRead)
async def upload_attachment(
    thread_id: int = Form(...),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatAttachmentRead:
    raw = await file.read()
    try:
        attachment = await create_uploaded_attachment(
            db,
            current_user,
            thread_id,
            file.filename or '',
            file.content_type,
            raw,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # For PDF files, also run RAG pipeline so context is retrievable via semantic search
    fname = (file.filename or '').lower()
    if fname.endswith('.pdf'):
        from app.models import PDFDocument
        from app.ai.rag import get_rag_service
        from datetime import datetime

        storage_key = f"pdf_{current_user.id}_{thread_id}_{(file.filename or '').replace(' ', '_')}"
        pdf_doc = PDFDocument(
            user_id=current_user.id,
            thread_id=thread_id,
            file_name=file.filename or '',
            file_size_bytes=len(raw),
            content_type=file.content_type or 'application/pdf',
            storage_key=storage_key,
            status='processing',
        )
        db.add(pdf_doc)
        await db.flush()

        try:
            rag_service = get_rag_service()
            result = await rag_service.process_and_store_pdf(raw, file.filename or '', thread_id)
            pdf_doc.chunks_count = result.get('chunks_count', 0)
            pdf_doc.page_count = result.get('chunks_count', 0) // 10 or 1
            pdf_doc.status = 'ready' if result.get('success') else 'failed'
            pdf_doc.chromadb_collection_id = result.get('collection_name')
            logger.info(f"PDF RAG processed: {file.filename} -> {pdf_doc.chunks_count} chunks")
        except Exception as exc:
            logger.error(f"PDF RAG processing failed for {file.filename}: {exc}", exc_info=True)
            pdf_doc.status = 'failed'

        pdf_doc.processed_at = datetime.now()
        await db.commit()

    return ChatAttachmentRead.model_validate(attachment)


@router.post('/attachments/formula', response_model=ChatAttachmentRead)
async def upload_formula_attachment(
    request: FormulaAttachmentCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatAttachmentRead:
    try:
        attachment = await create_formula_attachment(db, current_user, request.thread_id, request.latex)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return ChatAttachmentRead.model_validate(attachment)


@router.post('/attachments/code', response_model=ChatAttachmentRead)
async def upload_code_attachment(
    request: CodeSnippetAttachmentCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatAttachmentRead:
    try:
        attachment = await create_code_snippet_attachment(
            db,
            current_user,
            request.thread_id,
            request.code,
            request.language,
            request.title,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return ChatAttachmentRead.model_validate(attachment)


@router.get('/attachments/{attachment_id}/content')
async def download_attachment_content(
    attachment_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> FileResponse:
    attachment = await get_attachment_by_id(db, current_user.id, attachment_id)
    if attachment is None:
        raise HTTPException(status_code=404, detail='Attachment not found.')

    path = get_attachment_file_path(attachment)
    if path is None or not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail='Attachment file not found.')

    return FileResponse(
        path=path,
        media_type=attachment.content_type or 'application/octet-stream',
        filename=attachment.file_name or path.name,
    )


# PDF and RAG endpoints
@router.post('/documents/upload-pdf')
async def upload_pdf(
    thread_id: int = Form(...),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> PDFUploadResponse:
    """Upload a PDF document for RAG-based chat."""
    from app.ai.rag import get_rag_service
    from app.models import PDFDocument
    from datetime import datetime

    if not file.filename or not file.filename.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail='Only PDF files are accepted.')

    try:
        # Read file
        raw = await file.read()
        if not raw:
            raise HTTPException(status_code=400, detail='Uploaded file is empty.')

        # Verify thread belongs to user
        thread = await db.get(ChatThread, thread_id)
        if not thread or thread.user_id != current_user.id:
            raise HTTPException(status_code=404, detail='Thread not found.')

        # Generate storage key
        storage_key = f"pdf_{current_user.id}_{thread_id}_{file.filename.replace(' ', '_')}"

        # Store PDF document record
        pdf_doc = PDFDocument(
            user_id=current_user.id,
            thread_id=thread_id,
            file_name=file.filename,
            file_size_bytes=len(raw),
            content_type=file.content_type or 'application/pdf',
            storage_key=storage_key,
            status='processing',
        )
        db.add(pdf_doc)
        await db.flush()  # Get the ID

        # Process PDF with RAG
        from app.ai.rag import get_rag_service
        rag_service = get_rag_service()
        result = await rag_service.process_and_store_pdf(
            raw,
            file.filename,
            thread_id,
        )

        # Update document record
        pdf_doc.page_count = result.get('chunks_count', 0) // 10 if result.get('chunks_count') else 0
        pdf_doc.chunks_count = result.get('chunks_count', 0)
        pdf_doc.status = 'ready' if result.get('success') else 'failed'
        pdf_doc.processed_at = datetime.now()
        pdf_doc.chromadb_collection_id = result.get('collection_name')

        await db.commit()
        await db.refresh(pdf_doc)

        return PDFUploadResponse.model_validate(pdf_doc)

    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"PDF upload error: {exc}")
        raise HTTPException(status_code=500, detail=f"PDF upload failed: {str(exc)}")


@router.get('/documents/{thread_id}')
async def get_thread_documents(
    thread_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ThreadDocumentsResponse:
    """Get all documents uploaded to a thread."""
    from app.models import PDFDocument

    # Verify thread belongs to user
    thread = await db.get(ChatThread, thread_id)
    if not thread or thread.user_id != current_user.id:
        raise HTTPException(status_code=404, detail='Thread not found.')

    # Get documents
    stmt = select(PDFDocument).where(
        (PDFDocument.thread_id == thread_id) &
        (PDFDocument.user_id == current_user.id)
    )
    result = await db.execute(stmt)
    documents = result.scalars().all()

    return ThreadDocumentsResponse(
        thread_id=thread_id,
        documents=[PDFDocumentRead.model_validate(doc) for doc in documents],
    )


@router.delete('/documents/{document_id}')
async def delete_document(
    document_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, bool]:
    """Delete a document and remove its embeddings from RAG."""
    from app.models import PDFDocument
    from app.ai.rag import get_rag_service

    try:
        # Get document
        doc = await db.get(PDFDocument, document_id)
        if not doc or doc.user_id != current_user.id:
            raise HTTPException(status_code=404, detail='Document not found.')

        # Delete from RAG
        rag_service = get_rag_service()
        await rag_service.delete_document(doc.file_name, doc.thread_id)

        # Delete from database
        await db.delete(doc)
        await db.commit()

        return {'ok': True}

    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"Document deletion error: {exc}")
        raise HTTPException(status_code=500, detail=f"Document deletion failed: {str(exc)}")


@router.delete('/documents/{thread_id}/all')
async def clear_thread_documents(
    thread_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, bool]:
    """Delete all documents from a thread."""
    from app.models import PDFDocument
    from app.ai.rag import get_rag_service

    try:
        # Verify thread belongs to user
        thread = await db.get(ChatThread, thread_id)
        if not thread or thread.user_id != current_user.id:
            raise HTTPException(status_code=404, detail='Thread not found.')

        # Delete from RAG
        rag_service = get_rag_service()
        await rag_service.clear_thread_documents(thread_id)

        # Delete from database
        stmt = delete(PDFDocument).where(
            (PDFDocument.thread_id == thread_id) &
            (PDFDocument.user_id == current_user.id)
        )
        await db.execute(stmt)
        await db.commit()

        return {'ok': True}

    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"Clear documents error: {exc}")
        raise HTTPException(status_code=500, detail=f"Failed to clear documents: {str(exc)}")


@router.post('/chat/rag', response_model=ChatResponse)
async def chat_with_rag(
    request: RAGChatRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatResponse:
    """Chat using RAG for PDF context injection."""
    from app.ai.rag import get_rag_service

    try:
        # Get or create thread
        if request.thread_id is None:
            thread = ChatThread(user_id=current_user.id, title='Chat')
            db.add(thread)
            await db.flush()
            thread_id = thread.id
        else:
            thread = await db.get(ChatThread, request.thread_id)
            if not thread or thread.user_id != current_user.id:
                raise HTTPException(status_code=404, detail='Thread not found.')
            thread_id = thread.id

        # Build RAG context if requested
        rag_context = ""
        if request.use_rag:
            rag_service = get_rag_service()
            rag_context = await rag_service.build_rag_context(request.message, thread_id)

        # Build enhanced message with RAG context
        enhanced_message = request.message
        if rag_context:
            enhanced_message = f"{rag_context}\n\nUser Question: {request.message}"

        # Call chat with enhanced message
        answer_text, answer_attachments = await chat_with_thread(
            db,
            current_user,
            enhanced_message,
            thread_id,
            request.attachment_ids,
            force_image_generation=False,
        )

        return ChatResponse(
            reply=answer_text,
            attachments=[ChatAttachmentRead.model_validate(attachment) for attachment in answer_attachments],
        )

    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error(f"RAG chat error: {exc}")
        raise HTTPException(status_code=502, detail=f"Chat failed: {str(exc)}")
