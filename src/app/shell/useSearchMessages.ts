import { workflowOwner } from "../../features/relay/workflow-attribution";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  messageSearchable,
  searchDebounce,
} from "../../shared/search-debounce";
import { objectBody } from "../../features/relay/body";
import type { RelaySession } from "../../features/relay/session";
import type { ReadFilter } from "../../features/relay/events";
import { foldProfiles } from "../../features/relay/profiles";
import { normalizeName } from "../../features/search/person-match";
import {
  isHexPubkey,
  isViewerHandle,
  normalizeFromHandle,
  normalizeInChannel,
  operatorMatches,
  parseSearchOperators,
  searchTextSyntax,
} from "./parseSearchOperators";

const noAgentNames: ReadonlyMap<string, string> = new Map();
const PAGE_SIZE = 20;

export type SearchSort = "relevance" | "newest";

export type SearchMessage = Readonly<{
  id: string;
  channelId: string;
  authorId: string;
  workflowOwnerId?: string | undefined;
  createdAt: number;
  preview: string;
}>;
type Result = {
  owner: object;
  messages: readonly SearchMessage[];
  error?: string;
  ambiguousAuthor?: boolean;
  /** The resolved filter and the page that follows, while one may exist. */
  next?: { filter: ReadFilter; page: number };
  loadingMore?: boolean;
  moreError?: string;
};

/** One relay page of hits, mapped to messages, and whether another may follow. */
async function readPage(
  session: RelaySession,
  channelId: string | null | undefined,
  filter: ReadFilter,
  page: number,
  signal: AbortSignal,
) {
  // Revalidate public previews on every scoped read. Joined members are
  // skipped by resolve; a retained public preview is not live authority.
  if (channelId)
    await session.channels.resolve?.([channelId], {
      signal,
      priority: "foreground",
    });
  if (channelId && !session.channels.get?.(channelId))
    return { messages: [], more: false };
  const { events, relayCount } = await session.readPage(
    [page > 1 ? { ...filter, page } : filter],
    { signal, priority: "foreground", fresh: true },
  );
  signal.throwIfAborted();
  const messages = events.flatMap((event): SearchMessage[] => {
    const destinations = event.tags.filter(([name]) => name === "h");
    const hitChannelId = destinations[0]?.[1];
    const hitChannel = hitChannelId && session.channels.get?.(hitChannelId);
    if (
      ![9, 40002, 40008].includes(event.kind) ||
      destinations.length !== 1 ||
      !hitChannelId ||
      (channelId && hitChannelId !== channelId) ||
      !hitChannel ||
      hitChannel.huddle
    )
      return [];
    // Search returns original indexed events, not an auxiliary edit fold.
    // Exact navigation owns current content/deletion checks when opened.
    const body = event.kind === 40002 ? objectBody(event.content) : undefined;
    const text =
      event.kind === 40002
        ? typeof body?.content === "string"
          ? body.content
          : "Agent message"
        : event.content;
    return [
      {
        id: event.id,
        channelId: hitChannelId,
        authorId: event.pubkey,
        workflowOwnerId: workflowOwner(event, session.workflowAuthority),
        createdAt: event.created_at,
        preview: text.replace(/\s+/g, " ").trim().slice(0, 240) || "Attachment",
      },
    ];
  });
  // The relay pages by offset, so only a full page can have a successor.
  return { messages, more: relayCount >= PAGE_SIZE };
}

/** Later pages extend the list. Offsets can shift between reads, so a repeated
 * hit is dropped, and a newest-first list keeps the relay's own order. */
