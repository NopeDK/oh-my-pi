/**
 * Terminal tools — read_terminal and send_terminal.
 *
 * These tools give the agent access to the persistent shell pane's state:
 * - read_terminal: reads scrollback with non-duplication (default 15 lines,
 *   caps at newLinesSinceLastRead unless force: true). Returns readPosition
 *   for LLM reasoning.
 * - send_terminal: writes a command to the shell PTY (presses Enter by default).
 *
 * Both tools are no-ops when no terminal pane is mounted (non-interactive
 * sessions, or before the user presses Shift+Alt+S/D to create the shell).
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ToolSession } from ".";

// ── read_terminal ──────────────────────────────────────────────────────────

const readTerminalSchema = type({
	amount: type("number").describe("Number of lines to read from the terminal scrollback (default 15)"),
	offset: type("number").describe("Lines from the bottom to start reading (default 0 = most recent)"),
	force: type("boolean").describe(
		"If true, read the full requested amount even if no new lines arrived since last read",
	),
});

type ReadTerminalParams = typeof readTerminalSchema.infer;

const readTerminalDescription = `Read the persistent terminal pane's scrollback.

Returns recent terminal output with non-duplication: by default, only lines that arrived since the last read are returned (capped at the requested amount). Use force: true to re-read the full requested amount regardless of new lines.

You can also use the read tool with \`terminal://\` as the path (e.g. \`read("terminal://")\` for default 15 lines, \`read("terminal://:0-30")\` for 30 lines from the bottom, \`read("terminal://:force")\` to force re-read).

Returns:
- lines: array of text lines from the terminal
- totalLines: total lines in the scrollback buffer
- newLinesSinceLastRead: lines that arrived since the last read
- readPosition: offset from bottom of the last read (for reasoning about position)
- cwd: current working directory reported by the shell
- lastCommand: last executed command
- lastExitCode: last command's exit code (undefined if unknown, e.g. cmd.exe)

If no terminal pane is mounted, returns an empty result with a warning.`;

export class ReadTerminalTool implements AgentTool<typeof readTerminalSchema> {
	readonly name = "read_terminal";
	readonly approval = "read" as const;
	readonly label = "Read Terminal";
	readonly description = readTerminalDescription;
	readonly parameters = readTerminalSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Read the persistent terminal pane's scrollback";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, params: ReadTerminalParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const result = this.session.readTerminalScrollback?.({
				amount: params.amount,
				offset: params.offset,
				force: params.force,
			});

			if (!result) {
				return {
					content: [
						{
							type: "text",
							text: "No terminal pane is mounted. The terminal pane is created when the user opens the shell pane (Shift+Alt+S or Shift+Alt+D).",
						},
					],
				};
			}

			const linesText = result.lines.length > 0 ? result.lines.join("\n") : "(no new lines since last read)";

			const text = [
				`Terminal scrollback (${result.lines.length} lines, ${result.newLinesSinceLastRead} new since last read):`,
				`readPosition: ${result.readPosition} | totalLines: ${result.totalLines}`,
				result.cwd ? `cwd: ${result.cwd}` : "cwd: (unknown)",
				result.lastCommand ? `lastCommand: ${result.lastCommand}` : "lastCommand: (none)",
				`lastExitCode: ${result.lastExitCode ?? "unknown"}`,
				"",
				linesText,
			].join("\n");

			return { content: [{ type: "text", text }] };
		});
	}
}

// ── send_terminal ──────────────────────────────────────────────────────────

const sendTerminalSchema = type({
	command: type("string").describe("Command or text to send to the terminal pane's PTY"),
	press_enter: type("boolean").describe(
		"If true (default), press Enter after sending the command. Set false to type without executing.",
	),
});

type SendTerminalParams = typeof sendTerminalSchema.infer;

const sendTerminalDescription = `Send a command to the persistent terminal pane's shell.

Writes the command text to the shell's PTY. By default, presses Enter after the command (press_enter: true). Set press_enter: false to type text without executing (e.g. for autocomplete or multi-line input).

Use read_terminal afterwards to see the command's output.

If no terminal pane is mounted, returns a warning.`;

export class SendTerminalTool implements AgentTool<typeof sendTerminalSchema> {
	readonly name = "send_terminal";
	readonly approval = "exec" as const;
	readonly label = "Send Terminal";
	readonly description = sendTerminalDescription;
	readonly parameters = sendTerminalSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Send a command to the persistent terminal pane's shell";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, params: SendTerminalParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			if (!this.session.writeToTerminalPane) {
				return {
					content: [
						{
							type: "text",
							text: "No terminal pane is mounted. The terminal pane is created when the user opens the shell pane (Shift+Alt+S or Shift+Alt+D).",
						},
					],
				};
			}

			const pressEnter = params.press_enter !== false;
			this.session.writeToTerminalPane(params.command, pressEnter);

			const action = pressEnter ? "sent (Enter pressed)" : "typed (no Enter)";
			return {
				content: [
					{
						type: "text",
						text: `Command ${action}: ${params.command}`,
					},
				],
			};
		});
	}
}
