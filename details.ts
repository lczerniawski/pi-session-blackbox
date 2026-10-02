import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, highlightCode } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { FlightRecord } from "./recorder.ts";
import { interpreterLanguage, languageCatalog, languageFromPath, shebangLanguage } from "./languages.ts";

function shellLines(command: string): string[] {
  const source = command.split("\n");
  const lines = highlightCode(command, "bash");
  // Explicit interpreter heredocs carry a known language; never guess from prose.
  for (let i = 0; i < source.length; i++) {
    const match = /^\s*(?:\w+=\S+\s+)*([\w./-]+)\b.*?<<(-?)(?:'([^']+)'|"([^"]+)"|(\w+))\s*$/.exec(source[i]);
    const language = match ? interpreterLanguage(match[1]) : undefined;
    if (!match || !language) continue;
    const delimiter = match[3] || match[4] || match[5];
    let end = i + 1;
    while (end < source.length && (match[2] ? source[end].replace(/^\t+/, "") : source[end]) !== delimiter) end++;
    if (end === source.length) continue;
    if (end > i + 1) {
      lines.splice(i + 1, end - i - 1, ...highlightCode(source.slice(i + 1, end).join("\n"), language));
    }
    i = end;
  }
  return lines;
}

function outputLanguage(text: string): string | undefined {
  if (/^(?:diff --git |@@ [-+]\d)/m.test(text)) return "diff";
  if (/^\s*[\[{]/.test(text)) {
    try { JSON.parse(text); return "json"; } catch { /* Logs that resemble JSON stay literal. */ }
  }
  return shebangLanguage(text);
}

// A bounded, literal shell-word scan, not a shell parser. Never expand variables or run commands.
// Filename-free snippets require one known language or the compatible JavaScript/TypeScript family.
function searchContext(command: string): { searched: boolean; language?: string } {
  const tokens = command.match(/(?:[^\s"';&|<>]|"(?:\\.|[^"\\])*"|'[^']*')+|[;&|<>]+|\n/g) ?? [];
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (/^[;&|<>]+$|^\n$/.test(token)) segments.push([]);
    else segments.at(-1)!.push(token.replace(/^(['"])([\s\S]*)\1$/, "$2"));
  }
  const languages = new Set<string>();
  let searched = false;
  let ambiguous = false;
  const valueOptions = new Set(["-A", "-B", "-C", "-m", "-g", "-t", "-T", "-j", "-r",
    "--after-context", "--before-context", "--context", "--max-count", "--glob", "--iglob", "--type",
    "--type-not", "--threads", "--replace", "--encoding", "--max-depth", "--color", "--colors",
    "--sort", "--sortr", "--context-separator", "--field-match-separator", "--field-context-separator"]);
  for (const segment of segments) {
    while (/^\w+=/.test(segment[0] ?? "")) segment.shift();
    if (!/^(?:.*\/)?(?:rg|grep)$/.test(segment[0] ?? "")) continue;
    searched = true;
    let pattern = false;
    let options = true;
    let paths = 0;
    for (let i = 1; i < segment.length; i++) {
      const word = segment[i];
      if (options && word === "--") { options = false; continue; }
      if (options && ["-e", "--regexp", "-f", "--file"].includes(word)) { pattern = true; i++; continue; }
      if (options && /^(?:-[ef].+|--(?:regexp|file)=)/.test(word)) { pattern = true; continue; }
      if (options && valueOptions.has(word)) { i++; continue; }
      if (options && word.startsWith("-")) continue;
      if (!pattern) { pattern = true; continue; }
      paths++;
      const language = languageFromPath(word);
      if (language) languages.add(language);
      else ambiguous = true;
    }
    if (!paths) ambiguous = true;
  }
  let language: string | undefined;
  if (!ambiguous && languages.size) {
    if (languages.size === 1) language = [...languages][0];
    // TypeScript's grammar also covers JS. A compound search can include .d.ts files
    // (even searches with no results); that must not disable colors for the JS output.
    else if ([...languages].every((value) => value === "javascript" || value === "typescript")) language = "typescript";
  }
  return { searched, language };
}

function searchLines(text: string, command: string, theme: Theme, override?: string): string[] | undefined {
  const context = searchContext(command);
  if (!context.searched) return undefined;
  const source = text.split("\n");
  const rendered: string[] = [];
  let language = override ?? context.language;
  let path: string | undefined;
  let block: { prefix: string; code: string; language: string }[] = [];
  const flush = () => {
    if (!block.length) return;
    // Highlight a whole contiguous source block so multiline comments/strings retain their state.
    const colored = highlightCode(block.map((line) => line.code).join("\n"), block[0].language);
    rendered.push(...block.map((line, i) => theme.fg("dim", line.prefix) + (colored[i] ?? theme.fg("toolOutput", line.code))));
    block = [];
  };
  for (let i = 0; i < source.length; i++) {
    const line = source[i];
    const numbered = /^(\d+[:-])(.*)$/.exec(line);
    const named = numbered ? null : /^(.+?)([:-])(\d+)\2(.*)$/.exec(line);
    const namedLanguage = named ? languageFromPath(named[1]) : undefined;
    if (named && named[1] !== path) { flush(); path = named[1]; }
    let code = named && (namedLanguage || override) ? named[4] : numbered?.[2];
    const sourceLanguage = override ?? (named ? namedLanguage : language);
    if (code !== undefined && sourceLanguage) {
      let prefix = line.slice(0, line.length - code.length);
      // rg --column emits an additional numeric field on match lines.
      const column = prefix.endsWith(":") ? /^(\d+:)(.*)$/.exec(code) : null;
      if (column) { prefix += column[1]; code = column[2]; }
      if (block.length && block[0].language !== sourceLanguage) flush();
      block.push({ prefix, code, language: sourceLanguage });
      if (namedLanguage && !override) language = namedLanguage;
    } else {
      flush();
      // rg --heading prints a filename before numbered snippets.
      if (named && !override) language = namedLanguage;
      if (line.trim() && line !== "--" && /^\d+[:-]/.test(source[i + 1] ?? "")) {
        path = line.trim();
        if (!override) language = languageFromPath(path);
      }
      rendered.push(...logLines(line, theme));
    }
  }
  flush();
  return rendered;
}

function logLines(text: string, theme: Theme): string[] {
  return text.split("\n").map((line) => {
    let color: ThemeColor = "toolOutput";
    if (/^\s*(?:error\b|fatal\b|fail(?:ed|ure)?\b|traceback\b|\w*Error:|✖|×)/i.test(line)) color = "error";
    else if (/^\s*(?:warn(?:ing)?\b|⚠)/i.test(line)) color = "warning";
    else if (/^\s*(?:PASS\b|ok\b|✔|✓)/i.test(line)) color = "success";
    return theme.fg(color, line);
  });
}

function overriddenLines(text: string, command: string, language: string, theme: Theme): string[] {
  if (language === "plaintext") return highlightCode(text, language);
  const searched = searchLines(text, command, theme, language);
  // Numbered search output retains its prefixes; other output is one explicitly chosen code block.
  if (searched && /^\d+[:-]|^.+?[:-]\d+[:-]/m.test(text)) return searched;
  return highlightCode(text, language);
}

/** A width-safe code panel. Wrap rather than truncate long code/output lines. */
function panel(lines: string[], width: number, theme: Theme): string[] {
  const text = lines.join("\n").replace(/\t/g, "    ");
  if (width < 8) return wrapTextWithAnsi(text, width);
  const innerWidth = width - 4;
  const border = (text: string) => theme.fg("mdCodeBlockBorder", text);
  return [border(`┌${"─".repeat(width - 2)}┐`),
    ...wrapTextWithAnsi(text, innerWidth).map((line) =>
      `${border("│ ")}${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))}${border(" │")}`),
    border(`└${"─".repeat(width - 2)}┘`)];
}

function markdownLines(text: string, width: number): string[] {
  return new Markdown(text, 0, 0, getMarkdownTheme()).render(width);
}

/** Render documents as Markdown, but keep indexed source listings readable and literal. */
function contentLines(text: string, width: number, theme: Theme, language?: string, command?: string): string[] {
  const indexedSearch = command !== undefined && searchContext(command).searched
    && /^(?:\d+[:-]|.+?[:-]\d+[:-])/m.test(text);
  if (language === "markdown" && !indexedSearch) return markdownLines(text, width);
  const lines = command !== undefined
    ? language ? overriddenLines(text, command, language, theme) : searchLines(text, command, theme) ?? logLines(text, theme)
    : language ? highlightCode(text, language) : logLines(text, theme);
  return panel(lines, width, theme);
}

/** Display-only formatting: stored excerpts, search, and exports remain literal. */
export function renderRecordDetails(record: FlightRecord, width: number, theme: Theme, languageOverride?: string): string[] {
  languageCatalog(); // Register all shipped grammars before file or Markdown highlighting.
  const w = Math.max(1, width);
  const heading = (text: string, color: ThemeColor = "accent") =>
    wrapTextWithAnsi(theme.fg(color, theme.bold(text)), w);
  let lines: string[];
  if (record.command) {
    const command = record.detail.slice(2, record.command.end);
    const output = record.detail.slice(record.command.outputStart);
    const language = outputLanguage(output);
    lines = [...heading(`Command · bash · ${record.command.status}`, record.failed ? "error" : "accent"),
      ...panel(shellLines(command), w, theme), "", ...heading(languageOverride ? `Output · ${languageOverride}` : "Output", record.failed ? "error" : "accent"),
      ...(output ? contentLines(output, w, theme, languageOverride ?? language, command)
        : [theme.fg("muted", record.command.outputStart >= record.detail.length && record.detail.includes("[…truncated;")
          ? "Output omitted by excerpt limit." : "(no output)")])];
  } else if (languageOverride) {
    const prefix = `${record.title}\n\n`;
    const output = record.detail.startsWith(prefix) ? record.detail.slice(prefix.length) : record.detail;
    lines = [...heading(`${record.title} · ${languageOverride}`, record.failed ? "error" : "accent"),
      ...contentLines(output, w, theme, languageOverride)];
  } else if (["prompt", "assistant", "decision", "compaction", "branch"].includes(record.kind)) {
    lines = markdownLines(record.detail, w);
  } else {
    const prefix = `${record.title}\n\n`;
    const output = record.detail.startsWith(prefix) ? record.detail.slice(prefix.length) : record.detail;
    const language = (record.sourcePath ? languageFromPath(record.sourcePath) : undefined) ?? outputLanguage(output);
    lines = [...heading(record.title, record.failed ? "error" : "accent"),
      ...(record.sourcePath ? [...heading(`File · ${record.sourcePath}`, "muted"), ""] : [""]),
      ...contentLines(output, w, theme, language)];
  }
  return lines.map((line) => truncateToWidth(line, w));
}
