import { describe, it, expect } from "vitest";
import { askGeminiToolDefinition } from "../src/tools/ask-gemini.js";
import { geminiReplyToolDefinition } from "../src/tools/gemini-reply.js";
import { geminiPollToolDefinition } from "../src/tools/gemini-poll.js";
import { geminiCancelToolDefinition } from "../src/tools/gemini-cancel.js";

describe("tool annotations", () => {
  it("all 4 tools have annotations defined", () => {
    expect(askGeminiToolDefinition.annotations).toBeDefined();
    expect(geminiReplyToolDefinition.annotations).toBeDefined();
    expect(geminiPollToolDefinition.annotations).toBeDefined();
    expect(geminiCancelToolDefinition.annotations).toBeDefined();
  });

  describe("ask-gemini", () => {
    it("has correct top-level title", () => {
      expect(askGeminiToolDefinition.title).toBe("Ask Gemini");
    });

    it("has correct annotations", () => {
      expect(askGeminiToolDefinition.annotations).toEqual({
        title: "Ask Gemini",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
    });
  });

  describe("gemini-reply", () => {
    it("has correct top-level title", () => {
      expect(geminiReplyToolDefinition.title).toBe("Continue Gemini Session");
    });

    it("has correct annotations", () => {
      expect(geminiReplyToolDefinition.annotations).toEqual({
        title: "Continue Gemini Session",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
    });
  });

  describe("gemini-poll", () => {
    it("has correct top-level title", () => {
      expect(geminiPollToolDefinition.title).toBe("Poll Gemini Job");
    });

    it("has correct annotations", () => {
      expect(geminiPollToolDefinition.annotations).toEqual({
        title: "Poll Gemini Job",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    });
  });

  describe("gemini-cancel", () => {
    it("has correct top-level title", () => {
      expect(geminiCancelToolDefinition.title).toBe("Cancel Gemini Job");
    });

    it("has correct annotations", () => {
      expect(geminiCancelToolDefinition.annotations).toEqual({
        title: "Cancel Gemini Job",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    });
  });
});
