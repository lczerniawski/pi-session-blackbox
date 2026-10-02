import { mkdir, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { exportMarkdown, type ExportMetadata, type FlightRecord } from "./recorder.ts";

export function resolveExportPath(path: string, cwd: string): string {
  const unquoted = path.replace(/^(["'])(.*)\1$/s, "$2");
  return resolve(cwd, unquoted === "~" ? homedir() : unquoted.startsWith("~/") ? join(homedir(), unquoted.slice(2)) : unquoted);
}
export function defaultExportPath(sessionId: string, now = new Date()): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "session";
  return join(agentDir, "exports", "blackbox", `${now.toISOString().replace(/[:.]/g, "-")}_${safeId}.md`);
}

/** Existing folders keep the generated filename; custom parents are never created implicitly. */
export async function resolveExportDestination(path: string, cwd: string, suggestedPath: string, folderOnly = false): Promise<string> {
  const target = resolveExportPath(path, cwd);
  const folderRequested = folderOnly || /[/\\]["']?$/.test(path);
  let directory = false;
  try { directory = (await stat(target)).isDirectory(); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    if (folderRequested) throw new Error(`Export folder does not exist: ${target}`);
  }
  if (directory) return join(target, basename(suggestedPath));
  if (folderRequested) throw new Error(`Export folder is not a directory: ${target}`);
  return target;
}

/** Explicit export only; exclusive creation refuses overwrite and existing symlinks. */
export async function saveExport(path: string, records: readonly FlightRecord[], meta: ExportMetadata, createDefaultDirectory = false): Promise<void> {
  if (createDefaultDirectory) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  }
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(exportMarkdown(records, meta), "utf8"); }
  finally { await file.close(); }
}
