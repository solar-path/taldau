/**
 * PDF translation pipeline.
 *
 * PDF → unpdf (text items) → normalize → sort → detect columns →
 * group into paragraphs → translate → build HTML → @easykit/pdf → PDF
 *
 * Fallback: if Chromium not found → returns HTML file instead of PDF.
 */

import { getDocumentProxy } from "unpdf";
import { log } from "./logger";

// ─── Types ─────────────────────────────────────────────────────────

interface RawTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
}

export interface NormalizedTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontCategory: "serif" | "sans" | "mono";
}

export interface PdfPage {
  pageNumber: number;
  width: number;
  height: number;
  items: RawTextItem[];
}

export interface ParagraphBlock {
  type: "paragraph";
  text: string;
  items: NormalizedTextItem[];
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontCategory: "serif" | "sans" | "mono";
  column: number;
}

export interface TableRowBlock {
  type: "table-row";
  cells: ParagraphBlock[];
  y: number;
}

export type Block = ParagraphBlock | TableRowBlock;

export interface InternalPage {
  pageNumber: number;
  width: number;
  height: number;
  blocks: Block[];
}

export interface InternalDoc {
  pages: InternalPage[];
}

// ─── 1. Extract raw text items from PDF ────────────────────────────

export async function extractPdfContent(pdfBuffer: Uint8Array, jobId?: string): Promise<PdfPage[]> {
  const doc = await getDocumentProxy(new Uint8Array(pdfBuffer));
  const pages: PdfPage[] = [];

  log.info("pdf", "PDF loaded", { numPages: doc.numPages }, jobId);

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();

    const items: RawTextItem[] = [];
    for (const item of textContent.items) {
      if (!("str" in item) || !item.str.trim()) continue;

      const tx = item.transform;
      items.push({
        text: item.str,
        x: tx[4],
        y: tx[5],
        width: item.width,
        height: item.height || Math.abs(tx[3]),
        fontName: item.fontName || "",
      });
    }

    pages.push({
      pageNumber: i,
      width: viewport.width,
      height: viewport.height,
      items,
    });

    log.debug("pdf", `Page ${i}: ${items.length} text items`, {
      pageWidth: Math.round(viewport.width),
      pageHeight: Math.round(viewport.height),
    }, jobId);
  }

  const totalItems = pages.reduce((sum, p) => sum + p.items.length, 0);
  log.info("pdf", "Extraction complete", { pages: pages.length, totalItems }, jobId);

  return pages;
}

// ─── 2. Normalize text items (fix dirty text) ─────────────────────

function classifyFont(fontName: string): "serif" | "sans" | "mono" {
  const lower = fontName.toLowerCase();
  if (/mono|courier|consol/i.test(lower)) return "mono";
  if (/serif|times|garamond|georgia|cambria|palatino/i.test(lower)) return "serif";
  return "sans";
}

/**
 * Merge glyphs into words, fix spacing, normalize unicode.
 * Solves: "H e l l o" → "Hello", double spaces, broken unicode.
 */
export function normalizeItems(items: RawTextItem[]): NormalizedTextItem[] {
  if (items.length === 0) return [];

  const result: NormalizedTextItem[] = [];
  let current: NormalizedTextItem | null = null;

  for (const item of items) {
    const normalized: NormalizedTextItem = {
      text: item.text.normalize("NFC"),
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      fontCategory: classifyFont(item.fontName),
    };

    if (!current) {
      current = { ...normalized };
      continue;
    }

    // Same line? (Y within tolerance)
    const sameLineY = Math.abs(current.y - normalized.y) < Math.max(current.height, normalized.height) * 0.5;
    if (!sameLineY) {
      result.push(current);
      current = { ...normalized };
      continue;
    }

    // Gap between end of current and start of next
    const gap = normalized.x - (current.x + current.width);

    // Average character width for threshold
    const avgCharWidth = current.text.length > 0
      ? current.width / current.text.length
      : normalized.height * 0.5;

    if (gap < avgCharWidth * 0.3) {
      // Tight gap: merge directly (broken glyphs)
      current.text += normalized.text;
      current.width = (normalized.x + normalized.width) - current.x;
    } else if (gap < avgCharWidth * 2.5) {
      // Normal word gap: merge with space
      current.text += " " + normalized.text;
      current.width = (normalized.x + normalized.width) - current.x;
    } else {
      // Large gap: separate items (different columns/blocks)
      result.push(current);
      current = { ...normalized };
    }
  }

  if (current) result.push(current);

  // Clean up double spaces
  for (const item of result) {
    item.text = item.text.replace(/\s{2,}/g, " ").trim();
  }

  return result.filter((item) => item.text.length > 0);
}

