/**
 * TerminalPaneComponent — persistent shell pane for the AI-native terminal.
 *
 * Forked from BashInteractiveOverlayComponent (bash-interactive.ts:112-320).
 * Key differences:
 * - No command lifecycle (no setComplete, no state tracking, no overlay chrome)
 * - Esc is forwarded to PTY (normal shell behavior), not used for dismissal
 * - ShellIntegrationParser observes the PTY stream before xterm
 * - readScrollback() provides non-duplicated reading for the agent bridge
 * - startShell() resolves pwsh > powershell > cmd.exe and injects integration scripts
 *
 * Future: alacritty_terminal (Rust) is the planned replacement for xterm-headless
 * in Phase 1. xterm-specific calls (terminal creation, buffer access, write)
 * should eventually be isolated behind a thin interface. For MVP, this is
 * comment-level only — premature abstraction would slow the MVP.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";
import {
	type Component,
	CURSOR_MARKER,
	extractPrintableText,
	parseKey,
	parseKittySequence,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type * as XtermModule from "@oh-my-pi/pi-utils/vterm";
import type { BufferLine, Terminal as XtermTerminalType } from "@oh-my-pi/pi-utils/vterm";
import { type CommandBoundary, ShellIntegrationParser, type TerminalState } from "../../tools/shell-integration-parser";
import { readTerminalRows, styleTerminalRow } from "../../tools/terminal-output";
import type { Theme } from "../theme/theme";

// Caps the live xterm display backlog to prevent unbounded memory growth.
const MAX_LIVE_WRITE_QUEUE_CHUNKS = 512;

/**
 * Find the raw string index at the start of the visible column `col`,
 * skipping ANSI escape sequences (CSI, OSC, APC, single-char ESC).
 * Returns `content.length` if `col` is at or past the end of visible content.
 */
function rawIndexAtCol(content: string, col: number): number {
	let visibleCol = 0;
	let i = 0;
	while (i < content.length) {
		if (content[i] === "\x1b") {
			// ESC sequence — skip entirely (zero visible width)
			i = skipEscape(content, i);
			continue;
		}
		if (visibleCol >= col) return i;
		// Advance one visible cell. Most chars are width 1; wide chars (CJK,
		// emoji) are width 2. Control chars other than ESC are width 0.
		const code = content.codePointAt(i)!;
		const charLen = code > 0xffff ? 2 : 1;
		const w = charWidth(code);
		visibleCol += w;
		i += charLen;
	}
	return i;
}

/** Returns the visible char at `col` and its width, or null if none. */
function charAtCol(content: string, col: number): { chars: string; width: number } | null {
	let visibleCol = 0;
	let i = 0;
	while (i < content.length) {
		if (content[i] === "\x1b") {
			i = skipEscape(content, i);
			continue;
		}
		const code = content.codePointAt(i)!;
		const charLen = code > 0xffff ? 2 : 1;
		const w = charWidth(code);
		if (visibleCol === col) {
			return { chars: content.slice(i, i + charLen), width: w };
		}
		visibleCol += w;
		i += charLen;
	}
	return null;
}

/** Skip an ANSI escape sequence starting at index `i` (content[i] === "\x1b"). Returns the index after the sequence. */
function skipEscape(content: string, i: number): number {
	const next = content[i + 1];
	if (next === "[") {
		// CSI: ESC [ params intermediates final
		let j = i + 2;
		while (j < content.length) {
			const c = content[j]!.charCodeAt(0);
			if (c >= 0x40 && c <= 0x7e) return j + 1; // final byte
			j++;
		}
		return j;
	}
	if (next === "]" || next === "_") {
		// OSC (]) or APC (_): terminated by BEL (\x07) or ST (ESC \)
		let j = i + 2;
		while (j < content.length) {
			if (content[j] === "\x07") return j + 1;
			if (content[j] === "\x1b" && content[j + 1] === "\\") return j + 2;
			j++;
		}
		return j;
	}
	// Other ESC sequences: ESC + single byte
	return i + 2;
}

