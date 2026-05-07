from langchain.messages import HumanMessage, SystemMessage
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.llm import llm
from app.core.config import settings
from app.models import ChatMessage, ChatThread, User

SYSTEM_PROMPT = (
    'You are a helpful assistant. Answer questions clearly and concisely.'
)
DEMO_RESPONSE = (
    'Demo assistant response: the configured LLM API key is missing or invalid. '
    'Please update backend/.env with a valid LLM API key to get real responses.'
)


def is_api_key_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(
        token in text
        for token in [
            'invalid_api_key',
            'incorrect api key',
            'api key',
            '401',
            'authentication',
            'permission denied',
            'not authorized',
        ]
    )


async def get_chat_response(user_message: str) -> str:
    if not settings.effective_llm_api_key:
        return DEMO_RESPONSE

    messages = [
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=user_message),
    ]

    try:
        response = await llm.agenerate([[messages[0], messages[1]]])
        first_generation = response.generations[0][0]
        return first_generation.text.strip()
    except Exception as exc:
        if is_api_key_error(exc):
            return DEMO_RESPONSE
        raise


async def save_chat_pair(
    db: AsyncSession,
    user_id: int,
    user_message: str,
    assistant_reply: str,
    thread_id: int | None = None,
) -> None:
    if thread_id is not None:
        thread_stmt = select(ChatThread).where(
            ChatThread.id == thread_id,
            ChatThread.user_id == user_id,
        )
    else:
        thread_stmt = (
            select(ChatThread)
            .where(ChatThread.user_id == user_id)
            .order_by(ChatThread.updated_at.desc(), ChatThread.id.desc())
            .limit(1)
        )

    thread_result = await db.execute(thread_stmt)
    thread = thread_result.scalar_one_or_none()

    if thread is None:
        thread = ChatThread(user_id=user_id, title='New Chat')
        db.add(thread)
        await db.flush()

    db.add(ChatMessage(user_id=user_id, thread_id=thread.id, role='user', content=user_message))
    db.add(
        ChatMessage(
            user_id=user_id,
            thread_id=thread.id,
            role='assistant',
            content=assistant_reply,
        )
    )
    await db.commit()


async def chat_with_persistence(db: AsyncSession, user: User, user_message: str) -> str:
    assistant_reply = await get_chat_response(user_message)
    await save_chat_pair(db, user.id, user_message, assistant_reply)
    return assistant_reply


async def chat_with_thread(
    db: AsyncSession,
    user: User,
    user_message: str,
    thread_id: int | None,
) -> str:
    assistant_reply = await get_chat_response(user_message)
    await save_chat_pair(db, user.id, user_message, assistant_reply, thread_id=thread_id)
    return assistant_reply


async def get_chat_history(db: AsyncSession, user: User) -> list[ChatMessage]:
    stmt = (
        select(ChatMessage)
        .where(ChatMessage.user_id == user.id)
        .order_by(ChatMessage.created_at.asc(), ChatMessage.id.asc())
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def list_threads(db: AsyncSession, user: User) -> list[ChatThread]:
    stmt = (
        select(ChatThread)
        .where(ChatThread.user_id == user.id)
        .order_by(ChatThread.updated_at.desc(), ChatThread.id.desc())
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def create_thread(db: AsyncSession, user: User, title: str) -> ChatThread:
    thread = ChatThread(user_id=user.id, title=title.strip() or 'New Chat')
    db.add(thread)
    await db.commit()
    await db.refresh(thread)
    return thread


async def update_thread_title(db: AsyncSession, user: User, thread_id: int, title: str) -> ChatThread | None:
    stmt = select(ChatThread).where(ChatThread.id == thread_id, ChatThread.user_id == user.id)
    result = await db.execute(stmt)
    thread = result.scalar_one_or_none()
    if thread is None:
        return None

    thread.title = title.strip() or thread.title
    await db.commit()
    await db.refresh(thread)
    return thread


async def delete_thread(db: AsyncSession, user: User, thread_id: int) -> bool:
    stmt = select(ChatThread).where(ChatThread.id == thread_id, ChatThread.user_id == user.id)
    result = await db.execute(stmt)
    thread = result.scalar_one_or_none()
    if thread is None:
        return False

    await db.delete(thread)
    await db.commit()
    return True


async def get_thread_messages(db: AsyncSession, user: User, thread_id: int) -> list[ChatMessage]:
    stmt = (
        select(ChatMessage)
        .where(ChatMessage.user_id == user.id, ChatMessage.thread_id == thread_id)
        .order_by(ChatMessage.created_at.asc(), ChatMessage.id.asc())
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())
