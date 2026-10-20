# Everything you need day to day is a make target, so `make <target>` is the only command to remember.
# Run `make` or `make help` for the list.
#
# GNU Make on Windows: the recipes below use only commands that behave the same in cmd.exe and in a POSIX
# shell (docker, pnpm, node), so they work wherever make is installed. Install make once with
#   winget install ezwinports.make
# then open a NEW terminal. (GnuWin32.Make or `choco install make` also work.)

.DEFAULT_GOAL := help
.PHONY: help setup env install db db-stop db-logs dev status check verify build build-production \
        lint format format-check typecheck test test-integration test-e2e evaluate up down clean

# The command that creates .env from the template when it does not exist (it never overwrites an existing one).
ENV_SNIPPET = const fs=require('fs');if(fs.existsSync('.env')){console.log('.env already exists - left unchanged')}else{fs.copyFileSync('.env.example','.env');console.log('created .env from .env.example - open it and set LLM_PROVIDER and the matching API key')}

help:
	@echo Trao AI Interview Prep Kit - make targets
	@echo   make setup             first time: install packages and create .env if missing
	@echo   make dev               start MongoDB, the API on port 4000 and the web app on port 3000
	@echo   make db                start only MongoDB (waits until it is healthy)
	@echo   make db-stop           stop MongoDB, keeping its data
	@echo   make db-logs           show the last MongoDB log lines
	@echo   make status            show whether MongoDB, the API and the web app are answering
	@echo   make check             format check, lint, typecheck and unit tests
	@echo   make verify            check plus integration tests and the production build
	@echo   make test              unit tests
	@echo   make test-integration  integration tests against MongoDB (starts it first)
	@echo   make build             production build
	@echo   make build-production API_URL=https://api.example.com   deployment build
	@echo   make evaluate INPUT=cases.json OUTPUT=kits.json   batch evaluation (uses your model key)
	@echo   make clean             delete node_modules and build output (not your data)
	@echo Stop make dev with Ctrl+C in its window.

# --- first-time setup ---------------------------------------------------------------------------------

setup: env install

env:
	@node -e "$(ENV_SNIPPET)"

install:
	pnpm install --frozen-lockfile

# --- run the application ------------------------------------------------------------------------------

# `make dev` is the one command to start everything. It creates .env if it is missing, installs packages if
# they are missing, starts MongoDB (Docker) and waits until it is healthy, then runs the API and the web app
# together. The API loads .env, so the model provider and key come from there.
dev: .env node_modules/.installed db
	pnpm dev

.env:
	@node -e "$(ENV_SNIPPET)"

# A stamp file records that the packages match package.json and pnpm-lock.yaml, so `make dev` installs only
# when one of them changed (or node_modules is missing).
node_modules/.installed: package.json pnpm-lock.yaml
	pnpm install --frozen-lockfile
	node -e "require('fs').writeFileSync('node_modules/.installed','')"

# --- MongoDB (Docker) ---------------------------------------------------------------------------------

# Starts the `mongo` service from compose.yaml and waits for its health check. Data lives in a Docker volume
# and survives db-stop and down.
db: .env
	docker compose up -d --wait mongo

db-stop:
	docker compose stop mongo

db-logs:
	docker compose logs --tail 50 mongo

status:
	docker compose ps
	@node -e "const t=(n,u)=>fetch(u,{signal:AbortSignal.timeout(2000)}).then(r=>console.log(n,'answers',r.status),()=>console.log(n,'is NOT answering'));Promise.all([t('API  http://localhost:4000/ready','http://localhost:4000/ready'),t('Web  http://localhost:3000/login','http://localhost:3000/login')])"

# --- checks -------------------------------------------------------------------------------------------

check: format-check lint typecheck test

verify: check test-integration build

lint:
	pnpm lint

format:
	pnpm format

format-check:
	pnpm format:check

typecheck:
	pnpm typecheck

test:
	pnpm test

test-integration: db
	pnpm test:integration

test-e2e:
	pnpm test:e2e

# --- builds -------------------------------------------------------------------------------------------

build:
	pnpm build

# Deployment build. It refuses to build unless API_URL is a public https address (see docs/deployment.md).
build-production: export NEXT_PUBLIC_API_URL = $(API_URL)
build-production:
	pnpm build:production

# --- batch evaluation ---------------------------------------------------------------------------------

# Usage: make evaluate INPUT=cases.json OUTPUT=kits.json
evaluate:
	npm run evaluate -- --input $(INPUT) --output $(OUTPUT)

# --- Docker and cleanup -------------------------------------------------------------------------------

# Aliases kept from earlier versions.
up: db

# Stops and removes the containers. The database volume is kept (this never uses -v).
down:
	docker compose down

clean:
	node -e "for (const d of ['node_modules','apps/web/.next','coverage']) require('fs').rmSync(d,{recursive:true,force:true})"
