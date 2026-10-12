# Run `make` or `make help` to see the targets.

# 8000 is a common default but is often taken (e.g. by Docker); override with
# `make dev BACKEND_PORT=8000`.
BACKEND_PORT ?= 8001
FRONTEND_PORT ?= 5173

.DEFAULT_GOAL := help
.PHONY: help install dev backend frontend mock test test-backend test-frontend typecheck build clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[1mmake %-14s\033[0m %s\n", $$1, $$2}'

install: ## Install backend and frontend dependencies
	cd backend && uv sync
	cd frontend && npm install

dev: ## Run backend + frontend together (Ctrl-C stops both)
	@echo "Open http://localhost:$(FRONTEND_PORT)  (backend on :$(BACKEND_PORT))"
	@trap 'kill 0' INT TERM EXIT; \
	$(MAKE) --no-print-directory backend & \
	$(MAKE) --no-print-directory frontend & \
	wait

backend: ## Run only the FastAPI backend
	cd backend && uv run uvicorn app.main:app --host 127.0.0.1 --port $(BACKEND_PORT) --reload

frontend: ## Run only the frontend, proxying to the backend
	cd frontend && SDI_BACKEND_URL=http://127.0.0.1:$(BACKEND_PORT) npx vite --port $(FRONTEND_PORT) --strictPort

mock: ## Run the frontend alone on the in-browser mock backend
	cd frontend && npx vite --mode mock --port $(FRONTEND_PORT) --strictPort

test: test-backend test-frontend ## Run all tests

test-backend: ## Run backend tests (pytest)
	cd backend && uv run pytest -q

test-frontend: ## Run frontend tests (vitest)
	cd frontend && npm test

typecheck: ## Typecheck the frontend
	cd frontend && npx tsc -b

build: ## Production build of the frontend
	cd frontend && npm run build

clean: ## Remove build output and caches (keeps the SQLite database)
	rm -rf frontend/dist frontend/node_modules/.vite frontend/*.tsbuildinfo
	find backend -type d \( -name __pycache__ -o -name .pytest_cache \) -prune -exec rm -rf {} +
