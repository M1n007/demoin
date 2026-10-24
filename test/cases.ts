/**
 * Test cases from production runs.
 *
 * Every case here was born from a user video that really broke. The site is
 * imitated just enough in test/sites, and no AI is involved, so the cases can
 * be repeated without an API key, without internet, and always give the same
 * result. The test sites are in Indonesian on purpose: they prove the
 * heuristics do not depend on English UI text.
 *
 *   pnpm test                every case
 *   pnpm test popup          only cases whose name contains "popup"
 *
 * Adding a case: imitate the site in test/sites, write one entry in CASES
 * named after the production run it came from, then run it.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, Executor } from "../src/browser/executor.js";
import { presetOf } from "../src/preset.js";
import { snapshotPage, renderSnapshot, emptyRequiredFields, fieldsNamedInErrors } from "../src/browser/snapshot.js";
import { splitCredentials } from "../src/browser/credentials.js";
import { findTarget } from "../src/script/locator.js";

const SITES = fileURLToPath(new URL("./sites", import.meta.url));

// ---------------------------------------------------------------------------
// tools

function serve(dir: string): Promise<{ url: string; close: () => void }> {
  const srv = http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent((req.url ?? "/").split("?")[0]));
    if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<!doctype html><title>404 Not Found</title><h1>Not Found</h1>");
      return;
    }
    res.writeHead(200, { "content-type": p.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() })));
}

function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const fakeRecorder = { now: () => Date.now(), latest: async () => null } as never;

async function browser(device: "mobile" | "desktop" = "mobile") {
  const l = await launchBrowser(presetOf(device));
  return { ...l, close: () => l.browser.close().catch(() => {}) };
}

// ---------------------------------------------------------------------------
// cases

interface Case {
  name: string;
  /** the production run it came from */
  origin: string;
  run: (site: string) => Promise<string>;
}

