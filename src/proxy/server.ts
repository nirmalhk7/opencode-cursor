import { execSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { platform } from "node:os";
import type { ProxyConfig, ProxyServer } from "./types.js";
import { createLogger } from "../utils/logger.js";
import { createOpenAiRequestHandler } from "../server/openai.js";

const log = createLogger("proxy-server");

const DEFAULT_PORT = 32124;
const PORT_RANGE_SIZE = 256;

function readHttpServerPort(server: Server | null): number | null {
  const address = server?.address();
  return typeof address === "object" && address ? address.port : null;
}

async function isPortAvailable(port: number, host: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createNetServer();
    server.unref();

    server.once("error", () => {
      resolve(false);
    });

    server.listen({ port, host }, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * Returns the set of ports in [minPort, maxPort) that are currently in use (listening).
 * Uses platform-specific commands:
 * - Linux: `ss -tlnH`
 * - macOS: `lsof -iTCP -sTCP:LISTEN -nP`
 * Falls back to empty set if command is unavailable (e.g., Windows).
 */
function getUsedPortsInRange(minPort: number, maxPort: number): Set<number> {
  const used = new Set<number>();
  const os = platform();

  try {
    let out: string;
    if (os === "linux") {
      out = execSync("ss -tlnH", { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"] });
      // ss output format: State Recv-Q Send-Q Local-Address:Port Peer-Address:Port
      for (const line of out.split("\n")) {
        const cols = line.trim().split(/\s+/);
        const local = cols[3]; // e.g. "127.0.0.1:32124" or "*:22"
        if (!local) continue;
        const portStr = local.includes(":") ? local.slice(local.lastIndexOf(":") + 1) : local;
        const port = parseInt(portStr, 10);
        if (!Number.isNaN(port) && port >= minPort && port < maxPort) used.add(port);
      }
    } else if (os === "darwin") {
      out = execSync("lsof -iTCP -sTCP:LISTEN -nP", { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"] });
      // lsof output: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
      // NAME column contains: *:PORT or 127.0.0.1:PORT
      for (const line of out.split("\n")) {
        const match = line.match(/:(\d+)\s*(?:\(LISTEN\))?$/);
        if (match) {
          const port = parseInt(match[1], 10);
          if (!Number.isNaN(port) && port >= minPort && port < maxPort) used.add(port);
        }
      }
    } else {
      // Windows and other platforms: no port detection available
      // Will fall back to probe-based discovery via tryStart failures
      log.debug(`Port detection not supported on ${os}. Using probe-based discovery.`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.debug(`Port detection failed: ${msg}. Using probe-based discovery.`);
  }
  return used;
}

/**
 * Finds an available port in [DEFAULT_PORT, DEFAULT_PORT + PORT_RANGE_SIZE).
 * Uses platform-specific tools (ss on Linux, lsof on macOS) to check used ports.
 * On unsupported platforms, returns DEFAULT_PORT and relies on tryStart fallback.
 */
export async function findAvailablePort(host = "127.0.0.1"): Promise<number> {
  const minPort = DEFAULT_PORT;
  const maxPort = DEFAULT_PORT + PORT_RANGE_SIZE;
  const used = getUsedPortsInRange(minPort, maxPort);
  for (let p = minPort; p < maxPort; p++) {
    if (used.has(p)) continue;
    if (await isPortAvailable(p, host)) {
      return p;
    }
  }

  // Port listing can be incomplete in sandboxed environments; fall back to probing
  // ports we believe are "used" as well.
  for (let p = minPort; p < maxPort; p++) {
    if (await isPortAvailable(p, host)) {
      return p;
    }
  }
  throw new Error(`No available port in range ${minPort}-${maxPort - 1}`);
}

export function createProxyServer(config: ProxyConfig): ProxyServer {
  const requestedPort = config.port ?? 0;
  const host = config.host ?? "127.0.0.1";

  let server: Server | null = null;
  let baseURL = requestedPort > 0 ? `http://${host}:${requestedPort}/v1` : "";

  const tryStart = (port: number): { success: boolean; error?: Error } => {
    try {
      const nextServer = createHttpServer(createOpenAiRequestHandler({
        workspaceDirectory: config.workspaceDirectory,
        cursorAgentPath: config.cursorAgentPath,
        requestTimeout: config.requestTimeout,
      }));
      nextServer.listen({
        port,
        host,
      });
      server = nextServer;
      return { success: true };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      // Log unexpected errors (not port-in-use)
      const isPortInUse = err.message.includes("EADDRINUSE") ||
                          err.message.includes("address already in use") ||
                          err.message.includes("port is already in use");
      if (!isPortInUse) {
        log.debug(`Unexpected error starting on port ${port}: ${err.message}`);
      }
      return { success: false, error: err };
    }
  };

  return {
    async start(): Promise<string> {
      if (server) {
        return baseURL;
      }

      let port: number;
      if (requestedPort > 0) {
        const result = await listenOnPort(requestedPort);
        if (result.success) {
          port = requestedPort;
        } else {
          log.debug(
            `Requested port ${requestedPort} unavailable: ${result.error?.message ?? "unknown"}. Falling back to automatic port selection.`
          );
          port = await findAvailablePort(host);
          const fallbackResult = await listenOnPort(port);
          if (!fallbackResult.success) {
            throw new Error(
              `Failed to start server on port ${requestedPort} (${result.error?.message ?? "unknown"}) ` +
              `and fallback port ${port} (${fallbackResult.error?.message ?? "unknown"})`
            );
          }
          log.debug(`Server started on fallback port ${port} instead of requested port ${requestedPort}`);
        }
      } else {
        port = await findAvailablePort(host);
        const result = await listenOnPort(port);
        if (!result.success) {
          throw new Error(`Failed to start server on port ${port}: ${result.error?.message ?? "unknown"}`);
        }
      }

      const actualPort = readHttpServerPort(server) ?? port ?? DEFAULT_PORT;
      baseURL = `http://${host}:${actualPort}/v1`;
      return baseURL;
    },

    stop(): Promise<void> {
      if (!server) {
        return Promise.resolve();
      }

      const current = server;
      return new Promise((resolve, reject) => {
        current.close((error) => {
          server = null;
          baseURL = "";
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },

    getBaseURL(): string {
      return baseURL;
    },

    getPort(): number | null {
      return readHttpServerPort(server);
    },
  };

  async function listenOnPort(port: number): Promise<{ success: boolean; error?: Error }> {
    const result = tryStart(port);
    if (!result.success || !server) {
      return result;
    }

    return await new Promise((resolve) => {
      const current = server!;
      const onListening = () => {
        cleanup();
        resolve({ success: true });
      };
      const onError = (error: Error) => {
        cleanup();
        server = null;
        resolve({ success: false, error });
      };
      const cleanup = () => {
        current.off("listening", onListening);
        current.off("error", onError);
      };
      current.once("listening", onListening);
      current.once("error", onError);
    });
  }
}
