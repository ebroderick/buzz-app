import { workflowLabel } from "../../features/relay/workflow-attribution";
import {
  useIdentityNames,
  useNamesRevision,
} from "../../features/identity-names/react";
import { npubEncode } from "nostr-tools/nip19";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { EventData } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import {
  useChannelList,
  useProfileGeneration,
} from "../../features/relay/react";
import { useSavedHiddenDmIds } from "../../bundled/channels/useHiddenDms";
import { useAgentChoices } from "../../features/agents/use-choices";
import { canMessageAgent } from "../../features/agents/choices";
import { useMentionArchives } from "../../features/messages/use-mention-archives";
import { archiveHides } from "../../features/relay/identity-archives";
import { foldProfiles } from "../../features/relay/profiles";
import {
  ArrowsDownUpIcon,
  CalendarIcon,
  ChatCircleIcon,
} from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import type {
  SearchDestination,
  SearchGroup,
  SearchInputProps,
  SearchViews,
} from "./SearchChoices";
import { SearchChoices } from "./SearchChoices";
import { MatchRank, matchName, matchRank } from "../../features/search/match";
import {
  noSearchUsage,
  readSearchUsage,
  recordChoice,
  searchOrder,
} from "../../features/search/usage";
import { usePublicChannelSearch } from "../../features/channels/usePublicChannelSearch";
import { useMemberCounts } from "../../features/channels/useChannelDirectory";
import { type SearchSort, useSearchMessages } from "./useSearchMessages";
import {
  MESSAGE_SEARCH_MIN_CHARS,
  SEARCH_MIN_CHARS,
  searchDebounce,
  searchable,
} from "../../shared/search-debounce";
import { matchPerson, normalizeName } from "../../features/search/person-match";
import {
  personKey,
  rankPeople,
  type PersonCandidate,
} from "../../features/search/people-rank";
import { peopleRelationships } from "../../features/profiles/relationships";
import { knownAgentPubkeys } from "../../features/agents/known";
import { usePersonDirectory } from "./usePersonDirectory";
import {
  isChannelUuid,
  isHexPubkey,
  isViewerHandle,
  normalizeFromHandle,
  normalizeInChannel,
  operatorMatches,
  parseSearchOperators,
} from "./parseSearchOperators";
import { avatarMedia } from "../../shared/avatar-source";
import { useVerifiedNames } from "../../features/profiles/useVerifiedNames";
import { sortParticipantNames } from "../../features/identity-names/participant-order";

function conversationName(
  channel: ChannelSummary,
  profiles: ReadonlyMap<string, Profile>,
  resolveName: ReturnType<typeof useIdentityNames>,
) {
  if (channel.channelType !== "dm" || !channel.participants)
    return channel.name;
  return (
    sortParticipantNames(
      channel.participants.map((id) =>
        resolveName(
          id,
          profiles.get(id)?.name ?? id.slice(0, 10),
          channel.participants,
        ),
      ),
    ).join(", ") || "Notes to self"
  );
}

/** The most rows the People and Agents groups each show. */
const PERSON_ROWS = 6;
const noMembers: readonly string[] = [];

/** "Search in this conversation" narrows the search and "Show more messages"
 * extends it; neither is a result. */
const isSearchAction = (key: string) =>
  key.startsWith("scope:") || key === "more-messages";

function useDelayedSearch(pending: boolean) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!pending) return;
    const timer = setTimeout(() => setSlow(true), 1000);
    return () => clearTimeout(timer);
  }, [pending]);
  return pending && slow;
}

function useSearchAnnouncement(
  channels: boolean,
  people: boolean,
  messages: boolean,
) {
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const sources = [
      channels && "channels",
      people && "people",
      messages && "messages",
    ].filter(Boolean);
    setAnnouncement((previous) => {
      if (!sources.length) return "";
      const names =
        sources.length === 3
          ? `${sources.slice(0, 2).join(", ")}, and ${sources[2]}`
          : sources.join(" and ");
      return previous || `Searching ${names}…`;
    });
  }, [channels, people, messages]);
  return announcement;
}

