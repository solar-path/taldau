/**
 * Taldau — Office Document Translator
 * Bun HTTP server with HTMX + Alpine.js UI
 */

import JSZip from "jszip";
import { readdir, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { cpus } from "node:os";
import { detectDocType, getTranslatablePaths, translateXml } from "./src/parsers";
import { LANGUAGES, type TranslateOptions, translateBatch, getEngines, getActiveEngine, setActiveEngine, type EngineName } from "./src/translate";
import { extractPdfContent, buildInternalDoc, collectTexts, buildTranslatedHtml, renderToPdf, MAX_PDF_SIZE, MAX_PDF_PAGES } from "./src/pdf";
import { getCacheStats, clearCache, getGlossaryTerms, getGlossaryMap, addGlossaryTerm, updateGlossaryTerm, deleteGlossaryTerm, getSetting, setSetting, getAllSettings } from "./src/db";
import { log, getRecentLogs, getJobLogs, clearJobLogs, logsToHtml } from "./src/logger";

const PORT = Number(process.env.PORT) || 3333;
const CPU_COUNT = cpus().length;

/** Run tasks with concurrency limited by CPU cores */
async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency = CPU_COUNT
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]!, i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
const ORIGINAL_DIR = join(import.meta.dir, "original");
const RESULT_DIR = join(import.meta.dir, "result");

await mkdir(ORIGINAL_DIR, { recursive: true });
await mkdir(RESULT_DIR, { recursive: true });

// Track translation progress per job
const jobs = new Map<string, { status: string; progress: number; total: number; error?: string; fileName?: string; stage?: string }>();

