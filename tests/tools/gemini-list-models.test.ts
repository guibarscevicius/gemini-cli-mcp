import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ZodError } from "zod";
import {
  geminiListModels,
  geminiListModelsToolDefinition,
} from "../../src/tools/gemini-list-models.js";

describe("gemini-list-models", () => {
  let originalModels: string | undefined;

  beforeEach(() => {
    originalModels = process.env.GEMINI_MODELS;
    delete process.env.GEMINI_MODELS;
  });

  afterEach(() => {
    if (originalModels !== undefined) {
      process.env.GEMINI_MODELS = originalModels;
    } else {
      delete process.env.GEMINI_MODELS;
    }
  });

  describe("default curated list", () => {
    it("returns all default models with correct structure", async () => {
      const result = await geminiListModels({});
      expect(result.source).toBe("curated");
      expect(result.total).toBe(9);
      expect(result.models).toHaveLength(9);

      for (const model of result.models) {
        expect(model).toHaveProperty("id");
        expect(model).toHaveProperty("description");
        expect(model).toHaveProperty("tier");
        expect(model).toHaveProperty("notes");
        expect(["fast", "balanced", "deep"]).toContain(model.tier);
      }
    });

    it("includes the expected model IDs", async () => {
      const result = await geminiListModels({});
      const ids = result.models.map((m) => m.id);
      expect(ids).toContain("gemini-3.1-pro-preview");
      expect(ids).toContain("gemini-3-flash-preview");
      expect(ids).toContain("gemini-3.1-flash-lite-preview");
      expect(ids).toContain("gemini-2.5-pro");
      expect(ids).toContain("gemini-2.5-flash");
      expect(ids).toContain("gemini-2.5-flash-lite");
      expect(ids).toContain("gemini-3-pro-preview");
      expect(ids).toContain("gemini-2.0-flash");
      expect(ids).toContain("gemini-2.0-flash-lite");
    });
  });

  describe("filter", () => {
    it("filters by substring match on model ID", async () => {
      const result = await geminiListModels({ filter: "flash" });
      expect(result.total).toBe(6);
      expect(result.models.every((m) => m.id.includes("flash"))).toBe(true);
    });

    it("filters case-insensitively", async () => {
      const result = await geminiListModels({ filter: "PRO" });
      expect(result.total).toBe(3);
      expect(result.models.every((m) => m.id.includes("pro"))).toBe(true);
    });

    it("returns empty array when filter matches nothing", async () => {
      const result = await geminiListModels({ filter: "nonexistent" });
      expect(result.models).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.source).toBe("curated");
    });
  });

  describe("GEMINI_MODELS env override", () => {
    it("returns custom models when env is set", async () => {
      process.env.GEMINI_MODELS = "custom-model-a,custom-model-b";
      const result = await geminiListModels({});

      expect(result.source).toBe("custom");
      expect(result.total).toBe(2);
      expect(result.models[0].id).toBe("custom-model-a");
      expect(result.models[1].id).toBe("custom-model-b");
      expect(result.models[0].tier).toBe("balanced");
      expect(result.models[0].description).toBe("Custom model");
    });

    it("trims whitespace from custom model IDs", async () => {
      process.env.GEMINI_MODELS = " model-a , model-b ";
      const result = await geminiListModels({});
      expect(result.models[0].id).toBe("model-a");
      expect(result.models[1].id).toBe("model-b");
    });

    it("ignores empty segments in GEMINI_MODELS", async () => {
      process.env.GEMINI_MODELS = "model-a,,model-b,";
      const result = await geminiListModels({});
      expect(result.total).toBe(2);
    });

    it("combines custom models with filter", async () => {
      process.env.GEMINI_MODELS = "alpha-fast,beta-slow,gamma-fast";
      const result = await geminiListModels({ filter: "fast" });
      expect(result.total).toBe(2);
      expect(result.source).toBe("custom");
      expect(result.models.map((m) => m.id)).toEqual([
        "alpha-fast",
        "gamma-fast",
      ]);
    });
  });

  describe("input validation", () => {
    it("accepts undefined input", async () => {
      const result = await geminiListModels(undefined);
      expect(result.total).toBe(9);
    });

    it("accepts empty object", async () => {
      const result = await geminiListModels({});
      expect(result.total).toBe(9);
    });

    it("rejects non-string filter", async () => {
      await expect(
        geminiListModels({ filter: 123 })
      ).rejects.toThrow(ZodError);
    });
  });

  describe("tool definition", () => {
    it("has correct name and title", () => {
      expect(geminiListModelsToolDefinition.name).toBe("gemini-list-models");
      expect(geminiListModelsToolDefinition.title).toBe("List Gemini Models");
    });

    it("has correct annotations", () => {
      expect(geminiListModelsToolDefinition.annotations).toEqual({
        title: "List Gemini Models",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    });

    it("has outputSchema with expected required fields", () => {
      expect(geminiListModelsToolDefinition.outputSchema).toBeDefined();
      expect(
        (geminiListModelsToolDefinition.outputSchema as { required: string[] })
          .required
      ).toEqual(["models", "total", "source"]);
    });
  });
});
