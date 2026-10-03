import type { KeybindingsManager, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, matchesKey, truncateToWidth, type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { filterTimeline, parseQuery, timeLabel, type BlackboxRecord, type RecordKind } from "./timeline.ts";
import { renderRecordDetails } from "./details.ts";
import { languageCatalog, languageCatalogError } from "./languages.ts";

function printableInput(data: string): string {
  // Input supports CSI-u text but not xterm modifyOtherKeys. Preserve plain text and paste.
  return data.replace(/^\x1b\[27;(\d+);(\d+)~$/, "\x1b[$2;$1u");
}

const CATEGORY_COLORS: Record<RecordKind, ThemeColor> = {
  prompt: "accent",
  assistant: "text",
  decision: "syntaxKeyword",
  edit: "toolDiffAdded",
  command: "bashMode",
  test: "syntaxType",
  error: "error",
  tool: "toolTitle",
  model: "syntaxFunction",
  compaction: "muted",
  branch: "syntaxKeyword",
};

export type BrowserResult = { exportRecords: BlackboxRecord[] } | undefined;

export class TimelineBrowser implements Component, Focusable {
  private input = new Input({ prompt: "Search: ", placeholder: "words · kind:test · status:failed" });
  private list!: SelectList;
  private filtered: BlackboxRecord[] = [];
  private details?: BlackboxRecord;
  private scroll = 0;
  private focusedValue = false;
  private listHeight = 0;
  private detailLineCount = 0;
  private detailHeight = 1;
  private detailCache?: { record: BlackboxRecord; width: number; lines: string[] };
  private languageOverrides = new Map<string, string>();
  private languageInput = new Input({ prompt: "Language: ", placeholder: "name or alias (e.g. python, rust, yaml)" });
  private languageList?: SelectList;
  private languageListHeight = 0;

  constructor(private records: BlackboxRecord[], private tui: TUI, private theme: Theme,
    private keys: KeybindingsManager, private done: (result: BrowserResult) => void, query = "") {
    this.input.setValue(query);
    this.rebuild();
  }
  get focused(): boolean { return this.focusedValue; }
  set focused(value: boolean) {
    this.focusedValue = value;
    this.input.focused = value && !this.details;
    this.languageInput.focused = value && !!this.languageList;
  }
  invalidate(): void {
    this.input.invalidate(); this.list.invalidate(); this.languageInput.invalidate();
    this.languageList?.invalidate(); this.detailCache = undefined;
  }

  private rebuild(preserve = false): void {
    const previous = preserve ? this.list?.getSelectedItem()?.value : undefined;
    this.filtered = filterTimeline(this.records, parseQuery(this.input.getValue())).reverse();
    // Reserve eight header/footer rows and one SelectList scroll-indicator row.
    this.listHeight = Math.max(1, this.tui.terminal.rows - 9);
    const recordsById = new Map(this.filtered.map((record) => [record.id, record]));
    this.list = new SelectList(this.filtered.map((record) => ({
      value: record.id,
      label: `${timeLabel(record.timestamp)} ${record.failed ? "!" : "·"} ${record.kind.padEnd(10)} ${record.title}`,
    })), this.listHeight, {
      ...getSelectListTheme(),
      // Keep category colors on the selected row; distinguish it with bold/background.
      selectedText: (text) => this.theme.bg("selectedBg", this.theme.bold(text)),
    }, {
      // Apply colors at render time so theme changes never leave stale ANSI labels.
      truncatePrimary: ({ item, maxWidth }) => truncateToWidth(this.rowLabel(recordsById.get(item.value)!), Math.max(0, maxWidth), ""),
    });
    this.list.onSelect = (item) => {
      this.details = this.filtered.find((record) => record.id === item.value);
      this.scroll = 0;
      this.input.focused = false;
    };
    if (previous) this.list.setSelectedIndex(Math.max(0, this.filtered.findIndex((record) => record.id === previous)));
  }

  private rebuildLanguages(preferred = this.languageList?.getSelectedItem()?.value): void {
    const query = this.languageInput.getValue().trim().toLowerCase();
    const choices = [
      { value: "automatic", label: "Automatic", description: "Use file hints; render Markdown documents" },
      { value: "plaintext", label: "Plain text", description: "Literal source; no Markdown formatting or highlighting" },
      ...languageCatalog().filter((item) => item.value !== "plaintext"),
    ].filter((item) => `${item.value} ${item.label} ${item.description ?? ""}`.toLowerCase().includes(query));
    const rank = (item: (typeof choices)[number]) => item.value.toLowerCase() === query ? 3
      : item.label.toLowerCase() === query ? 2
        : (item.description ?? "").split(/,\s*/).some((name) => name.toLowerCase() === query) ? 1 : 0;
    choices.sort((a, b) => rank(b) - rank(a));
    // The picker has seven header/footer rows, plus the scroll indicator.
    this.languageListHeight = Math.max(1, this.tui.terminal.rows - 8);
    this.languageList = new SelectList(choices, this.languageListHeight, getSelectListTheme());
    this.languageList.onSelect = (item) => {
      if (this.details) {
        if (item.value === "automatic") this.languageOverrides.delete(this.details.id);
        else this.languageOverrides.set(this.details.id, item.value);
      }
      this.detailCache = undefined;
      this.languageList = undefined;
      this.languageInput.focused = false;
    };
    this.languageList.setSelectedIndex(Math.max(0, choices.findIndex((item) => item.value === preferred)));
  }

  private openLanguages(): void {
    this.languageInput.setValue("");
    this.rebuildLanguages(this.details ? this.languageOverrides.get(this.details.id) ?? "automatic" : "automatic");
    this.languageInput.focused = this.focusedValue;
  }

  private recordColor(record: BlackboxRecord): ThemeColor {
    return record.failed ? "error" : CATEGORY_COLORS[record.kind];
  }

  private rowLabel(record: BlackboxRecord): string {
    const color = this.recordColor(record);
    const status = record.failed ? this.theme.fg("error", this.theme.bold("!")) : this.theme.fg(color, "·");
    return `${this.theme.fg("dim", timeLabel(record.timestamp))} ${status} ${this.theme.fg(color, record.kind.padEnd(10))} ${this.theme.fg(record.failed ? "error" : "text", record.title)}`;
  }

  private scrollTo(line: number): boolean {
    if (!Number.isFinite(line)) return false;
    const next = Math.max(0, Math.min(Math.max(0, this.detailLineCount - this.detailHeight), Math.trunc(line)));
    const changed = next !== this.scroll;
    this.scroll = next;
    return changed;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.languageList && event.type === "wheel") return { handled: true, render: false };
    if (event.type !== "wheel" || !event.wheelDelta || !Number.isFinite(event.wheelDelta)) return undefined;
    // Pi has already converted wheel/trackpad input into logical lines, including acceleration.
    let changed = false;
    if (this.details) {
      changed = this.scrollTo(this.scroll + event.wheelDelta);
    } else {
      const selected = this.list.getSelectedItem();
      const index = this.filtered.findIndex((record) => record.id === selected?.value);
      if (index >= 0) {
        const next = Math.max(0, Math.min(this.filtered.length - 1, Math.trunc(index + event.wheelDelta)));
        changed = next !== index;
        if (changed) this.list.setSelectedIndex(next);
      }
    }
    if (changed) this.tui.requestRender();
    // Consume wheel events even at the bounds so they never scroll the transcript behind the reader.
    return { handled: true, render: changed };
  }

  handleInput(data: string): void {
    if (this.languageList) {
      if (this.keys.matches(data, "tui.select.cancel")) {
        this.languageList = undefined;
        this.languageInput.focused = false;
      } else if ((["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm"] as const)
        .some((key) => this.keys.matches(data, key))) {
        this.languageList.handleInput(data);
      } else {
        const before = this.languageInput.getValue();
        this.languageInput.handleInput(printableInput(data));
        if (before !== this.languageInput.getValue()) this.rebuildLanguages("");
      }
      this.tui.requestRender();
      return;
    }
    if (this.details && matchesKey(data, "ctrl+l")) {
      this.openLanguages();
    } else if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.details) { this.details = undefined; this.input.focused = this.focusedValue; }
      else this.done(undefined);
    } else if (matchesKey(data, "ctrl+x")) {
      this.done({ exportRecords: [...this.filtered].reverse() });
    } else if (this.details) {
      const up = this.keys.matches(data, "tui.select.up");
      const down = this.keys.matches(data, "tui.select.down");
      const pageUp = this.keys.matches(data, "tui.select.pageUp");
      const pageDown = this.keys.matches(data, "tui.select.pageDown");
      const amount = pageUp || pageDown ? this.detailHeight : 1;
      if (this.keys.matches(data, "tui.altScreen.top") || matchesKey(data, "ctrl+home")) this.scrollTo(0);
      else if (this.keys.matches(data, "tui.altScreen.bottom") || matchesKey(data, "ctrl+end")) this.scrollTo(this.detailLineCount);
      else if (up || pageUp) this.scrollTo(this.scroll - amount);
      else if (down || pageDown) this.scrollTo(this.scroll + amount);
    } else if ((["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm"] as const).some(
      (key) => this.keys.matches(data, key))) {
      this.list.handleInput(data);
    } else {
      const before = this.input.getValue();
      this.input.handleInput(printableInput(data));
      if (before !== this.input.getValue()) this.rebuild();
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    const height = Math.max(1, this.tui.terminal.rows);
    let lines: string[];
    if (this.languageList) {
      if (this.languageListHeight !== Math.max(1, height - 8)) this.rebuildLanguages();
      lines = [this.theme.fg("accent", this.theme.bold(languageCatalogError() ? "Choose language · catalog unavailable" : `Choose language · ${languageCatalog().length} installed grammars`)),
      this.theme.fg("dim", "This record only · display-only override · no automatic guessing"),
      ...this.languageInput.render(w), "", ...this.languageList!.render(w), "",
      this.theme.fg(languageCatalogError() ? "warning" : "dim", languageCatalogError()
        ? "Full grammar catalog unavailable in this Pi installation. Automatic hints remain available."
        : "Commands stay Bash; Markdown renders formatting; Plain text shows source."),
      this.theme.fg("dim", "Type name/alias · ↑↓ select · Enter apply · Esc cancel")];
    } else if (this.details) {
      const record = this.details;
      if (this.detailCache?.record !== record || this.detailCache.width !== w) {
        this.detailCache = { record, width: w, lines: renderRecordDetails(record, w, this.theme, this.languageOverrides.get(record.id)) };
      }
      const wrapped = this.detailCache.lines;
      this.detailHeight = Math.max(1, height - 4);
      this.detailLineCount = wrapped.length;
      this.scroll = Math.min(this.scroll, Math.max(0, wrapped.length - this.detailHeight));
      lines = [this.theme.fg(this.recordColor(record), `${record.kind} · ${record.timestamp} · entry ${record.entryId}`), "",
      ...wrapped.slice(this.scroll, this.scroll + this.detailHeight), "",
      this.theme.fg("dim", `${this.tui.mode === "fullscreen" ? "Wheel / " : ""}↑↓/PgUp/PgDn · Home/End · Ctrl+L language · Esc back · Ctrl+X export · ${this.scroll + 1}/${wrapped.length}`)];
    } else {
      if (this.listHeight !== Math.max(1, height - 9)) this.rebuild(true);
      const selected = this.filtered.find((record) => record.id === this.list.getSelectedItem()?.value);
      lines = [this.theme.fg("accent", this.theme.bold(`Blackbox · ${this.filtered.length}/${this.records.length} records`)),
      this.theme.fg("dim", "Active branch · newest first · no extra model calls"),
      ...this.input.render(w), "", ...this.list.render(w), "",
      this.theme.fg("muted", selected ? truncateToWidth(selected.detail.replace(/\s+/g, " "), w) : "No matching records."),
      this.theme.fg("dim", `Type to search · ${this.tui.mode === "fullscreen" ? "Wheel / " : ""}↑↓ select · Enter details · Esc close · Ctrl+X export`),
      this.theme.fg("dim", "Start filtered: /blackbox kind:test status:failed · /blackbox help")];
    }
    // maxHeight only caps an overlay; it does not fill unused rows. Cover the whole viewport
    // (including short/empty views) so the transcript cannot show above or below the reader.
    const footer = lines.at(-1) ?? "";
    const body = lines.slice(0, -1).slice(0, height - 1);
    return [...body, ...Array<string>(height - 1 - body.length).fill(""), footer]
      .map((line) => truncateToWidth(line, w));
  }
}
