/**
 * Translation service with multi-engine fallback chain.
 * Engines (all free, no API keys):
 *   1. Google Translate (gtx) — primary, unlimited but unofficial
 *   2. MyMemory — 5000 chars/day free
 *   3. Lingva Translate — open-source Google proxy
 *
 * Uses SQLite cache and glossary term protection.
 */

import { getCached, setCache, getSetting } from "./db";
import { protectBatch, restoreBatch } from "./glossary";
import { log } from "./logger";

/** Get API key from env var or SQLite settings */
function getKey(envVar: string, settingKey: string): string {
  return process.env[envVar] || getSetting(settingKey) || "";
}

export interface TranslateOptions {
  from: string;
  to: string;
  jobId?: string;
  glossary?: Map<string, string>;
  engine?: EngineName;
}

export const LANGUAGES: Record<string, string> = {
  af: "Afrikaans",
  sq: "Shqip",
  am: "አማርኛ",
  ar: "العربية",
  hy: "Հայերեն",
  as: "অসমীয়া",
  ay: "Aymar aru",
  az: "Azərbaycan",
  bm: "Bamanankan",
  eu: "Euskara",
  be: "Беларуская",
  bn: "বাংলা",
  bho: "भोजपुरी",
  bs: "Bosanski",
  bg: "Български",
  ca: "Català",
  ceb: "Cebuano",
  "zh-CN": "中文（简体）",
  "zh-TW": "中文（繁體）",
  co: "Corsu",
  hr: "Hrvatski",
  cs: "Čeština",
  da: "Dansk",
  dv: "ދިވެހި",
  doi: "डोगरी",
  nl: "Nederlands",
  en: "English",
  eo: "Esperanto",
  et: "Eesti",
  ee: "Eʋegbe",
  fil: "Filipino",
  fi: "Suomi",
  fr: "Français",
  fy: "Frysk",
  gl: "Galego",
  ka: "ქართული",
  de: "Deutsch",
  el: "Ελληνικά",
  gn: "Avañe'ẽ",
  gu: "ગુજરાતી",
  ht: "Kreyòl Ayisyen",
  ha: "Hausa",
  haw: "ʻŌlelo Hawaiʻi",
  he: "עברית",
  hi: "हिन्दी",
  hmn: "Hmong",
  hu: "Magyar",
  is: "Íslenska",
  ig: "Igbo",
  ilo: "Iloko",
  id: "Bahasa Indonesia",
  ga: "Gaeilge",
  it: "Italiano",
  ja: "日本語",
  jv: "Jawa",
  kn: "ಕನ್ನಡ",
  kk: "Қазақша",
  km: "ខ្មែរ",
  rw: "Kinyarwanda",
  gom: "कोंकणी",
  ko: "한국어",
  kri: "Krio",
  ku: "Kurdî",
  ckb: "کوردی",
  ky: "Кыргызча",
  lo: "ລາວ",
  la: "Latina",
  lv: "Latviešu",
  ln: "Lingála",
  lt: "Lietuvių",
  lg: "Luganda",
  lb: "Lëtzebuergesch",
  mk: "Македонски",
  mai: "मैथिली",
  mg: "Malagasy",
  ms: "Bahasa Melayu",
  ml: "മലയാളം",
  mt: "Malti",
  mi: "Māori",
  mr: "मराठी",
  "mni-Mtei": "ꯃꯤꯇꯩꯂꯣꯟ",
  lus: "Mizo ṭawng",
  mn: "Монгол",
  my: "မြန်မာ",
  ne: "नेपाली",
  no: "Norsk",
  ny: "Chichewa",
  or: "ଓଡ଼ିଆ",
  om: "Oromoo",
  ps: "پښتو",
  fa: "فارسی",
  pl: "Polski",
  pt: "Português",
  pa: "ਪੰਜਾਬੀ",
  qu: "Runasimi",
  ro: "Română",
  ru: "Русский",
  sm: "Gagana Sāmoa",
  sa: "संस्कृतम्",
  gd: "Gàidhlig",
  nso: "Sepedi",
  sr: "Српски",
  st: "Sesotho",
  sn: "chiShona",
  sd: "سنڌي",
  si: "සිංහල",
  sk: "Slovenčina",
  sl: "Slovenščina",
  so: "Soomaali",
  es: "Español",
  su: "Basa Sunda",
  sw: "Kiswahili",
  sv: "Svenska",
  tl: "Tagalog",
  tg: "Тоҷикӣ",
  ta: "தமிழ்",
  tt: "Татарча",
  te: "తెలుగు",
  th: "ไทย",
  ti: "ትግርኛ",
  ts: "Xitsonga",
  tr: "Türkçe",
  tk: "Türkmen",
  ak: "Akan",
  uk: "Українська",
  ur: "اردو",
  ug: "ئۇيغۇرچە",
  uz: "O'zbekcha",
  vi: "Tiếng Việt",
  cy: "Cymraeg",
  xh: "isiXhosa",
  yi: "ייִדיש",
  yo: "Yorùbá",
  zu: "isiZulu",
};

