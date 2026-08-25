/** Cell rendition tracked by the virtual terminal. */
export interface CellAttributes {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
	strikethrough: boolean;
	overline: boolean;
	fgMode: 0 | 1 | 2;
	fg: number;
	bgMode: 0 | 1 | 2;
	bg: number;
}

/** A mutable terminal grid cell. */
export interface CellData {
	chars: string;
	width: number;
	attrs: CellAttributes;
}

/** Creates the default rendition. */
export function defaultAttributes(): CellAttributes {
	return {
		bold: false,
		dim: false,
		italic: false,
		underline: false,
		inverse: false,
		strikethrough: false,
		overline: false,
		fgMode: 0,
		fg: 0,
		bgMode: 0,
		bg: 0,
	};
}

function cloneAttributes(attrs: CellAttributes): CellAttributes {
	return { ...attrs };
}

/** Creates an empty cell with the supplied rendition. */
export function blankCell(attrs: CellAttributes = defaultAttributes()): CellData {
	return { chars: "", width: 1, attrs: cloneAttributes(attrs) };
}

/** Proposed xterm-compatible cell readback object. */
export class BufferCell {
	#cell: CellData = blankCell();

	/** Reuses this object for another grid cell. */
	setFrom(cell: CellData): this {
		this.#cell = cell;
		return this;
	}

	/** Returns the grapheme stored in this cell. */
	getChars(): string {
		return this.#cell.chars;
	}

	/** Returns the cell width, with zero denoting a wide-cell continuation. */
	getWidth(): number {
		return this.#cell.width;
	}

	/** Returns the packed foreground palette index or RGB value. */
	getFgColor(): number {
		return this.#cell.attrs.fg;
	}

	/** Returns the packed background palette index or RGB value. */
	getBgColor(): number {
		return this.#cell.attrs.bg;
	}

