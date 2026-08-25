/**
 * PaneLayout — split and toggle layout manager for the AI-native terminal.
 *
 * Wraps TerminalPaneComponent (shell pane) and an agent pane (existing OMP
 * containers). Four layout modes:
 * - full-agent: default, normal OMP, no shell visible
 * - split-v: shell on top half, agent on bottom half
 * - split-h: shell on left half, agent on right half
 * - full-term: only shell visible, agent hidden
 *
 * OMP starts in full-agent mode. Shell is lazily created on first keybind press.
 * If the shell process exits, layout returns to full-agent.
 *
 * Keybindings (left-hand only, Shift+Alt+ combos, WASD area, no conflicts):
 * - Shift+Alt+S → start shell + cycle split-v ↔ split-h
 * - Shift+Alt+D → start shell + cycle full-term ↔ full-agent
 * - Shift+Alt+F → switch focus between panes (split modes only)
 * Tab is NOT intercepted — passes through to focused pane for autocomplete.
 *
 * render() IS the reflow — no separate reflow method. When mode changes,
 * the next renderFrame() calls render() at new dimensions, which detects
 * terminal dim changes and calls terminalPane.resize().
 *
 * Follows the GitTuiComponent side-by-side pattern (git-tui/index.ts:572-590):
 * sub-width renders joined per row with a focus-colored separator.
 */

