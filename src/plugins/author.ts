// FOUNDATION: Type-only author entry. Runtime capabilities come from injected ctx.
export type { AgentHook, AgentHookContext } from "../features/agents/hooks";
export type { PluginManifest, PluginModule } from "./api";
export type { SettingsCard, SettingsCards } from "../features/settings/service";
export type { Context } from "@deepseek-ai/cordis";
export type {
  Host,
  HostRequest,
  HostByteUpload,
  HostRequestOnceOptions,
  HostResponse,
  HostByteRequest,
  HostByteResponse,
  HostSavedBytes,
  HostMcpServer,
  McpHandler,
} from "../features/host/service";
export type {
  IdentityNames,
  NamingPolicy,
} from "../features/identity-names/service";
export type { NamingIdentity } from "../features/identity-names/policy";
export type { Browser, BrowserViewProps } from "../features/browser/api";
export type {
  Page,
  PagePreviewProps,
  PageSidebarProps,
  Pages,
} from "../features/pages/service";
export type {
  SidebarRow,
  SidebarRowSortMode,
  SidebarRowContribution,
  SidebarRows,
} from "../features/channel-navigation/sidebar-rows-service";
export type {
  SidebarSectionAction,
  SidebarSectionContribution,
  SidebarSectionRow,
  SidebarSections,
} from "../features/channel-navigation/sidebar-sections-service";
export type {
  PluginInstallOutcome,
  PluginInstallSource,
  PluginInstaller,
} from "./installer";
export type {
  SidebarRestriction,
  SidebarScope,
} from "../features/channel-navigation/sidebar-scope-service";
export type {
  Panel,
  Panels,
  ChannelPanelContext,
  ChannelLauncherProps,
} from "../features/panels/service";
export type { Conversation } from "../features/conversation/service";
export type {
  ComposerObservation,
  CompletionContext,
  CompletionQuery,
  CompletionEdit,
  CompletionSuggestion,
  CompletionResult,
  ComposerCompletionProps,
  ComposerCompletion,
  ComposerAccessory,
  ComposerAccessoryProps,
  ComposerResource,
  ComposerCaptureProps,
  AttachmentRenderer,
  AttachmentRendererProps,
  ComposerToolProps,
  ComposerTool,
  InlineContent,
  InlineRange,
  InlineRenderer,
  LinkRenderer,
  MessageRenderer,
  MessageAction,
  TargetOpener,
} from "../features/conversation/contracts";
export type { RelayData, RelaySnapshot } from "../features/relay/service";
export type {
  ArtifactSyncFilter,
  ArtifactSyncSnapshot,
  ArtifactSyncStatus,
  ArtifactSyncView,
} from "../features/relay/artifact-sync";

export type {
  Shortcuts,
  Shortcut,
  KeyBinding,
  RegisteredShortcut,
} from "../features/shortcuts/service";

export type {
  UnreadCapability,
  UnreadSnapshot,
  ThreadActivityItem,
  ThreadActivitySnapshot,
  ReadingHandle,
} from "../features/relay/unread";
export type { ReadTarget } from "../features/relay/read-state-model";
export type {
  ReadMutationResult,
  ReadSyncSnapshot,
} from "../features/relay/read-state";

export type {
  Decisions,
  DecisionProvider,
  DecisionProviderStatus,
  DecisionReply,
  DecisionQuestion,
  DecisionRequest,
  DecisionAnswer,
  DecisionFailure,
  DecisionResult,
} from "../features/decisions/service";

export type {
  Navigation,
  NavigationSnapshot,
  OpenResult,
  OpenFailure,
} from "../features/navigation/controller";
export type {
  OpenTarget,
  NavigationScope,
  JsonValue,
} from "../features/navigation/targets";
export type { PageNavigation } from "../features/navigation/service";

export type {
  Notifications,
  NotificationInput,
  NotificationCategoryDescriptor,
  NotificationGate,
} from "../features/notifications/service";

export type { VoiceRecording } from "../features/relay/voice-media";

export type {
  Agents,
  AgentAddedTab,
  AgentHandle,
  AgentType,
  AgentSession,
  AgentSessions,
  Delivery,
  StandaloneTurn,
  TurnResult,
} from "../features/agents/service";
export type {
  HarnessConversation,
  HarnessKit,
  HarnessPrompt,
  HarnessScope,
} from "../features/agent-harness/kit";

export type { ArtifactStorage } from "../features/artifact-storage/service";
export type {
  ArtifactCollection,
  ArtifactCollectionDefinition,
  ArtifactEntry,
  ArtifactIndex,
  ArtifactPage,
  ArtifactPageQuery,
  ArtifactRevision,
  ArtifactAvailability,
  SavedArtifact,
  ArtifactImport,
} from "../features/artifact-storage/types";

export type {
  SoloNavigation,
  SoloRegionBinding,
  SoloRegionSnapshot,
  SoloRegionAction,
  SoloRegionSource,
  SoloChatInput,
  SoloRegionHandle,
  SoloRegionProps,
  SoloConversationProps,
  SoloConversation,
  SoloConversationLinkProps,
  SoloCardProps,
  SoloDisclosureProps,
} from "../features/channel-navigation/solo-navigation-contract";

export type {
  FederatedIdentity,
  SessionSnapshot,
  AuthenticatedRequest,
} from "../features/federated-identity/service";

export type { AddedTool } from "../buzz-mcp/session-tools";
export type {
  BuzzClient,
  Media,
  Context as AddedToolContext,
} from "../buzz-mcp/client";
export type { Reply as AddedToolReply } from "../buzz-mcp/tools";
