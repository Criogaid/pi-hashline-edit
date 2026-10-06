import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { FORGET_MIN_BYTES } from "./budgets.ts";
import { withResultTag } from "./forget-tool.ts";
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

for (const { name, filename, body } of [
  { name: "ordinary log", filename: "build.log", body: LOG_BODY },
  {
    name: "NUL log containing a row-like source line",
    filename: "build.log",
    body: `${LOG_BODY}\0\n1│source text\n`,
  },
  {
    name: "UTF-8 log containing a Unicode line separator",
    filename: "build.log",
    body: `before\u2028${LOG_BODY}`,
  },
  { name: "PNG image", filename: "picture.png", body: PNG },
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
});

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

for (const invalid of ["empty ids", "duplicate ids", "malformed id"] as const) {
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
          arguments: { ids },
        });
      },
      finish,
    );
    assert.equal(toolResult(f.requests[2], "forget-call").isError, true);
    assert.deepEqual(toolResult(f.requests[2], "read-log"), toolResult(f.requests[1], "read-log"));
  });
}

function collidingToolCallIds() {
  const maxCandidateCalls = 20_000;
  const seen = new Map<string, string>();
  for (let index = 0; index < maxCandidateCalls; index++) {
    const callId = `call_collision_${index}`;
    const id = taggedResultId(
      withResultTag(callId, { content: [{ type: "text", text: LOG_BODY }] }),
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