	/** Reports bold rendition. */
	isBold(): number {
		return Number(this.#cell.attrs.bold);
	}

	/** Reports dim rendition. */
	isDim(): number {
		return Number(this.#cell.attrs.dim);
	}

	/** Reports italic rendition. */
	isItalic(): number {
		return Number(this.#cell.attrs.italic);
	}

	/** Reports underline rendition. */
	isUnderline(): number {
		return Number(this.#cell.attrs.underline);
	}

	/** Reports inverse rendition. */
	isInverse(): number {
		return Number(this.#cell.attrs.inverse);
	}

	/** Reports strikethrough rendition. */
	isStrikethrough(): number {
		return Number(this.#cell.attrs.strikethrough);
	}

	/** Reports overline rendition. */
	isOverline(): number {
		return Number(this.#cell.attrs.overline);
	}

	/** Reports a true-color foreground. */
	isFgRGB(): boolean {
		return this.#cell.attrs.fgMode === 2;
	}

	/** Reports a true-color background. */
	isBgRGB(): boolean {
		return this.#cell.attrs.bgMode === 2;
	}

	/** Reports a palette foreground. */
	isFgPalette(): boolean {
		return this.#cell.attrs.fgMode === 1;
	}

	/** Reports a palette background. */
	isBgPalette(): boolean {
		return this.#cell.attrs.bgMode === 1;
	}
}

/** One physical row in a terminal buffer. */
export class BufferLine {
	cells: CellData[];
	isWrapped = false;

	constructor(columns: number, attrs: CellAttributes = defaultAttributes()) {
		this.cells = Array.from({ length: columns }, () => blankCell(attrs));
	}

	/** Number of grid columns in the line. */
	get length(): number {
		return this.cells.length;
	}

	/** Reads a cell, optionally reusing the caller's object. */
	getCell(column: number, cell = new BufferCell()): BufferCell | undefined {
		const value = this.cells[column];
		return value ? cell.setFrom(value) : undefined;
	}

	/** Converts a column range to text. */
	translateToString(trimRight = false, startColumn = 0, endColumn = this.cells.length): string {
		const start = Math.max(0, startColumn);
		let end = Math.min(endColumn, this.cells.length);
		if (trimRight) {
			while (end > start && !this.cells[end - 1]!.chars) end--;
		}
		let text = "";
		for (let column = start; column < end; column++) {
			const cell = this.cells[column]!;
			if (cell.width !== 0) text += cell.chars || " ";
		}
		return text;
	}
}

/** Storage backing one terminal screen and its history. */
export interface BufferState {
	/** Immutable, append-only history. Lines stay at their original width. */
	scrollback: BufferLine[];
	/** Live viewport — exactly `rows` lines, mutable. Shell DL/IL/SU/SD operate here only. */
	screen: BufferLine[];
	cursorX: number;
	cursorY: number;
}

/** Public xterm-compatible view over a buffer state. */
export class BufferView {
	constructor(private readonly state: () => BufferState) {}

	/** Number of physical lines, including scrollback. */
	get length(): number {
		const s = this.state();
		return s.scrollback.length + s.screen.length;
	}

	/** First row of the live screen in the full buffer (= scrollback.length). */
	get baseY(): number {
		return this.state().scrollback.length;
	}

	/** First row currently exposed by the viewport (= scrollback.length, no viewport scroll for MVP). */
	get viewportY(): number {
		return this.state().scrollback.length;
	}

	/** Cursor column in the live screen. */
	get cursorX(): number {
		return this.state().cursorX;
	}

	/** Cursor row in the live screen. */
	get cursorY(): number {
		return this.state().cursorY;
	}

	/** Reads a physical buffer line (virtualized over [scrollback…][screen…]). */
	getLine(row: number): BufferLine | undefined {
		const s = this.state();
		return row < s.scrollback.length ? s.scrollback[row] : s.screen[row - s.scrollback.length];
	}

	/** Creates a reusable empty cell readback object. */
	getNullCell(): BufferCell {
		return new BufferCell();
	}
}

// ── Serialization ─────────────────────────────────────────────────────────

function attrsAreDefault(a: CellAttributes): boolean {
	return (
		a.bold === false &&
		a.dim === false &&
		a.italic === false &&
		a.underline === false &&
		a.inverse === false &&
		a.strikethrough === false &&
		a.overline === false &&
		a.fgMode === 0 &&
		a.fg === 0 &&
		a.bgMode === 0 &&
		a.bg === 0
	);
}

function encodeAttrs(a: CellAttributes): number[] {
	const out: number[] = [];
	let bools = 0;
	if (a.bold) bools |= 1;
	if (a.dim) bools |= 2;
	if (a.italic) bools |= 4;
	if (a.underline) bools |= 8;
	if (a.inverse) bools |= 16;
	if (a.strikethrough) bools |= 32;
	if (a.overline) bools |= 64;
	const hasCustomColors = a.fgMode !== 0 || a.fg !== 0 || a.bgMode !== 0 || a.bg !== 0;
	if (hasCustomColors) bools |= 128;
	out.push(bools);
	if (hasCustomColors) {
		out.push((a.fgMode << 4) | a.bgMode);
		writeVarint(out, a.fg);
		writeVarint(out, a.bg);
	}
	return out;
}

function decodeAttrs(data: Uint8Array, offset: number): { attrs: CellAttributes; next: number } {
	const bools = data[offset]!;
	const attrs = defaultAttributes();
	let next = offset + 1;
	attrs.bold = (bools & 1) !== 0;
	attrs.dim = (bools & 2) !== 0;
	attrs.italic = (bools & 4) !== 0;
	attrs.underline = (bools & 8) !== 0;
	attrs.inverse = (bools & 16) !== 0;
	attrs.strikethrough = (bools & 32) !== 0;
	attrs.overline = (bools & 64) !== 0;
	if (bools & 128) {
		const colorModes = data[next]!;
		next += 1;
		attrs.fgMode = (colorModes >> 4) as 0 | 1 | 2;
		attrs.bgMode = (colorModes & 0x0f) as 0 | 1 | 2;
		const fg = readVarint(data, next);
		attrs.fg = fg.value;
		next = fg.next;
		const bg = readVarint(data, next);
		attrs.bg = bg.value;
		next = bg.next;
	}
	return { attrs, next };
}

function writeVarint(out: number[], value: number): void {
	let v = value;
	while (v >= 0x80) {
		out.push((v & 0x7f) | 0x80);
		v >>>= 7;
	}
	out.push(v & 0x7f);
}

function readVarint(data: Uint8Array, offset: number): { value: number; next: number } {
	let result = 0;
	let shift = 0;
	let pos = offset;
	while (pos < data.length) {
		const byte = data[pos]!;
		pos += 1;
		result |= (byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return { value: result, next: pos };
		shift += 7;
	}
	return { value: result, next: pos };
}

const CELL_BLANK_DEFAULT = 0;
const CELL_BLANK_STYLED = 1;
const CELL_CONTENT_STYLED = 2;
const CELL_CONTENT_DEFAULT = 3;

/**
 * Encodes a BufferLine into a compact byte array using RLE for blank runs.
 * Width-agnostic — stores the actual cell count, not the column width.
 */
export function encodeBufferLine(line: BufferLine): Uint8Array {
	const out: number[] = [];
	out.push(line.isWrapped ? 1 : 0);
	writeVarint(out, line.cells.length);

	let i = 0;
	while (i < line.cells.length) {
		const cell = line.cells[i]!;
		const isBlank = cell.chars === "" && cell.width !== 0;
		const isDefault = attrsAreDefault(cell.attrs);

		if (isBlank && isDefault) {
			let runLen = 1;
			while (i + runLen < line.cells.length) {
				const next = line.cells[i + runLen]!;
				if (next.chars !== "" || next.width === 0 || !attrsAreDefault(next.attrs)) break;
				runLen++;
			}
			writeVarint(out, runLen);
			out.push(CELL_BLANK_DEFAULT);
			i += runLen;
		} else if (isBlank && !isDefault) {
			let runLen = 1;
			while (i + runLen < line.cells.length) {
				const next = line.cells[i + runLen]!;
				if (next.chars !== "" || next.width === 0) break;
				const na = next.attrs;
				if (
					na.bold !== cell.attrs.bold ||
					na.dim !== cell.attrs.dim ||
					na.italic !== cell.attrs.italic ||
					na.underline !== cell.attrs.underline ||
					na.inverse !== cell.attrs.inverse ||
					na.strikethrough !== cell.attrs.strikethrough ||
					na.overline !== cell.attrs.overline ||
					na.fgMode !== cell.attrs.fgMode ||
					na.fg !== cell.attrs.fg ||
					na.bgMode !== cell.attrs.bgMode ||
					na.bg !== cell.attrs.bg
				)
					break;
				runLen++;
			}
			writeVarint(out, runLen);
			out.push(CELL_BLANK_STYLED);
			for (const b of encodeAttrs(cell.attrs)) out.push(b);
			i += runLen;
		} else {
			writeVarint(out, 1);
			out.push(isDefault ? CELL_CONTENT_DEFAULT : CELL_CONTENT_STYLED);
			out.push(cell.width);
			const charsBytes = Buffer.from(cell.chars, "utf-8");
			writeVarint(out, charsBytes.length);
			for (const b of charsBytes) out.push(b);
			if (!isDefault) {
				for (const b of encodeAttrs(cell.attrs)) out.push(b);
			}
			i += 1;
		}
	}
	return Uint8Array.from(out);
}

/**
 * Decodes a BufferLine from a byte array at the given offset.
 * Returns the decoded line and the offset past the entry.
 */
export function decodeBufferLine(data: Uint8Array, offset: number): { line: BufferLine; next: number } {
	let pos = offset;
	const flags = data[pos]!;
	pos += 1;
	const cellCount = readVarint(data, pos);
	pos = cellCount.next;

	const line = new BufferLine(0);
	line.cells.length = 0;
	line.isWrapped = (flags & 1) !== 0;

	let decoded = 0;
	while (decoded < cellCount.value && pos < data.length) {
		const runLen = readVarint(data, pos);
		pos = runLen.next;
		const cellType = data[pos]!;
		pos += 1;

		if (cellType === CELL_BLANK_DEFAULT) {
			for (let r = 0; r < runLen.value; r++) line.cells.push(blankCell());
		} else if (cellType === CELL_BLANK_STYLED) {
			const { attrs, next } = decodeAttrs(data, pos);
			pos = next;
			for (let r = 0; r < runLen.value; r++) line.cells.push(blankCell({ ...attrs }));
		} else if (cellType === CELL_CONTENT_DEFAULT) {
			const width = data[pos]!;
			pos += 1;
			const charsLen = readVarint(data, pos);
			pos = charsLen.next;
			const chars = Buffer.from(data.subarray(pos, pos + charsLen.value)).toString("utf-8");
			pos += charsLen.value;
			line.cells.push({ chars, width, attrs: defaultAttributes() });
		} else if (cellType === CELL_CONTENT_STYLED) {
			const width = data[pos]!;
			pos += 1;
			const charsLen = readVarint(data, pos);
			pos = charsLen.next;
			const chars = Buffer.from(data.subarray(pos, pos + charsLen.value)).toString("utf-8");
			pos += charsLen.value;
			const { attrs, next } = decodeAttrs(data, pos);
			pos = next;
			line.cells.push({ chars, width, attrs });
		} else {
			break;
		}
		decoded += runLen.value;
	}
	return { line, next: pos };
}
