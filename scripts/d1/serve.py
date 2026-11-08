"""
Local stand-in for TypeSafe's POST /v1/systemone, backed by a Liquid d1 decision model on MLX.

Answers are reshaped into Jev's wire format, so the unchanged @typesafe-ai/sdk works against it with
TYPESAFE_BASE_URL=http://127.0.0.1:8091. Single-threaded on purpose: MLX evaluation is not thread-safe and a
decision takes a few milliseconds, so requests simply queue.

    python scripts/d1/serve.py [--model LiquidAI/d1-omni-600M-MLX-fp16] [--port 8091]
"""
import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import zstandard
from mlx_vlm import load, predict


def to_jev(answer: dict) -> dict:
    kind = answer.get("type")
    if kind in ("bool", "noul"):
        return {"type": "noul", "noul": answer["probability"]}
    if kind == "choice":
        return {
            "type": "choice",
            "choice": answer["value"],
            "confidence": answer.get("metadata", {}).get("confidence", max(answer["probabilities"].values())),
            "probabilities": answer["probabilities"],
        }
    if kind == "score":
        return {
            "type": "score",
            "score": answer["value"],
            "confidence": answer.get("metadata", {}).get("confidence"),
            "probabilities": answer["probabilities"],
            "legend": answer.get("legend"),
        }
    return answer


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="LiquidAI/d1-omni-600M-MLX-fp16")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8091)
    args = ap.parse_args()

    model, processor = load(args.model)
    name = args.model.split("/")[-1]
    # Warm up: the first forward pass compiles kernels and costs ~1.5 s.
    predict(model, processor, {"warm": "up"}, {"q": {"type": "noul", "instructions": "Is this a warmup?"}})

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/v1/models":
                self.send(200, {"models": [{"id": name}]})
            elif self.path == "/health":
                self.send(200, {"ok": True, "model": name})
            else:
                self.send(404, {"error": {"message": "not found"}})

        def do_POST(self):
            if self.path != "/v1/systemone":
                return self.send(404, {"error": {"message": "not found"}})
            try:
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                # The TypeSafe SDK zstd-compresses request bodies when the runtime supports it.
                if self.headers.get("Content-Encoding") == "zstd":
                    raw = zstandard.ZstdDecompressor().decompressobj().decompress(raw)
                req = json.loads(raw)
                t0 = time.perf_counter()
                res = predict(model, processor, req.get("state"), req["questions"])
                ms = (time.perf_counter() - t0) * 1000
                self.send(200, {
                    "model": name,
                    "answers": {k: to_jev(v) for k, v in res["answers"].items()},
                    "usage": res.get("usage", {}),
                    "server_ms": round(ms, 2),
                })
            except Exception as e:  # surface as an API error so the SDK falls back cleanly
                self.send(400, {"error": {"message": f"{type(e).__name__}: {e}"}})

    print(f"d1 systemone server: {name} on http://{args.host}:{args.port}", flush=True)
    HTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
