/**
 * Glossary term protection/restoration for translation pipeline.
 *
 * Before translation: replace glossary terms with placeholders like ⟦GL001⟧
 * After translation: replace placeholders with glossary target terms.
 *
 * Uses Unicode brackets (⟦⟧) instead of [[]] — translation engines
 * are less likely to mangle them.
 */

import { log } from "./logger";

const PH_LEFT = "\u27E6";   // ⟦
const PH_RIGHT = "\u27E7";  // ⟧
const PH_PREFIX = "GL";

interface ProtectionResult {
  text: string;
  /** Map: placeholder -> glossary target term */
  placeholders: Map<string, string>;
}

/**
 * Replace glossary source terms with numbered placeholders.
 * The glossary map must be sorted longest-first (getGlossaryMap does this).
 */
export function protectTerms(
  text: string,
  glossary: Map<string, string>,
  jobId?: string
): ProtectionResult {
  const placeholders = new Map<string, string>();

  if (glossary.size === 0) return { text, placeholders };

  let result = text;
  let counter = 0;

  for (const [source, target] of glossary) {
    // Case-insensitive search for the source term
    const regex = new RegExp(escapeRegex(source), "gi");
    if (regex.test(result)) {
      const ph = `${PH_LEFT}${PH_PREFIX}${String(counter).padStart(3, "0")}${PH_RIGHT}`;
      placeholders.set(ph, target);
      result = result.replace(regex, ph);
      counter++;

      log.debug("glossary", "Protected term", {
        source: source.slice(0, 40),
        placeholder: ph,
        target: target.slice(0, 40),
      }, jobId);
    }
  }

  return { text: result, placeholders };
}

/**
 * Restore placeholders with glossary target terms after translation.
 */
export function restoreTerms(
  translatedText: string,
  placeholders: Map<string, string>,
  jobId?: string
): string {
  if (placeholders.size === 0) return translatedText;

  let result = translatedText;

  for (const [ph, target] of placeholders) {
    if (result.includes(ph)) {
      result = result.replaceAll(ph, target);
    } else {
      // Engine might have mangled the placeholder — try fuzzy match
      const stripped = ph.replace(PH_LEFT, "").replace(PH_RIGHT, "");
      if (result.includes(stripped)) {
        result = result.replaceAll(stripped, target);
        log.warn("glossary", "Placeholder was mangled, restored via fuzzy match", {
          placeholder: ph,
          target: target.slice(0, 40),
        }, jobId);
      } else {
        log.warn("glossary", "Placeholder lost during translation", {
          placeholder: ph,
          target: target.slice(0, 40),
        }, jobId);
      }
    }
  }

  return result;
}

/**
 * Batch protect/restore for an array of texts.
 */
export function protectBatch(
  texts: string[],
  glossary: Map<string, string>,
  jobId?: string
): { texts: string[]; allPlaceholders: Map<string, string>[] } {
  const allPlaceholders: Map<string, string>[] = [];
  const protectedTexts: string[] = [];

  for (const text of texts) {
    const { text: protected_, placeholders } = protectTerms(text, glossary, jobId);
    protectedTexts.push(protected_);
    allPlaceholders.push(placeholders);
  }

  return { texts: protectedTexts, allPlaceholders };
}

export function restoreBatch(
  translatedTexts: string[],
  allPlaceholders: Map<string, string>[],
  jobId?: string
): string[] {
  return translatedTexts.map((text, i) =>
    restoreTerms(text, allPlaceholders[i]!, jobId)
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
