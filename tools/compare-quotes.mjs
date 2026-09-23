// Does rewriting curly quotes to straight ones before translation help the engine? (G-54)
//
// Takes the FLORES-200 devtest sentences that contain curly quotes or apostrophes (“ ” „ ‘ ’) in a
// source language, translates each twice with Bergamot through the built extension, once as written
// and once with those characters made straight, and scores both against the English reference with
// chrF. Quote marks are made straight in hypotheses and references alike before scoring, so the
// figure measures the translation, not which quote style came out. Glossa's own text preparation
// (soft hyphens, spacing at the edges) leaves quote marks alone, so the variants are the only difference.
//
//   npm run build -- --smoke
//   GLOSSA_CHROMIUM_PATH=... node tools/compare-quotes.mjs [fr de pl]
//
// Downloads FLORES-200 (25 MB, CC BY-SA 4.0) into .tmp/ once, and a model per pair.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, ".tmp");
const floresDir = path.join(tmp, "flores200_dataset", "devtest");
// GLOSSA_EXTENSION_PATH points at a copy of the build, so a rebuild meanwhile cannot pull it away.
const extensionPath = process.env.GLOSSA_EXTENSION_PATH ?? path.join(root, "dist", "chrome-smoke");
const FLORES_CODES = { fr: "fra_Latn", de: "deu_Latn", pl: "pol_Latn", it: "ita_Latn", es: "spa_Latn", pt: "por_Latn", nl: "nld_Latn" };
const sources = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["fr", "de", "pl"];
const CURLY = /[“”„‟‘’‚‛]/u;

const straighten = (text) => text.replace(/[“”„‟]/gu, '"').replace(/[‘’‚‛]/gu, "'");
const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeHtml = (text) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");

// chrF (character 6-grams, beta 2, whitespace dropped), the way sacrebleu computes it at corpus
// level: n-gram statistics summed over every sentence, then one F-score averaged over n.
function ngrams(text, n) {
  const counts = new Map();
  for (let i = 0; i + n <= text.length; i++) {
    const gram = text.slice(i, i + n);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}
function chrf(hypotheses, references) {
  const order = 6;
  const beta = 2;
  const totals = Array.from({ length: order }, () => ({ match: 0, hyp: 0, ref: 0 }));
  hypotheses.forEach((hypothesis, index) => {
    const hyp = straighten(hypothesis).replace(/\s+/gu, "");
    const ref = straighten(references[index]).replace(/\s+/gu, "");
    for (let n = 1; n <= order; n++) {
      const h = ngrams(hyp, n);
      const r = ngrams(ref, n);
      let match = 0;
      for (const [gram, count] of h) match += Math.min(count, r.get(gram) ?? 0);
      totals[n - 1].match += match;
      totals[n - 1].hyp += Math.max(0, hyp.length - n + 1);
      totals[n - 1].ref += Math.max(0, ref.length - n + 1);
    }
  });
  let precision = 0;
  let recall = 0;
  for (const total of totals) {
    precision += total.hyp > 0 ? total.match / total.hyp : 0;
    recall += total.ref > 0 ? total.match / total.ref : 0;
  }
  precision /= order;
  recall /= order;
  if (precision + recall === 0) return 0;
  return (100 * (1 + beta ** 2) * precision * recall) / (beta ** 2 * precision + recall);
}

async function flores() {
  if (existsSync(floresDir)) return;
  await mkdir(tmp, { recursive: true });
  const archive = path.join(tmp, "flores200_dataset.tar.gz");
  const response = await fetch("https://dl.fbaipublicfiles.com/nllb/flores200_dataset.tar.gz");
  if (!response.ok) throw new Error(`FLORES-200: HTTP ${response.status}`);
  await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
  // Relative paths: GNU tar reads the "C:" of a Windows path as a remote host.
  execFileSync("tar", ["-xzf", path.basename(archive), "./flores200_dataset/devtest/"], { cwd: tmp });
  await rm(archive);
}

async function main() {
  await flores();
  const english = (await readFile(path.join(floresDir, "eng_Latn.devtest"), "utf8")).split("\n");
  const executablePath = process.env.GLOSSA_CHROMIUM_PATH;
  const profile = path.join(tmp, "compare-quotes-profile");
  await rm(profile, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(profile, {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20_000 });
    const ui = await context.newPage();
    await ui.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    const session = await context.browser().newBrowserCDPSession();
    let nextId = 1;
    const waiting = new Map();
    session.on("Target.receivedMessageFromTarget", ({ message }) => {
      const parsed = JSON.parse(message);
      waiting.get(parsed.id)?.(parsed);
      waiting.delete(parsed.id);
    });
    const inOffscreen = async (expression) => {
      const { targetInfos } = await session.send("Target.getTargets");
      const target = targetInfos.find((info) => info.url.endsWith("/offscreen.html"));
      if (!target) throw new Error("the engine's document is not open");
      const { sessionId } = await session.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
      const id = nextId++;
      const reply = new Promise((resolve) => waiting.set(id, resolve));
      await session.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })
      });
      const answer = await reply;
      await session.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      if (answer.result?.exceptionDetails) throw new Error(answer.result.exceptionDetails.exception?.description ?? "evaluation failed");
      return answer.result?.result?.value;
    };

    const rows = [];
    for (const source of sources) {
      const lines = (await readFile(path.join(floresDir, `${FLORES_CODES[source]}.devtest`), "utf8")).split("\n");
      const picked = lines.map((line, index) => ({ line, index })).filter(({ line }) => CURLY.test(line));
      // The download, through the extension the way a user gets it.
      await ui.evaluate(([from]) => chrome.runtime.sendMessage({ type: "glossa:models:install", sourceLanguage: from, targetLanguage: "en" }), [source]);
      const translate = async (texts) => {
        const out = [];
        for (let start = 0; start < texts.length; start += 40) {
          const batch = texts.slice(start, start + 40).map(escapeHtml);
          // Through handle(), so the host counts the work and does not idle out under it. Its text
          // preparation leaves quote marks alone, so the two variants still differ only in them.
          const request = { target: "glossa-engine", engine: "bergamot", idleMs: 600_000, type: "translate", sourceLanguage: source, targetLanguage: "en", fragments: batch };
          const result = await inOffscreen(`glossaEngineHost.handle(${JSON.stringify(request)}).then((r) => r.fragments)`);
          out.push(...result.map(unescapeHtml));
        }
        return out;
      };
      const asWritten = await translate(picked.map(({ line }) => line));
      const straight = await translate(picked.map(({ line }) => straighten(line)));
      const references = picked.map(({ index }) => english[index]);
      const differ = asWritten.filter((text, index) => straighten(text) !== straighten(straight[index])).length;
      rows.push({
        pair: `${source}->en`,
        sentences: picked.length,
        differ,
        asWritten: chrf(asWritten, references),
        straight: chrf(straight, references)
      });
      const row = rows.at(-1);
      console.info(
        `quotes: ${row.pair}: ${row.sentences} sentences, ${row.differ} translated differently; chrF as written ${row.asWritten.toFixed(2)}, straightened ${row.straight.toFixed(2)} (${(row.straight - row.asWritten).toFixed(2)})`
      );
    }
    const wins = rows.filter((row) => row.straight - row.asWritten >= 0.5).length;
    const losses = rows.filter((row) => row.asWritten - row.straight >= 0.5).length;
    console.info(`quotes: straightening helps by 0.5 chrF or more on ${wins} of ${rows.length} pairs and hurts as much on ${losses}`);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`quotes: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
