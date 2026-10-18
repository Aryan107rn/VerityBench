.PHONY: test test-python lint typecheck build frontend-test

test: test-python lint typecheck frontend-test

test-python:
	python -m pytest

lint:
	python -m ruff check src tests

typecheck:
	python -m mypy src

frontend-test:
	cd frontend && npm run typecheck && npm run build
