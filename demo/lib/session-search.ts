import { createReadStream } from "node:fs";
import { stat as statFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { SessionInfo } from "./types";

const MAX_FILES = 500;
const MAX_RESULTS = 30;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LINE_CHARS = 1024 * 1024;
/** Bound on one result's snippet, including margins and any appended excerpts. */
const MAX_SNIPPET_CHARS = 200;
/** Past this many terms the per-message width expansion turns quadratic; search the whole query literally. */
const MAX_TERMS = 8;
/** Anchor margin of a multi-term query: it keeps room for terms found in other messages. */
const MULTI_TERM_MARGIN = 40;
/** Excerpt sizes tried in order, largest first, for a term outside the anchor's window. */
const EXCERPT_SIZES = [30, 20, 12] as const;
/** Room kept free for the " … (+N)" tail counting terms that no longer fit. */
const OMITTED_MARK_RESERVE = 10;
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
  /**
   * Every term's highlight, as offsets into `before + match + after`, so an AND
   * query marks each of its words instead of only the first one. Overlapping
   * terms are merged; a term that only occurs outside the snippet window has no
   * range. Absent means "just `match`", which is what older payloads implied.
   */
  highlights?: HighlightRange[];
}

/** One term's first hit; the snippet and its ranges are assembled from these. */
type TermHit = Omit<SessionSearchResult, "session" | "titleMatch" | "highlights">;

