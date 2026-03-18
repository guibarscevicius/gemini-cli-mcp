import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const GeminiListModelsSchema = z
  .object({
    filter: z
      .string()
      .optional()
      .describe(
        "Optional substring filter on model ID (case-insensitive). Example: 'flash' returns only models with 'flash' in the ID."
      ),
  })
  .optional();

export interface ModelInfo {
  id: string;
  description: string;
  tier: "fast" | "balanced" | "deep";
  notes: string | null;
}

export interface GeminiListModelsOutput {
  models: ModelInfo[];
  total: number;
  source: "curated" | "custom";
}

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: "gemini-3-flash-preview",
    description: "Fast, high-quality general purpose model (default)",
    tier: "fast",
    notes: null,
  },
  {
    id: "gemini-2.5-flash",
    description: "Fast model with strong coding and reasoning",
    tier: "fast",
    notes: null,
  },
  {
    id: "gemini-2.5-pro",
    description: "Deep reasoning model for complex tasks",
    tier: "deep",
    notes: "slow ~60s response time",
  },
  {
    id: "gemini-3-pro-preview",
    description: "Advanced reasoning with broad capabilities",
    tier: "balanced",
    notes: null,
  },
  {
    id: "gemini-3.1-pro-preview",
    description: "Deep reasoning with ARC-AGI-2 and GPQA strength",
    tier: "deep",
    notes: "may not be available on all plans",
  },
  {
    id: "gemini-3.1-flash-lite",
    description: "Cost-efficient lightweight model",
    tier: "fast",
    notes: "may not be available on all plans",
  },
];

function parseCustomModels(raw: string): ModelInfo[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => ({
      id,
      description: "Custom model",
      tier: "balanced" as const,
      notes: null,
    }));
}

export async function geminiListModels(
  input: unknown
): Promise<GeminiListModelsOutput> {
  const parsed = GeminiListModelsSchema.parse(input);
  const filter = parsed?.filter?.toLowerCase();

  const customEnv = process.env.GEMINI_MODELS;
  const source: "curated" | "custom" = customEnv ? "custom" : "curated";
  const allModels = customEnv ? parseCustomModels(customEnv) : DEFAULT_MODELS;

  const models = filter
    ? allModels.filter((m) => m.id.toLowerCase().includes(filter))
    : allModels;

  return { models, total: models.length, source };
}

export const geminiListModelsToolDefinition: Tool = {
  name: "gemini-list-models",
  title: "List Gemini Models",
  description:
    "Return the list of available Gemini models with tier, description, and notes. " +
    "Uses a curated default list; override with GEMINI_MODELS env var (comma-separated IDs). " +
    "Optionally filter by substring match on model ID.",
  inputSchema: {
    type: "object" as const,
    properties: {
      filter: {
        type: "string",
        description:
          "Optional substring filter on model ID (case-insensitive). Example: 'flash' returns only models with 'flash' in the ID.",
      },
    },
    required: [],
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      models: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            description: { type: "string" },
            tier: { type: "string", enum: ["fast", "balanced", "deep"] },
            notes: { type: ["string", "null"] },
          },
          required: ["id", "description", "tier", "notes"],
        },
      },
      total: { type: "number" },
      source: { type: "string", enum: ["curated", "custom"] },
    },
    required: ["models", "total", "source"],
  },
  annotations: {
    title: "List Gemini Models",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};
