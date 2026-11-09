/**
 * Procedural sound engine. Everything is synthesized with Web Audio, so there are no asset files:
 * saw whine that tracks blade spin, hammer thuds, pneumatic flips, metallic clangs, pit alarm,
 * crowd that swells on big hits, and a few cartoon flourishes (slide whistle into the pit).
 *
 * Browsers only start audio after a user gesture, so `unlock()` is called from the first click/key.
 */

type Ctx = AudioContext;

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export class SoundEngine {
  private ctx: Ctx | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private crowd!: GainNode;
  private crowdSwell!: GainNode;
  private noiseBuf!: AudioBuffer;
  private sawVoices = new Map<string, { osc: OscillatorNode; osc2: OscillatorNode; gain: GainNode; filter: BiquadFilterNode }>();
  private motors = new Map<string, { osc: OscillatorNode; gain: GainNode }>();
  private torches = new Map<string, { gain: GainNode; filter: BiquadFilterNode }>();
  private grind: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private alarm: { osc: OscillatorNode; gain: GainNode; lfo: OscillatorNode } | null = null;
  muted = false;
  private lastPlayed = new Map<string, number>();

  constructor() {
    try {
      this.muted = localStorage.getItem("s1.muted") === "1";
    } catch {
      /* private mode */
    }
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  /** Create/resume the context. Safe to call repeatedly; call from a user gesture. */
  unlock() {
    if (!this.ctx) this.build();
    if (this.ctx && this.ctx.state !== "running") void this.ctx.resume();
  }

  setMuted(m: boolean) {
    this.muted = m;
    try {
      localStorage.setItem("s1.muted", m ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  private build() {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.8;
    this.sfx.connect(this.master);

    // White noise buffer reused by everything percussive.
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Crowd bed: brown-ish noise through a bandpass, always murmuring, swells on big moments.
    this.crowd = ctx.createGain();
    this.crowd.gain.value = 0.05;
    this.crowdSwell = ctx.createGain();
    this.crowdSwell.gain.value = 1;
    const crowdSrc = ctx.createBufferSource();
    crowdSrc.buffer = this.noiseBuf;
    crowdSrc.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 600;
    bp.Q.value = 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1400;
    crowdSrc.connect(bp).connect(lp).connect(this.crowdSwell).connect(this.crowd).connect(this.master);
    crowdSrc.start();
    // Slow wobble so the murmur isn't static.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.02;
    lfo.connect(lfoGain).connect(this.crowd.gain);
    lfo.start();

    // Kill-saw grind loop, silent until the saws rise.
    const g = ctx.createGain();
    g.gain.value = 0;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 2200;
    f.Q.value = 2;
    src.connect(f).connect(g).connect(this.sfx);
    src.start();
    this.grind = { src, gain: g };
  }

  /** Rate-limit a named one-shot so 30 saw sparks a second don't become a wall of noise. */
  private gate(key: string, minGap: number): boolean {
    if (!this.ctx) return false;
    const now = this.ctx.currentTime;
    const last = this.lastPlayed.get(key) ?? -1;
    if (now - last < minGap) return false;
    this.lastPlayed.set(key, now);
    return true;
  }

  private noise(duration: number, opts: { type?: BiquadFilterType; freq?: number; freqEnd?: number; q?: number; gain?: number; attack?: number }) {
    if (!this.ctx) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.loopStart = Math.random();
    src.loopEnd = src.loopStart + 1;
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? "lowpass";
    f.frequency.setValueAtTime(opts.freq ?? 1000, ctx.currentTime);
    if (opts.freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), ctx.currentTime + duration);
    f.Q.value = opts.q ?? 0.8;
    const g = ctx.createGain();
    const a = opts.attack ?? 0.003;
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(opts.gain ?? 0.5, ctx.currentTime + a);
    g.gain.exponentialRampToValueAtTime(0.0005, ctx.currentTime + duration);
    src.connect(f).connect(g).connect(this.sfx);
    src.start();
    src.stop(ctx.currentTime + duration + 0.05);
    return g;
  }

  private tone(freq: number, duration: number, opts: { type?: OscillatorType; freqEnd?: number; gain?: number; attack?: number; delay?: number } = {}) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const o = ctx.createOscillator();
    o.type = opts.type ?? "sine";
    o.frequency.setValueAtTime(freq, t0);
    if (opts.freqEnd) o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), t0 + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(opts.gain ?? 0.3, t0 + (opts.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + duration);
    o.connect(g).connect(this.sfx);
    o.start(t0);
    o.stop(t0 + duration + 0.05);
  }

  /** Inharmonic partials = metal. */
  private clang(base: number, duration: number, gain: number) {
    const ratios = [1, 1.93, 2.71, 3.4, 4.97];
    ratios.forEach((r, i) => this.tone(base * r, duration * (1 - i * 0.12), { gain: gain / (i + 1.5), type: "sine" }));
  }

  // ---- continuous sounds driven from the frame loop ----

  /** Per-saw whine: pitch and level follow blade spin. A bar spinner uses the same voice an octave down. */
  updateSaw(id: string, spin: number, alive: boolean, biting: boolean, pitchMul = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    let v = this.sawVoices.get(id);
    if (!v) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      const osc2 = ctx.createOscillator();
      osc2.type = "sine";
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 1.2;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const mix = ctx.createGain();
      mix.gain.value = 0.5;
      osc.connect(mix);
      osc2.connect(mix);
      mix.connect(filter).connect(gain).connect(this.sfx);
      osc.start();
      osc2.start();
      v = { osc, osc2, gain, filter };
      this.sawVoices.set(id, v);
    }
    const t = ctx.currentTime;
    // Low, mellow hum that rises with spin; it only gets loud for the moment the blade is in something.
    const f = (70 + spin * spin * 260) * pitchMul;
    v.osc.frequency.setTargetAtTime(f, t, 0.08);
    v.osc2.frequency.setTargetAtTime(f * 2 + 1.5, t, 0.08);
    v.filter.frequency.setTargetAtTime(220 + spin * 700 + (biting ? 1800 : 0), t, 0.05);
    const level = alive ? 0.004 + spin * 0.018 + (biting ? 0.05 : 0) : 0;
    v.gain.gain.setTargetAtTime(level, t, 0.06);
  }

  /** Per-bot drive motor: a quiet low hum whose pitch and level follow how hard the bot is driving. */
  updateMotor(id: string, drive: number, alive: boolean, pitch: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    let m = this.motors.get(id);
    if (!m) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 320;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(lp).connect(gain).connect(this.sfx);
      osc.start();
      m = { osc, gain };
      this.motors.set(id, m);
    }
    const t = ctx.currentTime;
    m.osc.frequency.setTargetAtTime(pitch * (0.8 + drive * 1.1), t, 0.12);
    m.gain.gain.setTargetAtTime(alive ? 0.002 + drive * 0.022 : 0, t, 0.12);
  }

  /** Per-torch roar: filtered noise that opens up while the flame is on. */
  updateTorch(id: string, firing: boolean, alive: boolean) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    let v = this.torches.get(id);
    if (!v) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 700;
      filter.Q.value = 0.7;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.sfx);
      src.start();
      v = { gain, filter };
      this.torches.set(id, v);
    }
    const t = ctx.currentTime;
    const on = firing && alive;
    v.filter.frequency.setTargetAtTime(on ? 900 + Math.random() * 300 : 500, t, 0.08);
    v.gain.gain.setTargetAtTime(on ? 0.11 : 0, t, on ? 0.04 : 0.12);
  }

  /** Kill saws: grind loop level follows how far they're raised. */
  updateGrind(raise: number) {
    if (!this.ctx || !this.grind) return;
    this.grind.gain.gain.setTargetAtTime(raise * 0.12, this.ctx.currentTime, 0.1);
  }

  /** Pit warning klaxon on/off. */
  updateAlarm(on: boolean) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (on && !this.alarm) {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = 660;
      const lfo = ctx.createOscillator();
      lfo.type = "square";
      lfo.frequency.value = 3;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.05;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      lfo.connect(lfoGain).connect(gain.gain);
      osc.connect(gain).connect(this.sfx);
      osc.start();
      lfo.start();
      gain.gain.setTargetAtTime(0.05, ctx.currentTime, 0.1);
      this.alarm = { osc, gain, lfo };
    } else if (!on && this.alarm) {
      const a = this.alarm;
      this.alarm = null;
      a.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
      a.osc.stop(ctx.currentTime + 0.5);
      a.lfo.stop(ctx.currentTime + 0.5);
    }
  }

  // ---- one-shots ----

  crowdReact(intensity: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const g = this.crowdSwell.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(g.value, 1), t);
    g.linearRampToValueAtTime(1 + intensity * 9, t + 0.25);
    g.exponentialRampToValueAtTime(1, t + 1.6 + intensity * 1.5);
  }

  sawBite(power: number) {
    if (!this.gate("sawbite", 0.12)) return;
    this.noise(0.18, { type: "highpass", freq: 2500, gain: 0.25 + power * 0.3 });
    this.tone(900 + power * 600, 0.12, { type: "square", gain: 0.06, freqEnd: 400 });
  }

  hammerWindup() {
    if (!this.gate("windup", 0.3)) return;
    this.noise(0.25, { type: "bandpass", freq: 900, freqEnd: 2500, q: 3, gain: 0.12, attack: 0.05 });
  }

  hammerStrike(landed: boolean, crit = false) {
    this.tone(95, 0.35, { freqEnd: 28, gain: 0.9 });
    this.noise(0.12, { freq: 1800, freqEnd: 200, gain: 0.5 });
    if (landed) {
      this.clang(320, 0.6, 0.35);
      if (crit) this.clang(540, 0.9, 0.3);
    } else {
      this.noise(0.4, { freq: 400, freqEnd: 60, gain: 0.3 });
    }
  }

  grab() {
    this.clang(480, 0.25, 0.25);
    this.noise(0.15, { type: "bandpass", freq: 3000, q: 4, gain: 0.3 });
    this.tone(140, 0.25, { type: "square", gain: 0.08, freqEnd: 90 });
  }

  release() {
    this.noise(0.3, { type: "bandpass", freq: 1800, freqEnd: 600, q: 2, gain: 0.2 });
  }

  crush() {
    if (!this.gate("crush", 0.3)) return;
    this.noise(0.25, { type: "bandpass", freq: 700, freqEnd: 250, q: 5, gain: 0.18 });
    this.tone(70, 0.3, { type: "sawtooth", gain: 0.05, freqEnd: 50 });
  }

  flip(hit: boolean) {
    // Pneumatic dump ("PSSHH"), the plate slamming its stop ("THWACK"), and, on a hit, the whoosh of airtime.
    this.noise(0.32, { type: "bandpass", freq: 5000, freqEnd: 500, q: 1.2, gain: 0.9 });
    this.tone(170, 0.22, { type: "triangle", gain: 0.6, freqEnd: 45, delay: 0.03 });
    this.noise(0.08, { freq: 2500, freqEnd: 300, gain: 0.5, attack: 0.001 });
    if (hit) {
      this.clang(300, 0.4, 0.35);
      this.noise(0.75, { type: "bandpass", freq: 350, freqEnd: 2600, q: 1.5, gain: 0.28, attack: 0.08 });
    }
  }

  spinnerHit(power: number, crit: boolean) {
    if (!this.gate("spinhit", 0.1)) return;
    this.clang(180 + power * 120, 0.5, 0.3 + power * 0.3);
    this.noise(0.25, { type: "bandpass", freq: 1500, freqEnd: 300, q: 1.5, gain: 0.35 });
    this.tone(90, 0.3, { freqEnd: 30, gain: 0.5 });
    if (crit) this.noise(0.6, { type: "bandpass", freq: 400, freqEnd: 2200, q: 1.5, gain: 0.25, attack: 0.05 });
  }

  torchHit() {
    if (!this.gate("torchhit", 0.25)) return;
    this.noise(0.3, { type: "highpass", freq: 1800, freqEnd: 600, gain: 0.14, attack: 0.02 });
  }

  boost() {
    this.noise(0.5, { type: "bandpass", freq: 300, freqEnd: 1800, q: 1.2, gain: 0.3, attack: 0.03 });
    this.tone(70, 0.6, { type: "sawtooth", freqEnd: 160, gain: 0.08, attack: 0.05 });
  }

  slam(speed: number, crit: boolean) {
    if (!this.gate("slam", 0.12)) return;
    const k = clamp(speed / 9, 0, 1);
    this.tone(80, 0.35, { freqEnd: 25, gain: 0.5 + k * 0.5 });
    this.noise(0.18, { freq: 1200, freqEnd: 150, gain: 0.4 + k * 0.3 });
    this.clang(150 + Math.random() * 40, 0.4, 0.2 + k * 0.3);
    if (crit) this.clang(300, 0.7, 0.3);
  }

  /** One-shot weapon back online: a sharp click and a short hiss. Distinct per kind so ears can track it. */
  recharged(kind: "hammer" | "grabber" | "flipper" | "ram") {
    const f = kind === "hammer" ? 900 : kind === "grabber" ? 1400 : kind === "ram" ? 600 : 2100;
    this.tone(f, 0.05, { type: "square", gain: 0.07 });
    this.tone(f * 1.5, 0.08, { type: "square", gain: 0.05, delay: 0.05 });
    if (kind === "flipper") this.noise(0.25, { type: "highpass", freq: 3500, gain: 0.12, attack: 0.02 });
    if (kind === "hammer") this.noise(0.2, { type: "bandpass", freq: 500, freqEnd: 900, q: 3, gain: 0.1, attack: 0.03 });
  }

  landing(force: number, crit = false) {
    this.tone(110, 0.3, { freqEnd: 35, gain: 0.5 + force * 0.4 });
    this.noise(0.2, { freq: 900, freqEnd: 150, gain: 0.3 + force * 0.3 });
    this.clang(200 + Math.random() * 60, 0.5, 0.2 + force * 0.2);
    if (crit) this.clang(410, 0.8, 0.3);
  }

  wall(speed: number) {
    if (!this.gate("wall", 0.08)) return;
    const k = clamp((speed - 1) / 8, 0, 1);
    this.clang(240 + Math.random() * 80, 0.35 + k * 0.4, 0.12 + k * 0.4);
    if (k > 0.3) this.tone(80, 0.25, { freqEnd: 30, gain: 0.3 * k });
  }

  sawsChew() {
    if (!this.gate("chew", 0.15)) return;
    this.noise(0.2, { type: "highpass", freq: 3000, gain: 0.3 });
  }

  crit() {
    // bright "ding" chord on top of whatever the hit itself did
    this.tone(1320, 0.5, { gain: 0.12, attack: 0.002 });
    this.tone(1980, 0.4, { gain: 0.07, attack: 0.002, delay: 0.02 });
    this.tone(2640, 0.35, { gain: 0.04, attack: 0.002, delay: 0.04 });
    this.crowdReact(0.6);
  }

  destroyed() {
    this.tone(70, 0.9, { freqEnd: 20, gain: 1.0 });
    this.noise(0.9, { freq: 3500, freqEnd: 80, gain: 0.8, attack: 0.01 });
    for (let i = 0; i < 6; i++) this.tone(300 + Math.random() * 900, 0.15, { type: "square", gain: 0.05, delay: 0.1 + Math.random() * 0.6 });
    this.clang(180, 1.2, 0.3);
    this.crowdReact(1);
  }

  pitted() {
    // slide whistle down, then a distant thump
    this.tone(1400, 1.1, { type: "triangle", freqEnd: 180, gain: 0.25, attack: 0.03 });
    this.tone(60, 0.4, { freqEnd: 25, gain: 0.6, delay: 1.05 });
    this.noise(0.5, { freq: 600, freqEnd: 100, gain: 0.4, attack: 0.01 });
    this.crowdReact(0.9);
  }

  pitOpen() {
    this.tone(55, 1.2, { type: "sawtooth", freqEnd: 30, gain: 0.35, attack: 0.1 });
    this.noise(1.0, { type: "bandpass", freq: 300, freqEnd: 120, q: 1, gain: 0.3, attack: 0.1 });
    this.crowdReact(0.5);
  }

  sawsRising() {
    this.noise(0.9, { type: "bandpass", freq: 500, freqEnd: 2500, q: 2, gain: 0.25, attack: 0.1 });
    this.tone(120, 0.9, { type: "sawtooth", freqEnd: 420, gain: 0.08, attack: 0.1 });
  }

  countdownBeep(final: boolean) {
    this.tone(final ? 1320 : 880, final ? 0.6 : 0.12, { type: "square", gain: 0.12 });
    if (final) this.crowdReact(0.7);
  }

  matchEnd() {
    // air horn + crowd
    [220, 277, 330].forEach((f, i) => this.tone(f, 1.4, { type: "sawtooth", gain: 0.12, attack: 0.05, delay: i * 0.02 }));
    this.crowdReact(1);
  }

  uiClick() {
    this.tone(1200, 0.05, { type: "square", gain: 0.04 });
  }
}
