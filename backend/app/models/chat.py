from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class User(Base):
	__tablename__ = 'users'

	id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
	email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
	password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
	created_at: Mapped[datetime] = mapped_column(
		DateTime(timezone=True), server_default=func.now(), nullable=False
	)

	messages: Mapped[list['ChatMessage']] = relationship(
		back_populates='user', cascade='all, delete-orphan'
	)
	threads: Mapped[list['ChatThread']] = relationship(
		back_populates='user', cascade='all, delete-orphan'
	)


class ChatThread(Base):
	__tablename__ = 'chat_threads'

	id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
	user_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
	title: Mapped[str] = mapped_column(String(255), nullable=False, default='New Chat')
	created_at: Mapped[datetime] = mapped_column(
		DateTime(timezone=True), server_default=func.now(), nullable=False
	)
	updated_at: Mapped[datetime] = mapped_column(
		DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
	)

	user: Mapped[User] = relationship(back_populates='threads')
	messages: Mapped[list['ChatMessage']] = relationship(
		back_populates='thread', cascade='all, delete-orphan'
	)


class ChatMessage(Base):
	__tablename__ = 'chat_messages'

	id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
	user_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
	thread_id: Mapped[int] = mapped_column(ForeignKey('chat_threads.id', ondelete='CASCADE'), nullable=False)
	role: Mapped[str] = mapped_column(String(20), nullable=False)
	content: Mapped[str] = mapped_column(Text, nullable=False)
	created_at: Mapped[datetime] = mapped_column(
		DateTime(timezone=True), server_default=func.now(), nullable=False
	)

	user: Mapped[User] = relationship(back_populates='messages')
	thread: Mapped[ChatThread] = relationship(back_populates='messages')
