export interface ModelInfo {
  id: string;
  description: string;
  tier: "fast" | "balanced" | "deep";
  notes: string | null;
}

export interface ModelsResourcePayload {
  models: ModelInfo[];
  total: number;
  source: "curated" | "custom";
}

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: "gemini-3-pro-preview",
    description: "Most capable Gemini 3 preview model for deep reasoning and agentic work",
    tier: "deep",
    notes: null,
  },
  {
    id: "gemini-3-flash-preview",
    description: "Fast frontier-class performance at low cost (default)",
    tier: "fast",
    notes: "default",
  },
  {
    id: "gemini-3.1-pro-preview",
    description: "Rolling out preview upgrade over Gemini 3 Pro for eligible users",
    tier: "deep",
    notes: "limited rollout",
  },
  {
    id: "gemini-2.5-pro",
    description: "Stable pro model for complex reasoning when Gemini 3 preview is unavailable",
    tier: "deep",
    notes: null,
  },
  {
    id: "gemini-2.5-flash",
    description: "Balanced fast model with strong coding and reasoning",
    tier: "balanced",
    notes: null,
  },
  {
    id: "gemini-2.5-flash-lite",
    description: "Lowest-cost high-throughput model for simple or parallel tasks",
    tier: "fast",
    notes: null,
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

/**
 * Build the JSON payload for the `gemini://models` resource. Honors GEMINI_MODELS
 * (comma-separated list) as an override; otherwise returns the curated default list.
 */
export function getModelsPayload(): ModelsResourcePayload {
  const customEnv = process.env.GEMINI_MODELS;
  const source: "curated" | "custom" = customEnv ? "custom" : "curated";
  const models = customEnv ? parseCustomModels(customEnv) : DEFAULT_MODELS;
  return { models, total: models.length, source };
}
