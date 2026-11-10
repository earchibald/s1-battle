/**
 * A worker-thread pool that plays match pairs in parallel. Workers keep their loaded networks between jobs.
 * One pair is ~80 ms on one core, so 14 workers play ~170 pairs (340 matches) a second.
 */
import { cpus } from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { playPair, type Builds, type ContenderSpec, type PairResult } from "./arena";

interface Job {
  id: number;
  a: ContenderSpec;
  b: ContenderSpec;
  seeds: number[];
  builds: Builds;
}

if (!isMainThread && (workerData as { leaguePool?: boolean } | null)?.leaguePool) {
  parentPort!.on("message", (job: Job) => {
    const out = job.seeds.map((s) => playPair(job.a, job.b, s, job.builds));
    parentPort!.postMessage({ id: job.id, out });
  });
}

export class Pool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { job: Job; resolve: (r: PairResult[]) => void; reject: (e: unknown) => void }[] = [];
  private waiting = new Map<number, { resolve: (r: PairResult[]) => void; reject: (e: unknown) => void }>();
  private nextId = 1;

  constructor(readonly size = Math.max(1, cpus().length - 4)) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL(import.meta.url), { workerData: { leaguePool: true } });
      w.on("message", (m: { id: number; out: PairResult[] }) => {
        this.waiting.get(m.id)?.resolve(m.out);
        this.waiting.delete(m.id);
        this.idle.push(w);
        this.pump();
      });
      w.on("error", (e) => {
        for (const p of this.waiting.values()) p.reject(e);
        this.waiting.clear();
      });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const q = this.queue.shift()!;
      this.waiting.set(q.job.id, q);
      w.postMessage(q.job);
    }
  }

  /** Plays one pair per seed, split into chunks across the workers; results come back in seed order. */
  async run(a: ContenderSpec, b: ContenderSpec, seeds: number[], builds: Builds, chunk = 8): Promise<PairResult[]> {
    const parts: Promise<PairResult[]>[] = [];
    for (let i = 0; i < seeds.length; i += chunk) {
      const job: Job = { id: this.nextId++, a, b, seeds: seeds.slice(i, i + chunk), builds };
      parts.push(new Promise((resolve, reject) => this.queue.push({ job, resolve, reject })));
    }
    this.pump();
    return (await Promise.all(parts)).flat();
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
