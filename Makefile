# Thin wrappers over the pnpm scripts. GNU Make is optional: every target is a single pnpm command,
# so `pnpm <script>` works identically. On Windows install Make with `winget install GnuWin32.Make`
# (or `choco install make`).
.PHONY: install dev build lint format format-check typecheck test test-integration test-e2e evaluate up down clean

install:
	pnpm install --frozen-lockfile

dev:
	pnpm dev

build:
	pnpm build

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

test-integration:
	pnpm test:integration

test-e2e:
	pnpm test:e2e

# Usage: make evaluate INPUT=cases.json OUTPUT=kits.json
evaluate:
	npm run evaluate -- --input $(INPUT) --output $(OUTPUT)

up:
	docker compose up -d

down:
	docker compose down

clean:
	node -e "for (const d of ['node_modules','apps/web/.next','coverage']) require('fs').rmSync(d,{recursive:true,force:true})"
