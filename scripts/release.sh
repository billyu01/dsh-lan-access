#!/usr/bin/env bash
#
# Publish dsh-lan-access to npm.
#
# Usage:
#   npm run release              # publish a patch bump
#   npm run release -- patch     # explicit: patch | minor | major
#   npm run release -- 0.2.0     # explicit version
#
# Requires: npm, and a logged-in registry (`npm whoami`).
set -euo pipefail

cd "$(dirname "$0")/.."

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm not found on PATH" >&2
  exit 1
fi

if ! npm whoami >/dev/null 2>&1; then
  echo "error: not logged into npm (run: npm login)" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "error: working tree is dirty; commit or stash before releasing" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Resolve target version
# ---------------------------------------------------------------------------
BUMP="${1:-patch}"

if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  VERSION="$BUMP"
  echo ">> publishing explicit version $VERSION"
  npm version "$VERSION" --no-git-tag-version
else
  case "$BUMP" in
    patch|minor|major) ;;
    *)
      echo "error: unknown bump '$BUMP' (expected patch|minor|major or x.y.z)" >&2
      exit 1
      ;;
  esac
  echo ">> bumping $BUMP"
  npm version "$BUMP"
fi

# ---------------------------------------------------------------------------
# 3. Verify the tarball contents
# ---------------------------------------------------------------------------
echo ">> packing dry run"
npm pack --dry-run 2>&1 | sed 's/^/   /'

# ---------------------------------------------------------------------------
# 4. Publish
# ---------------------------------------------------------------------------
echo ">> publishing"
npm publish --access public

echo ">> done"
