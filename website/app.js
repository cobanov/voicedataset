import { STR, UI_LANGS, pickUiLang } from "./i18n.js";
import * as store from "./store.js";
import { analyze, resample, toFloat, toInt16, wav } from "./audio.js";
import { ZipWriter } from "./zip.js";

const $ = (id) => document.getElementById(id);
const local = {
  get(k, d) {
    try {
      const v = localStorage.getItem("vd." + k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("vd." + k, JSON.stringify(v));
    } catch {}
  },
};

// Page state
const S = {
  ui: "en",
  langs: [],
  lang: "en",
  data: null,
  set: "quick",
  name: "",
  items: [],
  idx: 0,
  takes: new Map(), // sentence id -> take meta, for the current speaker and language
  saving: false,
  exporting: false,
  lastFlags: null, // flags of the take just recorded, shown until the next action
  savedNote: null,
};
// Microphone state
const M = { ctx: null, stream: null, src: null, node: null, sink: null, recording: false, stopping: false, chunks: [], trace: [], recTrace: [], t0: 0, timer: 0, hold: -120, holdAt: 0 };
let player = null;
let persisted = false;

const t = (key, vars) => {
  let s = STR[S.ui]?.[key] ?? STR.en[key] ?? key;
  if (vars && typeof s === "string") for (const [k, v] of Object.entries(vars)) s = s.replaceAll("{" + k + "}", v);
  return s;
};

const TR_MAP = { ı: "i", İ: "i", ş: "s", Ş: "s", ğ: "g", Ğ: "g", ç: "c", Ç: "c", ö: "o", Ö: "o", ü: "u", Ü: "u", ß: "ss", æ: "ae", ø: "o", đ: "d", ł: "l" };
const slug = (s) =>
  s.replace(/[^\u0000-\u007f]/g, (c) => TR_MAP[c] ?? c).normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "speaker";
const speaker = () => slug(S.name.trim());
const scope = () => `${speaker()}/${S.lang}`;
const fmtDur = (s) => {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m} min ${String(r).padStart(2, "0")} s` : `${r} s`;
};
const fmtDb = (d) => (d <= -120 ? "–∞" : d.toFixed(1).replace("-", "−"));

/* ---------- sentences ---------- */

function buildItems() {
  const d = S.data;
  const items = [{
    id: "consent",
    text: d.consent.replace("{name}", S.name.trim() || "[" + t("name_needed") + "]"),
    label: t("consent"),
    tpl: d.consent,
    note: t("consent_note"),
  }];
  if (S.set === "custom") {
    local.get("custom." + S.lang, []).forEach((text, i) => {
      items.push({ id: "c_" + String(i + 1).padStart(3, "0"), text, label: t("custom_label"), note: "" });
    });
  } else {
    const quick = Array.isArray(d.quick) ? new Set(d.quick) : null;
    d.parts.forEach((p, pi) => {
      p.lines.forEach((text, li) => {
        const id = `${p.id}_${String(li + 1).padStart(2, "0")}`;
        if (S.set === "full" || (quick ? quick.has(id) : li % 4 === 0)) {
          items.push({ id, text, label: `${t("part", { n: pi + 1 })} · ${p.title}`, note: p.note || "" });
        }
      });
    });
  }
  S.items = items;
}

const counts = () => {
  const full = S.data.parts.reduce((a, p) => a + p.lines.length, 0) + 1;
  const quick = Array.isArray(S.data.quick)
    ? S.data.quick.length + 1
    : S.data.parts.reduce((a, p) => a + Math.ceil(p.lines.length / 4), 0) + 1;
  const custom = local.get("custom." + S.lang, []).length + 1;
  return { quick, full, custom };
};

const takeOf = (item) => S.takes.get(item.id);
const isStale = (item) => {
  const tk = takeOf(item);
  return !!tk && tk.text !== item.text;
};
const isDone = (item) => !!takeOf(item) && !isStale(item);

function nextTodo(from) {
  const n = S.items.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (!isDone(S.items[i])) return i;
  }
  return -1;
}

async function loadLanguage(code) {
  const r = await fetch(`languages/${code}.json`);
  if (!r.ok) throw new Error(`languages/${code}.json: ${r.status}`);
  S.data = await r.json();
  S.lang = code;
  local.set("lang", code);
}

async function loadTakes() {
  const metas = await store.takesIn(scope());
  S.takes = new Map(metas.map((m) => [m.id, m]));
}

async function refreshList({ keepId } = {}) {
  buildItems();
  await loadTakes();
  const keep = keepId ? S.items.findIndex((x) => x.id === keepId) : -1;
  if (keep >= 0) S.idx = keep;
  else {
    const i = S.items.findIndex((x) => !isDone(x));
    S.idx = i < 0 ? 0 : i;
  }
  S.lastFlags = null;
  S.savedNote = null;
  renderAll();
}

/* ---------- rendering ---------- */

function renderStatic() {
  document.documentElement.lang = S.ui;
  document.title = t("page_title");
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const v = t(el.dataset.i18n);
    if (typeof v === "string") el.textContent = v;
  });
  $("name").placeholder = t("name_ph");
  $("custom").placeholder = t("custom_ph");
  $("prev").setAttribute("aria-label", t("prev"));
  $("next").setAttribute("aria-label", t("next"));
  $("rec-key").textContent = t("key_space");
  document.querySelector(".meter").title = t("meter_zone");
  $("tips").replaceChildren(...t("tips").map((s) => Object.assign(document.createElement("li"), { textContent: s })));
  const ex = `${speaker()}_${S.lang}_p1_01`;
  $("tree").innerHTML =
    `${speaker()}-${S.lang}-voicedataset/\n` +
    `├── wavs/\n│   ├── ${ex}.wav  <span class="c"># ${t("zip_wavs")}</span>\n│   └── …\n` +
    `├── metadata.csv    <span class="c"># ${t("zip_csv")}</span>\n` +
    `├── metadata.jsonl  <span class="c"># ${t("zip_jsonl")}</span>\n` +
    `└── README.md       <span class="c"># ${t("zip_readme")}</span>`;
}

