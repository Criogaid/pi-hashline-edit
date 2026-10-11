import { rejectsArgument } from "./argument-error.testing.ts";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_OUTPUT_BUDGETS, FORGET_MIN_BYTES } from "./budgets.ts";
import { withResultTag } from "./forget-tool.ts";
import { reportOf } from "./report.ts";
import {
  assertForgotten,
  finish,
  forgetCall,
  openForgetSession,
  SESSION_TIMEOUT_MS,
  taggedResultId,
  toolResponse,
  toolResult,
} from "./forget.testing.ts";

const LOG_BODY = `build payload ${"x".repeat(FORGET_MIN_BYTES)}\nlast line\n`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

for (const { name, filename, body, receiptSuffix } of [
  { name: "ordinary log", filename: "build.log", body: LOG_BODY, receiptSuffix: " · lines 1–2" },
  {
    name: "NUL log containing a row-like source line",
    filename: "build.log",
    body: `${LOG_BODY}\0\n1│source text\n`,
    receiptSuffix: "",
  },
  {
    name: "UTF-8 log containing a Unicode line separator",
    filename: "build.log",
    body: `before\u2028${LOG_BODY}`,
    receiptSuffix: " · lines 1–2",
  },
  { name: "PNG image", filename: "picture.png", body: PNG, receiptSuffix: " · image" },
]) {
  test(`${name} read then forgotten → the next request contains only a receipt`, {
    timeout: SESSION_TIMEOUT_MS,
  }, async (t) => {
    const f = await openForgetSession(t);
    await writeFile(join(f.cwd, filename), body);
    await f.prompt(
      toolResponse(f.read("read-log", filename)),
      (messages) => toolResponse(forgetCall(messages, "read-log")),
      finish,
    );
    const original = toolResult(f.requests[1], "read-log");
    const id = taggedResultId(original);
    assert.ok(id);
    if (typeof body === "string") {
      for (const line of body.trimEnd().split("\n")) {
        assert.ok(
          original.content.some((block) => block.type === "text" && block.text.includes(line)),
        );
      }
    } else {
      assert.ok(original.content.some((block) => block.type === "image"));
    }
    assert.equal(f.requests.length, 3, "A standalone forget must allow the model to continue");
    const forgotten = toolResult(f.requests[2], "read-log");
    const remainingText = forgotten.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    assert.ok(
      !remainingText.includes("build payload"),
      "Consumed file content must not be sent again",
    );
    assert.ok(!remainingText.includes(filename), "File headers are forgotten with the body");
    assertForgotten(forgotten, id);
    const receipt = `${join(f.cwd, filename)}${receiptSuffix}`;
    assert.partialDeepStrictEqual(f.rawResult("forget-call").details, {
      forgotten: [{ id, receipt }],
    });
    assert.ok(f.renderForgetCard().includes(receipt));
  });
}

