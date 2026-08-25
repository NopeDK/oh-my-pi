/**
 * ShellIntegrationParser — intercepts OSC 133 and OSC 9;9 sequences from the
 * raw PTY stream BEFORE they reach xterm-headless (which discards OSC payload).
 *
 * The parser is observational: it returns the chunk unchanged so xterm still
 * receives the full PTY output. It only observes and records state.
 *
 * OSC sequences parsed:
 * - ESC ] 133 ; A BEL/ST — prompt start
 * - ESC ] 133 ; B BEL/ST — command input start (user typing)
 * - ESC ] 133 ; C BEL/ST — command execution start (user pressed Enter)
 * - ESC ] 133 ; D [ ; <code> ] BEL/ST — command execution end (with or without exit code)
 * - ESC ] 9 ; 9 ; <cwd> BEL/ST — CWD reporting
 *
 * cmd.exe emits `133;D` WITHOUT an exit code parameter — the parser
 * distinguishes `133;D` (no param) from `133;D;<code>` (with param).
 */

export interface TerminalState {
	cwd: string | undefined;
	lastCommand: string | undefined;
	lastExitCode: number | undefined; // undefined when exit code is unknown (cmd.exe)
	commandHistory: Array<{ command: string; exitCode: number | undefined }>;
}

export interface CommandBoundary {
	commandStartRow: number; // xterm buffer row at 133;C
	commandEndRow: number; // xterm buffer row at 133;D
	command: string; // text between 133;B and 133;C
	exitCode: number | undefined; // from 133;D;<code>, or undefined if 133;D has no parameter (cmd.exe)
}

// OSC terminator: BEL (\x07) or ST (ESC \)
const OSC_START = "\x1b]";
const BEL = "\x07";
const ST = "\x1b\\";

export class ShellIntegrationParser {
	#state: TerminalState = {
		cwd: undefined,
		lastCommand: undefined,
		lastExitCode: undefined,
		commandHistory: [],
	};
	#buffer = ""; // accumulates partial OSC sequences across chunk boundaries
	#pendingCommand: string | undefined; // command text between 133;B and 133;C
	#lastBoundary: CommandBoundary | undefined;
	#lastMark: "A" | "B" | "C" | "D" | undefined;
	#commandStartRow: number | undefined; // buffer row at last 133;C
	#onCommandFailed: ((boundary: CommandBoundary) => void) | undefined;

	constructor(onCommandFailed?: (boundary: CommandBoundary) => void) {
		this.#onCommandFailed = onCommandFailed;
	}

	/**
	 * Feed a raw PTY chunk. Returns the chunk unchanged (lossless — xterm drops OSC anyway).
	 * The parser scans for OSC sequences and updates internal state.
	 */
	feed(chunk: string, xtermBufferRow?: () => number): string {
		const data = this.#buffer + chunk;
		this.#buffer = "";

		let pos = 0;
		while (pos < data.length) {
			const oscStart = data.indexOf(OSC_START, pos);
			if (oscStart === -1) {
				// No more OSC sequences in this chunk
				break;
			}

			// Find the terminator (BEL or ST)
			const belPos = data.indexOf(BEL, oscStart + 2);
			const stPos = data.indexOf(ST, oscStart + 2);

			let termPos: number;
			let termLen: number;
			if (belPos === -1 && stPos === -1) {
				// Incomplete sequence — buffer the rest for next chunk
				this.#buffer = data.slice(oscStart);
				break;
			}
			if (belPos === -1) {
				termPos = stPos;
				termLen = ST.length;
			} else if (stPos === -1) {
				termPos = belPos;
				termLen = BEL.length;
			} else {
				// Both found — take the earlier one
				if (belPos <= stPos) {
					termPos = belPos;
					termLen = BEL.length;
				} else {
					termPos = stPos;
					termLen = ST.length;
				}
			}

			const payload = data.slice(oscStart + 2, termPos);
			this.#processOsc(payload, xtermBufferRow);

			pos = termPos + termLen;
		}

		return chunk;
	}

	#processOsc(payload: string, xtermBufferRow?: () => number): void {
		// OSC 133;A / 133;B / 133;C / 133;D[;<code>]
		if (payload.startsWith("133;")) {
			const parts = payload.slice(4); // after "133;"
			const semicolonPos = parts.indexOf(";");
			const mark = semicolonPos === -1 ? parts : parts.slice(0, semicolonPos);
			const data = semicolonPos === -1 ? undefined : parts.slice(semicolonPos + 1);

			switch (mark) {
				case "A": // Prompt start
					this.#lastMark = "A";
					this.#pendingCommand = undefined;
					break;
				case "B": // Command input start
					this.#lastMark = "B";
					break;
				case "C": // Command execution start
					this.#lastMark = "C";
					this.#commandStartRow = xtermBufferRow?.();
					break;
				case "D": {
					this.#lastMark = "D";
					// Command execution end
					const exitCode = data !== undefined ? Number.parseInt(data, 10) : undefined;
					const commandEndRow = xtermBufferRow?.();
					const command = this.#pendingCommand ?? "";

					const boundary: CommandBoundary = {
						commandStartRow: this.#commandStartRow ?? 0,
						commandEndRow: commandEndRow ?? 0,
						command,
						exitCode: Number.isNaN(exitCode) ? undefined : exitCode,
					};

					this.#lastBoundary = boundary;
					this.#state.lastCommand = command || this.#state.lastCommand;
					this.#state.lastExitCode = boundary.exitCode;
					this.#state.commandHistory.push({ command, exitCode: boundary.exitCode });

					// Trigger error callback if exit code is non-zero
					if (boundary.exitCode !== undefined && boundary.exitCode !== 0 && this.#onCommandFailed) {
						this.#onCommandFailed(boundary);
					}

					this.#commandStartRow = undefined;
					break;
				}
			}
			return;
		}

		// OSC 9;9;<cwd> — CWD reporting
		if (payload.startsWith("9;9;")) {
			this.#state.cwd = payload.slice(4);
			return;
		}
	}

	/** Set the pending command text (captured from xterm buffer between 133;B and 133;C). */
	setPendingCommand(command: string): void {
		this.#pendingCommand = command;
	}

	getState(): Readonly<TerminalState> {
		return this.#state;
	}

	getLastBoundary(): CommandBoundary | undefined {
		return this.#lastBoundary;
	}

	getLastMark(): "A" | "B" | "C" | "D" | undefined {
		return this.#lastMark;
	}

	/** Reset state (used when a new shell session starts). */
	reset(): void {
		this.#state = {
			cwd: undefined,
			lastCommand: undefined,
			lastExitCode: undefined,
			commandHistory: [],
		};
		this.#buffer = "";
		this.#pendingCommand = undefined;
		this.#lastBoundary = undefined;
		this.#lastMark = undefined;
		this.#commandStartRow = undefined;
	}
}
