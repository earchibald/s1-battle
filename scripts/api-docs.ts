/**
 * Builds docs/api/index.html: the guide (README.md), the HTTP reference (openapi.yaml) and the realtime
 * reference (asyncapi.yaml) as one static page. Also checks the specs: every $ref resolves, every operation is
 * well-formed, and every example in either spec validates against the schema it sits beside.
 *
 *   npx tsx scripts/api-docs.ts                 build docs/api/index.html
 *   npx tsx scripts/api-docs.ts --check         check only, write nothing
 *   npx tsx scripts/api-docs.ts --fragment f    also write the page without its <html> wrapper (for embedding)
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { parse } from "yaml";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;
type DocKey = "http" | "rt";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs/api");
const docs: Record<DocKey, Node> = {
  http: parse(readFileSync(path.join(DIR, "openapi.yaml"), "utf8")),
  rt: parse(readFileSync(path.join(DIR, "asyncapi.yaml"), "utf8")),
};
const readme = readFileSync(path.join(DIR, "README.md"), "utf8");
const problems: string[] = [];
const bad = (msg: string) => problems.push(msg);

/* ------------------------------------------------------------------------------------------------ */
/* References                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

interface Hit {
  node: Node;
  doc: DocKey;
  /** Last pointer segment: the schema or message name. */
  name: string;
  pointer: string;
}

function follow(ref: string, from: DocKey): Hit | null {
  const [file, pointer = ""] = ref.split("#");
  const doc: DocKey = file === "" ? from : file.endsWith("openapi.yaml") ? "http" : file.endsWith("asyncapi.yaml") ? "rt" : from;
  let node: Node = docs[doc];
  const parts = pointer.split("/").filter(Boolean).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  for (const p of parts) {
    if (node == null || typeof node !== "object" || !(p in node)) return null;
    node = node[p];
  }
  return { node, doc, name: parts[parts.length - 1] ?? "", pointer };
}

/** Resolve a chain of $refs. Returns the final node and the document it lives in. */
function deref(node: Node, doc: DocKey): { node: Node; doc: DocKey; name: string | null } {
  let name: string | null = null;
  let guard = 0;
  while (node && typeof node === "object" && typeof node.$ref === "string" && guard++ < 20) {
    const hit = follow(node.$ref, doc);
    if (!hit) {
      bad(`unresolved $ref ${node.$ref}`);
      return { node: {}, doc, name };
    }
    // Keys beside a $ref (a local description) are kept by the callers that care.
    node = hit.node;
    doc = hit.doc;
    name = hit.name;
  }
  return { node, doc, name };
}

function checkRefs(node: Node, doc: DocKey, where: string) {
  if (Array.isArray(node)) return node.forEach((n, i) => checkRefs(n, doc, `${where}[${i}]`));
  if (!node || typeof node !== "object") return;
  if (typeof node.$ref === "string" && !follow(node.$ref, doc)) bad(`${where}: unresolved $ref ${node.$ref}`);
  for (const [k, v] of Object.entries(node)) if (k !== "example" && k !== "examples") checkRefs(v, doc, `${where}/${k}`);
}

