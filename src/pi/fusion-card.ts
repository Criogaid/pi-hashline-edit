import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import type { ActionFusionProgress } from "./action-fusion.ts";

const CARD_TYPE = "hashline-then-run";
const RESULT_TYPE = "hashline-then-run-result";

type CommandCardData = Pick<ActionFusionProgress, "toolCallId" | "commandText" | "command" | "output" | "reason"> & { version: 1 };

function commandCardData({ toolCallId, commandText, command, output, reason }: ActionFusionProgress): CommandCardData {
	return { version: 1, toolCallId, commandText, command, output, ...(reason ? { reason } : {}) };
}

/** Render one durable transcript card per fused command without adding model context. */
export function registerFusionCards(pi: ExtensionAPI) {
	const bash = createBashToolDefinition(process.cwd());
	const states = new Map<string, CommandCardData>();
	const active = new Set<string>();

	const restore = (ctx: ExtensionContext) => {
		states.clear();
		active.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || (entry.customType !== CARD_TYPE && entry.customType !== RESULT_TYPE)) continue;
			const data = entry.data as (ActionFusionProgress & { version?: number }) | undefined;
			if (data && typeof data.toolCallId === "string" && typeof data.commandText === "string" && typeof data.output === "string") {
				const restored = commandCardData(data);
				// Older snapshots stored the compound error in output. Recover only a known command wrapper.
				if (data.version !== 1 && ["skipped", "cancelled", "failed", "timeout"].includes(data.command)) {
					const marker = data.command === "cancelled" ? "[then_run:skipped]" : "[then_run:failed]";
					const fileState = data.publication === "PUBLISHED" ? "File changes are saved."
						: data.publication === "NOT_PUBLISHED" ? "No file changes were published." : "File state is uncertain.";
					const prefix = `mutation completed; then_run did not complete successfully ${marker}\n${fileState} Command ${data.command}.\n`;
					if (data.command !== "skipped" && data.output.startsWith(prefix)) restored.output = data.output.slice(prefix.length);
					else {
						restored.output = "";
						restored.reason = data.command === "skipped" ? "Command was not run." : "Legacy failure details are available in the original tool result.";
					}
				}
				states.set(data.toolCallId, restored);
			}
		}
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.registerEntryRenderer<CommandCardData>(CARD_TYPE, (entry, { expanded }, theme) => {
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
				const interrupted = pending && !active.has(current.toolCallId);
				const status = interrupted ? "interrupted (final status unknown)" : current.command;
				const failed = current.command === "failed" || current.command === "timeout";
				const color = pending || current.command === "cancelled" ? "warning" : failed ? "error" : current.command === "succeeded" ? "success" : "dim";
				const background = pending && !interrupted ? "toolPendingBg" : failed ? "toolErrorBg" : current.command === "succeeded" ? "toolSuccessBg" : "customMessageBg";
				box.setBgFn((line) => theme.bg(background, line));
				statusText.setText(`${theme.fg("toolTitle", theme.bold("then_run"))} · ${theme.fg(color, status)}`);
				const context = {
					args: { command: current.commandText }, toolCallId: current.toolCallId, cwd: process.cwd(),
					state: rendererState, invalidate: () => box.invalidate(),
					// Parent tool updates drive entry rendering; leave the native elapsed-time timer off.
					executionStarted: false, argsComplete: true, isPartial: pending && !interrupted, expanded, showImages: false,
					isError: failed,
				};
				call = bash.renderCall!(context.args, theme, { ...context, lastComponent: call });
				box.clear();
				box.addChild(statusText);
				box.addChild(call);
				if (current.reason) box.addChild(new Text(theme.fg("dim", current.reason), 0, 0));
				if (current.output || current.command === "succeeded" || failed) {
					result = bash.renderResult!({ content: [{ type: "text", text: current.output }], details: undefined },
						{ expanded, isPartial: context.isPartial }, theme, { ...context, lastComponent: result });
					box.addChild(result);
				}
				return box.render(width);
			},
		};
	});

	return (progress: ActionFusionProgress) => {
		const first = !states.has(progress.toolCallId);
		const data = commandCardData(progress);
		states.set(progress.toolCallId, data);
		const pending = progress.command === "waiting" || progress.command === "running";
		if (pending) active.add(progress.toolCallId);
		else active.delete(progress.toolCallId);
		// Only endpoints are persisted; streaming snapshots reuse Bash's bounded output.
		if (first) pi.appendEntry(CARD_TYPE, data);
		if (!pending) pi.appendEntry(RESULT_TYPE, data);
	};
}
