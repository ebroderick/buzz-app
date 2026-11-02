import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Dialog, type DialogProps } from "../../shared/design-system/ui/Dialog";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { communityName } from "./community-name";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Button } from "../../shared/design-system/ui/Button";
import { communityRequest, inspectProfile, type CommunityInfo } from "./api";
import type { Communities, PersonalProfile } from "./service";
import { canSaveProfile, ProfileFields, profilesEqual } from "./ProfileFields";
import { communityDestination, relayOrigin } from "./destination";
import { nativeIdentityEnabled } from "../identity/service";
import { readErrorKind } from "../relay/errors";
import { createJoinJournal, type PendingJoin } from "./join-journal";
import { admitCommunity, completeJoin, type Current } from "./join";
import { CommunitySignIn } from "../federated-identity/CommunitySignIn";
import type { FederatedIdentity } from "../federated-identity/service";
import { OnboardingBack } from "../identity/OnboardingBack";
import { OnboardingScreen } from "../identity/OnboardingScreen";
import styles from "./Communities.module.css";

export function CommunityDialog({
  communities,
  mode,
  close,
  onJoined,
  invite,
  connectionFrom,
  submittedDestination = false,
  onboarding = false,
  federatedIdentity,
}: {
  communities: Communities;
  /** Offers protected-community sign-in when admission refuses for it. */
  federatedIdentity?: FederatedIdentity | undefined;
  mode: "join" | "profile";
  close(): void;
  onJoined?: (id: string) => void;
  /** A deliberate connection edit uses the same admission flow, never rekeys existing data. */
  connectionFrom?: string;
  /** The landing form already submitted this destination. */
  submittedDestination?: boolean;
  onboarding?: boolean;
  invite?:
    | Readonly<{
        community: string;
        code: string;
      }>
    | undefined;
}) {
  const BackControl = onboarding ? OnboardingBack : Button;
  const formId = useId();
  const destinationInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const touchOpening = useRef(false);
  const focusFrom = useRef<Element | null>(null);
  const focusProfile = useRef(false);
  const client = communities.snapshot();
  const unavailable =
    client.status !== "ready" || (mode === "join" && !client.relayAvailable);
  const [journal] = useState(() =>
    mode === "join" && nativeIdentityEnabled() && client.viewer
      ? createJoinJournal(client.viewer)
      : undefined,
  );
  const [recovery] = useState(() => {
    try {
      return { pending: journal?.latest(), error: "" };
    } catch (reason) {
      return { pending: undefined, error: String(reason) };
    }
  });
  const [url, setUrl] = useState(
    connectionFrom ??
      invite?.community ??
      (recovery.pending
        ? communityDestination(recovery.pending.community).url
        : ""),
  );
  const [destination, setDestination] =
    useState<ReturnType<typeof communityDestination>>();
  const id = destination?.id ?? "";
  const [step, setStep] = useState<"destination" | "access" | "profile">(
    mode === "profile" ? "profile" : "destination",
  );
  const [info, setInfo] = useState<CommunityInfo>();
  const [profile, setProfile] = useState<PersonalProfile>(client.profile);
  const [original, setOriginal] =
    useState<Awaited<ReturnType<typeof inspectProfile>>>();
  const [code, setCode] = useState(invite?.code ?? "");
  const [needsInvite, setNeedsInvite] = useState(!!invite?.code);
  const [agreed, setAgreed] = useState(false);
  const [adult, setAdult] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(recovery.error);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function work(action: () => Promise<void>) {
    focusFrom.current = document.activeElement;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      if (mounted.current) {
        if (
          step === "access" &&
          info?.membershipRequired === true &&
          readErrorKind(reason) === "denied"
        )
          setNeedsInvite(true);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  useLayoutEffect(() => {
    if (busy || step !== "profile" || !focusProfile.current) return;
    focusProfile.current = false;
    // The submitted step owns this handoff only while focus has not moved elsewhere.
    if (
      !touchOpening.current &&
      (document.activeElement === focusFrom.current ||
        document.activeElement === document.body)
    )
      nameInput.current?.focus();
  }, [busy, step]);
  const startedDestination = useRef(false);
  useEffect(() => {
    if (!submittedDestination || startedDestination.current || unavailable)
      return;
    startedDestination.current = true;
    void submit();
  });
  const policy = info?.policy;
  const allowed =
    (!policy?.age_attestation_required || adult) &&
    (!(policy?.terms_markdown || policy?.privacy_markdown) || agreed);
  const current: Current = (entry) =>
    mounted.current && (!entry || journal?.current(entry) === true);
  function showProfile(
    found: Awaited<ReturnType<typeof inspectProfile>>,
    pending?: PendingJoin,
  ) {
    setOriginal(found);
    setProfile(
      pending?.profile ?? (found.exists ? found.profile : client.profile),
    );
    focusProfile.current = true;
    setStep("profile");
  }
  async function submit() {
    if (uploading || unavailable) return;
    if (step === "destination") {
      await work(async () => {
        const next = communityDestination(relayOrigin(url));
        setDestination(next);
        const value = await communityRequest<CommunityInfo>(next.id, "info");
        if (!mounted.current) return;
        const pending = journal?.get(next.id);
        // Restoring an existing admitted profile is not a new join or policy acceptance.
        const found = await inspectProfile(next.id).catch((reason: unknown) => {
          if (pending && readErrorKind(reason) !== "denied") throw reason;
          if (
            mounted.current &&
            value.membershipRequired === true &&
            readErrorKind(reason) === "denied"
          )
            setNeedsInvite(true);
          return undefined;
        });
        if (current(pending)) {
          setInfo(value);
          if (found && (found.exists || pending)) showProfile(found, pending);
          else setStep("access");
        }
      });
    } else if (step === "access") {
      if (!allowed) return;
      await work(async () => {
        const admission = await admitCommunity({
          community: id,
          journal,
          code,
          policy,
          consent: { adult, agreed },
          current,
        });
        if (admission) showProfile(admission.found, admission.entry);
      });
    } else {
      if (!profile.name.trim()) return;
      await work(async () => {
        if (mode === "profile")
          communities.saveProfile({ ...profile, name: profile.name.trim() });
        else {
          if (!destination || !original)
            throw new Error("Choose a community first");
          const done = await completeJoin({
            community: id,
            membership: {
              id,
              name:
                info?.name && info.name !== "Buzz Relay"
                  ? info.name
                  : destination.name,
              ...(info?.icon?.startsWith("https://")
                ? { icon: info.icon }
                : {}),
            },
            found: original,
            journal,
            publish: profile,
            communities,
            current,
          });
          if (!done) return;
          onJoined?.(id);
        }
        close();
      });
    }
  }
  // Keeping an existing community profile publishes nothing, so it needs no edit validation.
  const keepsProfile =
    mode === "join" &&
    !!original?.exists &&
    profilesEqual(profile, original.profile);
  return (
    <JoinSurface
      onboarding={onboarding}
      open
      dismissOnOutsideClick={false}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      preventClose={busy}
      initialFocus={(type) => {
        // Controlled entry has no Base UI trigger to report touch modality.
        touchOpening.current =
          type === "touch" ||
          !!window.matchMedia?.("(pointer: coarse)").matches;
        const field =
          step === "destination"
            ? destinationInput.current
            : step === "profile"
              ? nameInput.current
              : null;
        return touchOpening.current
          ? (field?.closest<HTMLElement>('[role="dialog"]') ?? null)
          : field;
      }}
      description={
        unavailable
          ? undefined
          : step === "destination"
            ? connectionFrom
              ? "Enter a wss:// or https:// relay address without a path. Changing the connection URL does not rename or move this community."
              : "Use your identity across communities. Your profile and conversations stay separate in each one."
            : step === "access"
              ? destination && (
                  <span className="flex items-center gap-3 rounded-[var(--radius-row)] bg-surface-inset p-4">
                    {info?.icon && (
                      <Avatar
                        alt=""
                        src={info.icon}
                        fallback={communityName(info.name, destination.name)}
                        shape="squircle"
                        size="large"
                      />
                    )}
                    <span className="min-w-0 flex-1 break-words text-body text-standard">
                      <span>{communityName(info?.name, destination.name)}</span>
                      <span className="block break-all text-body-sm text-subtle">
                        {destination.url}
                      </span>
                    </span>
                  </span>
                )
              : mode === "profile"
                ? "Your local default. Use it when joining communities; saving here does not publish changes to them."
                : original?.exists
                  ? undefined
                  : "Start with your local profile, or choose how you appear in this community."
      }
      leadingActions={
        !unavailable && (
          <BackControl
            type="button"
            disabled={busy || uploading}
            onClick={() => {
              if (
                step === "destination" ||
                mode === "profile" ||
                (submittedDestination && step === "access")
              )
                close();
              else {
                setError("");
                setStep(step === "profile" ? "access" : "destination");
                setAgreed(false);
                setAdult(false);
              }
            }}
          >
            {onboarding ? undefined : "Back"}
          </BackControl>
        )
      }
      actions={
        !unavailable && (
          <Button
            variant="prominent"
            {...(onboarding ? { size: "lg" as const } : {})}
            type="submit"
            form={formId}
            disabled={
              busy ||
              uploading ||
              (step === "access" && !allowed) ||
              (step === "profile" &&
                (keepsProfile
                  ? !profile.name.trim()
                  : !canSaveProfile(profile)))
            }
          >
            {busy
              ? "Working…"
              : step === "profile"
                ? mode === "profile"
                  ? "Save profile"
                  : keepsProfile
                    ? "Continue"
                    : "Publish profile & open"
                : "Continue"}
          </Button>
        )
      }
      title={
        mode === "profile"
          ? "Your profile"
          : step === "profile"
            ? "Your profile"
            : connectionFrom
              ? "Edit connection"
              : "Join a community"
      }
    >
      <form
        id={formId}
        noValidate
        className="w-full space-y-6 text-left"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {unavailable ? (
          <p>
            {client.status === "loading"
              ? "Opening your local identity…"
              : client.status === "ready"
                ? "Your identity is ready, but connecting to communities is not available in this build yet. You can manage your local profile and identity in Settings."
                : "Live identity access is unavailable. For development, set BUZZ_DEV_VIEWER to your Buzz public key in .env.local, then restart just web or just desktop. See docs/contributing.md for requirements."}
          </p>
        ) : (
          <>
            {step === "destination" && submittedDestination && busy ? (
              <p role="status">Finding your community…</p>
            ) : (
              step === "destination" && (
                <Field
                  label="Community URL"
                  error={error || undefined}
                  description={
                    connectionFrom
                      ? undefined
                      : "Paste your community link. Continue shares your Buzz identity with the community so you can preview it before joining."
                  }
                >
                  <Input
                    ref={destinationInput}
                    type="url"
                    required
                    autoComplete="url"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="wss://communities.buzz.xyz"
                    maxLength={2048}
                    disabled={busy}
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setDestination(undefined);
                      setCode("");
                      setNeedsInvite(false);
                      setAgreed(false);
                      setAdult(false);
                      setInfo(undefined);
                      setOriginal(undefined);
                      setProfile(client.profile);
                      setError("");
                    }}
                  />
                </Field>
              )
            )}
            {step === "access" && (
              <>
                {needsInvite && (
                  <Field label="Invite code">
                    <Input
                      disabled={busy}
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      maxLength={256}
                    />
                  </Field>
                )}
                {policy && (
                  <div className={styles.policy}>
                    {(policy.terms_markdown || policy.privacy_markdown) && (
                      <Checkbox
                        checked={agreed}
                        aria-label={`I agree to this community’s ${[policy.terms_markdown && "Terms of Service", policy.privacy_markdown && "Privacy Notice"].filter(Boolean).join(" and ")}.`}
                        onCheckedChange={setAgreed}
                        label={
                          <>
                            I agree to this community’s{" "}
                            {policy.terms_markdown && (
                              <a
                                className="underline"
                                href={`${destination?.url}/api/join-policy/terms`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Terms of Service
                              </a>
                            )}
                            {policy.terms_markdown &&
                              policy.privacy_markdown &&
                              " and "}
                            {policy.privacy_markdown && (
                              <a
                                className="underline"
                                href={`${destination?.url}/api/join-policy/privacy`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Privacy Notice
                              </a>
                            )}
                            .
                          </>
                        }
                      />
                    )}
                    {policy.age_attestation_required && (
                      <Checkbox
                        checked={adult}
                        onCheckedChange={setAdult}
                        label="I confirm that I am at least 18 years old."
                      />
                    )}
                  </div>
                )}
              </>
            )}
            {step === "profile" && (
              <ProfileFields
                showAbout={!onboarding}
                {...(onboarding
                  ? { emptyAvatarStyle: "dotted-circle" as const }
                  : {})}
                nameRef={nameInput}
                community={mode === "profile" ? undefined : id}
                onBusyChange={setUploading}
                profile={profile}
                onChange={setProfile}
                disabled={busy}
              />
            )}
            {error && step !== "destination" && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
            {error && (
              <CommunitySignIn
                identity={federatedIdentity}
                error={error}
                // Sign-in only clears the refusal: Continue then runs the current
                // step with current input, never one captured before the login.
                retry={() => setError("")}
              />
            )}
          </>
        )}
      </form>
    </JoinSurface>
  );
}

/** First-run joins share the admission form with Add community, without a modal. */
function JoinSurface({
  onboarding,
  ...props
}: DialogProps & { onboarding: boolean }) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (onboarding && props.title) heading.current?.focus();
  }, [onboarding, props.title]);
  if (!onboarding) return <Dialog {...props} />;
  return (
    <OnboardingScreen
      labelledBy={titleId}
      intro={
        <>
          <h1 ref={heading} tabIndex={-1} id={titleId} className="text-heading">
            {props.title}
          </h1>
          {props.description && (
            <p className="text-body text-subtle">{props.description}</p>
          )}
        </>
      }
    >
      {props.children}
      <div data-onboarding-actions="" className="w-full">
        {props.leadingActions}
        {props.actions}
      </div>
    </OnboardingScreen>
  );
}
