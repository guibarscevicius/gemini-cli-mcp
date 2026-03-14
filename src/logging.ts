import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { LoggingLevel } from "@modelcontextprotocol/sdk/types.js";

// RFC 5424: lower number = higher severity
const SEVERITY: Record<LoggingLevel, number> = {
  emergency: 0,
  alert: 1,
  critical: 2,
  error: 3,
  warning: 4,
  notice: 5,
  info: 6,
  debug: 7,
};

let _server: Server | null = null;
let _minLevel: LoggingLevel = "debug";

export function initMcpLogger(server: Server): void {
  _server = server;
}

export function setMcpLogLevel(level: LoggingLevel): void {
  _minLevel = level;
}

export function mcpLog(level: LoggingLevel, logger: string, data: unknown): void {
  if (!_server || SEVERITY[level] > SEVERITY[_minLevel]) return;
  _server.sendLoggingMessage({ level, logger, data }).catch(() => {});
}

// For test isolation only:
export function _resetMcpLogger(): void {
  _server = null;
  _minLevel = "debug";
}
