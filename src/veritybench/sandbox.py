"""Docker boundary for CLI-local custom agents.

This module deliberately owns the host-facing sandbox policy.  The agent
source is copied into a private temporary directory and the container sees
only a read-only bind mount of that one file.  The runtime and image are
explicitly injectable for offline tests, but production calls use Docker and
never fall back to a host Python process.
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess  # nosec B404 - invokes only the fixed Docker runtime command
import tempfile
import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

AGENT_IMAGE_ENV = "VERITYBENCH_AGENT_IMAGE"
AGENT_CONTAINER_PATH = "/veritybench-agent.py"
DEFAULT_PREFLIGHT_TIMEOUT_SECONDS = 5.0
CONTAINER_USER = "65532:65532"
CONTAINER_MEMORY = "256m"
CONTAINER_CPUS = "1"
CONTAINER_PIDS_LIMIT = "128"

_PINNED_IMAGE_PATTERN = re.compile(r"[^@\s]+@sha256:[0-9a-f]{64}\Z")


class SandboxError(RuntimeError):
    """A fail-closed local sandbox setup or runtime error."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _error_detail(result: subprocess.CompletedProcess[bytes]) -> str:
    detail = result.stderr.decode("utf-8", errors="replace").strip()
    return detail[:500]


def validate_agent_source(agent_path: Path) -> Path:
    """Validate and return the exact regular source file without resolving links."""

    candidate = agent_path.expanduser()
    if any(part == ".." for part in candidate.parts):
        raise SandboxError("invalid_agent_path", "agent path must not contain parent-directory traversal")
    source = candidate if candidate.is_absolute() else Path.cwd() / candidate
    source = Path(os.path.abspath(source))
    try:
        source_stat = os.lstat(source)
    except FileNotFoundError as exc:
        raise SandboxError("agent_not_found", f"agent path does not exist: {agent_path}") from exc
    except OSError as exc:
        raise SandboxError("agent_not_found", f"cannot inspect agent path: {exc}") from exc

    if stat.S_ISLNK(source_stat.st_mode):
        raise SandboxError("invalid_agent_path", "agent path must not be a symlink")
    if not stat.S_ISREG(source_stat.st_mode):
        raise SandboxError("invalid_agent_path", "agent path must point to a regular file")
    if source.suffix.lower() != ".py":
        raise SandboxError("invalid_agent_path", "agent path must point to a .py file")

    current = Path(source.anchor)
    for part in source.parts[1:]:
        current /= part
        try:
            mode = os.lstat(current).st_mode
        except OSError as exc:
            raise SandboxError("agent_not_found", f"cannot inspect agent path: {exc}") from exc
        if stat.S_ISLNK(mode):
            raise SandboxError("invalid_agent_path", "agent path must not traverse symlinked directories")
    return source


def _copy_source(source: Path, destination: Path) -> None:
    """Copy through an open no-follow descriptor to avoid staging a replacement link."""

    try:
        source_stat = os.lstat(source)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        source_fd = os.open(source, flags)
        try:
            opened_stat = os.fstat(source_fd)
            if (opened_stat.st_dev, opened_stat.st_ino) != (source_stat.st_dev, source_stat.st_ino):
                raise SandboxError("invalid_agent_path", "agent source changed during staging")
            destination_fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
            try:
                with os.fdopen(source_fd, "rb", closefd=False) as source_file, os.fdopen(
                    destination_fd, "wb", closefd=False
                ) as destination_file:
                    shutil.copyfileobj(source_file, destination_file)
            finally:
                os.close(destination_fd)
        finally:
            os.close(source_fd)
        os.chmod(destination, 0o444)
    except SandboxError:
        raise
    except OSError as exc:
        raise SandboxError("agent_stage_failed", f"could not stage agent source: {exc}") from exc


@contextmanager
def stage_agent(agent_path: Path) -> Iterator[Path]:
    """Stage exactly one agent file in a private temporary directory."""

    source = validate_agent_source(agent_path)
    try:
        with tempfile.TemporaryDirectory(prefix="veritybench-agent-") as temporary_directory:
            staged = Path(temporary_directory) / "agent.py"
            _copy_source(source, staged)
            yield staged
    except SandboxError:
        raise
    except OSError as exc:
        raise SandboxError("agent_stage_failed", f"could not create private agent staging directory: {exc}") from exc


def _runtime_environment() -> dict[str, str]:
    """Keep host secrets and Docker client configuration out of runtime calls."""

    return {"PATH": os.defpath, "LC_ALL": "C", "LANG": "C"}


