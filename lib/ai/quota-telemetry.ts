/**
 * Gemini/Vertex quota telemetry.
 *
 * The shared Google project quota is the real global ceiling on how many
 * products this system can draft at once, and it has never been measured
 * — MAX_BATCH_SIZE's own comment says as much ("that is the real global
 * ceiling and it is not measured yet"). Until it is, every number about
 * capacity is an estimate, and raising CLAIM_LIMIT or the worker fan-out
 * is a guess.
 *
 * Worse, a quota rejection is currently INVISIBLE. callGemini answers any
 * failure by falling through to the next model in PREFERRED_MODELS, so a
 * 429 is logged the same way a deprecated-model 404 is — a truncated
 * console.warn — and if the whole list is exhausted the caller gets
 * "No Gemini model worked", naming everything except the actual cause.
 *
 * This module makes quota pressure countable:
 *   - isQuotaError classifies a rejection as quota/rate-limit rather than
 *     "model unavailable", so the two stop looking identical in the logs.
 *   - trackGeminiCall counts calls and records PEAK CONCURRENCY, which is
 *     the number that actually decides whether the fan-out can go up: 3
 *     workers x CLAIM_LIMIT 3 products x ~4 passes per product is a burst
 *     of roughly 36 simultaneous calls, and nothing has ever confirmed
 *     the project tolerates that.
 *
 * Deliberately NOT short-circuiting the model fallback on a quota error.
 * Vertex quotas are largely per-model-per-region, so a 429 on one model
 * may genuinely be survivable by trying another — and whether that is
 * true here is exactly what this telemetry exists to find out. Measure
 * first, then decide.
 *
 * Counters are per-process and cumulative since cold start. They are NOT
 * reset per request: on a warm Vercel instance several worker invocations
 * share the module, so a per-request reset would race and report
 * nonsense. Cumulative plus peak is robust to that and enough to answer
 * "is this project hitting its ceiling".
 */

let totalCalls   = 0;
let quotaErrors  = 0;
let inFlight     = 0;
let peakInFlight = 0;

/**
 * True when a rejection is the provider refusing on quota/rate grounds,
 * rather than the model being missing, deprecated or misconfigured.
 *
 * Matched on message text because both SDKs surface status this way:
 * Vertex throws "[VertexAI.ClientError] ... got status: 429", AI Studio
 * throws "[GoogleGenerativeAI Error] ... [429 ...] ... RESOURCE_EXHAUSTED".
 * Neither exposes a structured status code on the error object.
 */
export function isQuotaError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return (
    /\b429\b/.test(message) ||
    /RESOURCE_EXHAUSTED/i.test(message) ||
    /\bquota\b/i.test(message) ||
    /rate[ _-]?limit/i.test(message) ||
    /too many requests/i.test(message)
  );
}

/**
 * Wrap one Gemini round-trip so it's counted. Rethrows untouched — this
 * observes, it never changes behaviour.
 */
export async function trackGeminiCall<T>(fn: () => Promise<T>): Promise<T> {
  totalCalls += 1;
  inFlight   += 1;
  if (inFlight > peakInFlight) peakInFlight = inFlight;
  try {
    return await fn();
  } catch (e) {
    if (isQuotaError(e)) quotaErrors += 1;
    throw e;
  } finally {
    inFlight -= 1;
  }
}

export interface GeminiTelemetry {
  /** Calls attempted since this process started. */
  calls:        number;
  /** How many of those were refused on quota/rate grounds. */
  quotaErrors:  number;
  /** Calls in flight right now. */
  inFlight:     number;
  /** Highest simultaneous call count seen since cold start — the number
   *  that decides whether the worker fan-out can safely go up. */
  peakInFlight: number;
}

export function readGeminiTelemetry(): GeminiTelemetry {
  return { calls: totalCalls, quotaErrors, inFlight, peakInFlight };
}
