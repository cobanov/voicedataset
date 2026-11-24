// Take analysis, trimming, WAV encoding and resampling. Pure functions, no DOM.

const FRAME = 0.01; // 10 ms analysis frames
const HEAD = 0.2; // the first 0.2 s and last 0.3 s hold the key or click that started and stopped the take
const TAIL = 0.3;
const PRE = 0.25; // silence kept before the first and after the last word
const POST = 0.3;
const MIN_RUN = 5; // a word is at least 50 ms of sound; clicks are shorter

const db = (power) => 10 * Math.log10(power + 1e-12);

// Finds the speech in a take, trims the silence and key clicks around it and checks the levels.
// Flags: nospeech, early (speech already running when the take started), late (still running at the end),
// clip (peak above -1 dBFS), quiet (peak below -24 dBFS), noisy (high noise floor or low signal-to-noise).
export function analyze(x, sr) {
  const fl = Math.max(1, Math.round(sr * FRAME));
  const n = Math.floor(x.length / fl);
  const level = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * fl, e = i + fl; i < e; i++) s += x[i] * x[i];
    level[f] = db(s / fl);
  }

  const lo = Math.min(Math.round(HEAD / FRAME), n);
  const hi = Math.max(lo, n - Math.round(TAIL / FRAME));
  const inner = Array.from(level.subarray(lo, hi)).sort((a, b) => a - b);
  const floorDb = inner.length ? inner[Math.floor(inner.length * 0.1)] : -120;
  const thr = Math.max(floorDb + 12, -55);

  const run = (f, dir) => {
    for (let k = 0; k < MIN_RUN; k++) {
      const g = f + k * dir;
      if (g < lo || g >= hi || level[g] <= thr) return false;
    }
    return true;
  };
  let first = -1;
  let last = -1;
  for (let f = lo; f < hi; f++) if (run(f, 1)) { first = f; break; }
  for (let f = hi - 1; f >= lo; f--) if (run(f, -1)) { last = f; break; }

  if (first < 0) {
    let peak = 0;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    return { y: x, flags: ["nospeech"], floorDb, peakDb: 20 * Math.log10(peak + 1e-12), speechDb: -120 };
  }

  const flags = [];
  if (first <= lo + 1) flags.push("early");
  if (last >= hi - 2) flags.push("late");

  const s0 = Math.max(lo, first - Math.round(PRE / FRAME)) * fl;
  const s1 = Math.min(hi, last + 1 + Math.round(POST / FRAME)) * fl;
  const y = x.slice(s0, s1);
  const fade = Math.min(Math.round(sr * 0.01), y.length >> 1);
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    y[i] *= g;
    y[y.length - 1 - i] *= g;
  }

  let peak = 0;
  let clipped = 0;
  for (let i = s0; i < s1; i++) {
    const v = Math.abs(x[i]);
    if (v > peak) peak = v;
    if (v >= 0.999) clipped++;
  }
  let power = 0;
  let voiced = 0;
  for (let f = first; f <= last; f++) {
    if (level[f] > thr) {
      power += 10 ** (level[f] / 10);
      voiced++;
    }
  }
  const speechDb = voiced ? db(power / voiced) : -120;
  const peakDb = 20 * Math.log10(peak + 1e-12);

  if (clipped >= 3 || peakDb > -1) flags.push("clip");
  else if (peakDb < -24) flags.push("quiet");
  if (floorDb > -45 || speechDb - floorDb < 20) flags.push("noisy");

  return { y, flags, floorDb, peakDb, speechDb };
}

export function toInt16(f) {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i]));
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  return out;
}

export function toFloat(i16) {
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
  return out;
}

// 16-bit mono PCM WAV.
export function wav(i16, sr) {
  const bytes = new Uint8Array(44 + i16.length * 2);
  const v = new DataView(bytes.buffer);
  const text = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  text(0, "RIFF");
  v.setUint32(4, 36 + i16.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, i16.length * 2, true);
  new Int16Array(bytes.buffer, 44).set(i16);
  return bytes;
}

// Windowed-sinc resampler (Blackman window, 16 zero crossings), with the low-pass set below the lower
// of the two Nyquist frequencies, so downsampling for training does not alias.
export function resample(x, from, to) {
  if (from === to) return x;
  const ratio = to / from;
  const fc = 0.5 * Math.min(1, ratio) * 0.96; // cutoff in cycles per input sample
  const half = 16 / (2 * fc); // kernel half-width in input samples
  const RES = 256;
  const table = new Float32Array(Math.ceil(half * RES) + 2);
  for (let i = 0; i < table.length; i++) {
    const t = i / RES;
    if (t >= half) break;
    const a = 2 * fc * t;
    const sinc = a === 0 ? 1 : Math.sin(Math.PI * a) / (Math.PI * a);
    const u = t / half;
    const w = 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
    table[i] = 2 * fc * sinc * w;
  }
  const out = new Float32Array(Math.round(x.length * ratio));
  for (let n = 0; n < out.length; n++) {
    const t = n / ratio;
    const k0 = Math.max(0, Math.ceil(t - half));
    const k1 = Math.min(x.length - 1, Math.floor(t + half));
    let acc = 0;
    for (let k = k0; k <= k1; k++) {
      const d = Math.abs(t - k) * RES;
      const i = d | 0;
      acc += x[k] * (table[i] + (table[i + 1] - table[i]) * (d - i));
    }
    out[n] = acc;
  }
  return out;
}
