# Run `make` or `make help` to see the targets.

# 8000 is a common default but is often taken (e.g. by Docker); override with
# `make dev BACKEND_PORT=8000`.
BACKEND_PORT ?= 8001
FRONTEND_PORT ?= 5173
DOCKER_IMAGE ?= sketchroom
DOCKER_PORT ?= 8080
PG_TEST_PORT ?= 55432

.DEFAULT_GOAL := help
.PHONY: help install dev backend frontend mock test test-backend test-postgres test-frontend typecheck build docker docker-run clean

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

test-postgres: ## Run backend tests against a throwaway Postgres container
	@docker rm -f sdi-test-postgres >/dev/null 2>&1 || true
	docker run -d --rm --name sdi-test-postgres -e POSTGRES_PASSWORD=sdi -e POSTGRES_DB=sdi_test \
		-p 127.0.0.1:$(PG_TEST_PORT):5432 postgres:17 >/dev/null
	@# -h 127.0.0.1: the image's first-boot setup server is reachable only over its Unix socket.
	@# INT/TERM exit explicitly because dash, make's shell on Debian, skips EXIT traps on signals.
	@trap 'docker rm -f sdi-test-postgres >/dev/null' EXIT; trap 'exit 130' INT TERM; \
	n=0; until docker exec sdi-test-postgres pg_isready -q -h 127.0.0.1 -U postgres; do \
		n=$$((n + 1)); [ $$n -lt 120 ] || { echo "Postgres did not start within 60s" >&2; exit 1; }; sleep 0.5; \
	done; \
	cd backend && TEST_DATABASE_URL=postgresql+psycopg://postgres:sdi@127.0.0.1:$(PG_TEST_PORT)/sdi_test uv run pytest -q

test-frontend: ## Run frontend tests (vitest)
	cd frontend && npm test

typecheck: ## Typecheck the frontend
	cd frontend && npx tsc -b

build: ## Production build of the frontend
	cd frontend && npm run build

docker: ## Build the Docker image (frontend + backend in one)
	docker build -t $(DOCKER_IMAGE) .

docker-run: docker ## Run the Docker image, keeping rooms in the sketchroom-data volume
	@echo "Open http://localhost:$(DOCKER_PORT)"
	docker run --rm -p $(DOCKER_PORT):8000 -v sketchroom-data:/app/data $(DOCKER_IMAGE)

clean: ## Remove build output and caches (keeps the SQLite database)
	rm -rf frontend/dist frontend/node_modules/.vite frontend/*.tsbuildinfo
	find backend -type d \( -name __pycache__ -o -name .pytest_cache \) -prune -exec rm -rf {} +
