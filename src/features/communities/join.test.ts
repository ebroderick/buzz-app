// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { communityRequest, inspectProfile, publishProfile } from "./api";
import { admitCommunity, CLAIM_REFUSALS, completeJoin } from "./join";
import { createJoinJournal } from "./join-journal";
import type { Communities, PersonalProfile } from "./service";

vi.mock("./api", () => ({
  communityRequest: vi.fn(),
  inspectProfile: vi.fn(),
  publishProfile: vi.fn(),
}));

const viewer = "a".repeat(64);
const community = "https://relay.example.com";
const key = `buzz-community-joins.v1:${viewer}`;
const policy = { version: "2026-10", age_attestation_required: true };
const consent = { adult: true, agreed: true };
const none = {
  existing: {},
  profile: { name: "", picture: "", about: "" },
  exists: false,
};
const held = (profile: PersonalProfile) => ({
  existing: { name: profile.name },
  profile,
  exists: true,
});
const denied = () => Promise.reject(new Error("Relay read failed (403)"));
const entries = () => JSON.parse(localStorage.getItem(key) ?? "[]");
/** Every remote call, journal write and saved membership, in order. */
let sequence: string[];
function communities(profile = none.profile) {
  return {
    joined: vi.fn(() => {
      sequence.push("joined");
    }),
    snapshot: () => ({ profile }) as ReturnType<Communities["snapshot"]>,
  };
}
beforeEach(() => {
  localStorage.clear();
  sequence = [];
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    name,
    value,
  ) {
    sequence.push("setItem");
    Reflect.set(this, name, value);
  });
  vi.mocked(communityRequest).mockImplementation(async (_id, route) => {
    sequence.push(route);
    return route === "accept-policy"
      ? { receipt: "policy-receipt" }
      : { status: "joined" };
  });
  vi.mocked(inspectProfile).mockImplementation(async () => {
    sequence.push("read");
    return none;
  });
  vi.mocked(publishProfile).mockImplementation(async () => {
    sequence.push("publish");
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it("journals the join before any remote effect, then accepts the policy, claims and reads", async () => {
  const journal = createJoinJournal(viewer);
  const admission = await admitCommunity({
    community,
    journal,
    code: " CODE ",
    policy,
    consent,
    current: () => true,
  });
  expect(sequence).toEqual(["setItem", "accept-policy", "claim", "read"]);
  expect(communityRequest).toHaveBeenNthCalledWith(
    1,
    community,
    "accept-policy",
    { code: "CODE", policy_version: "2026-10", age_confirmed: true },
  );
  expect(communityRequest).toHaveBeenNthCalledWith(2, community, "claim", {
    code: "CODE",
    policy_receipt: "policy-receipt",
  });
  expect(admission).toEqual({ found: none, entry: entries()[0] });
  expect(entries()).toEqual([{ id: expect.any(String), community }]);
});

it("sends nothing when the journal record cannot be persisted", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  await expect(
    admitCommunity({
      community,
      journal: createJoinJournal(viewer),
      code: "CODE",
      policy,
      consent,
      current: () => true,
    }),
  ).rejects.toThrow(
    "Could not save community setup on this device. Free storage and try again.",
  );
  expect(communityRequest).not.toHaveBeenCalled();
  expect(inspectProfile).not.toHaveBeenCalled();
});

it("reads before reclaiming a pending join and keeps its entry when the key is admitted", async () => {
  const journal = createJoinJournal(viewer);
  const pending = journal.begin(community);
  sequence = [];
  const admission = await admitCommunity({
    community,
    journal,
    code: "EXPIRED",
    policy,
    consent,
    current: () => true,
  });
  expect(sequence).toEqual(["read"]);
  expect(admission).toEqual({ found: none, entry: pending });
  expect(entries()).toEqual([pending]);
});

it("claims again when the pending join's read is denied, replacing its entry", async () => {
  const journal = createJoinJournal(viewer);
  const pending = journal.begin(community);
  vi.mocked(inspectProfile)
    .mockImplementationOnce(() => {
      sequence.push("read");
      return denied();
    })
    .mockImplementationOnce(async () => {
      sequence.push("read");
      return held({ name: "Ada", picture: "", about: "" });
    });
  const admission = await admitCommunity({
    community,
    journal,
    code: "CODE",
    policy: null,
    consent,
    current: () => true,
  });
  expect(sequence).toEqual(["setItem", "read", "setItem", "claim", "read"]);
  expect(communityRequest).toHaveBeenCalledTimes(1);
  expect(communityRequest).toHaveBeenCalledWith(community, "claim", {
    code: "CODE",
    policy_receipt: undefined,
  });
  expect(admission?.entry?.id).not.toBe(pending.id);
  expect(entries()).toEqual([admission?.entry]);
});

it("maps a relay refusal to its copy and rethrows anything else", async () => {
  const refuse = (message: string) =>
    vi.mocked(communityRequest).mockRejectedValueOnce(new Error(message));
  refuse("invite_expired");
  await expect(
    admitCommunity({ community, code: "CODE", consent, current: () => true }),
  ).rejects.toThrow(CLAIM_REFUSALS.invite_expired);
  refuse("Community request failed (502)");
  await expect(
    admitCommunity({ community, code: "CODE", consent, current: () => true }),
  ).rejects.toThrow("Community request failed (502)");
  expect(inspectProfile).not.toHaveBeenCalled();
});

it("rejects a claim that neither joined nor found an existing member", async () => {
  vi.mocked(communityRequest).mockResolvedValueOnce({ status: "pending" });
  await expect(
    admitCommunity({ community, code: "CODE", consent, current: () => true }),
  ).rejects.toThrow("Membership was not confirmed");
  expect(inspectProfile).not.toHaveBeenCalled();
});

it("skips the claim without a code and stops at a fence before reading", async () => {
  const current = vi.fn(() => false);
  await expect(
    admitCommunity({ community, code: "  ", consent, current }),
  ).resolves.toBeUndefined();
  expect(communityRequest).not.toHaveBeenCalled();
  expect(inspectProfile).not.toHaveBeenCalled();
});

it("saves the membership without publishing when the fresh read already matches", async () => {
  const journal = createJoinJournal(viewer);
  const profile = { name: "Ada", picture: "", about: "" };
  vi.mocked(inspectProfile).mockImplementation(async () => {
    sequence.push("read");
    return held(profile);
  });
  const service = communities();
  await expect(
    completeJoin({
      community,
      membership: { id: community, name: "relay.example.com" },
      found: none,
      journal,
      publish: { ...profile, name: " Ada " },
      communities: service,
      current: () => true,
    }),
  ).resolves.toBe(true);
  expect(sequence).toEqual(["setItem", "read", "joined", "setItem"]);
  expect(publishProfile).not.toHaveBeenCalled();
  expect(service.joined).toHaveBeenCalledWith(
    { id: community, name: "relay.example.com" },
    { name: "Ada", picture: "", about: "" },
  );
  expect(entries()).toEqual([]);
});

it("publishes a differing profile, confirms it by readback, then saves the membership last", async () => {
  const journal = createJoinJournal(viewer);
  const next = { name: "Ada", picture: "", about: "" };
  vi.mocked(inspectProfile)
    .mockImplementationOnce(async () => {
      sequence.push("read");
      return none;
    })
    .mockImplementationOnce(async () => {
      sequence.push("read");
      return held(next);
    });
  const service = communities();
  await expect(
    completeJoin({
      community,
      membership: { id: community, name: "relay.example.com" },
      found: none,
      journal,
      publish: { name: " Ada ", picture: "", about: " " },
      communities: service,
      current: () => true,
    }),
  ).resolves.toBe(true);
  expect(sequence).toEqual([
    "setItem",
    "read",
    "publish",
    "read",
    "joined",
    "setItem",
  ]);
  expect(publishProfile).toHaveBeenCalledWith(community, next, {});
  expect(service.joined).toHaveBeenCalledWith(
    { id: community, name: "relay.example.com" },
    next,
  );
  expect(entries()).toEqual([]);
});

it("retains the journaled draft and saves nothing when the readback is not current", async () => {
  const journal = createJoinJournal(viewer);
  const publish = { name: "Ada", picture: "", about: "" };
  vi.mocked(inspectProfile)
    .mockResolvedValueOnce(none)
    .mockResolvedValueOnce(held({ name: "Someone else", picture: "" }));
  const service = communities();
  await expect(
    completeJoin({
      community,
      membership: { id: community, name: "relay.example.com" },
      found: none,
      journal,
      publish,
      communities: service,
      current: () => true,
    }),
  ).rejects.toThrow(
    "Your profile change is not current. Your edits are retained; try again.",
  );
  expect(publishProfile).toHaveBeenCalledTimes(1);
  expect(service.joined).not.toHaveBeenCalled();
  expect(entries()).toEqual([
    { id: expect.any(String), community, profile: publish },
  ]);
});

it("neither saves the membership nor clears the journal once fenced", async () => {
  const journal = createJoinJournal(viewer);
  const service = communities();
  let fenced = false;
  vi.mocked(publishProfile).mockImplementation(async () => {
    fenced = true;
  });
  await expect(
    completeJoin({
      community,
      membership: { id: community, name: "relay.example.com" },
      found: none,
      journal,
      publish: { name: "Ada", picture: "", about: "" },
      communities: service,
      current: () => !fenced,
    }),
  ).resolves.toBe(false);
  expect(inspectProfile).toHaveBeenCalledTimes(1);
  expect(service.joined).not.toHaveBeenCalled();
  expect(entries()).toHaveLength(1);
});

it("saves the membership with the relay's profile and finishes the admission entry when nothing is published", async () => {
  const journal = createJoinJournal(viewer);
  const entry = journal.begin(community);
  const relay = { name: "Ada", picture: `${community}/media/a.png` };
  const service = communities({ name: "", picture: "local.png", about: "" });
  sequence = [];
  await expect(
    completeJoin({
      community,
      membership: { id: community, name: "relay.example.com" },
      found: held(relay),
      journal,
      entry,
      communities: service,
      current: () => true,
    }),
  ).resolves.toBe(true);
  expect(sequence).toEqual(["joined", "setItem"]);
  expect(inspectProfile).not.toHaveBeenCalled();
  expect(publishProfile).not.toHaveBeenCalled();
  // The same local-default rule as the dialog: this community's media stays out of it.
  expect(service.joined).toHaveBeenCalledWith(
    { id: community, name: "relay.example.com" },
    { name: "Ada", picture: "local.png" },
  );
  expect(entries()).toEqual([]);
});
