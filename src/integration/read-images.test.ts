import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { getImageDimensions } from "@earendil-works/pi-tui";
import hashlineEdit from "../index.ts";
import { openTestSession, responseStream, SESSION_TIMEOUT_MS } from "../testing/session.testing.ts";

// A 3000×8 PNG of a single color, wider than the configured resize limit.
const widePng =
  "iVBORw0KGgoAAAANSUhEUgAAC7gAAAAIAQAAAABBo49bAAAAGklEQVR4nO3BAQ0AAADCoPdPbQ43oAAAgBcDC8AAAYsOu+YAAAAASUVORK5CYII=";

for (const [autoResize, width] of [
  [false, 3000],
  [true, 2000],
] as const) {
  test(`session images.autoResize=${autoResize} → delegated read returns a ${width}px image`, {
    timeout: SESSION_TIMEOUT_MS,
  }, async (t) => {
    let result: ToolResultEvent | undefined;
    const { cwd, session, model } = await openTestSession(t, {
      tools: ["read"],
      images: { autoResize },
      async configure(pi) {
        await hashlineEdit(pi);
        pi.on("tool_result", (event) => {
          if (event.toolName === "read") result = event;
        });
      },
    });
    const path = "wide.png";
    await writeFile(join(cwd, path), Buffer.from(widePng, "base64"));
    let requests = 0;
    session.agent.streamFunction = () =>
      responseStream(
        model,
        requests++ === 0
          ? {
              stopReason: "toolUse",
              content: [{ type: "toolCall", id: "read-wide", name: "read", arguments: { path } }],
            }
          : { stopReason: "stop", content: [{ type: "text", text: "Done." }] },
      );
    await session.prompt("Read the image.");
    assert.ok(result);
    assert.equal(result.isError, false);
    const image = result.content.find((block) => block.type === "image");
    assert.ok(image);
    assert.equal(getImageDimensions(image.data, image.mimeType)?.widthPx, width);
    const note = result.content.find((block) => block.type === "text")?.text;
    assert.deepEqual(result.structuredContent, { ...image, note });
    const message = session.agent.state.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "read-wide",
    );
    assert.ok(message?.role === "toolResult");
    assert.deepEqual(
      message.content.find((block) => block.type === "image"),
      image,
    );
  });
}
