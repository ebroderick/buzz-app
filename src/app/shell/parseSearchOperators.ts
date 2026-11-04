/**
 * Parse Slack-style search operators out of a free-text query.
 *
 * Remaining text is the FTS / prefix query. Invalid operator tokens (for example
 * `after:soon`) are left in the text so they still participate in FTS.
 *
 * Name resolution for `from:` / `in:` happens at the call site (autocomplete or
 * local channel/user lists). This module only splits syntax.
 *
 * Operators must start at a token boundary (start of string or whitespace). A
 * word-boundary `\b` is intentionally avoided: it also matches after `-` / `/`,
 * which would turn `built-in:react` or `https://x.com/in:foo` into operators.
 */

export type ParsedSearchOperators = {
  /** FTS / prefix query with operators removed. */
  text: string;
  /** Raw `from:` value (pubkey hex, npub, @name, `me`, …), if present. */
  from: string | null;
  /** Raw `in:` value (channel uuid, #name, @person, …), if present. */
  in: string | null;
  /**
   * Inclusive lower bound (unix seconds) from `after:`, `on:` and `during:`:
   * the local start of the named day or period. Several bounds intersect.
   */
  since: number | null;
  /**
   * Inclusive upper bound (unix seconds) from `before:`, `on:` and `during:`.
   * NIP-01 `until` is inclusive, so it is one second before the local start of
   * `before:`'s day or of the day after an `on:`/`during:` period: the named
   * `before:` day itself is not included (Slack-compatible).
   */
  until: number | null;
};

/** Token-start only — not `\b`, which fires after hyphens and slashes. */
const OPERATOR_RE = /(?:^|\s)(from|in|after|before|on|during):(\S+)/gi;

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** Local `[start, end)` of a calendar period, in unix seconds. */
function period(year: number, month: number, day?: number) {
  const start = new Date(year, month, day ?? 1);
  const end =
    day === undefined
      ? new Date(year, month + 1, 1)
      : new Date(year, month, day + 1);
  return {
    start: Math.floor(start.getTime() / 1000),
    end: Math.floor(end.getTime() / 1000),
  };
}

/**
 * The local period a date value names: `YYYY-MM-DD`, `today` or `yesterday`;
 * with `periods`, also `YYYY-MM`, `YYYY` and a month name or its first three
 * letters (its latest occurrence that has started). Anything else is null.
 */
function parseDateValue(value: string, periods: boolean, now: Date) {
  const lower = value.toLowerCase();
  if (lower === "today" || lower === "yesterday")
    return period(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - (lower === "yesterday" ? 1 : 0),
    );
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (match) {
    const year = Number(match[1]);
    // `Date` reads years below 100 as 19xx.
    if (year < 100) return null;
    const month = match[2] === undefined ? undefined : Number(match[2]) - 1;
    const day = match[3] === undefined ? undefined : Number(match[3]);
    if (day === undefined && !periods) return null;
    if (month === undefined)
      return { start: period(year, 0).start, end: period(year + 1, 0).start };
    if (month < 0 || month > 11) return null;
    if (day === undefined) return period(year, month);
    const date = new Date(year, month, day);
    if (date.getMonth() !== month || date.getDate() !== day) return null;
    return period(year, month, day);
  }
  const month = periods
    ? MONTHS.findIndex(
        (name) =>
          name === lower || (lower.length === 3 && name.startsWith(lower)),
      )
    : -1;
  if (month < 0) return null;
  return period(now.getFullYear() - (month > now.getMonth() ? 1 : 0), month);
}

/**
 * Matches of the global `pattern`, each starting at a token boundary, whose
 * token is outside quotes: quoted text is a phrase, never an operator. An
 * unclosed quote runs to the end.
 */
export function operatorMatches(raw: string, pattern: RegExp) {
  return [...raw.matchAll(pattern)].filter((match) => {
    const start =
      (match.index ?? 0) + match[0].length - match[0].trimStart().length;
    let open = false;
    for (let i = 0; i < start; i++) if (raw[i] === '"') open = !open;
    return !open;
  });
}

/** Drop trailing punctuation so `in:general,` still resolves to `general`. */
function cleanOperatorValue(value: string): string {
  return value.replace(/[.,;:!?]+$/g, "");
}