function renderSetup() {
  const c = counts();
  const minutes = (n) => Math.max(1, Math.round((n * 9) / 60)); // about nine seconds a sentence, retakes included
  document.querySelectorAll("#set button").forEach((b) => {
    const on = b.dataset.set === S.set;
    b.setAttribute("aria-checked", on);
    b.tabIndex = on ? 0 : -1;
    const n = c[b.dataset.set];
    b.querySelector("small").textContent = b.dataset.set === "custom" && n <= 1 ? "" : t("set_count", { n, m: minutes(n) });
  });
  $("custom-box").hidden = S.set !== "custom";
  if (S.set === "custom") {
    const lines = local.get("custom." + S.lang, []);
    if (document.activeElement !== $("custom")) $("custom").value = lines.join("\n");
    $("custom-count").textContent = t(lines.length === 1 ? "custom_count_one" : "custom_count", { n: lines.length });
  }
}

function renderItem() {
  const item = S.items[S.idx];
  const tk = item && takeOf(item);
  $("part-label").textContent = item ? item.label : "";
  $("counter").textContent = item ? `${S.idx + 1} / ${S.items.length}` : "";
  $("note").textContent = item ? item.note : "";
  const sentence = $("sentence");
  if (item && item.tpl && !S.name.trim()) {
    const [before, after = ""] = item.tpl.split("{name}");
    const blank = Object.assign(document.createElement("span"), { className: "blank", title: t("name") });
    sentence.replaceChildren(before, blank, after);
  } else sentence.textContent = item ? item.text : "";
  $("sentence").lang = S.lang;
  $("prev").disabled = M.recording || S.idx <= 0;
  $("next").disabled = M.recording || S.idx >= S.items.length - 1;
  $("play").disabled = M.recording || !tk;
  $("rec").disabled = !item;
  $("recorder").classList.toggle("recording", M.recording);
  $("rec-label").textContent = M.recording ? t("stop") : t("rec");
  renderStatus();
  if (!M.recording) drawTake(item);
}

