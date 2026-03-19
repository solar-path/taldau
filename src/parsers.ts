/**
 * XML parsers for Office documents.
 *
 * Fixes applied from log analysis:
 * 1. Index-based replacement (no string.replace() corruption)
 * 2. Skip numbers, already-target-language text, XML fragments
 * 3. Chart parser also uses index-based replacement
 * 4. Skip notesSlides (only contain page numbers)
 * 5. Filter out untranslatable text before API calls
 * 6. Minimal XML escaping (no &apos;)
 */

import { translateBatch, type TranslateOptions } from "./translate";
import { log } from "./logger";

/** Escape text for safe XML insertion */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Unescape XML entities for translation */
function unescapeXml(text: string): string {
  return text
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/**
 * Check if text should be skipped (not sent to translation API).
 * Filters out: pure numbers, XML fragments, whitespace-only,
 * single characters, placeholders like [VALUE], ‹#›
 */
function shouldSkipText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // Pure number (with optional %, commas, dots)
  if (/^[\d\s.,:%+\-–—$/€₸₽¥£()]+$/.test(t)) return true;
  // Single character
  if (t.length <= 1) return true;
  // XML tags leaked into text content
  if (t.includes("</a:") || t.includes("<a:") || t.includes("</w:") || t.includes("<w:")) return true;
  // Placeholders
  if (/^\[.*\]$/.test(t)) return true;
  // Special markers like ‹#›
  if (/^[‹›#]+$/.test(t)) return true;
  return false;
}

// ─── Run-level structures ───────────────────────────────────────────

interface RunMatch {
  absStart: number;
  absEnd: number;
  tagOpen: string;
  rawText: string;
  tagClose: string;
}

interface ParagraphInfo {
  runs: RunMatch[];
  fullText: string;
}

// ─── Generic run finder ─────────────────────────────────────────────

function findParagraphs(
  xml: string,
  paragraphTag: string,
  textTag: string,
  jobId?: string,
  scopeName = "parser"
): ParagraphInfo[] {
  const paragraphs: ParagraphInfo[] = [];
  const pRegex = new RegExp(`<${paragraphTag}\\b[^>]*>[\\s\\S]*?<\\/${paragraphTag}>`, "g");
  let pMatch: RegExpExecArray | null;
  let totalRuns = 0;
  let emptyParagraphs = 0;
  let skippedParagraphs = 0;

  while ((pMatch = pRegex.exec(xml)) !== null) {
    const pStart = pMatch.index;
    const pContent = pMatch[0];

    const tRegex = new RegExp(`(<${textTag}\\b[^>]*>)([\\s\\S]*?)(<\\/${textTag}>)`, "g");
    let tMatch: RegExpExecArray | null;
    const runs: RunMatch[] = [];

    while ((tMatch = tRegex.exec(pContent)) !== null) {
      runs.push({
        absStart: pStart + tMatch.index,
        absEnd: pStart + tMatch.index + tMatch[0].length,
        tagOpen: tMatch[1]!,
        rawText: tMatch[2]!,
        tagClose: tMatch[3]!,
      });
    }
    totalRuns += runs.length;

    if (runs.length > 0) {
      const fullText = runs.map((r) => unescapeXml(r.rawText)).join("");
      if (shouldSkipText(fullText)) {
        skippedParagraphs++;
      } else {
        if (runs.length > 1) {
          log.debug(scopeName, "Fragmented paragraph merged", {
            runsCount: runs.length,
            fragments: runs.map((r) => unescapeXml(r.rawText).slice(0, 30)),
            merged: fullText.slice(0, 80),
          }, jobId);
        }
        paragraphs.push({ runs, fullText });
      }
    } else {
      emptyParagraphs++;
    }
  }

  log.info(scopeName, "Parsed XML", {
    translatable: paragraphs.length,
    totalRuns,
    skipped: skippedParagraphs,
    empty: emptyParagraphs,
    fragmented: paragraphs.filter((p) => p.runs.length > 1).length,
  }, jobId);

  return paragraphs;
}

// ─── Chart parser ───────────────────────────────────────────────────

interface ChartTextMatch {
  absStart: number;
  absEnd: number;
  tagOpen: string;
  rawText: string;
  tagClose: string;
  text: string;
}

function findChartTexts(xml: string, jobId?: string): ChartTextMatch[] {
  const results: ChartTextMatch[] = [];
  let skippedNumeric = 0;
  let skippedOther = 0;

  const allRegex = /(<(?:c:v|c:t|a:t)\b[^>]*>)([\s\S]*?)(<\/(?:c:v|c:t|a:t)>)/g;
  let match: RegExpExecArray | null;

  while ((match = allRegex.exec(xml)) !== null) {
    const text = unescapeXml(match[2]!);
    if (shouldSkipText(text)) {
      if (/^[\d\s.,:%+\-–—$/€₸₽¥£()]+$/.test(text.trim())) {
        skippedNumeric++;
      } else {
        skippedOther++;
      }
      continue;
    }

    results.push({
      absStart: match.index,
      absEnd: match.index + match[0].length,
      tagOpen: match[1]!,
      rawText: match[2]!,
      tagClose: match[3]!,
      text,
    });
  }

  log.info("parser:chart", "Parsed chart XML", {
    textElements: results.length,
    skippedNumeric,
    skippedOther,
    sampleTexts: results.slice(0, 5).map((r) => r.text.slice(0, 40)),
  }, jobId);

  return results;
}

// ─── Index-based XML replacement ────────────────────────────────────

interface Replacement {
  start: number;
  end: number;
  newContent: string;
}

/**
 * Apply all replacements using absolute positions.
 * Sorted descending so positions remain valid.
 */
function applyReplacements(xml: string, replacements: Replacement[], jobId?: string): string {
  replacements.sort((a, b) => b.start - a.start);

  let result = xml;
  let applied = 0;
  let skipped = 0;

  for (const rep of replacements) {
    const original = result.slice(rep.start, rep.end);
    if (!original.startsWith("<")) {
      log.warn("parser", "Skipping replacement — invalid position", {
        position: rep.start,
        found: original.slice(0, 30),
      }, jobId);
      skipped++;
      continue;
    }
    result = result.slice(0, rep.start) + rep.newContent + result.slice(rep.end);
    applied++;
  }

  log.info("parser", "Applied replacements", { applied, skipped, total: replacements.length }, jobId);
  return result;
}

function applyParagraphTranslations(
  xml: string,
  paragraphs: ParagraphInfo[],
  translations: string[],
  jobId?: string
): string {
  const replacements: Replacement[] = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i]!;
    const translated = escapeXml(translations[i]!);

    for (let j = 0; j < para.runs.length; j++) {
      const run = para.runs[j]!;
      let newContent: string;

      if (j === 0) {
        let openTag = run.tagOpen;
        if (!openTag.includes('xml:space')) {
          openTag = openTag.replace(/>$/, ' xml:space="preserve">');
        }
        newContent = `${openTag}${translated}${run.tagClose}`;
      } else {
        newContent = `${run.tagOpen}${run.tagClose}`;
      }

      replacements.push({ start: run.absStart, end: run.absEnd, newContent });
    }
  }

  return applyReplacements(xml, replacements, jobId);
}

