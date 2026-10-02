import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const piRoot = process.env.PI_PACKAGE_PATH || resolve(dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent");
const fromPi = async (path) => import(pathToFileURL(join(piRoot, path)).href);
const { loadExtensions } = await fromPi("dist/core/extensions/loader.js");
const themes = await fromPi("dist/modes/interactive/theme/theme.js");
const { KeybindingsManager } = await fromPi("dist/core/keybindings.js");
const { visibleWidth } = await fromPi("node_modules/@earendil-works/pi-tui/dist/utils.js");
const require = createRequire(join(piRoot, "package.json"));
const registry = require("highlight.js/lib/core");
themes.initTheme("dark", false);
const loaded = await loadExtensions([fileURLToPath(new URL("../index.ts", import.meta.url))], process.cwd());
assert.deepEqual(loaded.errors, []);
const handler = loaded.extensions[0].commands.get("blackbox").handler;
const stamp = "2026-06-01T12:00:00.000Z";
const message = (id, text) => ({ type: "message", id, timestamp: stamp, message: { role: "user", content: text } });
const command = (id, cmd, output) => ({ type: "message", id, timestamp: stamp,
  message: { role: "bashExecution", command: cmd, output, exitCode: 0 } });
function read(path, output) {
  return [
    { type: "message", id: "call", timestamp: stamp, message: { role: "assistant", content: [
      { type: "toolCall", id: "read", name: "read", arguments: { path } }] } },
    { type: "message", id: "result", timestamp: stamp, message: { role: "toolResult", toolCallId: "read", toolName: "read",
      content: [{ type: "text", text: output }], isError: false } },
  ];
}
async function inspect(history, check) {
  const notifications = [];
  await handler("", {
    cwd: "/project", mode: "tui", hasUI: true, waitForIdle: async () => {},
    sessionManager: { getBranch: () => history },
    ui: { notify: (text) => notifications.push(text), custom: async (factory) => {
      let result;
      const tui = { terminal: { rows: 60 }, requestRender: () => {}, mode: "fullscreen" };
      const browser = factory(tui, themes.theme, new KeybindingsManager(), (value) => { result = value; });
      browser.focused = true;
      browser.handleInput("\r");
      await check(browser, tui, () => result);
    } },
  });
  assert.deepEqual(notifications, []);
}
const plain = (browser, width = 160) => browser.render(width).map(stripVTControlCharacters).join("\n");
function pick(browser, language) {
  browser.handleInput("\x0c");
  assert.match(plain(browser), /Choose language/);
  browser.handleInput(`\x1b[200~${language}\x1b[201~`);
  browser.handleInput("\r");
  assert.doesNotMatch(plain(browser), /Choose language/);
}
const colored = (text, color, token) => text.includes(themes.theme.fg(color, token));

test("every shipped grammar is selectable, renders literally, and leaves exports unchanged", async () => {
  const sample = '// comment\n# comment\nfunction hello() { return "world" + 42; }\nconst answer = true;\nSELECT value FROM items WHERE id = 42;';
  await inspect(read("unknown.extension", sample), (browser, tui, result) => {
    browser.render(160); // Registers the full catalog before rendering any details.
    const languages = registry.listLanguages();
    assert.ok(languages.length >= 180, `Expected full distribution, got ${languages.length}`);
    browser.handleInput("\x18");
    const original = JSON.stringify(result().exportRecords);
    for (const language of languages) {
      browser.handleInput("\x0c");
      assert.match(plain(browser), new RegExp(`${languages.length} installed grammars`));
      browser.handleInput(`\x1b[200~${language}\x1b[201~`);
      const label = language === "plaintext" ? "Plain text" : language;
      assert.ok(plain(browser).split("\n").some((line) => line.trimStart().startsWith(`→ ${label}`)), language);
      browser.handleInput("\r");
      assert.ok(plain(browser).includes(` · ${language}`), language);
      // Exercise Pi's exact highlighting function on each registered language, not just registry lookup.
      assert.equal(themes.highlightCode(sample, language).map(stripVTControlCharacters).join("\n"), sample, language);
      assert.match(plain(browser), /SELECT value FROM items WHERE id = 42;/, language);
      browser.handleInput("\x18");
      assert.equal(JSON.stringify(result().exportRecords), original, language);
    }
  });
});

test("expanded filename hints, shebangs, and interpreter heredocs receive real syntax colors", async () => {
  const samples = [
    ["main.dart", 'void main() { print("hello"); }', "syntaxKeyword", "void"],
    ["package.nix", '{ pkgs }: pkgs.stdenv.mkDerivation { name = "demo"; }', "syntaxString", '"demo"'],
    ["Main.hs", 'module Main where\nmain = putStrLn "hello"', "syntaxKeyword", "module"],
    ["demo.fsx", 'let answer = 42\nprintfn "%d" answer', "syntaxKeyword", "let"],
    ["query.sql", "SELECT name FROM people WHERE id = 42;", "syntaxKeyword", "SELECT"],
    ["demo.jl", 'function hello()\n println("hello")\nend', "syntaxKeyword", "function"],
    ["demo.exs", 'defmodule Demo do\n def hello, do: "hello"\nend', "syntaxKeyword", "defmodule"],
    ["CMakeLists.txt", 'cmake_minimum_required(VERSION 3.20)\nproject(demo)', "syntaxKeyword", "cmake_minimum_required"],
    ["Dockerfile.dev", 'FROM node:22\nRUN echo "hello"', "syntaxKeyword", "FROM"],
    ["settings.toml", '[server]\nport = 8080\nname = "demo"', "syntaxNumber", "8080"],
  ];
  for (const [path, source, color, token] of samples) {
    await inspect(read(path, source), (browser) => {
      assert.ok(colored(browser.render(160).join("\n"), color, token), path);
      assert.ok(plain(browser).includes(source.split("\n")[0]), path);
    });
  }
  await inspect(read("bin/demo", '#!/usr/bin/env python3\ndef hello():\n    return "hello"'), (browser) => {
    assert.ok(colored(browser.render(160).join("\n"), "syntaxKeyword", "def"));
  });
  for (const [interpreter, source] of [["lua", 'local answer = 42\nprint("hello")'], ["julia", 'println("hello")']]) {
    await inspect([command("script", `${interpreter} <<'CODE'\n${source}\nCODE`, "hello")], (browser) => {
      assert.match(plain(browser), /Command · bash/);
      assert.ok(colored(browser.render(160).join("\n"), "syntaxString", '"hello"'), interpreter);
    });
  }
});

test("Markdown fences and named search snippets support languages outside Pi's eager set", async () => {
  await inspect([message("fenced", '```dart\nvoid main() { print("hello"); }\n```\n```nix\n{ name = "demo"; }\n```\n```rs\nfn main() {}\n```')], (browser) => {
    const rendered = browser.render(160).join("\n");
    assert.ok(colored(rendered, "syntaxKeyword", "void"));
    assert.ok(colored(rendered, "syntaxKeyword", "fn"));
    assert.ok(colored(rendered, "syntaxString", '"demo"'));
    assert.match(plain(browser), /void main/);
    assert.match(plain(browser), /name = "demo"/);
  });
  await inspect([command("search", "rg -n answer .", "demo.nix:7:let answer = 42; in answer\ndemo.fsx:9:let answer = 42")], (browser) => {
    assert.match(plain(browser), /demo.nix:7:let answer = 42; in answer/);
    assert.match(plain(browser), /demo.fsx:9:let answer = 42/);
    assert.ok(colored(browser.render(160).join("\n"), "syntaxKeyword", "let"));
  });
});

test("picker supports aliases, cancellation, plain/automatic, per-record state, resize, and theme changes", async () => {
  const history = [message("first", 'const answer = "hello";'), message("second", 'const answer = "second";')];
  await inspect(history, (browser, tui, result) => {
    pick(browser, "js");
    assert.match(plain(browser), / · javascript/);
    assert.ok(colored(browser.render(160).join("\n"), "syntaxKeyword", "const"));
    browser.handleInput("\x0c");
    for (const width of [1, 8, 20, 80, 160]) {
      for (const rows of [12, 24, 60]) {
        tui.terminal.rows = rows;
        const lines = browser.render(width);
        assert.equal(lines.length, rows);
        assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}/${rows}`);
      }
    }
    browser.handleInput("\x1b[200~no-such-language\x1b[201~");
    assert.match(plain(browser), /No matching commands/);
    browser.handleInput("\r"); // unavailable grammars cannot be applied
    assert.match(plain(browser), /Choose language/);
    browser.handleInput("\x1b"); // cancel picker, not details
    assert.match(plain(browser), / · javascript/);
    tui.terminal.rows = 60;
    pick(browser, "plaintext");
    assert.match(plain(browser), / · plaintext/);
    pick(browser, "automatic");
    assert.doesNotMatch(plain(browser), / · javascript| · plaintext/);
    pick(browser, "js");
    const dark = browser.render(160).join("\n");
    themes.setTheme("light");
    const light = browser.render(160).join("\n");
    assert.notEqual(light, dark);
    assert.equal(stripVTControlCharacters(light), stripVTControlCharacters(dark));
    themes.setTheme("dark");
    browser.handleInput("\x1b"); // back to list
    browser.handleInput("\x1b[B"); // other record
    browser.handleInput("\r");
    assert.doesNotMatch(plain(browser), / · javascript/);
    browser.handleInput("\x1b");
    browser.handleInput("\x1b[A");
    browser.handleInput("\r");
    assert.match(plain(browser), / · javascript/);
    browser.handleInput("\x18");
    assert.ok(result().exportRecords.every((record) => !Object.hasOwn(record, "languageOverride")));
  });
});

test("unknown source can be overridden without changing shell highlighting or numbered prefixes", async () => {
  await inspect([command("snippet", "rg -n answer unknown.xyz", '7:const answer = "hello";\n8-const count = 42;')], (browser) => {
    pick(browser, "typescript");
    assert.match(plain(browser), /Command · bash/);
    assert.match(plain(browser), /Output · typescript/);
    assert.match(plain(browser), /7:const answer = "hello";/);
    assert.match(plain(browser), /8-const count = 42;/);
    assert.ok(colored(browser.render(160).join("\n"), "syntaxKeyword", "const"));
  });
  await inspect(read("unknown.xyz", 'const answer = "hello";'), (browser) => {
    const before = browser.render(160).join("\n");
    const keyword = themes.theme.fg("syntaxKeyword", "const");
    // Base output/header colors can equal syntax colors; assert on the token itself.
    assert.equal(before.includes(keyword), false);
    pick(browser, "javascript");
    assert.ok(browser.render(160).join("\n").includes(keyword));
    pick(browser, "plaintext");
    assert.equal(browser.render(160).join("\n").includes(keyword), false);
  });
});

const markdownDocument = '# Preview title\n\n**Bold preview** and *italic preview* with `inline()`.\n\n'
  + '- First item\n- Second item\n\n> Quoted preview\n\n[Docs](https://example.com/docs)\n\n'
  + '| Name | Value |\n| --- | --- |\n| Answer | 42 |\n\n```typescript\nconst answer = 42;\n```';
function assertMarkdownPreview(browser) {
  const output = plain(browser);
  assert.match(output, /Preview title/);
  assert.match(output, /Bold preview/);
  assert.match(output, /First item/);
  assert.match(output, /Second item/);
  assert.match(output, /Quoted preview/);
  assert.match(output, /Docs/);
  assert.match(output, /Answer/);
  assert.match(output, /const answer = 42;/);
  assert.doesNotMatch(output, /# Preview title|\*\*Bold preview\*\*|\*italic preview\*|> Quoted preview|\[Docs\]\(|\| --- \|/);
  const rendered = browser.render(160).join("\n");
  assert.ok(rendered.includes(themes.theme.bold("Bold preview")), "emphasis must be styled, not merely colored source");
  assert.ok(colored(rendered, "syntaxKeyword", "const"), "fenced code still gets syntax highlighting");
}

test("Markdown file previews render formatting and retain literal search/export excerpts", async () => {
  for (const path of ["docs/README.md", "docs/GUIDE.MARKDOWN"]) {
    await inspect(read(path, markdownDocument), (browser, tui, result) => {
      assertMarkdownPreview(browser);
      assert.match(plain(browser), /File · docs\//);
      browser.handleInput("\x18");
      const original = JSON.stringify(result().exportRecords);
      assert.equal(result().exportRecords[0].detail, `read completed\n\n${markdownDocument}`);
      pick(browser, "plaintext");
      assert.match(plain(browser), /\*\*Bold preview\*\*/);
      assert.match(plain(browser), /# Preview title/);
      pick(browser, "automatic");
      assertMarkdownPreview(browser);
      try {
        const dark = browser.render(160).join("\n");
        themes.setTheme("light");
        browser.invalidate();
        assertMarkdownPreview(browser);
        const light = browser.render(160).join("\n");
        assert.notEqual(dark, light);
        assert.equal(stripVTControlCharacters(dark), stripVTControlCharacters(light));
      } finally { themes.setTheme("dark"); browser.invalidate(); }
      for (const rows of [12, 24, 60]) {
        tui.terminal.rows = rows;
        for (const width of [1, 8, 20, 80, 160]) {
          const lines = browser.render(width);
          assert.equal(lines.length, rows);
          assert.ok(lines.every((line) => visibleWidth(line) <= width), `${path}: ${width}/${rows}`);
        }
      }
      tui.terminal.rows = 12;
      browser.render(40);
      browser.handleInput("\x1b[4~");
      assert.match(plain(browser, 40), /const answer = 42;/);
      browser.handleInput("\x18");
      assert.equal(JSON.stringify(result().exportRecords), original);
      browser.handleInput("\x1b");
      for (const char of "**Bold") browser.handleInput(char);
      assert.match(plain(browser), /1\/1 records/); // search still sees the raw Markdown characters
    });
  }
});

test("Markdown overrides render unknown files, tool output, and messages; Automatic and Plain text restore their modes", async () => {
  for (const history of [read("unknown.xyz", markdownDocument), [command("markdown", "echo report", markdownDocument)],
    [message("markdown-message", markdownDocument)]]) {
    await inspect(history, (browser, tui, result) => {
      browser.handleInput("\x18");
      const original = JSON.stringify(result().exportRecords);
      const initiallyMarkdown = history[0].message.role === "user";
      if (initiallyMarkdown) assertMarkdownPreview(browser);
      else assert.match(plain(browser), /\*\*Bold preview\*\*/);
      pick(browser, "md");
      assertMarkdownPreview(browser);
      if (history[0].message.role === "bashExecution") {
        assert.match(plain(browser), /Command · bash/);
        assert.match(plain(browser), /Output · markdown/);
        assert.match(plain(browser), /echo report/);
      }
      pick(browser, "plaintext");
      assert.match(plain(browser), /\*\*Bold preview\*\*/);
      pick(browser, "automatic");
      if (initiallyMarkdown) assertMarkdownPreview(browser);
      else assert.match(plain(browser), /\*\*Bold preview\*\*/);
      browser.handleInput("\x18");
      assert.equal(JSON.stringify(result().exportRecords), original);
    });
  }
});

test("Markdown source-search results keep filenames and numeric prefixes even under Markdown override", async () => {
  const output = 'docs/a.md:1:# Indexed heading\ndocs/a.md:2:**Literal source**\n--\ndocs/b.md-5-> source quote';
  await inspect([command("markdown-source", "rg -n heading docs/", output)], (browser) => {
    for (const line of output.split("\n")) assert.ok(plain(browser).includes(line));
    pick(browser, "markdown");
    for (const line of output.split("\n")) assert.ok(plain(browser).includes(line), line);
  });
});
