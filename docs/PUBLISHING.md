# Publishing `agentproxy`

Agentproxy is publishable as an npm package and as a Docker image on GitHub Packages / GHCR.

The npm binary entrypoint is `agentproxy` (`dist/server/main.js`).

## Prerequisites

- npm account with publish access for `agentproxy`, if publishing npm artifacts
- npm trusted publishing configured for this repository, if publishing npm artifacts
- `GITHUB_TOKEN` or `GHCR_TOKEN` with `packages:write`, if publishing Docker images
- Clean `main` branch with passing CI

## Release Checklist

1. Decide if this is a publish-worthy change.
   - Docs-only or refactors with no user-visible behavior change: do not publish.
   - User-visible changes to the HTTP API, Docker image, authentication flow, or CLI behavior: publish.
2. Update version in `package.json` (semver) only when publishing.
2. Build and run tests locally:
   - `npm install`
   - `npm run build`
   - `npm test`
   - `sh -n docker-entrypoint.sh`
   - `bash -n scripts/deploy-ghcr.sh`
3. Confirm package contents:
   - `npm pack --dry-run`
4. Confirm target version is not already published:
   - `npm view agentproxy version`
5. Commit and push the version bump to `main`.
6. Create and push a release tag:
   - `git tag vX.Y.Z`
   - `git push origin vX.Y.Z`

## GitHub Actions Publish Flow

The workflow in `.github/workflows/publish.yml` publishes automatically on:

- `push` tags matching `v*`
- Manual `workflow_dispatch`

Publish step:

- `npm publish --access public`

If you need a non-publish validation run, execute the same build/test steps locally and use `npm pack --dry-run`.

## GitHub Container Registry

Publish the Docker image to GHCR:

```bash
GHCR_TOKEN=ghp_xxx npm run docker:publish
```

The deployment script tags images as:

- `ghcr.io/<owner>/<repo>:<package.json version>`
- `ghcr.io/<owner>/<repo>:sha-<git sha>`
- `ghcr.io/<owner>/<repo>:latest`

Preview without Docker or credentials:

```bash
scripts/deploy-ghcr.sh --dry-run --image ghcr.io/example/agentproxy --tag test
```

## Dist Tags (Optional)

Use dist-tags for pre-releases instead of publishing a rapid stream of patch versions:
- `latest`: stable releases
- `beta`: pre-release channel (for example `2.2.0-beta.1`)
