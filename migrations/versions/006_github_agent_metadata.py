"""store provenance for imported public GitHub agent sources

Revision ID: 006_github_agent_metadata
Revises: 005_run_scenario_config
"""

import sqlalchemy as sa
from alembic import op

revision = "006_github_agent_metadata"
down_revision = "005_run_scenario_config"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("agent_registrations")}
    if "source_kind" not in columns:
        op.add_column(
            "agent_registrations",
            sa.Column("source_kind", sa.String(length=20), nullable=False, server_default="inline"),
        )
    if "source_url" not in columns:
        op.add_column("agent_registrations", sa.Column("source_url", sa.String(length=500), nullable=True))
    if "source_ref" not in columns:
        op.add_column("agent_registrations", sa.Column("source_ref", sa.String(length=200), nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("agent_registrations")}
    for name in ("source_ref", "source_url", "source_kind"):
        if name in columns:
            op.drop_column("agent_registrations", name)
