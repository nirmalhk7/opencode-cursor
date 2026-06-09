import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readText = (path) => readFileSync(path, "utf8");
const readJson = (path) => JSON.parse(readText(path));

test("package metadata is branded as agentproxy", () => {
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");

  assert.equal(packageJson.name, "agentproxy");
  assert.deepEqual(packageJson.bin, { agentproxy: "dist/server/main.js" });
  assert.equal(packageLock.name, "agentproxy");
  assert.equal(packageLock.packages[""].name, "agentproxy");
  assert.deepEqual(packageLock.packages[""].bin, { agentproxy: "dist/server/main.js" });
});

test("README documents current agentproxy commands and auth flow", () => {
  const readme = readText("README.md");

  assert.match(readme, /^# agentproxy/m);
  assert.match(readme, /agentproxy --port 32124/);
  assert.match(readme, /directory\/project context should be managed at the OpenClaw layer/);
  assert.match(readme, /only forwards `--workspace`/);
  assert.match(readme, /ghcr\.io\/acme\/agentproxy/);
  assert.match(readme, /agentproxy-auth/);
  assert.doesNotMatch(readme, /open-cursor/);
});

test("Docker packaging uses the agentproxy entrypoint", () => {
  const dockerfile = readText("Dockerfile");
  const entrypoint = readText("docker-entrypoint.sh");
  const deployScript = readText("scripts/deploy-ghcr.sh");

  assert.match(dockerfile, /agentproxy-entrypoint/);
  assert.match(entrypoint, /node dist\/server\/main\.js/);
  assert.match(deployScript, /ghcr\.io\/acme\/agentproxy/);
  assert.doesNotMatch(dockerfile, /open-cursor-entrypoint/);
});

test("AGENTS.md documents active service boundaries", () => {
  const agents = readText("AGENTS.md");

  assert.match(agents, /^# Agent instructions for agentproxy/m);
  assert.match(agents, /OpenAI\/OpenClaw compatibility/);
  assert.match(agents, /npm test/);
  assert.match(agents, /legacy context/);
});

test("documentation index and publishing docs point at current workflows", () => {
  const docsIndex = readText("docs/README.md");
  const publishing = readText("docs/PUBLISHING.md");
  const releaseNotes = readText("docs/RELEASE_NOTES.md");

  assert.match(docsIndex, /Current agentproxy docs/);
  assert.match(docsIndex, /Historical docs/);
  assert.match(publishing, /^# Publishing `agentproxy`/m);
  assert.match(publishing, /npm test/);
  assert.match(publishing, /ghcr\.io\/example\/agentproxy/);
  assert.match(releaseNotes, /agentproxy - OpenAI-compatible Cursor service/);
});

test("GitHub workflows run the active Node validation path", () => {
  const ci = readText(".github/workflows/ci.yml");
  const publish = readText(".github/workflows/publish.yml");
  const docker = readText(".github/workflows/docker.yml");

  assert.match(ci, /npm ci/);
  assert.match(ci, /npm test/);
  assert.match(ci, /bash -n scripts\/deploy-ghcr\.sh/);
  assert.match(publish, /npm ci/);
  assert.match(publish, /npm test/);
  assert.doesNotMatch(ci, /bun run/);
  assert.doesNotMatch(publish, /bun run/);
  assert.match(docker, /docker\/build-push-action/);
  assert.match(docker, /cursor-agent --version/);
  assert.match(docker, /\/health/);
});

test("Dockerfile stages agentproxy and cursor-agent separately", () => {
  const dockerfile = readText("Dockerfile");

  assert.match(dockerfile, /AS deps/);
  assert.match(dockerfile, /AS build/);
  assert.match(dockerfile, /AS cursor-agent/);
  assert.match(dockerfile, /AS runtime/);
  assert.match(dockerfile, /COPY --from=cursor-agent/);
  assert.match(dockerfile, /CURSOR_INSTALL_URL/);
});