function appendPage(
  previous: readonly SearchMessage[],
  page: readonly SearchMessage[],
  newestFirst: boolean,
) {
  const seen = new Set(previous.map(({ id }) => id));
  const merged = [...previous, ...page.filter(({ id }) => !seen.has(id))];
  return newestFirst
    ? merged.sort(
        (a, b) =>
          b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
    : merged;
}

/** Finite, ranked results belong to this open palette, not a retained event view. */
export function useSearchMessages(
  session: RelaySession,
  query: string,
  scopedChannelId?: string,
  operatorChannelId?: string | null,
  /** Selectable agents' own names, by public key. The author picker matches
   * an agent by its own name too, so a completed author name resolves the
   * same way. */
  agentNames: ReadonlyMap<string, string> = noAgentNames,
  /** Newest is honored only by relays advertising `buzz-search-sort`. */
  sort: SearchSort = "relevance",
) {
  const ordinaryChannel = useCallback(
    (id: string, includePending = false) => {
      const channel = session.channels.get?.(id);
      return (
        !!channel &&
        !channel.huddle &&
        (includePending || !channel.metadataPending)
      );
    },
    [session],
  );
  const parsed = useMemo(() => parseSearchOperators(query), [query]);
  const syntax = useMemo(() => searchTextSyntax(parsed.text), [parsed.text]);
  // Rerun the search only when the names change, not on every new map.
  const agentKey = JSON.stringify([...agentNames]);
  const agents = useMemo(
    () => new Map<string, string>(JSON.parse(agentKey)),
    [agentKey],
  );
  const channelId = scopedChannelId ?? operatorChannelId;
  const unresolvedChannel =
    !scopedChannelId &&
    !!(parsed.in && normalizeInChannel(parsed.in)) &&
    !channelId;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result>();
  const hasFilters =
    !!(parsed.from && normalizeFromHandle(parsed.from)) ||
    !!(parsed.in && normalizeInChannel(parsed.in)) ||
    parsed.since !== null ||
    parsed.until !== null;
  // An unfinished author token is an identity prompt, not free-text search.
  // Both from:name and from:@name take the same picker path until an exact key
  // is selected (or the token is completed with a space).
  // `me` is the viewer, never a name to pick.
  const unfinishedAuthor = operatorMatches(
    query,
    /(?:^|\s)from:(@?)([^\s]*)$/gi,
  ).at(-1);
  const authorPrompt =
    !!unfinishedAuthor &&
    !isHexPubkey(unfinishedAuthor[2] ?? "") &&
    !isViewerHandle(unfinishedAuthor[2] ?? "");
  // A prefix search answers a short last word with no hits; a full-text
  // search needs something to find, not only exclusions.
  const textSearchable = syntax.fullText
    ? syntax.positive
    : messageSearchable(parsed.text);
  const canSearch =
    !authorPrompt &&
    // A filter alone reads history; typed text is always a relay search.
    (parsed.text ? textSearchable : hasFilters);
  const newest = sort === "newest" && session.searchSort;
  // Without text the relay reads its ordinary newest-first history.
  const newestFirst = newest || !parsed.text;
  const owner = useMemo(
    () => ({ session, query, channelId, unresolvedChannel, attempt, newest }),
    [session, query, channelId, unresolvedChannel, attempt, newest],
  );
  // The copied result changes synchronously even if React has not committed it yet.
  const copied = useRef<Result | undefined>(undefined);
  // A page read belongs to the result it extends; a new search aborts it.
  const more = useRef<AbortController>(undefined);
  const replace = useCallback((next: Result | undefined) => {
    copied.current = next;
    setResult(next);
  }, []);
  useEffect(
    () =>
      session.channels.subscribeList(() => {
        const previous = copied.current;
        if (!previous) return;
        // Keep bounded search evidence so completed classification can reveal
        // ordinary results, while render always checks the current destination.
        replace({
          ...previous,
          messages: previous.messages.filter((message) =>
            ordinaryChannel(message.channelId, true),
          ),
        });
      }),
    [session, replace, ordinaryChannel],
  );
  useEffect(() => {
    if (!canSearch || unresolvedChannel) return;
    const controller = new AbortController();
    // Typeahead waits for a brief typing pause; cancellation also owns the delay.
    const cancel = searchDebounce(() => {
      void (async (): Promise<{
        messages: readonly SearchMessage[];
        next?: Result["next"];
        ambiguousAuthor?: boolean;
      }> => {
        let author: string | undefined;
        if (parsed.from) {
          if (isHexPubkey(parsed.from)) {
            author = parsed.from.toLowerCase();
          } else if (isViewerHandle(parsed.from)) {
            if (!session.viewer) return { messages: [] };
            author = session.viewer;
          } else {
            const typed = normalizeFromHandle(parsed.from).trim();
            const handle = normalizeName(typed);
            if (!handle) return { messages: [] };
            const knownMembers = channelId
              ? (session.channels.get?.(channelId)?.members ?? [])
              : [];
            if (knownMembers.length) {
              await session.profiles.ensure(knownMembers, "foreground");
              controller.signal.throwIfAborted();
            }
            // A key matches by its profile name or, for a selectable agent,
            // by the agent's own name.
            const named = (pubkey: string, profileName = "") =>
              normalizeName(profileName) === handle ||
              normalizeName(agents.get(pubkey) ?? "") === handle;
            // Selectable agents are offered wherever the picker runs, so they
            // are always candidates, alongside members or relay matches.
            const agentMatches = [...agents.keys()].filter((pubkey) =>
              named(pubkey, session.profiles.snapshot().get(pubkey)?.name),
            );
            const scoped = knownMembers.filter((pubkey) =>
              named(pubkey, session.profiles.snapshot().get(pubkey)?.name),
            );
            const resolve = (keys: readonly string[]) => {
              const unique = [...new Set(keys)];
              if (unique.length > 1) return { ambiguous: true };
              return { author: unique[0] };
            };
            if (scoped.length) {
              const found = resolve([...scoped, ...agentMatches]);
              if (found.ambiguous)
                return { messages: [], ambiguousAuthor: true };
              author = found.author;
            } else {
              // Relay name search is limited. A match outside its first page
              // is unknown, so a full page is as ambiguous as duplicate names.
              // The relay does not fold accents, so it gets the typed text.
              const limit = 40;
              const candidates = await session.searchProfiles(
                typed.toLowerCase(),
                { limit, signal: controller.signal },
              );
              const matches = [...foldProfiles(candidates)]
                .filter(
                  ([pubkey, profile]) =>
                    named(pubkey, profile.name) || pubkey === handle,
                )
                .map(([pubkey]) => pubkey);
              const found = resolve([...matches, ...agentMatches]);
              if (found.ambiguous || candidates.length >= limit)
                return { messages: [], ambiguousAuthor: true };
              author = found.author;
            }
            if (!author) return { messages: [] };
          }
        }
        const filter: ReadFilter = {
          kinds: [9, 40002, 40008],
          ...(parsed.text
            ? {
                search: parsed.text,
                search_mode: syntax.fullText
                  ? ("fulltext" as const)
                  : ("prefix" as const),
                ...(newest ? { search_sort: "newest" as const } : {}),
              }
            : {}),
          limit: PAGE_SIZE,
          ...(channelId ? { "#h": [channelId] } : {}),
          ...(author ? { authors: [author] } : {}),
          ...(parsed.since !== null ? { since: parsed.since } : {}),
          ...(parsed.until !== null ? { until: parsed.until } : {}),
        };
        const page = await readPage(
          session,
          channelId,
          filter,
          1,
          controller.signal,
        );
        return {
          messages: page.messages,
          ...(page.more ? { next: { filter, page: 2 } } : {}),
        };
      })()
        .then(({ messages, next, ambiguousAuthor }) => {
          if (controller.signal.aborted) return;
          replace({
            owner,
            messages,
            ...(next ? { next } : {}),
            ...(ambiguousAuthor ? { ambiguousAuthor } : {}),
          });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            replace({
              owner,
              messages: [],
              error: `Message search couldn’t finish${error instanceof Error && error.message ? `: ${error.message.slice(0, 240)}` : "."}${scopedChannelId ? " Try again." : " Pages and conversations are still available."}`,
            });
        });
    });
    return () => {
      cancel();
      controller.abort();
      more.current?.abort();
    };
  }, [
    canSearch,
    session,
    parsed,
    syntax,
    channelId,
    unresolvedChannel,
    owner,
    replace,
    scopedChannelId,
    agents,
    newest,
  ]);
  const loadMore = useCallback(() => {
    const base = copied.current;
    if (base?.owner !== owner || !base.next || base.loadingMore) return;
    const { filter, page } = base.next;
    const controller = new AbortController();
    more.current = controller;
    const { moreError: _, ...rest } = base;
    replace({ ...rest, loadingMore: true });
    void readPage(session, channelId, filter, page, controller.signal)
      .then((next) => {
        const previous = copied.current;
        if (controller.signal.aborted || !previous) return;
        const { next: _, loadingMore: __, ...rest } = previous;
        replace({
          ...rest,
          messages: appendPage(previous.messages, next.messages, newestFirst),
          ...(next.more ? { next: { filter, page: page + 1 } } : {}),
        });
      })
      .catch((error: unknown) => {
        const previous = copied.current;
        if (controller.signal.aborted || !previous) return;
        const { loadingMore: _, ...rest } = previous;
        replace({
          ...rest,
          moreError: `More messages couldn’t load${error instanceof Error && error.message ? `: ${error.message.slice(0, 240)}` : "."}`,
        });
      });
  }, [owner, replace, session, channelId, newestFirst]);
  const current = result?.owner === owner ? result : undefined;
  return {
    messages: (current?.messages ?? []).filter((message) =>
      ordinaryChannel(message.channelId),
    ),
    loading: canSearch && !unresolvedChannel && !current,
    /** The last typed word is too short to search messages. */
    tooShort:
      !!parsed.text && !syntax.fullText && !messageSearchable(parsed.text),
    /** The text only excludes words, so there is nothing to search for. */
    onlyExclusions: !!parsed.text && syntax.fullText && !syntax.positive,
    error: current?.error,
    ambiguousAuthor: current?.ambiguousAuthor,
    newestFirst,
    hasMore: !!current?.next,
    loadingMore: !!current?.loadingMore,
    moreError: current?.moreError,
    loadMore,
    retry: () => setAttempt((value) => value + 1),
  };
}
