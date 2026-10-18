"""Password and opaque bearer-session helpers."""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .models import SessionToken, User

PASSWORD_HASHER = PasswordHasher()


def hash_password(password: str) -> str:
    return PASSWORD_HASHER.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return PASSWORD_HASHER.verify(password_hash, password)
    except (InvalidHashError, VerificationError, VerifyMismatchError):
        return False


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def issue_session(db: Session, user: User, settings: Settings) -> tuple[str, SessionToken]:
    raw_token = secrets.token_urlsafe(32)
    session = SessionToken(
        id=str(uuid4()),
        user_id=user.id,
        token_hash=token_digest(raw_token),
        expires_at=datetime.now(UTC) + timedelta(hours=settings.veritybench_session_ttl_hours),
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return raw_token, session


def find_active_session(db: Session, raw_token: str) -> SessionToken | None:
    session = db.scalar(select(SessionToken).where(SessionToken.token_hash == token_digest(raw_token)))
    if session is None or session.revoked_at is not None:
        return None
    expires_at = session.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if expires_at <= datetime.now(UTC):
        return None
    return session


def revoke_session(db: Session, raw_token: str) -> bool:
    session = find_active_session(db, raw_token)
    if session is None:
        return False
    session.revoked_at = datetime.now(UTC)
    db.commit()
    return True
