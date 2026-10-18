"""align the legacy session token index with the ORM model

Revision ID: 003_session_token_index
Revises: 002_run_events
"""

import sqlalchemy as sa
from alembic import op

revision = "003_session_token_index"
down_revision = "002_run_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    names = {index["name"] for index in inspector.get_indexes("session_tokens")}
    if "ix_session_tokens_token_hash" not in names:
        op.create_index(
            "ix_session_tokens_token_hash",
            "session_tokens",
            ["token_hash"],
            unique=True,
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    names = {index["name"] for index in inspector.get_indexes("session_tokens")}
    if "ix_session_tokens_token_hash" in names:
        op.drop_index("ix_session_tokens_token_hash", table_name="session_tokens")