// ─── 3. Sort items by reading order ───────────────────────────────

export function sortItems(items: NormalizedTextItem[]): NormalizedTextItem[] {
  return [...items].sort((a, b) => {
    // PDF Y-axis goes bottom-to-top, so higher Y = higher on page
    // We want top-to-bottom reading order → descending Y
    if (Math.abs(a.y - b.y) < 2) return a.x - b.x;
    return b.y - a.y;
  });
}

// ─── 4. Detect columns ───────────────────────────────────────────

/**
 * Find column boundaries using X-position clustering.
 * Returns sorted array of column left-edge X positions.
 */
export function detectColumns(items: NormalizedTextItem[], pageWidth: number): number[] {
  if (items.length < 4) return [0];

  // Collect unique X starts (rounded to reduce noise)
  const xStarts: number[] = items.map((it) => Math.round(it.x / 5) * 5);
  xStarts.sort((a, b) => a - b);

  // Find large gaps in X positions (> 15% of page width)
  const gapThreshold = pageWidth * 0.15;
  const uniqueXs = [...new Set(xStarts)].sort((a, b) => a - b);

  const columnStarts: number[] = [uniqueXs[0]!];

  for (let i = 1; i < uniqueXs.length; i++) {
    const gap = uniqueXs[i]! - uniqueXs[i - 1]!;
    if (gap > gapThreshold) {
      columnStarts.push(uniqueXs[i]!);
    }
  }

  return columnStarts;
}

function assignColumn(x: number, columnStarts: number[]): number {
  for (let i = columnStarts.length - 1; i >= 0; i--) {
    if (x >= columnStarts[i]! - 10) return i;
  }
  return 0;
}

// ─── 5. Group into paragraphs and detect tables ──────────────────

/**
 * Check if text should be skipped (same logic as parsers.ts).
 * Duplicated here to avoid circular dependency — keeps pdf.ts self-contained.
 */