// ─── Engine types ────────────────────────────────────────────────

export type EngineName = "google" | "mymemory" | "lingva" | "gemini" | "groq" | "deepl" | "google-cloud" | "microsoft" | "openai" | "claude";

interface TranslateEngine {
  name: EngineName;
  label: string;
  translate: (text: string, from: string, to: string) => Promise<string | null>;
}

// ─── Engine: Google Translate (gtx) ──────────────────────────────

const googleEngine: TranslateEngine = {
  name: "google",
  label: "Google Translate",
  async translate(text, from, to) {
    const params = new URLSearchParams({
      client: "gtx", sl: from, tl: to, dt: "t", q: text,
    });
    const res = await fetch(
      `https://translate.googleapis.com/translate_a/single?${params}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as any[];
    if (!data?.[0] || !Array.isArray(data[0])) return null;
    return (data[0] as Array<[string]>).map((s) => s[0]).join("");
  },
};

// ─── Engine: MyMemory ────────────────────────────────────────────

const myMemoryEngine: TranslateEngine = {
  name: "mymemory",
  label: "MyMemory",
  async translate(text, from, to) {
    const params = new URLSearchParams({
      q: text,
      langpair: `${from}|${to}`,
    });
    const res = await fetch(
      `https://api.mymemory.translated.net/get?${params}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (!data?.responseData?.translatedText) return null;
    const translated = data.responseData.translatedText as string;
    // MyMemory returns UNTRANSLATED TEXT IN CAPS when quota exceeded
    if (translated === text.toUpperCase()) return null;
    return translated;
  },
};

// ─── Engine: Lingva Translate ────────────────────────────────────

const LINGVA_INSTANCES = [
  "https://lingva.ml",
  "https://lingva.lunar.icu",
  "https://translate.plausibility.cloud",
];

const lingvaEngine: TranslateEngine = {
  name: "lingva",
  label: "Lingva Translate",
  async translate(text, from, to) {
    for (const instance of LINGVA_INSTANCES) {
      try {
        const res = await fetch(
          `${instance}/api/v1/${from}/${to}/${encodeURIComponent(text)}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (!res.ok) continue;
        const data = await res.json() as any;
        if (data?.translation) return data.translation as string;
      } catch {
        continue;
      }
    }
    return null;
  },
};

// ─── Engine: Google Gemini (free: 15 RPM, 1500 req/day) ─────────

const geminiKey = () => getKey("GEMINI_API_KEY", "gemini_api_key");

const geminiEngine: TranslateEngine = {
  name: "gemini",
  label: "Gemini",
  async translate(text, from, to) {
    if (!geminiKey()) return null;
    const fromName = LANGUAGES[from] || from;
    const toName = LANGUAGES[to] || to;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Translate the following text from ${fromName} to ${toName}. Return ONLY the translated text, nothing else.\n\n${text}`,
            }],
          }],
          generationConfig: { temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    const result = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return result?.trim() || null;
  },
};

// ─── Engine: Groq (free: 30 RPM, 14400 req/day) ─────────────────

const groqKey = () => getKey("GROQ_API_KEY", "groq_api_key");

const groqEngine: TranslateEngine = {
  name: "groq",
  label: "Groq",
  async translate(text, from, to) {
    if (!groqKey()) return null;
    const fromName = LANGUAGES[from] || from;
    const toName = LANGUAGES[to] || to;
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${groqKey()}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: "You are a professional translator. Translate the user's text accurately. Return ONLY the translated text, nothing else.",
          },
          {
            role: "user",
            content: `Translate from ${fromName} to ${toName}:\n\n${text}`,
          },
        ],
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const result = data?.choices?.[0]?.message?.content;
    return result?.trim() || null;
  },
};

// ─── Engine: DeepL (paid: $5.49/1M chars, free: 500K chars/month) ─

const deeplKey = () => getKey("DEEPL_API_KEY", "deepl_api_key");

// DeepL uses different language codes for some languages
function deeplLangCode(code: string): string {
  const map: Record<string, string> = {
    "zh-CN": "ZH-HANS", "zh-TW": "ZH-HANT",
    en: "EN", pt: "PT-BR",
  };
  return map[code] || code.toUpperCase();
}

