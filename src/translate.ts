/**
 * Translation service: Google Translate.
 * Uses SQLite cache and glossary term protection.
 */

import { getCached, setCache } from "./db";
import { protectBatch, restoreBatch } from "./glossary";
import { log } from "./logger";

const GOOGLE_TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single";

export interface TranslateOptions {
  from: string;
  to: string;
  jobId?: string;
  glossary?: Map<string, string>;
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

// ─── Google Translate ───────────────────────────────────────────────

async function translateSingle(text: string, opts: TranslateOptions): Promise<string> {
  if (!text.trim()) return text;

  const cached = getCached(text, opts.from, opts.to);
  if (cached !== null) return cached;

  const params = new URLSearchParams({
    client: "gtx", sl: opts.from, tl: opts.to, dt: "t", q: text,
  });

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
        log.warn("translate", `Attempt ${attempt + 1} failed, retrying`, {
          error: err.message,
        }, opts.jobId);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      log.error("translate", "Google Translate failed after retries", {
        text: text.slice(0, 80), error: err.message,
      }, opts.jobId);
      return text;
    }
  }

  if (!res) return text;
  if (!res.ok) {
    log.error("translate", "Google API error", {
      status: res.status, text: text.slice(0, 80),
    }, opts.jobId);
    return text;
  }

  const data = await res.json() as any[];
  if (!data?.[0] || !Array.isArray(data[0])) {
    log.error("translate", "Unexpected Google response", {
      text: text.slice(0, 80),
    }, opts.jobId);
    return text;
  }

  const translated = (data[0] as Array<[string]>).map((s: [string]) => s[0]).join("");

  log.info("translate", "Translated", {
    source: text.slice(0, 50),
    result: translated.slice(0, 50),
  }, opts.jobId);

  setCache(text, translated, opts.from, opts.to);
  return translated;
}

// ─── Batch API ──────────────────────────────────────────────────────

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