function shouldSkipText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^[\d\s.,:%+\-–—$/€₸₽¥£()]+$/.test(t)) return true;
  if (t.length <= 1) return true;
  if (/^\[.*\]$/.test(t)) return true;
  if (/^[‹›#]+$/.test(t)) return true;
  return false;
}

interface LineGroup {
  y: number;
  items: NormalizedTextItem[];
}

function groupIntoLines(items: NormalizedTextItem[]): LineGroup[] {
  if (items.length === 0) return [];

  const lines: LineGroup[] = [];
  let currentLine: LineGroup = { y: items[0]!.y, items: [items[0]!] };

  for (let i = 1; i < items.length; i++) {
    const item = items[i]!;
    // Items are already sorted by Y desc then X asc
    // Same line if Y within half the line height
    const tolerance = Math.max(currentLine.items[0]!.height, item.height) * 0.5;
    if (Math.abs(currentLine.y - item.y) < tolerance) {
      currentLine.items.push(item);
    } else {
      lines.push(currentLine);
      currentLine = { y: item.y, items: [item] };
    }
  }
  lines.push(currentLine);

  return lines;
}

function isTableRow(line: LineGroup, pageWidth: number): boolean {
  if (line.items.length < 3) return false;
  // Multiple items spread across the page width
  const xs = line.items.map((it) => it.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const spread = maxX - minX;
  return spread > pageWidth * 0.3 && line.items.length >= 3;
}

export function buildInternalDoc(pages: PdfPage[], jobId?: string): InternalDoc {
  const internalPages: InternalPage[] = [];

  for (const page of pages) {
    const normalized = normalizeItems(page.items);
    const sorted = sortItems(normalized);
    const columnStarts = detectColumns(sorted, page.width);
    const lines = groupIntoLines(sorted);

    const blocks: Block[] = [];

    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;

      // Table detection
      if (isTableRow(line, page.width)) {
        const cells: ParagraphBlock[] = line.items
          .filter((it) => !shouldSkipText(it.text))
          .map((it) => ({
            type: "paragraph" as const,
            text: it.text,
            items: [it],
            x: it.x,
            y: it.y,
            width: it.width,
            fontSize: it.height,
            fontCategory: it.fontCategory,
            column: assignColumn(it.x, columnStarts),
          }));

        if (cells.length > 0) {
          blocks.push({ type: "table-row", cells, y: line.y });
        }
        i++;
        continue;
      }

      // Paragraph grouping: merge consecutive lines that are close vertically
      // and in the same column
      const paragraphLines: LineGroup[] = [line];
      const lineColumn = assignColumn(line.items[0]!.x, columnStarts);
      const lineHeight = line.items[0]!.height;

      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1]!;
        const nextColumn = assignColumn(nextLine.items[0]!.x, columnStarts);

        // Must be same column
        if (nextColumn !== lineColumn) break;

        // Must be close vertically (within 1.5x line height)
        const yGap = Math.abs(line.y - nextLine.y);
        if (yGap > lineHeight * 1.5) break;

        // Don't merge table rows into paragraphs
        if (isTableRow(nextLine, page.width)) break;

        paragraphLines.push(nextLine);
        i++;
      }

      // Merge all items from paragraph lines
      const allItems = paragraphLines.flatMap((l) => l.items);
      const text = allItems.map((it) => it.text).join(" ");

      if (!shouldSkipText(text)) {
        const xs = allItems.map((it) => it.x);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs.map((x, idx) => x + allItems[idx]!.width));

        blocks.push({
          type: "paragraph",
          text,
          items: allItems,
          x: minX,
          y: Math.max(...allItems.map((it) => it.y)),
          width: maxX - minX,
          fontSize: allItems.reduce((sum, it) => sum + it.height, 0) / allItems.length,
          fontCategory: allItems[0]!.fontCategory,
          column: lineColumn,
        });
      }

      i++;
    }

    const textBlocks = blocks.filter((b) =>
      b.type === "paragraph" ? !shouldSkipText(b.text) : b.cells.some((c) => !shouldSkipText(c.text))
    );

    internalPages.push({
      pageNumber: page.pageNumber,
      width: page.width,
      height: page.height,
      blocks: textBlocks,
    });

    log.debug("pdf", `Page ${page.pageNumber}: ${textBlocks.length} blocks`, {
      paragraphs: textBlocks.filter((b) => b.type === "paragraph").length,
      tableRows: textBlocks.filter((b) => b.type === "table-row").length,
      columns: columnStarts.length,
    }, jobId);
  }

  const totalBlocks = internalPages.reduce((sum, p) => sum + p.blocks.length, 0);
  log.info("pdf", "Internal document built", {
    pages: internalPages.length,
    totalBlocks,
  }, jobId);

  return { pages: internalPages };
}

// ─── 6. Collect all translatable texts ───────────────────────────

export function collectTexts(doc: InternalDoc): string[] {
  const texts: string[] = [];

  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.type === "paragraph") {
        texts.push(block.text);
      } else {
        for (const cell of block.cells) {
          texts.push(cell.text);
        }
      }
    }
  }

  return texts;
}

// ─── 7. Build translated HTML with adaptive layout ───────────────