const deeplEngine: TranslateEngine = {
  name: "deepl",
  label: "DeepL",
  async translate(text, from, to) {
    if (!deeplKey()) return null;
    const isFree = deeplKey().endsWith(":fx");
    const baseUrl = isFree
      ? "https://api-free.deepl.com/v2/translate"
      : "https://api.deepl.com/v2/translate";
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `DeepL-Auth-Key ${deeplKey()}`,
      },
      body: JSON.stringify({
        text: [text],
        source_lang: deeplLangCode(from),
        target_lang: deeplLangCode(to),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.translations?.[0]?.text?.trim() || null;
  },
};

// ─── Engine: Google Cloud Translation (paid: $20/1M chars) ───────

const gcloudKey = () => getKey("GOOGLE_CLOUD_API_KEY", "google_cloud_api_key");

const googleCloudEngine: TranslateEngine = {
  name: "google-cloud",
  label: "Google Cloud",
  async translate(text, from, to) {
    if (!gcloudKey()) return null;
    const res = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${gcloudKey()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: text, source: from, target: to, format: "text" }),
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.data?.translations?.[0]?.translatedText?.trim() || null;
  },
};

// ─── Engine: Microsoft Translator (paid: $10/1M chars, 2M free/month) ─

const microsoftKey = () => getKey("MICROSOFT_TRANSLATOR_KEY", "microsoft_translator_key");
const microsoftRegion = () => process.env.MICROSOFT_TRANSLATOR_REGION || getSetting("microsoft_translator_region") || "global";

