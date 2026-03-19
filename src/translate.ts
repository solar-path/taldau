/**
 * Google Translate via free web API endpoint.
 * Uses SQLite cache to avoid redundant API calls.
 */

import { getCached, setCache } from "./db";
import { log } from "./logger";

const GOOGLE_TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single";

export interface TranslateOptions {
  from: string;
  to: string;
  jobId?: string;
}

/** Supported languages for the UI */
export const LANGUAGES: Record<string, string> = {
  ru: "Русский",
  kk: "Қазақша",
  en: "English",
  tr: "Türkçe",
  uz: "O'zbekcha",
  ky: "Кыргызча",
  zh: "中文",
  ar: "العربية",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  ko: "한국어",
  ja: "日本語",
};

async function translateSingle(text: string, opts: TranslateOptions): Promise<string> {
  if (!text.trim()) return text;

  // Check cache first
  const cached = getCached(text, opts.from, opts.to);
  if (cached !== null) {
    log.debug("translate", "Cache hit", {
      text: text.slice(0, 80),
      cached: cached.slice(0, 80),
    }, opts.jobId);
    return cached;
  }

  const params = new URLSearchParams({
    client: "gtx",
    sl: opts.from,
    tl: opts.to,
    dt: "t",
    q: text,
  });

  const startMs = performance.now();
  let res: Response | undefined;
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      res = await fetch(`${GOOGLE_TRANSLATE_URL}?${params}`, {
        signal: AbortSignal.timeout(8000),
      });
      break;
    } catch (err: any) {
      if (attempt < maxRetries) {
        log.warn("translate", `Attempt ${attempt + 1} failed, retrying...`, {
          text: text.slice(0, 50),
          error: err.message,
        }, opts.jobId);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      log.error("translate", "Google Translate failed after retries", {
        text: text.slice(0, 80),
        error: err.message,
      }, opts.jobId);
      return text;
    }
  }

  if (!res) return text;

  const elapsedMs = Math.round(performance.now() - startMs);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log.error("translate", "Google Translate API error", {
      status: res.status,
      statusText: res.statusText,
      text: text.slice(0, 80),
      responseBody: body.slice(0, 200),
      elapsedMs,
    }, opts.jobId);
    throw new Error(`Google Translate error: ${res.status} ${res.statusText}`);
  }

  let data: any;
  try {
    data = await res.json();
  } catch (err: any) {
    log.error("translate", "Failed to parse Google Translate response", {
      text: text.slice(0, 80),
      error: err.message,
    }, opts.jobId);
    throw err;
  }

  if (!data || !data[0] || !Array.isArray(data[0])) {
    log.error("translate", "Unexpected response structure from Google Translate", {
      text: text.slice(0, 80),
      response: JSON.stringify(data).slice(0, 300),
    }, opts.jobId);
    throw new Error("Unexpected Google Translate response format");
  }

  const sentences = data[0] as Array<[string, string]>;
  const translated = sentences.map((s) => s[0]).join("");

  log.info("translate", "Translated", {
    from: opts.from,
    to: opts.to,
    source: text.slice(0, 60),
    result: translated.slice(0, 60),
    elapsedMs,
  }, opts.jobId);

  // Save to cache
  setCache(text, translated, opts.from, opts.to);

  return translated;
}

/**
 * Translate an array of texts in batches.
 * Cached texts are returned instantly, only uncached ones hit the API.
 */
export async function translateBatch(
  texts: string[],
  opts: TranslateOptions,
  batchSize = 10,
  delayMs = 300
): Promise<string[]> {
  const results: string[] = new Array(texts.length);
  const uncachedIndices: number[] = [];

  // First pass: fill from cache
  for (let i = 0; i < texts.length; i++) {
    const cached = getCached(texts[i]!, opts.from, opts.to);
    if (cached !== null) {
      results[i] = cached;
    } else {
      uncachedIndices.push(i);
    }
  }

  const cachedCount = texts.length - uncachedIndices.length;
  log.info("translate", "Batch translation started", {
    total: texts.length,
    cached: cachedCount,
    toTranslate: uncachedIndices.length,
    direction: `${opts.from} -> ${opts.to}`,
  }, opts.jobId);

  // Second pass: translate uncached in batches
  for (let i = 0; i < uncachedIndices.length; i += batchSize) {
    const batchIndices = uncachedIndices.slice(i, i + batchSize);
    const batchTexts = batchIndices.map((idx) => texts[idx]!);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(uncachedIndices.length / batchSize);

    log.debug("translate", `API batch ${batchNum}/${totalBatches}`, {
      size: batchTexts.length,
      firstText: batchTexts[0]?.slice(0, 50),
    }, opts.jobId);

    const translated = await Promise.all(
      batchTexts.map((t) => translateSingle(t, opts))
    );

    for (let j = 0; j < batchIndices.length; j++) {
      results[batchIndices[j]!] = translated[j]!;
    }

    if (i + batchSize < uncachedIndices.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  log.info("translate", "Batch translation complete", {
    total: texts.length,
    fromCache: cachedCount,
    fromApi: uncachedIndices.length,
  }, opts.jobId);

  return results;
}

export async function translate(text: string, opts: TranslateOptions): Promise<string> {
  return translateSingle(text, opts);
}
