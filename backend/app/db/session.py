from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.core.config import settings


class Base(DeclarativeBase):
	pass


DATABASE_URL = settings.DATABASE_URL
engine: AsyncEngine = create_async_engine(
	DATABASE_URL,
	future=True,
	echo=False,
	connect_args={
		'statement_cache_size': 0,
		'prepared_statement_cache_size': 0,
	},
)
AsyncSessionLocal = sessionmaker(bind=engine, expire_on_commit=False, class_=AsyncSession)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
	async with AsyncSessionLocal() as session:
		yield session


async def init_models() -> None:
	from app.models import chat  # noqa: F401

	async with engine.begin() as conn:
		await conn.run_sync(Base.metadata.create_all)