function renderStatus() {
  const box = $("status");
  const item = S.items[S.idx];
  const lines = [];
  const add = (text, cls) => lines.push(Object.assign(document.createElement("p"), { textContent: text, className: cls || "" }));
  if (M.recording) {
    const p = document.createElement("p");
    p.innerHTML = `<span class="rec-time">● ${((performance.now() - M.t0) / 1000).toFixed(1)} s</span> · `;
    p.append(t("st_rec"));
    lines.push(p);
  } else if (S.lastFlags) {
    for (const f of S.lastFlags) add(t("flag_" + f), "warn");
  } else if (!S.name.trim()) add(t("st_name"));
  else if (!M.node) add(t("st_mic"));
  else if (item) {
    const tk = takeOf(item);
    if (S.savedNote) add(S.savedNote);
    else if (isStale(item)) add(t("flag_stale"), "warn");
    else if (tk) {
      add(t("st_has", { s: tk.seconds.toFixed(1), p: fmtDb(tk.peakDb) }));
      for (const f of tk.flags.filter((f) => f !== "noisy")) add(t("flag_" + f), "warn");
    } else add(nextTodo(S.idx - 1) < 0 ? t("st_done") : t("st_ready"));
  }
  box.replaceChildren(...lines);
}

function renderGrid() {
  const grid = $("grid");
  if (grid.children.length !== S.items.length) {
    grid.replaceChildren(...S.items.map((it, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.i = i;
      return b;
    }));
  }
  S.items.forEach((it, i) => {
    const b = grid.children[i];
    const tk = takeOf(it);
    const flagged = tk && (isStale(it) || tk.flags.some((f) => f !== "noisy"));
    b.className = (flagged ? "flag" : tk ? "done" : "") + (i === S.idx ? " cur" : "");
    b.title = `${i + 1}. ${it.text}`;
    b.setAttribute("aria-label", `${i + 1}. ${it.text}`);
  });
  const done = S.items.filter(isDone).length;
  $("progress-label").textContent = t("progress", { done, total: S.items.length });
}

async function renderExport() {
  const takes = [...S.takes.values()];
  const secs = takes.reduce((a, m) => a + m.seconds, 0);
  const flagged = takes.filter((m) => m.flags.some((f) => f !== "noisy")).length;
  $("export-stats").textContent = takes.length
    ? t(takes.length === 1 ? "export_stats_one" : "export_stats", { n: takes.length, dur: fmtDur(secs) }) + (flagged ? " · " + t("export_flagged", { n: flagged }) : "")
    : t("export_none");
  $("download").disabled = !takes.length || S.exporting;
  $("delete").hidden = !takes.length;
  if (!S.exporting) $("download-label").textContent = t("download");

  const rates = new Set(takes.map((m) => m.sampleRate));
  const orig = takes.length ? mostCommon(takes.map((m) => m.sampleRate)) : M.ctx?.sampleRate || 48000;
  const sel = $("rate");
  const prev = sel.value || local.get("rate", "keep");
  const opts = [["keep", t("rate_keep", { r: orig / 1000 })]];
  for (const r of [48000, 44100, 24000, 22050, 16000]) if (r !== orig || rates.size > 1) opts.push([String(r), t("rate_hz", { r: r / 1000 })]);
  sel.replaceChildren(...opts.map(([v, l]) => Object.assign(document.createElement("option"), { value: v, textContent: l })));
  sel.value = opts.some(([v]) => v === prev) ? prev : "keep";

  let used = "";
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage > 1e6) used = t("used", { mb: Math.round(est.usage / 1e6) });
  } catch {}
  $("export-note").textContent = t("export_note", { used });
}

function renderAll() {
  renderStatic();
  renderSetup();
  renderItem();
  renderGrid();
  renderExport();
}

