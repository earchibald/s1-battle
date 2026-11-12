import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bettingRouter } from "./betting";
import { decide, getStats, jevConfigured, jevModel } from "./jev";
import type { BotSense } from "../shared/bots/common";
import type { BotKind } from "../shared/types";
import { BOT_KINDS } from "../shared/types";

const PORT = Number(process.env.PORT ?? 8787);
const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, jev: jevConfigured, model: jevModel });
});

app.get("/api/stats", (_req, res) => {
  res.json(getStats());
});

/** One bot, one moment, one Jev request. Body: { kind, sense: { perception, facts }, build? }. */
app.post("/api/decide", async (req, res) => {
  const body = req.body as { kind?: BotKind; sense?: BotSense; build?: unknown };
  if (!body?.kind || !BOT_KINDS.includes(body.kind) || !body.sense?.perception || !body.sense?.facts) {
    res.status(400).json({ ok: false, error: "expected { kind, sense: { perception, facts }, build? }" });
    return;
  }
  const result = await decide(body.kind, body.sense, body.build);
  res.status(result.ok ? 200 : (result.status ?? 502)).json(result);
});

/** Season betting: the house, wallets and markets (server/betting.ts). */
app.use("/api/bet", bettingRouter());

if (process.env.NODE_ENV === "production") {
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}  jev=${jevConfigured ? jevModel : "NOT CONFIGURED (baseline only)"}`);
});
