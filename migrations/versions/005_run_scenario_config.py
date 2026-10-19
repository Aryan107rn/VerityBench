"""persist validated scenario configuration for reproducible reruns

Revision ID: 005_run_scenario_config
Revises: 004_agent_registrations
"""

import sqlalchemy as sa
from alembic import op

revision = "005_run_scenario_config"
down_revision = "004_agent_registrations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("runs")}
    if "scenario_config_json" not in columns:
        op.add_column("runs", sa.Column("scenario_config_json", sa.Text(), nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("runs")}
    if "scenario_config_json" in columns:
        op.drop_column("runs", "scenario_config_json")
