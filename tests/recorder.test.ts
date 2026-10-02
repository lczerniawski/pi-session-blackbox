import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildTimeline, cleanText, clipped, exportMarkdown, filterTimeline, isTestCommand, MARKER_TYPE, parseQuery, timeLabel } from "../recorder.ts";
import { defaultExportPath, resolveExportDestination, resolveExportPath, saveExport } from "../export.ts";

const stamp = "2026-06-01T12:00:00.000Z";
const meta = { sessionId: "session-1", cwd: "/project", exportedAt: stamp };
function message(id: string, role: string, other: Record<string, unknown>) {
  return { type: "message", id, timestamp: stamp, parentId: null, message: { role, ...other } };
}
function call(id: string, name: string, args: Record<string, unknown>) {
  return message(`call-${id}`, "assistant", { content: [{ type: "toolCall", id, name, arguments: args }] });
}
function result(id: string, name: string, text: string, isError = false) {
  return message(`result-${id}`, "toolResult", { toolCallId: id, toolName: name, isError, content: [{ type: "text", text }] });
}

test("reconstructs prompts, assistant text, edits, test commands, failures, and markers", () => {
  const entries = [message("prompt", "user", { content: "Fix authentication\nUse tokens" }),
    message("answer", "assistant", { content: [{ type: "text", text: "Choose tokens because cookies aren't available." }] }),
    call("edit", "edit", { path: "src/auth.ts", newText: "WRITE_PAYLOAD_SECRET" }), result("edit", "edit", "Edited successfully"),
    call("test", "bash", { command: "npm test" }), result("test", "bash", "one test failed", true),
    { type: "custom", id: "marker", timestamp: stamp, customType: MARKER_TYPE, data: { text: "Use tokens because this is a CLI" } }];
  const records = buildTimeline(entries);
  assert.deepEqual(records.map((r) => r.kind), ["prompt", "assistant", "edit", "test", "decision"]);
  assert.equal(records[2].title, "edit completed: src/auth.ts");
  assert.equal(records[3].failed, true);
  assert.equal(records[4].entryId, "marker");
  assert.ok(!JSON.stringify(records).includes("WRITE_PAYLOAD_SECRET"));
});

test("does not extract decisions from assistant prose or expose thinking/images", () => {
  const records = buildTimeline([message("a", "assistant", { content: [
    { type: "thinking", thinking: "PRIVATE_REASONING", thinkingSignature: "PRIVATE_SIGNATURE" },
    { type: "image", data: "IMAGE_PAYLOAD" }, { type: "text", text: "Decision: use SQLite" }], stopReason: "stop" })]);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "assistant");
  assert.ok(!JSON.stringify(records).includes("PRIVATE"));
  assert.ok(!JSON.stringify(records).includes("IMAGE_PAYLOAD"));
});

test("supplied branch is authoritative; reconstruction is stateless and handles compaction", () => {
  const old = call("old", "write", { path: "abandoned.ts" });
  const active = [call("new", "write", { path: "active.ts" }), result("new", "write", "written"),
    { type: "compaction", id: "compact", timestamp: stamp, tokensBefore: 1234, summary: "Kept the active approach" },
    { type: "branch_summary", id: "branch", timestamp: stamp, fromId: "previous", summary: "Failed approach" },
    { type: "model_change", id: "model", timestamp: stamp, provider: "test", modelId: "model-a" }];
  buildTimeline([old]);
  const records = buildTimeline(active);
  assert.deepEqual(records.map((r) => r.kind), ["edit", "compaction", "branch", "model"]);
  assert.ok(!JSON.stringify(records).includes("abandoned.ts"));
  assert.deepEqual(buildTimeline(active), records);
});

test("handles namespaced tools, missing calls, direct bash commands, and cancellation", () => {
  const records = buildTimeline([call("n", "functions.bash", { command: "go test ./..." }), result("n", "functions.bash", "ok"),
    result("missing", "edit", "blocked", true), result("other", "read", "hello"),
    message("direct", "bashExecution", { command: "pytest -q", output: "cancelled", cancelled: true }),
    message("unknown", "bashExecution", { command: "pwd", output: "/project" }),
    message("abort", "assistant", { content: [], stopReason: "aborted", errorMessage: "Request aborted" })]);
  assert.deepEqual(records.map((r) => r.kind), ["test", "edit", "tool", "test", "command", "error"]);
  assert.ok(records[1].title.includes("[path unavailable]"));
  assert.equal(records[3].failed, true);
  assert.ok(records[4].title.includes("exit unknown"));
  assert.equal(records[5].detail, "Request aborted");
});

test("presentation offsets preserve multiline commands and literal output within sanitized excerpts", () => {
  const command = "python3 - <<'PY'\n\nprint('exit 42')\nPY\n\x1b[31mecho done\x1b[0m";
  const output = "exit 42\n\n```typescript\n# literal output\n```\n\x1b]0;evil\x07";
  const records = buildTimeline([call("c", "bash", { command }), result("c", "bash", output),
    message("direct", "bashExecution", { command, output, exitCode: 42 }),
    call("read", "read", { path: "src/example.ts" }), result("read", "read", "const answer = 42;")]);
  for (const record of records.slice(0, 2)) {
    assert.ok(record.command);
    assert.equal(record.detail.slice(2, record.command.end), cleanText(command));
    assert.equal(record.detail.slice(record.command.outputStart), cleanText(output));
    assert.ok(!record.detail.includes("\x1b"));
  }
  assert.equal(records[0].command?.status, "completed");
  assert.equal(records[1].command?.status, "exit 42");
  assert.equal(records[2].sourcePath, "src/example.ts");
  const capped = buildTimeline([call("long", "bash", { command: "echo " + "x".repeat(7000) }), result("long", "bash", "OMITTED_OUTPUT")])[0];
  assert.ok(capped.detail.length < 6200);
  assert.ok(!JSON.stringify(capped).includes("OMITTED_OUTPUT"));
  assert.ok(capped.detail.slice(2, capped.command?.end).includes("[…truncated;"));
});

