import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import type { ActionFusionProgress } from "./action-fusion.ts";

const CARD_TYPE = "hashline-then-run";
const RESULT_TYPE = "hashline-then-run-result";

/** Render one durable transcript card per fused command without adding model context. */
export function registerFusionCards(pi: ExtensionAPI) {
	const bash = createBashToolDefinition(process.cwd());
	const states = new Map<string, ActionFusionProgress>();
	const active = new Set<string>();

	const restore = (ctx: ExtensionContext) => {
		states.clear();
		active.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || (entry.customType !== CARD_TYPE && entry.customType !== RESULT_TYPE)) continue;
			const data = entry.data as ActionFusionProgress | undefined;
			if (data && typeof data.toolCallId === "string" && typeof data.commandText === "string" && typeof data.output === "string") {
				states.set(data.toolCallId, data);
			}
		}
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.registerEntryRenderer<ActionFusionProgress>(CARD_TYPE, (entry, { expanded }, theme) => {
		const initial = entry.data;
		if (!initial) return undefined;
		const statusText = new Text("", 0, 0);
		const box = new Box(1, 1);
		let call: Component | undefined;
		let result: Component | undefined;
		const rendererState = { startedAt: undefined, endedAt: undefined, interval: undefined };
		return {
			invalidate: () => box.invalidate(),
			render(width) {
				// Read live state during rendering; native tool updates schedule the repaint.
				const current = states.get(initial.toolCallId) ?? initial;
				const pending = current.command === "waiting" || current.command === "running";
				const status = pending && !active.has(current.toolCallId) ? "interrupted (final status unknown)" : current.command;
				const color = pending ? "warning" : current.command === "succeeded" ? "success" : "error";
				const background = pending ? "toolPendingBg" : current.command === "succeeded" ? "toolSuccessBg" : "toolErrorBg";
				box.setBgFn((line) => theme.bg(background, line));
				const stale = current.freshness === "changed" || current.freshness === "missing" ? `\nAnchors are stale: target ${current.freshness}.` : "";
				statusText.setText(`${theme.fg("toolTitle", theme.bold("then_run"))} · ${theme.fg(color, status)}\n${current.path}\npublication=${current.publication} freshness=${current.freshness}${stale}`);
				const context = {
					args: { command: current.commandText }, toolCallId: current.toolCallId, cwd: process.cwd(),
					state: rendererState, invalidate: () => box.invalidate(),
					// Parent tool updates drive entry rendering; leave the native elapsed-time timer off.
					executionStarted: false, argsComplete: true, isPartial: pending, expanded, showImages: false,
					isError: !pending && current.command !== "succeeded",
				};
				call = bash.renderCall!(context.args, theme, { ...context, lastComponent: call });
				result = bash.renderResult!({ content: [{ type: "text", text: current.output }], details: undefined },
					{ expanded, isPartial: pending }, theme, { ...context, lastComponent: result });
				box.clear();
				box.addChild(statusText);
				box.addChild(call);
				box.addChild(result);
				return box.render(width);
			},
		};
	});

	return (progress: ActionFusionProgress) => {
		const first = !states.has(progress.toolCallId);
		states.set(progress.toolCallId, progress);
		const pending = progress.command === "waiting" || progress.command === "running";
		if (pending) active.add(progress.toolCallId);
		else active.delete(progress.toolCallId);
		// Only endpoints are persisted; streaming snapshots reuse Bash's bounded output.
		if (first) pi.appendEntry(CARD_TYPE, progress);
		if (!pending) pi.appendEntry(RESULT_TYPE, progress);
	};
}
