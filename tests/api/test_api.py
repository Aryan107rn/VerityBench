from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from fastapi.testclient import TestClient

from veritybench.api import main as api_main
from veritybench.api.main import app
from veritybench.models import Run
from veritybench_engine import DeterministicEngine, ExecutionCancelled


def register(client: TestClient, email: str) -> tuple[str, str]:
    response = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "correct horse battery staple"},
    )
    assert response.status_code == 201, response.text
    payload = response.json()
    return payload["access_token"], payload["user"]["id"]


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_legacy_report_without_version_remains_readable() -> None:
    legacy_report = {"agent_name": "legacy-agent", "evaluation": {"passed": True}}
    run = Run(
        id="legacy-run",
        project_id="project",
        state="passed",
        agent="safe",
        scenario="normal",
        report_json=json.dumps(legacy_report),
    )

    assert api_main._load_run_report(run) == legacy_report


def wait_for_terminal(client: TestClient, run_id: str, headers: dict[str, str]) -> dict:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/runs/{run_id}", headers=headers)
        assert response.status_code == 200, response.text
        payload = response.json()
        if payload["state"] in {"passed", "failed", "cancelled", "timed_out", "inconclusive"}:
            return payload
        time.sleep(0.01)
    raise AssertionError(f"run {run_id} did not reach a terminal state")


def test_project_run_report_persists_and_uses_independent_engine() -> None:
    with TestClient(app) as client:
        token, _ = register(client, "owner@example.test")
        headers = auth(token)
        project_response = client.post(
            "/api/v1/projects", headers=headers, json={"name": "Orders", "description": "demo"}
        )
        assert project_response.status_code == 201
        project_id = project_response.json()["id"]

        run_response = client.post(
            f"/api/v1/projects/{project_id}/runs",
            headers=headers,
            json={"agent": "defective", "scenario": "timeout_after_success"},
        )
        assert run_response.status_code == 201, run_response.text
        queued_run = run_response.json()
        assert queued_run["state"] in {"queued", "running", "failed"}
        run = wait_for_terminal(client, queued_run["id"], headers)
        assert run["state"] == "failed"
        assert run["report"]["report_version"] == 1
        assert run["report"]["run_state"] == "failed"
        assert run["report"]["metrics"]["duplicate_charges"] == 1
        assert run["report"]["evaluation"]["passed"] is False

        summaries_response = client.get(f"/api/v1/projects/{project_id}/runs", headers=headers)
        assert summaries_response.status_code == 200
        summaries = summaries_response.json()
        assert len(summaries) == 1
        assert summaries[0]["id"] == run["id"]
        assert summaries[0]["state"] == "failed"
        assert summaries[0]["cancel_requested"] is False

        read_response = client.get(f"/api/v1/runs/{run['id']}", headers=headers)
        assert read_response.status_code == 200
        assert read_response.json()["report"]["trace"]