test("test-command detection labels actual command positions, not mentions", () => {
  for (const cmd of ["npm test", "pnpm run test:unit", "yarn test", "pnpm exec vitest", "npx jest", "pytest -q", "python3 -m pytest", "go test ./...", "cargo test", "node --test tests/*.ts", "cd project && npm test", "CI=true npm test", "bun test", "./gradlew test"]) {
    assert.equal(isTestCommand(cmd), true, cmd);
  }
  for (const cmd of ["echo npm test", "rg pytest README.md", "cat tests/auth.test.ts", "npm install", "npm run testing-helper"]) {
    assert.equal(isTestCommand(cmd), false, cmd);
  }
});

test("queries AND text words, categories, and failed flags across edits/tests", () => {
  const records = buildTimeline([call("e", "edit", { path: "src/auth.ts" }), result("e", "edit", "old text not found", true),
    call("t", "bash", { command: "npm test auth" }), result("t", "bash", "test failed", true)]);
  assert.equal(filterTimeline(records, parseQuery("kind:edit status:failed auth old")).length, 1);
  assert.equal(filterTimeline(records, parseQuery("type:test AUTH")).length, 1);
  assert.equal(filterTimeline(records, parseQuery("auth absent")).length, 0);
  assert.equal(filterTimeline(records, parseQuery("result-e")).length, 1);
  assert.equal(parseQuery("kind:not-real").text, "kind:not-real");
});

test("sanitizes terminal controls, tolerates unknown entries, caps large output", () => {
  assert.equal(cleanText("\x1b[31mred\x1b[0m\x1b]0;evil title\x07\r\n\x00done"), "red\ndone");
  const records = buildTimeline([null, {}, { type: "future" }, message("a", "assistant", { content: [{ type: "text", text: "x".repeat(12000) }] })]);
  assert.equal(records.length, 1);
  assert.ok(records[0].detail.includes("truncated"));
  assert.ok(records[0].detail.length < 6200);
  assert.equal(clipped("hi"), "hi");
  assert.equal(timeLabel("bad date"), "--:--:--");
});

test("Markdown safely fences embedded Markdown and documents sensitive exports", () => {
  const records = buildTimeline([message("p", "user", { content: "```\n# embedded header\n````\n\x1b[31mred" })]);
  const md = exportMarkdown(records, meta);
  assert.match(md, /^# Blackbox — Pi session history\n/);
  assert.ok(md.includes("`````text"));
  assert.ok(md.includes("Active branch only"));
  assert.ok(md.includes("Exports may contain sensitive"));
  assert.ok(!md.includes("\x1b"));
});

test("exports are private, refuse overwrite/symlinks, and do not create custom parents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-flight-"));
  try {
    const path = join(dir, "timeline.md");
    await saveExport(path, [], meta);
    assert.match(await readFile(path, "utf8"), /Records: 0/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(saveExport(path, [], meta), { code: "EEXIST" });
    const link = join(dir, "link.md");
    await symlink(path, link);
    await assert.rejects(saveExport(link, [], meta), { code: "EEXIST" });
    await assert.rejects(saveExport(join(dir, "missing", "a.md"), [], meta), { code: "ENOENT" });
    await saveExport(join(dir, "default", "a.md"), [], meta, true);
    assert.equal((await stat(join(dir, "default"))).mode & 0o777, 0o700);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("destinations accept existing folders or files without creating custom directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-flight-destinations-"));
  const suggested = "/default/generated.md";
  try {
    await mkdir(join(dir, "archive folder"));
    await mkdir(join(dir, "reports.md"));
    assert.equal(await resolveExportDestination('"archive folder"', dir, suggested), join(dir, "archive folder", "generated.md"));
    assert.equal(await resolveExportDestination("reports.md", dir, suggested, true), join(dir, "reports.md", "generated.md"));
    assert.equal(await resolveExportDestination("archive folder/", dir, suggested), join(dir, "archive folder", "generated.md"));
    assert.equal(await resolveExportDestination("~", dir, suggested, true), join(homedir(), "generated.md"));
    assert.equal(await resolveExportDestination('"my timeline.md"', dir, suggested), join(dir, "my timeline.md"));
    assert.equal(await resolveExportDestination("~/my timeline.md", dir, suggested), join(homedir(), "my timeline.md"));
    await assert.rejects(resolveExportDestination("missing", dir, suggested, true), /Export folder does not exist/);
    await assert.rejects(resolveExportDestination('"missing/"', dir, suggested), /Export folder does not exist/);
    await saveExport(join(dir, "file.md"), [], meta);
    await assert.rejects(resolveExportDestination("file.md", dir, suggested, true), /Export folder is not a directory/);
    assert.equal(await resolveExportDestination("missing/file.md", dir, suggested), join(dir, "missing", "file.md"));
    await assert.rejects(stat(join(dir, "missing")), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("export paths allow quoted names and sanitize session IDs", () => {
  assert.equal(resolveExportPath('"my timeline.md"', "/project"), "/project/my timeline.md");
  const path = defaultExportPath("../../../bad", new Date(stamp));
  assert.ok(!path.includes("../"));
  assert.ok(path.endsWith("_________bad.md"));
});