test("forget in a mixed tool batch → work continues and unselected results stay intact", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  const f = await openForgetSession(t);
  for (const filename of ["build.log", "test.log", "keep.log"]) {
    await writeFile(join(f.cwd, filename), LOG_BODY);
  }
  await writeFile(join(f.cwd, "next.txt"), "next task");
  await f.prompt(
    toolResponse(
      f.read("selected"),
      f.read("selected-too", "test.log"),
      f.read("kept", "keep.log"),
    ),
    (messages) =>
      toolResponse(forgetCall(messages, "selected", "selected-too"), f.read("next", "next.txt")),
    finish,
  );
  assert.equal(f.requests.length, 3);
  for (const callId of ["selected", "selected-too"]) {
    const id = taggedResultId(toolResult(f.requests[1], callId));
    assert.ok(id);
    assertForgotten(toolResult(f.requests[2], callId), id);
  }
  assert.deepEqual(toolResult(f.requests[2], "kept"), toolResult(f.requests[1], "kept"));
  assert.equal(toolResult(f.requests[2], "next").isError, false);
  const expected = ["selected", "selected-too"].map((callId, index) => ({
    id: taggedResultId(toolResult(f.requests[1], callId)),
    receipt: `${join(f.cwd, index === 0 ? "build.log" : "test.log")} · lines 1–2`,
  }));
  assert.partialDeepStrictEqual(f.rawResult("forget-call").details, { forgotten: expected });
  const displayed = f.renderForgetCard();
  assert.equal(displayed.split("\n")[0].trimEnd(), `forget · ${expected.length} results`);
  assert.doesNotMatch(displayed, /Forgotten ·/);
  const expanded = f.renderForgetCard(true);
  for (const { id, receipt } of expected) {
    assert.ok(id);
    assert.ok(displayed.includes(receipt));
    assert.ok(!displayed.includes(id));
    assert.ok(expanded.includes(`${id} · ${receipt}`));
  }
  assert.ok(!displayed.includes("keep.log"));
  const payload = JSON.stringify(await f.requestPayload(2));
  assert.doesNotMatch(payload, /"forgetReceipt"|"forgotten":/);
  for (const { receipt } of expected) assert.ok(!payload.includes(receipt));
  const response = toolResult(f.requests[2], "forget-call");
  assert.deepEqual(response.content, f.rawResult("forget-call").content);
  for (const block of response.content) {
    if (block.type === "text") assert.ok(payload.includes(JSON.stringify(block.text).slice(1, -1)));
  }
});

for (const mode of ["pagination", "byte truncation"] as const) {
  test(`read stops at ${mode} → forget receipt names only the returned lines`, {
    timeout: SESSION_TIMEOUT_MS,
  }, async (t) => {
    const f = await openForgetSession(t);
    const path = join(f.cwd, "build.log");
    const maxReadBytes = DEFAULT_OUTPUT_BUDGETS.readBytes;
    const trailingLine = mode === "byte truncation" ? "y".repeat(maxReadBytes) : "next page";
    await writeFile(path, `skip this line\n${LOG_BODY}${trailingLine}\n`);
    const read = f.read("read-log");
    await f.prompt(
      toolResponse({
        ...read,
        arguments: { ...read.arguments, offset: 2, limit: mode === "pagination" ? 2 : 3 },
      }),
      (messages) => toolResponse(forgetCall(messages, "read-log")),
      finish,
    );
    const id = taggedResultId(toolResult(f.requests[1], "read-log"));
    assert.ok(id);
    const receipt = `${path} · lines 2–3${mode === "byte truncation" ? " · truncated" : ""}`;
    assert.partialDeepStrictEqual(f.rawResult("forget-call").details, {
      forgotten: [{ id, receipt }],
    });
    assert.ok(f.renderForgetCard().includes(receipt));
    assertForgotten(toolResult(f.requests[2], "read-log"), id);
    const details = f.rawResult("read-log").details;
    assert.ok(details && typeof details === "object");
    assert.ok(mode === "pagination" ? "pagination" in details : "truncation" in details);
  });
}

test("forget with a note → calls, saved facts, source bytes and raw session remain", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  const f = await openForgetSession(t);
  const path = join(f.cwd, "build.log");
  const note = "Build failed during dependency installation.";
  const read = f.read("read-log");
  await writeFile(path, LOG_BODY);
  await f.prompt(
    toolResponse(read),
    (messages) => {
      const call = forgetCall(messages, "read-log");
      return toolResponse({ ...call, arguments: { ...call.arguments, note } });
    },
    finish,
  );
  const calls = f.requests[2].flatMap((message) =>
    message.role === "assistant"
      ? message.content.filter((block) => block.type === "toolCall")
      : [],
  );
  assert.deepEqual(
    calls.find((call) => call.id === read.id),
    read,
  );
  assert.equal(calls.find((call) => call.name === "forget")?.arguments.note, note);
  const original = f.sessionManager
    .getEntries()
    .find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolCallId === read.id,
    );
  assert.ok(original?.type === "message" && original.message.role === "toolResult");
  assert.deepEqual(original.message.content, toolResult(f.requests[1], read.id).content);
  assert.equal(await readFile(path, "utf8"), LOG_BODY);
});