def test_authenticated_project_selection_and_safe_run_report_readback() -> None:
    with TestClient(app) as client:
        token, _ = register(client, "flow-owner@example.test")
        headers = auth(token)

        assert client.get("/api/v1/projects", headers=headers).json() == []

        create_project_response = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "Payments", "description": "controlled scenarios"},
        )
        assert create_project_response.status_code == 201, create_project_response.text
        project = create_project_response.json()
        assert project["created_at"].endswith("Z")

        second_project_response = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "Refunds", "description": "another controlled scenario"},
        )
        assert second_project_response.status_code == 201, second_project_response.text
        second_project = second_project_response.json()

        listed_projects_response = client.get("/api/v1/projects", headers=headers)
        assert listed_projects_response.status_code == 200
        assert listed_projects_response.json() == sorted(
            [project, second_project],
            key=lambda item: (item["created_at"], item["id"]),
            reverse=True,
        )

        selected_project_response = client.get(f"/api/v1/projects/{project['id']}", headers=headers)
        assert selected_project_response.status_code == 200
        assert selected_project_response.json() == project

        create_run_response = client.post(
            f"/api/v1/projects/{project['id']}/runs",
            headers=headers,
            json={"agent": "safe", "scenario": "timeout_after_success"},
        )
        assert create_run_response.status_code == 201, create_run_response.text
        queued_run = create_run_response.json()
        assert queued_run["state"] in {"queued", "running", "passed"}
        run = wait_for_terminal(client, queued_run["id"], headers)
        assert run["state"] == "passed"
        assert run["report"]["agent_name"] == "safe-sample-agent"
        assert run["report"]["metrics"]["duplicate_charges"] == 0

        second_run_response = client.post(
            f"/api/v1/projects/{project['id']}/runs",
            headers=headers,
            json={"agent": "safe", "scenario": "normal"},
        )
        assert second_run_response.status_code == 201, second_run_response.text
        second_run = wait_for_terminal(client, second_run_response.json()["id"], headers)

        list_runs_response = client.get(f"/api/v1/projects/{project['id']}/runs", headers=headers)
        assert list_runs_response.status_code == 200
        summaries = list_runs_response.json()
        assert [summary["id"] for summary in summaries] == [
            item["id"]
            for item in sorted(
                [run, second_run],
                key=lambda item: (item["created_at"], item["id"]),
                reverse=True,
            )
        ]
        assert all("report" not in summary for summary in summaries)
        assert all(summary["created_at"].endswith("Z") for summary in summaries)

        persisted_response = client.get(f"/api/v1/runs/{run['id']}", headers=headers)
        assert persisted_response.status_code == 200
        persisted = persisted_response.json()
        assert persisted["report"] == run["report"]
        assert persisted["completed_at"].endswith("Z")


def test_cross_user_project_and_run_access_is_not_disclosed() -> None:
    with TestClient(app) as client:
        owner_token, _ = register(client, "second-owner@example.test")
        attacker_token, _ = register(client, "attacker@example.test")
        project_response = client.post(
            "/api/v1/projects", headers=auth(owner_token), json={"name": "private"}
        )
        project_id = project_response.json()["id"]
        run_id = client.post(
            f"/api/v1/projects/{project_id}/runs",
            headers=auth(owner_token),
            json={"scenario": "normal", "agent": "safe"},
        ).json()["id"]
        assert client.get(f"/api/v1/projects/{project_id}", headers=auth(attacker_token)).status_code == 404
        assert (
            client.post(
                f"/api/v1/projects/{project_id}/runs",
                headers=auth(attacker_token),
                json={"scenario": "normal", "agent": "safe"},
            ).status_code
            == 404
        )
        assert client.get(f"/api/v1/runs/{run_id}/events", headers=auth(attacker_token)).status_code == 404
        assert (
            client.get(f"/api/v1/runs/{run_id}/events/stream", headers=auth(attacker_token)).status_code
            == 404
        )
        assert client.post(f"/api/v1/runs/{run_id}/cancel", headers=auth(attacker_token)).status_code == 404


def test_invalid_session_is_rejected_and_logout_revokes_token() -> None:
    with TestClient(app) as client:
        token, _ = register(client, "logout@example.test")
        assert client.get("/api/v1/auth/me", headers=auth("not-a-token")).status_code == 401
        assert client.post("/api/v1/auth/logout", headers={"Authorization": f"bearer {token}"}).status_code == 204
        assert client.get("/api/v1/auth/me", headers=auth(token)).status_code == 401


def test_unsupported_agent_is_rejected_before_execution() -> None:
    with TestClient(app) as client:
        token, _ = register(client, "validation@example.test")
        project_response = client.post(
            "/api/v1/projects", headers=auth(token), json={"name": "validation"}
        )
        project_id = project_response.json()["id"]
        response = client.post(
            f"/api/v1/projects/{project_id}/runs",
            headers=auth(token),
            json={"agent": "arbitrary-code", "scenario": "normal"},
        )
        assert response.status_code == 422
        assert response.json()["detail"] == "invalid request"