const mostCommon = (xs) => {
  const c = new Map();
  for (const x of xs) c.set(x, (c.get(x) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

/* ---------- waveform ---------- */

function canvas() {
  const c = $("wave");
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  return { g, w, h, color: (v) => css.getPropertyValue(v).trim() };
}

// Everything on the waveform strip is drawn as bars: the live input (muted) while the mic listens,
// the take in red while recording, and the saved take (blue, or amber with a warning) afterwards.
const BAR = 3; // px per bar, 2 px of ink and 1 px of gap
const height = (pk) => Math.max(0, Math.min(1, (20 * Math.log10(pk + 1e-9) + 54) / 54));

function drawBars(values, slots, colorVar, alignRight) {
  const { g, w, h, color } = canvas();
  g.fillStyle = color("--line");
  g.fillRect(0, Math.round(h / 2), w, 1);
  if (!values || !values.length) return;
  g.fillStyle = color(colorVar);
  const bw = w / slots;
  const offset = alignRight ? slots - values.length : 0;
  values.forEach((pk, i) => {
    const a = height(pk) * (h / 2 - 2);
    if (a < 0.5) return;
    g.fillRect((offset + i) * bw, h / 2 - a, Math.max(1, bw - 1), a * 2);
  });
}

let drawToken = 0;
async function drawTake(item) {
  const token = ++drawToken;
  const tk = item && takeOf(item);
  if (!tk) return drawTrace();
  const buf = await store.audio(tk.key);
  if (token !== drawToken || !buf) return;
  const x = new Int16Array(buf);
  const slots = Math.max(1, Math.floor($("wave").clientWidth / BAR));
  const step = x.length / slots;
  const peaks = [];
  for (let b = 0; b < slots; b++) {
    let pk = 0;
    for (let i = Math.floor(b * step), e = Math.min(x.length, Math.floor((b + 1) * step)); i < e; i++) {
      const v = x[i] < 0 ? -x[i] : x[i];
      if (v > pk) pk = v;
    }
    peaks.push(pk / 32768);
  }
  drawBars(peaks, slots, isStale(item) || tk.flags.some((f) => f !== "noisy") ? "--warn" : "--accent");
}

let traceQueued = false;
function drawTrace() {
  traceQueued = false;
  const slots = Math.max(1, Math.floor($("wave").clientWidth / BAR));
  if (M.recording) return drawBars(M.recTrace, Math.max(M.recTrace.length, slots * 2), "--rec");
  const item = S.items[S.idx];
  if (item && takeOf(item)) return;
  drawBars(M.node ? M.trace.slice(-slots) : null, slots, "--faint", true);
}

/* ---------- microphone ---------- */

async function enableMic(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    showMicInfo(t("mic_unsupported"), true);
    return;
  }
  $("mic-btn").disabled = true;
  try {
    M.stream?.getTracks().forEach((tr) => tr.stop());
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 } };
    if (deviceId) audio.deviceId = { exact: deviceId };
    M.stream = await navigator.mediaDevices.getUserMedia({ audio });
    const track = M.stream.getAudioTracks()[0];
    await connect(track.getSettings().sampleRate);
    track.addEventListener("ended", () => showMicInfo(t("mic_none"), true));
    local.set("mic", track.getSettings().deviceId || "");
    await listDevices(track.getSettings().deviceId);
    $("mic-btn").hidden = true;
    $("meter-wrap").hidden = false;
    describeMic(track);
  } catch (e) {
    const msg = e.name === "NotAllowedError" || e.name === "SecurityError" ? t("mic_denied")
      : e.name === "NotFoundError" || e.name === "OverconstrainedError" ? t("mic_none")
      : t("mic_error", { msg: e.message || e.name });
    showMicInfo(msg, true);
  } finally {
    $("mic-btn").disabled = false;
    renderItem();
  }
}