for (const invalid of ["old result", "unknown result"] as const) {
  test(`eligible id combined with ${invalid} → the whole forget call is rejected`, {
    timeout: SESSION_TIMEOUT_MS,
  }, async (t) => {
    const f = await openForgetSession(t);
    await writeFile(join(f.cwd, "build.log"), LOG_BODY);
    await f.prompt(
      toolResponse(f.read("old")),
      toolResponse(f.read("current")),
      (messages) => {
        const current = forgetCall(messages, "current");
        const currentId = taggedResultId(toolResult(messages, "current"));
        assert.ok(currentId);
        const old = taggedResultId(toolResult(messages, "old"));
        assert.ok(old);
        const invalidId = invalid === "old result" ? old : "r00000";
        assert.notEqual(taggedResultId(toolResult(messages, "current")), invalidId);
        return toolResponse({ ...current, arguments: { ids: [currentId, invalidId] } });
      },
      finish,
    );
    assert.equal(toolResult(f.requests[3], "forget-call").isError, true);
    for (const id of ["old", "current"]) {
      assert.deepEqual(toolResult(f.requests[3], id), toolResult(f.requests[2], id));
    }
    assert.ok(!f.sessionManager.getEntries().some((entry) => entry.type === "context_edit"));
  });
}

for (const scenario of [
  "rejected batch call",
  "split batch",
  "already forgotten result",
] as const) {
  test(`forget ${scenario} → later forget sees only the remaining batch results`, {
    timeout: SESSION_TIMEOUT_MS,
  }, async (t) => {
    const f = await openForgetSession(t);
    await writeFile(join(f.cwd, "build.log"), LOG_BODY);
    await f.prompt(
      toolResponse(f.read("batch-first"), f.read("batch-second")),
      (messages) => {
        const source = scenario === "rejected batch call" ? "batch-second" : "batch-first";
        const id = taggedResultId(toolResult(messages, source));
        assert.ok(id);
        const ids = scenario === "rejected batch call" ? ["r00000", id] : [id];
        for (const source of ["batch-first", "batch-second"])
          assert.notEqual(taggedResultId(toolResult(messages, source)), "r00000");
        return toolResponse({
          type: "toolCall",
          id: "forget-first-attempt",
          name: "forget",
          arguments: { ids },
        });
      },
      (messages) => {
        const originals = ["batch-first", "batch-second"].map((source) =>
          toolResult(f.requests[1], source),
        );
        const ids = originals.map((result) => {
          const id = taggedResultId(result);
          assert.ok(id);
          return id;
        });
        const firstAttempt = toolResult(messages, "forget-first-attempt");
        if (scenario === "rejected batch call") {
          assert.equal(firstAttempt.isError, true);
          const report = reportOf(firstAttempt);
          assert.equal(report?.error, "NOT_FORGETTABLE");
          assert.deepEqual(report?.ids, ["r00000"]);
          assert.deepEqual(report?.available, ids);
          for (const original of originals)
            assert.deepEqual(toolResult(messages, original.toolCallId), original);
        } else {
          assert.equal(firstAttempt.isError, false);
          assert.deepEqual(reportOf(firstAttempt)?.forgotten, [ids[0]]);
          assertForgotten(toolResult(messages, "batch-first"), ids[0]);
          assert.deepEqual(toolResult(messages, "batch-second"), originals[1]);
        }
        return toolResponse({
          type: "toolCall",
          id: "forget-second-attempt",
          name: "forget",
          arguments: { ids: [ids[scenario === "already forgotten result" ? 0 : 1]] },
        });
      },
      finish,
    );
    const firstId = taggedResultId(toolResult(f.requests[1], "batch-first"));
    const secondId = taggedResultId(toolResult(f.requests[1], "batch-second"));
    assert.ok(firstId && secondId);
    const after = f.requests[3];
    const secondAttempt = toolResult(after, "forget-second-attempt");
    if (scenario === "already forgotten result") {
      assert.equal(secondAttempt.isError, true);
      const report = reportOf(secondAttempt);
      assert.equal(report?.error, "NOT_FORGETTABLE");
      assert.deepEqual(report?.ids, [firstId]);
      assert.deepEqual(report?.available, [secondId]);
      assertForgotten(toolResult(after, "batch-first"), firstId);
      assert.deepEqual(
        toolResult(after, "batch-second"),
        toolResult(f.requests[1], "batch-second"),
      );
    } else {
      assert.equal(secondAttempt.isError, false, JSON.stringify(reportOf(secondAttempt)));
      assert.deepEqual(reportOf(secondAttempt)?.forgotten, [secondId]);
      assertForgotten(toolResult(after, "batch-second"), secondId);
      if (scenario === "split batch") assertForgotten(toolResult(after, "batch-first"), firstId);
      else
        assert.deepEqual(
          toolResult(after, "batch-first"),
          toolResult(f.requests[1], "batch-first"),
        );
    }
  });
}