const FONT_STACKS: Record<string, string> = {
  serif: "'Times New Roman', Georgia, serif",
  sans: "Arial, Helvetica, sans-serif",
  mono: "'Courier New', monospace",
};

function autoFitFontSize(original: string, translated: string, baseFontSize: number): number {
  if (translated.length <= original.length * 1.4) return baseFontSize;
  const scale = (original.length * 1.4) / translated.length;
  return Math.max(baseFontSize * scale, baseFontSize * 0.7);
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildTranslatedHtml(
  doc: InternalDoc,
  translations: Map<string, string>
): string {
  const pagesHtml: string[] = [];

  for (const page of doc.pages) {
    const blocksHtml: string[] = [];

    for (const block of page.blocks) {
      if (block.type === "paragraph") {
        const translated = translations.get(block.text) || block.text;
        const fontSize = autoFitFontSize(block.text, translated, block.fontSize);
        const fontStack = FONT_STACKS[block.fontCategory] || FONT_STACKS.sans;

        // Convert PDF coordinates (origin bottom-left) to CSS (origin top-left)
        const cssTop = page.height - block.y;

        blocksHtml.push(
          `<div style="position:absolute;left:${block.x.toFixed(1)}px;top:${cssTop.toFixed(1)}px;` +
          `max-width:${Math.max(block.width, 100).toFixed(1)}px;` +
          `font-size:${fontSize.toFixed(1)}px;font-family:${fontStack};` +
          `line-height:1.3;white-space:normal;word-break:break-word;overflow:hidden">${escHtml(translated)}</div>`
        );
      } else {
        // Table row → horizontal flex container
        const cellsHtml = block.cells.map((cell) => {
          const translated = translations.get(cell.text) || cell.text;
          const fontSize = autoFitFontSize(cell.text, translated, cell.fontSize);
          const fontStack = FONT_STACKS[cell.fontCategory] || FONT_STACKS.sans;
          return `<div style="flex:1;padding:2px 4px;font-size:${fontSize.toFixed(1)}px;font-family:${fontStack}">${escHtml(translated)}</div>`;
        }).join("");

        const cssTop = page.height - block.y;

        blocksHtml.push(
          `<div style="position:absolute;left:${block.cells[0]!.x.toFixed(1)}px;top:${cssTop.toFixed(1)}px;` +
          `width:${(page.width - block.cells[0]!.x * 2).toFixed(1)}px;` +
          `display:flex;gap:4px">${cellsHtml}</div>`
        );
      }
    }

    pagesHtml.push(
      `<div style="position:relative;width:${page.width.toFixed(1)}px;height:${page.height.toFixed(1)}px;` +
      `page-break-after:always;margin:0 auto;background:#fff">${blocksHtml.join("")}</div>`
    );
  }

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>
  @page { margin: 0; size: auto; }
  body { margin: 0; padding: 0; background: #fff; }
  div { box-sizing: border-box; }
</style>
</head><body>${pagesHtml.join("")}</body></html>`;
}

// ─── 8. Render to PDF with Chromium fallback ─────────────────────

export async function renderToPdf(
  html: string,
  pageWidth: number,
  pageHeight: number,
  jobId?: string
): Promise<{ buffer: Buffer; format: "pdf" | "html" }> {
  try {
    const { generatePdf } = await import("@easykit/pdf");
    const buffer = await generatePdf({
      html,
      format: "A4",
      margins: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
    });
    log.info("pdf", "PDF generated via Chromium", { sizeKb: Math.round(buffer.length / 1024) }, jobId);
    return { buffer, format: "pdf" };
  } catch (err: any) {
    log.warn("pdf", "Chromium not found, returning HTML", { error: err.message }, jobId);
    return { buffer: Buffer.from(html, "utf-8"), format: "html" };
  }
}

// ─── 9. Full pipeline ────────────────────────────────────────────

export const MAX_PDF_SIZE = 50 * 1024 * 1024; // 50MB
export const MAX_PDF_PAGES = 100;
