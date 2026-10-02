import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";

// Use Pi's installed dependencies: the extension itself needs no npm install.
const piRoot = process.env.PI_PACKAGE_PATH || resolve(dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent");
const fromPi = async (path) => import(pathToFileURL(join(piRoot, path)).href);
const { loadExtensions } = await fromPi("dist/core/extensions/loader.js");
const themes = await fromPi("dist/modes/interactive/theme/theme.js");
const { KeybindingsManager } = await fromPi("dist/core/keybindings.js");
const { visibleWidth } = await fromPi("node_modules/@earendil-works/pi-tui/dist/utils.js");
const { TuiAltScreen } = await fromPi("node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js");
themes.initTheme("dark", false);
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const loaded = await loadExtensions([extensionPath], process.cwd());
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
const handler = extension.commands.get("blackbox").handler;
const stamp = "2026-06-01T12:00:00.000Z";
const entries = [
  { type: "message", id: "prompt", timestamp: stamp, message: { role: "user", content: "Fix auth 🔐 漢字" } },
  { type: "message", id: "call", timestamp: stamp, message: { role: "assistant", content: [
    { type: "toolCall", id: "test", name: "bash", arguments: { command: "npm test" } }] } },
  { type: "message", id: "result", timestamp: stamp, message: { role: "toolResult", toolCallId: "test", toolName: "bash",
    isError: true, content: [{ type: "text", text: "assertion failed\n".repeat(100) }] } },
];
function context(overrides = {}) {
  const notifications = [];
  return { notifications, cwd: "/project", mode: "tui", hasUI: true, waitForIdle: async () => {},
    sessionManager: { getBranch: () => entries, getSessionId: () => "test-session", getSessionName: () => "Test flight" },
    ui: { notify: (text, type) => notifications.push({ text, type }), confirm: async () => false,
      select: async (_title, options) => options[0], input: async () => undefined }, ...overrides };
}

async function inspectDetails(history, check) {
  const ctx = context({ sessionManager: { getBranch: () => history } });
  ctx.ui.custom = async (factory) => {
    let result;
    const tui = { terminal: { rows: 60 }, requestRender: () => {} };
    const browser = factory(tui, themes.theme, new KeybindingsManager(), (value) => { result = value; });
    browser.handleInput("\r");
    await check(browser, tui, () => result);
    return undefined;
  };
  await handler("", ctx);
  assert.deepEqual(ctx.notifications, []);
}

test("Pi loads Blackbox only, preserves saved markers, and adds no extra tools/hooks", async () => {
  assert.deepEqual([...extension.commands.keys()], ["blackbox"]);
  assert.equal(extension.commands.has("timeline"), false, "No compatibility alias");
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "pi-session-blackbox");
  assert.equal(manifest.license, "MIT");
  assert.ok(manifest.files.includes("LICENSE"));
  assert.match(await readFile(new URL("../LICENSE", import.meta.url), "utf8"), /^MIT License/);
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "*");
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.private, undefined);
  assert.deepEqual([...extension.entryRenderers.keys()], ["session-flight-recorder.marker.v1"]);
  assert.equal(extension.tools.size, 0);
  assert.equal(extension.handlers.size, 0);
});

test("Blackbox command exposes filter examples, help, and composable argument suggestions", async () => {
  const command = extension.commands.get("blackbox");
  assert.match(command.description, /kind:test/);
  assert.match(command.description, /status:failed/);
  const complete = command.getArgumentCompletions;
  const values = (prefix) => (complete(prefix) || []).map((item) => item.value);
  for (const value of ["kind:test", "kind:edit", "kind:decision", "status:failed", "help"]) {
    assert.ok(values("").includes(value), value);
  }
  assert.deepEqual(values("kind:te"), ["kind:test"]);
  assert.deepEqual(values("type:te"), ["type:test"]);
  assert.deepEqual(values("kind:test status:"), ["kind:test status:failed"]);
  assert.deepEqual(values("authentication kind:ed"), ["authentication kind:edit"]);
  assert.deepEqual(values("text kind:te"), ["text kind:test"]);
  assert.deepEqual(values("text kind:test status:"), ["text kind:test status:failed"]);
  assert.deepEqual(values("kind:test "), ["kind:test status:failed"]);
  assert.ok(values("status:failed ").includes("status:failed kind:test"));
  assert.ok(!values("status:failed ").includes("status:failed status:failed"));
  for (const prefix of ["mark Use ", "export ./", "help ", "kind:unknown"]) assert.equal(complete(prefix), null);
  const ctx = context();
  await handler("help", ctx);
  assert.match(ctx.notifications[0].text, /Usage: \/blackbox \[search words\]/);
  assert.match(ctx.notifications[0].text, /\/blackbox kind:test status:failed/);
  assert.doesNotMatch(ctx.notifications[0].text, /\/timeline|[Ff]light recorder/);
  assert.match(ctx.notifications[0].text, /exports\/blackbox/);
  assert.match(ctx.notifications[0].text, /same query inside/);
  assert.match(ctx.notifications[0].text, /default folder first/);
  assert.match(ctx.notifications[0].text, /existing folder\/file/);
  assert.match(ctx.notifications[0].text, /PI_CODING_AGENT_DIR/);
});