async function processDocument(jobId: string, filePath: string, opts: TranslateOptions) {
  const fileName = basename(filePath);
  const docType = detectDocType(fileName);

  if (!docType) {
    log.error("job", "Unsupported file format", { fileName }, jobId);
    jobs.set(jobId, { status: "error", progress: 0, total: 0, error: "Unsupported format" });
    return;
  }

  log.info("job", "Starting document translation", {
    jobId: jobId.slice(0, 8),
    fileName,
    docType,
    direction: `${opts.from} -> ${opts.to}`,
  }, jobId);

  try {
    const startMs = performance.now();
    const fileData = await Bun.file(filePath).arrayBuffer();
    log.info("job", "File loaded", { fileName, sizeKb: Math.round(fileData.byteLength / 1024) }, jobId);

    // ── PDF pipeline (separate from ZIP/OOXML) ──
    if (docType === "pdf") {
      if (fileData.byteLength > MAX_PDF_SIZE) {
        throw new Error(`PDF too large (${Math.round(fileData.byteLength / 1024 / 1024)}MB). Maximum: 50MB`);
      }

      jobs.set(jobId, { status: "translating", progress: 0, total: 3, fileName, stage: "extracting" });

      const pages = await extractPdfContent(new Uint8Array(fileData), jobId);
      const totalItems = pages.reduce((sum, p) => sum + p.items.length, 0);

      if (totalItems === 0) {
        log.warn("job", "PDF contains no extractable text (may be scanned/image-only)", { fileName }, jobId);
        jobs.set(jobId, { status: "error", progress: 0, total: 0, error: "No text found in PDF. The file may contain only images.", fileName });
        return;
      }

      if (pages.length > MAX_PDF_PAGES) {
        throw new Error(`PDF has ${pages.length} pages. Maximum: ${MAX_PDF_PAGES}`);
      }

      jobs.set(jobId, { status: "translating", progress: 1, total: 3, fileName, stage: "translating" });

      const doc = buildInternalDoc(pages, jobId);
      const texts = collectTexts(doc);

      log.info("job", "PDF texts collected for translation", {
        blocks: texts.length,
        totalChars: texts.reduce((sum, t) => sum + t.length, 0),
      }, jobId);

      const translated = await translateBatch(texts, opts);

      // Build translation map
      const translationMap = new Map<string, string>();
      for (let i = 0; i < texts.length; i++) {
        translationMap.set(texts[i]!, translated[i]!);
      }

      jobs.set(jobId, { status: "translating", progress: 2, total: 3, fileName, stage: "generating" });

      const html = buildTranslatedHtml(doc, translationMap);
      const { buffer, format } = await renderToPdf(html, pages[0]!.width, pages[0]!.height, jobId);

      const outputFileName = format === "pdf" ? fileName : fileName.replace(/\.pdf$/i, ".html");
      const outputPath = join(RESULT_DIR, outputFileName);
      await Bun.write(outputPath, buffer);

      const totalMs = Math.round(performance.now() - startMs);
      log.info("job", "PDF translation complete", {
        jobId: jobId.slice(0, 8),
        fileName,
        outputFormat: format,
        totalMs,
        outputSizeKb: Math.round(buffer.length / 1024),
      }, jobId);

      jobs.set(jobId, { status: "done", progress: 3, total: 3, fileName: outputFileName });
      return;
    }

    const zip = await JSZip.loadAsync(fileData);

    // Log all files in the ZIP
    const allFiles: string[] = [];
    zip.forEach((path) => allFiles.push(path));
    log.info("job", "ZIP contents", { totalFiles: allFiles.length, files: allFiles }, jobId);

    const patterns = getTranslatablePaths(docType);
    const translatableFiles: string[] = [];
    zip.forEach((relativePath) => {
      if (patterns.some((p) => p.test(relativePath))) {
        translatableFiles.push(relativePath);
      }
    });

    const skippedFiles = allFiles.filter((f) => !translatableFiles.includes(f));
    log.info("job", "File classification", {
      translatable: translatableFiles,
      skipped: skippedFiles.length,
    }, jobId);

    jobs.set(jobId, { status: "translating", progress: 0, total: translatableFiles.length, fileName });

    log.info("job", "Parallel processing with CPU cores", { cpuCount: CPU_COUNT, files: translatableFiles.length }, jobId);

    let completedCount = 0;

    await parallelMap(translatableFiles, async (xmlPath, i) => {
      const xmlContent = await zip.file(xmlPath)!.async("string");

      log.info("job", `Processing file ${i + 1}/${translatableFiles.length}`, {
        file: xmlPath,
        xmlSizeKb: Math.round(xmlContent.length / 1024),
      }, jobId);

      const translated = await translateXml(xmlContent, xmlPath, docType, { ...opts, jobId });
      zip.file(xmlPath, translated);
      completedCount++;
      jobs.set(jobId, { status: "translating", progress: completedCount, total: translatableFiles.length, fileName });
    });

    const totalMs = Math.round(performance.now() - startMs);

    const outputPath = join(RESULT_DIR, fileName);
    const outputData = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    await Bun.write(outputPath, outputData);

    log.info("job", "Translation complete", {
      jobId: jobId.slice(0, 8),
      fileName,
      totalMs,
      outputSizeKb: Math.round(outputData.byteLength / 1024),
    }, jobId);

    jobs.set(jobId, { status: "done", progress: translatableFiles.length, total: translatableFiles.length, fileName });
  } catch (err: any) {
    log.error("job", "Translation failed", {
      jobId: jobId.slice(0, 8),
      fileName,
      error: err.message,
      stack: err.stack?.split("\n").slice(0, 3).join(" | "),
    }, jobId);
    jobs.set(jobId, { status: "error", progress: 0, total: 0, error: err.message, fileName });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function glossaryHtml(from: string, to: string): Response {
  const terms = getGlossaryTerms(from, to);
  let html = `<table class="glossary-table">
    <thead><tr><th>Source term</th><th>Translation</th><th></th></tr></thead><tbody>`;

  for (const t of terms) {
    html += `<tr>
      <td>${escHtml(t.source_term)}</td>
      <td>${escHtml(t.translated_term)}</td>
      <td><button class="btn btn-sm btn-del"
        hx-delete="/api/glossary/${t.id}?from=${from}&to=${to}"
        hx-target="#glossary-list" hx-swap="innerHTML"
        hx-confirm="Delete term?">&times;</button></td>
    </tr>`;
  }

  html += `</tbody></table>`;
  if (terms.length === 0) html = `<p class="muted">No glossary terms for this language pair</p>`;
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── HTTP Server ────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // ── Static UI ──
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "index.html")), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // ── API: Get languages ──
    if (url.pathname === "/api/languages") {
      return Response.json(LANGUAGES);
    }

    // ── API: Upload & translate ──
    if (url.pathname === "/api/translate" && req.method === "POST") {
      const formData = await req.formData();
      const file = formData.get("file") as File | null;
      const from = (formData.get("from") as string) || "ru";
      const to = (formData.get("to") as string) || "kk";
      if (!file) {
        log.warn("server", "Upload attempt with no file");
        return new Response('<div class="error">No file uploaded</div>', {
          status: 400,
          headers: { "Content-Type": "text/html" },
        });
      }

      const docType = detectDocType(file.name);
      if (!docType) {
        log.warn("server", "Unsupported file uploaded", { name: file.name });
        return new Response('<div class="error">Unsupported format. Use .pptx, .docx, .xlsx, or .pdf</div>', {
          status: 400,
          headers: { "Content-Type": "text/html" },
        });
      }

      const savePath = join(ORIGINAL_DIR, file.name);
      await Bun.write(savePath, await file.arrayBuffer());

      const jobId = crypto.randomUUID();
      log.info("server", "New translation job", {
        jobId: jobId.slice(0, 8),
        file: file.name,
        from,
        to,
        sizeKb: Math.round(file.size / 1024),
      });

      const glossary = getGlossaryMap(from, to);
      jobs.set(jobId, { status: "starting", progress: 0, total: 0, fileName: file.name });
      processDocument(jobId, savePath, { from, to, glossary });

      return new Response(
        `<div id="progress" hx-get="/api/progress/${jobId}" hx-trigger="every 1s" hx-swap="outerHTML">
          <div class="progress-bar"><div class="progress-fill" style="width: 0%"></div></div>
          <p class="status">Starting translation...</p>
        </div>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // ── API: Check progress ──
    if (url.pathname.startsWith("/api/progress/")) {
      const jobId = url.pathname.split("/").pop()!;
      const job = jobs.get(jobId);

      if (!job) {
        return new Response('<div class="error">Job not found</div>', {
          headers: { "Content-Type": "text/html" },
        });
      }

      if (job.status === "error") {
        return new Response(
          `<div id="progress" class="error">Error: ${job.error}</div>`,
          { headers: { "Content-Type": "text/html" } }
        );
      }

      if (job.status === "done") {
        jobs.delete(jobId);
        return new Response(
          `<div id="progress" class="done">
            <p>Translation complete!</p>
            <a href="/api/download/${encodeURIComponent(job.fileName!)}" class="btn btn-download" download>
              Download ${job.fileName}
            </a>
          </div>`,
          { headers: { "Content-Type": "text/html" } }
        );
      }

      const pct = job.total > 0 ? Math.round((job.progress / job.total) * 100) : 0;
      const stageLabels: Record<string, string> = {
        extracting: "Extracting text from PDF...",
        translating: "Translating...",
        generating: "Generating PDF...",
      };
      const statusText = job.stage && stageLabels[job.stage]
        ? stageLabels[job.stage]
        : `Translating: ${job.progress}/${job.total} files (${pct}%)`;
      return new Response(
        `<div id="progress" hx-get="/api/progress/${jobId}" hx-trigger="every 1s" hx-swap="outerHTML">
          <div class="progress-bar"><div class="progress-fill" style="width: ${pct}%"></div></div>
          <p class="status">${statusText}</p>
        </div>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // ── API: Download result ──
    if (url.pathname.startsWith("/api/download/")) {
      const fileName = decodeURIComponent(url.pathname.replace("/api/download/", ""));
      const filePath = join(RESULT_DIR, fileName);
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        return new Response("File not found", { status: 404 });
      }
      return new Response(file, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${fileName}"`,
        },
      });
    }

    // ── API: Cache stats ──
    if (url.pathname === "/api/cache" && req.method === "DELETE") {
      const deleted = clearCache();
      log.info("server", "Cache cleared", { deleted });
      return new Response(
        `<div class="cache-stats"><p>Cleared ${deleted} entries</p></div>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    if (url.pathname === "/api/cache") {
      const stats = getCacheStats();
      return new Response(
        `<div class="cache-stats">
          <p><strong>${stats.total}</strong> cached translations</p>
          ${stats.languages.map((l) => `<span class="badge">${l.pair}: ${l.count}</span>`).join(" ")}
          ${stats.total > 0 ? `<button class="btn btn-sm" hx-delete="/api/cache" hx-target="#cache-info" hx-swap="innerHTML">Clear cache</button>` : ""}
        </div>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // ── API: List files in result ──
    if (url.pathname === "/api/results") {
      const files = await readdir(RESULT_DIR);
      const officeFiles = files.filter((f) => /\.(pptx|docx|xlsx|pdf|html)$/i.test(f));
      if (officeFiles.length === 0) {
        return new Response('<p class="muted">No translated files yet</p>', {
          headers: { "Content-Type": "text/html" },
        });
      }
      const html = officeFiles.map((f) =>
        `<li><a href="/api/download/${encodeURIComponent(f)}" download>${f}</a></li>`
      ).join("");
      return new Response(`<ul class="file-list">${html}</ul>`, {
        headers: { "Content-Type": "text/html" },
      });
    }

    // ── API: Logs (for UI) ──
    if (url.pathname === "/api/logs") {
      const limit = Number(url.searchParams.get("limit")) || 100;
      const entries = getRecentLogs(limit);
      return new Response(logsToHtml(entries), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // ── API: Glossary CRUD ──
    if (url.pathname === "/api/glossary" && req.method === "POST") {
      const form = await req.formData();
      const source = (form.get("source_term") as string || "").trim();
      const translated = (form.get("translated_term") as string || "").trim();
      const from = (form.get("from") as string) || "ru";
      const to = (form.get("to") as string) || "kk";
      if (source && translated) {
        addGlossaryTerm(source, translated, from, to);
        log.info("glossary", "Term added", { source, translated, from, to });
      }
      // Return updated table
      return glossaryHtml(from, to);
    }

    if (url.pathname === "/api/glossary" && req.method === "GET") {
      const from = url.searchParams.get("from") || "ru";
      const to = url.searchParams.get("to") || "kk";
      return glossaryHtml(from, to);
    }

    if (url.pathname.startsWith("/api/glossary/") && req.method === "DELETE") {
      const id = Number(url.pathname.split("/").pop());
      if (id) {
        deleteGlossaryTerm(id);
        log.info("glossary", "Term deleted", { id });
      }
      const from = url.searchParams.get("from") || "ru";
      const to = url.searchParams.get("to") || "kk";
      return glossaryHtml(from, to);
    }

    if (url.pathname.startsWith("/api/glossary/") && req.method === "PUT") {
      const id = Number(url.pathname.split("/").pop());
      const form = await req.formData();
      const source = (form.get("source_term") as string || "").trim();
      const translated = (form.get("translated_term") as string || "").trim();
      if (id && source && translated) {
        updateGlossaryTerm(id, source, translated);
        log.info("glossary", "Term updated", { id, source, translated });
      }
      const from = url.searchParams.get("from") || "ru";
      const to = url.searchParams.get("to") || "kk";
      return glossaryHtml(from, to);
    }

    // ── API: Translation engines ──
    if (url.pathname === "/api/engines" && req.method === "GET") {
      const enginesList = getEngines();
      const active = getActiveEngine();
      const html = enginesList.map((e) =>
        `<button class="engine-btn ${e.name === active ? "active" : ""}" `
        + `hx-post="/api/engines/${e.name}" hx-target="#engine-selector" hx-swap="innerHTML">`
        + `${escHtml(e.label)}</button>`
      ).join("");
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname.startsWith("/api/engines/") && req.method === "POST") {
      const name = url.pathname.split("/").pop() as EngineName;
      setActiveEngine(name);
      const enginesList = getEngines();
      const active = getActiveEngine();
      const html = enginesList.map((e) =>
        `<button class="engine-btn ${e.name === active ? "active" : ""}" `
        + `hx-post="/api/engines/${e.name}" hx-target="#engine-selector" hx-swap="innerHTML">`
        + `${escHtml(e.label)}</button>`
      ).join("");
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    // ── API: API Keys management ──
    if (url.pathname === "/api/keys" && req.method === "GET") {
      const keyConfigs = [
        { key: "gemini_api_key", label: "Gemini", hint: "Free: 15 RPM, 1500 req/day" },
        { key: "groq_api_key", label: "Groq", hint: "Free: 30 RPM, 14400 req/day" },
        { key: "deepl_api_key", label: "DeepL", hint: "$5.49/1M символов, free: 500K/мес" },
        { key: "google_cloud_api_key", label: "Google Cloud", hint: "$20/1M символов" },
        { key: "microsoft_translator_key", label: "Microsoft", hint: "$10/1M символов, 2M free/мес" },
        { key: "openai_api_key", label: "OpenAI", hint: "GPT-4o-mini ~$0.15/1M токенов" },
        { key: "anthropic_api_key", label: "Claude", hint: "Haiku ~$0.25/1M токенов" },
      ];
      const rows = keyConfigs.map((c) => {
        const val = getSetting(c.key) || "";
        const masked = val ? "••••" + val.slice(-4) : "";
        const hasKey = !!val;
        return `<div class="key-row">
          <div class="key-info">
            <span class="key-label">${escHtml(c.label)}</span>
            <span class="key-hint">${escHtml(c.hint)}</span>
          </div>
          <div class="key-input">
            <input type="password" name="${c.key}" placeholder="${masked || 'API key...'}"
              class="key-field" autocomplete="off">
            <button class="btn-sm btn-save-key"
              hx-post="/api/keys" hx-include="[name='${c.key}']"
              hx-target="#api-keys" hx-swap="innerHTML"
              hx-encoding="multipart/form-data">
              ${hasKey ? "Update" : "Save"}</button>
            ${hasKey ? `<button class="btn-sm btn-del-key"
              hx-delete="/api/keys/${c.key}"
              hx-target="#api-keys" hx-swap="innerHTML">Del</button>` : ""}
          </div>
        </div>`;
      }).join("");
      return new Response(rows, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/api/keys" && req.method === "POST") {
      const form = await req.formData();
      for (const [key, value] of form.entries()) {
        if (typeof value === "string" && value.trim()) {
          setSetting(key, value.trim());
          log.info("settings", "API key saved", { key, length: value.trim().length });
        }
      }
      return new Response("", {
        headers: { "Content-Type": "text/html", "HX-Trigger": "keysUpdated" },
      });
    }

    if (url.pathname.startsWith("/api/keys/") && req.method === "DELETE") {
      const key = url.pathname.replace("/api/keys/", "");
      setSetting(key, "");
      log.info("settings", "API key removed", { key });
      return new Response("", {
        headers: { "Content-Type": "text/html", "HX-Trigger": "keysUpdated" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

log.info("server", `Taldau started`, { port: PORT, url: `http://localhost:${PORT}`, cpuCores: CPU_COUNT });
