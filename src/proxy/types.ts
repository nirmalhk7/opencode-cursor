export interface ProxyConfig {
  port?: number;
  host?: string;
  healthCheckPath?: string;
  requestTimeout?: number;
  workspaceDirectory?: string;
  cursorAgentPath?: string;
}

export interface ProxyServer {
  start(): Promise<string>;
  stop(): Promise<void>;
  getBaseURL(): string;
  getPort(): number | null;
}