class DockerSandbox:
    """Configured Docker runtime with one immutable image policy."""

    def __init__(self, command: tuple[str, ...], image: str) -> None:
        self.command = command
        self.image = image

    @classmethod
    def from_environment(cls, runtime_command: Sequence[str] | None = None) -> DockerSandbox:
        image = os.environ.get(AGENT_IMAGE_ENV, "").strip()
        if not image:
            raise SandboxError(
                "sandbox_image_unconfigured",
                f"{AGENT_IMAGE_ENV} must be set to a digest-pinned Docker image",
            )
        if _PINNED_IMAGE_PATTERN.fullmatch(image) is None:
            raise SandboxError(
                "sandbox_image_unpinned",
                f"{AGENT_IMAGE_ENV} must use name@sha256:<64 lowercase hex characters>",
            )

        if runtime_command is None:
            docker_path = shutil.which("docker")
            if docker_path is None:
                raise SandboxError(
                    "docker_unavailable",
                    "Docker is required for --agent-path but the docker executable was not found",
                )
            command: tuple[str, ...] = (docker_path,)
        else:
            command = tuple(runtime_command)
            if not command or any(not item for item in command):
                raise SandboxError("docker_unavailable", "the injected Docker runtime command is empty")
        return cls(command, image)

    def _control(self, arguments: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
        try:
            return subprocess.run(  # nosec B603 - command is Docker or an injected offline test runtime  # noqa: S603
                [*self.command, *arguments],
                capture_output=True,
                env=_runtime_environment(),
                timeout=DEFAULT_PREFLIGHT_TIMEOUT_SECONDS,
                check=False,
            )
        except FileNotFoundError as exc:
            raise SandboxError("docker_unavailable", f"Docker could not be started: {self.command[0]}") from exc
        except subprocess.TimeoutExpired as exc:
            raise SandboxError("docker_unavailable", "Docker did not respond during sandbox preflight") from exc
        except OSError as exc:
            raise SandboxError("docker_unavailable", f"Docker could not be started: {exc}") from exc

    def preflight(self) -> None:
        """Require a responsive Docker daemon and the exact pinned image locally."""

        info = self._control(("info", "--format", "{{.ServerVersion}}"))
        if info.returncode != 0:
            detail = _error_detail(info)
            suffix = f": {detail}" if detail else ""
            raise SandboxError("docker_unavailable", f"Docker daemon is unavailable{suffix}")

        image = self._control(("image", "inspect", "--format", "{{.Id}}", self.image))
        if image.returncode != 0:
            detail = _error_detail(image)
            suffix = f": {detail}" if detail else ""
            raise SandboxError(
                "sandbox_image_unavailable",
                f"configured Docker image {self.image!r} is not available locally{suffix}",
            )

    def container_name(self) -> str:
        return f"veritybench-agent-{uuid.uuid4().hex}"

    def run_arguments(self, staged_agent: Path, container_name: str, worker_mode: str = "worker") -> list[str]:
        """Return the fixed, hardened Docker invocation for the worker protocol."""

        if worker_mode not in {"worker", "decision-worker"}:
            raise SandboxError("invalid_worker_mode", "unsupported sandbox worker mode")

        mount = f"type=bind,source={staged_agent},destination={AGENT_CONTAINER_PATH},readonly"
        return [
            "run",
            "--rm",
            "--init",
            "--pull=never",
            "--name",
            container_name,
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges:true",
            f"--user={CONTAINER_USER}",
            f"--pids-limit={CONTAINER_PIDS_LIMIT}",
            f"--memory={CONTAINER_MEMORY}",
            f"--cpus={CONTAINER_CPUS}",
            "--mount",
            mount,
            "--env=PATH=/usr/local/bin:/usr/bin:/bin",
            "--env=PYTHONPATH=/app/src",
            "--env=PYTHONDONTWRITEBYTECODE=1",
            "--env=PYTHONNOUSERSITE=1",
            "--env=PYTHONUNBUFFERED=1",
            "--env=LC_ALL=C",
            "--env=LANG=C",
            "--entrypoint=python",
            self.image,
            "-m",
            "veritybench.local_worker",
            f"--{worker_mode}",
        ]

    def cleanup(self, container_name: str) -> None:
        """Remove a possible orphan after a client-side timeout or launch error."""

        try:
            subprocess.run(  # nosec B603 - command is Docker or an injected offline test runtime  # noqa: S603
                [*self.command, "rm", "--force", container_name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=_runtime_environment(),
                timeout=DEFAULT_PREFLIGHT_TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return