def test_run_events_are_ordered_persisted_and_streamable() -> None:
    with TestClient(app) as client:
        token, _ = register(client, "events@example.test")
        headers = auth(token)
        project_id = client.post(
            "/api/v1/projects", headers=headers, json={"name": "events"}
        ).json()["id"]
        queued = client.post(
            f"/api/v1/projects/{project_id}/runs",
            headers=headers,
            json={"agent": "safe", "scenario": "normal"},
        ).json()
        run = wait_for_terminal(client, queued["id"], headers)

        response = client.get(f"/api/v1/runs/{run['id']}/events", headers=headers)
        assert response.status_code == 200, response.text
        events = response.json()
        assert [event["sequence"] for event in events] == list(range(len(events)))
        assert all(event["schema_version"] == 1 for event in events)
        assert events[0]["event_type"] == "run_queued"
        assert events[1]["event_type"] == "run_started"
        assert events[-1]["event_type"] == "run_completed"
        assert any(event["event_type"] == "order_created" for event in events)
        engine_events = [
            event for event in events if event["event_type"] not in {"run_queued", "run_started", "run_completed"}
        ]
        assert [event["payload"]["index"] for event in engine_events] == list(range(len(engine_events)))
        page = client.get(
            f"/api/v1/runs/{run['id']}/events?after_sequence=1&limit=2", headers=headers
        )
        assert [event["sequence"] for event in page.json()] == [2, 3]

        stream = client.get(f"/api/v1/runs/{run['id']}/events/stream", headers=headers)
        assert stream.status_code == 200
        assert stream.headers["content-type"].startswith("text/event-stream")
        assert "event: run_queued" in stream.text
        assert "event: order_created" in stream.text
        assert "event: run_completed" in stream.text


def test_project_agent_registry_is_authenticated_and_repository_scoped() -> None:
    with TestClient(app) as client:
        owner_token, _ = register(client, "registry-owner@example.test")
        attacker_token, _ = register(client, "registry-attacker@example.test")
        project_id = client.post(
            "/api/v1/projects", headers=auth(owner_token), json={"name": "registry"}
        ).json()["id"]

        registry = client.get(f"/api/v1/projects/{project_id}/agents", headers=auth(owner_token))
        assert registry.status_code == 200
        assert {item["key"] for item in registry.json()} == {"safe", "defective"}
        assert all(item["source"] == "repository" and item["runnable"] for item in registry.json())
        assert (
            client.get(f"/api/v1/projects/{project_id}/agents", headers=auth(attacker_token)).status_code
            == 404
        )


def test_remote_agent_registration_is_stored_without_api_execution(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        api_main,
        "settings",
        api_main.settings.model_copy(update={"veritybench_agent_artifact_dir": str(tmp_path)}),
    )
    source = """\nAGENT_CONTRACT_VERSION = 1\n\ndef create_agent():\n    raise RuntimeError('must execute only in the worker')\n"""
    with TestClient(app) as client:
        token, _ = register(client, "remote-agent@example.test")
        headers = auth(token)
        project_id = client.post(
            "/api/v1/projects", headers=headers, json={"name": "remote"}
        ).json()["id"]

        registration = client.post(
            f"/api/v1/projects/{project_id}/agents",
            headers=headers,
            json={"name": "checkout-agent", "version": "1.0.0", "source": source},
        )
        assert registration.status_code == 201, registration.text
        metadata = registration.json()
        assert metadata["source_size"] == len(source.encode())
        assert (tmp_path / f"{metadata['id']}.py").read_text() == source

        registry = client.get(f"/api/v1/projects/{project_id}/agents", headers=headers).json()
        custom = next(item for item in registry if item["key"] == f"remote:{metadata['id']}")
        assert custom["source"] == "remote"
        assert custom["runnable"] is True

        queued = client.post(
            f"/api/v1/projects/{project_id}/runs",
            headers=headers,
            json={"agent": f"remote:{metadata['id']}", "scenario": "normal"},
        )
        assert queued.status_code == 201, queued.text
        assert queued.json()["state"] == "queued"
        time.sleep(0.03)
        assert client.get(f"/api/v1/runs/{queued.json()['id']}", headers=headers).json()["state"] == "queued"

        disabled = client.delete(
            f"/api/v1/projects/{project_id}/agents/{metadata['id']}", headers=headers
        )
        assert disabled.status_code == 204


