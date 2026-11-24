// Checks every reading script in website/languages: node scripts/validate.mjs
// No dependencies. Exits non-zero when a file breaks a rule, so CI can run it on pull requests.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("../website/languages/", import.meta.url).pathname;
const errors = [];
const warnings = [];
const err = (f, m) => errors.push(`${f}: ${m}`);
const warn = (f, m) => warnings.push(`${f}: ${m}`);

const read = (f) => {
  try {
    return JSON.parse(readFileSync(join(dir, f), "utf8"));
  } catch (e) {
    err(f, `not valid JSON (${e.message})`);
    return null;
  }
};

const index = read("index.json");
const listed = new Set();
if (index) {
  if (!Array.isArray(index.languages)) err("index.json", '"languages" must be a list');
  for (const l of index.languages || []) {
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(l.code || "")) err("index.json", `bad code ${JSON.stringify(l.code)}`);
    if (!l.name || !l.nativeName) err("index.json", `${l.code}: needs "name" and "nativeName"`);
    if (listed.has(l.code)) err("index.json", `${l.code} listed twice`);
    listed.add(l.code);
  }
}

const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
for (const code of listed) if (!files.includes(`${code}.json`)) err("index.json", `${code} is listed but ${code}.json is missing`);

for (const f of files) {
  const d = read(f);
  if (!d) continue;
  const code = f.replace(/\.json$/, "");
  if (!listed.has(code)) err(f, "not listed in index.json");
  if (d.code !== code) err(f, `"code" is ${JSON.stringify(d.code)}, expected "${code}"`);
  for (const k of ["name", "nativeName", "version", "license", "consent"]) if (typeof d[k] !== "string" || !d[k].trim()) err(f, `"${k}" is missing`);
  if (d.license && d.license !== "CC0-1.0") err(f, 'sentences must be released as "CC0-1.0"');
  if (d.consent && !d.consent.includes("{name}")) err(f, 'the consent line must contain "{name}"');
  if (!Array.isArray(d.parts) || !d.parts.length) {
    err(f, '"parts" must be a non-empty list');
    continue;
  }
  const ids = new Set();
  const seen = new Map();
  let total = 0;
  d.parts.forEach((p, pi) => {
    const where = `part ${pi + 1}`;
    if (!/^[a-z0-9]{1,12}$/.test(p.id || "")) err(f, `${where}: "id" must be short lowercase letters and digits`);
    if (ids.has(p.id)) err(f, `${where}: id "${p.id}" used twice`);
    ids.add(p.id);
    if (!p.title) err(f, `${where}: "title" is missing`);
    if (!Array.isArray(p.lines) || !p.lines.length) return err(f, `${where}: "lines" must be a non-empty list`);
    p.lines.forEach((line, li) => {
      const at = `${p.id} line ${li + 1}`;
      if (typeof line !== "string" || !line.trim()) return err(f, `${at}: empty`);
      if (line !== line.trim() || /\s{2,}|\n/.test(line)) err(f, `${at}: stray whitespace or line break`);
      if (/\|/.test(line)) err(f, `${at}: "|" is the metadata separator and cannot appear in a sentence`);
      if (/\d/.test(line)) warn(f, `${at}: has digits; spell numbers out so the text matches what is said`);
      const words = line.split(/\s+/).length;
      if (words < 3 || words > 40) warn(f, `${at}: ${words} words (aim for 8–25)`);
      const norm = line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      if (seen.has(norm)) err(f, `${at}: same sentence as ${seen.get(norm)}`);
      seen.set(norm, at);
      total++;
    });
  });
  if (d.quick !== undefined) {
    if (!Array.isArray(d.quick)) err(f, '"quick" must be a list of sentence ids such as "p1_01"');
    else {
      const all = new Set(d.parts.flatMap((p) => (p.lines || []).map((_, i) => `${p.id}_${String(i + 1).padStart(2, "0")}`)));
      for (const id of d.quick) if (!all.has(id)) err(f, `quick: unknown sentence id "${id}"`);
    }
  }
  console.log(`${f}: ${d.parts.length} parts, ${total} sentences`);
}

for (const w of warnings) console.warn("warning  " + w);
for (const e of errors) console.error("error    " + e);
if (errors.length) process.exit(1);
console.log(errors.length || warnings.length ? `${warnings.length} warnings` : "all good");