async function connect(trackRate) {
  M.src?.disconnect();
  M.src = null;
  const make = async (opts) => {
    const ctx = new AudioContext(opts);
    await ctx.audioWorklet.addModule("worklet.js");
    return ctx;
  };
  if (!M.ctx) M.ctx = await make({ latencyHint: "interactive" });
  try {
    M.src = M.ctx.createMediaStreamSource(M.stream);
  } catch {
    // Firefox refuses to connect a microphone whose rate differs from the context's: rebuild at the mic's rate.
    await M.ctx.close();
    M.node = null;
    M.ctx = await make({ latencyHint: "interactive", sampleRate: trackRate });
    M.src = M.ctx.createMediaStreamSource(M.stream);
  }
  if (!M.node) {
    M.node = new AudioWorkletNode(M.ctx, "tap", { numberOfInputs: 1, numberOfOutputs: 1 });
    M.node.port.onmessage = onTap;
    M.sink = M.ctx.createGain();
    M.sink.gain.value = 0; // keeps the tap running without sending the mic to the speakers
    M.node.connect(M.sink).connect(M.ctx.destination);
  }
  M.src.connect(M.node);
  if (M.ctx.state !== "running") await M.ctx.resume();
}

async function listDevices(currentId) {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  const sel = $("mic");
  sel.replaceChildren(...devs.map((d, i) => Object.assign(document.createElement("option"), {
    value: d.deviceId,
    textContent: d.label || `${t("mic")} ${i + 1}`,
  })));
  if (devs.some((d) => d.deviceId === currentId)) sel.value = currentId;
  sel.hidden = devs.length < 2;
}

function describeMic(track) {
  const st = track.getSettings();
  const on = [];
  if (st.echoCancellation) on.push("echo cancellation");
  if (st.noiseSuppression) on.push("noise suppression");
  if (st.autoGainControl) on.push("auto gain");
  const rate = `${(M.ctx.sampleRate / 1000).toFixed(M.ctx.sampleRate % 1000 ? 1 : 0)} kHz`;
  if (on.length) showMicInfo(`${rate} · ${t("mic_processed", { list: on.join(", ") })}`, true);
  else showMicInfo(`${rate} · ${t("mic_raw")} · ${t("meter_zone")}`);
}

function showMicInfo(text, warn) {
  $("mic-info").textContent = text;
  $("mic-info").classList.toggle("warn", !!warn);
}

function onTap(e) {
  const d = e.data;
  if (d.pk !== undefined) meter(d.pk);
  else if (d.buf) {
    M.chunks.push(d.buf);
  } else if (d.stopped) finish();
}

function meter(pk) {
  const db = 20 * Math.log10(pk + 1e-9);
  const pos = (v) => Math.max(0, Math.min(100, ((v + 60) / 60) * 100));
  const now = performance.now();
  if (db >= M.hold || now - M.holdAt > 1200) {
    M.hold = db;
    M.holdAt = now;
  }
  const bar = $("meter-bar");
  bar.style.width = pos(db) + "%";
  bar.classList.toggle("hot", db > -1);
  $("meter-hold").style.left = `calc(${pos(M.hold)}% - 1px)`;
  $("meter-db").textContent = db < -59 ? "–∞" : fmtDb(M.hold) + " dB";
  M.trace.push(pk);
  if (M.trace.length > 600) M.trace.splice(0, M.trace.length - 400);
  if (M.recording) M.recTrace.push(pk);
  if (!traceQueued) {
    traceQueued = true;
    requestAnimationFrame(drawTrace);
  }
}

/* ---------- recording ---------- */

function startRec() {
  if (M.recording || M.stopping || S.exporting) return;
  if (S.saving) return say(t("st_busy"));
  if (!S.name.trim()) {
    renderStatus();
    $("name").focus();
    return;
  }
  if (!M.node) {
    renderStatus();
    return;
  }
  stopPlayback();
  M.chunks = [];
  M.recTrace = [];
  M.recording = true;
  M.t0 = performance.now();
  S.lastFlags = null;
  S.savedNote = null;
  M.node.port.postMessage("start");
  M.timer = setInterval(() => {
    renderStatus();
    if (performance.now() - M.t0 > 45000) stopRec(); // nobody reads a sentence for 45 s; a forgotten take
  }, 100);
  renderItem();
  drawTrace();
}