export interface HighlightRange {
  start: number;
  end: number;
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

// Slicing by UTF-16 index can cut a surrogate pair in half, which renders as a
// replacement character; move the boundary out of the pair.
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function head(text: string, length: number): string {
  if (text.length <= length) return text;
  return text.slice(0, isLowSurrogate(text.charCodeAt(length)) ? length - 1 : length);
}

function tail(text: string, length: number): string {
  const start = text.length - length;
  if (start <= 0) return text;
  return text.slice(isLowSurrogate(text.charCodeAt(start)) ? start - 1 : start);
}

// One range per term: the primary hit for the first term, its earliest occurrence
// for the rest. Sorted and merged so overlapping terms paint a single mark.
function highlightRanges(before: string, match: string, after: string, matchers: readonly RegExp[]): HighlightRange[] {
  const text = before + match + after;
  const ranges: HighlightRange[] = [{ start: before.length, end: before.length + match.length }];
  for (const matcher of matchers.slice(1)) {
    const hit = matcher.exec(text);
    if (hit) ranges.push({ start: hit.index, end: hit.index + hit[0].length });
  }
  ranges.sort((left, right) => left.start - right.start);
  const merged: HighlightRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

// Space separates terms and every term must match somewhere in the session
// (session-level AND, any order); double quotes keep a phrase exact. Each term
// stays literal, so `C++` and `foo(bar)` need no escaping from the user.
// A quote only delimits a phrase at the start of a term or to close one, so a
// quote inside a word (`foo"bar`) stays literal and stays searchable.
function parseTerms(query: string): string[] {
  const terms: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of query) {
    if (char === '"') {
      if (quoted) {
        if (current) terms.push(current);
        current = "";
        quoted = false;
        continue;
      }
      if (!current) {
        quoted = true;
        continue;
      }
    }
    if (!quoted && /\s/.test(char)) {
      if (current) terms.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) terms.push(current);
  return terms;
}

/** Escapes every operator: this is literal search, with offsets in the original text. */
function literalMatcher(term: string): RegExp {
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

/**
 * Fills in the first hit of every term this message still needs, and reports whether
 * the session now has one for each of them: terms may sit on different lines.
 */
function collectMessageHits(message: MessageText, matchers: readonly RegExp[], hits: Array<TermHit | undefined>): boolean {
  const text = message.blocks.map((block) => block.text).join("\n");
  for (const [termIndex, matcher] of matchers.entries()) {
    if (hits[termIndex]) continue;
    const match = matcher.exec(text);
    if (!match) continue;
    const anchorStart = match.index;
    const anchorEnd = anchorStart + match[0].length;
    // Widen around the anchor to the other terms of this message, so a
    // two-word query usually shows two marks instead of one. Bounded: a
    // couple of far-apart hits must not turn the row into a paragraph.
    let spanStart = anchorStart;
    let spanEnd = anchorEnd;
    for (const other of matchers) {
      const hit = other.exec(text);
      if (!hit) continue;
      spanStart = Math.min(spanStart, hit.index);
      spanEnd = Math.max(spanEnd, hit.index + hit[0].length);
    }
    // Prefer the historical 80/80 margins; tighten them only when a long term
    // or a wide span would push the row past MAX_SNIPPET_CHARS ("..." costs six
    // characters). A single term never widens, so it keeps the old window.
    const span = spanEnd - spanStart;
    const needsWiden = spanStart < anchorStart || spanEnd > anchorEnd;
    const marginWithin = (contentLength: number) =>
      Math.max(0, Math.min(80, Math.floor((MAX_SNIPPET_CHARS - contentLength - 6) / 2)));
    const widenMargin = marginWithin(span);
    const widened = needsWiden && widenMargin >= 20;
    const baseMargin = widened ? widenMargin : marginWithin(match[0].length);
    // A multi-term query whose other terms sit in another message still has to
    // fit their excerpts; a single term keeps the historical 80/80 window.
    const margin = widened || matchers.length === 1 ? baseMargin : Math.min(baseMargin, MULTI_TERM_MARGIN);
    const start = Math.max(0, (widened ? spanStart : anchorStart) - margin);
    const end = Math.min(text.length, (widened ? spanEnd : anchorEnd) + margin);
    let blockOffset = 0;
    const matchedBlock = message.blocks.find((block) => {
      const blockEnd = blockOffset + block.text.length;
      blockOffset = blockEnd + 1;
      return anchorStart <= blockEnd;
    })!;
    // Keep window boundaries out of surrogate pairs as well.
    const safeStart = isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start;
    const safeEnd = end < text.length && isLowSurrogate(text.charCodeAt(end)) ? end - 1 : end;
    const before = (safeStart > 0 ? "..." : "") + text.slice(safeStart, anchorStart).replace(/\s+/g, " ").trimStart();
    const matchText = match[0].replace(/\s+/g, " ");
    const after = text.slice(anchorEnd, safeEnd).replace(/\s+/g, " ").trimEnd() + (safeEnd < text.length ? "..." : "");
    hits[termIndex] = {
      ...(message.entryId !== undefined ? { entryId: message.entryId } : {}),
      blockIndex: matchedBlock.blockIndex,
      before,
      match: matchText,
      after,
    };
  }
  return hits.every((hit) => hit !== undefined);
}

/**
 * The row is anchored on the first term's earliest hit (for a single term that is
 * exactly the previous behaviour), then grows an excerpt for every term that hit
 * nowhere inside it — typically a word from another message.
 */
function assembleResult(session: SessionInfo, hits: readonly TermHit[], matchers: readonly RegExp[]): SessionSearchResult {
  const primary = hits[0];
  const before = primary.before;
  const matchText = primary.match;
  let after = primary.after;
  const snippet = () => before + matchText + after;
  let omitted = 0;
  for (let index = 1; index < hits.length; index++) {
    const hit = hits[index];
    if (matchers[index].test(snippet())) continue;
    // Shrink the excerpt before dropping it: a silent drop makes a two-word query
    // look like a one-word one and hides why the session matched at all.
    let appended = false;
    for (const size of EXCERPT_SIZES) {
      // No leading ellipsis: the separator already marks the gap in front of it.
      const excerpt =
        tail(hit.before, size) + hit.match + head(hit.after, size) +
        (hit.after.length > size ? "..." : "");
      // Drop the anchor's trailing ellipsis: the separator already marks the gap in front of it.
      const base = after.endsWith("...") ? after.slice(0, -3) : after;
      const joined = base + " … " + excerpt;
      if (before.length + matchText.length + joined.length > MAX_SNIPPET_CHARS - OMITTED_MARK_RESERVE) continue;
      after = joined;
      appended = true;
      break;
    }
    if (!appended) omitted += 1;
  }
  // Count what no longer fits, so a row never pretends every term is visible.
  if (omitted) {
    const base = after.endsWith("...") ? after.slice(0, -3) : after;
    after = base + ` … (+${omitted})`;
  }
  // Ranges are recomputed over the assembled snippet so the appended excerpts
  // are marked like the anchor.
  return { session, ...primary, before, match: matchText, after, highlights: highlightRanges(before, matchText, after, matchers) };
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
  const parsed = parseTerms(needle);
  // A query of only quotes, e.g. `""`, parses to no term at all and a pathological one
  // can parse to dozens; both fall back to the whole string as a single literal term,
  // which is exactly the search this change must never narrow.
  const terms = parsed.length && parsed.length <= MAX_TERMS ? parsed : [needle];
  const matchers = terms.map(literalMatcher);
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
    // First hit per term; a session qualifies once every term has one.
    const hits: Array<TermHit | undefined> = matchers.map(() => undefined);
    let found = false;
    let tailUnread = false;
    // A cache hit is only trusted while the file keeps the size and mtime it was read with,
    // so the stat happens first and a file that changed is simply read again.
    let messages: MessageText[] | undefined;
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
        if (collectMessageHits(message, matchers, hits)) {
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
          if (collectMessageHits(message, matchers, hits)) {
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
    if (found) response.results.push(assembleResult(session, hits as TermHit[], matchers));
    // A file cut at MAX_FILE_BYTES only means the answer is partial when nothing matched
    // inside the bytes that were read, which is how the plain scan reports it too.
    if (!found && tailUnread) response.truncated = true;
    // Preserve message navigation when both body and title match. The catalogue
    // already carries the displayed name (including session_info names), so a
    // title hit is a fallback only when the transcript has no match.
    if (!found && !signal.aborted && Date.now() < deadline) {
      const title = session.name || session.firstMessage || "";
      // Every term has to be in the title; highlighting one of them alone would
      // make the result look like a partial match.
      const titleHit = matchers.every((matcher) => matcher.test(title)) ? matchers[0].exec(title) : null;
      if (titleHit) {
        const before = title.slice(0, titleHit.index);
        const matchText = titleHit[0];
        const after = title.slice(titleHit.index + titleHit[0].length);
        response.results.push({
          session,
          blockIndex: 0,
          titleMatch: true,
          before,
          match: matchText,
          after,
          highlights: highlightRanges(before, matchText, after, matchers),
        });
      }
    }
  }
  return response;
}
