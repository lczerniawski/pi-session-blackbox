import { stripVTControlCharacters } from "node:util";

// Persisted data ID: retain it so decisions in existing sessions survive the Blackbox rename.
export const MARKER_TYPE = "session-flight-recorder.marker.v1";
export const KINDS = ["prompt", "assistant", "decision", "edit", "command", "test", "error", "tool", "model", "compaction", "branch"] as const;
export type RecordKind = (typeof KINDS)[number];
export interface FlightRecord {
  id: string;
  entryId: string;
  timestamp: string;
  kind: RecordKind;
  title: string;
  detail: string;
  failed: boolean;
  /** Offsets into the sanitized, capped detail excerpt; never duplicate full output. */
  command?: { end: number; outputStart: number; status: string };
  sourcePath?: string;
}
export interface TimelineQuery { kind?: RecordKind; failedOnly?: boolean; text?: string }
export interface ExportMetadata { sessionId: string; name?: string; cwd: string; exportedAt: string }

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }

/** Never let stored tool output emit terminal control sequences. */
export function cleanText(value: string): string {
  const withoutOsc = value.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c)/g, "");
  return stripVTControlCharacters(withoutOsc).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}
export function clipped(value: string, max = 6000): string {
  const clean = cleanText(value);
  return clean.length > max ? `${clean.slice(0, max)}\n[…truncated; original remains in Pi session history]` : clean;
}
function oneLine(value: string): string { return cleanText(value).replace(/\s+/g, " ").trim(); }
function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // Deliberately exclude thinking, signatures, image data, and tool arguments.
  return content.map((block) => {
    const item = object(block);
    return item.type === "text" ? string(item.text) : "";
  }).filter(Boolean).join("\n");
}
function firstLine(text: string): string {
  return text.split("\n").map((line) => oneLine(line).replace(/^#+\s*/, "")).find(Boolean) || "(no text)";
}
export function isTestCommand(command: string): boolean {
  // A label, not a shell parser or proof that tests passed. Avoid matching prose/echo.
  return /(?:^|&&|\|\||[;\n])\s*(?:(?:env\s+)?\w+=\S+\s+)*(?:npm\s+(?:test\b|run\s+test(?::[\w:-]+)?\b)|(?:pnpm|yarn|bun)\s+(?:(?:run|exec)\s+)?(?:test(?::[\w:-]+)?|vitest|jest)\b|(?:npx\s+)?(?:vitest|jest|pytest)\b|python[\d.]*\s+-m\s+(?:pytest|unittest)\b|go\s+test\b|cargo\s+test\b|node\b[^\n;&|]*\s--test\b|dotnet\s+test\b|(?:\.\/)?(?:gradlew|gradle|mvn)\s+test\b)/i.test(command);
}
function toolBase(name: string): string { return name.split(/[./:]/).pop() || name; }

/** Build only from the supplied active branch; no duplicated persistent log. */
export function buildTimeline(entries: readonly unknown[]): FlightRecord[] {
  const records: FlightRecord[] = [];
  const calls = new Map<string, { name: string; args: ObjectValue }>();
  for (const raw of entries) {
    const entry = object(raw);
    const id = string(entry.id);
    const timestamp = string(entry.timestamp);
    const add = (kind: RecordKind, title: string, detail = title, failed = false,
      presentation: Pick<FlightRecord, "command" | "sourcePath"> = {}) => {
      records.push({ id: `${id}:${records.length}`, entryId: id, timestamp, kind,
        title: clipped(oneLine(title), 240), detail: clipped(detail), failed, ...presentation });
    };
    const addCommand = (command: string, output: string, status: string, failed: boolean, direct = false) => {
      const safeCommand = cleanText(command);
      const prefix = `$ ${safeCommand}`;
      const separator = direct ? `\n${status}\n\n` : "\n\n";
      add(isTestCommand(command) ? "test" : "command", `${status}: ${command}`,
        `${prefix}${separator}${output}`, failed,
        { command: { end: prefix.length, outputStart: prefix.length + separator.length, status } });
    };
    if (entry.type === "custom" && entry.customType === MARKER_TYPE) {
      const note = string(object(entry.data).text);
      if (note) add("decision", `Marked decision: ${firstLine(note)}`, note);
    } else if (entry.type === "compaction") {
      add("compaction", `Compacted ${entry.tokensBefore ?? "unknown"} tokens`, string(entry.summary));
    } else if (entry.type === "branch_summary") {
      add("branch", `Branch summary from ${entry.fromId ?? "root"}`, string(entry.summary));
    } else if (entry.type === "model_change") {
      add("model", `${entry.provider}/${entry.modelId}`);
    } else if (entry.type === "message") {
      const message = object(entry.message);
      if (message.role === "user") {
        const text = textContent(message.content);
        add("prompt", firstLine(text), text || "[non-text prompt]");
      } else if (message.role === "assistant") {
        if (Array.isArray(message.content)) {
          for (const rawBlock of message.content) {
            const block = object(rawBlock);
            if (block.type === "toolCall") calls.set(string(block.id), { name: string(block.name), args: object(block.arguments) });
          }
        }
        const text = textContent(message.content);
        if (text.trim()) add("assistant", firstLine(text), text);
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          add("error", `Assistant ${message.stopReason}`, string(message.errorMessage) || text || `Assistant ${message.stopReason}`, true);
        }
      } else if (message.role === "toolResult") {
        const call = calls.get(string(message.toolCallId));
        const name = toolBase(string(message.toolName) || call?.name || "unknown");
        const args = call?.args || {};
        const output = textContent(message.content);
        const failed = message.isError === true;
        const status = failed ? "failed" : "completed";
        if (name === "edit" || name === "write") {
          const path = string(args.path) || "[path unavailable]";
          // Never duplicate write content or edit replacement payloads into the timeline.
          add("edit", `${name} ${status}: ${path}`, `${name} ${status}: ${path}\n\n${output}`, failed);
        } else if (name === "bash") {
          const command = string(args.command) || "[command unavailable]";
          addCommand(command, output, status, failed);
        } else {
          add(failed ? "error" : "tool", `${name} ${status}`, `${name} ${status}\n\n${output}`, failed,
            name === "read" && typeof args.path === "string" ? { sourcePath: clipped(oneLine(args.path), 240) } : {});
        }
      } else if (message.role === "bashExecution") {
        const command = string(message.command);
        const failed = message.cancelled === true || (typeof message.exitCode === "number" && message.exitCode !== 0);
        const status = message.cancelled ? "cancelled" : typeof message.exitCode === "number" ? `exit ${message.exitCode}` : "exit unknown";
        addCommand(command, string(message.output), status, failed, true);
      }
    }
  }
  return records;
}

/** Words AND together. kind:test/type:test and status:failed are optional filters. */
export function parseQuery(input: string): TimelineQuery {
  const words: string[] = [];
  const query: TimelineQuery = {};
  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    const match = /^(?:kind|type):(.+)$/i.exec(token);
    if (match && KINDS.includes(match[1].toLowerCase() as RecordKind)) query.kind = match[1].toLowerCase() as RecordKind;
    else if (/^status:failed$/i.test(token)) query.failedOnly = true;
    else words.push(token);
  }
  query.text = words.join(" ");
  return query;
}
export function filterTimeline(records: readonly FlightRecord[], query: TimelineQuery): FlightRecord[] {
  const words = (query.text || "").toLowerCase().split(/\s+/).filter(Boolean);
  return records.filter((record) => {
    if (query.kind && record.kind !== query.kind) return false;
    if (query.failedOnly && !record.failed) return false;
    const haystack = `${record.title}\n${record.detail}\n${record.entryId}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
export function timeLabel(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString("en-GB", { hour12: false });
}
function codeBlock(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) || []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}
export function exportMarkdown(records: readonly FlightRecord[], meta: ExportMetadata): string {
  const lines = ["# Blackbox — Pi session history", "", codeBlock(cleanText([
    `Session: ${meta.sessionId}`, `Name: ${meta.name || "(unnamed)"}`, `Working directory: ${meta.cwd}`,
    `Exported: ${meta.exportedAt}`, `Records: ${records.length}`,
  ].join("\n"))), "", "> Active branch only. Text excerpts are capped at 6,000 characters. Test labels identify commands, not proof of passing tests. Exports may contain sensitive prompt or command output.", ""];
  for (const record of records) {
    lines.push(`## ${cleanText(record.timestamp)} · ${record.kind}${record.failed ? " · FAILED" : ""}`, "",
      codeBlock(`Entry: ${record.entryId}\n${record.title}\n\n${record.detail}`), "");
  }
  return `${lines.join("\n")}\n`;
}