function stopRec() {
  if (!M.recording || M.stopping) return;
  M.stopping = true;
  M.node.port.postMessage("stop");
}

async function finish() {
  clearInterval(M.timer);
  M.recording = false;
  M.stopping = false;
  const sr = M.ctx.sampleRate;
  const total = M.chunks.reduce((a, c) => a + c.length, 0);
  const x = new Float32Array(total);
  let o = 0;
  for (const c of M.chunks) {
    x.set(c, o);
    o += c.length;
  }
  M.chunks = [];
  const item = S.items[S.idx];
  if (total < sr * 0.8) {
    S.lastFlags = null;
    renderItem();
    return say(t("st_short"), true);
  }
  const a = analyze(x, sr);
  if (a.flags.includes("nospeech")) {
    S.lastFlags = ["nospeech"];
    renderItem();
    return;
  }

  S.saving = true;
  const pcm = toInt16(a.y);
  const meta = {
    key: `${scope()}/${item.id}`,
    scope: scope(),
    id: item.id,
    text: item.text,
    speaker: S.name.trim(),
    lang: S.lang,
    sampleRate: sr,
    seconds: pcm.length / sr,
    peakDb: a.peakDb,
    floorDb: a.floorDb,
    speechDb: a.speechDb,
    flags: a.flags,
    time: Date.now(),
  };
  try {
    await store.putTake(meta, pcm.buffer);
  } catch (e) {
    S.saving = false;
    return say(String(e.message || e), true);
  }
  S.saving = false;
  S.takes.set(item.id, meta);
  if (!persisted) {
    persisted = true;
    navigator.storage?.persist?.().catch(() => {});
  }
  if (a.flags.includes("noisy")) showMicInfo(t("flag_noisy"), true);

  const blocking = a.flags.filter((f) => f !== "noisy");
  if (blocking.length) {
    S.lastFlags = blocking;
  } else {
    const n = nextTodo(S.idx);
    if (n >= 0) {
      S.idx = n;
      S.savedNote = t("st_saved", { s: meta.seconds.toFixed(1) });
    } else S.savedNote = t("st_done");
  }
  renderItem();
  renderGrid();
  renderExport();
}

function say(text, warn) {
  $("status").replaceChildren(Object.assign(document.createElement("p"), { textContent: text, className: warn ? "warn" : "" }));
}

/* ---------- playback and navigation ---------- */

function stopPlayback() {
  if (player) {
    player.pause();
    URL.revokeObjectURL(player.src);
    player = null;
  }
}

async function play() {
  if (M.recording) return;
  const item = S.items[S.idx];
  const tk = item && takeOf(item);
  if (!tk) return;
  if (player) return stopPlayback();
  const buf = await store.audio(tk.key);
  if (!buf) return;
  const url = URL.createObjectURL(new Blob([wav(new Int16Array(buf), tk.sampleRate)], { type: "audio/wav" }));
  player = new Audio(url);
  player.onended = stopPlayback;
  player.play().catch(stopPlayback);
}

function go(i) {
  if (M.recording || i < 0 || i >= S.items.length) return;
  stopPlayback();
  S.idx = i;
  S.lastFlags = null;
  S.savedNote = null;
  renderItem();
  renderGrid();
}

/* ---------- export ---------- */

