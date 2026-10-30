# s1sdk developer tasks. `just` is optional — every recipe is one bun command.
#   brew install just   |   cargo install just
#
# Provider is the first positional argument:
#   just smoke ollama          just example 2 ollama          just examples
set shell := ["bash", "-uc"]

default:
    @just --list

# ── Setup ────────────────────────────────────────────────────────────────────

install:
    bun install

# Copy the annotated env template once; .env is gitignored.
env:
    @test -f .env || cp .env.example .env
    @echo "edit .env, then: just doctor"

# ── Local loop ───────────────────────────────────────────────────────────────

# Which credentials/daemons are visible, and which provider wins.
doctor:
    bun run scripts/devx.ts doctor

# One real decision against the resolved provider (latency + tokens printed).
smoke provider="" model="":
    bun run scripts/devx.ts smoke {{ if provider != "" { "--provider " + provider } else { "" } }} {{ if model != "" { "--model " + model } else { "" } }}

# Everything: doctor + smoke.
devx provider="":
    bun run scripts/devx.ts all {{ if provider != "" { "--provider " + provider } else { "" } }}

# Run one example through the resolver: just example 2 [ollama]
example id provider="":
    bun run scripts/devx.ts example {{ id }} {{ if provider != "" { "--provider " + provider } else { "" } }}

# Every provider-agnostic example in order.
examples provider="":
    bun run scripts/devx.ts examples {{ if provider != "" { "--provider " + provider } else { "" } }}

list:
    bun run scripts/devx.ts list

# ── Quality gates ────────────────────────────────────────────────────────────

typecheck:
    bun run typecheck

test filter="":
    bun run test {{ filter }}

build:
    bun run build

# The gate that must pass before a release.
check: typecheck test build

# ── Cloudflare worker example (real env.AI binding) ──────────────────────────

worker-dev:
    set -a && . ./.env && set +a && bunx wrangler@4 dev \
      --config examples/03-cloudflare-worker-customer-service/wrangler.clairic.jsonc --port 8791

# ── Release ──────────────────────────────────────────────────────────────────

# Inspect the tarball that would be published (no upload).
pack:
    npm publish --dry-run --access public

# Publish 0.1.x to npm. Requires a valid NPM_TOKEN / npm login.
release: check
    npm publish --access public

# Tag the published commit and push the tag (not main).
tag version:
    git tag -a "v{{ version }}" -m "s1sdk v{{ version }}"
    git push origin "v{{ version }}"

clean:
    rm -rf dist node_modules/.cache .vitest
