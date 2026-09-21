/**
 * geminiKeyRotator.js
 * Multi-API-Key Pool, Round-Robin Load Balancer & Failover Manager for Google Gemini
 * 
 * Capabilities:
 * 1. Collects keys from GEMINI_API_KEYS (comma-separated), GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3, etc.
 * 2. Distributes incoming requests round-robin across healthy keys to maximize quota efficiency.
 * 3. Automatically fails over to the next key if a key encounters:
 *    - 429 RESOURCE_EXHAUSTED / Quota limit exceeded / Rate limit
 *    - 503 UNAVAILABLE / High demand spike
 *    - Connection/Network timeouts
 * 4. Zero dummy responses: if all keys fail or no keys configured, returns honest AI_UNAVAILABLE.
 */

let currentKeyIndex = 0;

/**
 * Returns an array of valid, non-placeholder Gemini API keys from the environment.
 * @returns {string[]}
 */
export function getGeminiApiKeys() {
  const keys = [];

  // Check comma-separated list: GEMINI_API_KEYS=key1,key2,key3
  if (process.env.GEMINI_API_KEYS) {
    const split = process.env.GEMINI_API_KEYS.split(",");
    for (const raw of split) {
      const k = (raw || "").trim();
      if (k && k !== "your_gemini_api_key_here" && !keys.includes(k)) {
        keys.push(k);
      }
    }
  }

  // Check indexed environment variables: GEMINI_API_KEY, GEMINI_API_KEY_1, GEMINI_API_KEY_2, GEMINI_API_KEY_3, GEMINI_API_KEY_4, GEMINI_API_KEY_5
  const indexedEnvVars = [
    "GEMINI_API_KEY",
    "GEMINI_API_KEY_1",
    "GEMINI_API_KEY_2",
    "GEMINI_API_KEY_3",
    "GEMINI_API_KEY_4",
    "GEMINI_API_KEY_5"
  ];

  for (const envVar of indexedEnvVars) {
    const val = (process.env[envVar] || "").trim();
    if (val && val !== "your_gemini_api_key_here" && !keys.includes(val)) {
      keys.push(val);
    }
  }

  return keys;
}

/**
 * Executes an operation with automatic multi-key failover and round-robin load distribution.
 * 
 * @template T
 * @param {(apiKey: string, keyIndex: number, totalKeys: number) => Promise<T>} operationFn
 * @param {object} [options]
 * @param {string[]} [options.explicitKeys] Optional array of keys to use instead of reading process.env
 * @returns {Promise<T>}
 */
export async function executeWithGeminiKeyFailover(operationFn, options = {}) {
  const keys = Array.isArray(options)
    ? options
    : (options.explicitKeys && options.explicitKeys.length > 0 ? options.explicitKeys : getGeminiApiKeys());

  if (keys.length === 0) {
    const err = new Error("AI_UNAVAILABLE: No valid Gemini API keys configured. Set GEMINI_API_KEY, GEMINI_API_KEY_2, or GEMINI_API_KEYS in .env");
    err.code = "AI_UNAVAILABLE";
    throw err;
  }

  const totalKeys = keys.length;
  const startIndex = currentKeyIndex % totalKeys;
  // Advance index for next call so requests are distributed round-robin across keys
  currentKeyIndex = (currentKeyIndex + 1) % totalKeys;

  let lastError = null;

  // Try each key once starting from startIndex
  for (let offset = 0; offset < totalKeys; offset++) {
    const keyIdx = (startIndex + offset) % totalKeys;
    const activeKey = keys[keyIdx];

    try {
      const result = await operationFn(activeKey, keyIdx, totalKeys);
      return result;
    } catch (err) {
      lastError = err;
      const isQuotaOrRateLimit = err.status === 429 || 
        err.message?.includes("429") || 
        err.message?.includes("quota") || 
        err.message?.includes("RESOURCE_EXHAUSTED") ||
        err.message?.includes("rate limit");
        
      const isTransientSpike = err.status === 503 || 
        err.message?.includes("503") || 
        err.message?.includes("high demand") || 
        err.message?.includes("temporary");

      const maskedKey = `${activeKey.slice(0, 6)}...${activeKey.slice(-4)}`;

      if ((isQuotaOrRateLimit || isTransientSpike) && totalKeys > 1 && offset < totalKeys - 1) {
        console.warn(`[GeminiKeyRotator] Key ${keyIdx + 1}/${totalKeys} (${maskedKey}) hit ${isQuotaOrRateLimit ? "quota limit (429)" : "high demand spike (503)"}. Failing over to next key in pool...`);
        continue;
      }

      // If it's a non-retryable error (e.g. fatal validation error), don't blindly loop through all keys unless it might be key-specific
      if (!isQuotaOrRateLimit && !isTransientSpike && !err.message?.includes("API key")) {
        throw err;
      }
    }
  }

  // All keys exhausted
  if (lastError) {
    if (!lastError.code) {
      lastError.code = "AI_UNAVAILABLE";
    }
    throw lastError;
  }

  const fallbackErr = new Error("AI_UNAVAILABLE: All configured Gemini API keys were exhausted or unavailable");
  fallbackErr.code = "AI_UNAVAILABLE";
  throw fallbackErr;
}

export function resetRotatorState() {
  currentKeyIndex = 0;
}