async function exportZip() {
  const takes = [...S.takes.values()];
  if (!takes.length || S.exporting) return;
  S.exporting = true;
  renderExport();
  const order = (id) => (id === "consent" ? "0" : "1" + id);
  takes.sort((a, b) => order(a.id).localeCompare(order(b.id)));
  const choice = $("rate").value;
  const rate = choice === "keep" ? mostCommon(takes.map((m) => m.sampleRate)) : Number(choice);
  local.set("rate", choice);

  try {
    const who = speaker();
    const root = `${who}-${S.lang}-voicedataset/`;
    const zip = new ZipWriter();
    const enc = new TextEncoder();
    const csv = [];
    const jsonl = [];
    let seconds = 0;
    for (let i = 0; i < takes.length; i++) {
      const m = takes[i];
      const buf = await store.audio(m.key);
      if (!buf) continue;
      let pcm = new Int16Array(buf);
      if (m.sampleRate !== rate) pcm = toInt16(resample(toFloat(pcm), m.sampleRate, rate));
      const base = `${who}_${S.lang}_${m.id}`;
      zip.add(`${root}wavs/${base}.wav`, wav(pcm, rate));
      const text = m.text.replace(/[|\r\n]+/g, " ").trim();
      const dur = pcm.length / rate;
      seconds += dur;
      csv.push(`${base}|${text}|${text}`);
      jsonl.push(JSON.stringify({
        audio: `wavs/${base}.wav`,
        id: m.id,
        text,
        speaker: m.speaker,
        language: m.lang,
        duration: Math.round(dur * 1000) / 1000,
        sample_rate: rate,
        peak_db: Math.round(m.peakDb * 10) / 10,
        speech_db: Math.round(m.speechDb * 10) / 10,
        noise_floor_db: Math.round(m.floorDb * 10) / 10,
        flags: m.flags,
        recorded: new Date(m.time).toISOString(),
      }));
      $("download-label").textContent = t("exporting", { p: Math.round(((i + 1) / takes.length) * 100) });
      if (i % 3 === 2) await new Promise((r) => setTimeout(r));
    }
    zip.add(root + "metadata.csv", enc.encode(csv.join("\n") + "\n"));
    zip.add(root + "metadata.jsonl", enc.encode(jsonl.join("\n") + "\n"));
    zip.add(root + "README.md", enc.encode(readme(takes.length, seconds, rate)));
    const url = URL.createObjectURL(zip.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: `${who}-${S.lang}-voicedataset.zip` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    say(String(e.message || e), true);
  } finally {
    S.exporting = false;
    renderExport();
  }
}

function readme(n, seconds, rate) {
  const d = S.data;
  const flagged = [...S.takes.values()].filter((m) => m.flags.some((f) => f !== "noisy")).length;
  return `# Voice dataset: ${S.name.trim()}

Recorded in the browser with https://voicedataset.cobanov.dev on ${new Date().toISOString().slice(0, 10)}.

- Speaker: ${S.name.trim()}
- Language: ${d.nativeName} (${d.code})
- Clips: ${n}, ${fmtDur(seconds)} in total
- Audio: WAV, 16-bit PCM, mono, ${rate} Hz; silence and key clicks trimmed, about 0.25 s of room tone kept at each end
- Sentences: voicedataset ${d.code} script, version ${d.version}, ${d.license}${S.set === "custom" ? ", plus the speaker's own sentences" : ""}
- Clips with warnings: ${flagged}

## Files

- \`wavs/\`: one WAV per sentence
- \`metadata.csv\`: LJSpeech format, \`file id|text|normalized text\` (the scripts already spell numbers out, so both text columns match)
- \`metadata.jsonl\`: one JSON object per clip with its duration, levels (dBFS) and warnings

## Warnings

- \`clip\`: peak above -1 dBFS, may be distorted
- \`quiet\`: peak below -24 dBFS
- \`early\`: speech was already under way when the take started; the first sound may be cut
- \`late\`: speech was still under way when the take stopped; the last sound may be cut
- \`noisy\`: noise floor above -45 dBFS or less than 20 dB below the speech

These are your own recordings. The consent clip (\`consent\`) states, in your voice, that you recorded them for a voice model.
`;
}

/* ---------- events ---------- */

function wire() {
  $("ui-lang").replaceChildren(...UI_LANGS.map(([code, name]) => Object.assign(document.createElement("option"), { value: code, textContent: code.toUpperCase(), title: name })));
  $("ui-lang").value = S.ui;
  $("ui-lang").addEventListener("change", (e) => {
    S.ui = e.target.value;
    local.set("ui", S.ui);
    e.target.blur();
    buildItems();
    renderAll();
    if (M.stream) describeMic(M.stream.getAudioTracks()[0]);
  });

  $("lang").replaceChildren(...S.langs.map((l) => Object.assign(document.createElement("option"), { value: l.code, textContent: l.nativeName })));
  $("lang").value = S.lang;
  $("lang").addEventListener("change", async (e) => {
    e.target.blur();
    if (M.recording) return;
    await loadLanguage(e.target.value);
    await refreshList();
  });

  $("name").value = S.name;
  let nameTimer = 0;
  $("name").addEventListener("input", (e) => {
    S.name = e.target.value;
    local.set("name", S.name);
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => refreshList({ keepId: S.items[S.idx]?.id }), 250);
  });
  $("name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.target.blur();
  });

  $("set").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-set]");
    if (!b || M.recording) return;
    S.set = b.dataset.set;
    local.set("set", S.set);
    if (e.detail) b.blur();
    await refreshList({ keepId: S.items[S.idx]?.id });
    if (S.set === "custom" && counts().custom <= 1) $("custom").focus();
  });

  $("custom").addEventListener("input", (e) => {
    const n = e.target.value.split("\n").filter((s) => s.trim()).length;
    $("custom-count").textContent = t(n === 1 ? "custom_count_one" : "custom_count", { n });
  });
  $("custom-use").addEventListener("click", async () => {
    const seen = new Set();
    const lines = $("custom").value.split("\n").map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s && !seen.has(s) && seen.add(s)).slice(0, 2000);
    local.set("custom." + S.lang, lines);
    await refreshList();
  });

  $("mic-btn").addEventListener("click", () => enableMic(local.get("mic", "") || undefined));
  $("mic").addEventListener("change", (e) => {
    e.target.blur();
    if (!M.recording) enableMic(e.target.value);
  });

  $("rec").addEventListener("click", (e) => {
    if (e.detail) e.currentTarget.blur();
    M.recording ? stopRec() : startRec();
  });
  $("play").addEventListener("click", (e) => {
    if (e.detail) e.currentTarget.blur();
    play();
  });
  $("prev").addEventListener("click", () => go(S.idx - 1));
  $("next").addEventListener("click", () => go(S.idx + 1));
  $("grid").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (b) go(Number(b.dataset.i));
  });
  $("download").addEventListener("click", exportZip);
  $("rate").addEventListener("change", (e) => local.set("rate", e.target.value));
  $("delete").addEventListener("click", async () => {
    const n = S.takes.size;
    const lang = S.langs.find((l) => l.code === S.lang)?.nativeName || S.lang;
    if (!n || !confirm(t("delete_confirm", { n, name: S.name.trim() || speaker(), lang }))) return;
    await store.removeScope(scope());
    await refreshList();
  });

  document.addEventListener("keydown", (e) => {
    const el = e.target;
    if (el.closest?.("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space") {
      e.preventDefault();
      if (e.repeat) return;
      M.recording ? stopRec() : startRec();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      go(S.idx + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(S.idx - 1);
    } else if (e.key === "p" || e.key === "P") {
      play();
    }
  });
  // Space on a focused button would also click it on key-up: the shortcut above already handled it.
  document.addEventListener("keyup", (e) => {
    if (e.code === "Space" && e.target.closest?.("button")) e.preventDefault();
  }, true);

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => !M.recording && drawTake(S.items[S.idx]), 100);
  });
  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    if (M.stream) listDevices(M.stream.getAudioTracks()[0]?.getSettings().deviceId);
  });
}

async function main() {
  S.ui = local.get("ui", null) || pickUiLang(navigator.languages || [navigator.language]);
  S.name = local.get("name", "");
  S.set = local.get("set", "quick");
  S.langs = (await (await fetch("languages/index.json")).json()).languages;
  const want = local.get("lang", null) || (S.langs.some((l) => l.code === S.ui) ? S.ui : "en");
  await loadLanguage(S.langs.some((l) => l.code === want) ? want : S.langs[0].code);
  wire();
  await refreshList();
}

main().catch((e) => say(String(e.message || e), true));