test("forget mixed with read → the next forget is limited to the new batch", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  const f = await openForgetSession(t);
  await writeFile(join(f.cwd, "build.log"), LOG_BODY);
  await f.prompt(
    toolResponse(f.read("old-batch"), f.read("old-kept")),
    (messages) => toolResponse(forgetCall(messages, "old-batch"), f.read("new-batch")),
    (messages) => {
      const oldId = taggedResultId(toolResult(f.requests[1], "old-batch"));
      assert.ok(oldId);
      const keptId = taggedResultId(toolResult(messages, "old-kept"));
      assert.ok(keptId);
      assert.equal(toolResult(messages, "forget-call").isError, false);
      assertForgotten(toolResult(messages, "old-batch"), oldId);
      assert.ok(taggedResultId(toolResult(messages, "new-batch")));
      return toolResponse({
        type: "toolCall",
        id: "forget-old-batch",
        name: "forget",
        arguments: { ids: [oldId, keptId] },
      });
    },
    finish,
  );
  const oldId = taggedResultId(toolResult(f.requests[1], "old-batch"));
  const keptId = taggedResultId(toolResult(f.requests[1], "old-kept"));
  const newId = taggedResultId(toolResult(f.requests[2], "new-batch"));
  assert.ok(oldId && keptId && newId);
  const rejected = toolResult(f.requests[3], "forget-old-batch");
  assert.equal(rejected.isError, true);
  const report = reportOf(rejected);
  assert.equal(report?.error, "NOT_FORGETTABLE");
  assert.deepEqual(report?.ids, [oldId, keptId]);
  assert.deepEqual(report?.available, [newId]);
  assertForgotten(toolResult(f.requests[3], "old-batch"), oldId);
  assert.deepEqual(toolResult(f.requests[3], "old-kept"), toolResult(f.requests[1], "old-kept"));
  assert.deepEqual(toolResult(f.requests[3], "new-batch"), toolResult(f.requests[2], "new-batch"));
});

test("forget after a reply without tools → the earlier batch is no longer available", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  const f = await openForgetSession(t);
  await writeFile(join(f.cwd, "build.log"), LOG_BODY);
  await f.prompt(toolResponse(f.read("earlier-batch")), finish);
  const original = toolResult(f.requests[1], "earlier-batch");
  const id = taggedResultId(original);
  assert.ok(id);
  await f.prompt(
    toolResponse({
      type: "toolCall",
      id: "forget-after-text",
      name: "forget",
      arguments: { ids: [id] },
    }),
    finish,
  );
  const after = f.requests.at(-1);
  assert.ok(after);
  const rejected = toolResult(after, "forget-after-text");
  assert.equal(rejected.isError, true);
  const report = reportOf(rejected);
  assert.equal(report?.error, "NOT_FORGETTABLE");
  assert.deepEqual(report?.ids, [id]);
  assert.deepEqual(report?.available, []);
  assert.deepEqual(toolResult(after, "earlier-batch"), original);
});