const microsoftEngine: TranslateEngine = {
  name: "microsoft",
  label: "Microsoft",
  async translate(text, from, to) {
    if (!microsoftKey()) return null;
    const params = new URLSearchParams({
      "api-version": "3.0",
      from,
      to,
    });
    const res = await fetch(
      `https://api.cognitive.microsofttranslator.com/translate?${params}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Ocp-Apim-Subscription-Key": microsoftKey(),
          "Ocp-Apim-Subscription-Region": microsoftRegion(),
        },
        body: JSON.stringify([{ text }]),
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.[0]?.translations?.[0]?.text?.trim() || null;
  },
};

// ─── Engine: OpenAI (paid: ~$0.15-2.50/1M tokens) ───────────────

const openaiKey = () => getKey("OPENAI_API_KEY", "openai_api_key");

const openaiEngine: TranslateEngine = {
  name: "openai",
  label: "OpenAI",
  async translate(text, from, to) {
    if (!openaiKey()) return null;
    const fromName = LANGUAGES[from] || from;
    const toName = LANGUAGES[to] || to;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiKey()}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a professional translator. Translate the user's text accurately. Return ONLY the translated text, nothing else.",
          },
          {
            role: "user",
            content: `Translate from ${fromName} to ${toName}:\n\n${text}`,
          },
        ],
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.choices?.[0]?.message?.content?.trim() || null;
  },
};

// ─── Engine: Claude (paid: ~$0.25-3/1M tokens) ──────────────────

const claudeKey = () => getKey("ANTHROPIC_API_KEY", "anthropic_api_key");

const claudeEngine: TranslateEngine = {
  name: "claude",
  label: "Claude",
  async translate(text, from, to) {
    if (!claudeKey()) return null;
    const fromName = LANGUAGES[from] || from;
    const toName = LANGUAGES[to] || to;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": claudeKey(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: `Translate the following text from ${fromName} to ${toName}. Return ONLY the translated text, nothing else.\n\n${text}`,
        }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const block = data?.content?.[0];
    return block?.type === "text" ? block.text.trim() : null;
  },
};

// ─── Engine registry & fallback chain ────────────────────────────

// Free engines first, then paid (paid are premium, shown only when keys exist)
const allEngines: TranslateEngine[] = [
  // Free (no API key)
  googleEngine, myMemoryEngine, lingvaEngine,
  // Free tier (API key required)
  geminiEngine, groqEngine,
  // Paid / subscription (API key required)
  deeplEngine, googleCloudEngine, microsoftEngine, openaiEngine, claudeEngine,
];

// Engine availability checked dynamically (keys can be added at runtime via UI)
function isEngineAvailable(name: EngineName): boolean {
  switch (name) {
    case "gemini": return !!geminiKey();
    case "groq": return !!groqKey();
    case "deepl": return !!deeplKey();
    case "google-cloud": return !!gcloudKey();
    case "microsoft": return !!microsoftKey();
    case "openai": return !!openaiKey();
    case "claude": return !!claudeKey();
    default: return true;
  }
}

function getAvailableEngines(): TranslateEngine[] {
  return allEngines.filter((e) => isEngineAvailable(e.name));
}

const engineMap = new Map<EngineName, TranslateEngine>(
  allEngines.map((e) => [e.name, e])
);

/** Get available engines for UI (dynamic — reflects keys added at runtime) */
export function getEngines(): { name: EngineName; label: string }[] {
  return getAvailableEngines().map((e) => ({ name: e.name, label: e.label }));
}

/** Active engine (can be changed at runtime) */
let activeEngine: EngineName = "google";

export function getActiveEngine(): EngineName {
  return activeEngine;
}

export function setActiveEngine(name: EngineName) {
  if (engineMap.has(name)) {
    activeEngine = name;
    log.info("translate", `Engine switched to ${name}`);
  }
}

// ─── Core translation with fallback ─────────────────────────────

/**
 * Translate a single text using the active engine.
 * On failure, falls back through remaining engines.
 */
async function translateSingle(text: string, opts: TranslateOptions): Promise<string> {
  if (!text.trim()) return text;

  const cached = getCached(text, opts.from, opts.to);
  if (cached !== null) return cached;

  // Build engine order: preferred first, then others as fallback
  const preferred = opts.engine || activeEngine;
  const orderedEngines = [
    engineMap.get(preferred)!,
    ...getAvailableEngines().filter((e) => e.name !== preferred),
  ];

  for (const engine of orderedEngines) {
    try {
      const result = await engine.translate(text, opts.from, opts.to);
      if (result && result.trim()) {
        if (engine.name !== preferred) {
          log.warn("translate", `Fallback: ${preferred} → ${engine.name}`, {
            text: text.slice(0, 50),
          }, opts.jobId);
        }

        log.info("translate", "Translated", {
          engine: engine.name,
          source: text.slice(0, 50),
          result: result.slice(0, 50),
        }, opts.jobId);

        setCache(text, result, opts.from, opts.to);
        return result;
      }
    } catch (err: any) {
      log.warn("translate", `${engine.name} failed`, {
        error: err.message,
        text: text.slice(0, 50),
      }, opts.jobId);
    }
  }

  log.error("translate", "All engines failed", {
    text: text.slice(0, 80),
  }, opts.jobId);
  return text;
}

// ─── Batch API ──────────────────────────────────────────────────

/**
 * Translate array of texts in batches.
 * Applies glossary protection before translation and restoration after.
 */
export async function translateBatch(
  texts: string[],
  opts: TranslateOptions,
  batchSize = 10,
  delayMs = 300
): Promise<string[]> {
  const glossary = opts.glossary;

  // Apply glossary protection
  let textsToTranslate = texts;
  let allPlaceholders: Map<string, string>[] | undefined;

  if (glossary && glossary.size > 0) {
    const protected_ = protectBatch(texts, glossary, opts.jobId);
    textsToTranslate = protected_.texts;
    allPlaceholders = protected_.allPlaceholders;
    const protectedCount = allPlaceholders.filter((p) => p.size > 0).length;
    if (protectedCount > 0) {
      log.info("glossary", "Protected terms in batch", {
        textsWithTerms: protectedCount,
        total: texts.length,
      }, opts.jobId);
    }
  }

  // Check cache
  const results: string[] = new Array(textsToTranslate.length);
  const uncachedIndices: number[] = [];

  for (let i = 0; i < textsToTranslate.length; i++) {
    const cached = getCached(textsToTranslate[i]!, opts.from, opts.to);
    if (cached !== null) {
      results[i] = cached;
    } else {
      uncachedIndices.push(i);
    }
  }

  const cachedCount = textsToTranslate.length - uncachedIndices.length;
  log.info("translate", "Batch started", {
    engine: opts.engine || activeEngine,
    total: textsToTranslate.length,
    cached: cachedCount, toTranslate: uncachedIndices.length,
  }, opts.jobId);

  // Translate uncached in batches with delays
  for (let i = 0; i < uncachedIndices.length; i += batchSize) {
    const batchIndices = uncachedIndices.slice(i, i + batchSize);
    const translated = await Promise.all(
      batchIndices.map((idx) => translateSingle(textsToTranslate[idx]!, opts))
    );
    for (let j = 0; j < batchIndices.length; j++) {
      results[batchIndices[j]!] = translated[j]!;
    }
    if (i + batchSize < uncachedIndices.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  log.info("translate", "Batch complete", {
    engine: opts.engine || activeEngine,
    total: textsToTranslate.length,
    fromCache: cachedCount,
    fromApi: uncachedIndices.length,
  }, opts.jobId);

  // Restore glossary terms
  if (allPlaceholders) {
    return restoreBatch(results, allPlaceholders, opts.jobId);
  }

  return results;
}

export async function translate(text: string, opts: TranslateOptions): Promise<string> {
  return translateSingle(text, opts);
}
