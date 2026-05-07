from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe

import bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.session import get_db
from app.models import User

ALGORITHM = 'HS256'
EMPLOYEE_DOMAIN = '@amzur.com'
security = HTTPBearer(auto_error=False)


def normalize_email(email: str) -> str:
    return email.strip().lower()


def is_employee_email(email: str) -> bool:
    return normalize_email(email).endswith(EMPLOYEE_DOMAIN)


def hash_password(password: str) -> str:
    hashed = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt())
    return hashed.decode('utf-8')


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode('utf-8'), password_hash.encode('utf-8'))


def create_access_token(user_id: int, email: str) -> str:
    expires_delta = timedelta(minutes=settings.JWT_EXPIRE_MINUTES)
    expire = datetime.now(UTC) + expires_delta
    payload = {
        'sub': str(user_id),
        'email': email,
        'exp': expire,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)


async def authenticate_employee(
    db: AsyncSession, email: str, password: str
) -> User:
    normalized_email = normalize_email(email)
    if not is_employee_email(normalized_email):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail='Only Amzur employee accounts are allowed.',
        )

    try:
        stmt = select(User).where(User.email == normalized_email)
        result = await db.execute(stmt)
        user = result.scalar_one_or_none()
    except (SQLAlchemyError, OSError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='Database is unavailable. Please try again shortly.',
        ) from exc

    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Invalid email or password.',
        )

    if not verify_password(password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Invalid email or password.',
        )

    return user


async def register_employee(db: AsyncSession, email: str, password: str) -> User:
    normalized_email = normalize_email(email)
    if not is_employee_email(normalized_email):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail='Only Amzur employee accounts are allowed.',
        )

    try:
        stmt = select(User).where(User.email == normalized_email)
        result = await db.execute(stmt)
        existing_user = result.scalar_one_or_none()
    except (SQLAlchemyError, OSError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='Database is unavailable. Please try again shortly.',
        ) from exc

    if existing_user is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail='Account already exists. Please sign in.',
        )

    try:
        user = User(email=normalized_email, password_hash=hash_password(password))
        db.add(user)
        await db.commit()
        await db.refresh(user)
    except (SQLAlchemyError, OSError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='Database is unavailable. Please try again shortly.',
        ) from exc

    return user


def verify_google_token(token: str) -> str:
    client_id = settings.effective_google_oauth_client_id
    if not client_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='Google login is not configured on the server.',
        )

    try:
        payload = google_id_token.verify_oauth2_token(
            token,
            google_requests.Request(),
            client_id,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Invalid Google token.',
        ) from exc

    email = normalize_email(str(payload.get('email', '')))
    email_verified = bool(payload.get('email_verified', False))

    if not email or not email_verified:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Google account email is missing or unverified.',
        )

    if not is_employee_email(email):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail='Only Amzur employee accounts are allowed.',
        )

    return email


async def authenticate_google_employee(db: AsyncSession, token: str) -> User:
    email = verify_google_token(token)

    try:
        stmt = select(User).where(User.email == email)
        result = await db.execute(stmt)
        existing_user = result.scalar_one_or_none()
    except (SQLAlchemyError, OSError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='Database is unavailable. Please try again shortly.',
        ) from exc

    if existing_user is not None:
        return existing_user

    try:
        # Store a random hash so Google-only users can still satisfy the non-null password column.
        user = User(email=email, password_hash=hash_password(token_urlsafe(32)))
        db.add(user)
        await db.commit()
        await db.refresh(user)
    except (SQLAlchemyError, OSError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='Database is unavailable. Please try again shortly.',
        ) from exc

    return user


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Not authenticated.',
        )

    token = credentials.credentials
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
        user_id = int(payload.get('sub', '0'))
    except (JWTError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Invalid token.',
        )

    try:
        stmt = select(User).where(User.id == user_id)
        result = await db.execute(stmt)
        user = result.scalar_one_or_none()
    except (SQLAlchemyError, OSError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='Database is unavailable. Please try again shortly.',
        ) from exc
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='User not found.',
        )

    return user