for (const invalid of [
  "empty ids",
  "duplicate ids",
  "malformed id",
  "multiple invalid fields",
] as const) {
  test(`${invalid} from a model call → schema rejection leaves the result intact`, {
    timeout: SESSION_TIMEOUT_MS,
  }, async (t) => {
    const f = await openForgetSession(t);
    await writeFile(join(f.cwd, "build.log"), LOG_BODY);
    await f.prompt(
      toolResponse(f.read("read-log")),
      (messages) => {
        const id = taggedResultId(toolResult(messages, "read-log"));
        assert.ok(id);
        const ids =
          invalid === "empty ids"
            ? []
            : invalid === "duplicate ids"
              ? [id, id]
              : ["not-a-result-id"];
        return toolResponse({
          type: "toolCall",
          id: "forget-call",
          name: "forget",
          arguments: invalid === "multiple invalid fields" ? { ids, note: "" } : { ids },
        });
      },
      finish,
    );
    const rejection = toolResult(f.requests[2], "forget-call");
    assert.equal(rejection.isError, true);
    if (invalid === "multiple invalid fields") {
      const text = rejection.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      rejectsArgument("ids[0]", /pattern/)(new Error(text));
      rejectsArgument("note")(new Error(text));
    }
    assert.deepEqual(toolResult(f.requests[2], "read-log"), toolResult(f.requests[1], "read-log"));
  });
}

function collidingToolCallIds() {
  const maxCandidateCalls = 20_000;
  const seen = new Map<string, string>();
  for (let index = 0; index < maxCandidateCalls; index++) {
    const callId = `call_collision_${index}`;
    const id = taggedResultId(
      withResultTag(
        callId,
        {
          report: { tool: "read", path: "build.log" },
          payload: [{ type: "text", text: LOG_BODY }],
        },
        true,
        () => "build.log",
      ),
    );
    assert.ok(id);
    const earlier = seen.get(id);
    if (earlier) return [earlier, callId];
    seen.set(id, callId);
  }
  throw new Error("No colliding public result tags found within the fixture search bound");
}

for (const batch of ["same batch", "older visible batch"] as const) {
  test(`distinct read calls have colliding tags in the ${batch} → neither result is forgotten`, {
    timeout: SESSION_TIMEOUT_MS,
  }, async (t) => {
    const f = await openForgetSession(t);
    await writeFile(join(f.cwd, "build.log"), LOG_BODY);
    // Find real call ids that collide, then let actual reads produce the tagged results.
    const [first, second] = collidingToolCallIds();
    const reads =
      batch === "same batch"
        ? [toolResponse(f.read(first), f.read(second))]
        : [toolResponse(f.read(first)), toolResponse(f.read(second))];
    await f.prompt(
      ...reads,
      (messages) => {
        assert.equal(
          taggedResultId(toolResult(messages, first)),
          taggedResultId(toolResult(messages, second)),
        );
        return toolResponse(forgetCall(messages, second));
      },
      finish,
    );
    const before = f.requests[reads.length];
    const after = f.requests[reads.length + 1];
    assert.equal(toolResult(after, "forget-call").isError, true);
    assert.deepEqual(toolResult(after, first), toolResult(before, first));
    assert.deepEqual(toolResult(after, second), toolResult(before, second));
  });
}

test("model output is truncated while requesting forget → Pi rejects the call and retains the result", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  const f = await openForgetSession(t);
  await writeFile(join(f.cwd, "build.log"), LOG_BODY);
  await f.prompt(
    toolResponse(f.read("read-log")),
    (messages) => ({
      content: [forgetCall(messages, "read-log")],
      stopReason: "length",
    }),
    finish,
  );
  assert.equal(toolResult(f.requests[2], "forget-call").isError, true);
  assert.deepEqual(toolResult(f.requests[2], "read-log"), toolResult(f.requests[1], "read-log"));
});

