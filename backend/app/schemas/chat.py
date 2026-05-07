from pydantic import BaseModel
from datetime import datetime


class ChatRequest(BaseModel):
    message: str
    thread_id: int | None = None


class ChatResponse(BaseModel):
    reply: str


class ChatMessageRead(BaseModel):
    id: int
    role: str
    content: str
    created_at: datetime

    class Config:
        from_attributes = True


class ChatHistoryResponse(BaseModel):
    messages: list[ChatMessageRead]


class ChatThreadCreateRequest(BaseModel):
    title: str


class ChatThreadUpdateRequest(BaseModel):
    title: str


class ChatThreadRead(BaseModel):
    id: int
    user_id: int
    title: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ChatThreadsResponse(BaseModel):
    threads: list[ChatThreadRead]
