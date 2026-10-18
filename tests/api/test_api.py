from __future__ import annotations

from fastapi.testclient import TestClient

from veritybench.api.main import app


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
        run = run_response.json()
        assert run["state"] == "failed"
        assert run["report"]["metrics"]["duplicate_charges"] == 1
        assert run["report"]["evaluation"]["passed"] is False

        read_response = client.get(f"/api/v1/runs/{run['id']}", headers=headers)
        assert read_response.status_code == 200
        assert read_response.json()["report"]["trace"]


def test_cross_user_project_and_run_access_is_not_disclosed() -> None:
    with TestClient(app) as client:
        owner_token, _ = register(client, "second-owner@example.test")
        attacker_token, _ = register(client, "attacker@example.test")
        project_response = client.post(
            "/api/v1/projects", headers=auth(owner_token), json={"name": "private"}
        )
        project_id = project_response.json()["id"]
        assert client.get(f"/api/v1/projects/{project_id}", headers=auth(attacker_token)).status_code == 404
        assert (
            client.post(
                f"/api/v1/projects/{project_id}/runs",
                headers=auth(attacker_token),
                json={"scenario": "normal", "agent": "safe"},
            ).status_code
            == 404
        )


def test_invalid_session_is_rejected_and_logout_revokes_token() -> None:
    with TestClient(app) as client:
        token, _ = register(client, "logout@example.test")
        assert client.get("/api/v1/auth/me", headers=auth("not-a-token")).status_code == 401
        assert client.post("/api/v1/auth/logout", headers=auth(token)).status_code == 204
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
