/**
 * ScrollbackPersistence — compressed append-only file for terminal scrollback,
 * stored as a sidecar in the session artifacts directory.
 *
 * Architecture:
 * - Lines are encoded with `encodeBufferLine()` (RLE + packed attrs) and
 *   appended one at a time as they scroll off screen (event-driven via
 *   `onScrollbackCommit`).
 * - Writes are buffered and flushed on a microtask — multiple scroll-off
 *   events in the same macrotask coalesce into one `writeSync`. The buffer
 *   never spans more than one microtask, so by the time `flushSync()` runs
 *   (shell exit / shutdown), pending data is already on disk or in the
 *   buffer (drained synchronously).
 * - A 32-byte header tracks logical ring buffer state (totalLines,
 *   firstOffset, writeOffset). Eviction advances firstOffset — the file
 *   grows monotonically, but `readAll()` only reads [firstOffset,
 *   writeOffset), so the logical cap is enforced. Periodic compaction
 *   reclaims evicted space when it exceeds 50% of the file.
 * - On resume, the file is read and decoded into BufferLine[] for
 *   `Terminal.restoreScrollback()`.
 * - CSI 3J (clear scrollback) truncates the file and resets the header.
 *
 * File format:
 *   [32-byte header]
 *   [entry: 4-byte len (LE) + encoded BufferLine bytes]...
 *   [evicted space — skipped by firstOffset]
 *   [active entries...]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type BufferLine, decodeBufferLine, encodeBufferLine } from "@oh-my-pi/pi-utils/vterm";

const MAGIC = 0x5342434f; // "SBCO" — Scrollback COntent
const VERSION = 1;
const HEADER_SIZE = 32;
const ENTRY_LEN_SIZE = 4;
const DEFAULT_CAP = 1000;
// Compact when evicted space exceeds this fraction of file size.
const COMPACT_THRESHOLD = 0.5;

interface Header {
	magic: number;
	version: number;
	cols: number;
	totalLines: number;
	firstOffset: number;
	writeOffset: number;
}

function writeHeader(buf: Buffer, h: Header): void {
	buf.writeUInt32LE(h.magic, 0);
	buf.writeUInt32LE(h.version, 4);
	buf.writeUInt32LE(h.cols, 8);
	buf.writeUInt32LE(h.totalLines, 12);
	buf.writeUInt32LE(h.firstOffset, 16);
	buf.writeUInt32LE(h.writeOffset, 20);
	// bytes 24-31 reserved
}

function readHeader(buf: Buffer): Header | null {
	if (buf.length < HEADER_SIZE) return null;
	const magic = buf.readUInt32LE(0);
	if (magic !== MAGIC) return null;
	return {
		magic,
		version: buf.readUInt32LE(4),
		cols: buf.readUInt32LE(8),
		totalLines: buf.readUInt32LE(12),
		firstOffset: buf.readUInt32LE(16),
		writeOffset: buf.readUInt32LE(20),
	};
}

export class ScrollbackPersistence {
	#filePath: string;
	#cap: number;
	#fd: number | undefined;
	#header: Header;
	#writeBuffer: Buffer[] = [];
	#flushScheduled = false;
	#closed = false;

	constructor(artifactsDir: string, cols: number, cap = DEFAULT_CAP) {
		this.#filePath = path.join(artifactsDir, "terminal-scrollback.bin");
		this.#cap = cap;
		this.#header = {
			magic: MAGIC,
			version: VERSION,
			cols,
			totalLines: 0,
			firstOffset: HEADER_SIZE,
			writeOffset: HEADER_SIZE,
		};
	}

	/** Opens the sidecar file for writing. Called lazily on first commit. */
	#ensureOpen(): void {
		if (this.#fd !== undefined) return;
		fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
		const exists = fs.existsSync(this.#filePath);
		this.#fd = fs.openSync(this.#filePath, exists ? "r+" : "w+");
		if (exists) {
			const stat = fs.fstatSync(this.#fd);
			if (stat.size >= HEADER_SIZE) {
				const headerBuf = Buffer.alloc(HEADER_SIZE);
				fs.readSync(this.#fd, headerBuf, 0, HEADER_SIZE, 0);
				const existing = readHeader(headerBuf);
				if (existing && existing.version === VERSION) {
					this.#header = existing;
				}
			} else {
				this.#writeHeaderSync();
			}
		} else {
			this.#writeHeaderSync();
		}
	}

	/** Opens the sidecar for reading (resume). No-op if already open. */
	open(): void {
		this.#ensureOpen();
	}

	/** Appends a scrollback line. Called per scroll-off event. */
	commit(line: BufferLine): void {
		if (this.#closed) return;
		if (this.#fd === undefined) this.#ensureOpen();
		if (this.#fd === undefined) return;
		const encoded = encodeBufferLine(line);
		const entry = Buffer.allocUnsafe(ENTRY_LEN_SIZE + encoded.length);
		entry.writeUInt32LE(encoded.length, 0);
		entry.set(encoded, ENTRY_LEN_SIZE);
		this.#writeBuffer.push(entry);
		this.#header.totalLines += 1;
		this.#scheduleFlush();
	}

	/** Clears all scrollback (CSI 3J). Truncates file and resets header. */
	clear(): void {
		if (this.#closed || this.#fd === undefined) return;
		this.#writeBuffer.length = 0;
		this.#flushScheduled = false;
		this.#header.totalLines = 0;
		this.#header.firstOffset = HEADER_SIZE;
		this.#header.writeOffset = HEADER_SIZE;
		fs.ftruncateSync(this.#fd, HEADER_SIZE);
		this.#writeHeaderSync();
	}

	/** Reads all scrollback lines from the file (for restore on resume). */
	readAll(): BufferLine[] {
		if (this.#fd === undefined) {
			if (!fs.existsSync(this.#filePath)) return [];
			this.#fd = fs.openSync(this.#filePath, "r+");
			const headerBuf = Buffer.alloc(HEADER_SIZE);
			fs.readSync(this.#fd, headerBuf, 0, HEADER_SIZE, 0);
			const existing = readHeader(headerBuf);
			if (!existing || existing.version !== VERSION) return [];
			this.#header = existing;
		}

		const lines: BufferLine[] = [];
		const stat = fs.fstatSync(this.#fd);
		if (stat.size <= HEADER_SIZE) return lines;

		const data = Buffer.alloc(stat.size);
		fs.readSync(this.#fd, data, 0, stat.size, 0);

		let offset = this.#header.firstOffset;
		let count = 0;
		const maxLines = Math.min(this.#header.totalLines, this.#cap);

		while (count < maxLines && offset + ENTRY_LEN_SIZE <= stat.size) {
			const entryLen = data.readUInt32LE(offset);
			if (offset + ENTRY_LEN_SIZE + entryLen > stat.size) break;
			const entryData = data.subarray(offset + ENTRY_LEN_SIZE, offset + ENTRY_LEN_SIZE + entryLen);
			try {
				const { line } = decodeBufferLine(entryData, 0);
				lines.push(line);
			} catch {
				break;
			}
			offset += ENTRY_LEN_SIZE + entryLen;
			count++;
		}

		return lines;
	}

	/** Schedules a buffered flush on the next microtask. */
	#scheduleFlush(): void {
		if (this.#flushScheduled) return;
		this.#flushScheduled = true;
		queueMicrotask(() => {
			this.#flushScheduled = false;
			this.#flush();
		});
	}

	/** Flushes the write buffer to disk synchronously. */
	#flush(): void {
		if (this.#writeBuffer.length === 0 || this.#fd === undefined) return;
		const combined = Buffer.concat(this.#writeBuffer);
		this.#writeBuffer = [];
		fs.writeSync(this.#fd, combined, 0, combined.length, this.#header.writeOffset);
		this.#header.writeOffset += combined.length;
		const excess = this.#header.totalLines - this.#cap;
		if (excess > 0) this.#evictOldest(excess);
		else this.#writeHeaderSync();
	}

	/** Evicts oldest entries by advancing firstOffset. */
	#evictOldest(count: number): void {
		if (this.#fd === undefined) return;
		const stat = fs.fstatSync(this.#fd);
		const data = Buffer.alloc(ENTRY_LEN_SIZE);
		let offset = this.#header.firstOffset;
		let evicted = 0;

		while (evicted < count && offset + ENTRY_LEN_SIZE <= stat.size) {
			fs.readSync(this.#fd, data, 0, ENTRY_LEN_SIZE, offset);
			const entryLen = data.readUInt32LE(0);
			offset += ENTRY_LEN_SIZE + entryLen;
			evicted++;
		}

		this.#header.firstOffset = offset;
		this.#header.totalLines -= evicted;
		this.#writeHeaderSync();

		// Compact if evicted space exceeds threshold of file size.
		const evictedSpace = this.#header.firstOffset - HEADER_SIZE;
		const activeSpace = this.#header.writeOffset - this.#header.firstOffset;
		if (evictedSpace > activeSpace * COMPACT_THRESHOLD) this.#compact();
	}

	/** Reclaims evicted space by rewriting active entries to the beginning. */
	#compact(): void {
		if (this.#fd === undefined) return;
		const stat = fs.fstatSync(this.#fd);
		if (this.#header.firstOffset <= HEADER_SIZE) return;

		// Read active region [firstOffset, writeOffset)
		const activeSize = this.#header.writeOffset - this.#header.firstOffset;
		if (activeSize <= 0) {
			// No active data — just truncate
			fs.ftruncateSync(this.#fd, HEADER_SIZE);
			this.#header.firstOffset = HEADER_SIZE;
			this.#header.writeOffset = HEADER_SIZE;
			this.#writeHeaderSync();
			return;
		}

		const active = Buffer.alloc(activeSize);
		fs.readSync(this.#fd, active, 0, activeSize, this.#header.firstOffset);

		// Write active data right after header
		fs.writeSync(this.#fd, active, 0, activeSize, HEADER_SIZE);
		fs.ftruncateSync(this.#fd, HEADER_SIZE + activeSize);

		this.#header.firstOffset = HEADER_SIZE;
		this.#header.writeOffset = HEADER_SIZE + activeSize;
		this.#writeHeaderSync();
	}

	#writeHeaderSync(): void {
		if (this.#fd === undefined) return;
		const headerBuf = Buffer.alloc(HEADER_SIZE);
		writeHeader(headerBuf, this.#header);
		fs.writeSync(this.#fd, headerBuf, 0, HEADER_SIZE, 0);
	}

	/** Flushes pending writes synchronously (for shutdown). */
	flushSync(): void {
		if (this.#fd === undefined || this.#closed) return;
		this.#flushScheduled = false;
		this.#flush();
		this.#writeHeaderSync();
	}

	/** Deletes the sidecar file (for deliberate exit without save). */
	delete(): void {
		this.close();
		try {
			fs.unlinkSync(this.#filePath);
		} catch {
			// File may not exist
		}
	}

	/** Closes the file handle. No further writes are possible. */
	close(): void {
		if (this.#fd !== undefined) {
			try {
				fs.closeSync(this.#fd);
			} catch {
				// Already closed
			}
			this.#fd = undefined;
		}
		this.#closed = true;
	}

	get filePath(): string {
		return this.#filePath;
	}

	get totalLines(): number {
		return this.#header.totalLines;
	}
}