/** Visible width of a Unicode code point (1 or 2). */
function charWidth(code: number): number {
	if (code < 0x20 || code === 0x7f) return 0; // control chars
	// Simplified wide-char check: CJK ranges, emoji, etc.
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0x303e) ||
		(code >= 0x3040 && code <= 0x33bf) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1faff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

let xtermTerminalCtor: typeof XtermModule.Terminal | undefined;

/** Lazily load the headless xterm Terminal (same pattern as bash-interactive.ts). */
export async function loadXtermTerminal(): Promise<typeof XtermModule.Terminal> {
	if (!xtermTerminalCtor) {
		const mod = await import("@oh-my-pi/pi-utils/vterm");
		xtermTerminalCtor = mod.Terminal;
	}
	return xtermTerminalCtor;
}

function normalizeInputForPty(data: string, applicationCursorKeysMode: boolean): string {
	const kitty = parseKittySequence(data);
	if (kitty?.eventType === 3) {
		return "";
	}
	const printableText = extractPrintableText(data);
	if (printableText) {
		return printableText;
	}
	if (!kitty) {
		return data;
	}
	const keyId = parseKey(data);
	if (!keyId) {
		return data;
	}
	const normalizedKey = keyId.toLowerCase();
	if (normalizedKey === "up") return applicationCursorKeysMode ? "\x1bOA" : "\x1b[A";
	if (normalizedKey === "down") return applicationCursorKeysMode ? "\x1bOB" : "\x1b[B";
	if (normalizedKey === "right") return applicationCursorKeysMode ? "\x1bOC" : "\x1b[C";
	if (normalizedKey === "left") return applicationCursorKeysMode ? "\x1bOD" : "\x1b[D";
	if (normalizedKey === "home") return applicationCursorKeysMode ? "\x1bOH" : "\x1b[H";
	if (normalizedKey === "end") return applicationCursorKeysMode ? "\x1bOF" : "\x1b[F";
	if (normalizedKey === "pageup") return "\x1b[5~";
	if (normalizedKey === "pagedown") return "\x1b[6~";
	if (normalizedKey === "insert") return "\x1b[2~";
	if (normalizedKey === "delete") return "\x1b[3~";
	if (normalizedKey === "shift+tab") return "\x1b[Z";
	if (normalizedKey === "enter") return "\r";
	if (normalizedKey === "tab") return "\t";
	if (normalizedKey === "space") return " ";
	if (normalizedKey === "backspace") return "\x7f";
	if (normalizedKey === "escape") return "\x1b";
	const ctrlMatch = /^ctrl\+([a-z])$/u.exec(normalizedKey);
	if (ctrlMatch) {
		const letter = ctrlMatch[1]!;
		return String.fromCharCode(letter.charCodeAt(0) - 96);
	}
	const altMatch = /^alt\+([a-z])$/u.exec(normalizedKey);
	if (altMatch) {
		return `\x1b${altMatch[1]!}`;
	}
	if (kitty.codepoint >= 32 && kitty.codepoint < 127) {
		let ch = String.fromCharCode(kitty.codepoint);
		if (kitty.modifier & 4) {
			const code = kitty.codepoint;
			if (code >= 97 && code <= 122) {
				ch = String.fromCharCode(code - 96);
			}
		}
		if (kitty.modifier & 2) {
			ch = `\x1b${ch}`;
		}
		return ch;
	}
	return data;
}

export interface TerminalScrollbackResult {
	lines: string[];
	totalLines: number;
	newLinesSinceLastRead: number;
	readPosition: number;
	cwd: string | undefined;
	lastCommand: string | undefined;
	lastExitCode: number | undefined;
}

export interface ShellExitInfo {
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut: boolean;
	lastMark: "A" | "B" | "C" | "D" | undefined;
}