test("startup filters populate the browser before any typing", async () => {
  const ctx = context();
  ctx.ui.custom = async (factory) => {
    let result;
    const browser = factory({ terminal: { rows: 24 }, requestRender: () => {} },
      themes.theme, new KeybindingsManager(), (value) => { result = value; });
    const rendered = browser.render(80).join("\n");
    assert.match(rendered, /1\/2 records/);
    assert.match(rendered, /Blackbox · 1\/2 records/);
    assert.match(rendered, /Start filtered: \/blackbox kind:test status:failed/);
    assert.doesNotMatch(rendered, /\/timeline|[Ff]light recorder/);
    browser.handleInput("\x18");
    assert.deepEqual(result.exportRecords.map((record) => [record.kind, record.failed]), [["test", true]]);
    return undefined;
  };
  await handler("kind:test status:failed", ctx);
  assert.deepEqual(ctx.notifications, []);
});

test("RPC fallback emits a filtered text timeline without trying terminal UI", async () => {
  const ctx = context({ mode: "rpc" });
  await handler("kind:test status:failed", ctx);
  assert.match(ctx.notifications[0].text, /^Blackbox: 1\/2 records/);
  assert.match(ctx.notifications[0].text, /Use \/blackbox export/);
  assert.match(ctx.notifications[0].text, /\[test:failed\]/);
});

test("marks explicit decisions without sending model messages", async () => {
  const appended = [];
  loaded.runtime.appendEntry = (type, data) => appended.push({ type, data });
  const ctx = context();
  await handler("mark Use SQLite because data is local", ctx);
  assert.deepEqual(appended, [{ type: "session-flight-recorder.marker.v1", data: { text: "Use SQLite because data is local" } }]);
  await handler("mark", ctx);
  assert.equal(appended.length, 1);
  assert.equal(ctx.notifications.at(-1).type, "warning");
});

test("browser handles search, arrows, details, scrolling, escape, resize, and export", async () => {
  const ctx = context();
  let requestedRender = 0;
  let exportCount;
  ctx.ui.custom = async (factory) => {
    let doneResult;
    const tui = { terminal: { rows: 24 }, requestRender: () => requestedRender++ };
    const browser = factory(tui, themes.theme, new KeybindingsManager(), (result) => { doneResult = result; });
    browser.focused = true;
    assert.match(browser.render(80).join("\n"), /2\/2 records/);
    for (const char of "kind:test") browser.handleInput(char);
    assert.match(browser.render(80).join("\n"), /1\/2 records/);
    browser.handleInput("\r"); // enter details
    assert.match(browser.render(80).join("\n"), /entry result/);
    browser.handleInput("\x1b[6~"); // page down
    assert.match(browser.render(80).join("\n"), /assertion failed/);
    browser.handleInput("\x1b"); // return to search
    assert.match(browser.render(80).join("\n"), /Search:/);
    browser.handleInput("\x15"); // ctrl+u clears search
    assert.match(browser.render(80).join("\n"), /2\/2 records/);
    browser.handleInput("\x1b[B"); // down selects the user prompt
    browser.handleInput("\r");
    assert.match(browser.render(80).join("\n"), /entry prompt/);
    for (const width of [1, 8, 20, 80, 120]) {
      const lines = browser.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `detail width ${width}`);
    }
    browser.handleInput("\x1b");
    tui.terminal.rows = 12;
    browser.invalidate();
    for (const width of [1, 8, 20, 80]) {
      const lines = browser.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `list width ${width}`);
      assert.equal(lines.length, 12);
      if (width === 80) assert.match(lines.join("\n"), /Ctrl\+X export/);
    }
    browser.handleInput("\x18"); // ctrl+x export snapshot
    exportCount = doneResult.exportRecords.length;
    return doneResult;
  };
  await handler("", ctx);
  assert.equal(exportCount, 2);
  assert.ok(requestedRender > 0);
  assert.ok(!ctx.notifications.some((n) => n.type === "error"), JSON.stringify(ctx.notifications));
});