def test_cancellation_is_persisted_and_transitions_a_running_run(monkeypatch) -> None:
    started = threading.Event()

    class BlockingEngine(DeterministicEngine):
        def run(self, agent, *, on_event=None, should_cancel=None):
            started.set()
            while should_cancel is not None and not should_cancel():
                time.sleep(0.01)
            raise ExecutionCancelled

    monkeypatch.setattr(api_main, "DeterministicEngine", BlockingEngine)
    with TestClient(app) as client:
        token, _ = register(client, "cancel@example.test")
        headers = auth(token)
        project_id = client.post(
            "/api/v1/projects", headers=headers, json={"name": "cancel"}
        ).json()["id"]
        queued = client.post(
            f"/api/v1/projects/{project_id}/runs",
            headers=headers,
            json={"agent": "safe", "scenario": "normal"},
        ).json()
        assert started.wait(2)

        cancelled = client.post(f"/api/v1/runs/{queued['id']}/cancel", headers=headers)
        assert cancelled.status_code == 200, cancelled.text
        assert cancelled.json()["cancel_requested"] is True
        completed = wait_for_terminal(client, queued["id"], headers)
        assert completed["state"] == "cancelled"

        events = client.get(f"/api/v1/runs/{queued['id']}/events", headers=headers).json()
        assert [event["event_type"] for event in events][-2:] == [
            "run_cancel_requested",
            "run_cancelled",
        ]


def test_exhausting_the_bounded_engine_is_reported_as_timed_out(monkeypatch) -> None:
    monkeypatch.setattr(api_main, "auth_limiter", api_main.AuthRateLimiter())
    monkeypatch.setattr(
        api_main,
        "settings",
        api_main.settings.model_copy(update={"veritybench_max_run_steps": 1}),
    )
    with TestClient(app) as client:
        token, _ = register(client, "bounded-timeout@example.test")
        headers = auth(token)
        project_id = client.post(
            "/api/v1/projects", headers=headers, json={"name": "bounded-timeout"}
        ).json()["id"]
        queued = client.post(
            f"/api/v1/projects/{project_id}/runs",
            headers=headers,
            json={"agent": "safe", "scenario": "normal"},
        ).json()

        run = wait_for_terminal(client, queued["id"], headers)

        assert run["state"] == "timed_out"
        assert run["report"]["run_state"] == "timed_out"
        assert run["report"]["order"]["status"] == "paid"


def test_worker_exception_is_reported_as_inconclusive(monkeypatch) -> None:
    monkeypatch.setattr(api_main, "auth_limiter", api_main.AuthRateLimiter())

    class BrokenEngine(DeterministicEngine):
        def run(self, agent, *, on_event=None, should_cancel=None):
            raise RuntimeError("synthetic engine failure")

    monkeypatch.setattr(api_main, "DeterministicEngine", BrokenEngine)
    with TestClient(app) as client:
        token, _ = register(client, "inconclusive@example.test")
        headers = auth(token)
        project_id = client.post(
            "/api/v1/projects", headers=headers, json={"name": "inconclusive"}
        ).json()["id"]
        queued = client.post(
            f"/api/v1/projects/{project_id}/runs",
            headers=headers,
            json={"agent": "safe", "scenario": "normal"},
        ).json()

        run = wait_for_terminal(client, queued["id"], headers)

        assert run["state"] == "inconclusive"
        assert run["report"] is None
        assert run["error_message"] == "execution failed: RuntimeError"