export interface TerminalPaneOptions {
	shellLabel: string;
	theme: Theme;
	onCommandFailed?: (boundary: CommandBoundary) => void;
	onShellExit?: (info: ShellExitInfo) => void;
	/** Called when new PTY output arrives — triggers TUI re-render. */
	onOutput?: () => void;
	/** Called when a line is promoted to scrollback (for persistence). */
	onScrollbackCommit?: (line: BufferLine) => void;
	/** Called when scrollback is cleared (for persistence). */
	onScrollbackClear?: () => void;
}

export class TerminalPaneComponent implements Component {
	#terminal: XtermTerminalType;
	#session: PtySession | null = null;
	#shellIntegration: ShellIntegrationParser;
	#theme: Theme;
	#onOutput?: () => void;
	#shellLabel: string;
	#onShellExit?: (info: ShellExitInfo) => void;
	#lastCols = 0;
	#lastRows = 0;
	#writeQueue: string[] = [];
	#writeOffset = 0;
	#flushResolvers: Array<() => void> = [];
	#writing = false;
	#disposed = false;
	#lastReadContentLines = 0;
	#scrollOffset = 0; // 0 = bottom (live), positive = scrolled up into scrollback
	#useTerminalCursor = false;
	#focused = false;

	// Shell startup state
	#shellStarted = false;
	#shellExited = false;