for (const entry of ["direct", "codemode"] as const) {
  test(`codemode forwards mixed text outputs → ${entry} forget removes the whole script result`, {
    timeout: SESSION_TIMEOUT_MS,
  }, async (t) => {
    const f = await openForgetSession(t);
    await writeFile(join(f.cwd, "build.log"), LOG_BODY);
    await writeFile(join(f.cwd, "keep.log"), "keep this source\n");
    const code = [
      'const results = await Promise.all([tools.read({path:"build.log"}), tools.read({path:"keep.log"})]);',
      "text({selected: results[0], another: results[1]});",
      'text("Saved conclusion from the script.");',
    ].join("\n");
    const note = "Keep the saved conclusion.";
    await f.prompt(
      toolResponse({ type: "toolCall", id: "script-read", name: "codemode", arguments: { code } }),
      (messages) => {
        const result = toolResult(messages, "script-read");
        const id = taggedResultId(result);
        assert.ok(id, "The persisted codemode result must have a usable tag");
        const text = result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        assert.equal(
          [...text.matchAll(/\bresultId\b/g)].length,
          1,
          "Nested reads must not expose unusable tags",
        );
        assert.match(text, /entire codemode output/i);
        const call = forgetCall(messages, "script-read");
        return toolResponse(
          entry === "direct"
            ? { ...call, arguments: { ...call.arguments, note } }
            : {
                type: "toolCall",
                id: "forget-script",
                name: "codemode",
                arguments: {
                  code: `text(await tools.forget(${JSON.stringify({ ids: [id], note })}));`,
                },
              },
        );
      },
      finish,
    );
    const original = toolResult(f.requests[1], "script-read");
    const id = taggedResultId(original);
    assert.ok(id);
    assertForgotten(toolResult(f.requests[2], "script-read"), id);
    assert.deepEqual(f.rawResult("script-read").content, original.content);
    assert.equal(await readFile(join(f.cwd, "build.log"), "utf8"), LOG_BODY);
    assert.equal(await readFile(join(f.cwd, "keep.log"), "utf8"), "keep this source\n");
    assert.equal(
      toolResult(f.requests[2], entry === "direct" ? "forget-call" : "forget-script").isError,
      false,
    );
    const payload = JSON.stringify(await f.requestPayload(2));
    assert.ok(!payload.includes("build payload"));
    assert.ok(!payload.includes("keep this source"));
    assert.ok(payload.includes(note));
  });
}

for (const { name, code } of [
  {
    name: "filtered short read",
    code: 'await tools.read({path:"build.log"}); text("only a conclusion");',
  },
  {
    name: "script error",
    code: 'text(await tools.read({path:"build.log"})); throw new Error("script failed");',
  },
  { name: "no read calls", code: `text(${JSON.stringify(LOG_BODY)});` },
]) {
  test(`codemode ${name} → output has no forget tags`, {
    timeout: SESSION_TIMEOUT_MS,
  }, async (t) => {
    const f = await openForgetSession(t);
    await writeFile(join(f.cwd, "build.log"), LOG_BODY);
    await f.prompt(
      toolResponse({ type: "toolCall", id: "script-read", name: "codemode", arguments: { code } }),
      finish,
    );
    const output = toolResult(f.requests[1], "script-read")
      .content.filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    assert.doesNotMatch(output, /\[result r[0-9a-f]{5}\]/);
  });
}

test("codemode prints inspection text and an image → forget removes every output block", {
  timeout: SESSION_TIMEOUT_MS,
}, async (t) => {
  const f = await openForgetSession(t);
  await writeFile(join(f.cwd, "build.log"), LOG_BODY);
  await f.prompt(
    toolResponse({
      type: "toolCall",
      id: "script-image",
      name: "codemode",
      arguments: {
        code: `text(await tools.read({path:"build.log"})); image(${JSON.stringify({ type: "image", data: PNG.toString("base64"), mimeType: "image/png" })});`,
      },
    }),
    (messages) => toolResponse(forgetCall(messages, "script-image")),
    finish,
  );
  const original = toolResult(f.requests[1], "script-image");
  assert.ok(original.content.some((block) => block.type === "image"));
  const id = taggedResultId(original);
  assert.ok(id);
  assertForgotten(toolResult(f.requests[2], "script-image"), id);
  assert.deepEqual(f.rawResult("script-image").content, original.content);
  assert.equal(await readFile(join(f.cwd, "build.log"), "utf8"), LOG_BODY);
});
