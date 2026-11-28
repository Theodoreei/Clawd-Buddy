// Plays MyClawd animation sets on a canvas.
// Every set is enter -> loop(s) -> exit, and all of them start and end on the same
// "seam" pose, so any set can follow any other one without a visible jump.
"use strict";

const SET_ROOT = "../../assets/sets/";
const MAX_CACHED_SETS = 16;
const CUT_IF_REMAINING_MS = 700; // switching mid-loop: cut to exit if more than this is left

class ClawdPlayer {
  constructor(canvas, sets) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { willReadFrequently: true });
    this.ctx.imageSmoothingEnabled = false;
    this.sets = sets;
    this.cache = new Map(); // name -> Promise<{enter, exit, loops}>
    this.lru = [];

    this.mode = null; // a persistent animation (what Clawd is busy with)
    this.idle = "idle"; // what to fall back to when there is nothing else
    this.queue = []; // one-shot reactions, played in order before the mode

    this.cur = null; // {name, set, phase, clip, i, frameStart, loopIdx, once}
    this.onChange = null;
    this._raf = this._raf.bind(this);
    requestAnimationFrame(this._raf);
  }

  has(name) {
    return !!this.sets[name];
  }

  // ---------- public API ----------
  setMode(name) {
    if (name && !this.has(name)) return;
    if (this.mode === name) return;
    this.mode = name;
    this._load(this.desired());
    this._maybeCut();
  }

  setIdle(name) {
    if (!this.has(name) || this.idle === name) return;
    this.idle = name;
    this._load(name);
    this._maybeCut();
  }

  // Play a set once (one loop), then go back to what Clawd was doing.
  react(name, { loops = 1, front = false } = {}) {
    if (!this.has(name)) return;
    const item = { name, loops };
    if (front) this.queue.unshift(item);
    else this.queue.push(item);
    if (this.queue.length > 3) this.queue.splice(1, this.queue.length - 3); // don't pile up stale reactions
    this._load(name);
    this._maybeCut();
  }

  current() {
    return this.cur ? this.cur.name : null;
  }

  // Is there a visible (non-transparent) Clawd pixel at this point (CSS px within the canvas)?
  hitTest(x, y, cssW, cssH) {
    const px = Math.floor((x / cssW) * this.canvas.width);
    const py = Math.floor((y / cssH) * this.canvas.height);
    if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) return false;
    const x0 = Math.max(0, px - 1), y0 = Math.max(0, py - 1);
    const data = this.ctx.getImageData(x0, y0, 3, 3).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 20) return true;
    return false;
  }

  preload(names) {
    for (const n of names) if (this.has(n)) this._load(n);
  }

  // ---------- internals ----------
  desired() {
    if (this.queue.length) return this.queue[0].name;
    return this.mode || this.idle;
  }

  _maybeCut() {
    const c = this.cur;
    if (!c || c.phase !== "loop" || c.once) return; // let one-shot reactions finish
    if (this.desired() === c.name) return;
    const remaining = c.clip.total - (performance.now() - c.clipStart);
    if (remaining > CUT_IF_REMAINING_MS) this._startPhase("exit");
  }

  _load(name) {
    if (!this.has(name)) return Promise.resolve(null);
    this.lru = [name, ...this.lru.filter((n) => n !== name)];
    if (!this.cache.has(name)) {
      const info = this.sets[name];
      const p = Promise.all([
        this._decode(name, "enter.gif"),
        this._decode(name, "exit.gif"),
        Promise.all(info.loops.map(([f]) => this._decode(name, f))),
      ])
        .then(([enter, exit, loops]) => ({ enter, exit, loops: loops.filter(Boolean) }))
        .catch((e) => {
          console.warn("could not load", name, e);
          this.cache.delete(name);
          return null;
        });
      p.then((v) => (p.value = v));
      this.cache.set(name, p);
      this._evict();
    }
    return this.cache.get(name);
  }

  _evict() {
    const keep = new Set([this.idle, this.mode, ...(this.queue.map((q) => q.name)), this.cur && this.cur.name]);
    while (this.cache.size > MAX_CACHED_SETS) {
      const victim = [...this.lru].reverse().find((n) => this.cache.has(n) && !keep.has(n));
      if (!victim) break;
      const p = this.cache.get(victim);
      this.cache.delete(victim);
      p.then((set) => {
        if (!set) return;
        for (const clip of [set.enter, set.exit, ...set.loops]) if (clip) clip.frames.forEach((f) => f.bmp.close());
      });
    }
  }

  async _decode(name, file) {
    const res = await fetch(SET_ROOT + name + "/" + file);
    if (!res.ok) return null;
    const data = await res.arrayBuffer();
    const dec = new ImageDecoder({ data, type: "image/gif" });
    await dec.tracks.ready;
    const count = dec.tracks.selectedTrack.frameCount;
    const frames = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const dur = image.duration ? image.duration / 1000 : 100;
      frames.push({ bmp: await createImageBitmap(image), dur: dur || 100 });
      total += dur || 100;
      image.close();
    }
    dec.close();
    return { frames, total };
  }

  _ready(name) {
    const p = this.cache.get(name);
    return p && p.value ? p.value : null;
  }

  _startSet(name) {
    const set = this._ready(name);
    if (!set) {
      this._load(name);
      return false;
    }
    const once = this.queue.length > 0 && this.queue[0].name === name;
    this.cur = { name, set, phase: "enter", once, loopsDone: 0, lastLoop: -1 };
    this._startPhase("enter");
    if (this.onChange) this.onChange(name);
    return true;
  }

  _startPhase(phase) {
    const c = this.cur;
    c.phase = phase;
    if (phase === "enter") c.clip = c.set.enter;
    else if (phase === "exit") c.clip = c.set.exit;
    else {
      // pick a loop, avoiding an immediate repeat when there are several
      const n = c.set.loops.length;
      let idx = Math.floor(Math.random() * n);
      if (n > 1 && idx === c.lastLoop) idx = (idx + 1) % n;
      c.lastLoop = idx;
      c.clip = c.set.loops[idx];
    }
    if (!c.clip) {
      // missing clip: skip ahead
      c.clip = { frames: [], total: 0 };
    }
    c.i = 0;
    c.clipStart = performance.now();
    c.frameStart = c.clipStart;
  }

  _clipEnded() {
    const c = this.cur;
    if (c.phase === "enter") {
      this._startPhase("loop");
      return;
    }
    if (c.phase === "loop") {
      c.loopsDone++;
      if (c.once) {
        const item = this.queue[0];
        if (item && item.name === c.name && c.loopsDone >= item.loops) {
          this.queue.shift();
          c.once = false;
          // the same set again? keep looping without exit/enter
          if (this.desired() === c.name) {
            c.once = this.queue.length > 0 && this.queue[0].name === c.name;
            c.loopsDone = 0;
            this._startPhase("loop");
            return;
          }
          this._startPhase("exit");
          return;
        }
        this._startPhase("loop");
        return;
      }
      if (this.desired() !== c.name) this._startPhase("exit");
      else this._startPhase("loop");
      return;
    }
    // exit finished: start whatever is wanted now
    const next = this.desired();
    if (!this._startSet(next)) {
      c.phase = "waiting"; // hold the seam pose until the next set is decoded
    }
  }

  _raf(now) {
    requestAnimationFrame(this._raf);
    if (!this.cur) {
      this._startSet(this.desired());
      return;
    }
    const c = this.cur;
    if (c.phase === "waiting") {
      this._startSet(this.desired());
      return;
    }
    if (now - c.frameStart > 2000) c.frameStart = now; // window was hidden or asleep: don't fast-forward
    let guard = 0;
    while (guard++ < 50) {
      const frames = c.clip.frames;
      if (c.i >= frames.length) {
        this._clipEnded();
        if (this.cur !== c || c.phase === "waiting") return;
        continue;
      }
      if (now - c.frameStart >= frames[c.i].dur) {
        c.frameStart += frames[c.i].dur;
        c.i++;
        continue;
      }
      break;
    }
    const f = this.cur.clip.frames[this.cur.i];
    if (f && f !== this._drawn) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(f.bmp, 0, 0);
      this._drawn = f;
    }
  }
}

window.ClawdPlayer = ClawdPlayer;
