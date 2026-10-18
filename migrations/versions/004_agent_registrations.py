"""add project-owned remote agent registrations

Revision ID: 004_agent_registrations
Revises: 003_session_token_index
"""

import sqlalchemy as sa
from alembic import op

revision = "004_agent_registrations"
down_revision = "003_session_token_index"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "agent_registrations" not in tables:
        op.create_table(
            "agent_registrations",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("project_id", sa.String(length=36), nullable=False),
            sa.Column("name", sa.String(length=128), nullable=False),
            sa.Column("version", sa.String(length=64), nullable=False),
            sa.Column("source_path", sa.String(length=500), nullable=False),
            sa.Column("source_sha256", sa.String(length=64), nullable=False),
            sa.Column("source_size", sa.Integer(), nullable=False),
            sa.Column("contract_version", sa.Integer(), nullable=False),
            sa.Column("enabled", sa.Boolean(), server_default="1", nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "project_id",
                "name",
                "version",
                name="uq_agent_registrations_project_name_version",
            ),
        )
        op.create_index("ix_agent_registrations_project_id", "agent_registrations", ["project_id"])
        op.create_index(
            "ix_agent_registrations_project_created",
            "agent_registrations",
            ["project_id", "created_at"],
        )

    columns = {column["name"] for column in inspector.get_columns("runs")}
    if "agent_registration_id" not in columns:
        with op.batch_alter_table("runs", recreate="always") as batch:
            batch.add_column(sa.Column("agent_registration_id", sa.String(length=36), nullable=True))
            batch.create_foreign_key(
                "fk_runs_agent_registration_id",
                "agent_registrations",
                ["agent_registration_id"],
                ["id"],
                ondelete="SET NULL",
            )
        op.create_index("ix_runs_agent_registration_id", "runs", ["agent_registration_id"])

    with op.batch_alter_table("runs", recreate="always") as batch:
        batch.alter_column(
            "agent",
            existing_type=sa.String(length=40),
            type_=sa.String(length=128),
            existing_nullable=False,
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("runs")}
    if "agent_registration_id" in columns:
        if "ix_runs_agent_registration_id" in {index["name"] for index in inspector.get_indexes("runs")}:
            op.drop_index("ix_runs_agent_registration_id", table_name="runs")
        with op.batch_alter_table("runs", recreate="always") as batch:
            batch.drop_constraint("fk_runs_agent_registration_id", type_="foreignkey")
            batch.drop_column("agent_registration_id")
    with op.batch_alter_table("runs", recreate="always") as batch:
        batch.alter_column(
            "agent",
            existing_type=sa.String(length=128),
            type_=sa.String(length=40),
            existing_nullable=False,
        )

    if "agent_registrations" in set(inspector.get_table_names()):
        op.drop_index("ix_agent_registrations_project_created", table_name="agent_registrations")
        op.drop_index("ix_agent_registrations_project_id", table_name="agent_registrations")
        op.drop_table("agent_registrations")