/* ------------------------------------------------------------------------------------------------ */
/* A small JSON Schema validator: enough to hold every example in the specs to its schema            */
/* ------------------------------------------------------------------------------------------------ */

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function validate(schemaIn: Node, value: unknown, doc: DocKey, at: string): string[] {
  const { node: s, doc: d } = deref(schemaIn, doc);
  if (!s || typeof s !== "object") return [];
  const errs: string[] = [];
  if (s.allOf) for (const part of s.allOf) errs.push(...validate(part, value, d, at));
  if (s.oneOf) {
    const tries = (s.oneOf as Node[]).map((part) => validate(part, value, d, at));
    if (!tries.some((t) => t.length === 0)) errs.push(`${at}: matches no oneOf branch (${tries.map((t) => t[0]).join(" | ")})`);
  }
  if ("const" in s && s.const !== value) errs.push(`${at}: expected ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(s.enum)}`);
  if (s.type) {
    const t = typeName(value);
    const ok = s.type === t || (s.type === "number" && t === "integer");
    if (!ok) return [...errs, `${at}: expected ${s.type}, got ${t}`];
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) errs.push(`${at}: below minimum ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) errs.push(`${at}: above maximum ${s.maximum}`);
  }
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) errs.push(`${at}: shorter than ${s.minLength}`);
    if (typeof s.maxLength === "number" && value.length > s.maxLength) errs.push(`${at}: longer than ${s.maxLength}`);
    if (s.pattern && !new RegExp(s.pattern).test(value)) errs.push(`${at}: does not match ${s.pattern}`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) errs.push(`${at}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems) errs.push(`${at}: more than ${s.maxItems} items`);
    if (s.items) value.forEach((v, i) => errs.push(...validate(s.items, v, d, `${at}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in obj)) errs.push(`${at}: missing ${k}`);
    for (const [k, v] of Object.entries(obj)) {
      if (s.properties?.[k]) errs.push(...validate(s.properties[k], v, d, `${at}.${k}`));
      else if (s.additionalProperties === false) errs.push(`${at}: unexpected ${k}`);
      else if (s.additionalProperties && typeof s.additionalProperties === "object") errs.push(...validate(s.additionalProperties, v, d, `${at}.${k}`));
    }
  }
  return errs;
}

/** Examples attached to a media type or a message: `example`, or `examples` as a map or a list. */
function examplesOf(holder: Node): { label: string; value: unknown }[] {
  const out: { label: string; value: unknown }[] = [];
  if (holder?.example !== undefined) out.push({ label: "", value: holder.example });
  const ex = holder?.examples;
  if (Array.isArray(ex)) for (const e of ex) out.push({ label: e.summary ?? "", value: e.payload ?? e.value ?? e });
  else if (ex && typeof ex === "object") for (const e of Object.values<Node>(ex)) out.push({ label: e.summary ?? "", value: e.value });
  return out;
}

/* ------------------------------------------------------------------------------------------------ */
/* HTML helpers                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

marked.setOptions({ gfm: true });
/** Markdown to HTML, with tables made scrollable. */
function md(text: string | undefined, inline = false): string {
  if (!text) return "";
  const html = inline ? (marked.parseInline(text.trim()) as string) : (marked.parse(text.trim()) as string);
  return html.replace(/<table>/g, '<div class="tw"><table>').replace(/<\/table>/g, "</table></div>");
}

/** JSON laid out the way a person would: short objects on one line, long ones broken. */
function pretty(v: unknown, indent = 0, width = 92): string {
  const flat = (x: unknown): string => {
    if (Array.isArray(x)) return x.length ? `[${x.map(flat).join(", ")}]` : "[]";
    if (x && typeof x === "object") {
      const e = Object.entries(x);
      return e.length ? `{ ${e.map(([k, val]) => `${JSON.stringify(k)}: ${flat(val)}`).join(", ")} }` : "{}";
    }
    return JSON.stringify(x);
  };
  const one = flat(v);
  if (v === null || typeof v !== "object" || indent + one.length <= width) return one;
  const pad = " ".repeat(indent + 2);
  if (Array.isArray(v)) return `[\n${v.map((x) => pad + pretty(x, indent + 2, width)).join(",\n")}\n${" ".repeat(indent)}]`;
  return `{\n${Object.entries(v)
    .map(([k, x]) => `${pad}${JSON.stringify(k)}: ${pretty(x, indent + 2 + k.length + 4, width).replace(/^\s+/, "")}`)
    .join(",\n")}\n${" ".repeat(indent)}}`;
}

function exampleBlocks(holder: Node): string {
  return examplesOf(holder)
    .map((e) => `<figure class="ex">${e.label ? `<figcaption>${esc(e.label)}</figcaption>` : ""}<pre><code>${esc(pretty(e.value))}</code></pre></figure>`)
    .join("");
}

/* ------------------------------------------------------------------------------------------------ */
/* Schemas                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

const schemaId = (name: string) => `s-${name}`;
const refLink = (name: string) => `<a class="ref" href="#${schemaId(name)}">${esc(name)}</a>`;
const isNamedSchema = (ref: string) => /components\/schemas\/[^/]+$/.test(ref);

/** A short description of a schema's type, with links to named schemas. */
function typeOf(s: Node, doc: DocKey): string {
  if (!s || typeof s !== "object") return "any";
  if (s.$ref) {
    const hit = follow(s.$ref, doc);
    return hit && isNamedSchema(s.$ref) ? refLink(hit.name) : esc(hit?.name ?? "?");
  }
  if (s.oneOf) return (s.oneOf as Node[]).map((x) => (x.title ? esc(x.title) : typeOf(x, doc))).join(" <span class=\"or\">or</span> ");
  if (s.allOf) return (s.allOf as Node[]).map((x) => typeOf(x, doc)).join(" + ");
  if ("const" in s) return `<code>${esc(JSON.stringify(s.const))}</code>`;
  if (s.type === "array") return `array of ${s.items ? typeOf(s.items, doc) : "any"}`;
  if (s.type === "object" || s.properties) {
    if (!s.properties && s.additionalProperties && typeof s.additionalProperties === "object") return `map of ${typeOf(s.additionalProperties, doc)}`;
    return "object";
  }
  if (s.enum) return `${esc(s.type ?? "string")} enum`;
  return esc(s.format ? `${s.type} (${s.format})` : (s.type ?? "any"));
}

function constraints(s: Node): string {
  const bits: string[] = [];
  if (s.enum) bits.push(`<span class="vals">${(s.enum as unknown[]).map((v) => `<code>${esc(v)}</code>`).join(" ")}</span>`);
  const range = (lo: unknown, hi: unknown, unit = "") => (lo !== undefined && hi !== undefined ? `${lo} to ${hi}${unit}` : lo !== undefined ? `at least ${lo}${unit}` : `at most ${hi}${unit}`);
  if (s.minimum !== undefined || s.maximum !== undefined) bits.push(range(s.minimum, s.maximum));
  if (s.minLength !== undefined || s.maxLength !== undefined) bits.push(range(s.minLength, s.maxLength, " characters"));
  if (s.minItems !== undefined || s.maxItems !== undefined) bits.push(s.minItems === s.maxItems ? `exactly ${s.minItems} items` : range(s.minItems, s.maxItems, " items"));
  if (s.pattern) bits.push(`matches <code>${esc(s.pattern)}</code>`);
  if (s.default !== undefined) bits.push(`default <code>${esc(JSON.stringify(s.default))}</code>`);
  if (s.examples?.length) bits.push(`e.g. ${(s.examples as unknown[]).slice(0, 3).map((v) => `<code>${esc(typeof v === "string" ? v : JSON.stringify(v))}</code>`).join(", ")}`);
  return bits.length ? `<div class="cons">${bits.join(" · ")}</div>` : "";
}

/** Does this schema have structure worth expanding under its row? */
function hasBody(s: Node): boolean {
  if (!s || typeof s !== "object" || s.$ref) return false;
  if (s.properties || s.allOf) return true;
  if (s.oneOf) return (s.oneOf as Node[]).some((x) => hasBody(x));
  if (s.type === "array") return hasBody(s.items);
  if (s.additionalProperties && typeof s.additionalProperties === "object") return hasBody(s.additionalProperties);
  return false;
}

/** Gather the properties of an object schema, following allOf (and the refs inside it) one level at a time. */
function collect(s: Node, doc: DocKey, depth = 0): { props: { key: string; schema: Node; required: boolean; doc: DocKey }[]; from: string[]; extra: Node | null; extraDoc: DocKey } {
  const out = { props: [] as { key: string; schema: Node; required: boolean; doc: DocKey }[], from: [] as string[], extra: null as Node | null, extraDoc: doc };
  const visit = (nodeIn: Node, dIn: DocKey, level: number) => {
    const { node, doc: d, name } = deref(nodeIn, dIn);
    if (name && level > 0) out.from.push(name);
    if (!node || typeof node !== "object" || level > 6) return;
    for (const part of node.allOf ?? []) visit(part, d, level + 1);
    for (const [key, schema] of Object.entries<Node>(node.properties ?? {})) {
      const row = { key, schema, required: (node.required ?? []).includes(key), doc: d };
      const i = out.props.findIndex((p) => p.key === key);
      if (i >= 0) out.props[i] = row;
      else out.props.push(row);
    }
    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      out.extra = node.additionalProperties;
      out.extraDoc = d;
    }
  };
  visit(s, doc, depth);
  return out;
}

function propRows(s: Node, doc: DocKey, depth: number): string {
  const { props, from, extra, extraDoc } = collect(s, doc);
  const rows = props.map((p) => {
    const local = p.schema ?? {};
    const target = deref(local, p.doc).node ?? {};
    const desc = local.description ?? target.description ?? "";
    const nested = hasBody(local) && depth < 5 ? `<details class="nest"><summary>fields</summary>${schemaBody(local, p.doc, depth + 1)}</details>` : "";
    return `<div class="prop"><div class="pk"><code>${esc(p.key)}</code>${p.required ? '<span class="req">required</span>' : ""}</div><div class="pt">${typeOf(local, p.doc)}</div><div class="pd">${md(desc)}${local.$ref && hasBody(target) ? "" : constraints(target)}${nested}</div></div>`;
  });
  if (extra) rows.push(`<div class="prop"><div class="pk"><code>&lt;key&gt;</code></div><div class="pt">${typeOf(extra, extraDoc)}</div><div class="pd">${md(extra.description)}${hasBody(extra) && depth < 5 ? `<details class="nest"><summary>fields</summary>${schemaBody(extra, extraDoc, depth + 1)}</details>` : ""}</div></div>`);
  const note = from.length ? `<p class="from">Includes every field of ${[...new Set(from)].map(refLink).join(", ")}.</p>` : "";
  return rows.length ? `${note}<div class="props">${rows.join("")}</div>` : note;
}

/** The expandable body of a schema: property rows, variants, or the item type of an array. */
function schemaBody(sIn: Node, doc: DocKey, depth = 0): string {
  if (!sIn || typeof sIn !== "object") return "";
  if (sIn.$ref) {
    const hit = follow(sIn.$ref, doc);
    if (hit && isNamedSchema(sIn.$ref)) return `<p class="from">${refLink(hit.name)}</p>${depth === 0 && hasBody(hit.node) ? schemaBody(hit.node, hit.doc, 1) : ""}`;
    const r = deref(sIn, doc);
    return schemaBody(r.node, r.doc, depth);
  }
  const s = sIn;
  if (s.oneOf) {
    const variants = (s.oneOf as Node[]).filter((x) => x.type !== "null");
    if (variants.every((x) => !hasBody(x))) return `<p class="from">${typeOf(s, doc)}</p>`;
    return `<div class="variants">${variants
      .map((x) => `<div class="variant"><div class="vt">${x.title ? esc(x.title) : typeOf(x, doc)}</div>${md(x.description)}${schemaBody(x, doc, depth + 1)}</div>`)
      .join("")}</div>`;
  }
  if (s.type === "array" && s.items) return hasBody(s.items) ? schemaBody(s.items, doc, depth) : `<p class="from">array of ${typeOf(s.items, doc)}</p>`;
  if (s.properties || s.allOf || s.additionalProperties) return propRows(s, doc, depth);
  return `<p class="from">${typeOf(s, doc)}</p>${constraints(s)}`;
}

/* ------------------------------------------------------------------------------------------------ */
/* HTTP reference                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
interface Op {
  id: string;
  method: string;
  path: string;
  op: Node;
  tag: string;
}

function operations(): Op[] {
  const api = docs.http;
  const tags = new Set((api.tags as Node[]).map((t) => t.name));
  const seen = new Set<string>();
  const out: Op[] = [];
  for (const [p, item] of Object.entries<Node>(api.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const where = `${method.toUpperCase()} ${p}`;
      if (!op.operationId) bad(`${where}: no operationId`);
      if (seen.has(op.operationId)) bad(`${where}: duplicate operationId ${op.operationId}`);
      seen.add(op.operationId);
      if (!["live", "partial", "proposed"].includes(op["x-status"])) bad(`${where}: x-status must be live, partial or proposed`);
      if (op["x-status"] !== "proposed" && !op["x-today"]) bad(`${where}: ${op["x-status"]} needs x-today`);
      if (!op.tags?.length || !tags.has(op.tags[0])) bad(`${where}: unknown tag`);
      const declared = new Set(((op.parameters ?? []) as Node[]).map((x) => deref(x, "http").node).filter((x) => x.in === "path").map((x) => x.name));
      for (const m of p.matchAll(/\{(\w+)\}/g)) if (!declared.has(m[1])) bad(`${where}: path parameter ${m[1]} is not declared`);
      for (const [code, r] of Object.entries<Node>(op.responses ?? {})) {
        const media = deref(r, "http").node.content?.["application/json"];
        for (const e of examplesOf(media)) for (const err of validate(media.schema, e.value, "http", `${where} ${code} example`)) bad(err);
      }
      const body = op.requestBody?.content?.["application/json"];
      for (const e of examplesOf(body)) for (const err of validate(body.schema, e.value, "http", `${where} request example`)) bad(err);
      out.push({ id: op.operationId, method, path: p, op, tag: op.tags?.[0] ?? "" });
    }
  }
  return out;
}

function authLine(op: Node): string {
  const sec: Node[] = op.security ?? docs.http.security ?? [];
  const named = sec.filter((s) => Object.keys(s).length);
  if (!named.length) return "None";
  const text = named
    .map((s) => {
      const [scheme, scopes] = Object.entries<string[]>(s)[0];
      const what = scheme === "adminToken" ? "<code>X-Admin-Token</code> header" : "Bearer";
      return scopes.length ? `${what}, scope ${scopes.map((x) => `<code>${esc(x)}</code>`).join(" ")}` : what;
    })
    .join(" or ");
  return named.length < sec.length ? `Optional. ${text}` : text;
}

function renderOp(o: Op): string {
  const { op } = o;
  const status = op["x-status"] as string;
  const params = ((op.parameters ?? []) as Node[]).map((x) => ({ local: x, ...deref(x, "http") }));
  const paramRows = params
    .map(({ node: p }) => {
      const s = p.schema ?? {};
      const target = deref(s, "http").node ?? {};
      return `<div class="prop"><div class="pk"><code>${esc(p.name)}</code>${p.required ? '<span class="req">required</span>' : ""}</div><div class="pt">${esc(p.in)} · ${typeOf(s, "http")}</div><div class="pd">${md(p.description ?? target.description)}${constraints(s.$ref ? {} : s)}</div></div>`;
    })
    .join("");
  const body = op.requestBody?.content?.["application/json"];
  const responses = Object.entries<Node>(op.responses ?? {})
    .map(([code, rIn]) => {
      const r = deref(rIn, "http").node;
      const media = r.content?.["application/json"];
      const headers = r.headers ? `<p class="from">Headers: ${Object.keys(r.headers).map((h) => `<code>${esc(h)}</code>`).join(", ")}</p>` : "";
      const inner = media ? `${schemaBody(media.schema, "http")}${exampleBlocks(media)}` : "";
      const cls = code.startsWith("2") || code.startsWith("3") ? "ok" : "err";
      return `<details class="resp ${cls}"${code === "200" ? " open" : ""}><summary><span class="code">${esc(code)}</span>${md(r.description, true)}</summary>${headers}${inner}</details>`;
    })
    .join("");
  const meta = [
    `<div><dt>Auth</dt><dd>${authLine(op)}</dd></div>`,
    op["x-today"] ? `<div><dt>Today</dt><dd>${md(String(op["x-today"]), true).replace(/^((?:GET|POST|PUT|DELETE) \/[^\s<(]*)/, "<code>$1</code>")}</dd></div>` : "",
    op["x-rate-limit"] ? `<div><dt>Rate limit</dt><dd>${esc(op["x-rate-limit"])}</dd></div>` : "",
  ].join("");
  return `<article class="op" id="op-${esc(o.id)}" data-status="${status}" data-text="${esc(`${o.method} ${o.path} ${op.summary} ${o.id}`.toLowerCase())}">
<header><span class="m m-${o.method}">${o.method.toUpperCase()}</span><code class="path">${esc(o.path).replace(/\{(\w+)\}/g, "<i>{$1}</i>")}</code><span class="st st-${status}">${status}</span></header>
<h4>${esc(op.summary)}</h4>
<dl class="meta">${meta}</dl>
${md(op.description)}
${paramRows ? `<h5>Parameters</h5><div class="props">${paramRows}</div>` : ""}
${body ? `<h5>Request body</h5>${schemaBody(body.schema, "http")}${exampleBlocks(body)}` : ""}
<h5>Responses</h5>${responses}
</article>`;
}

/* ------------------------------------------------------------------------------------------------ */
/* Realtime reference                                                                                */
/* ------------------------------------------------------------------------------------------------ */

interface Msg {
  key: string;
  name: string;
  node: Node;
  dir: "send" | "receive";
  channel: string;
}

function channelMessages(channelKey: string): Msg[] {
  const rt = docs.rt;
  const out: Msg[] = [];
  for (const [opKey, op] of Object.entries<Node>(rt.operations)) {
    if (follow(op.channel.$ref, "rt")?.name !== channelKey) continue;
    for (const ref of op.messages as Node[]) {
      const inChannel = follow(ref.$ref, "rt");
      if (!inChannel) {
        bad(`operation ${opKey}: unresolved message ${ref.$ref}`);
        continue;
      }
      const { node } = deref(inChannel.node, "rt");
      for (const e of examplesOf(node)) for (const err of validate(node.payload, e.value, "rt", `message ${node.name} example`)) bad(err);
      // The server receives what a client sends.
      out.push({ key: inChannel.name, name: node.name, node, dir: op.action === "receive" ? "send" : "receive", channel: channelKey });
    }
  }
  const listed = new Set(Object.keys(rt.channels[channelKey].messages));
  for (const m of out) listed.delete(m.key);
  for (const k of listed) bad(`channel ${channelKey}: message ${k} is in no operation`);
  return out;
}

const msgId = (m: Msg) => `msg-${m.channel}-${slug(m.name)}`;

function renderMsg(m: Msg): string {
  const n = m.node;
  return `<article class="op msg" id="${msgId(m)}" data-status="proposed" data-text="${esc(`${m.name} ${n.title ?? ""} ${m.channel}`.toLowerCase())}">
<header><span class="m m-${m.dir}">${m.dir === "send" ? "SEND" : "RECV"}</span><code class="path">${esc(m.name)}</code><span class="st st-proposed">proposed</span></header>
<h4>${esc(n.title ?? m.name)}</h4>
${n.summary ? `<p class="lede">${md(n.summary, true)}</p>` : ""}
${md(n.description)}
<h5>Payload</h5>${n.contentType === "application/octet-stream" ? '<p class="from">Binary frame, 5 bytes.</p>' : schemaBody(n.payload, "rt")}
${exampleBlocks(n)}
</article>`;
}

/* ------------------------------------------------------------------------------------------------ */
/* Page                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

function build(): { html: string; counts: Record<string, number>; ops: number; msgs: number; schemas: number } {
  checkRefs(docs.http, "http", "openapi");
  checkRefs(docs.rt, "rt", "asyncapi");
  const ops = operations();
  const counts: Record<string, number> = { live: 0, partial: 0, proposed: 0 };
  for (const o of ops) counts[o.op["x-status"]] = (counts[o.op["x-status"]] ?? 0) + 1;

  // Guide: the README without its repository-only parts, headings given ids.
  const guideNav: { id: string; text: string }[] = [];
  const guideHtml = md(readme.replace(/<!-- repo-only -->[\s\S]*?<!-- \/repo-only -->/g, ""))
    .replace(/<h1[^>]*>[\s\S]*?<\/h1>/, "")
    .replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_m, level: string, inner: string) => {
      const id = `g-${slug(inner)}`;
      if (level === "2") guideNav.push({ id, text: inner.replace(/<[^>]+>/g, "") });
      return `<h${level} id="${id}">${inner}</h${level}>`;
    })
    .replace(/<a href="(?!https?:|#)[^"]*">([\s\S]*?)<\/a>/g, "$1");

  const tags = docs.http.tags as Node[];
  const httpHtml = tags
    .map((t) => {
      const mine = ops.filter((o) => o.tag === t.name);
      return `<section class="group" id="t-${slug(t.name)}"><h3>${esc(t.name)}</h3>${md(t.description)}${mine.map(renderOp).join("")}</section>`;
    })
    .join("");

  const channels = Object.entries<Node>(docs.rt.channels);
  const msgNames = new Set<string>();
  const rtNav: string[] = [];
  const rtHtml = channels
    .map(([key, ch]) => {
      const msgs = channelMessages(key);
      for (const m of msgs) msgNames.add(m.name);
      const send = msgs.filter((m) => m.dir === "send");
      const recv = msgs.filter((m) => m.dir === "receive");
      const params = Object.entries<Node>(ch.parameters ?? {})
        .map(([k, p]) => `<div class="prop"><div class="pk"><code>${esc(k)}</code><span class="req">required</span></div><div class="pt">path</div><div class="pd">${md(p.description)}</div></div>`)
        .join("");
      rtNav.push(`<li class="navh"><a href="#ch-${key}">${esc(ch.title)}</a></li>${msgs.map((m) => `<li data-status="proposed" data-text="${esc(`${m.name} ${m.node.title ?? ""}`.toLowerCase())}"><a href="#${msgId(m)}"><span class="m m-${m.dir}">${m.dir === "send" ? "SEND" : "RECV"}</span>${esc(m.name)}</a></li>`).join("")}`);
      return `<section class="group" id="ch-${key}"><h3>${esc(ch.title)}</h3>
<p class="addr"><span class="m m-ws">WS</span><code class="path">${esc(docs.rt.servers.local.pathname + ch.address).replace(/\{(\w+)\}/g, "<i>{$1}</i>")}</code></p>
${md(ch.description)}
${params ? `<h5>Parameters</h5><div class="props">${params}</div>` : ""}
<h4 class="dir">You send</h4>${send.map(renderMsg).join("")}
<h4 class="dir">You receive</h4>${recv.map(renderMsg).join("")}
</section>`;
    })
    .join("");

  const schemaList: { name: string; node: Node; doc: DocKey }[] = [
    ...Object.entries<Node>(docs.http.components.schemas).map(([name, node]) => ({ name, node, doc: "http" as DocKey })),
    ...Object.entries<Node>(docs.rt.components.schemas ?? {}).map(([name, node]) => ({ name, node, doc: "rt" as DocKey })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const schemasHtml = schemaList
    .map(
      ({ name, node, doc }) =>
        `<article class="schema" id="${schemaId(name)}" data-text="${esc(name.toLowerCase())}"><h4><code>${esc(name)}</code><span class="ty">${node.oneOf && !hasBody(node) ? "" : typeOf({ ...node, $ref: undefined }, doc)}</span></h4>${md(node.description)}${node.oneOf && !hasBody(node) ? `<p class="from">${typeOf(node, doc)}</p>` : hasBody(node) ? schemaBody(node, doc) : constraints(node)}</article>`,
    )
    .join("");

  const nav = `
<div class="navgroup"><h2>Guide</h2><ul>${guideNav.map((g) => `<li><a href="#${g.id}">${esc(g.text)}</a></li>`).join("")}</ul></div>
<div class="navgroup"><h2>HTTP</h2><ul>${tags
    .map((t) => `<li class="navh"><a href="#t-${slug(t.name)}">${esc(t.name)}</a></li>${ops.filter((o) => o.tag === t.name).map((o) => `<li data-status="${o.op["x-status"]}" data-text="${esc(`${o.method} ${o.path} ${o.op.summary}`.toLowerCase())}"><a href="#op-${o.id}"><span class="m m-${o.method}">${o.method === "delete" ? "DEL" : o.method.toUpperCase()}</span>${esc(o.op.summary)}</a></li>`).join("")}`)
    .join("")}</ul></div>
<div class="navgroup"><h2>Realtime</h2><ul>${rtNav.join("")}</ul></div>
<div class="navgroup"><h2>Schemas</h2><ul><li><a href="#schemas">All ${schemaList.length} schemas</a></li></ul></div>`;

  const info = docs.http.info;
  const html = `<title>S1 Arena API</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=Saira+Condensed:wght@500;600;700&display=swap">
<style>${CSS}</style>
<div class="top"><div class="topin">
  <div class="brand"><span class="mark">S1 ARENA</span><span class="what">API</span><span class="ver">v${esc(info.version)}</span></div>
  <p class="sum">${esc(info.summary)}</p>
  <ul class="tally">
    <li><b>${ops.length}</b> HTTP operations</li><li><b>${msgNames.size}</b> message types on ${channels.length} sockets</li>
    <li><span class="st st-live">live</span> <b>${counts.live}</b></li><li><span class="st st-partial">partial</span> <b>${counts.partial}</b></li><li><span class="st st-proposed">proposed</span> <b>${counts.proposed}</b> + all sockets</li>
  </ul>
</div></div>
<div class="shell">
<aside class="side" id="side">
  <div class="tools">
    <label class="sr" for="q">Filter operations, messages and schemas</label>
    <input id="q" type="search" placeholder="Filter: bets, intent, WorldState…" autocomplete="off">
    <div class="chips" role="group" aria-label="Show by status">
      <button type="button" id="f-all" data-f="all" aria-pressed="true">All</button>
      <button type="button" id="f-live" data-f="live" aria-pressed="false">Live today</button>
      <button type="button" id="f-proposed" data-f="proposed" aria-pressed="false">Proposed</button>
    </div>
    <button type="button" class="navtoggle" id="navtoggle" aria-expanded="false" aria-controls="nav">Contents</button>
  </div>
  <nav id="nav" aria-label="Contents">${nav}</nav>
</aside>
<main>
  <section class="guide" id="guide">${guideHtml}</section>
  <section class="ref" id="http"><h2>HTTP reference</h2>
    <p class="lede">Base path <code>/api/v1</code>. Specified in <code>openapi.yaml</code> (OpenAPI ${esc(docs.http.openapi)}).</p>${httpHtml}</section>
  <section class="ref" id="realtime"><h2>Realtime reference</h2>
    <p class="lede">WebSocket, base path <code>/api/v1</code>. Specified in <code>asyncapi.yaml</code> (AsyncAPI ${esc(docs.rt.asyncapi)}). Every message is a JSON object with a <code>type</code>.</p>
    ${md(docs.rt.info.description.split("\n\n").slice(1).join("\n\n"))}${rtHtml}</section>
  <section class="ref" id="schemas"><h2>Schemas</h2>
    <p class="lede">Every named type in both specs, alphabetically.</p>${schemasHtml}</section>
  <p class="none" id="none" hidden>Nothing matches that filter.</p>
</main>
</div>
<a class="totop" href="#side">Contents</a>
<script>${JS}</script>`;
  return { html, counts, ops: ops.length, msgs: msgNames.size, schemas: schemaList.length };
}

const CSS = `
/* Layout: a sticky contents rail beside one long reference column; on a phone the rail folds into a bar. */
:root{
  --bg:#eef0ed; --surface:#fafbf9; --sunk:#e3e7e3; --ink:#16201d; --muted:#55625d; --line:#cbd3ce;
  --accent:#c2480a; --link:#0b5f8a; --code:#22302c;
  --get:#0b6aa2; --post:#1f7a3d; --put:#8a5a00; --delete:#b3261e; --ws:#6b3fa0;
  --live:#1f7a3d; --partial:#8a5a00; --proposed:#5b6770;
  --display:"Saira Condensed","Arial Narrow",Impact,sans-serif;
  --body:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
  --bg:#111615; --surface:#19201e; --sunk:#0c100f; --ink:#e3eae6; --muted:#93a19b; --line:#2b3633;
  --accent:#ff8f4a; --link:#6cc4ee; --code:#d5dfda;
  --get:#62b6e6; --post:#62c98a; --put:#e0b04a; --delete:#f0857d; --ws:#b99ae6;
  --live:#62c98a; --partial:#e0b04a; --proposed:#9aa7ae; color-scheme:dark } }
:root[data-theme="dark"]{
  --bg:#111615; --surface:#19201e; --sunk:#0c100f; --ink:#e3eae6; --muted:#93a19b; --line:#2b3633;
  --accent:#ff8f4a; --link:#6cc4ee; --code:#d5dfda;
  --get:#62b6e6; --post:#62c98a; --put:#e0b04a; --delete:#f0857d; --ws:#b99ae6;
  --live:#62c98a; --partial:#e0b04a; --proposed:#9aa7ae; color-scheme:dark }
*{box-sizing:border-box}
html{scroll-behavior:smooth}
@media (prefers-reduced-motion: reduce){ html{scroll-behavior:auto} }
body{background:var(--bg);color:var(--ink);font:15px/1.6 var(--body);margin:0;-webkit-text-size-adjust:100%}
a{color:var(--link);text-decoration-thickness:1px;text-underline-offset:2px}
a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
code,pre{font-family:var(--mono);font-size:.875em}
code{color:var(--code);overflow-wrap:anywhere}
pre{background:var(--sunk);border:1px solid var(--line);border-radius:4px;padding:12px 14px;overflow-x:auto;line-height:1.5;margin:0}
pre code{overflow-wrap:normal;font-size:12.5px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}

/* The top band. Its lower edge is a tick ruler: one mark per tick, a long one every sixth. */
.top{background:var(--surface);border-bottom:1px solid var(--line);position:relative}
.top::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:7px;
  background:
    repeating-linear-gradient(90deg,var(--accent) 0 1px,transparent 1px 60px) left bottom/100% 7px no-repeat,
    repeating-linear-gradient(90deg,var(--muted) 0 1px,transparent 1px 10px) left bottom/100% 3px no-repeat}
.topin{max-width:1280px;margin:0 auto;padding-block:22px 24px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.brand{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;font-family:var(--display);line-height:1}
.mark{font-size:40px;font-weight:700;letter-spacing:.02em}
.what{font-size:40px;font-weight:500;color:var(--accent)}
.ver{font-family:var(--mono);font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:3px;padding:3px 6px}
.sum{margin:8px 0 12px;color:var(--muted);max-width:60ch}
.tally{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:var(--muted)}
.tally b{color:var(--ink);font-variant-numeric:tabular-nums}

.shell{max-width:1280px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr)}
.side{padding-block:14px 0;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));min-width:0}
main{padding-block:8px 80px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));min-width:0}
.tools{display:flex;flex-direction:column;gap:8px}
#q{width:100%;font:14px var(--body);color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:8px 10px}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chips button,.navtoggle{font:500 12.5px var(--body);color:var(--muted);background:transparent;border:1px solid var(--line);border-radius:3px;padding:5px 9px;cursor:pointer}
.chips button[aria-pressed="true"]{color:var(--surface);background:var(--ink);border-color:var(--ink)}
.navtoggle{align-self:flex-start}
#nav{display:none;padding-bottom:10px}
#nav.open{display:block}
.navgroup h2{font:600 13px var(--display);letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin:18px 0 6px}
.navgroup ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.navgroup li a{display:flex;gap:7px;align-items:baseline;padding:3px 0;color:var(--ink);text-decoration:none;font-size:13.5px;line-height:1.35}
.navgroup li a:hover{color:var(--link)}
.navgroup li.navh a{font-weight:600;margin-top:8px}
.totop{position:fixed;right:max(14px,env(safe-area-inset-right,0px));bottom:calc(14px + env(safe-area-inset-bottom,0px));font:500 12.5px var(--body);background:var(--ink);color:var(--surface);padding:7px 11px;border-radius:3px;text-decoration:none;z-index:5}
@media (min-width:980px){
  .shell{grid-template-columns:290px minmax(0,1fr)}
  .side{position:sticky;top:0;align-self:start;max-height:100vh;overflow-y:auto;padding-right:14px;padding-block:20px 24px;border-right:1px solid var(--line)}
  main{padding-left:36px}
  #nav{display:block}
  .navtoggle,.totop{display:none}
}

/* Method and status marks */
.m{font:500 10.5px/1 var(--mono);letter-spacing:.04em;padding:3px 5px;border-radius:2px;border:1px solid currentColor;flex:none;min-width:38px;text-align:center}
.m-get{color:var(--get)} .m-post{color:var(--post)} .m-put,.m-patch{color:var(--put)} .m-delete{color:var(--delete)}
.m-send{color:var(--post)} .m-receive{color:var(--get)} .m-ws{color:var(--ws)}
.st{font:600 11px/1 var(--display);letter-spacing:.1em;text-transform:uppercase;padding:3px 6px;border-radius:2px;white-space:nowrap}
.st-live{background:var(--live);color:var(--surface)}
.st-partial{background:transparent;color:var(--partial);box-shadow:inset 0 0 0 1px var(--partial)}
.st-proposed{background:transparent;color:var(--proposed);box-shadow:inset 0 0 0 1px var(--proposed)}

/* Running text */
main h2{font:700 30px/1.1 var(--display);letter-spacing:.01em;text-wrap:balance;margin:44px 0 10px;padding-top:14px;border-top:2px solid var(--ink);scroll-margin-top:8px}
.guide>h2:first-child,.guide>p:first-child{margin-top:20px}
main h3{font:600 22px/1.15 var(--display);letter-spacing:.01em;text-wrap:balance;margin:32px 0 8px;scroll-margin-top:8px}
main h4{font:600 16px/1.3 var(--body);margin:14px 0 6px}
main h5{font:600 12px var(--display);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:18px 0 6px}
.guide p,.guide li,.op>p,.group>p,.schema>p,.lede{max-width:72ch}
.guide ul,.guide ol{padding-left:22px}
.guide li{margin:3px 0}
.guide pre{margin:12px 0}
.lede{color:var(--muted)}
.tw{overflow-x:auto;margin:12px 0}
table{border-collapse:collapse;font-size:13.5px;min-width:100%}
th,td{text-align:left;vertical-align:top;padding:7px 12px 7px 0;border-bottom:1px solid var(--line)}
th{font:600 12px var(--display);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
td{font-variant-numeric:tabular-nums}

/* Operations and messages */
.group{margin-top:8px}
.op,.schema{background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:16px 18px;margin:14px 0;min-width:0;scroll-margin-top:10px}
.op>header{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.path{font-size:14px;font-weight:500;min-width:0}
.path i{font-style:normal;color:var(--accent)}
.op>header .st{margin-left:auto}
.addr{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:6px 0}
.meta{display:flex;flex-direction:column;gap:3px;margin:8px 0;font-size:13.5px}
.meta div{display:flex;gap:10px}
.meta dt{flex:none;width:76px;font:600 11.5px/1.9 var(--display);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.meta dd{margin:0;min-width:0}
h4.dir{font:600 13px var(--display);letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:26px 0 0}
.schema h4{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin:0 0 4px}
.schema h4 code{font-size:15px}
.ty{font:400 13px var(--body);color:var(--muted)}

/* Property rows */
.props{border-top:1px solid var(--line);font-size:13.5px}
.prop{display:grid;grid-template-columns:minmax(0,1fr);gap:2px;padding:8px 0;border-bottom:1px solid var(--line)}
@media (min-width:700px){ .prop{grid-template-columns:minmax(0,190px) minmax(0,170px) minmax(0,1fr);gap:14px} }
.pk{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;min-width:0}
.pk code{font-weight:500}
.req{font:600 10px var(--display);letter-spacing:.1em;text-transform:uppercase;color:var(--accent)}
.pt{color:var(--muted);min-width:0;overflow-wrap:anywhere}
.or{font-size:.9em;opacity:.8}
.pd{min-width:0}
.pd p{margin:0 0 4px}
.pd ul{margin:4px 0;padding-left:18px}
.cons{color:var(--muted);font-size:12.5px}
.vals{display:inline-flex;gap:4px;flex-wrap:wrap}
.vals code{background:var(--sunk);border-radius:2px;padding:0 4px}
.from{color:var(--muted);font-size:13.5px;margin:6px 0}
.nest{margin-top:6px}
.nest>summary,.resp>summary{cursor:pointer}
.nest>summary{font-size:12.5px;color:var(--link)}
.nest .props{margin-top:6px;border-left:2px solid var(--line);padding-left:12px}
.nest .prop{grid-template-columns:minmax(0,1fr);gap:2px}
.variants{display:flex;flex-direction:column;gap:12px;margin:8px 0}
.variant{border-left:2px solid var(--line);padding-left:12px;min-width:0}
.vt{font-weight:600;font-size:13.5px}
.resp{border-top:1px solid var(--line);padding:8px 0}
.resp>summary{display:flex;gap:10px;align-items:baseline;font-size:13.5px}
.resp .code{font:500 12.5px var(--mono);flex:none}
.resp.ok .code{color:var(--live)} .resp.err .code{color:var(--delete)}
.resp[open]>summary{margin-bottom:8px}
.ex{margin:10px 0 0;min-width:0}
.ex figcaption{font-size:12.5px;color:var(--muted);margin-bottom:4px}
.none{color:var(--muted);padding:40px 0}
`;

const JS = `
(function(){
  var q=document.getElementById('q'), nav=document.getElementById('nav'), toggle=document.getElementById('navtoggle');
  var none=document.getElementById('none'), status='all';
  var items=[].slice.call(document.querySelectorAll('main .op, main .schema, #nav li[data-text]'));
  function apply(){
    var text=(q.value||'').trim().toLowerCase(), shown=0;
    items.forEach(function(el){
      var st=el.getAttribute('data-status');
      var okStatus = status==='all' ? true : !st ? false : (status==='live' ? st!=='proposed' : st==='proposed');
      var ok = okStatus && (!text || (el.getAttribute('data-text')||'').indexOf(text)>=0);
      el.hidden=!ok; if(ok && el.tagName!=='LI') shown++;
    });
    var filtering = !!text || status!=='all';
    document.getElementById('guide').hidden = !!text;
    [].forEach.call(document.querySelectorAll('main .group'),function(g){ g.hidden = filtering && !g.querySelector('.op:not([hidden])'); });
    [].forEach.call(document.querySelectorAll('main h4.dir'),function(h){ var n=h.nextElementSibling, any=false; while(n && n.classList.contains('op')){ if(!n.hidden) any=true; n=n.nextElementSibling; } h.hidden=!any; });
    none.hidden = shown>0;
  }
  q.addEventListener('input',apply);
  [].forEach.call(document.querySelectorAll('.chips button'),function(b){
    b.addEventListener('click',function(){
      status=b.getAttribute('data-f');
      [].forEach.call(document.querySelectorAll('.chips button'),function(x){ x.setAttribute('aria-pressed', String(x===b)); });
      apply();
    });
  });
  toggle.addEventListener('click',function(){ var open=nav.classList.toggle('open'); toggle.setAttribute('aria-expanded',String(open)); });
  nav.addEventListener('click',function(e){ if(e.target.closest('a') && window.matchMedia('(max-width:979px)').matches){ nav.classList.remove('open'); toggle.setAttribute('aria-expanded','false'); } });
  // A link to something hidden by the filter clears the filter first.
  window.addEventListener('hashchange',function(){ var el=document.getElementById(location.hash.slice(1)); if(el && (el.hidden || (el.closest('[hidden]')))){ q.value=''; status='all'; [].forEach.call(document.querySelectorAll('.chips button'),function(x){ x.setAttribute('aria-pressed', String(x.getAttribute('data-f')==='all')); }); apply(); el.scrollIntoView(); } });
})();
`;

/* ------------------------------------------------------------------------------------------------ */

const args = process.argv.slice(2);
const out = build();
if (problems.length) {
  console.error(`${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`specs ok: ${out.ops} HTTP operations (${out.counts.live} live, ${out.counts.partial} partial, ${out.counts.proposed} proposed), ${out.msgs} socket message types, ${out.schemas} schemas; every $ref resolves and every example validates`);
if (!args.includes("--check")) {
  const page = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${out.html}\n</body>\n</html>\n`;
  writeFileSync(path.join(DIR, "index.html"), page);
  console.log(`wrote docs/api/index.html (${Math.round(page.length / 1024)} kB)`);
  const i = args.indexOf("--fragment");
  if (i >= 0 && args[i + 1]) {
    writeFileSync(path.resolve(args[i + 1]), out.html);
    console.log(`wrote ${args[i + 1]}`);
  }
}
