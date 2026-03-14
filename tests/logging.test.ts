import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetMcpLogger,
  initMcpLogger,
  mcpLog,
  setMcpLogLevel,
} from "../src/logging.js";

type LoggerServer = Parameters<typeof initMcpLogger>[0];

function makeMockServer() {
  return {
    sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe("mcp logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetMcpLogger();
  });

  it("stores server reference and sends notifications/message logs", () => {
    const server = makeMockServer();
    initMcpLogger(server as unknown as LoggerServer);

    mcpLog("info", "tools", { event: "x" });

    expect(server.sendLoggingMessage).toHaveBeenCalledWith({
      level: "info",
      logger: "tools",
      data: { event: "x" },
    });
  });

  it("swallows sendLoggingMessage rejections", async () => {
    const server = {
      sendLoggingMessage: vi.fn().mockRejectedValue(new Error("boom")),
    };
    initMcpLogger(server as unknown as LoggerServer);

    expect(() => mcpLog("error", "tests", { event: "x" })).not.toThrow();
    await Promise.resolve();
  });

  it("suppresses info when min level is warning", () => {
    const server = makeMockServer();
    initMcpLogger(server as unknown as LoggerServer);
    setMcpLogLevel("warning");

    mcpLog("info", "tests", { event: "suppressed" });

    expect(server.sendLoggingMessage).not.toHaveBeenCalled();
  });

  it("suppresses debug when min level is error", () => {
    const server = makeMockServer();
    initMcpLogger(server as unknown as LoggerServer);
    setMcpLogLevel("error");

    mcpLog("debug", "tests", { event: "suppressed" });

    expect(server.sendLoggingMessage).not.toHaveBeenCalled();
  });

  it("allows error when min level is warning", () => {
    const server = makeMockServer();
    initMcpLogger(server as unknown as LoggerServer);
    setMcpLogLevel("warning");

    mcpLog("error", "tests", { event: "allowed" });

    expect(server.sendLoggingMessage).toHaveBeenCalledTimes(1);
  });

  it("reset clears server state", () => {
    const server = makeMockServer();
    initMcpLogger(server as unknown as LoggerServer);
    _resetMcpLogger();

    mcpLog("error", "tests", { event: "ignored" });

    expect(server.sendLoggingMessage).not.toHaveBeenCalled();
  });

  it("setMcpLogLevel updates filtering", () => {
    const server = makeMockServer();
    initMcpLogger(server as unknown as LoggerServer);
    setMcpLogLevel("error");
    mcpLog("warning", "tests", { event: "suppressed" });
    setMcpLogLevel("debug");
    mcpLog("warning", "tests", { event: "allowed" });

    expect(server.sendLoggingMessage).toHaveBeenCalledTimes(1);
    expect(server.sendLoggingMessage).toHaveBeenLastCalledWith({
      level: "warning",
      logger: "tests",
      data: { event: "allowed" },
    });
  });
});
