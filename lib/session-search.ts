import { createReadStream } from "node:fs";
import { stat as statFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { SessionInfo } from "./types";

const MAX_FILES = 500;
const MAX_RESULTS = 30;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LINE_CHARS = 1024 * 1024;
const TIME_BUDGET_MS = 3000;
/**
 * Extracted text kept between queries, counted in UTF-16 code units: a non-Latin-1 character
 * takes two bytes of heap, so the reachable heap is about twice this bound. The scan itself
 * reads far more bytes than it keeps (763 MB of JSONL for 9.8 MB of text on one archive).
 */
const CACHE_TEXT_CHARS = 64 * 1024 * 1024;
/** PI_SESSION_SEARCH_CACHE=0 restores the plain scan, for comparing the two. */
const CACHE_ENABLED = process.env.PI_SESSION_SEARCH_CACHE !== "0";

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

interface CachedSession {
  mtimeMs: number;
  size: number;
  textChars: number;
  messages: MessageText[];
  /** The file is longer than MAX_FILE_BYTES; a query that finds nothing reports truncation. */
  capped: boolean;
}

interface SessionCache {
  /** Insertion order is the eviction order: the least recently used session goes first. */
  sessions: Map<string, CachedSession>;
  textChars: number;
}

// A dev rebuild re-evaluates this module, and the cache has to outlive that. The suffix
// changes whenever the cached shape does, so an old object is never read by new code.
const CACHE_SLOT = Symbol.for("pi-web.session-search-cache-v1");

function sessionCache(): SessionCache {
  const shared = globalThis as typeof globalThis & { [CACHE_SLOT]?: SessionCache };
  shared[CACHE_SLOT] ??= { sessions: new Map(), textChars: 0 };
  return shared[CACHE_SLOT];
}

function dropCached(path: string): void {
  const cache = sessionCache();
  const entry = cache.sessions.get(path);
  if (!entry) return;
  cache.sessions.delete(path);
  cache.textChars -= entry.textChars;
}

/** Drops sessions the current query would not have looked at: deleted files and the tail past MAX_FILES. */
function pruneCache(live: ReadonlySet<string>): void {
  if (!CACHE_ENABLED || !live.size) return;
  const cache = sessionCache();
  for (const path of cache.sessions.keys()) if (!live.has(path)) dropCached(path);
}

/**
 * A cached session, but only while the file still has the size and mtime it was read
 * with: a session file is appended to, never rewritten in place. A same-size rewrite that
 * also restored the mtime would keep the old text; that is not something this app writes,
 * and detecting it would cost a content hash on every query. A hit moves the entry to the
 * end of the eviction order.
 */
function cachedMessages(path: string, mtimeMs: number, size: number): MessageText[] | undefined {
  const cache = sessionCache();
  const entry = cache.sessions.get(path);
  if (!entry) return undefined;
  if (entry.mtimeMs !== mtimeMs || entry.size !== size) {
    dropCached(path);
    return undefined;
  }
  cache.sessions.delete(path);
  cache.sessions.set(path, entry);
  return entry.messages;
}

function rememberMessages(path: string, mtimeMs: number, size: number, messages: MessageText[], capped: boolean): void {
  const cache = sessionCache();
  dropCached(path);
  const textChars = messages.reduce((total, message) => total + message.blocks.reduce((n, block) => n + block.text.length, 0), 0);
  cache.sessions.set(path, { mtimeMs, size, textChars, messages, capped });
  cache.textChars += textChars;
  // Sessions arrive newest first, so the oldest entry is the one least likely to be searched.
  for (const oldest of cache.sessions.keys()) {
    if (cache.textChars <= CACHE_TEXT_CHARS || cache.sessions.size === 1) break;
    dropCached(oldest);
  }
}

/** The stat a cache entry must match; undefined when the file is gone. */
async function statForCache(path: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const stat = await statFile(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
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
  const scoped = candidates.slice(0, MAX_FILES);
  pruneCache(new Set(scoped.map((session) => session.path)));
  if (candidates.length > scoped.length) response.truncated = true;

  for (const session of scoped) {
    if (response.results.length >= MAX_RESULTS || signal.aborted || Date.now() >= deadline) {
      response.truncated = true;
      break;
    }
    let found = false;
    // A cache hit is only trusted while the file keeps the size and mtime it was read with,
    // so the stat happens first and a file that changed is simply read again.
    let messages: MessageText[] | undefined;
    let tailUnread = false;
    if (CACHE_ENABLED) {
      const cache = sessionCache();
      if (cache.sessions.has(session.path)) {
        const stat = await statForCache(session.path);
        if (!stat) {
          // Gone from disk: fall through to the read, which reports it the way it always did.
          dropCached(session.path);
        } else {
          const entry = cache.sessions.get(session.path);
          const hit = cachedMessages(session.path, stat.mtimeMs, stat.size);
          if (hit) {
            messages = hit;
            tailUnread = entry?.capped ?? false;
          }
        }
      }
    }

    if (messages) {
      for (const message of messages) {
        if (signal.aborted || Date.now() >= deadline) {
          response.truncated = true;
          break;
        }
        if (matchMessage(message, matcher, session, response)) {
          found = true;
          break;
        }
      }
    } else {
      const scan: SessionScan = { truncated: false, capped: false };
      const collected: MessageText[] = [];
      // The stat has to come before the read: a session file only ever grows, so a file
      // appended to while it is read must be stored under the older key and re-read next
      // time, never under the newer one with its last messages missing.
      const before = CACHE_ENABLED ? await statForCache(session.path) : undefined;
      try {
        for await (const message of readMessageTexts(session.path, signal, deadline, scan)) {
          if (CACHE_ENABLED) collected.push(message);
          if (matchMessage(message, matcher, session, response)) {
            found = true;
            break;
          }
        }
      } catch {
        // Missing/unreadable files and interrupted reads must not hide other results.
        scan.truncated = true;
      }
      if (scan.truncated) response.truncated = true;
      tailUnread = scan.capped;
      // Only a file read to its end is worth keeping. Every early exit of the reader — the
      // deadline, an abort, a read error, an oversized line — sets scan.truncated, and a
      // match stops the read before the end; anything else is a complete file.
      if (CACHE_ENABLED && before && !found && !scan.truncated) {
        rememberMessages(session.path, before.mtimeMs, before.size, collected, scan.capped);
      }
    }
    // A file cut at MAX_FILE_BYTES only means the answer is partial when nothing matched
    // inside the bytes that were read, which is how the plain scan reports it too.
    if (!found && tailUnread) response.truncated = true;
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

/** Appends the first match of one message, with the block the viewer must reveal. */
function matchMessage(message: MessageText, matcher: RegExp, session: SessionInfo, response: SessionSearchResponse): boolean {
  const text = message.blocks.map((block) => block.text).join("\n");
  const match = matcher.exec(text);
  if (!match) return false;
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
  return true;
}
