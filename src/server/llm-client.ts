import { loadConfig, requireKey } from "./config";

// Minimal client for the Meta Model API (OpenAI-compatible, plain HTTP).
// P2 adds the variant / ranking / fallback calls on top of this.

export interface LlmClient {
  baseUrl: string;
  apiKey: string;
  textModel: string;
}

export function createLlmClient(): LlmClient {
  const config = loadConfig();
  return {
    baseUrl: config.metaBaseUrl,
    apiKey: requireKey(config.modelApiKey, "MODEL_API_KEY"),
    textModel: config.textModel,
  };
}

export function authHeaders(client: Pick<LlmClient, "apiKey">): Record<string, string> {
  return {
    Authorization: `Bearer ${client.apiKey}`,
    "Content-Type": "application/json",
  };
}