test("details support wheel/trackpad, page keys, Home/End, and bounded scrolling after resize", async () => {
  const history = [{ type: "message", id: "scroll", timestamp: stamp, message: { role: "bashExecution",
    command: "echo lines", output: Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n"), exitCode: 0 } }];
  await inspectDetails(history, (browser, tui) => {
    tui.mode = "fullscreen";
    let renders = 0;
    tui.requestRender = () => renders++;
    const position = () => {
      const footer = stripVTControlCharacters(browser.render(120).at(-1));
      const [, top, total] = / (\d+)\/(\d+)$/.exec(footer);
      return { top: Number(top), total: Number(total) };
    };
    const wheel = (wheelDelta, type = "wheel") => browser.handleMouse({ type, button: "none", x: 10, y: 5,
      screenX: 10, screenY: 5, width: 120, height: 60, shift: false, alt: false, ctrl: false, wheelDelta });
    assert.equal(position().top, 1);
    assert.deepEqual(wheel(3), { handled: true, render: true });
    assert.equal(position().top, 4);
    assert.equal(renders, 1);
    wheel(-2);
    assert.equal(position().top, 2);
    for (const delta of [undefined, 0, NaN, Infinity]) assert.equal(wheel(delta), undefined);
    for (const type of ["press", "click", "drag", "move", "release"]) assert.equal(wheel(1, type), undefined);
    browser.handleInput("\x1b[H"); // Home
    assert.equal(position().top, 1);
    assert.deepEqual(wheel(-10000), { handled: true, render: false });
    browser.handleInput("\x1b[6~"); // Page Down
    assert.equal(position().top, 57);
    browser.handleInput("\x1b[5~"); // Page Up
    assert.equal(position().top, 1);
    browser.handleInput("\x1b[F"); // End
    const bottom = position();
    assert.equal(bottom.top, bottom.total - 56 + 1);
    assert.deepEqual(wheel(10000), { handled: true, render: false });
    browser.handleInput("\x1b[1;5H"); // Ctrl+Home
    assert.equal(position().top, 1);
    wheel(10000);
    assert.equal(position().top, bottom.top);
    browser.handleInput("\x1b[1~"); // alternate Home encoding
    assert.equal(position().top, 1);
    browser.handleInput("\x1b[1;5F"); // Ctrl+End
    assert.equal(position().top, bottom.top);
    tui.terminal.rows = 12;
    position();
    browser.handleInput("\x1b[4~"); // alternate End encoding, resized height = 8
    assert.equal(position().top, bottom.total - 8 + 1);
    assert.ok(browser.render(20).every((line) => visibleWidth(line) <= 20));
    tui.terminal.rows = 200;
    assert.equal(position().top, 1);
    assert.deepEqual(wheel(10000), { handled: true, render: false });
    browser.handleInput("\x1b"); // Back to search: don't hijack list/terminal mouse events
    browser.render(120);
    assert.equal(wheel(3), undefined);
    for (const char of "kind:command") browser.handleInput(char);
    browser.handleInput("\x1b[H");
    assert.match(stripVTControlCharacters(browser.render(120).join("\n")), /kind:command/);
  });
});

test("fullscreen Pi routes wheel and Home/End/Page keys to the focused reader overlay", async () => {
  const ctx = context();
  ctx.ui.custom = async (factory, options) => {
    assert.equal(options.overlay, true);
    assert.deepEqual(options.overlayOptions, { width: "100%", maxHeight: "100%" });
    let send;
    const terminal = { columns: 120, rows: 24, kittyProtocolActive: false,
      start: (onInput) => { send = onInput; }, stop() {}, write() {}, hideCursor() {}, showCursor() {} };
    const ui = new TuiAltScreen(terminal, false);
    const original = { render: () => Array.from({ length: 200 }, (_, i) => `Transcript ${i}`),
      invalidate() {}, handleInput() {} };
    ui.addChild(original);
    ui.setFocus(original);
    const browser = factory(ui, themes.theme, new KeybindingsManager(), () => ui.hideOverlay());
    try {
      ui.start();
      ui.showOverlay(browser, options.overlayOptions);
      ui.renderNow();
      send("\r");
      ui.renderNow();
      const position = () => Number(/ (\d+)\/\d+$/.exec(stripVTControlCharacters(browser.render(120).at(-1)))[1]);
      const transcriptTop = ui.viewportTop;
      assert.equal(position(), 1);
      send("\x0c"); // Ctrl+L must reach the focused overlay, not clear/scroll the transcript.
      ui.renderNow();
      assert.match(ui.getScreenLines().map(stripVTControlCharacters).join("\n"), /Choose language/);
      send("rs");
      send("\r");
      ui.renderNow();
      assert.match(ui.getScreenLines().map(stripVTControlCharacters).join("\n"), /Output · rust/);
      assert.equal(position(), 1);
      assert.equal(ui.viewportTop, transcriptTop);
      send("\x1b[<65;20;6M"); // SGR mouse wheel down inside overlay
      ui.renderNow();
      assert.ok(position() > 1);
      send("\x1b[F");
      ui.renderNow();
      const bottom = position();
      assert.ok(bottom > 1);
      send("\x1b[H");
      ui.renderNow();
      assert.equal(position(), 1);
      send("\x1b[6~");
      ui.renderNow();
      assert.equal(position(), 21);
      send("\x1b[5~");
      ui.renderNow();
      assert.equal(position(), 1);
      send("\x1b[<64;20;6M"); // wheel up at top must not scroll underlying transcript
      ui.renderNow();
      assert.equal(position(), 1);
      assert.equal(ui.viewportTop, transcriptTop);
      send("\x1b"); // back to list
      send("\x1b"); // close overlay
      assert.equal(ui.hasOverlay(), false);
      assert.equal(ui.getFocusedComponent(), original);
    } finally { ui.stop(); }
    return undefined;
  };
  await handler("kind:test", ctx);
  assert.deepEqual(ctx.notifications, []);
});

test("timeline covers the entire viewport for short details, empty results, and resized lists", async () => {
  const ctx = context();
  ctx.ui.custom = async (factory, options) => {
    let send;
    const terminal = { columns: 100, rows: 24, kittyProtocolActive: false,
      start: (onInput) => { send = onInput; }, stop() {}, write() {}, hideCursor() {}, showCursor() {} };
    const ui = new TuiAltScreen(terminal, false);
    const original = { render: () => Array.from({ length: 200 }, (_, i) => `BACKGROUND_TRANSCRIPT_${i}`),
      invalidate() {}, handleInput() {} };
    ui.addChild(original);
    ui.setFocus(original);
    const browser = factory(ui, themes.theme, new KeybindingsManager(), () => ui.hideOverlay());
    const frame = () => {
      ui.renderNow();
      const screen = ui.getScreenLines().map(stripVTControlCharacters);
      assert.equal(screen.length, terminal.rows);
      assert.equal(browser.render(terminal.columns).length, terminal.rows, "overlay must cover every terminal row");
      assert.ok(screen.every((line) => visibleWidth(line) <= terminal.columns));
      assert.ok(!screen.join("\n").includes("BACKGROUND_TRANSCRIPT_"), "transcript must not show around the timeline");
      return screen.join("\n");
    };
    try {
      ui.start();
      ui.showOverlay(browser, options.overlayOptions);
      assert.match(frame(), /Blackbox/);
      send("\x1b[B"); // select short prompt, not long command output
      send("\r");
      assert.match(frame(), /Fix auth/);
      for (const [rows, columns] of [[40, 120], [12, 80], [3, 8], [1, 1], [24, 100]]) {
        terminal.rows = rows;
        terminal.columns = columns;
        ui.invalidate();
        frame();
      }
      send("\x1b"); // back to list
      assert.match(frame(), /Blackbox/);
      for (const char of "no-such-entry") send(char);
      assert.match(frame(), /No matching records/);
      send("\x15");
      assert.match(frame(), /2\/2 records/);
      send("\x1b");
      ui.renderNow();
      assert.match(ui.getScreenLines().map(stripVTControlCharacters).join("\n"), /BACKGROUND_TRANSCRIPT_/);
      assert.equal(ui.getFocusedComponent(), original);
    } finally { ui.stop(); }
    return undefined;
  };
  await handler("", ctx);
  assert.deepEqual(ctx.notifications, []);
});

test("rows retain category colors, failure emphasis, and selection across theme changes", async () => {
  const colorEntries = [...entries,
    { type: "message", id: "passed", timestamp: stamp, message: { role: "bashExecution", command: "npm test", exitCode: 0, output: "passed" } },
    { type: "message", id: "edit", timestamp: stamp, message: { role: "toolResult", toolName: "write", isError: false, content: [] } },
    { type: "custom", id: "decision", timestamp: stamp, customType: "session-flight-recorder.marker.v1", data: { text: "Use SQLite" } },
  ];
  const ctx = context({ sessionManager: { getBranch: () => colorEntries } });
  ctx.ui.custom = async (factory) => {
    let result;
    const browser = factory({ terminal: { rows: 24 }, requestRender: () => {} },
      themes.theme, new KeybindingsManager(), (value) => { result = value; });
    let plainRows;
    for (const name of ["dark", "light"]) {
      themes.initTheme(name, false);
      const rendered = browser.render(100);
      const rows = rendered.filter((line) => /^.{2}\d{2}:\d{2}:\d{2}/.test(stripVTControlCharacters(line)));
      assert.equal(rows.length, 5, name);
      const plain = rows.map(stripVTControlCharacters);
      if (plainRows) assert.deepEqual(plain, plainRows);
      plainRows = plain;
      for (const [pattern, token] of [
        [/decision/, "syntaxKeyword"], [/edit/, "toolDiffAdded"],
        [/test.*exit 0/, "syntaxType"], [/test.*failed/, "error"], [/prompt/, "accent"],
      ]) {
        const row = rows.find((line) => pattern.test(stripVTControlCharacters(line)));
        assert.ok(row, String(pattern));
        assert.ok(row.includes(themes.theme.getFgAnsi(token)), `${name}: ${token}`);
        assert.ok(row.includes(themes.theme.getFgAnsi("dim")), `${name}: muted timestamp`);
      }
      assert.ok(stripVTControlCharacters(rows[0]).startsWith("→ "));
      assert.ok(rows[0].includes(themes.theme.getBgAnsi("selectedBg")));
      assert.ok(!rows[1].includes(themes.theme.getBgAnsi("selectedBg")));
      for (const width of [1, 8, 20, 80, 120]) {
        assert.ok(browser.render(width).every((line) => visibleWidth(line) <= width), `${name}: width ${width}`);
      }
    }
    browser.handleInput("\x1b[B"); // selection moves to edit without losing its color
    let selected = browser.render(100).find((line) => stripVTControlCharacters(line).startsWith("→ "));
    assert.ok(selected.includes(themes.theme.getFgAnsi("toolDiffAdded")));
    assert.ok(selected.includes(themes.theme.getBgAnsi("selectedBg")));
    browser.handleInput("\r");
    assert.ok(browser.render(100)[0].includes(themes.theme.getFgAnsi("toolDiffAdded")));
    browser.handleInput("\x1b");
    for (const char of "status:failed") browser.handleInput(char);
    selected = browser.render(100).find((line) => stripVTControlCharacters(line).startsWith("→ "));
    assert.match(stripVTControlCharacters(selected), /! test/);
    assert.ok(selected.includes(themes.theme.getFgAnsi("error")));
    assert.ok(selected.includes(themes.theme.getBgAnsi("selectedBg")));
    browser.handleInput("\x18");
    assert.equal(result.exportRecords.length, 1);
    assert.ok(!JSON.stringify(result.exportRecords).includes("\\u001b"), "display colors must not leak into exports");
    return undefined;
  };
  try {
    await handler("", ctx);
    assert.deepEqual(ctx.notifications, []);
  } finally { themes.initTheme("dark", false); }
});

test("command details highlight scripts, distinguish literal logs, refresh themes, and export raw excerpts", async () => {
  const command = "python3 - <<'PY'\n\ndef greet(name):\n    print(f'hello {name}')\ngreet('Pi 🔐 漢字')\nPY";
  const output = "PASS sample\nError: diagnostic\n# literal heading\n```typescript\nnot parsed\n```\n\x1b]0;evil title\x07";
  const history = [{ type: "message", id: "script", timestamp: stamp,
    message: { role: "bashExecution", command, output, exitCode: 0 } }];
  try {
    await inspectDetails(history, (browser, tui, result) => {
      let before;
      for (const name of ["dark", "light"]) {
        themes.initTheme(name, false);
        browser.invalidate();
        const rendered = browser.render(100);
        const plain = rendered.map(stripVTControlCharacters).join("\n");
        assert.match(plain, /Command · bash · exit 0/);
        assert.match(plain, /Output/);
        assert.match(plain, /┌─/);
        assert.match(plain, /def greet\(name\):/);
        assert.match(plain, /# literal heading/);
        assert.match(plain, /```typescript/);
        assert.ok(!plain.includes("evil title"));
        const code = rendered.find((line) => stripVTControlCharacters(line).includes("def greet"));
        assert.ok(code.includes(themes.theme.getFgAnsi("syntaxKeyword")), `${name}: Python keyword`);
        assert.ok(rendered.find((line) => line.includes("Error: diagnostic")).includes(themes.theme.getFgAnsi("error")));
        assert.ok(rendered.find((line) => line.includes("PASS sample")).includes(themes.theme.getFgAnsi("success")));
        if (before) assert.deepEqual(plain, before);
        before = plain;
      }
      for (const width of [1, 8, 20, 80, 120]) {
        assert.ok(browser.render(width).every((line) => visibleWidth(line) <= width), `formatted width ${width}`);
      }
      tui.terminal.rows = 12;
      browser.render(30);
      browser.handleInput("\x1b[6~");
      assert.equal(browser.render(30).length, 12);
      tui.terminal.rows = 60;
      assert.match(browser.render(100).map(stripVTControlCharacters).join("\n"), /Command · bash/);
      browser.handleInput("\x18");
      const record = result().exportRecords[0];
      assert.match(record.detail, /\$ python3 - <<'PY'/);
      assert.match(record.detail, /exit 0\n\nPASS sample/);
      assert.ok(!record.detail.includes("┌"));
      assert.ok(!record.detail.includes("\x1b"));
    });
  } finally { themes.initTheme("dark", false); }
});

test("Markdown code fences and read-file code receive syntax colors in details", async () => {
  const scenarios = [
    { history: [{ type: "message", id: "md", timestamp: stamp, message: { role: "assistant", content:
      "## Example\n\n**Use a constant.**\n\n```typescript\nconst answer = 42;\n```" } }], expected: /Example/, source: "const answer = 42;" },
    { history: [
      { type: "message", id: "read-call", timestamp: stamp, message: { role: "assistant", content: [
        { type: "toolCall", id: "read", name: "read", arguments: { path: "src/example.ts" } }] } },
      { type: "message", id: "read-result", timestamp: stamp, message: { role: "toolResult", toolCallId: "read", toolName: "read",
        content: [{ type: "text", text: "const answer = 42;" }] } },
    ], expected: /File · src\/example.ts/, source: "const answer = 42;" },
    { history: [{ type: "message", id: "node", timestamp: stamp, message: { role: "bashExecution",
      command: "node <<'JS'\nconst answer = 42;\nconsole.log(answer);\nJS", output: "42", exitCode: 0 } }],
      expected: /Command · bash/, source: "const answer = 42;" },
  ];
  for (const scenario of scenarios) await inspectDetails(scenario.history, (browser) => {
    const rendered = browser.render(100);
    assert.match(rendered.map(stripVTControlCharacters).join("\n"), scenario.expected);
    const code = rendered.find((line) => stripVTControlCharacters(line).includes(scenario.source));
    assert.ok(code.includes(themes.theme.getFgAnsi("syntaxKeyword")), "code should have keyword color");
    for (const width of [1, 8, 20, 80]) {
      assert.ok(browser.render(width).every((line) => visibleWidth(line) <= width), `code/Markdown width ${width}`);
    }
  });
});

test("JSON/diff output is highlighted while unknown logs and oversized commands stay safe", async () => {
  for (const [output, token, source] of [
    ['{"answer":42}', "syntaxNumber", "42"],
    ["diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new", "toolDiffAdded", "+new"],
    ["unstructured output stays literal", "toolOutput", "unstructured output"],
  ]) await inspectDetails([{ type: "message", id: "output", timestamp: stamp,
    message: { role: "bashExecution", command: "echo output", output, exitCode: 0 } }], (browser) => {
    const line = browser.render(100).find((line) => stripVTControlCharacters(line).includes(source));
    assert.ok(line.includes(themes.theme.getFgAnsi(token)), token);
  });
  await inspectDetails([{ type: "message", id: "large", timestamp: stamp, message: { role: "bashExecution",
    command: "echo " + "x".repeat(7000), output: "OMITTED_OUTPUT", exitCode: 0 } }], (browser, tui) => {
    tui.terminal.rows = 200;
    const rendered = browser.render(100).map(stripVTControlCharacters).join("\n");
    assert.match(rendered, /truncated/);
    assert.match(rendered, /Output omitted by excerpt limit/);
    assert.ok(!rendered.includes("OMITTED_OUTPUT"));
  });
});

test("rg/grep source snippets are colored without changing numbered output or exports", async () => {
  const command = 'P=/some/pi; rg -n -A100 \'compositeOverlays\\(\' "$P/tui.js" | tail -110; '
    + 'rg -n -A55 \'function compositeTuiLine\' "$P/tui.js"; rg -n -A130 \'fullscreen Pi routes\' ~/tests/runtime.test.mjs';
  for (const [cmd, output, coloredSource] of [
    [command, "950:    compositeOverlays(lines, termWidth, termHeight) {\n951-        if (this.overlayStack.length === 0) {\n952-            return lines;\n953-        }\n--\n1200:const answer = 42;", "952-            return lines;"],
    ["grep -n -A 2 -e return 'src/file name.ts'", "10:const answer = 42;\n11-  return answer;", "11-  return answer;"],
    ["rg -n return src/", "src/a.ts:10:const answer = 42;\nsrc/a.ts-11-  return answer;\n--\nsrc/b.py:3:if True:\nsrc/b.py-4-    return 1", "src/b.py:3:if True:"],
    ["rg -n --heading return src/", "src/a.ts\n10:const answer = 42;\n11-  return answer;\n--\n20:const another = 43;", "20:const another = 43;"],
    ["rg -n --column return src/a.ts", "10:5:const answer = 42;\n11-  return answer;", "10:5:const answer = 42;"],
    ["rg -n -e return src/a.js src/b.py", "src/a.js:10:const answer = 42;\nsrc/b.py:2:if True:", "src/b.py:2:if True:"],
    ["rg -n comment src/a.js", "10:/* multiline\n11- return is a comment\n12- */ const answer = 42;", "12- */ const answer = 42;"],
    ["rg -n comment src/", "src/a.js:10:/* unfinished comment\nsrc/b.js:20:const answer = 42;", "src/b.js:20:const answer = 42;"],
  ]) {
    const entry = [{ type: "message", id: "snippet", timestamp: stamp,
      message: { role: "bashExecution", command: cmd, output, exitCode: 0 } }];
    await inspectDetails(entry, (browser, tui) => {
      tui.terminal.rows = 100;
      const lines = browser.render(160);
      const rendered = lines.map(stripVTControlCharacters).join("\n");
      const codeLine = lines.find((line) => stripVTControlCharacters(line).includes(coloredSource));
      assert.ok(codeLine.includes(themes.theme.getFgAnsi("syntaxKeyword")), cmd);
      for (const line of output.split("\n")) assert.ok(rendered.includes(line), line);
      assert.ok(lines.every((line) => visibleWidth(line) <= 160));
      if (cmd === command) {
        const afterSeparator = lines.find((line) => stripVTControlCharacters(line).includes("1200:const answer"));
        assert.ok(afterSeparator.includes(themes.theme.getFgAnsi("syntaxKeyword")), "context separators retain source language");
        browser.handleInput("\x1b[4~");
        const resized = browser.render(30);
        assert.ok(resized.every((line) => visibleWidth(line) <= 30));
      }
    });
    let exported;
    const ctx = context();
    ctx.sessionManager.getBranch = () => entry;
    ctx.ui.custom = async (factory) => {
      const browser = factory({ terminal: { rows: 24 }, requestRender() {} }, themes.theme,
        new KeybindingsManager(), (value) => { exported = value; });
      browser.handleInput("\r");
      browser.handleInput("\x18");
    };
    await handler("", ctx);
    assert.deepEqual(ctx.notifications, []);
    assert.ok(exported.exportRecords[0].detail.endsWith(output));
    assert.ok(!exported.exportRecords[0].detail.includes("\x1b"));
  }
});

test("failed compound rg commands mixing JS, MJS, and declaration TS still highlight source", async () => {
  const command = 'P=/Users/lczerniawski/.local/share/nvm/v26.5.0/lib/node_modules/@earendil-works/pi-coding-agent; '
    + 'rg -n -A55 \'function getLanguageFromPath\' "$P/dist/modes/interactive/theme/theme.js"; '
    + 'rg -n -A65 \'JSON/diff output\' ~/.pi/agent/extensions/blackbox/tests/runtime.test.mjs; '
    + 'rg -n \'export.*supportsLanguage\' "$P/dist/index.d.ts"';
  const output = '783:export function getLanguageFromPath(filePath) {\n'
    + '784-    const ext = filePath.split(".").pop()?.toLowerCase();\n'
    + '785-    if (!ext)\n786-        return undefined;\n787-    const extToLang = {\n'
    + '788-        ts: "typescript",\n789-        tsx: "typescript",\n790-        js: "javascript",\n'
    + '791-        jsx: "javascript",\n792-        mjs: "javascript",\n793-        cjs: "javascript",\n'
    + '459:test("JSON/diff output is highlighted", async () => {\n460-  const answer = 42;';
  const history = [
    { type: "message", id: "compound-call", timestamp: stamp, message: { role: "assistant", content: [
      { type: "toolCall", id: "compound-rg", name: "bash", arguments: { command } }] } },
    { type: "message", id: "6ff88fce", timestamp: "2026-10-02T08:40:12.853Z", message: {
      role: "toolResult", toolCallId: "compound-rg", toolName: "bash", isError: true,
      content: [{ type: "text", text: output }] } },
  ];
  await inspectDetails(history, (browser, tui, result) => {
    tui.terminal.rows = 60;
    try {
      for (const name of ["dark", "light"]) {
        themes.initTheme(name, false);
        browser.invalidate();
        const lines = browser.render(150);
        const find = (text) => lines.find((line) => stripVTControlCharacters(line).includes(text));
        assert.ok(find("Command · bash · failed").includes(themes.theme.getFgAnsi("error")));
        assert.ok(find("783:export function").includes(themes.theme.getFgAnsi("syntaxKeyword")), `${name}: JS keywords`);
        assert.ok(find('788-        ts: "typescript"').includes(themes.theme.getFgAnsi("syntaxString")), `${name}: strings`);
        assert.ok(find("460-  const answer = 42;").includes(themes.theme.getFgAnsi("syntaxNumber")), `${name}: MJS numbers`);
        for (const line of output.split("\n")) assert.ok(lines.map(stripVTControlCharacters).join("\n").includes(line));
        assert.ok(lines.every((line) => visibleWidth(line) <= 150));
      }
      browser.handleInput("\x18");
      assert.ok(result().exportRecords[0].detail.endsWith(output));
      assert.ok(!result().exportRecords[0].detail.includes("\x1b"));
    } finally { themes.initTheme("dark", false); }
  });
});

test("search-like logs and ambiguous filename-free snippets remain literal", async () => {
  for (const command of [
    "echo 'rg -n return file.js'", "rg -n return app.log", "rg -n return src/",
    "rg -n return src/a.js src/b.py", "rg -n -g '*.ts' return src/",
  ]) await inspectDetails([{ type: "message", id: "log", timestamp: stamp,
    message: { role: "bashExecution", command, output: "950:const answer = 42;\n951- return answer;", exitCode: 0 } }], (browser) => {
    const line = browser.render(120).find((line) => stripVTControlCharacters(line).includes("951- return answer;"));
    assert.ok(line.includes(themes.theme.getFgAnsi("toolOutput")), command);
    assert.ok(!line.includes(themes.theme.getFgAnsi("syntaxKeyword")), command);
  });
});

test("typing kind:test supports shifted colon across terminal keyboard protocols", async () => {
  const sequences = {
    plain: [..."kind:test"],
    kitty: [..."kind:test"].map((char) => `\x1b[${char.codePointAt(0)}u`),
    kittyShiftedColon: [..."kind:test"].map((char) => char === ":" ? "\x1b[59:58;2u" : char),
    modifyOtherKeysColon: [..."kind:test"].map((char) => char === ":" ? "\x1b[27;2;58~" : char),
    modifyOtherKeys: [..."kind:test"].map((char) => `\x1b[27;${char === ":" ? 2 : 1};${char.codePointAt(0)}~`),
    paste: ["\x1b[200~kind:test\x1b[201~"],
  };
  for (const [protocol, keys] of Object.entries(sequences)) {
    const ctx = context();
    ctx.ui.custom = async (factory) => {
      let result;
      const browser = factory({ terminal: { rows: 24 }, requestRender: () => {} },
        themes.theme, new KeybindingsManager(), (value) => { result = value; });
      browser.focused = true;
      for (const key of keys) browser.handleInput(key);
      assert.match(browser.render(80).join("\n"), /1\/2 records/, protocol);
      browser.handleInput("\x18");
      assert.deepEqual(result.exportRecords.map((record) => record.kind), ["test"], protocol);
      return undefined;
    };
    // The command reports component errors rather than throwing them.
    await handler("", ctx);
    assert.deepEqual(ctx.notifications, [], protocol);
  }
});

test("exports require confirmation; approved paths are written; overwrite is reported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-flight-runtime-"));
  try {
    const path = join(dir, "timeline.md");
    const ctx = context();
    await handler(`export ${path}`, ctx); // denied
    await assert.rejects(readFile(path), { code: "ENOENT" });
    let prompt;
    ctx.ui.confirm = async (_title, text) => { prompt = text; return true; };
    await handler(`export ${path}`, ctx);
    assert.match(prompt, /sensitive/);
    assert.match(await readFile(path, "utf8"), /Session: test-session/);
    await handler(`export ${path}`, ctx);
    assert.equal(ctx.notifications.at(-1).type, "error");
    assert.match(ctx.notifications.at(-1).text, /EEXIST/);
    const noUI = context({ mode: "json", hasUI: false });
    await handler(`export ${join(dir, "no-ui.md")}`, noUI);
    assert.equal(noUI.notifications.at(-1).type, "warning");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
