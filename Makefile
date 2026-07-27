.DEFAULT_GOAL := help
SHELL := /usr/bin/env bash

.PHONY: help install install-cc install-skill verify doctor test test-engine test-engine-ci scan lint check-docs build-engine ci ci-clean check hooks gui-install gui gui-test gui-build gui-package

GUI_DIR := benchmarks/case-d-gui/desktop

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n",$$1,$$2}'

install: ## Install launchers to ~/bin (mirrors backends/bin)
	npm run install:backends

install-cc: ## Install launchers and put pinned claude-code into each env
	npm run install:backends -- --install-claude-code

verify: ## Launcher self-test + cc-models doctor
	npm run verify:launchers && cc-models doctor

doctor: ## Environment recon + workflow recommendation (run on any machine)
	orchestration/fuguectl/fuguectl doctor

install-skill: ## Install as a Claude Code skill (~/.claude/skills/fugunano, backs up first if present)
	npm run install:skill

test: ## Run plugin + fuguectl tests
	npm test

test-engine: ## Run TypeScript engine checks
	npm run test:engine

test-engine-ci: ## Clean-install engine deps, then run TypeScript engine checks
	npm run test:engine:ci

scan: ## Secret-leak scan (local gate)
	npm run scan

lint: ## Node launcher syntax check
	npm run lint:launchers

check-docs: ## Docs-drift gate (fuguectl README + Self-Harness guide == actual code)
	npm run check:docs

# Six fuguectl selftest files black-box the COMPILED engine via
# engine/dist/cli/main.js (see fuguectl-node-bridge.mjs). Without this,
# `make ci` grades a stale dist: an engine/src change that is coherent with
# its own vitest passes locally and only fails in the CI `node` job, which
# builds first. Mirrors `npm run ci`, which has always included build:engine.
build-engine: ## Build the engine CLI that the fuguectl shims delegate to
	npm run build:engine

hooks: ## Install repo git hooks (pre-commit = fast tiny-PR gate, pre-push = full make ci)
	git config core.hooksPath .githooks
	chmod +x .githooks/pre-commit .githooks/pre-push
	@echo "hooks installed: pre-commit (scan+lint+docs+staged engine checks), pre-push (make ci)"

ci: scan lint check-docs build-engine test test-engine ## Full local CI using installed deps

check: ci ## Alias for ci

ci-clean: scan lint check-docs build-engine test test-engine-ci ## Full clean CI with engine npm ci

gui-install: ## Install FuguNano Studio desktop GUI deps
	cd $(GUI_DIR) && npm install

gui: ## Launch FuguNano Studio (Electron desktop GUI, dev mode)
	cd $(GUI_DIR) && npm run dev

gui-test: ## Run GUI unit tests (selector parity / drift guard)
	cd $(GUI_DIR) && npm test

gui-build: ## Typecheck + test + build the GUI renderer (what CI runs)
	cd $(GUI_DIR) && npm run typecheck && npm test && npm run build

gui-package: ## Package the desktop app locally (unsigned .app + .dmg → release/)
	cd $(GUI_DIR) && npm run package
