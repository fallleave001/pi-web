import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { SessionInfo } from "./types";

const MAX_FILES = 500;
const MAX_RESULTS = 30;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LINE_CHARS = 1024 * 1024;
const TIME_BUDGET_MS = 3000;

export interface SessionSearchResult {
  session: SessionInfo;
  entryId?: string;
  blockIndex: number;
  /** A title hit has no message entry to reveal. */
  titleMatch?: boolean;
  before: string;
  match: string;
  after: string;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
  truncated: boolean;
}

/** One text block of a message, with the index the viewer needs to reveal it. */
interface MessageTextBlock {
  blockIndex: number;
  text: string;
}

/** The searchable text of one message: every text block, in order. */
interface MessageText {
  entryId?: string;
  blocks: MessageTextBlock[];
}

/** How one session read ended, so a partial scan is reported instead of hidden. */
interface SessionScan {
  /** The read stopped short: an oversized line, the deadline, an abort, or a read error. */
  truncated: boolean;
  /** The file ended at MAX_FILE_BYTES, so its tail was never searched. */
  capped: boolean;
}

/** Streams a session's message text one message at a time; other entry types never match. */
async function* readMessageTexts(
  path: string,
  signal: AbortSignal,
  deadline: number,
  scan: SessionScan,
): AsyncGenerator<MessageText> {
  const stream = createReadStream(path, { encoding: "utf8", end: MAX_FILE_BYTES - 1, signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (signal.aborted || Date.now() >= deadline) {
        scan.truncated = true;
        return;
      }
      if (line.length > MAX_LINE_CHARS) {
        scan.truncated = true;
        continue;
      }
      let entry: { type?: unknown; id?: unknown; message?: { role?: unknown; content?: unknown } } | null = null;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== "message") continue;
      const role = entry.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const content = entry.message?.content;
      const raw = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
      const blocks: MessageTextBlock[] = [];
      raw.forEach((block: { type?: unknown; text?: unknown } | null, blockIndex: number) => {
        if (block?.type === "text" && typeof block.text === "string") blocks.push({ blockIndex, text: block.text });
      });
      if (!blocks.length) continue;
      yield { ...(typeof entry.id === "string" ? { entryId: entry.id } : {}), blocks };
    }
  } catch {
    // An interrupted read must not hide the rest of the session.
    scan.truncated = true;
  } finally {
    scan.capped = stream.bytesRead >= MAX_FILE_BYTES;
    lines.close();
    stream.destroy();
  }
}

// ponytail: scan recent files without an index; add indexing if measured latency warrants it.
export async function searchSessionContents(
  sessions: readonly SessionInfo[],
  query: string,
  requestSignal?: AbortSignal,
): Promise<SessionSearchResponse> {
  const response: SessionSearchResponse = { results: [], truncated: false };
  const needle = query.trim();
  if (!needle) return response;
  if (needle.length > 200) throw new RangeError("Search query exceeds 200 characters");
  // Escape every operator: this is literal search, with offsets in the original text.
  const matcher = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const deadline = Date.now() + TIME_BUDGET_MS;
  const timeout = AbortSignal.timeout(TIME_BUDGET_MS);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
  const candidates = sessions
    .filter((session) => !session.transient && session.path)
    .sort((a, b) => b.modified.localeCompare(a.modified));

  for (const [index, session] of candidates.entries()) {
    if (index >= MAX_FILES || response.results.length >= MAX_RESULTS || signal.aborted || Date.now() >= deadline) {
      response.truncated = true;
      break;
    }
    const scan: SessionScan = { truncated: false, capped: false };
    let found = false;
    try {
      for await (const message of readMessageTexts(session.path, signal, deadline, scan)) {
        const text = message.blocks.map((block) => block.text).join("\n");
        const match = matcher.exec(text);
        if (!match) continue;
        const start = match.index;
        const end = start + match[0].length;
        let blockOffset = 0;
        const matchedBlock = message.blocks.find((block) => {
          const blockEnd = blockOffset + block.text.length;
          blockOffset = blockEnd + 1;
          return start <= blockEnd;
        })!;
        response.results.push({
          session,
          ...(message.entryId !== undefined ? { entryId: message.entryId } : {}),
          blockIndex: matchedBlock.blockIndex,
          before: (start > 80 ? "..." : "") + text.slice(Math.max(0, start - 80), start).replace(/\s+/g, " ").trimStart(),
          match: match[0].replace(/\s+/g, " "),
          after: text.slice(end, end + 80).replace(/\s+/g, " ").trimEnd() + (end + 80 < text.length ? "..." : ""),
        });
        found = true;
        break;
      }
    } catch {
      // Missing/unreadable files and interrupted reads must not hide other results.
      scan.truncated = true;
    }
    if (scan.truncated || (!found && scan.capped)) response.truncated = true;
    // Preserve message navigation when both body and title match. The catalogue
    // already carries the displayed name (including session_info names), so a
    // title hit is a fallback only when the transcript has no match.
    if (!found && !signal.aborted && Date.now() < deadline) {
      const title = session.name || session.firstMessage || "";
      const titleHit = matcher.exec(title);
      if (titleHit) {
        response.results.push({
          session,
          blockIndex: 0,
          titleMatch: true,
          before: title.slice(0, titleHit.index),
          match: titleHit[0],
          after: title.slice(titleHit.index + titleHit[0].length),
        });
      }
    }
  }
  return response;
}