/**
 * Extract `from:` / `in:` / `after:` / `before:` / `on:` / `during:`
 * operators from `raw`, with dates in `now`'s local timezone.
 *
 * Later `from:` / `in:` occurrences win; date bounds intersect. Date operators
 * whose value is not a recognized date, and operators inside quotes, stay in
 * the returned `text`.
 *
 * Multi-word handles (`from:@Will Pfleger`) are a known limitation: only the
 * first whitespace-delimited token is captured.
 */
export function parseSearchOperators(
  raw: string,
  now = new Date(),
): ParsedSearchOperators {
  let from: string | null = null;
  let inValue: string | null = null;
  let since: number | null = null;
  let until: number | null = null;

  const kept: string[] = [];
  let lastIndex = 0;

  for (const match of operatorMatches(raw, OPERATOR_RE)) {
    const index = match.index ?? 0;
    kept.push(raw.slice(lastIndex, index));
    lastIndex = index + match[0].length;

    const kind = match[1]?.toLowerCase();
    const value = cleanOperatorValue(match[2] ?? "");

    if (kind === "from") {
      from = value;
      continue;
    }
    if (kind === "in") {
      inValue = value;
      continue;
    }
    const range = parseDateValue(value, kind === "during", now);
    if (!range) {
      kept.push(match[0]);
      continue;
    }
    if (kind !== "before") since = Math.max(since ?? range.start, range.start);
    const end = (kind === "before" ? range.start : range.end) - 1;
    if (kind !== "after") until = Math.min(until ?? end, end);
  }

  kept.push(raw.slice(lastIndex));

  return {
    text: kept.join("").replace(/\s+/g, " ").trim(),
    from,
    in: inValue,
    since,
    until,
  };
}

const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

/**
 * How free text is searched, following the relay's web search syntax
 * (Postgres `websearch_to_tsquery`). A closed `"exact phrase"` or a `-word`
 * exclusion needs full-text search; other text is a typeahead prefix search.
 * `positive` says whether there is a word or phrase to look for, not only
 * exclusions, which would match nearly everything.
 *
 * As in web search, every `"` opens or closes a phrase, even inside a word,
 * and an unclosed one runs to the end. A `-` at the start of a word or phrase
 * (after a space, the start or a closing quote), or alone before one,
 * excludes it. Inside quotes,
 * `-` and `or` are words; outside, `or` between two terms means either.
 */
export function searchTextSyntax(text: string) {
  let fullText = false;
  const terms: { negated: boolean; or: boolean }[] = [];
  const parts = text.split('"');
  let negateNext = false;
  parts.forEach((part, index) => {
    if (index % 2) {
      const phrase = WORD_CHAR_RE.test(part);
      if (phrase && index < parts.length - 1) fullText = true;
      if (phrase) terms.push({ negated: negateNext, or: false });
      negateNext = false;
      return;
    }
    for (const word of part.split(/\s+/)) {
      if (!word) continue;
      // A lone `-` excludes the next word or phrase, across spaces.
      if (word === "-") {
        negateNext = true;
        continue;
      }
      if (!WORD_CHAR_RE.test(word)) {
        negateNext = false;
        continue;
      }
      // Each leading `-` negates once, as in Postgres: `-@staging` excludes,
      // `--help` is two negations, so it is still searched for.
      const minuses = (word.match(/^-*/)?.[0].length ?? 0) + Number(negateNext);
      const negated = minuses % 2 === 1;
      negateNext = false;
      if (negated) fullText = true;
      terms.push({ negated, or: !negated && word.toLowerCase() === "or" });
    }
  });
  const positive = terms.some(
    (term, index) =>
      !term.negated && (!term.or || index === 0 || index === terms.length - 1),
  );
  return { fullText, positive };
}

/** True when `value` names the signed-in viewer (`me` / `@me`). */
export function isViewerHandle(value: string): boolean {
  return normalizeFromHandle(value).toLowerCase() === "me";
}

const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a 64-char hex pubkey (optional `0x` rejected). */
export function isHexPubkey(value: string): boolean {
  return HEX_PUBKEY_RE.test(value);
}

/** Strip a leading `@` from a `from:` value. */
export function normalizeFromHandle(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

/** Strip a leading `#` from an `in:` value; a bare `@` names nobody yet. */
export function normalizeInChannel(value: string): string {
  return value === "@" ? "" : value.startsWith("#") ? value.slice(1) : value;
}

/** True when `value` is a channel UUID. */
export function isChannelUuid(value: string): boolean {
  return UUID_RE.test(value);
}
