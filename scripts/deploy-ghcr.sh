#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Deploy the Docker image to GitHub Packages (GHCR).

Usage:
  scripts/deploy-ghcr.sh [options]

Options:
  --image IMAGE        Fully qualified image name. Defaults to ghcr.io/<owner>/<repo>.
  --tag TAG           Extra tag to publish. May be repeated.
  --version VERSION   Version tag. Defaults to package.json version.
  --platform LIST     Docker platforms. Defaults to linux/amd64.
  --no-latest         Do not publish the latest tag.
  --no-login          Skip docker login.
  --dry-run           Print docker commands without running them.
  -h, --help          Show this help.

Environment:
  GHCR_IMAGE          Same as --image.
  IMAGE_NAME          Same as --image.
  VERSION             Same as --version.
  PLATFORMS           Same as --platform.
  GHCR_USERNAME       GitHub username/org for login. Defaults to GITHUB_ACTOR or git remote owner.
  GHCR_TOKEN          Token for GHCR login. Defaults to GITHUB_TOKEN.
  GITHUB_TOKEN        Token with packages:write permission.
  GITHUB_REPOSITORY   owner/repo, used to derive the default image name in GitHub Actions.

Examples:
  GHCR_TOKEN=ghp_xxx scripts/deploy-ghcr.sh
  scripts/deploy-ghcr.sh --image ghcr.io/acme/agentproxy --tag canary --no-latest
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

run() {
  if [ "$DRY_RUN" = "true" ]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

repo_from_git_remote() {
  local remote
  remote="$(git config --get remote.origin.url 2>/dev/null || true)"
  [ -n "$remote" ] || return 1

  case "$remote" in
    git@github.com:*)
      remote="${remote#git@github.com:}"
      remote="${remote%.git}"
      ;;
    https://github.com/*)
      remote="${remote#https://github.com/}"
      remote="${remote%.git}"
      ;;
    *)
      return 1
      ;;
  esac

  printf '%s\n' "$remote"
}

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

package_version() {
  node -p "require('./package.json').version"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

IMAGE="${GHCR_IMAGE:-${IMAGE_NAME:-}}"
VERSION="${VERSION:-}"
PLATFORMS="${PLATFORMS:-linux/amd64}"
PUBLISH_LATEST="true"
LOGIN="true"
DRY_RUN="false"
EXTRA_TAGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image)
      [ "$#" -ge 2 ] || die "--image requires a value"
      IMAGE="$2"
      shift 2
      ;;
    --tag)
      [ "$#" -ge 2 ] || die "--tag requires a value"
      EXTRA_TAGS+=("$2")
      shift 2
      ;;
    --version)
      [ "$#" -ge 2 ] || die "--version requires a value"
      VERSION="$2"
      shift 2
      ;;
    --platform)
      [ "$#" -ge 2 ] || die "--platform requires a value"
      PLATFORMS="$2"
      shift 2
      ;;
    --no-latest)
      PUBLISH_LATEST="false"
      shift
      ;;
    --no-login)
      LOGIN="false"
      shift
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

require_command git
require_command node
if [ "$DRY_RUN" != "true" ]; then
  require_command docker
fi

if [ -z "$IMAGE" ]; then
  repo="${GITHUB_REPOSITORY:-$(repo_from_git_remote || true)}"
  [ -n "$repo" ] || die "could not infer repository; pass --image ghcr.io/<owner>/<repo>"
  IMAGE="ghcr.io/$(lowercase "$repo")"
fi

case "$IMAGE" in
  ghcr.io/*) ;;
  *) die "image must be hosted on ghcr.io, got: $IMAGE" ;;
esac

if [ -z "$VERSION" ]; then
  VERSION="$(package_version)"
fi

GIT_SHA="$(git rev-parse --short=12 HEAD)"
TAGS=("$VERSION" "sha-$GIT_SHA")
if [ "$PUBLISH_LATEST" = "true" ]; then
  TAGS+=("latest")
fi
if [ "${#EXTRA_TAGS[@]}" -gt 0 ]; then
  TAGS+=("${EXTRA_TAGS[@]}")
fi

if [ "$LOGIN" = "true" ]; then
  username="${GHCR_USERNAME:-${GITHUB_ACTOR:-}}"
  if [ -z "$username" ]; then
    repo="${GITHUB_REPOSITORY:-$(repo_from_git_remote || true)}"
    username="${repo%%/*}"
  fi
  token="${GHCR_TOKEN:-${GITHUB_TOKEN:-}}"
  [ -n "$username" ] || die "GHCR_USERNAME or GITHUB_ACTOR is required for login"

  if [ "$DRY_RUN" = "true" ]; then
    echo "+ docker login ghcr.io --username $username --password-stdin"
  else
    [ -n "$token" ] || die "GHCR_TOKEN or GITHUB_TOKEN is required for login"
    printf '%s' "$token" | docker login ghcr.io --username "$username" --password-stdin
  fi
fi

BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
VCS_REF="$(git rev-parse HEAD)"

build_args=(
  docker buildx build
  --platform "$PLATFORMS"
  --push
  --build-arg "VERSION=$VERSION"
  --build-arg "VCS_REF=$VCS_REF"
  --build-arg "BUILD_DATE=$BUILD_DATE"
)
for tag in "${TAGS[@]}"; do
  build_args+=(--tag "$IMAGE:$tag")
done
build_args+=(.)

if [ "$DRY_RUN" = "true" ]; then
  run "${build_args[@]}"
elif docker buildx version >/dev/null 2>&1; then
  run "${build_args[@]}"
else
  [ "$PLATFORMS" = "linux/amd64" ] || die "docker buildx is required for multi-platform builds"
  build_args=(
    docker build
    --build-arg "VERSION=$VERSION"
    --build-arg "VCS_REF=$VCS_REF"
    --build-arg "BUILD_DATE=$BUILD_DATE"
  )
  for tag in "${TAGS[@]}"; do
    build_args+=(--tag "$IMAGE:$tag")
  done
  build_args+=(.)
  run "${build_args[@]}"
  for tag in "${TAGS[@]}"; do
    run docker push "$IMAGE:$tag"
  done
fi

echo "Published:"
for tag in "${TAGS[@]}"; do
  echo "  $IMAGE:$tag"
done
