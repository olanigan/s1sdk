# s1sdk — Makefile mirror of justfile for people without `just`.
# Every target is a thin wrapper around one bun command; no hidden state.
#
#   make            list targets
#   make doctor     which credentials/daemons are visible
#   make smoke      one real decision against the resolved provider
#   make example ID=2
#   make check      typecheck + test + build
#   make pack       inspect the npm tarball without uploading

SHELL := bash
.DEFAULT_GOAL := help
.DEFAULT_SHELLFLAGS := -eu -o pipefail -c

PROVIDER ?=
MODEL ?=
ID ?= 0
FILTER ?=

PROVIDER_FLAG := $(if $(PROVIDER),--provider $(PROVIDER),)
MODEL_FLAG := $(if $(MODEL),--model $(MODEL),)

.PHONY: help install env doctor smoke devx example examples list typecheck test build check worker-dev pack release tag clean

help:
	@echo "s1sdk targets"
	@echo "  install          bun install"
	@echo "  env              copy .env.example -> .env"
	@echo "  doctor           inspect credentials + daemons"
	@echo "  smoke            one real decision (PROVIDER= MODEL=)"
	@echo "  devx             doctor + smoke"
	@echo "  example ID=2     run one example (PROVIDER= to force a backend)"
	@echo "  examples         run all provider-agnostic examples"
	@echo "  list             list runnable examples"
	@echo "  typecheck test build check"
	@echo "  worker-dev       wrangler dev for the env.AI binding example"
	@echo "  pack             npm publish --dry-run"
	@echo "  release          publish to npm (requires NPM_TOKEN)"
	@echo "  tag VERSION=0.1.1"
	@echo "  clean"

install:
	bun install

env:
	@test -f .env || cp .env.example .env
	@echo "edit .env, then: make doctor"

doctor:
	bun run scripts/devx.ts doctor

smoke:
	bun run scripts/devx.ts smoke $(PROVIDER_FLAG) $(MODEL_FLAG)

devx:
	bun run scripts/devx.ts all $(PROVIDER_FLAG)

example:
	bun run scripts/devx.ts example $(ID) $(PROVIDER_FLAG)

examples:
	bun run scripts/devx.ts examples $(PROVIDER_FLAG)

list:
	bun run scripts/devx.ts list

typecheck:
	bun run typecheck

test:
	bun run test $(FILTER)

build:
	bun run build

check: typecheck test build

worker-dev:
	set -a && . ./.env && set +a && bunx wrangler@4 dev \
	  --config examples/03-cloudflare-worker-customer-service/wrangler.clairic.jsonc --port 8791

pack:
	npm publish --dry-run --access public

release: check
	npm publish --access public

tag:
	@test -n "$(VERSION)" || (echo "usage: make tag VERSION=0.1.1" && exit 1)
	git tag -a "v$(VERSION)" -m "s1sdk v$(VERSION)"
	git push origin "v$(VERSION)"

clean:
	rm -rf dist node_modules/.cache .vitest
