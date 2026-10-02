import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const piRoot = process.env.PI_PACKAGE_PATH || resolve(dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent");
const fromPi = async (path) => import(pathToFileURL(join(piRoot, path)).href);
const { loadExtensions } = await fromPi("dist/core/extensions/loader.js");
const themes = await fromPi("dist/modes/interactive/theme/theme.js");
const { KeybindingsManager } = await fromPi("dist/core/keybindings.js");
themes.initTheme("dark", false);
const loaded = await loadExtensions([fileURLToPath(new URL("../index.ts", import.meta.url))], process.cwd());
assert.deepEqual(loaded.errors, []);
const handler = loaded.extensions[0].commands.get("blackbox").handler;
const timestamp = "2026-06-01T12:00:00.000Z";
const history = [
  { type: "message", id: "prompt", timestamp, message: { role: "user", content: "PRIVATE_PROMPT" } },
  { type: "message", id: "test", timestamp, message: { role: "bashExecution", command: "npm test", output: "pass", exitCode: 0 } },
];
function context(cwd, mode = "tui") {
  const notifications = [];
  return { cwd, mode, hasUI: true, notifications, waitForIdle: async () => {},
    sessionManager: { getBranch: () => history, getSessionId: () => "export-test", getSessionName: () => "Export test" },
    ui: { notify: (text, type) => notifications.push({ text, type }),
      select: async (_title, options) => options[0], input: async () => undefined, confirm: async () => true } };
}
async function workspace(check) {
  const dir = await mkdtemp(join(tmpdir(), "pi-flight-export-ui-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try { await check(dir); }
  finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    await rm(dir, { recursive: true, force: true });
  }
}

test("default-first export creates the configured private default directory after confirmation", async () => {
  await workspace(async (dir) => {
    const ctx = context(dir);
    const destination = join(dir, "agent", "exports", "blackbox");
    let confirmedPath;
    ctx.ui.select = async (_title, options) => {
      assert.equal(options.length, 3);
      assert.match(options[0], /Save to default folder/);
      assert.ok(options[0].includes(destination));
      assert.match(options[1], /another folder/);
      assert.match(options[2], /file path/);
      await assert.rejects(stat(destination), { code: "ENOENT" });
      return options[0];
    };
    ctx.ui.input = async () => assert.fail("Default choice needs no path input");
    ctx.ui.confirm = async (_title, prompt) => {
      assert.match(prompt, /sensitive/);
      assert.match(prompt, /will not be overwritten/);
      confirmedPath = /records → ([^\n]+)/.exec(prompt)[1];
      await assert.rejects(stat(destination), { code: "ENOENT" });
      return true;
    };
    await handler("export", ctx);
    assert.equal(dirname(confirmedPath), destination);
    assert.equal((await readdir(destination)).length, 1);
    assert.equal((await stat(destination)).mode & 0o777, 0o700);
    assert.equal((await stat(confirmedPath)).mode & 0o777, 0o600);
    const markdown = await readFile(confirmedPath, "utf8");
    assert.match(markdown, /^# Blackbox — Pi session history\n/);
    assert.match(markdown, /Records: 2/);
    assert.match(ctx.notifications.at(-1).text, /^Blackbox exported to /);
    assert.equal(ctx.notifications.at(-1).type, "info");
  });
});

test("browser Ctrl+X lets users choose an existing folder and exports only matching records", async () => {
  await workspace(async (dir) => {
    const folder = join(dir, "my exports");
    await mkdir(folder);
    const ctx = context(dir);
    ctx.ui.select = async (_title, options) => options[1];
    ctx.ui.input = async (title) => { assert.match(title, /folder/); return '"./my exports"'; };
    ctx.ui.custom = async (factory) => {
      let result;
      const browser = factory({ terminal: { rows: 24 }, requestRender() {} }, themes.theme, new KeybindingsManager(), (value) => { result = value; });
      browser.handleInput("\x18");
      return result;
    };
    ctx.ui.confirm = async (_title, prompt) => {
      assert.match(prompt, /1 records/);
      assert.ok(prompt.includes(folder));
      return true;
    };
    await handler("kind:test", ctx);
    assert.equal(ctx.notifications.at(-1).type, "info");
    const [name] = await readdir(folder);
    assert.match(name, /_export-test\.md$/);
    const markdown = await readFile(join(folder, name), "utf8");
    assert.match(markdown, /Records: 1/);
    assert.match(markdown, /npm test/);
    assert.doesNotMatch(markdown, /PRIVATE_PROMPT/);
    await assert.rejects(stat(join(dir, "agent")), { code: "ENOENT" });
  });
});

test("RPC export supports a chosen filename with spaces and reports overwrite rather than replacing it", async () => {
  await workspace(async (dir) => {
    const ctx = context(dir, "rpc");
    ctx.ui.select = async (_title, options) => options[2];
    ctx.ui.input = async (title) => { assert.match(title, /file path/); return '"./my timeline.md"'; };
    await handler("export", ctx);
    const path = join(dir, "my timeline.md");
    const original = await readFile(path, "utf8");
    assert.match(original, /Records: 2/);
    assert.equal(ctx.notifications.at(-1).type, "info");
    await handler("export", ctx);
    assert.equal(ctx.notifications.at(-1).type, "error");
    assert.match(ctx.notifications.at(-1).text, /EEXIST/);
    assert.equal(await readFile(path, "utf8"), original);
  });
});

test("explicit folder and filename arguments skip destination dialogs but still require confirmation", async () => {
  await workspace(async (dir) => {
    const folder = join(dir, "archive folder");
    await mkdir(folder);
    const ctx = context(dir);
    ctx.ui.select = ctx.ui.input = async () => assert.fail("Explicit destinations skip the chooser");
    let confirmations = 0;
    ctx.ui.confirm = async () => { confirmations++; return true; };
    await handler('export "./archive folder"', ctx);
    assert.equal((await readdir(folder)).length, 1);
    await handler('export "./named export.md"', ctx);
    assert.match(await readFile(join(dir, "named export.md"), "utf8"), /Records: 2/);
    assert.equal(confirmations, 2);
    assert.ok(ctx.notifications.every((notice) => notice.type === "info"));
  });
});

test("cancelling destination/input or declining confirmation never creates export files or folders", async () => {
  await workspace(async (dir) => {
    for (const scenario of ["cancel choice", "invalid choice", "cancel input", "blank input", "deny confirmation"]) {
      const ctx = context(dir);
      let confirmations = 0;
      ctx.ui.select = async (_title, options) => scenario === "cancel choice" ? undefined
        : scenario === "invalid choice" ? "unexpected" : scenario === "deny confirmation" ? options[0] : options[1];
      ctx.ui.input = async () => scenario === "cancel input" ? undefined : "   ";
      ctx.ui.confirm = async () => { confirmations++; return false; };
      await handler("export", ctx);
      assert.equal(confirmations, scenario === "deny confirmation" ? 1 : 0, scenario);
      assert.deepEqual(ctx.notifications, [], scenario);
      assert.deepEqual(await readdir(dir), [], scenario);
    }
  });
});

test("missing custom folders and parents report errors without silently creating directories", async () => {
  await workspace(async (dir) => {
    const ctx = context(dir);
    let confirmations = 0;
    ctx.ui.confirm = async () => { confirmations++; return true; };
    ctx.ui.select = async (_title, options) => options[1];
    ctx.ui.input = async () => "./missing";
    await handler("export", ctx);
    assert.equal(confirmations, 0);
    assert.equal(ctx.notifications.at(-1).type, "error");
    assert.match(ctx.notifications.at(-1).text, /Export folder does not exist/);
    ctx.ui.select = async (_title, options) => options[2];
    ctx.ui.input = async () => "./missing/timeline.md";
    await handler("export", ctx);
    assert.equal(confirmations, 1);
    assert.equal(ctx.notifications.at(-1).type, "error");
    assert.match(ctx.notifications.at(-1).text, /ENOENT/);
    assert.deepEqual(await readdir(dir), []);
  });
});
