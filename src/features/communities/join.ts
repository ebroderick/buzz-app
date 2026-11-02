import { communityRequest, inspectProfile, publishProfile } from "./api";
import type { JoinConsent } from "./FindCommunity";
import type { createJoinJournal, PendingJoin } from "./join-journal";
import type { JoinPolicy } from "./join-policy";
import { profileDefault } from "./profile-default";
import { profilesEqual } from "./ProfileFields";
import type { Communities, Membership, PersonalProfile } from "./service";
import { readErrorKind } from "../relay/errors";

// Exact relay claim refusal codes, forwarded unchanged by the broker.
export const CLAIM_REFUSALS = {
  invite_expired: "This invite code has expired — ask for a new one.",
  invite_exhausted:
    "This invite has reached its use limit. Ask for a new invite.",
  invite_invalid: "This invite code is not valid for this community.",
  join_policy_required:
    "This community requires current policy acceptance. Go back and reopen the relay to review it.",
  join_policy_not_accepted:
    "The community policy changed. Go back and reopen the relay to review it.",
};

/** The copy for a relay claim refusal; `undefined` for any other failure. */
export function claimRefusal(reason: unknown) {
  return reason instanceof Error &&
    Object.hasOwn(CLAIM_REFUSALS, reason.message)
    ? CLAIM_REFUSALS[reason.message as keyof typeof CLAIM_REFUSALS]
    : undefined;
}

export type JoinJournal = ReturnType<typeof createJoinJournal>;
/** Whether a caller still wants the outcome: mounted, and `entry` (when given)
 * is still the journal's current record for its destination. */
export type Current = (entry?: PendingJoin) => boolean;
export type Admission = {
  /** The journal record to finish with the membership; absent without a journal. */
  entry?: PendingJoin;
  found: Awaited<ReturnType<typeof inspectProfile>>;
};

/**
 * The Add-a-community dialog's access step: when the journal holds a pending
 * entry, read before reclaiming (a lost claim reply may already have admitted
 * this key, even once its invite expired); otherwise journal the join before
 * any remote effect, so a storage failure blocks the claim, then accept the
 * policy, claim the code (when given) and prove admission with the signed
 * profile read. `undefined` means a `current` fence stopped the caller.
 */
export async function admitCommunity({
  community,
  journal,
  code,
  policy,
  consent,
  current,
}: {
  community: string;
  journal?: JoinJournal | undefined;
  code: string;
  policy?: JoinPolicy | null | undefined;
  consent: JoinConsent;
  current: Current;
}): Promise<Admission | undefined> {
  const pending = journal?.get(community);
  if (pending) {
    // A lost claim response may already have admitted this identity, even
    // when its invite has since expired. Read before attempting another claim.
    const found = await inspectProfile(community).catch((reason: unknown) => {
      if (readErrorKind(reason) !== "denied") throw reason;
      return undefined;
    });
    if (!current(pending)) return undefined;
    if (found) return { found, entry: pending };
  }
  const transaction = journal?.begin(community);
  if (code.trim()) {
    const receipt = policy
      ? (
          await communityRequest<{ receipt: string }>(
            community,
            "accept-policy",
            {
              code: code.trim(),
              policy_version: policy.version,
              age_confirmed: consent.adult,
            },
          )
        ).receipt
      : undefined;
    if (!current(transaction)) return undefined;
    const claim = await communityRequest<{ status: string }>(
      community,
      "claim",
      { code: code.trim(), policy_receipt: receipt },
    ).catch((reason: unknown) => {
      const known = claimRefusal(reason);
      throw known ? new Error(known) : reason;
    });
    if (!["joined", "already_member"].includes(claim.status))
      throw new Error("Membership was not confirmed");
  }
  if (!current(transaction)) return undefined;
  const found = await inspectProfile(community);
  if (!current(transaction)) return undefined;
  return { found, ...(transaction ? { entry: transaction } : {}) };
}

/**
 * The dialog's profile step: with `publish`, journal the draft, read the
 * profile afresh (native only; the browser path keeps the admission's read),
 * publish only when it differs, read it back to confirm the accepted event is
 * current, then save the membership last and clear the journal. Without
 * `publish` there is no remote write to confirm, so the membership is saved
 * with the relay's profile (or the local default) and `entry` is finished.
 * `false` means a `current` fence stopped the caller.
 */
export async function completeJoin({
  community,
  membership,
  found,
  journal,
  entry,
  publish,
  communities,
  current,
}: {
  community: string;
  membership: Membership;
  found: Admission["found"];
  journal?: JoinJournal | undefined;
  entry?: PendingJoin | undefined;
  publish?: PersonalProfile | undefined;
  communities: Pick<Communities, "joined" | "snapshot">;
  current: Current;
}): Promise<boolean> {
  let transaction = entry;
  let next: PersonalProfile;
  if (publish) {
    transaction = journal?.begin(community, publish);
    const read = journal ? await inspectProfile(community) : found;
    if (!current(transaction)) return false;
    next =
      read.exists && profilesEqual(publish, read.profile)
        ? publish
        : {
            ...publish,
            name: publish.name.trim(),
            about: publish.about?.trim() ?? "",
          };
    if (!read.exists || !profilesEqual(next, read.profile)) {
      await publishProfile(community, next, read.existing ?? {});
      if (!current(transaction)) return false;
      // An accepted replaceable event may already be superseded.
      const confirmed = await inspectProfile(community);
      if (!current(transaction)) return false;
      if (!confirmed.exists || !profilesEqual(confirmed.profile, next))
        throw new Error(
          "Your profile change is not current. Your edits are retained; try again.",
        );
    }
  } else {
    next = found.exists ? found.profile : communities.snapshot().profile;
  }
  if (!current(transaction)) return false;
  communities.joined(
    membership,
    profileDefault(next, communities.snapshot().profile, community),
  );
  if (transaction) journal?.finish(transaction);
  return true;
}
