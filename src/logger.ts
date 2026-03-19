/**
 * Structured logger with file output and in-memory buffer for UI.
 * Logs everything needed to diagnose translation problems:
 * - XML parsing (paragraphs found, runs per paragraph, text fragmentation)
 * - Translation API calls (source text, result, timing, errors)
 * - Cache hits/misses
 * - File processing (ZIP contents, matched XML files, sizes)
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(import.meta.dir, "..", "logs");
mkdirSync(LOG_DIR, { recursive: true });

type LogLevel = "info" | "warn" | "error" | "debug";

interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

// Ring buffer for UI — last N entries
const MAX_BUFFER = 500;
const buffer: LogEntry[] = [];

// Per-job logs
const jobLogs = new Map<string, LogEntry[]>();

function timestamp(): string {
  return new Date().toISOString();
}

function logFileName(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.log`;
}

function formatForFile(entry: LogEntry): string {
  const dataStr = entry.data ? " " + JSON.stringify(entry.data) : "";
  return `[${entry.ts}] [${entry.level.toUpperCase().padEnd(5)}] [${entry.scope}] ${entry.msg}${dataStr}\n`;
}

function write(level: LogLevel, scope: string, msg: string, data?: Record<string, unknown>, jobId?: string) {
  const entry: LogEntry = { ts: timestamp(), level, scope, msg, data };

  // Console
  const prefix = { info: "  ", warn: "  ", error: "  ", debug: "  " }[level];
  const color = { info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m", debug: "\x1b[90m" }[level];
  const reset = "\x1b[0m";
  console.log(`${color}${prefix}[${scope}]${reset} ${msg}${data ? ` ${color}${JSON.stringify(data)}${reset}` : ""}`);

  // File
  try {
    appendFileSync(join(LOG_DIR, logFileName()), formatForFile(entry));
  } catch {}

  // In-memory buffer
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  // Per-job buffer
  if (jobId) {
    let logs = jobLogs.get(jobId);
    if (!logs) {
      logs = [];
      jobLogs.set(jobId, logs);
    }
    logs.push(entry);
  }
}

// ─── Public API ──────────────────────────────────────────────────────

export const log = {
  info: (scope: string, msg: string, data?: Record<string, unknown>, jobId?: string) =>
    write("info", scope, msg, data, jobId),

  warn: (scope: string, msg: string, data?: Record<string, unknown>, jobId?: string) =>
    write("warn", scope, msg, data, jobId),

  error: (scope: string, msg: string, data?: Record<string, unknown>, jobId?: string) =>
    write("error", scope, msg, data, jobId),

  debug: (scope: string, msg: string, data?: Record<string, unknown>, jobId?: string) =>
    write("debug", scope, msg, data, jobId),
};

/** Get recent log entries (for UI) */
export function getRecentLogs(limit = 100): LogEntry[] {
  return buffer.slice(-limit);
}

/** Get logs for a specific job */
export function getJobLogs(jobId: string): LogEntry[] {
  return jobLogs.get(jobId) || [];
}

/** Clean up old job logs */
export function clearJobLogs(jobId: string) {
  jobLogs.delete(jobId);
}

/** Format log entries as HTML for HTMX */
export function logsToHtml(entries: LogEntry[]): string {
  if (entries.length === 0) return '<p class="muted">No logs yet</p>';

  return entries
    .map((e) => {
      const levelClass = { info: "log-info", warn: "log-warn", error: "log-error", debug: "log-debug" }[e.level];
      const time = (e.ts.split("T")[1] ?? "").split(".")[0];
      const dataHtml = e.data
        ? `<span class="log-data">${escapeHtml(JSON.stringify(e.data, null, 0))}</span>`
        : "";
      return `<div class="log-line ${levelClass}"><span class="log-time">${time}</span> <span class="log-level">${e.level.toUpperCase().padEnd(5)}</span> <span class="log-scope">[${escapeHtml(e.scope)}]</span> <span class="log-msg">${escapeHtml(e.msg)}</span> ${dataHtml}</div>`;
    })
    .join("");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
