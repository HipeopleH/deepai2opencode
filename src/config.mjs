// DeepAI Code lane fingerprint constants. Values are byte-for-byte what the
// shipped client sends; changing any of them changes what the lane sees.
export const LANE_VERSION = "7";
export const APP_VERSION = "0.3.50";
export const CONTROL_ORIGIN = "https://api.deepai.org";
export const MODEL_PREFIX = "/deepai_code";

// Transport policy mirrored from the client: one metered turn at a time,
// 330s max silence, 930s max wall clock.
export const IDLE_TIMEOUT_MS = 330_000;
export const TOTAL_TIMEOUT_MS = 930_000;
export const MAX_BODY_BYTES = 33_554_432;
export const CAPACITY_RETRY_MIN_MS = 1_000;
export const CAPACITY_RETRY_MAX_MS = 30_000;

// Shipped with the client as the offline fallback catalog.
export const BUNDLED_MODELS = [
  {
    id: "glm-5.3-flash",
    name: "GLM 5.3 Flash",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
  },
];
