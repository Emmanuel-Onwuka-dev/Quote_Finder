// Server-only configuration. Browser code must never import this module.

export interface ServerConfig {
  modelApiKey: string;
  metaBaseUrl: string;
  youtubeApiKey: string;
  textModel: string;
  transcriptionModel: string;
  imageModel: string;
  openModelUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  archiveTokenKey: string;
  archiveDbPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    modelApiKey: env.MODEL_API_KEY ?? "",
    metaBaseUrl: env.META_BASE_URL ?? "https://api.meta.ai/v1",
    youtubeApiKey: env.YOUTUBE_API_KEY ?? "",
    textModel: env.TEXT_MODEL ?? "muse-spark-1.3",
    transcriptionModel:
      env.TRANSCRIPTION_MODEL ?? "muse-voice-transcribe-1.0",
    imageModel: env.IMAGE_MODEL ?? "muse-image-1.0",
    openModelUrl: env.OPEN_MODEL_URL ?? "",
    googleClientId: env.GOOGLE_CLIENT_ID ?? "",
    googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
    googleRedirectUri: env.GOOGLE_REDIRECT_URI ?? "",
    archiveTokenKey: env.ARCHIVE_TOKEN_KEY ?? "",
    archiveDbPath: env.ARCHIVE_DB_PATH ?? "./archive.db",
  };
}

export function requireKey(value: string, name: string): string {
  if (!value) {
    throw new Error(
      `Missing server env ${name}. Set it in .env (local dev) or the platform secret store — never in chat or source.`,
    );
  }
  return value;
}
