/**
 * Output accumulator for streaming command output.
 *
 * Incrementally tracks streaming output with bounded memory.
 * Keeps only a tail for display snapshots, and opens a temp file
 * when the full output needs to be preserved.
 *
 * This is a runtime-agnostic implementation that uses Uint8Array
 * instead of Node.js Buffer.
 */

import { utf8ByteLength } from "../../../utils/bytes.js";

// ============================================================================
// Constants
// ============================================================================

/** Maximum number of lines to keep in memory */
const DEFAULT_MAX_LINES = 2000;

/** Maximum bytes to keep in memory */
const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

/** Rolling buffer size multiplier */
const MAX_ROLLING_BYTES_MULTIPLIER = 2;

// ============================================================================
// Types
// ============================================================================

export interface OutputAccumulatorOptions {
  maxLines?: number;
  maxBytes?: number;
}

export interface OutputSnapshot {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
}

// ============================================================================
// Helpers
// ============================================================================

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split("\n");
  if (content.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function truncateTail(
  content: string,
  maxLines: number,
  maxBytes: number
): {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  outputLines: number;
  outputBytes: number;
} {
  const totalBytes = utf8ByteLength(content);
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      outputLines: totalLines,
      outputBytes: totalBytes,
    };
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
    const line = lines[i];
    const lineBytes = utf8ByteLength(line) + (outputLinesArr.length > 0 ? 1 : 0);

    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }

    outputLinesArr.unshift(line);
    outputBytesCount += lineBytes;
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = "lines";
  }

  return {
    content: outputLinesArr.join("\n"),
    truncated: true,
    truncatedBy,
    outputLines: outputLinesArr.length,
    outputBytes: utf8ByteLength(outputLinesArr.join("\n")),
  };
}

// ============================================================================
// OutputAccumulator Class
// ============================================================================

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decoded chunks, keeps only a decoded tail for display snapshots.
 * This is a runtime-agnostic implementation that doesn't depend on Node.js APIs.
 */
export class OutputAccumulator {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly maxRollingBytes: number;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  private tailText = "";
  private tailBytes = 0;
  private tailStartsAtLineBoundary = true;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private totalLines = 0;
  private currentLineBytes = 0;
  private hasOpenLine = false;
  private finished = false;

  constructor(options: OutputAccumulatorOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRollingBytes = Math.max(this.maxBytes * MAX_ROLLING_BYTES_MULTIPLIER, 1);
  }

  /**
   * Append a chunk of data to the accumulator.
   */
  append(data: Uint8Array): void {
    if (this.finished) {
      return;
      // throw new Error("Cannot append to a finished output accumulator");
    }

    this.totalDecodedBytes += data.byteLength;
    this.appendDecodedText(this.decoder.decode(data, { stream: true }));
  }

  /**
   * Mark the output as finished and flush any remaining data.
   */
  finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.appendDecodedText(this.decoder.decode());
  }

  /**
   * Get a snapshot of the current output.
   */
  snapshot(): OutputSnapshot {
    const tailTruncation = truncateTail(this.getSnapshotText(), this.maxLines, this.maxBytes);
    const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
    const truncatedBy = truncated
      ? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
      : null;

    return {
      content: tailTruncation.content,
      truncated,
      truncatedBy,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      outputLines: tailTruncation.outputLines,
      outputBytes: tailTruncation.outputBytes,
    };
  }

  private appendDecodedText(text: string): void {
    if (text.length === 0) {
      return;
    }

    const bytes = utf8ByteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > this.maxRollingBytes * 2) {
      this.trimTail();
    }

    let newlines = 0;
    let lastNewline = -1;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      newlines++;
      lastNewline = i;
    }
    if (newlines === 0) {
      this.currentLineBytes += bytes;
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      const tail = text.slice(lastNewline + 1);
      this.currentLineBytes = utf8ByteLength(tail);
      this.hasOpenLine = tail.length > 0;
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  private trimTail(): void {
    const encoded = this.encoder.encode(this.tailText);
    if (encoded.byteLength <= this.maxRollingBytes) {
      this.tailBytes = encoded.byteLength;
      return;
    }

    let start = encoded.byteLength - this.maxRollingBytes;
    while (start < encoded.byteLength && (encoded[start] & 0xc0) === 0x80) {
      start++;
    }

    this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : encoded[start - 1] === 0x0a;
    this.tailText = new TextDecoder().decode(encoded.subarray(start));
    this.tailBytes = utf8ByteLength(this.tailText);
  }

  private getSnapshotText(): string {
    if (this.tailStartsAtLineBoundary) {
      return this.tailText;
    }

    const firstNewline = this.tailText.indexOf("\n");
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  }
}