export function SearchResults({
  session,
  inlineSettings,
  query,
  onQueryChange,
  input,
  open,
  pages,
  scopedChannelId,
  currentChannelId,
  onScopeChange,
  openConversation,
  openAgentSession,
  usageScope,
  sidebarScope,
  views,
}: {
  session: RelaySession;
  /** Tabs that switch this search to other views of it. */
  views?: SearchViews | undefined;
  pages: readonly SearchDestination[];
  scopedChannelId?: string | undefined;
  currentChannelId?: string | undefined;
  onScopeChange?: ((channelId?: string) => void) | undefined;
  openConversation: (channelId: string, messageId?: string) => void;
  /** Open a new Solo chat with one of the viewer's agents. Without it,
   * choosing one of their agents opens a direct message, as for anyone else. */
  openAgentSession?: ((pubkey: string) => void) | undefined;
  /** View-state partition whose visits and search choices rank results. */
  usageScope?: string | undefined;
  /** The sidebar's view scope, whose hidden DMs search leaves out too. */
  sidebarScope?: string | undefined;
} & SearchInputProps) {
  const resolveName = useIdentityNames(session.names);
  const list = useChannelList(session.channels);
  const parsed = useMemo(() => parseSearchOperators(query.trim()), [query]);
  const authorPrompt = operatorMatches(
    query,
    /(?:^|\s)from:(@?)([^\s]*)$/gi,
  ).at(-1);
  // `me` is the viewer, never a name to pick.
  const pickerPrompt =
    !!authorPrompt &&
    !isHexPubkey(authorPrompt[2] ?? "") &&
    !isViewerHandle(authorPrompt[2] ?? "");
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const channels = useMemo(
    () =>
      list.channels.filter(
        (channel) =>
          !channel.huddle &&
          !channel.metadataPending &&
          (!channel.archived ||
            (!channel.readOnly &&
              (channel.channelType === "stream" ||
                channel.channelType === "forum" ||
                channel.channelType === "solo"))) &&
          (!channel.hidden || channel.channelType === "dm") &&
          (!scopedChannelId || channel.id === scopedChannelId),
      ),
    [list.channels, scopedChannelId],
  );
  // A DM hidden from the sidebar (Remove from Team, or Hide conversation) has
  // no row here either. Its messages still match, and choosing the person
  // opens it again through the confirmed open, which restores its sidebar row.
  const dmVisibility = useSyncExternalStore(
    session.channelLifecycle.subscribe,
    session.channelLifecycle.snapshot,
    session.channelLifecycle.snapshot,
  );
  const savedHidden = useSavedHiddenDmIds(sidebarScope);
  const sidebarHidden = (channel: ChannelSummary) =>
    channel.channelType === "dm" &&
    (savedHidden.has(channel.id) || dmVisibility.hidden.includes(channel.id));
  const [selectedAuthor, setSelectedAuthor] = useState<{
    query: string;
    pubkey: string;
    name: string;
    index: number;
  }>();
  const authorOperand = selectedAuthor ? `from:${selectedAuthor.pubkey}` : "";
  const selectedIndex = selectedAuthor?.index ?? -1;
  const showAuthorChip =
    !!selectedAuthor &&
    query === selectedAuthor.query &&
    query.slice(selectedIndex, selectedIndex + authorOperand.length) ===
      authorOperand;
  const displayQuery = showAuthorChip
    ? `${query.slice(0, selectedIndex)}${query.slice(selectedIndex + authorOperand.length).replace(/^\s/, "")}`
    : undefined;
  const updateDisplayQuery = (value: string) => {
    const nextQuery = showAuthorChip
      ? `from:${selectedAuthor?.pubkey} ${value.trimStart()}`
      : value;
    setSelectedAuthor(
      showAuthorChip && selectedAuthor
        ? { ...selectedAuthor, query: nextQuery, index: 0 }
        : undefined,
    );
    onQueryChange(nextQuery);
  };
  const removeSelectedAuthor = () => {
    if (!selectedAuthor || !showAuthorChip) return;
    onQueryChange(displayQuery ?? "");
    setSelectedAuthor(undefined);
    input.current?.focus();
  };
  const updateDateQuery = (nextQuery: string) => {
    if (showAuthorChip && selectedAuthor) {
      const index = nextQuery.indexOf(authorOperand);
      setSelectedAuthor(
        index < 0 ? undefined : { ...selectedAuthor, query: nextQuery, index },
      );
    }
    onQueryChange(nextQuery);
  };
  const [authorSuggestions, setAuthorSuggestions] = useState<{
    query: string;
    lookupFailed?: boolean;
    remote: readonly EventData[];
  }>();
  // Completing either from:name or from:@name selects an exact signed key.
  const datePrompt = operatorMatches(
    query,
    /(?:^|\s)(after|before):([^\s]*)$/gi,
  ).at(-1);
  const showDateChoices =
    !!datePrompt && parseSearchOperators(datePrompt[0]).text !== "";
  const datePresets = [
    ["Today", 0],
    ["Yesterday", 1],
    ["This week", 2],
    ["Last week", 3],
    ["This month", 4],
  ] as const;
  const dateChoices: SearchDestination[] =
    showDateChoices && datePrompt
      ? datePresets.map(([label, kind]) => {
          const day = new Date();
          day.setHours(0, 0, 0, 0);
          if (kind === 1) day.setDate(day.getDate() - 1);
          if (kind === 2 || kind === 3) {
            day.setDate(
              day.getDate() - ((day.getDay() + 6) % 7) - (kind === 3 ? 7 : 0),
            );
          }
          if (kind === 4) day.setDate(1);
          const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
          return {
            key: `date:${kind}`,
            label,
            detail: date,
            icon: CalendarIcon,
            run: () =>
              updateDateQuery(
                `${query.slice(0, datePrompt.index)} ${datePrompt[1]}:${date} `.trimStart(),
              ),
          };
        })
      : [];
  // Every keystroke renders; DM names only change with their inputs.
  const names = useMemo(
    () =>
      new Map(
        channels.map((channel) => [
          channel.id,
          conversationName(channel, profiles, resolveName),
        ]),
      ),
    [channels, profiles, resolveName],
  );
  const operatorChannel = parsed.in ? normalizeInChannel(parsed.in) : "";
  // `in:@person` names your direct message with them, by key, `me` or name.
  const operatorPerson = operatorChannel.startsWith("@")
    ? normalizeFromHandle(operatorChannel)
    : undefined;
  const operatorPersonKey =
    operatorPerson && isViewerHandle(operatorPerson)
      ? session.viewer
      : operatorPerson && isHexPubkey(operatorPerson)
        ? operatorPerson.toLowerCase()
        : undefined;
  const sameName = (name: string | undefined, wanted: string) =>
    !!name && !!wanted && normalizeName(name) === normalizeName(wanted);
  /** Whether `channel` is the conversation the `in:` operator names. */
  const matchesInOperator = (channel: ChannelSummary) => {
    if (channel.huddle) return false;
    if (operatorPerson === undefined)
      return (
        channel.name.toLowerCase() === operatorChannel.toLowerCase() ||
        names.get(channel.id)?.toLowerCase() === operatorChannel.toLowerCase()
      );
    if (channel.channelType !== "dm") return false;
    const others = channel.participants;
    // A self-DM lists no other participants.
    if (operatorPersonKey && operatorPersonKey === session.viewer)
      return others?.length === 0;
    // Only a one-to-one DM names a single person.
    if (others?.length !== 1) return false;
    if (operatorPersonKey) return others[0] === operatorPersonKey;
    return (
      sameName(names.get(channel.id), operatorPerson) ||
      sameName(profiles.get(others[0] ?? "")?.name, operatorPerson)
    );
  };
  const namedChannels =
    !operatorChannel || isChannelUuid(operatorChannel)
      ? []
      : list.channels.filter(matchesInOperator);
  const needsPublicLookup =
    !scopedChannelId &&
    !!operatorChannel &&
    operatorPerson === undefined &&
    !isChannelUuid(operatorChannel);
  const operatorPublicChannels = usePublicChannelSearch(
    session,
    needsPublicLookup ? operatorChannel : "",
    list.status === "ready",
    true,
  );
  const operatorLookupPending =
    needsPublicLookup &&
    (list.status !== "ready" || operatorPublicChannels.loading);
  const operatorLookupError = needsPublicLookup
    ? operatorPublicChannels.error
    : undefined;
  // Joined and open namesakes compete together. A live conversation outranks
  // an archived namesake; live namesakes are ambiguous, so the search waits
  // for a clearer name rather than guess. Cached rows shown while the exact
  // lookup runs may miss a namesake, so only its settled answer resolves.
  const namedCandidates = [
    ...namedChannels,
    ...operatorPublicChannels.channels.filter(
      ({ id }) => !namedChannels.some((channel) => channel.id === id),
    ),
  ];
  const liveNamed = namedCandidates.filter((channel) => !channel.archived);
  const inMatches = liveNamed.length ? liveNamed : namedCandidates;
  const operatorChannelId = isChannelUuid(operatorChannel)
    ? operatorChannel
    : !operatorLookupPending && !operatorLookupError && inMatches.length === 1
      ? inMatches[0]?.id
      : undefined;
  const operatorChannelAmbiguous = inMatches.length > 1;
  // The author picker also matches a selectable agent by its own name, so a
  // completed from: name resolves against the same names.
  const agentSnapshot = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
    session.agentChoices.snapshot,
  );
  const [sort, setSort] = useState<SearchSort>("relevance");
  const search = useSearchMessages(
    session,
    query,
    scopedChannelId,
    operatorChannelId,
    new Map(
      agentSnapshot.selectable
        .filter(
          (agent) =>
            !archiveHides(session.archives, agent.pubkey, session.viewer),
        )
        .map((agent) => [agent.pubkey, agent.name]),
    ),
    // Only scoped search offers the choice, so global search keeps relevance.
    scopedChannelId ? sort : "relevance",
  );
  const messageOrder = search.newestFirst ? "Most recent" : "Most relevant";
  const showAmbiguousPicker = !!search.ambiguousAuthor && !pickerPrompt;
  // Ambiguity is known only after a completed token. Keep its original span so
  // choosing a key does not discard free text or other operators after it.
  const completedAuthor = showAmbiguousPicker
    ? operatorMatches(query, /(?:^|\s)from:(@?)(\S+)/gi).at(-1)
    : undefined;
  const authorToken = authorPrompt ?? completedAuthor;
  const authorNeedle = (authorPrompt?.[2] ?? parsed.from ?? "")
    .replace(/^@/, "")
    .toLowerCase();
  const showAuthorPicker = pickerPrompt || showAmbiguousPicker;
  const agents = useAgentChoices(session, showAuthorPicker);
  // People and agents are destinations for plain typed text outside a
  // conversation scope; an operator asks for messages. `@` asks for a person
  // and `#` for a channel.
  const peopleText = parsed.text.trim();
  const peopleNeedle = peopleText.replace(/^@/, "");
  const peopleActive =
    !scopedChannelId &&
    parsed.from === null &&
    parsed.in === null &&
    parsed.since === null &&
    parsed.until === null &&
    !showAuthorPicker &&
    !showDateChoices &&
    !!peopleNeedle &&
    !peopleText.startsWith("#");
  const personDirectory = usePersonDirectory(
    session,
    peopleNeedle,
    peopleActive,
  );
  // Typing cancels the page's read; the next settled page reads again.
  const directoryVerified = useVerifiedNames(session, personDirectory.people, {
    key: peopleNeedle,
    settled: !personDirectory.loading,
  });
  useMentionArchives(session, showAuthorPicker || peopleActive);
  // People labels come from one names scope built each render.
  useNamesRevision(session.names, peopleActive);
  // The viewer's own agents open a new chat, not a direct message: the
  // same agents the new-chat composer accepts. Their earlier chats
  // still show as conversations.
  const sessionSearch = !!openAgentSession && peopleActive;
  const ownAgents = useAgentChoices(session, sessionSearch, sessionSearch);
  const sessionAgents = new Map(
    (sessionSearch ? ownAgents.selectable : []).map((agent) => [
      agent.pubkey,
      agent,
    ]),
  );
  const effectiveChannelId = scopedChannelId ?? operatorChannelId;
  useEffect(() => {
    if (!showAuthorPicker) return;
    const controller = new AbortController();
    const cancel = searchDebounce(() => {
      void (async () => {
        const members = effectiveChannelId
          ? (session.channels.get?.(effectiveChannelId)?.members ?? [])
          : [];
        if (members.length) {
          try {
            await session.profiles.ensure(members, "foreground");
          } catch (error) {
            if (controller.signal.aborted) throw error;
            // A partial directory still contains verified member profiles.
          }
        }
        let remote: readonly EventData[] = [];
        let lookupFailed = false;
        if (searchable(authorNeedle)) {
          try {
            remote = await session.searchProfiles(authorNeedle, {
              limit: 40,
              signal: controller.signal,
            });
          } catch (error) {
            if (controller.signal.aborted) throw error;
            lookupFailed = true;
          }
        }
        controller.signal.throwIfAborted();
        setAuthorSuggestions({ query, lookupFailed, remote });
      })().catch(() => {
        if (!controller.signal.aborted)
          setAuthorSuggestions({ query, remote: [], lookupFailed: true });
      });
    });
    return () => {
      cancel();
      controller.abort();
    };
  }, [session, effectiveChannelId, query, authorNeedle, showAuthorPicker]);
  const members = effectiveChannelId
    ? (session.channels.get?.(effectiveChannelId)?.members ?? [])
    : [];
  const knownAgents = new Set(agents.identities.map(({ pubkey }) => pubkey));
  const selectableAgents = new Map(
    agents.selectable.map((agent) => [agent.pubkey, agent]),
  );
  const candidates = new Map([
    ...[...profiles].filter(([pubkey]) => members.includes(pubkey)),
    ...agents.selectable.map(
      (agent) =>
        [
          agent.pubkey,
          profiles.get(agent.pubkey) ?? {
            name: agent.name,
            isAgent: true as const,
            ...(agent.avatar ? { picture: agent.avatar } : {}),
          },
        ] as const,
    ),
    ...foldProfiles(
      authorSuggestions?.query === query ? authorSuggestions.remote : [],
    ),
  ]);
  // A selectable agent also matches by its own name, as in @ mentions.
  const authorTier = (pubkey: string, name: string) =>
    Math.min(
      ...[name, selectableAgents.get(pubkey)?.name].map((alias) =>
        alias === undefined
          ? Infinity
          : (matchPerson(alias, authorNeedle)?.tier ?? Infinity),
      ),
    );
  const authorChoices =
    authorToken && showAuthorPicker && authorSuggestions?.query === query
      ? [...candidates]
          .filter(([pubkey, profile]) => authorTier(pubkey, profile.name) < 4)
          .filter(
            ([pubkey]) =>
              !archiveHides(session.archives, pubkey, session.viewer) &&
              (!knownAgents.has(pubkey) || selectableAgents.has(pubkey)),
          )
          // Exact names survive the cap when the resolver reports ambiguity.
          .sort(
            ([left, leftProfile], [right, rightProfile]) =>
              Number(authorTier(right, rightProfile.name) === 0) -
                Number(authorTier(left, leftProfile.name) === 0) ||
              Number(!!leftProfile.isAgent || knownAgents.has(left)) -
                Number(!!rightProfile.isAgent || knownAgents.has(right)) ||
              Number(members.includes(right)) - Number(members.includes(left)),
          )
          .slice(0, 12)
          .map(([pubkey, profile]) => ({ pubkey, profile }))
          .map(({ pubkey, profile }) => {
            const agent = selectableAgents.get(pubkey);
            const isAgent = !!agent || !!profile.isAgent;
            return {
              key: `author:${pubkey}`,
              label: resolveName(
                pubkey,
                profile.name,
                effectiveChannelId
                  ? session.channels.get?.(effectiveChannelId)?.members
                  : undefined,
              ),
              detail: pubkey.slice(0, 12),
              icon: ChatCircleIcon,
              avatar: {
                src: avatarMedia(
                  profile.picture ?? agent?.avatar,
                  session.media,
                ),
                shape: isAgent ? ("squircle" as const) : ("circle" as const),
              },
              isAgent,
              run: () => {
                // The prompt's leading separator may be the one removed with
                // the old chip. Map the token itself through that removal,
                // rather than subtracting the separator from its start twice.
                const visible = displayQuery ?? query;
                const oldEnd = selectedIndex + authorOperand.length;
                const removedLength = showAuthorChip
                  ? authorOperand.length + (query[oldEnd] === " " ? 1 : 0)
                  : 0;
                const tokenStart =
                  authorToken.index +
                  (authorToken[0].match(/^\s*/)?.[0].length ?? 0);
                const promptStart =
                  showAuthorChip && selectedIndex < tokenStart
                    ? tokenStart - removedLength
                    : tokenStart;
                const promptEnd =
                  promptStart + authorToken[0].trimStart().length;
                const prefix = visible.slice(0, promptStart);
                const nextQuery = `${prefix}from:${pubkey}${visible.slice(promptEnd) || " "}`;
                setSelectedAuthor({
                  query: nextQuery,
                  pubkey,
                  name: profile.name,
                  index: prefix.length,
                });
                onQueryChange(nextQuery);
                input.current?.focus();
              },
            };
          })
      : [];
  const publicChannels = usePublicChannelSearch(
    session,
    scopedChannelId ? "" : parsed.text,
    list.status === "ready",
  );
  // Scoped search passes no text, so the lookup is idle there.
  const slowChannels = useDelayedSearch(publicChannels.loading);
  const slowPeople = useDelayedSearch(peopleActive && personDirectory.loading);

  const profileKey = [
    ...new Set([
      ...channels.flatMap((channel) =>
        channel.channelType === "dm" ? (channel.participants ?? []) : [],
      ),
      ...search.messages.flatMap((message) => [
        message.authorId,
        ...(message.workflowOwnerId ? [message.workflowOwnerId] : []),
      ]),
      ...personDirectory.people.flatMap((person) =>
        person.ownerPubkey ? [person.ownerPubkey] : [],
      ),
    ]),
  ]
    .sort()
    .slice(0, 1024)
    .join(":");
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    if (profileKey)
      void session.profiles
        .ensure(profileKey.split(":"), "background")
        .catch(() => {});
  }, [session, profileKey, profileGeneration]);
  const needle = parsed.text.toLowerCase().replace(/^#/, "");
  // Read once per opening, so usage recorded while it is open cannot reorder it.
  const usage = useMemo(
    () => (usageScope ? readSearchUsage(usageScope) : noSearchUsage),
    [usageScope],
  );
  const choose = (key: string, run: () => void) => () => {
    if (usageScope) recordChoice(usageScope, needle, key);
    cancelPersonOpen(key);
    run();
  };
  const messageableAgents = new Map(
    agents.identities
      .filter(canMessageAgent)
      .map((agent) => [agent.pubkey, agent]),
  );
  const people: (PersonCandidate & { picture?: string | undefined })[] = [];
  if (peopleActive) {
    const relationships = peopleRelationships(
      list.channels,
      new Set(messageableAgents.keys()),
    );
    const knownAgents = knownAgentPubkeys(profiles, {
      definitions: [],
      identities: agents.identities,
    });
    const sources = new Map<
      string,
      {
        name: string;
        username?: string | undefined;
        picture?: string | undefined;
        isAgent?: boolean | undefined;
      }
    >();
    // Ties keep this order, as in New message: the directory's rows first, in
    // the relay's order, then cached profiles, then agents. A cached profile
    // still supplies a directory row's facts. Where the shared profiles have
    // not verified a row, a name verified for this page names it as they would.
    const cached = (pubkey: string) => {
      const profile = profiles.get(pubkey);
      return profile && (!profile.nameIsFallback || profile.username)
        ? profile
        : undefined;
    };
    const pageVerified = (pubkey: string) =>
      profiles.get(pubkey)?.verified
        ? undefined
        : directoryVerified.get(pubkey);
    const verifiedOf = (pubkey: string) =>
      profiles.get(pubkey)?.verified ?? pageVerified(pubkey);
    const searched = new Map<string, readonly string[]>();
    for (const person of personDirectory.people) {
      const source = cached(person.pubkey) ?? person;
      const found = pageVerified(person.pubkey);
      // The relay matched these names; a verified name must not lose the row.
      searched.set(
        person.pubkey,
        [person.name, person.username].filter((name) => name !== undefined),
      );
      sources.set(
        person.pubkey,
        found
          ? { ...source, name: found.displayName, username: found.username }
          : source,
      );
    }
    for (const [pubkey, profile] of profiles)
      if (!sources.has(pubkey) && cached(pubkey)) sources.set(pubkey, profile);
    for (const agent of [
      ...messageableAgents.values(),
      ...sessionAgents.values(),
    ])
      if (!sources.has(agent.pubkey))
        sources.set(agent.pubkey, {
          name: agent.name,
          picture: agent.avatar,
          isAgent: true,
        });
    const eligible = [...sources].flatMap(([pubkey, source]) => {
      const agent =
        !!source.isAgent ||
        knownAgents.has(pubkey) ||
        sessionAgents.has(pubkey);
      // As in New message, agent DM eligibility comes from the shared choices.
      return pubkey === session.viewer ||
        (agent &&
          !messageableAgents.has(pubkey) &&
          !sessionAgents.has(pubkey)) ||
        archiveHides(session.archives, pubkey, session.viewer)
        ? []
        : [{ pubkey, source, agent }];
    });
    // Namesakes are told apart within these destinations. Directory rows that
    // the shared profile cache does not name supply their own names.
    const candidates = eligible.map(({ pubkey }) => pubkey);
    const displayFacts = personDirectory.people.flatMap((person) => {
      const source = sources.get(person.pubkey);
      return source && source !== profiles.get(person.pubkey)
        ? [
            {
              pubkey: person.pubkey,
              name: source.name,
              ...(person.isAgent ? { isAgent: true } : {}),
              ...(person.ownerPubkey
                ? { ownerPubkey: person.ownerPubkey }
                : {}),
            },
          ]
        : [];
    });
    const named = session.names?.scope(candidates, displayFacts);
    for (const { pubkey, source, agent } of eligible) {
      const dm = relationships.dm(pubkey);
      const agentName =
        messageableAgents.get(pubkey)?.name ?? sessionAgents.get(pubkey)?.name;
      // Without a naming policy the scope falls back to the public profile,
      // which must not outrank a name verified for this page.
      const found = named?.(pubkey);
      const label =
        (found?.source === "public-profile" && pageVerified(pubkey)
          ? undefined
          : found?.name) ?? source.name;
      const fullName = verifiedOf(pubkey)?.fullName;
      people.push({
        pubkey,
        label,
        // A verified username or full name is often the label itself.
        username: source.username !== source.name ? source.username : undefined,
        fullName: fullName !== label ? fullName : undefined,
        agentName: agentName !== source.name ? agentName : undefined,
        profileNames: searched.get(pubkey),
        agent,
        relationship: relationships.rank(pubkey),
        usageKeys: [personKey(pubkey), ...(dm ? [`channel:${dm}`] : [])],
        picture:
          source.picture ??
          messageableAgents.get(pubkey)?.avatar ??
          sessionAgents.get(pubkey)?.avatar,
      });
    }
  }
  // What the viewer chose before for this typed text. Only candidates that
  // match count, so a stale choice cannot add a row.
  const picked = usage.pick(
    needle,
    new Set([
      ...channels
        .filter(
          ({ id }) =>
            parsed.text && matchRank(names.get(id) ?? "", needle) !== undefined,
        )
        .map(({ id }) => `channel:${id}`),
      ...publicChannels.channels.map(({ id }) => `channel:${id}`),
      ...pages.map(({ key }) => key),
      ...people.map(({ pubkey }) => personKey(pubkey)),
    ]),
  );
  // Rank before the limit, so an exact name beyond the first eight still shows.
  // The store matches public channels by the same rule (`matchRank`).
  // The shared search order, with archived channels half a step behind live
  // ones in the same place.
  const rankOf = (label: string, key: string, archived?: boolean) => {
    const rank = matchRank(label, needle) ?? MatchRank.inOrder + 1;
    return searchOrder(usage, picked, { key, rank }) + (archived ? 0.5 : 0);
  };
  /** Whether a search order is an exact name, live (-2) or archived (-1.5). */
  const exact = (rank: number) => rank < -1;
  const byMatch = <T,>(rows: readonly T[], rank: (row: T) => number) =>
    rows
      .map((row) => ({ row, rank: rank(row) }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ row }) => row);
  const channelRank = (channel: ChannelSummary) =>
    rankOf(
      names.get(channel.id) ?? channel.name,
      `channel:${channel.id}`,
      channel.archived,
    );
  const matchingAll = byMatch(
    channels.filter(
      (channel) =>
        parsed.text &&
        !sidebarHidden(channel) &&
        matchRank(names.get(channel.id) ?? "", needle) !== undefined,
    ),
    channelRank,
  );
  // One of the viewer's own agents leads with its "New chat" row. Its
  // existing chats follow that row, and its DM comes after them: chats, not
  // DMs, are where the viewer works with their agents. Removing DM-listed
  // people below only lifts the rest, so a row shown here still shows in the
  // Agents group.
  const newChats = new Map(
    rankPeople(
      people.filter(({ agent }) => agent),
      peopleNeedle,
      usage,
      picked,
    )
      .slice(0, PERSON_ROWS)
      .filter(({ person }) => sessionAgents.has(person.pubkey))
      .map(({ person, score }) => [
        person.pubkey,
        { score, label: person.label },
      ]),
  );
  /** The best-placed shown agent among these members, if any. */
  const newChatAmong = (members: readonly string[] | undefined) =>
    (members ?? [])
      .flatMap((pubkey) => newChats.get(pubkey) ?? [])
      .sort((a, b) => a.score - b.score)[0];
  const dmAgent = (channel: ChannelSummary) =>
    channel.participants?.length === 1
      ? newChats.get(channel.participants[0] ?? "")
      : undefined;
  const dmRank = (channel: ChannelSummary) => {
    const agent = dmAgent(channel);
    return Math.max(
      channelRank(channel),
      agent ? agent.score + 0.5 : -Infinity,
    );
  };
  const directMessageResults = byMatch(
    matchingAll.filter((channel) => channel.channelType === "dm"),
    dmRank,
  ).slice(0, 8);
  // A person whose DM row already shows needs no second row to the same
  // place. An agent's "New chat" row goes somewhere else, so it stays.
  const listedDms = new Set(
    directMessageResults.flatMap((channel) =>
      channel.participants?.length === 1 && !dmAgent(channel)
        ? channel.participants
        : [],
    ),
  );
  const rankedPeople = rankPeople(
    people.filter(({ pubkey }) => !listedDms.has(pubkey)),
    peopleNeedle,
    usage,
    picked,
  );
  // Solo chats, by name or by a shown agent among their members. A chat whose
  // name is the exact text comes first. Chats with that agent come next, in
  // the agent's order, so they follow its "New chat" row; other chats found
  // by name come after them. Live chats come before archived ones, and newer
  // before older.
  // A chat's exactness comes from its own name only. A chat found through an
  // exactly named agent inherits the agent's score but is not an exact name.
  const chatRank = (channel: ChannelSummary) => {
    const named = matchingAll.includes(channel)
      ? channelRank(channel)
      : Infinity;
    return exact(named)
      ? { rank: named, exactName: true }
      : {
          rank: newChatAmong(channel.members)?.score ?? named,
          exactName: false,
        };
  };
  const chatResults = channels
    .filter(
      (channel) =>
        channel.channelType === "solo" &&
        (!!newChatAmong(channel.members) || matchingAll.includes(channel)),
    )
    .map((channel) => ({
      channel,
      agent: !!newChatAmong(channel.members),
      ...chatRank(channel),
    }))
    .sort(
      (a, b) =>
        Number(b.exactName) - Number(a.exactName) ||
        Number(b.agent) - Number(a.agent) ||
        a.rank - b.rank ||
        Number(!!a.channel.archived) - Number(!!b.channel.archived) ||
        (b.channel.lastActivityAt ?? b.channel.updatedAt ?? 0) -
          (a.channel.lastActivityAt ?? a.channel.updatedAt ?? 0),
    )
    .slice(0, 8);

  const joinedAll = matchingAll.filter(
    (channel) => channel.channelType !== "dm" && channel.channelType !== "solo",
  );
  // Joined and public channels share one ranking before the limit, so the row
  // that gives the group its best rank, such as a remembered public channel,
  // is the row shown first. Joined channels win ties.
  const channelResults = byMatch(
    [
      ...joinedAll,
      ...publicChannels.channels.filter(
        (channel) => !joinedAll.some(({ id }) => id === channel.id),
      ),
    ],
    channelRank,
  ).slice(0, 8);
  // Display only; joined rows count the roster they carry.
  const memberCounts = useMemberCounts(session.channels);
  const memberCount = (channel: ChannelSummary) =>
    channel.members?.length || memberCounts.counts.get(channel.id);
  // A chat found by its agent, not its name, says which agent it has.
  const soloDetail = (channel: ChannelSummary) => {
    const agent = newChatAmong(channel.members);
    return agent && !matchingAll.includes(channel)
      ? `Chat with ${agent.label}`
      : "Chat";
  };
  const conversationDestination = (
    channel: ChannelSummary,
  ): SearchDestination => {
    const label = names.get(channel.id) ?? channel.name;
    const matches = needle ? matchName(label, needle)?.positions : undefined;
    const key = `channel:${channel.id}`;
    return {
      key,
      label,
      ...(matches ? { matches } : {}),
      detail: channel.archived
        ? channel.channelType === "solo"
          ? "Archived chat"
          : "Archived channel"
        : channel.readOnly && !channel.cached && channel.viewerRole !== "guest"
          ? channel.channelType === "solo"
            ? channel.joinRole === "guest"
              ? "View-only chat"
              : "Public chat · not joined"
            : "Public channel · not joined"
          : channel.channelType === "dm"
            ? "Direct message"
            : channel.channelType === "solo"
              ? soloDetail(channel)
              : "Conversation",
      icon: ChatCircleIcon,
      run: choose(key, () => openConversation(channel.id)),
    };
  };
  // Channel rows add how many members they have, when the roster is known.
  const channelDestination = (channel: ChannelSummary): SearchDestination => {
    const destination = conversationDestination(channel);
    const count = memberCount(channel);
    return count
      ? {
          ...destination,
          detail: [
            destination.detail,
            `${count} ${count === 1 ? "member" : "members"}`,
          ]
            .filter(Boolean)
            .join(" · "),
        }
      : destination;
  };
  // Choosing a person opens your DM with them, starting it when needed.
  const [personOpen, setPersonOpen] = useState<{
    name: string;
    error?: string;
  }>();
  const personAttempt = useRef<
    { key: string; controller: AbortController } | undefined
  >(undefined);
  useEffect(() => () => personAttempt.current?.controller.abort(), []);
  // The newest choice wins: another choice cancels a DM that is still opening.
  const cancelPersonOpen = (key?: string) => {
    if (!personAttempt.current || personAttempt.current.key === key) return;
    personAttempt.current.controller.abort();
    personAttempt.current = undefined;
    setPersonOpen(undefined);
  };
  // So does closing, or a reopen during the close animation would navigate.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cancelPersonOpen reads only refs and setters.
  useEffect(() => {
    if (open === false) cancelPersonOpen();
  }, [open]);
  const openPerson = async (pubkey: string, name: string, agent: boolean) => {
    if (personAttempt.current) return;
    const existing = session.channels
      .list()
      .channels.find(
        (channel) =>
          channel.channelType === "dm" &&
          !channel.archived &&
          !channel.hidden &&
          channel.participants?.length === 1 &&
          channel.participants[0] === pubkey,
      );
    // Opening a DM hidden on this device goes through the confirmed open,
    // which restores its sidebar row. A visible DM just opens.
    if (
      existing &&
      (!sidebarHidden(existing) || !session.directMessages.available)
    )
      return openConversation(existing.id);
    if (
      agent &&
      !existing &&
      !session.agentChoices
        .snapshot()
        .identities.some(
          (item) => canMessageAgent(item) && item.pubkey === pubkey,
        )
    ) {
      setPersonOpen({
        name,
        error: "This agent is not ready to message in this community.",
      });
      return;
    }
    const controller = new AbortController();
    personAttempt.current = { key: personKey(pubkey), controller };
    setPersonOpen({ name });
    try {
      const channelId = await session.directMessages.open(
        [pubkey],
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setPersonOpen(undefined);
      openConversation(channelId);
    } catch (reason) {
      if (!controller.signal.aborted)
        setPersonOpen({
          name,
          error:
            reason instanceof Error
              ? reason.message
              : "Could not open the conversation. Try again.",
        });
    } finally {
      if (personAttempt.current?.controller === controller)
        personAttempt.current = undefined;
    }
  };
  const personDestination = ({
    person,
    score,
  }: (typeof rankedPeople)[number]): SearchDestination & {
    score: number;
  } => {
    const matches = matchPerson(person.label, peopleNeedle)?.positions;
    const key = personKey(person.pubkey);
    const newSession = !!openAgentSession && sessionAgents.has(person.pubkey);
    const dm = list.channels.some(
      (channel) =>
        channel.channelType === "dm" &&
        !channel.archived &&
        channel.participants?.length === 1 &&
        channel.participants[0] === person.pubkey,
    );
    return {
      key,
      label: person.label,
      ...(matches?.length ? { matches } : {}),
      detail: [
        person.fullName,
        person.username && `@${person.username}`,
        newSession
          ? "New chat"
          : dm
            ? "Direct message"
            : "Start a direct message",
      ]
        .filter(Boolean)
        .join(" · "),
      icon: ChatCircleIcon,
      avatar: {
        src: avatarMedia(person.picture, session.media),
        shape: person.agent ? "squircle" : "circle",
      },
      score,
      run: choose(key, () =>
        newSession
          ? openAgentSession(person.pubkey)
          : void openPerson(person.pubkey, person.label, person.agent),
      ),
    };
  };
  const personResults = rankedPeople
    .filter(({ person }) => !person.agent)
    .slice(0, PERSON_ROWS)
    .map(personDestination);
  const agentResults = rankedPeople
    .filter(({ person }) => person.agent)
    .slice(0, PERSON_ROWS)
    .map(personDestination);
  const recent: SearchDestination[] = channels
    .filter(
      (channel) =>
        (!channel.readOnly || channel.viewerRole === "guest") &&
        !channel.archived &&
        !sidebarHidden(channel),
    )
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? b.updatedAt ?? 0) -
        (a.lastActivityAt ?? a.updatedAt ?? 0),
    )
    .slice(0, 4)
    .map((channel) => ({
      ...conversationDestination(channel),
      ...(channel.preview ? { detail: channel.preview } : {}),
    }));
  const currentChannel = currentChannelId
    ? channels.find((channel) => channel.id === currentChannelId)
    : undefined;
  const scopeAction: SearchDestination[] =
    !scopedChannelId && currentChannel && onScopeChange
      ? [
          {
            key: `scope:${currentChannel.id}`,
            label: `Search ${currentChannel.channelType === "dm" ? "conversation with" : "in"} ${names.get(currentChannel.id) ?? currentChannel.name}`,
            detail: "Search messages in this conversation",
            icon: ChatCircleIcon,
            run: () => {
              cancelPersonOpen();
              onScopeChange(currentChannel.id);
            },
          },
        ]
      : [];
  const messages: SearchDestination[] = search.messages.map((message) => {
    const displayId = message.workflowOwnerId ?? message.authorId;
    const name = resolveName(
      displayId,
      profiles.get(displayId)?.name ?? displayId.slice(0, 10),
      list.channels.find((channel) => channel.id === message.channelId)
        ?.members ?? noMembers,
    );
    return {
      key: message.id,
      label: message.preview,
      detail: `${names.get(message.channelId) ?? session.channels.get?.(message.channelId)?.name ?? "Conversation"} · ${message.workflowOwnerId ? workflowLabel(name) : name} · ${new Date(message.createdAt * 1000).toLocaleDateString()}`,
      icon: ChatCircleIcon,
      run: () => {
        cancelPersonOpen();
        openConversation(message.channelId, message.id);
      },
    };
  });
  const messageRows: SearchDestination[] = search.hasMore
    ? [
        ...messages,
        {
          key: "more-messages",
          label: search.loadingMore
            ? "Loading more messages…"
            : "Show more messages",
          icon: ChatCircleIcon,
          run: () => {
            cancelPersonOpen();
            search.loadMore();
          },
        },
      ]
    : messages;
  const directoryPending = publicChannels.loading || personDirectory.loading;
  const messagesPending = operatorLookupPending || search.loading;
  const slowMessages = useDelayedSearch(messagesPending);
  // An author or date picker replaces the result groups, so it announces
  // none of their lookups.
  const resultsShown = !showAuthorPicker && !showDateChoices;
  const searchAnnouncement = useSearchAnnouncement(
    resultsShown && slowChannels,
    slowPeople,
    resultsShown && slowMessages,
  );
  const operatorChannelProblem =
    scopedChannelId ||
    !operatorChannel ||
    operatorChannelId ||
    operatorLookupPending ||
    operatorLookupError ||
    list.status === "loading"
      ? undefined
      : operatorChannelAmbiguous
        ? `More than one conversation is named “${operatorChannel}”. Search in that conversation instead.`
        : `No conversation named “${operatorChannel}”.`;
  const messageEmpty =
    operatorLookupPending || search.loading
      ? undefined
      : operatorLookupError || search.error
        ? "Message search is unavailable."
        : operatorChannelProblem
          ? operatorChannelProblem
          : query.trim()
            ? directoryPending
              ? undefined
              : search.tooShort
                ? // Only the last word is matched as a prefix, so name it
                  // once earlier words make the whole query long enough.
                  `Type at least ${MESSAGE_SEARCH_MIN_CHARS} characters${/\s/.test(parsed.text.trim()) ? " in the last word" : ""} to search messages.`
                : search.onlyExclusions
                  ? "Add a word or “phrase” to search for alongside -exclusions."
                  : "No matching messages in accessible conversations."
            : scopedChannelId
              ? "Type to search messages in this conversation."
              : "Type to search messages in this community.";
  // A retry removes its own focused button. Return focus to the combobox,
  // which owns keyboard navigation, before the retry starts.
  const retryFromInput = (retry: () => unknown) => () => {
    input.current?.focus();
    retry();
  };
  const groups: readonly SearchGroup[] =
    pickerPrompt || showAmbiguousPicker
      ? [
          {
            label: "People",
            destinations: authorChoices.filter((choice) => !choice.isAgent),
            empty: authorChoices.length
              ? undefined
              : authorSuggestions?.query !== query
                ? "Searching people…"
                : authorSuggestions.lookupFailed
                  ? "People search is unavailable. Try a longer name."
                  : authorNeedle && !searchable(authorNeedle)
                    ? `Type at least ${SEARCH_MIN_CHARS} characters to search people.`
                    : authorNeedle
                      ? "No matching people. Try a different name."
                      : "Type a name to search people.",
          },
          {
            label: "Agents",
            destinations: authorChoices.filter((choice) => choice.isAgent),
          },
        ]
      : showDateChoices
        ? [{ label: "Dates", destinations: dateChoices }]
        : scopedChannelId
          ? [
              {
                label: messageOrder,
                rank: Infinity,
                destinations: messageRows,
                headingStatus: slowMessages ? "Searching…" : undefined,
                empty: messageEmpty,
              },
            ]
          : !query.trim()
            ? [
                ...(scopeAction.length
                  ? [{ label: "This conversation", destinations: scopeAction }]
                  : []),
                {
                  label: "Recent activity",
                  destinations: recent,
                  empty:
                    list.status === "loading"
                      ? "Loading recent conversations…"
                      : "No recent activity yet.",
                },
              ]
            : [
                // Named destinations lead, so typed text selects one first.
                // The group with the best match leads them, so Enter opens
                // the "Work" page before a channel that merely contains it.
                // Every group scores on one scale, match and usage, not the
                // relationship band that orders rows inside People and
                // Agents. An exact name always leads. After exact names, when
                // the text finds one of the viewer's agents, its "New chat"
                // row leads and its chats follow, whatever else matches
                // better or was picked before; its DM, and every other group,
                // comes after them.
                ...[
                  {
                    label: "Agents",
                    destinations: agentResults,
                    best: Math.min(...agentResults.map(({ score }) => score)),
                  },
                  {
                    label: "Chats",
                    destinations: chatResults.map(({ channel }) =>
                      conversationDestination(channel),
                    ),
                    best: Math.min(...chatResults.map(({ rank }) => rank)),
                    exactName: chatResults.some(({ exactName }) => exactName),
                  },
                  {
                    label: "Channels",
                    destinations: channelResults.map(channelDestination),
                    best: Math.min(...channelResults.map(channelRank)),
                    headingStatus: slowChannels ? "Searching…" : undefined,
                  },
                  {
                    label: "People",
                    destinations: personResults,
                    headingStatus: slowPeople ? "Searching…" : undefined,
                    best: Math.min(...personResults.map(({ score }) => score)),
                  },
                  {
                    label: "Direct messages",
                    destinations: directMessageResults.map(
                      conversationDestination,
                    ),
                    best: Math.min(...directMessageResults.map(dmRank)),
                  },
                  {
                    label: "Pages",
                    // PageSearch already ranked these by text and underlined
                    // them; here usage and earlier choices adjust the order.
                    destinations: byMatch(pages, (page) =>
                      rankOf(page.label, page.key),
                    ).map((page) => ({
                      ...page,
                      run: choose(page.key, page.run),
                    })),
                    best: Math.min(
                      ...pages.map((page) => rankOf(page.label, page.key)),
                    ),
                  },
                ]
                  .map(({ exactName, ...group }) => {
                    const named = exactName ?? exact(group.best);
                    return {
                      ...group,
                      named,
                      lead:
                        named ||
                        (newChats.size > 0 &&
                          (group.label === "Agents" ||
                            group.label === "Chats")),
                    };
                  })
                  .sort(
                    (a, b) =>
                      Number(b.named) - Number(a.named) ||
                      Number(b.lead) - Number(a.lead) ||
                      (a.lead ? 0 : a.best - b.best),
                  )
                  // Inline settings slot in by rank, so they follow too.
                  .map(({ best, lead, named: _named, ...group }) => ({
                    ...group,
                    rank: lead ? -Infinity : best,
                  })),
                ...(scopeAction.length
                  ? [{ label: "This conversation", destinations: scopeAction }]
                  : []),
                {
                  label: messageOrder,
                  rank: Infinity,
                  destinations: messageRows,
                  headingStatus: slowMessages ? "Searching…" : undefined,
                  empty:
                    directMessageResults.length ||
                    chatResults.length ||
                    channelResults.length ||
                    rankedPeople.length ||
                    pages.length
                      ? undefined
                      : messageEmpty,
                },
              ];
  return (
    <SearchChoices
      onRowsShown={(keys) => {
        // Only channel results without a roster read a count.
        const unknown = new Set(
          channelResults.flatMap((channel) =>
            channel.members?.length ? [] : [`channel:${channel.id}`],
          ),
        );
        memberCounts.show(
          keys.flatMap((key) =>
            unknown.has(key) ? [key.slice("channel:".length)] : [],
          ),
        );
      }}
      inlineSettings={inlineSettings}
      query={query}
      onQueryChange={onQueryChange}
      views={views}
      authorChip={
        showAuthorChip && selectedAuthor
          ? {
              label: selectedAuthor.name,
              title: npubEncode(selectedAuthor.pubkey),
              onRemove: removeSelectedAuthor,
            }
          : undefined
      }
      displayQuery={displayQuery}
      onDisplayQueryChange={updateDisplayQuery}
      input={input}
      label={scopedChannelId ? "Search this conversation" : "Search Buzz"}
      scopeAction={
        scopedChannelId && session.searchSort && parsed.text ? (
          <MenuRoot>
            <MenuTrigger
              render={(props) => (
                <IconButton
                  {...props}
                  variant="ghost"
                  aria-label="Sort messages"
                  title="Sort messages"
                  icon={<ArrowsDownUpIcon size={16} aria-hidden="true" />}
                />
              )}
            />
            <MenuPopup
              align="end"
              size="compact"
              aria-label="Sort messages"
              finalFocus={input}
            >
              <MenuRadioGroup
                value={sort}
                onValueChange={(value) =>
                  setSort(value === "newest" ? "newest" : "relevance")
                }
              >
                <MenuRadioItem value="relevance" closeOnClick>
                  Most relevant
                </MenuRadioItem>
                <MenuRadioItem value="newest" closeOnClick>
                  Most recent
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuPopup>
          </MenuRoot>
        ) : undefined
      }
      scope={
        scopedChannelId && onScopeChange
          ? {
              label:
                names.get(scopedChannelId) ??
                session.channels.get?.(scopedChannelId)?.name ??
                "Conversation",
              onRemove: () => onScopeChange(),
            }
          : undefined
      }
      groups={groups}
      open={open}
      // Enter before any row, or on search actions alone, waits for a
      // channel or person row, or for the lookups to settle, rather than
      // opening a message that lands first. A cold joined list has not yet
      // started the open-channel lookup.
      pending={
        (directoryPending ||
          operatorLookupPending ||
          search.loading ||
          (!scopedChannelId &&
            !!query.trim() &&
            list.status === "loading" &&
            !list.channels.length)) &&
        !groups.some(
          (group) =>
            group.rank !== Infinity &&
            group.destinations !== scopeAction &&
            group.destinations.length,
        )
      }
      isAction={isSearchAction}
    >
      {/* Guidance, not status: outside the live region so opening search
          does not announce it. */}
      {!query.trim() && (
        <p className="px-3 pb-2 text-body-sm text-subtle">
          Filter messages with from:me or from:@name, in:#channel or in:@person,
          after:, before:, on: or during: a date, "exact phrase" and -word.
        </p>
      )}
      <div
        className="space-y-2 px-3 text-body-sm text-subtle"
        aria-live="polite"
      >
        {list.status === "loading" && query.trim() && !list.channels.length && (
          <p>Loading joined conversations…</p>
        )}
        {list.status === "error" && (
          <div>
            <p>Couldn’t load all joined conversations.</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={retryFromInput(() =>
                session.channels.refreshList
                  ? session.channels.refreshList()
                  : session.channels.ensureList(),
              )}
            >
              Retry conversations
            </Button>
          </div>
        )}
        {list.coverage === "partial" && (
          <p>Conversation names include only loaded joined conversations.</p>
        )}
        {query.trim() &&
          !scopedChannelId &&
          (publicChannels.partial || operatorPublicChannels.partial) && (
            <p>Only the newest open channels were searched.</p>
          )}
        {!scopedChannelId && publicChannels.error && (
          <div>
            <p>{publicChannels.error}</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={retryFromInput(publicChannels.retry)}
            >
              Retry channels
            </Button>
          </div>
        )}
        {operatorLookupError && (
          <div>
            <p>{operatorLookupError}</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={retryFromInput(operatorPublicChannels.retry)}
            >
              Retry channels
            </Button>
          </div>
        )}
        {personOpen && (
          <p role={personOpen.error ? "alert" : undefined}>
            {personOpen.error ??
              `Opening your conversation with ${personOpen.name}…`}
          </p>
        )}
        {peopleActive && personDirectory.error && (
          <div>
            <p>Couldn’t search community people.</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={retryFromInput(personDirectory.retry)}
            >
              Retry people
            </Button>
          </div>
        )}
        {search.moreError && <p>{search.moreError}</p>}
        {search.error && (
          <div>
            <p>{search.error}</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={retryFromInput(search.retry)}
            >
              Retry messages
            </Button>
          </div>
        )}
      </div>
      <p className="sr-only" role={searchAnnouncement ? "status" : undefined}>
        {searchAnnouncement}
      </p>
    </SearchChoices>
  );
}