function applyChartTranslations(
  xml: string,
  chartTexts: ChartTextMatch[],
  translations: string[],
  jobId?: string
): string {
  const replacements: Replacement[] = [];

  for (let i = 0; i < chartTexts.length; i++) {
    const ct = chartTexts[i]!;
    const translated = escapeXml(translations[i]!);
    replacements.push({
      start: ct.absStart,
      end: ct.absEnd,
      newContent: `${ct.tagOpen}${translated}${ct.tagClose}`,
    });
  }

  return applyReplacements(xml, replacements, jobId);
}

// ─── XLSX parser ────────────────────────────────────────────────────

function findXlsxStrings(xml: string, jobId?: string): ParagraphInfo[] {
  const paragraphs: ParagraphInfo[] = [];
  const siRegex = /<si\b[^>]*>[\s\S]*?<\/si>/g;
  let siMatch: RegExpExecArray | null;
  let totalStrings = 0;
  let skipped = 0;

  while ((siMatch = siRegex.exec(xml)) !== null) {
    totalStrings++;
    const siStart = siMatch.index;
    const siContent = siMatch[0];
    const tRegex = /(<t\b[^>]*>)([\s\S]*?)(<\/t>)/g;
    let tMatch: RegExpExecArray | null;
    const runs: RunMatch[] = [];

    while ((tMatch = tRegex.exec(siContent)) !== null) {
      runs.push({
        absStart: siStart + tMatch.index,
        absEnd: siStart + tMatch.index + tMatch[0].length,
        tagOpen: tMatch[1]!,
        rawText: tMatch[2]!,
        tagClose: tMatch[3]!,
      });
    }

    if (runs.length > 0) {
      const fullText = runs.map((r) => unescapeXml(r.rawText)).join("");
      if (shouldSkipText(fullText)) {
        skipped++;
      } else {
        paragraphs.push({ runs, fullText });
      }
    }
  }

  log.info("parser:xlsx", "Parsed shared strings", {
    totalStrings,
    translatable: paragraphs.length,
    skipped,
  }, jobId);

  return paragraphs;
}