	constructor(options: TerminalPaneOptions, terminalCtor: typeof XtermModule.Terminal) {
		this.#shellLabel = options.shellLabel;
		this.#theme = options.theme;
		this.#onOutput = options.onOutput;
		this.#onShellExit = options.onShellExit;
		this.#shellIntegration = new ShellIntegrationParser(options.onCommandFailed);
		this.#terminal = new terminalCtor({
			cols: 120,
			rows: 40,
			disableStdin: true,
			allowProposedApi: true,
			scrollback: 10_000,
			onScrollbackCommit: options.onScrollbackCommit,
			onScrollbackClear: options.onScrollbackClear,
		});
	}

	/** Whether the terminal pane has focus (drives border color). */
	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
	}

	/** Controls cursor rendering: hardware (marker) when true, software (inverted) when false. */
	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#useTerminalCursor = useTerminalCursor;
	}
	appendOutput(chunk: string): void {
		// Parser observes the stream, then unchanged chunk flows to xterm
		const passthrough = this.#shellIntegration.feed(chunk, () => this.#getCurrentBufferRow());
		this.#writeQueue.push(passthrough);
		this.#trimWriteQueue();
		this.#drainQueue();
		// New output resets scroll to bottom (live view)
		this.#scrollOffset = 0;
		this.#onOutput?.();
	}
	/**
	 * Find the last row in the buffer that has non-blank content.
	 * Scans backwards from the buffer end, checking each line's cells for
	 * any non-space character. This is the WTA ReadEntireBuffer approach:
	 * GetLastNonSpaceCharacter().y gives the actual content extent,
	 * independent of cursor position (which is unreliable after resizes).
	 * Returns -1 if the buffer is entirely blank.
	 */
	#findLastContentRow(): number {
		const buffer = this.#terminal.buffer.active;
		for (let row = buffer.length - 1; row >= 0; row--) {
			const line = buffer.getLine(row);
			if (!line) continue;
			for (let col = 0; col < line.cells.length; col++) {
				const cell = line.cells[col]!;
				if (cell.chars && cell.chars !== " ") return row;
			}
		}
		return -1;
	}

	/**
	 * Get the current buffer row for shell integration tracking.
	 * Uses cursor position (baseY + cursorY + 1) — correct during active
	 * output (cursor is at content end). NOT resize-safe, but called on
	 * every PTY output chunk (hot path) where the cursor is always at the
	 * content end. Use #findLastContentRow() for cold-path reads instead.
	 */
	#getCurrentBufferRow(): number {
		const buffer = this.#terminal.buffer.active;
		return buffer.baseY + buffer.cursorY + 1;
	}

	#trimWriteQueue(): void {
		if (this.#writeOffset > 0) {
			this.#writeQueue.splice(0, this.#writeOffset);
			this.#writeOffset = 0;
		}
		const firstPending = this.#writing ? 1 : 0;
		const overflow = this.#writeQueue.length - firstPending - MAX_LIVE_WRITE_QUEUE_CHUNKS;
		if (overflow > 0) {
			this.#writeQueue.splice(firstPending, overflow);
			this.#writeQueue[firstPending] = `\u001b\\${this.#writeQueue[firstPending]}`;
		}
	}

	#drainQueue(): void {
		if (this.#writing) return;
		if (this.#writeOffset >= this.#writeQueue.length) {
			this.#resolveFlushWaiters();
			return;
		}
		this.#writing = true;
		const data = this.#writeQueue[this.#writeOffset]!;
		this.#terminal.write(data, () => {
			this.#writing = false;
			this.#writeOffset += 1;
			if (this.#writeOffset >= this.#writeQueue.length) {
				this.#writeQueue = [];
				this.#writeOffset = 0;
				this.#resolveFlushWaiters();
			}
			this.#drainQueue();
		});
	}

	#resolveFlushWaiters(): void {
		if (this.#writing || this.#writeOffset < this.#writeQueue.length) return;
		if (this.#flushResolvers.length === 0) return;
		const resolvers = this.#flushResolvers;
		this.#flushResolvers = [];
		for (const resolve of resolvers) {
			resolve();
		}
	}

	flushOutput(): Promise<void> {
		if (!this.#writing && this.#writeOffset >= this.#writeQueue.length) {
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#flushResolvers.push(resolve);
		return promise;
	}

	handleInput(data: string): void {
		// Esc is forwarded to PTY as normal shell input (not dismissal)
		// Layout manager (PaneLayout) intercepts Shift+Alt+S/D/F before reaching here
		// Scroll keys are intercepted locally when terminal pane has focus
		const keyId = parseKey(data);
		if (keyId) {
			const k = keyId.toLowerCase();
			if (k === "pageup") {
				this.#scrollBy(-Math.max(1, this.#terminal.rows - 2));
				return;
			}
			if (k === "pagedown") {
				this.#scrollBy(Math.max(1, this.#terminal.rows - 2));
				return;
			}
			if (k === "ctrl+home") {
				this.#scrollToTop();
				return;
			}
			if (k === "ctrl+end") {
				this.#scrollToBottom();
				return;
			}
		}
		const normalizedInput = normalizeInputForPty(data, this.#terminal.modes.applicationCursorKeysMode);
		if (!normalizedInput) return;
		this.#session?.write(normalizedInput);
	}

	/** Scroll by delta lines (negative = up, positive = down). Clamped to [0, scrollback]. */
	#scrollBy(delta: number): void {
		const maxScroll = this.#terminal.buffer.active.baseY; // scrollback.length
		this.#scrollOffset = Math.max(0, Math.min(maxScroll, this.#scrollOffset - delta));
		this.#onOutput?.();
	}
	#scrollToTop(): void {
		this.#scrollOffset = this.#terminal.buffer.active.baseY;
		this.#onOutput?.();
	}

	/** Scroll to the bottom (live view). */
	#scrollToBottom(): void {
		this.#scrollOffset = 0;
		this.#onOutput?.();
	}

	/** Whether the terminal pane is currently scrolled up (not at live bottom). */
	get isScrolled(): boolean {
		return this.#scrollOffset > 0;
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(20, width);
		const innerWidth = Math.max(1, safeWidth - 2);
		// Read viewport at current xterm buffer state, adjusted for scroll offset
		const buffer = this.#terminal.buffer.active;
		const maxRows = Math.max(1, this.#terminal.rows);
		// viewportY = scrollback.length (bottom). Scroll back by offset.
		const startRow = Math.max(0, buffer.viewportY - this.#scrollOffset);
		const rows = readTerminalRows(this.#terminal, startRow, maxRows).map((line: string) =>
			truncateToWidth(styleTerminalRow(line, this.#theme.getFgAnsi("toolOutput")), innerWidth),
		);
		// Focus-colored border: accent when focused, border when not
		const borderColor = this.#focused ? "accent" : "border";
		const borderH = this.#theme.fg(borderColor, this.#theme.boxRound.horizontal.repeat(innerWidth));
		const borderV = this.#theme.fg(borderColor, this.#theme.boxRound.vertical);
		// Cursor: when focused and at live bottom (not scrolled), render a
		// cursor at xterm's cursor position. Hardware cursor mode emits
		// CURSOR_MARKER (zero-width sentinel) — TUI positions the native
		// terminal cursor there (blink controlled by Windows Terminal).
		// Software cursor mode inverts the cell at the cursor position.
		const showCursor = this.#focused && this.#scrollOffset === 0;
		const cursorCol = Math.min(buffer.cursorX, innerWidth - 1);
		const cursorRowIdx = buffer.cursorY; // screen-relative, 0-indexed
		const boxLine = (line: string, rowIdx: number) => {
			let content = line;
			if (showCursor && rowIdx === cursorRowIdx && cursorCol < innerWidth) {
				// readTerminalRows trims trailing whitespace, but the cursor may
				// be positioned in that trimmed area (e.g. the space after "PS C:\> ").
				// Pad the content to the cursor column so the marker lands at the
				// correct visible position.
				const contentWidth = visibleWidth(content);
				if (contentWidth < cursorCol) {
					content = content + " ".repeat(cursorCol - contentWidth);
				}
				// Find the raw string index corresponding to cursorCol visible
				// columns. Insert the marker at that raw index — this preserves
				// all ANSI escape codes (including style transitions that sit
				// exactly at the cursor boundary, e.g. PSReadLine ghost text).
				const insertAt = rawIndexAtCol(content, cursorCol);
				if (this.#useTerminalCursor) {
					// Hardware cursor: emit zero-width marker at cursor position
					content = content.slice(0, insertAt) + CURSOR_MARKER + content.slice(insertAt);
				} else {
					// Software cursor: invert the cell at cursor position.
					// Find the visible char at cursorCol and wrap it with reverse.
					const charInfo = charAtCol(content, cursorCol);
					const before = content.slice(0, insertAt);
					const rest = content.slice(insertAt);
					if (charInfo) {
						const cellEnd = rawIndexAtCol(content, cursorCol + charInfo.width);
						const cell = content.slice(insertAt, cellEnd);
						const afterCell = content.slice(cellEnd);
						content = `${before}\x1b[7m${cell || " "}\x1b[27m${afterCell}`;
					} else {
						content = `${before}\x1b[7m \x1b[27m${rest}`;
					}
				}
			}
			return `${borderV}${content}${" ".repeat(Math.max(0, innerWidth - visibleWidth(content)))}${borderV}`;
		};
		// Scroll indicator: replace the first visible chars of the top border
		// with "↑ scrolled" text, then fill the rest with horizontal border chars.
		// Build from visible-width-aware parts — never slice ANSI strings.
		const scrollLabel = "↑ scrolled";
		const labelWidth = visibleWidth(scrollLabel);
		const remainingWidth = Math.max(0, innerWidth - labelWidth);
		const topBorder =
			this.#scrollOffset > 0
				? `${this.#theme.fg(borderColor, this.#theme.boxRound.topLeft)}${this.#theme.fg(borderColor, scrollLabel)}${this.#theme.fg(borderColor, this.#theme.boxRound.horizontal.repeat(remainingWidth))}${this.#theme.fg(borderColor, this.#theme.boxRound.topRight)}`
				: `${this.#theme.fg(borderColor, this.#theme.boxRound.topLeft)}${borderH}${this.#theme.fg(borderColor, this.#theme.boxRound.topRight)}`;
		return [
			topBorder,
			...rows.map((line, i) => boxLine(line, i)),
			`${this.#theme.fg(borderColor, this.#theme.boxRound.bottomLeft)}${borderH}${this.#theme.fg(borderColor, this.#theme.boxRound.bottomRight)}`,
		];
	}

	/** Resize the terminal and PTY session. Called by PaneLayout when dimensions change. */
	resize(cols: number, rows: number): void {
		this.#terminal.resize(cols, rows);
		try {
			this.#session?.resize(cols, rows);
		} catch {
			// Session may have ended
		}
	}

	/** Check if dimensions changed and resize if needed. Called from render flow. */
	checkResize(cols: number, rows: number): boolean {
		if (cols !== this.#lastCols || rows !== this.#lastRows) {
			this.#lastCols = cols;
			this.#lastRows = rows;
			this.resize(cols, rows);
			return true;
		}
		return false;
	}

	/** Start the shell with integration injection. */
	startShell(options: {
		application: string;
		args: string[];
		cwd: string;
		env: Record<string, string>;
		cols: number;
		rows: number;
	}): void {
		if (this.#shellStarted || this.#disposed) return;
		this.#shellStarted = true;

		const session = new PtySession();
		this.#session = session;

		// Set initial dimensions
		this.#lastCols = options.cols;
		this.#lastRows = options.rows;

		session
			.startArgv(
				{
					application: options.application,
					args: options.args,
					cwd: options.cwd,
					env: options.env,
					cols: options.cols,
					rows: options.rows,
				},
				(_err, chunk) => {
					if (chunk) this.appendOutput(chunk);
				},
				(_err, _pid) => {
					// Shell started
				},
			)
			.then((result: PtyRunResult) => {
				this.#shellExited = true;
				this.#onShellExit?.({
					exitCode: result.exitCode,
					cancelled: result.cancelled,
					timedOut: result.timedOut,
					lastMark: this.#shellIntegration.getLastMark(),
				});
			})
			.catch(() => {
				this.#shellExited = true;
				this.#onShellExit?.({
					exitCode: undefined,
					cancelled: true,
					timedOut: false,
					lastMark: this.#shellIntegration.getLastMark(),
				});
			});
	}

	/** Write a command to the shell PTY (used by agent bridge). */
	writeToShell(data: string): void {
		this.#session?.write(data);
	}

	/** Non-duplicated scrollback reading API for the agent bridge. */
	readScrollback(opts: {
		lines?: number;
		offset?: number;
		amount?: number;
		force?: boolean;
	}): TerminalScrollbackResult {
		const buffer = this.#terminal.buffer.active;
		// Find actual content extent by scanning backwards for the last
		// non-blank row. This is resize-safe: cursor position (baseY +
		// cursorY) is unreliable after reflow moves the cursor. WTA's
		// ReadEntireBuffer uses GetLastNonSpaceCharacter().y for the same
		// purpose.
		const lastContentRow = this.#findLastContentRow();
		const contentBottom = lastContentRow + 1; // exclusive end
		const totalLines = Math.max(0, contentBottom);
		const newLinesSinceLastRead = Math.max(0, totalLines - this.#lastReadContentLines);

		const offsetFromBottom = opts.offset ?? 0;

		// Non-duplication: cap line count at newLinesSinceLastRead unless force is true
		let lineCount: number;
		if (opts.force) {
			lineCount = opts.amount ?? opts.lines ?? 15;
		} else {
			const requested = opts.amount ?? opts.lines ?? 15;
			lineCount = Math.min(requested, newLinesSinceLastRead);
		}

		if (lineCount <= 0) {
			const state = this.#shellIntegration.getState();
			return {
				lines: [],
				totalLines,
				newLinesSinceLastRead,
				readPosition: offsetFromBottom,
				cwd: state.cwd,
				lastCommand: state.lastCommand,
				lastExitCode: state.lastExitCode,
			};
		}

		// Read from the content bottom backwards. offsetFromBottom shifts
		// the read window up from the content end.
		const endRow = Math.max(0, contentBottom - offsetFromBottom);
		const startRow = Math.max(0, endRow - lineCount);
		const lines = readTerminalRows(this.#terminal, startRow, endRow - startRow);

		const readPosition = offsetFromBottom + lines.length;
		this.#lastReadContentLines = totalLines;

		const state = this.#shellIntegration.getState();
		return {
			lines,
			totalLines,
			newLinesSinceLastRead,
			readPosition,
			cwd: state.cwd,
			lastCommand: state.lastCommand,
			lastExitCode: state.lastExitCode,
		};
	}

	/** Read lines bounded by a command boundary (for ErrorAssist). */
	readCommandBoundary(boundary: CommandBoundary): string[] {
		const startRow = boundary.commandStartRow;
		const endRow = boundary.commandEndRow;
		const rowCount = Math.max(0, endRow - startRow);
		return readTerminalRows(this.#terminal, startRow, rowCount);
	}

	get shellStarted(): boolean {
		return this.#shellStarted;
	}

	get shellExited(): boolean {
		return this.#shellExited;
	}

	get shellLabel(): string {
		return this.#shellLabel;
	}

	/** Get terminal state for the agent bridge. */
	getTerminalState(): Readonly<TerminalState> | undefined {
		return this.#shellIntegration.getState();
	}

	/** Get the last command boundary (for ErrorAssist). */
	getLastBoundary(): CommandBoundary | undefined {
		return this.#shellIntegration.getLastBoundary();
	}

	/** Promote screen content to scrollback (for persistence before save). */
	flushScreenToScrollback(): void {
		this.#terminal.flushScreenToScrollback();
		this.#onOutput?.();
	}

	/** Restore previously-saved scrollback lines into the terminal buffer. */
	restoreScrollback(lines: BufferLine[]): void {
		this.#terminal.restoreScrollback(lines);
	}

	/** Access the underlying xterm Terminal for scrollback persistence. */
	get terminal(): XtermTerminalType {
		return this.#terminal;
	}

	invalidate(): void {}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		try {
			this.#session?.kill();
		} catch {
			// Session may already be dead
		}
		this.#terminal.dispose();
	}
}

// ── Shell resolution ──────────────────────────────────────────────────────

/**
 * Resolve the shell binary to use for the terminal pane.
 * Priority: pwsh 7+ > Windows PowerShell 5.x > cmd.exe
 * On POSIX: uses $SHELL or falls back to /bin/bash
 */
export function resolveShellBinary(): { application: string; args: string[]; label: string } {
	if (process.platform === "win32") {
		// Check for pwsh 7+ on PATH
		try {
			const result = Bun.spawnSync(["where", "pwsh.exe"], { stdout: "pipe", stderr: "pipe" });
			if (result.stdout && result.stdout.toString().trim().length > 0) {
				return { application: "pwsh.exe", args: ["-NoExit"], label: "powershell" };
			}
		} catch {
			// pwsh not found
		}
		// Check for Windows PowerShell 5.x
		try {
			const result = Bun.spawnSync(["where", "powershell.exe"], { stdout: "pipe", stderr: "pipe" });
			if (result.stdout && result.stdout.toString().trim().length > 0) {
				return { application: "powershell.exe", args: ["-NoExit"], label: "powershell" };
			}
		} catch {
			// powershell not found
		}
		// Fall back to cmd.exe (always present on Windows)
		return { application: "cmd.exe", args: [], label: "cmd" };
	}

	// POSIX: use $SHELL or fall back to bash
	const shell = process.env.SHELL || "/bin/bash";
	return { application: shell, args: ["-i"], label: shell.split("/").pop() ?? "shell" };
}

/**
 * Get the shell integration injection script for the given shell type.
 * Scripts borrowed from WTA (doc/configuring-shell-integration-autofix.md:36-65),
 * adapted with OMP_TERM sentinel and __omp_ prefix.
 */
export function getShellIntegrationScript(shellLabel: string): string | undefined {
	switch (shellLabel) {
		case "powershell":
			// PowerShell (pwsh 7+ and Windows PowerShell 5.x) — from WTA
			return [
				"$__omp_origPrompt = $function:prompt",
				"function prompt {",
				"    $ec = if ($?) { 0 } else { 1 }",
				'    "`e]133;D;$ec`a`e]133;A`a$($__omp_origPrompt.Invoke())`e]133;B`a"',
				"}",
			].join("\n");

		case "cmd":
			// cmd.exe — from WTA spec Shell-Integration-Marks.md
			// 133;D without exit code (cmd can't dynamically expand %ERRORLEVEL% in PROMPT)
			return "PROMPT $e]133;D$e\\$e]133;A$e\\$e]9;9;$P$e\\%PROMPT%$e]133;B$e\\";

		default:
			// bash — from WTA
			return [
				"__omp_shellinteg_prompt() {",
				"    local __ec=$?",
				'    printf \'\\033]133;D;%s\\007\\033]133;A\\007\\033]9;9;%s\\007\' "$__ec" "${PWD:-}"',
				"}",
				"PROMPT_COMMAND=__omp_shellinteg_prompt",
				"PS1=\"${PS1:-}\"'\\[\\033]133;B\\007\\]'",
			].join("\n");
	}
}

/**
 * Build the full shell startup options for TerminalPaneComponent.startShell().
 * Combines shell resolution + integration injection + session CWD + env.
 */
export function buildShellStartupOptions(
	cwd: string,
	cols: number,
	rows: number,
): {
	application: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	cols: number;
	rows: number;
	label: string;
} {
	const { application, args, label } = resolveShellBinary();
	const integrationScript = getShellIntegrationScript(label);

	// Base env with OMP_TERM sentinel and TERM
	const env: Record<string, string> = {
		...process.env,
		OMP_TERM: "1",
		TERM: "xterm-256color",
	};

	// Inject integration script based on shell type
	if (label === "powershell" && integrationScript) {
		// For PowerShell, use -NoExit -Command to inject the prompt function
		return {
			application,
			args: ["-NoExit", "-Command", integrationScript],
			cwd,
			env,
			cols,
			rows,
			label,
		};
	}

	if (label === "cmd" && integrationScript) {
		// For cmd.exe, use /k to inject the PROMPT command
		return {
			application,
			args: ["/k", integrationScript],
			cwd,
			env,
			cols,
			rows,
			label,
		};
	}

	// bash: write integration script to a temp init file and pass --init-file.
	// bash never sources arbitrary env vars, so we generate an rc file that
	// sources the user's ~/.bashrc first (preserving their prompt/aliases),
	// then appends the OSC 133 integration block (PROMPT_COMMAND + PS1).
	if (integrationScript) {
		const initFile = writeBashInitFile(integrationScript);
		if (initFile) {
			return {
				application,
				args: ["--init-file", initFile, ...args],
				cwd,
				env,
				cols,
				rows,
				label,
			};
		}
	}

	return {
		application,
		args,
		cwd,
		env,
		cols,
		rows,
		label,
	};
}

/**
 * Write a bash init file that sources ~/.bashrc then appends the OSC 133
 * integration script. Returns the temp file path, or undefined on failure.
 */
function writeBashInitFile(integrationScript: string): string | undefined {
	try {
		const tmpDir = os.tmpdir();
		const initPath = path.join(tmpDir, `omp-shell-integration-${process.pid}.bash`);
		const home = os.homedir();
		const bashrcPath = path.join(home, ".bashrc");
		const initContent = [
			`# OMP shell integration init file (auto-generated)`,
			`# Source the user's ~/.bashrc first to preserve their prompt/aliases`,
			`[ -f "${bashrcPath}" ] && source "${bashrcPath}"`,
			``,
			`# OMP OSC 133 shell integration`,
			integrationScript,
		].join("\n");
		fs.writeFileSync(initPath, initContent, { mode: 0o644 });
		return initPath;
	} catch {
		return undefined;
	}
}