import { type Component, Container, type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { ScrollbackPersistence } from "../../session/scrollback-persistence";
import type { CommandBoundary, TerminalState } from "../../tools/shell-integration-parser";
import type { Theme } from "../theme/theme";
import {
	buildShellStartupOptions,
	loadXtermTerminal,
	type ShellExitInfo,
	TerminalPaneComponent,
	type TerminalScrollbackResult,
} from "./terminal-pane";
import { TranscriptContainer } from "./transcript-container";

export type LayoutMode = "full-agent" | "split-v" | "split-h" | "full-term";
export type PaneFocus = "terminal" | "agent";

export interface PaneLayoutOptions {
	theme: Theme;
	/** Returns the terminal's current row count (for height-aware rendering). */
	getTerminalRows: () => number;
	/** Called when the terminal pane state changes (for agent bridge wiring). */
	onTerminalStateChange?: () => void;
	/** Called when a command fails with non-zero exit code (for ErrorAssist). */
	onCommandFailed?: (boundary: CommandBoundary, scrollback: string[]) => void;
	/** The session's current working directory (for shell startup). */
	cwd: string;
	/** Component that receives input when the agent pane is focused (the editor). */
	agentInputTarget?: Component;
	/** Called when the shell process exits. */
	onShellExit?: (info: ShellExitInfo) => void;
	/** Optional scrollback persistence manager. */
	scrollbackPersistence?: ScrollbackPersistence;
}

export class PaneLayout implements Component {
	#agentInputTarget?: Component;
	#terminalPane: TerminalPaneComponent | undefined;
	#agentPane: Component;
	#theme: Theme;
	#getTerminalRows: () => number;
	#onTerminalStateChange?: () => void;
	#scrollbackPersistence?: ScrollbackPersistence;
	#onCommandFailed?: (boundary: CommandBoundary, scrollback: string[]) => void;
	#onShellExit?: (info: ShellExitInfo) => void;
	#cwd: string;
	#mode: LayoutMode = "full-agent";
	#focus: PaneFocus = "agent";
	#xtermReady = false;
	#transcriptContainer: TranscriptContainer | undefined;
	/** Focusable implementation — delegates to the editor when agent pane is focused. */
	#focused = false;
	#hardwareCursorEnabled = false;
	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		this.#syncEditorFocus();
	}
	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#hardwareCursorEnabled = useTerminalCursor;
		// When terminal pane is focused, pass the flag to the terminal pane
		// so it can choose hardware cursor (marker) vs software cursor (inverted cell).
		if (this.#focus === "terminal" && this.#terminalPane) {
			this.#terminalPane.setUseTerminalCursor(useTerminalCursor);
		} else if (this.#agentInputTarget && "setUseTerminalCursor" in this.#agentInputTarget) {
			(this.#agentInputTarget as Component & Focusable).setUseTerminalCursor?.(useTerminalCursor);
		}
	}

	constructor(agentPane: Component, options: PaneLayoutOptions) {
		this.#agentPane = agentPane;
		this.#theme = options.theme;
		this.#getTerminalRows = options.getTerminalRows;
		this.#onTerminalStateChange = options.onTerminalStateChange;
		this.#agentInputTarget = options.agentInputTarget;
		this.#onCommandFailed = options.onCommandFailed;
		this.#cwd = options.cwd;
		this.#onShellExit = options.onShellExit;
		this.#scrollbackPersistence = options.scrollbackPersistence;
		// Scan agent pane children for TranscriptContainer — Composer.renderFrame
		// needs it for renderViewport (live capacity, history, animation sync).
		if (agentPane instanceof Container) {
			for (const child of agentPane.children) {
				if (child instanceof TranscriptContainer) {
					this.#transcriptContainer = child;
					break;
				}
			}
		}
	}

	/** Async preparation: load xterm and create the terminal pane. */
	async prepareTerminalPane(): Promise<void> {
		if (this.#terminalPane || this.#xtermReady) return;
		this.#xtermReady = true;
		const terminalCtor = await loadXtermTerminal();
		// Resolve shell first to get the correct label for the terminal pane header
		const startupOpts = buildShellStartupOptions(this.#cwd, 120, 40);
		this.#terminalPane = new TerminalPaneComponent(
			{
				shellLabel: startupOpts.label,
				theme: this.#theme,
				onOutput: () => this.#onTerminalStateChange?.(),
				onCommandFailed: boundary => {
					if (this.#onCommandFailed && this.#terminalPane) {
						const lines = this.#terminalPane.readCommandBoundary(boundary);
						this.#onCommandFailed(boundary, lines);
					}
				},
				onShellExit: info => this.onShellExit(info),
				onScrollbackCommit: this.#scrollbackPersistence
					? line => this.#scrollbackPersistence!.commit(line)
					: undefined,
				onScrollbackClear: this.#scrollbackPersistence ? () => this.#scrollbackPersistence!.clear() : undefined,
			},
			terminalCtor,
		);

		// Restore scrollback from persistence before starting the shell so
		// restored lines appear above the new prompt as frozen history.
		if (this.#scrollbackPersistence) {
			const lines = this.#scrollbackPersistence.readAll();
			if (lines.length > 0) this.#terminalPane.restoreScrollback(lines);
		}

		// Start the shell
		this.#terminalPane.startShell(startupOpts);
		this.#onTerminalStateChange?.();
	}

	// Keybind 1: Shift+Alt+S — start shell + cycle split-v / split-h
	async #keybind1(): Promise<void> {
		await this.prepareTerminalPane();
		if (this.#mode === "split-v") this.#setMode("split-h");
		else this.#setMode("split-v");
		this.#focus = "terminal";
		this.#syncEditorFocus();
		this.#onTerminalStateChange?.();
	}

	// Keybind 2: Shift+Alt+D — toggle between full-term and full-agent.
	// From split view: uses focused pane to decide which full mode to enter.
	//   terminal focused → full-term, agent focused → full-agent.
	// From full-term → full-agent. From full-agent → full-term.
	async #keybind2(): Promise<void> {
		if (this.#mode === "full-term") {
			this.#setMode("full-agent");
			this.#focus = "agent";
		} else if (this.#mode === "full-agent") {
			await this.prepareTerminalPane();
			this.#setMode("full-term");
			this.#focus = "terminal";
		} else {
			// Split view: use focused pane to pick full mode
			if (this.#focus === "terminal") {
				await this.prepareTerminalPane();
				this.#setMode("full-term");
			} else {
				this.#setMode("full-agent");
			}
		}
		this.#syncEditorFocus();
		this.#onTerminalStateChange?.();
	}

	#setMode(mode: LayoutMode): void {
		this.#mode = mode;
		// No explicit reflow needed — render() detects dimension changes and resizes.
	}

	/** Update focus state on both panes based on current pane focus. */
	#syncEditorFocus(): void {
		if (this.#agentInputTarget && "focused" in this.#agentInputTarget) {
			(this.#agentInputTarget as Component & Focusable).focused = this.#focused && this.#focus === "agent";
		}
		if (this.#terminalPane) {
			this.#terminalPane.focused = this.#focused && this.#focus === "terminal";
		}
		// Propagate hardware cursor preference to the newly focused pane.
		// The TUI only calls setUseTerminalCursor when the top-level focused
		// component changes, not when focus switches within PaneLayout.
		if (this.#focused) {
			this.setUseTerminalCursor(this.#hardwareCursorEnabled);
		}
	}

	async onShellExit(info: ShellExitInfo): Promise<void> {
		// Drain the xterm write queue before flushing screen to scrollback
		// so the last command's final output is captured for persistence.
		if (this.#scrollbackPersistence && this.#terminalPane) {
			await this.#terminalPane.flushOutput();
			this.#terminalPane.flushScreenToScrollback();
			this.#scrollbackPersistence.flushSync();
		}
		this.#onShellExit?.(info);
		this.#terminalPane?.dispose();
		this.#terminalPane = undefined;
		this.#xtermReady = false;
		this.#setMode("full-agent");
		this.#focus = "agent";
		this.#syncEditorFocus();
		this.#onTerminalStateChange?.();
	}

	#toggleFocus(): void {
		if (this.#mode === "full-agent" || this.#mode === "full-term") return;
		this.#focus = this.#focus === "terminal" ? "agent" : "terminal";
		this.#syncEditorFocus();
		this.#onTerminalStateChange?.();
	}

	handleInput(data: string): void {
		// Left-hand-only keybindings (Shift+Alt+ combos, WASD area, no conflicts)
		if (matchesKey(data, "shift+alt+s")) {
			this.#keybind1();
			return;
		}
		if (matchesKey(data, "shift+alt+d")) {
			this.#keybind2();
			return;
		}
		if (matchesKey(data, "shift+alt+f")) {
			this.#toggleFocus();
			return;
		}
		// Tab is NOT intercepted — it goes to the focused pane for autocomplete
		if (this.#focus === "terminal" && this.#terminalPane) {
			this.#terminalPane.handleInput(data);
		} else {
			// Forward to the editor (agentInputTarget) which actually handles input.
			// The agent pane Container itself has no handleInput — without this,
			// all keyboard input is swallowed and the TUI appears frozen.
			this.#agentInputTarget?.handleInput?.(data) ?? this.#agentPane.handleInput?.(data);
		}
	}

	render(width: number): readonly string[] {
		const height = this.#getTerminalRows();

		switch (this.#mode) {
			case "full-agent":
				return this.#agentPane.render(width);

			case "full-term": {
				if (!this.#terminalPane) return this.#agentPane.render(width);
				this.#checkTerminalResize(width, height);
				return this.#terminalPane.render(width);
			}

			case "split-v": {
				if (!this.#terminalPane) return this.#agentPane.render(width);
				const terminalHeight = Math.max(5, Math.floor(height * 0.5));
				const agentHeight = Math.max(1, height - terminalHeight - 1);
				this.#checkTerminalResize(width, terminalHeight);

				const terminalLines = this.#terminalPane.render(width);
				const terminalRows: string[] = terminalLines.slice(0, terminalHeight);
				// Pad terminal rows to terminalHeight
				while (terminalRows.length < terminalHeight) {
					terminalRows.push(" ".repeat(width));
				}
				const separator = this.#theme.fg("borderMuted", this.#theme.boxRound.horizontal.repeat(width));
				// Render agent pane with height-bounded transcript.
				// Container.render() is unbounded (transcript can be hundreds of lines),
				// so we split the agent pane into chrome + bounded transcript tail —
				// same pattern as Composer.#renderResizeTail.
				const agentRows = this.#renderAgentBounded(width, agentHeight);
				return [...terminalRows, separator, ...agentRows];
			}

			case "split-h": {
				if (!this.#terminalPane) return this.#agentPane.render(width);
				const terminalWidth = Math.max(20, Math.floor(width * 0.5));
				const agentWidth = Math.max(1, width - terminalWidth - 1);
				this.#checkTerminalResize(terminalWidth, height);

				const terminalLines = this.#terminalPane.render(terminalWidth);
				// Render agent pane with height-bounded transcript (same as split-v)
				const agentLines = this.#renderAgentBounded(agentWidth, height);
				const separator = this.#theme.fg("borderMuted", "│");

				const maxRows = Math.max(terminalLines.length, agentLines.length, height);
				const rows: string[] = [];
				for (let i = 0; i < maxRows; i++) {
					const left = terminalLines[i] ?? "";
					const leftPad = " ".repeat(Math.max(0, terminalWidth - visibleWidth(left)));
					const right = agentLines[i] ?? "";
					rows.push(`${truncateToWidth(left, terminalWidth)}${leftPad}${separator}${right}`);
				}
				return rows;
			}
		}
	}

	/**
	 * Render the agent pane's non-transcript children (the "chrome" around the
	 * transcript). Used by Composer.renderFrame to split the transcript from
	 * the rest, so it can call transcript.renderViewport() with flexible height.
	 *
	 * In full-agent mode, renders all agent pane children except the transcript.
	 * In split/full-term modes, renders terminal pane + non-transcript agent chrome.
	 * Returns { before, after } where `before` is rows above the transcript and
	 * `after` is rows below it. Currently the transcript is always the first
	 * child, so `before` is always empty.
	 */
	renderAgentChrome(width: number): { before: string[]; after: string[] } {
		const before: string[] = [];
		const after: string[] = [];

		if (this.#mode === "full-term" && this.#terminalPane) {
			// In full-term mode, the agent pane is hidden — no chrome to render.
			return { before, after };
		}

		// Render agent pane children except the transcript
		if (this.#agentPane instanceof Container) {
			for (const child of this.#agentPane.children) {
				if (child === this.#transcriptContainer) continue;
				after.push(...child.render(width));
			}
		} else {
			// Fallback: render the whole agent pane (includes transcript — degraded)
			after.push(...this.#agentPane.render(width));
		}

		return { before, after };
	}

	/**
	 * Render the agent pane bounded to a target height. Uses Container.render()
	 * (unbounded) and slices from the bottom to keep the editor + recent
	 * transcript visible. Scrolling is not supported in split modes (the
	 * composer's renderViewport path is bypassed) — this is the accepted MVP
	 * degradation. The terminal pane gets its allocated height; the agent pane
	 * gets the rest with the editor at the bottom.
	 */
	#renderAgentBounded(width: number, targetHeight: number): string[] {
		const lines = this.#agentPane.render(width);
		return lines.slice(-targetHeight);
	}

	#checkTerminalResize(cols: number, rows: number): void {
		if (!this.#terminalPane) return;
		// Approximate xterm cell count from pixel dimensions
		// The terminal pane's render() uses the xterm's own cols/rows,
		// but we need to tell it how many rows are available
		const effectiveCols = Math.max(1, cols - 2); // -2 for border
		const effectiveRows = Math.max(1, rows - 2); // -2 for top/bottom border (header removed)
		this.#terminalPane.checkResize(effectiveCols, effectiveRows);
	}

	/** Get terminal state for the agent bridge. */
	getTerminalState(): Readonly<TerminalState> | undefined {
		return this.#terminalPane?.getTerminalState();
	}

	/** Write to terminal pane (for agent bridge). */
	writeToTerminalPane(command: string, pressEnter = true): void {
		this.#terminalPane?.writeToShell(command + (pressEnter ? "\r" : ""));
	}

	/** Read terminal scrollback (for agent bridge). */
	readTerminalScrollback(opts: {
		lines?: number;
		offset?: number;
		amount?: number;
		force?: boolean;
	}): TerminalScrollbackResult | undefined {
		return this.#terminalPane?.readScrollback(opts);
	}

	/** Get the last command boundary (for ErrorAssist). */
	getLastBoundary(): CommandBoundary | undefined {
		return this.#terminalPane?.getLastBoundary();
	}

	get mode(): LayoutMode {
		return this.#mode;
	}

	get focus(): PaneFocus {
		return this.#focus;
	}

	get hasTerminalPane(): boolean {
		return this.#terminalPane !== undefined;
	}

	/** Expose the inner TranscriptContainer for Composer.renderFrame. */
	get transcriptContainer(): TranscriptContainer | undefined {
		return this.#transcriptContainer;
	}

	/** Expose the agent pane for Composer.renderFrame pre/after root rendering. */
	get agentPane(): Component {
		return this.#agentPane;
	}

	invalidate(): void {
		this.#terminalPane?.invalidate();
		this.#agentPane.invalidate?.();
	}

	/** Update the scrollback persistence reference (after session drop/reset). */
	updateScrollbackPersistence(sp: ScrollbackPersistence): void {
		this.#scrollbackPersistence = sp;
	}

	/** Flush screen to scrollback, kill terminal pane, reset to full-agent mode. */
	resetTerminal(): void {
		if (this.#scrollbackPersistence && this.#terminalPane) {
			this.#terminalPane.flushScreenToScrollback();
			this.#scrollbackPersistence.flushSync();
		}
		this.#terminalPane?.dispose();
		this.#terminalPane = undefined;
		this.#xtermReady = false;
		this.#setMode("full-agent");
		this.#focus = "agent";
		this.#syncEditorFocus();
		this.#onTerminalStateChange?.();
	}

	dispose(): void {
		if (this.#scrollbackPersistence && this.#terminalPane) {
			this.#terminalPane.flushScreenToScrollback();
			this.#scrollbackPersistence.flushSync();
		}
		this.#scrollbackPersistence?.close();
		this.#terminalPane?.dispose();
	}
}