// ─── Public API ─────────────────────────────────────────────────────

export type DocType = "pptx" | "docx" | "xlsx";

export function getTranslatablePaths(type: DocType): RegExp[] {
  switch (type) {
    case "pptx":
      return [
        /^ppt\/slides\/slide\d+\.xml$/,
        /^ppt\/charts\/chart\d+\.xml$/,
        // Skip slideMasters, slideLayouts, notesSlides — they contain
        // only template placeholders and page numbers, not real content
      ];
    case "docx":
      return [
        /^word\/document\.xml$/,
        /^word\/header\d*\.xml$/,
        /^word\/footer\d*\.xml$/,
      ];
    case "xlsx":
      return [
        /^xl\/sharedStrings\.xml$/,
      ];
  }
}

export function detectDocType(filename: string): DocType | null {
  const ext = filename.toLowerCase().split(".").pop();
  switch (ext) {
    case "pptx": return "pptx";
    case "docx": return "docx";
    case "xlsx": return "xlsx";
    default: return null;
  }
}

/** Translate a single XML file content */
export async function translateXml(
  xml: string,
  filePath: string,
  docType: DocType,
  opts: TranslateOptions
): Promise<string> {
  const jobId = opts.jobId;
  const isChart = /chart\d+\.xml$/.test(filePath);

  log.info("parser", "Processing XML file", {
    file: filePath,
    type: isChart ? "chart" : docType,
    xmlSizeKb: Math.round(xml.length / 1024),
  }, jobId);

  try {
    if (isChart) {
      const chartTexts = findChartTexts(xml, jobId);
      if (chartTexts.length === 0) {
        log.info("parser:chart", "No translatable text in chart", { file: filePath }, jobId);
        return xml;
      }
      const texts = chartTexts.map((t) => t.text);
      const translated = await translateBatch(texts, opts);
      return applyChartTranslations(xml, chartTexts, translated, jobId);
    }

    let paragraphs: ParagraphInfo[];

    switch (docType) {
      case "pptx":
        paragraphs = findParagraphs(xml, "a:p", "a:t", jobId, "parser:pptx");
        break;
      case "docx":
        paragraphs = findParagraphs(xml, "w:p", "w:t", jobId, "parser:docx");
        break;
      case "xlsx":
        paragraphs = findXlsxStrings(xml, jobId);
        break;
    }

    if (paragraphs.length === 0) {
      log.info("parser", "No translatable paragraphs", { file: filePath }, jobId);
      return xml;
    }

    const texts = paragraphs.map((p) => p.fullText);
    const startMs = performance.now();
    const translated = await translateBatch(texts, opts);
    const elapsedMs = Math.round(performance.now() - startMs);

    log.info("parser", "Translation done for file", {
      file: filePath,
      paragraphs: paragraphs.length,
      elapsedMs,
    }, jobId);

    const result = applyParagraphTranslations(xml, paragraphs, translated, jobId);
    validateXmlBasic(result, filePath, jobId);
    return result;
  } catch (err: any) {
    log.error("parser", "Failed to process XML — returning original", {
      file: filePath,
      error: err.message,
    }, jobId);
    return xml;
  }
}

function validateXmlBasic(xml: string, filePath: string, jobId?: string) {
  const badAmpersand = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g;
  const badMatches = xml.match(badAmpersand);
  if (badMatches && badMatches.length > 0) {
    log.warn("validator", "Unescaped ampersands in output XML", {
      file: filePath,
      count: badMatches.length,
    }, jobId);
  }
}