const CASES: Case[] = [
  {
    name: "form-side-label",
    origin: "pos-app signup: Business Name read as \"Toko Saya\" from its placeholder",
    async run(site) {
      const b = await browser();
      try {
        await b.page.goto(`${site}/form-pos.html`);
        await b.page.fill("[name=owner_name]", "Budi Santoso");
        const s = await snapshotPage(b.page);
        const names = s.elements.filter((e) => e.tag === "input").map((e) => e.name);
        must(names.includes("Nama Bisnis") && names.includes("Subdomain"), `field names: ${names.join(", ")}`);
        const text = renderSnapshot(s);
        must(/"Nama Bisnis" \(EMPTY; the grey text "Toko Saya"/.test(text), "Nama Bisnis not marked EMPTY");
        must(emptyRequiredFields(s).length === 6, `${emptyRequiredFields(s).length} empty required fields, expected 6`);
        await b.page.click("#lanjut");
        const s2 = await snapshotPage(b.page);
        must(fieldsNamedInErrors(s2).some((e) => e.name === "Nama Bisnis"), `error message not linked to its field: ${s2.errors.join(" | ")}`);
        return "label read, EMPTY marked, error message linked to Nama Bisnis";
      } finally {
        await b.close();
      }
    },
  },
  {
    name: "click-shifting-button",
    origin: "pos-app signup: \"Mulai Gratis\" clicked three times with no result",
    async run(site) {
      const b = await browser();
      try {
        const ex = new Executor(b.page, fakeRecorder, [], "auto", presetOf("mobile"));
        (ex as unknown as { explain: () => Promise<number> }).explain = async () => 0;
        await b.page.goto(`${site}/geser.html`);
        let s = await snapshotPage(b.page);
        const button = s.elements.find((e) => e.name === "Mulai Gratis" && e.tag === "button")!;
        await ex.run({ kind: "click", ref: button.ref, narration: "x" }, s);
        must(b.page.url().endsWith("tujuan.html"), `did not change page: ${b.page.url()}`);
        await b.page.goto(`${site}/geser.html`);
        s = await snapshotPage(b.page);
        const card = s.elements.find((e) => e.name === "Free Trial")!;
        await ex.run({ kind: "click", ref: card.ref, narration: "x" }, s);
        const cls = await b.page.getAttribute("#kartu", "class");
        must(cls === "pilih", `card must be selected once, class: ${cls}`);
        return "click follows the shifting button; card not clicked twice";
      } finally {
        await b.close();
      }
    },
  },
  {
    name: "re-rendered-element",
    origin: "bot-dashboard: \"element e2 not found anymore\", agent stopped",
    async run(site) {
      const b = await browser("desktop");
      try {
        const ex = new Executor(b.page, fakeRecorder, [], "auto", presetOf("desktop"));
        (ex as unknown as { explain: () => Promise<number> }).explain = async () => 0;
        await b.page.goto(`${site}/gambar-ulang.html`);
        const s = await snapshotPage(b.page);
        const bots = s.elements.find((e) => e.name === "Bots")!;
        await new Promise((r) => setTimeout(r, 1500)); // the menu has been re-rendered twice by now
        const ev = await ex.run({ kind: "click", ref: bots.ref, narration: "x" }, s);
        must(ev.ok, `click failed: ${ev.error}`);
        must((await b.page.innerText("main")).includes("Daftar Bot"), "page did not change");
        return "element reacquired by its name and position";
      } finally {
        await b.close();
      }
    },
  },
  {
    name: "loading-screen",
    origin: "invitation-app: three \"Menyiapkan undangan…\" screens in the video",
    async run(site) {
      const b = await browser();
      try {
        const ex = new Executor(b.page, fakeRecorder, [], "auto", presetOf("mobile"));
        await b.page.goto(`${site}/memuat.html`);
        await (ex as unknown as { waitForLoaders: () => Promise<void> }).waitForLoaders();
        const body = await b.page.innerText("body");
        must(body.includes("Rina"), `still loading: ${body.slice(0, 60)}`);
        return "an action only counts as done once the loading text is gone";
      } finally {
        await b.close();
      }
    },
  },
  {
    name: "closed-phone-menu",
    origin: "invitation-app 9:16 replay: \"Harga\" clicked inside a shut <details> menu, step reported as done",
    async run(site) {
      const b = await browser("mobile");
      try {
        await b.page.goto(`${site}/menu-tertutup.html`);
        const closed = await snapshotPage(b.page);
        const leaked = closed.elements.filter((e) => /^(Harga|Koleksi desain)$/.test(e.name.trim()));
        must(!leaked.length, `links of the shut menu are listed: ${leaked.map((e) => e.ref).join(", ")}`);
        must(!findTarget(closed, { tag: "a", name: "Harga" }), "replay found a link nobody can see");
        const menu = closed.elements.find((e) => e.name === "Menu navigasi");
        must(menu, "the menu button itself must stay listed");

        const exec = new Executor(b.page, fakeRecorder, [], "none", presetOf("mobile"));
        await exec.run({ kind: "click", ref: menu.ref, narration: "" }, closed);
        const open = await snapshotPage(b.page);
        const harga = findTarget(open, { tag: "a", name: "Harga" });
        must(harga, "once the menu is open its links must be listed");
        await exec.run({ kind: "click", ref: harga.ref, narration: "" }, open);
        const y = await b.page.evaluate(() => scrollY);
        must(y > 1200, `the click should land on the pricing section, scrollY=${y}`);
        return "shut menu hidden from the agent and replay; opened menu works";
      } finally {
        await b.close();
      }
    },
  },
  {
    name: "credentials-in-goal",
    origin: "bot-dashboard, saas-app: email and password written in the goal",
    async run() {
      const a = splitCredentials("buatkan iklan web https://contoh.com email : orang@gmail.com dan password Rahasia@123!");
      must(a.credentials.length === 2 && !a.goal.includes("Rahasia") && a.goal.includes("{{PASSWORD}}"), JSON.stringify(a));
      const b = splitCredentials("Klik daftar, isi email demo1@mail.com dan password Demo12345 lalu kirim");
      must(b.credentials.length === 0, "a sign-up goal must not be moved into credentials");
      const c = splitCredentials("Log in to https://example.com with email jane@example.com and password is Secret#42, then open settings");
      must(c.credentials.length === 2 && !c.goal.includes("Secret") && !c.goal.includes("jane@") && c.credentials[0].value === "Secret#42", JSON.stringify(c));
      const d = splitCredentials("Sign up with email demo@mail.com and password Demo12345, then submit");
      must(d.credentials.length === 0, "an English sign-up goal must not be moved into credentials");
      return "password moved to credentials; sign-up goals left alone (Indonesian and English)";
    },
  },
];

// ---------------------------------------------------------------------------

const filter = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const selected = CASES.filter((k) => !filter.length || filter.some((s) => k.name.includes(s)));

async function main() {
  const server = await serve(SITES);
  let failed = 0;
  for (const k of selected) {
    const t0 = Date.now();
    try {
      const result = await k.run(server.url);
      console.log(`  pass  ${k.name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)  ${result}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${k.name}\n        origin: ${k.origin}\n        ${(e as Error).message.split("\n")[0]}`);
    }
  }
  server.close();
  console.log(`\n${selected.length - failed} of ${selected.length} cases passed`);
  process.exit(failed ? 1 : 0);
}
void main();
