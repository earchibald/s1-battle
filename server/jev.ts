import { TypeSafeClient, APIError, RateLimitError } from "@typesafe-ai/sdk";
import type { BotSense } from "../shared/bots/common";
import type { BotBuild } from "../shared/build";
import { normalizeBuild } from "../shared/build";
import { stockBuild } from "../shared/bots/index";
import { buildQuestions } from "../shared/logic";
import type { BotKind, DecideError, DecideResponse, JevAnswer } from "../shared/types";

/**
 * Jev integration. One request per bot decision, every question fanned out together:
 * target (Choice), maneuver (Choice), in_danger (Noul) plus any kind-specific speculative Nouls.
 * The semantic Perception is the only thing Jev sees; Facts stay on our side for validation.
 */

const MODEL = process.env.JEV_MODEL ?? "jev-latest";
const hasKey = Boolean(process.env.TYPESAFE_API_KEY);

const client = hasKey
  ? new TypeSafeClient({
      defaultModel: MODEL,
      // Realtime: a slow answer is worth less than a fresh baseline decision, so keep retries short.
      timeout: 2500,
      retry: { maxRetries: 1, backoffInitialMs: 150, backoffMaxMs: 400 },
    })
  : null;

export const jevConfigured = hasKey;
export const jevModel = MODEL;

export interface JevStats {
  requests: number;
  errors: number;
  rateLimited: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  lastModel: string | null;
}

const latencies: number[] = [];
const stats: JevStats = {
  requests: 0,
  errors: 0,
  rateLimited: 0,
  avgLatencyMs: 0,
  p95LatencyMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  lastModel: null,
};

export function getStats(): JevStats {
  const sorted = latencies.slice().sort((a, b) => a - b);
  stats.avgLatencyMs = sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0;
  stats.p95LatencyMs = sorted.length ? Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0) : 0;
  return { ...stats };
}

/**
 * `rawBuild` is the client's editable build (name, techniques, logic). It is normalized against the stock
 * build for the kind, so a malformed or missing one simply means stock prompts.
 */
export async function decide(kind: BotKind, sense: BotSense, rawBuild?: unknown): Promise<DecideResponse | DecideError> {
  if (!client) return { ok: false, error: "TYPESAFE_API_KEY is not set", status: 503 };
  const build: BotBuild = rawBuild ? normalizeBuild(rawBuild, stockBuild, "request") : stockBuild(kind);
  if (build.kind !== kind) build.kind = kind;
  const questions = buildQuestions(build, sense);

  const t0 = performance.now();
  stats.requests++;
  try {
    const res = await client.systemOne({ state: sense.perception as unknown as Record<string, never>, questions });
    const latencyMs = Math.round(performance.now() - t0);
    latencies.push(latencyMs);
    if (latencies.length > 500) latencies.shift();
    stats.inputTokens += res.usage?.input_tokens ?? 0;
    stats.outputTokens += res.usage?.output_tokens ?? 0;
    stats.lastModel = res.model;
    return {
      ok: true,
      model: res.model,
      latencyMs,
      answers: res.answers as unknown as Record<string, JevAnswer>,
      usage: res.usage ? { input_tokens: res.usage.input_tokens ?? 0, output_tokens: res.usage.output_tokens ?? 0 } : undefined,
    };
  } catch (err) {
    stats.errors++;
    if (err instanceof RateLimitError) stats.rateLimited++;
    const status = err instanceof APIError ? err.status : undefined;
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, status };
  }
}
