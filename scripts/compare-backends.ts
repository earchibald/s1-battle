/**
 * Replay a decision corpus (scripts/dump-corpus.ts) against a System One backend through the real SDK and
 * record each answer and its latency. Point TYPESAFE_BASE_URL at a local d1 server to test it instead of Jev.
 * Usage: npx tsx scripts/compare-backends.ts corpus.jsonl out.jsonl [concurrency]
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { TypeSafeClient } from "@typesafe-ai/sdk";

const [inPath, outPath] = process.argv.slice(2);
const concurrency = Number(process.argv[4] ?? 1);
const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY ?? "local",
  defaultModel: process.env.JEV_MODEL ?? "jev-latest",
  timeout: 10000,
  retry: { maxRetries: 1 },
});
const rows = readFileSync(inPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const out: string[] = new Array(rows.length);
let next = 0;
let errors = 0;

async function worker() {
  while (next < rows.length) {
    const i = next++;
    const r = rows[i];
    const t0 = performance.now();
    try {
      const res = await client.systemOne({ state: r.sense.perception, questions: r.questions });
      out[i] = JSON.stringify({ i, kind: r.kind, ms: performance.now() - t0, model: res.model, answers: res.answers, usage: res.usage });
    } catch (e) {
      errors++;
      out[i] = JSON.stringify({ i, kind: r.kind, ms: performance.now() - t0, error: String(e) });
    }
  }
}
const t0 = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
writeFileSync(outPath, out.join("\n") + "\n");
console.log(`${rows.length} requests, ${errors} errors, ${((performance.now() - t0) / 1000).toFixed(1)}s → ${outPath}`);
