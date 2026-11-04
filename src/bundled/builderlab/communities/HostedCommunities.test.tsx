// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StrictMode, useState } from "react";
import { npubEncode } from "nostr-tools/nip19";
import { HostedCommunities } from "./HostedCommunities";
import { brokerApi, DELETION_PENDING_KEY } from "./api";

const local = "a".repeat(64);
const other = "b".repeat(64);
type Handler = (body: Record<string, string | number>) => unknown;
let routes: Record<string, Handler>;
let calls: [string, Record<string, string | number>][];

beforeEach(() => {
  localStorage.clear();
  calls = [];
  routes = {
    "/api/relay/identity": () => ({ viewer: local }),
    "/api/builderlab/auth": () => ({
      auth: {
        email: "a@example.com",
        name: "Ada",
        expiresAt: "2030",
        capabilities: { can_delete_buzz_communities: true },
      },
    }),
    "/api/builderlab/identity": () => ({ identity: { pubkey_hex: local } }),
    "/api/builderlab/list": () => ({
      communities: [],
      quota_used: 0,
      quota_limit: 5,
      can_create: true,
    }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push([url, body]);
      const handler = routes[url];
      if (!handler) return Response.json({ error: "missing" }, { status: 404 });
      const result = await handler(body);
      if (result instanceof Response) return result;
      return Response.json(result);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
// The dev app renders under StrictMode, which remounts effects once.
const renderCard = () =>
  render(
    <StrictMode>
      <HostedCommunities api={brokerApi} active={() => true} />
    </StrictMode>,
  );

function RerenderingParent() {
  const [, rerender] = useState(0);
  return (
    <>
      <button type="button" onClick={() => rerender((count) => count + 1)}>
        Parent update
      </button>
      <HostedCommunities api={brokerApi} active={() => true} />
    </>
  );
}

it("does not reload identity and list when the parent supplies new active closures", async () => {
  render(<RerenderingParent />);
  await screen.findByText(npubEncode(local));
  const identityReads = calls.filter(
    ([url]) => url === "/api/builderlab/identity",
  ).length;
  const listReads = calls.filter(
    ([url]) => url === "/api/builderlab/list",
  ).length;
  fireEvent.click(screen.getByRole("button", { name: "Parent update" }));
  fireEvent.click(screen.getByRole("button", { name: "Parent update" }));
  await act(async () => {});
  expect(
    calls.filter(([url]) => url === "/api/builderlab/identity"),
  ).toHaveLength(identityReads);
  expect(calls.filter(([url]) => url === "/api/builderlab/list")).toHaveLength(
    listReads,
  );
});

it("accepts a held deletion across parent rerenders and releases the busy state", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  const admission = hold();
  routes["/api/builderlab/delete"] = admission.answer as Handler;
  render(<RerenderingParent />);
  await confirmDeletion();
  await waitFor(() => expect(deletionPosts()).toHaveLength(1));
  const pending = deletionPosts()[0]?.[1];
  if (!pending) throw new Error("Expected the held deletion request");
  fireEvent.click(screen.getByRole("button", { name: "Parent update" }));
  fireEvent.click(screen.getByRole("button", { name: "Parent update" }));
  await act(async () =>
    admission.release(Response.json(accepted(pending), { status: 202 })),
  );
  expect(await screen.findByText("Deletion started")).toBeVisible();
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
});

it("does not abort a held sign-in on a parent rerender", async () => {
  routes["/api/builderlab/auth"] = () => ({ auth: null });
  const signIn = hold();
  routes["/api/builderlab/login"] = signIn.answer as Handler;
  const abort = vi.spyOn(AbortController.prototype, "abort");
  render(<RerenderingParent />);
  fireEvent.click(
    await screen.findByRole("button", { name: /Sign in with Builderlab/ }),
  );
  await waitFor(() =>
    expect(calls.map(([url]) => url)).toContain("/api/builderlab/login"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Parent update" }));
  expect(abort).not.toHaveBeenCalled();
  await act(async () =>
    signIn.release({
      auth: {
        expiresAt: "2030",
        capabilities: { can_delete_buzz_communities: true },
      },
    }),
  );
  await screen.findByText(npubEncode(local));
  expect(abort).not.toHaveBeenCalled();
});

it("offers browser sign-in when no Builderlab session exists", async () => {
  routes["/api/builderlab/auth"] = () => ({ auth: null });
  renderCard();
  expect(
    await screen.findByRole("button", { name: /Sign in with Builderlab/ }),
  ).toBeEnabled();
  expect(calls.map(([url]) => url)).not.toContain("/api/builderlab/list");
});

it("connects the Buzz identity when the account has none", async () => {
  routes["/api/builderlab/identity"] = () => ({
    error: { code: "missing_mapping", setup_needed: true },
  });
  routes["/api/builderlab/list"] = () => ({
    error: { code: "missing_mapping", setup_needed: true },
  });
  routes["/api/builderlab/bind"] = () => ({ identity: { pubkey_hex: local } });
  renderCard();
  fireEvent.click(
    await screen.findByRole("button", { name: "Connect Buzz identity" }),
  );
  routes["/api/builderlab/identity"] = () => ({
    identity: { pubkey_hex: local },
  });
  expect(await screen.findByText(npubEncode(local))).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("pauses create and offers a warned switch when the account uses another identity", async () => {
  routes["/api/builderlab/identity"] = () => ({
    identity: { pubkey_hex: other },
  });
  routes["/api/builderlab/unbind"] = () => ({});
  routes["/api/builderlab/bind"] = () => ({ identity: { pubkey_hex: local } });
  renderCard();
  const region = await screen.findByRole("region", {
    name: "Identity mismatch",
  });
  expect(region).toHaveTextContent(npubEncode(other));
  expect(region).toHaveTextContent(npubEncode(local));
  expect(screen.getByPlaceholderText("north-star")).toBeDisabled();
  routes["/api/builderlab/identity"] = () => ({
    identity: { pubkey_hex: local },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Switch to this device’s identity" }),
  );
  const warning = await screen.findByRole("alertdialog");
  expect(warning).toHaveTextContent(
    "It can never be linked to a Builderlab account again.",
  );
  expect(warning).toHaveTextContent(
    "If this device’s key was unlinked before, Builderlab refuses it too",
  );
  expect(calls.map(([url]) => url)).not.toContain("/api/builderlab/unbind");
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Switch identity",
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Identity mismatch" }),
    ).not.toBeInTheDocument(),
  );
  const order = calls.map(([url]) => url);
  expect(order.indexOf("/api/builderlab/unbind")).toBeLessThan(
    order.indexOf("/api/builderlab/bind"),
  );
});

it("checks availability after a pause and creates a valid community", async () => {
  routes["/api/builderlab/availability"] = () => ({ available: true });
  routes["/api/builderlab/create"] = () => ({
    community: { id: "c1", normalized_host: "north.communities.buzz.xyz" },
  });
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  renderCard();
  const input = await screen.findByPlaceholderText("north-star");
  await waitFor(() => expect(input).toBeEnabled());
  vi.useFakeTimers();
  fireEvent.change(input, { target: { value: "North" } });
  expect(input).toHaveValue("north");
  expect(input).toHaveAccessibleDescription(".communities.buzz.xyz");
  fireEvent.change(input, { target: { value: "-north" } });
  expect(input).toHaveAccessibleDescription(
    ".communities.buzz.xyz Use lowercase letters, numbers, and single hyphens.",
  );
  fireEvent.change(input, { target: { value: "North" } });
  expect(calls.map(([url]) => url)).not.toContain(
    "/api/builderlab/availability",
  );
  await act(() => vi.advanceTimersByTimeAsync(500));
  vi.useRealTimers();
  expect(
    await screen.findByText("That address is available."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create community" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("wss://north.communities.buzz.xyz"),
  );
  expect(calls).toContainEqual(["/api/builderlab/create", { name: "north" }]);
  expect(await screen.findByText(/Join a community/)).toBeInTheDocument();
});

it("rejects invalid names and blocks create at the community limit", async () => {
  routes["/api/builderlab/list"] = () => ({
    communities: Array.from({ length: 5 }, (_, index) => ({
      id: `c${index}`,
      name: `c${index}`,
      normalized_host: `c${index}.communities.buzz.xyz`,
    })),
    quota_used: 5,
    quota_limit: 5,
    can_create: false,
  });
  renderCard();
  expect(await screen.findByText("5 of 5 used")).toBeInTheDocument();
  expect(
    screen.getByText("You've reached your limit of 5 communities."),
  ).toBeVisible();
  expect(screen.getByPlaceholderText("north-star")).toBeDisabled();
});

it("honors can_create false independently of informational quota usage", async () => {
  routes["/api/builderlab/list"] = () => ({
    communities: [],
    quota_used: 0,
    quota_limit: 5,
    can_create: false,
  });
  renderCard();
  expect(await screen.findByText("0 of 5 used")).toBeVisible();
  expect(
    screen.getByText("You've reached your limit of 5 communities."),
  ).toBeVisible();
  expect(screen.getByPlaceholderText("north-star")).toBeDisabled();
  expect(calls.map(([url]) => url)).not.toContain("/api/builderlab/create");
});

it("archives and transfers after confirmation, surfacing friendly errors", async () => {
  routes["/api/builderlab/list"] = () => ({
    communities: [
      {
        id: "c1",
        name: "north",
        normalized_host: "north.communities.buzz.xyz",
      },
    ],
  });
  routes["/api/builderlab/archive"] = () => ({
    community: { id: "c1", archived_at: "2026-09-24" },
  });
  routes["/api/builderlab/transfer"] = () => ({
    error: { code: "transferee_not_registered" },
    correlation_id: "corr-1",
  });
  renderCard();
  fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Archive",
    }),
  );
  await waitFor(() =>
    expect(calls).toContainEqual([
      "/api/builderlab/archive",
      { community_id: "c1" },
    ]),
  );
  fireEvent.click(screen.getByRole("button", { name: "Transfer" }));
  const recipient = npubEncode(other);
  fireEvent.change(screen.getByPlaceholderText("npub1…"), {
    target: { value: recipient },
  });
  fireEvent.click(screen.getByRole("button", { name: "Transfer ownership" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "That person needs a connected Buzz identity before you can transfer ownership to them. Correlation ID: corr-1",
  );
  expect(calls).toContainEqual([
    "/api/builderlab/transfer",
    { communityId: "c1", transfereeNpub: recipient },
  ]);
  routes["/api/builderlab/transfer"] = () => ({
    error: { code: "limit_reached" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Transfer ownership" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The recipient has reached their community limit.",
  );
});

it("attributes transfer limit_reached to the recipient, not this owner's quota", async () => {
  routes["/api/builderlab/list"] = () => ({
    communities: [{ ...archived, archived_at: null }],
    quota_used: 1,
    quota_limit: 7,
    can_create: true,
  });
  routes["/api/builderlab/transfer"] = () =>
    Response.json({ error: { code: "limit_reached" } }, { status: 409 });
  renderCard();
  fireEvent.click(await screen.findByRole("button", { name: "Transfer" }));
  fireEvent.change(screen.getByPlaceholderText("npub1…"), {
    target: { value: npubEncode(other) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Transfer ownership" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The recipient has reached their community limit.",
  );
  expect(screen.getByRole("alert")).not.toHaveTextContent("your limit of 7");
});

it("shows the zero-limit copy without guessing a reason from usage", async () => {
  routes["/api/builderlab/list"] = () => ({
    communities: [],
    quota_used: 0,
    quota_limit: 0,
    can_create: false,
  });
  renderCard();
  expect(await screen.findByText("0 of 0 used")).toBeVisible();
  expect(
    screen.getByText("You can't create more communities right now."),
  ).toBeVisible();
  expect(screen.getByPlaceholderText("north-star")).toBeDisabled();
});

/** A route answer the test releases by hand. */
function hold() {
  let release!: (value: unknown) => void;
  const answer = new Promise((resolve) => {
    release = resolve;
  });
  return { answer: () => answer, release };
}

const renderShared = () =>
  render(
    <StrictMode>
      <HostedCommunities api={brokerApi} active={() => true} sharedSignIn />
    </StrictMode>,
  );

it("retries a failed shared-session account check in place", async () => {
  routes["/api/builderlab/auth"] = () =>
    Response.json({ error: "Builderlab is down" }, { status: 500 });
  renderShared();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Builderlab is down",
  );
  expect(calls.filter(([url]) => url === "/api/builderlab/list")).toHaveLength(
    0,
  );
  routes["/api/builderlab/auth"] = () => ({
    auth: { email: "a@example.com", expiresAt: "2030" },
  });
  routes["/api/builderlab/list"] = () => ({
    communities: [
      {
        id: "c1",
        name: "north",
        normalized_host: "north.communities.buzz.xyz",
      },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("north")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

it("drops a held account retry when the session replaces the card", async () => {
  const held = hold();
  const getAuth = vi
    .fn<typeof brokerApi.getAuth>()
    .mockRejectedValueOnce(new Error("Builderlab is down"))
    .mockReturnValueOnce(held.answer() as ReturnType<typeof brokerApi.getAuth>);
  const view = render(
    <HostedCommunities
      api={{ ...brokerApi, getAuth }}
      active={() => true}
      sharedSignIn
    />,
  );
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  try {
    await waitFor(() => expect(getAuth).toHaveBeenCalledTimes(2));
    // index.tsx keys the card by account, so a new session remounts it.
    view.unmount();
  } finally {
    held.release({ email: "a@example.com", expiresAt: "2030" });
  }
  // The retry's continuation runs before this one, so any load has started.
  await act(async () => {
    await held.answer();
  });
  expect(calls.filter(([url]) => url === "/api/builderlab/list")).toHaveLength(
    0,
  );
});

it("keeps create and copy paused until this device's key is read and matches", async () => {
  const device = hold();
  routes["/api/relay/identity"] = device.answer as Handler;
  routes["/api/builderlab/availability"] = () => ({ available: true });
  routes["/api/builderlab/list"] = () => ({
    communities: [
      {
        id: "c1",
        name: "north",
        normalized_host: "north.communities.buzz.xyz",
      },
    ],
  });
  renderCard();
  expect(
    await screen.findByText("Checking this device’s Buzz identity…"),
  ).toBeInTheDocument();
  expect(screen.getByPlaceholderText("north-star")).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Copy address" }),
  ).not.toBeInTheDocument();
  await act(async () => device.release({ viewer: other }));
  expect(
    await screen.findByRole("region", { name: "Identity mismatch" }),
  ).toHaveTextContent(
    "Your Builderlab account is linked to another Buzz key. Creating communities and copying addresses are paused until the identities match.",
  );
  expect(screen.getByPlaceholderText("north-star")).toBeDisabled();
});

it("pauses actions with a retry when this device's key cannot be read", async () => {
  routes["/api/relay/identity"] = () => {
    throw new Error("offline");
  };
  renderCard();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not read this device’s Buzz identity",
  );
  expect(screen.getByPlaceholderText("north-star")).toBeDisabled();
  routes["/api/relay/identity"] = () => ({ viewer: local });
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText(npubEncode(local))).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByPlaceholderText("north-star")).toBeEnabled(),
  );
});

it("ignores an older load that finishes after a newer identity change", async () => {
  const stale = hold();
  let first = true;
  routes["/api/builderlab/identity"] = () => {
    if (first) {
      first = false;
      return stale.answer();
    }
    return { identity: { pubkey_hex: local } };
  };
  routes["/api/builderlab/bind"] = () => ({ identity: { pubkey_hex: local } });
  renderCard();
  fireEvent.click(
    await screen.findByRole("button", { name: "Connect Buzz identity" }),
  );
  expect(await screen.findByText(npubEncode(local))).toBeInTheDocument();
  // The initial read, begun before Connect, reports an older binding.
  await act(async () => stale.release({ identity: { pubkey_hex: other } }));
  expect(
    screen.queryByRole("region", { name: "Identity mismatch" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(npubEncode(local))).toBeInTheDocument();
});

it("does not bind after the card is deactivated during Switch", async () => {
  const unbind = hold();
  let live = true;
  routes["/api/builderlab/identity"] = () => ({
    identity: { pubkey_hex: other },
  });
  routes["/api/builderlab/unbind"] = unbind.answer as Handler;
  routes["/api/builderlab/bind"] = () => ({ identity: { pubkey_hex: local } });
  render(<HostedCommunities api={brokerApi} active={() => live} />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Switch to this device’s identity",
    }),
  );
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Switch identity",
    }),
  );
  await waitFor(() =>
    expect(calls.map(([url]) => url)).toContain("/api/builderlab/unbind"),
  );
  live = false;
  await act(async () => unbind.release({}));
  expect(calls.map(([url]) => url)).not.toContain("/api/builderlab/bind");
  expect(
    screen.getByRole("button", { name: "Connect Buzz identity" }),
  ).toBeInTheDocument();
});

it("never unlinks again after Switch unlinks but its bind fails", async () => {
  routes["/api/builderlab/identity"] = () => ({
    identity: { pubkey_hex: other },
  });
  routes["/api/builderlab/unbind"] = () => ({});
  // The bind may have landed on the server even though its response was lost.
  routes["/api/builderlab/bind"] = () =>
    new Response("Bad gateway", { status: 502 });
  renderCard();
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Switch to this device’s identity",
    }),
  );
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Switch identity",
    }),
  );
  const connect = await screen.findByRole("button", {
    name: "Connect Buzz identity",
  });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  routes["/api/builderlab/bind"] = () => ({ identity: { pubkey_hex: local } });
  routes["/api/builderlab/identity"] = () => ({
    identity: { pubkey_hex: local },
  });
  fireEvent.click(connect);
  await screen.findByText("Buzz identity connected");
  const unlinks = calls.filter(([url]) => url === "/api/builderlab/unbind");
  expect(unlinks).toHaveLength(1);
});

async function typeName(value: string) {
  const input = await screen.findByPlaceholderText("north-star");
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value } });
}

it("shows an availability failure and retries the same name", async () => {
  routes["/api/builderlab/availability"] = () => ({
    error: { code: "relay_unavailable" },
    correlation_id: "corr-2",
  });
  renderCard();
  await typeName("north");
  expect(
    await screen.findByRole("alert", {}, { timeout: 2000 }),
  ).toHaveTextContent(
    "Community provisioning is temporarily unavailable. Correlation ID: corr-2",
  );
  expect(screen.queryByText("Checking availability…")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Create community" }),
  ).toBeDisabled();
  routes["/api/builderlab/availability"] = () => ({ available: true });
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(
    await screen.findByText(
      "That address is available.",
      {},
      { timeout: 2000 },
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Create community" }),
  ).toBeEnabled();
});

it("keeps the address visible when the clipboard rejects", async () => {
  routes["/api/builderlab/availability"] = () => ({ available: true });
  routes["/api/builderlab/create"] = () => ({
    community: { id: "c1", normalized_host: "north.communities.buzz.xyz" },
  });
  const writeText = vi.fn(async (_: string): Promise<void> => {
    throw new Error("denied");
  });
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  renderCard();
  await typeName("north");
  await screen.findByText("That address is available.", {}, { timeout: 2000 });
  fireEvent.click(screen.getByRole("button", { name: "Create community" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t copy the address.",
  );
  expect(
    screen.getByText("wss://north.communities.buzz.xyz"),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Address copied/)).not.toBeInTheDocument();
  writeText.mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole("button", { name: "Try copying again" }));
  expect(await screen.findByText(/Address copied/)).toBeInTheDocument();
});

it.each([
  ["an app-shell page", () => new Response("<!doctype html>", { status: 200 })],
  ["a missing route", () => new Response("Not found", { status: 404 })],
])(
  "reports hosted communities as unavailable when auth returns %s",
  async (_, reply) => {
    const base = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url === "/api/builderlab/auth" ? reply() : base(url, init),
      ),
    );
    renderCard();
    expect(
      await screen.findByText(/need the Buzz development broker/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Checking sign-in…")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Sign in with Builderlab/ }),
    ).not.toBeInTheDocument();
  },
);

const listed = {
  communities: [
    { id: "c1", name: "north", normalized_host: "north.communities.buzz.xyz" },
  ],
  quota_used: 1,
  quota_limit: 5,
  can_create: true,
};

it("does not carry a failed copy handoff into the next sign-in", async () => {
  routes["/api/builderlab/list"] = () => listed;
  routes["/api/builderlab/sign-out"] = () => ({});
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
  });
  renderCard();
  fireEvent.click(await screen.findByRole("button", { name: "Copy address" }));
  await screen.findByRole("button", { name: "Try copying again" });
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  routes["/api/builderlab/login"] = () => ({
    auth: { email: "b@example.com", name: "Bea", expiresAt: "2030" },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: /Sign in with Builderlab/ }),
  );
  expect(await screen.findByText("Bea")).toBeInTheDocument();
  await screen.findByRole("button", { name: "Copy address" });
  expect(
    screen.queryByRole("button", { name: "Try copying again" }),
  ).not.toBeInTheDocument();
});

it("does not write to the clipboard when create finishes after the card retires", async () => {
  const create = hold();
  let live = true;
  routes["/api/builderlab/availability"] = () => ({ available: true });
  routes["/api/builderlab/create"] = create.answer as Handler;
  const writeText = vi.fn(async (_: string) => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<HostedCommunities api={brokerApi} active={() => live} />);
  await typeName("north");
  await screen.findByText("That address is available.", {}, { timeout: 2000 });
  fireEvent.click(screen.getByRole("button", { name: "Create community" }));
  await waitFor(() =>
    expect(calls.map(([url]) => url)).toContain("/api/builderlab/create"),
  );
  live = false;
  await act(async () =>
    create.release({
      community: { id: "c1", normalized_host: "north.communities.buzz.xyz" },
    }),
  );
  expect(writeText).not.toHaveBeenCalled();
});

it("keeps a created community's address when the following refresh fails", async () => {
  routes["/api/builderlab/availability"] = () => ({ available: true });
  routes["/api/builderlab/create"] = () => ({
    community: { id: "c1", normalized_host: "north.communities.buzz.xyz" },
  });
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
  });
  renderCard();
  await typeName("north");
  await screen.findByText("That address is available.", {}, { timeout: 2000 });
  routes["/api/builderlab/list"] = () => ({
    error: { code: "relay_unavailable" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create community" }));
  expect(
    await screen.findByText(/The change was saved, but the list could not/),
  ).toBeInTheDocument();
  expect(
    screen.getByText("wss://north.communities.buzz.xyz"),
  ).toBeInTheDocument();
  // The name is cleared, so the same create cannot be resubmitted by accident.
  expect(screen.getByPlaceholderText("north-star")).toHaveValue("");
  expect(
    screen.getByRole("button", { name: "Create community" }),
  ).toBeDisabled();
  routes["/api/builderlab/list"] = () => listed;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("1 of 5 used")).toBeInTheDocument();
  expect(screen.queryByText(/The change was saved/)).not.toBeInTheDocument();
  expect(
    calls.filter(([url]) => url === "/api/builderlab/create"),
  ).toHaveLength(1);
});

it("completes a transfer when the following refresh fails", async () => {
  routes["/api/builderlab/list"] = () => listed;
  routes["/api/builderlab/transfer"] = () => ({
    community: { id: "c1" },
  });
  renderCard();
  fireEvent.click(await screen.findByRole("button", { name: "Transfer" }));
  fireEvent.change(screen.getByPlaceholderText("npub1…"), {
    target: { value: npubEncode(other) },
  });
  routes["/api/builderlab/list"] = () => ({
    error: { code: "relay_unavailable" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Transfer ownership" }));
  expect(
    await screen.findByText(/The change was saved, but the list could not/),
  ).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  // The transferred row is no longer offered as owned.
  expect(screen.queryByText("north")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Transfer" }),
  ).not.toBeInTheDocument();
  routes["/api/builderlab/list"] = () => ({
    communities: [],
    quota_used: 0,
    quota_limit: 5,
    can_create: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("0 of 5 used")).toBeInTheDocument();
  expect(
    calls.filter(([url]) => url === "/api/builderlab/transfer"),
  ).toHaveLength(1);
});

it.each([
  ["archive", "Archive", "Unarchive", null, "2026-09-24"],
  ["unarchive", "Unarchive", "Archive", "2026-09-24", null],
] as const)(
  "applies a confirmed %s when the following refresh fails",
  async (kind, action, next, before, after) => {
    const row = (archived_at: string | null) => ({
      communities: [{ ...listed.communities[0], archived_at }],
    });
    routes["/api/builderlab/list"] = () => row(before);
    routes[`/api/builderlab/${kind}`] = () => ({
      community: { id: "c1", archived_at: after },
    });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: action }));
    routes["/api/builderlab/list"] = () => ({
      error: { code: "relay_unavailable" },
    });
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: action,
      }),
    );
    expect(
      await screen.findByText(/The change was saved, but the list could not/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: next })).toBeEnabled(),
    );
    expect(
      screen.queryByRole("button", { name: action }),
    ).not.toBeInTheDocument();
    // Copy is offered only for an active community.
    expect(
      Boolean(screen.queryByRole("button", { name: "Copy address" })),
    ).toBe(kind === "unarchive");
    routes["/api/builderlab/list"] = () => row(after);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        screen.queryByText(/The change was saved/),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: next })).toBeEnabled();
    expect(
      calls.filter(([url]) => url === `/api/builderlab/${kind}`),
    ).toHaveLength(1);
  },
);

const unbound = () => ({
  error: { code: "missing_mapping", setup_needed: true },
});
const different = () => ({ identity: { pubkey_hex: other } });

it.each([
  ["completed rejection", "unbound", unbound],
  ["late success", "a different identity", different],
])(
  "drops a %s copy handoff when Refresh finds the account %s",
  async (schedule, _, identity) => {
    routes["/api/builderlab/list"] = () => listed;
    const clipboard = hold();
    const writeText = vi.fn(async (_: string) => {
      if (schedule === "completed rejection") throw new Error("denied");
      if ((await clipboard.answer()) === "reject") throw new Error("denied");
    });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderCard();
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy address" }),
    );
    if (schedule === "completed rejection")
      await screen.findByRole("button", { name: "Try copying again" });
    else await waitFor(() => expect(writeText).toHaveBeenCalled());
    // Another window or device changes the account's identity.
    routes["/api/builderlab/identity"] = identity;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await screen.findByRole("button", {
        name:
          identity === unbound
            ? "Connect Buzz identity"
            : "Switch to this device’s identity",
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
    );
    await act(async () =>
      clipboard.release(schedule === "late success" ? "resolve" : "reject"),
    );
    expect(screen.queryByText(/Address copied/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("wss://north.communities.buzz.xyz"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try copying again" }),
    ).not.toBeInTheDocument();
  },
);

it("keeps a failed copy handoff across a same-identity refresh", async () => {
  routes["/api/builderlab/list"] = () => listed;
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
  });
  renderCard();
  fireEvent.click(await screen.findByRole("button", { name: "Copy address" }));
  await screen.findByRole("button", { name: "Try copying again" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
  );
  expect(
    screen.getByText("wss://north.communities.buzz.xyz"),
  ).toBeInTheDocument();
});

it.each([
  ["completed rejection", "fails"],
  ["late success", "succeeds"],
])(
  "drops a %s copy handoff when the community is archived and the refresh %s",
  async (schedule, refresh) => {
    routes["/api/builderlab/list"] = () => listed;
    routes["/api/builderlab/archive"] = () => ({
      community: { id: "c1", archived_at: "2026-09-24" },
    });
    const clipboard = hold();
    const writeText = vi.fn(async (_: string) => {
      if (schedule === "completed rejection") throw new Error("denied");
      if ((await clipboard.answer()) === "reject") throw new Error("denied");
    });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderCard();
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy address" }),
    );
    if (schedule === "completed rejection")
      await screen.findByRole("button", { name: "Try copying again" });
    else await waitFor(() => expect(writeText).toHaveBeenCalled());
    routes["/api/builderlab/list"] =
      refresh === "fails"
        ? () => ({ error: { code: "relay_unavailable" } })
        : () => ({
            communities: [
              { ...listed.communities[0], archived_at: "2026-09-24" },
            ],
          });
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Archive",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unarchive" })).toBeEnabled(),
    );
    await act(async () =>
      clipboard.release(schedule === "late success" ? "resolve" : "reject"),
    );
    expect(screen.queryByText(/Address copied/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("wss://north.communities.buzz.xyz"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try copying again" }),
    ).not.toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(1);
  },
);

it("keeps a failed copy handoff for another address when a community is archived", async () => {
  routes["/api/builderlab/list"] = () => ({
    communities: [
      ...listed.communities,
      {
        id: "c2",
        name: "south",
        normalized_host: "south.communities.buzz.xyz",
      },
    ],
  });
  routes["/api/builderlab/archive"] = () => ({
    community: { id: "c1", archived_at: "2026-09-24" },
  });
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
  });
  renderCard();
  const [, south] = await screen.findAllByRole("button", {
    name: "Copy address",
  });
  fireEvent.click(south as HTMLElement);
  await screen.findByRole("button", { name: "Try copying again" });
  routes["/api/builderlab/list"] = () => ({
    error: { code: "relay_unavailable" },
  });
  fireEvent.click(
    screen.getAllByRole("button", { name: "Archive" })[0] as HTMLElement,
  );
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Archive",
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeEnabled(),
  );
  expect(
    screen.getByText("wss://south.communities.buzz.xyz"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Try copying again" }),
  ).toBeEnabled();
});

it("only presents an empty hosted collection after a successful read", async () => {
  let release!: (value: unknown) => void;
  const list = new Promise((resolve) => {
    release = resolve;
  });
  routes["/api/builderlab/list"] = () => list;
  renderCard();
  try {
    await waitFor(() =>
      expect(calls.some(([url]) => url === "/api/builderlab/list")).toBe(true),
    );
    expect(
      screen.queryByRole("heading", { name: "No hosted communities yet" }),
    ).toBeNull();
  } finally {
    release({ communities: [] });
  }
  expect(
    await screen.findByRole("heading", {
      name: "No hosted communities yet",
      level: 4,
    }),
  ).toBeVisible();
});

it("keeps a failed hosted collection read separate from an empty result", async () => {
  routes["/api/builderlab/list"] = () => ({
    error: { message: "List unavailable" },
  });
  renderCard();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "List unavailable",
  );
  expect(
    screen.queryByRole("heading", { name: "No hosted communities yet" }),
  ).toBeNull();
});

const archived = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "north",
  normalized_host: "North.communities.buzz.xyz",
  archived_at: "2026-09-24",
};
const accepted = (request: Record<string, string | number>) => ({
  ...request,
  status: "submitted",
  correlation_id: "corr-delete",
});

async function openDeletion() {
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  return screen.findByRole("dialog", { name: /Permanently delete north/ });
}

async function confirmDeletion(host = archived.normalized_host) {
  const dialog = await openDeletion();
  fireEvent.change(within(dialog).getByLabelText("Type the exact host"), {
    target: { value: host },
  });
  fireEvent.click(
    within(dialog).getByRole("checkbox", {
      name: /I understand this cannot be canceled/,
    }),
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Start deletion" }),
  );
}

const deletionPosts = () =>
  calls.filter(([url]) => url === "/api/builderlab/delete");

async function startUncertainDeletion() {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = () =>
    Response.json({ error: { code: "acceptance_unknown" } }, { status: 503 });
  const view = renderCard();
  await confirmDeletion();
  await screen.findByText("Deletion status is unknown");
  const saved = JSON.parse(localStorage.getItem(DELETION_PENDING_KEY) ?? "");
  expect(deletionPosts()).toEqual([["/api/builderlab/delete", saved.request]]);
  return { view, saved };
}

async function expectSameRequestRecovery(saved: {
  request: Record<string, string | number>;
}) {
  expect(JSON.parse(localStorage.getItem(DELETION_PENDING_KEY) ?? "")).toEqual(
    saved,
  );
  expect(deletionPosts()).toEqual([["/api/builderlab/delete", saved.request]]);
  routes["/api/builderlab/delete"] = (request) =>
    Response.json(accepted(request), { status: 202 });
  fireEvent.click(
    await screen.findByRole("button", { name: "Check deletion status" }),
  );
  await screen.findByText("Deletion started");
  expect(deletionPosts()).toEqual([
    ["/api/builderlab/delete", saved.request],
    ["/api/builderlab/delete", saved.request],
  ]);
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
}

it("keeps the uncertain UUID through sign-out and same-owner sign-in", async () => {
  const { saved } = await startUncertainDeletion();
  routes["/api/builderlab/sign-out"] = () => ({});
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByRole("button", { name: /Sign in with Builderlab/ });
  expect(JSON.parse(localStorage.getItem(DELETION_PENDING_KEY) ?? "")).toEqual(
    saved,
  );
  expect(deletionPosts()).toHaveLength(1);
  routes["/api/builderlab/login"] = () => ({
    auth: {
      email: "a@example.com",
      expiresAt: "2030",
      capabilities: { can_delete_buzz_communities: true },
    },
  });
  fireEvent.click(
    screen.getByRole("button", { name: /Sign in with Builderlab/ }),
  );
  await screen.findByText(saved.request.request_id);
  await expectSameRequestRecovery(saved);
});

it("hides but retains an uncertain UUID across A to B to A", async () => {
  const { saved } = await startUncertainDeletion();
  routes["/api/builderlab/identity"] = () => ({
    identity: { pubkey_hex: other },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("region", { name: "Identity mismatch" });
  expect(screen.queryByText(saved.request.request_id)).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(DELETION_PENDING_KEY) ?? "")).toEqual(
    saved,
  );
  expect(deletionPosts()).toHaveLength(1);
  routes["/api/builderlab/identity"] = () => ({
    identity: { pubkey_hex: local },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText(saved.request.request_id);
  await expectSameRequestRecovery(saved);
});

it("retains the uncertain UUID through an unpair elsewhere and same-owner rebind", async () => {
  const { saved } = await startUncertainDeletion();
  routes["/api/builderlab/identity"] = () => ({
    error: { code: "missing_mapping", setup_needed: true },
  });
  routes["/api/builderlab/list"] = () => ({
    error: { code: "missing_mapping", setup_needed: true },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("button", { name: "Connect Buzz identity" });
  expect(deletionPosts()).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem(DELETION_PENDING_KEY) ?? "")).toEqual(
    saved,
  );
  routes["/api/builderlab/bind"] = () => ({ identity: { pubkey_hex: local } });
  routes["/api/builderlab/identity"] = () => ({
    identity: { pubkey_hex: local },
  });
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  fireEvent.click(
    screen.getByRole("button", { name: "Connect Buzz identity" }),
  );
  await screen.findByText(saved.request.request_id);
  await expectSameRequestRecovery(saved);
});

it.each(["setup-needed", "unauthorized"])(
  "retains the uncertain UUID through %s and recovery",
  async (failure) => {
    const { saved } = await startUncertainDeletion();
    const error =
      failure === "setup-needed"
        ? { code: "missing_mapping", setup_needed: true }
        : { code: "unauthorized" };
    routes["/api/builderlab/identity"] = () => ({
      error,
    });
    routes["/api/builderlab/list"] = () => ({
      error,
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    if (failure === "setup-needed")
      await screen.findByRole("button", { name: "Connect Buzz identity" });
    else {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        failure === "unauthorized"
          ? "This Builderlab account can't manage Buzz identities right now. Try signing in again."
          : "Could not load the connected Buzz identity.",
      );
      expect(
        screen.queryByRole("button", { name: "Connect Buzz identity" }),
      ).not.toBeInTheDocument();
    }
    expect(
      screen.queryByText(saved.request.request_id),
    ).not.toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(DELETION_PENDING_KEY) ?? ""),
    ).toEqual(saved);
    expect(deletionPosts()).toHaveLength(1);
    routes["/api/builderlab/identity"] = () => ({
      identity: { pubkey_hex: local },
    });
    routes["/api/builderlab/list"] = () => ({ communities: [archived] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(saved.request.request_id);
    await expectSameRequestRecovery(saved);
  },
);

it("does not offer Connect or stale owner actions on an initial unauthorized load", async () => {
  const bytes = JSON.stringify({
    version: 1,
    owner_pubkey: local,
    backend_origin: window.location.origin,
    request: {
      community_id: archived.id,
      host: archived.normalized_host,
      request_id: "88888888-8888-4888-8888-888888888888",
      acknowledgement_version: 1,
    },
  });
  localStorage.setItem(DELETION_PENDING_KEY, bytes);
  routes["/api/builderlab/identity"] = () => ({
    error: { code: "unauthorized" },
  });
  routes["/api/builderlab/list"] = () => ({ error: { code: "unauthorized" } });
  renderCard();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This Builderlab account can't manage Buzz identities right now. Try signing in again.",
  );
  expect(
    screen.queryByRole("button", { name: "Connect Buzz identity" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Delete" }),
  ).not.toBeInTheDocument();
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBe(bytes);
  expect(deletionPosts()).toHaveLength(0);
});

it("clears stale blocked-owner and deletion notices on unauthorized Refresh", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = (request) =>
    Response.json(accepted(request), { status: 202 });
  renderCard();
  await confirmDeletion();
  await screen.findByText("Deletion started");
  localStorage.setItem(
    DELETION_PENDING_KEY,
    JSON.stringify({
      version: 1,
      owner_pubkey: other,
      backend_origin: window.location.origin,
      request: {
        community_id: archived.id,
        host: archived.normalized_host,
        request_id: "77777777-7777-4777-8777-777777777777",
        acknowledgement_version: 1,
      },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText(/A deletion request from/);
  routes["/api/builderlab/list"] = () => ({ error: { code: "unauthorized" } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This Builderlab account can't manage Buzz identities right now. Try signing in again.",
  );
  expect(screen.queryByText("Deletion started")).not.toBeInTheDocument();
  expect(screen.queryByText(/A deletion request from/)).not.toBeInTheDocument();
  expect(
    JSON.parse(localStorage.getItem(DELETION_PENDING_KEY) ?? "").owner_pubkey,
  ).toBe(other);
});

it("retains the uncertain UUID through Switch back to its owner", async () => {
  const { saved } = await startUncertainDeletion();
  routes["/api/builderlab/identity"] = () => ({
    identity: { pubkey_hex: other },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("region", { name: "Identity mismatch" });
  routes["/api/builderlab/unbind"] = () => ({});
  routes["/api/builderlab/bind"] = () => ({ identity: { pubkey_hex: local } });
  routes["/api/builderlab/identity"] = () => ({
    identity: { pubkey_hex: local },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Switch to this device’s identity" }),
  );
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Switch identity",
    }),
  );
  await screen.findByText(saved.request.request_id);
  await expectSameRequestRecovery(saved);
});

it("restores an accepted archived row only after its bound abort on Refresh", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = (request) =>
    Response.json(accepted(request), { status: 202 });
  renderCard();
  await confirmDeletion();
  await screen.findByText("Deletion started");
  const original = deletionPosts()[0]?.[1];
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
  expect(deletionPosts()).toHaveLength(1);
  routes["/api/builderlab/list"] = () => ({ communities: [] });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
  );
  expect(deletionPosts()).toHaveLength(1);
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = (request) =>
    Response.json({ ...request, status: "aborted" }, { status: 202 });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(deletionPosts()).toHaveLength(2));
  expect(deletionPosts()[1]?.[1]).toEqual(original);
  expect(await screen.findByRole("button", { name: "Delete" })).toBeEnabled();
  expect(
    screen.getByText(/North\.communities\.buzz\.xyz · Archived/),
  ).toBeVisible();
  expect(
    screen.getByText(
      `Deletion of ${archived.normalized_host} stopped. This community is not being deleted.`,
    ),
  ).toBeVisible();
  expect(screen.queryByText("Deletion started")).not.toBeInTheDocument();
});

it.each([
  ["absent", {}],
  ["incomplete", { quota_used: 5, quota_limit: 5 }],
  ["malformed", { quota_used: "5", quota_limit: 5, can_create: false }],
])(
  "keeps Create available when the quota projection is %s",
  async (_label, projection) => {
    routes["/api/builderlab/list"] = () => ({
      communities: Array.from({ length: 5 }, (_, index) => ({
        id: `c${index}`,
        name: `c${index}`,
        normalized_host: `c${index}.communities.buzz.xyz`,
      })),
      ...projection,
    });
    renderCard();
    const input = await screen.findByPlaceholderText("north-star");
    await waitFor(() => expect(input).toBeEnabled());
    expect(screen.queryByText(/quota unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ of \d+ used/)).not.toBeInTheDocument();
    expect(screen.queryByText(/reached the limit/)).not.toBeInTheDocument();
  },
);

it("shows the server's limit_reached message when quota is absent", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [] });
  routes["/api/builderlab/availability"] = () => ({ available: true });
  routes["/api/builderlab/create"] = () =>
    Response.json({ error: { code: "limit_reached" } }, { status: 409 });
  renderCard();
  const input = await screen.findByPlaceholderText("north-star");
  await waitFor(() => expect(input).toBeEnabled());
  vi.useFakeTimers();
  fireEvent.change(input, { target: { value: "north" } });
  await act(() => vi.advanceTimersByTimeAsync(500));
  vi.useRealTimers();
  expect(await screen.findByText("That address is available.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Create community" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("You've reached your community limit.");
  expect(alert).not.toHaveTextContent(/\d/);
  expect(alert).not.toHaveTextContent("limit of 5");
  expect(calls).toContainEqual(["/api/builderlab/create", { name: "north" }]);
});

it("uses valid projected limit for a server limit_reached create error", async () => {
  routes["/api/builderlab/list"] = () => ({
    communities: [],
    quota_used: 0,
    quota_limit: 7,
    can_create: true,
  });
  routes["/api/builderlab/availability"] = () => ({ available: true });
  routes["/api/builderlab/create"] = () =>
    Response.json({ error: { code: "limit_reached" } }, { status: 409 });
  renderCard();
  const input = await screen.findByPlaceholderText("north-star");
  await waitFor(() => expect(input).toBeEnabled());
  vi.useFakeTimers();
  fireEvent.change(input, { target: { value: "north" } });
  await act(() => vi.advanceTimersByTimeAsync(500));
  vi.useRealTimers();
  fireEvent.click(screen.getByRole("button", { name: "Create community" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "You've reached your limit of 7 communities.",
  );
});

it("shows deletion only for literal capability true and requires the byte-exact host plus explicit confirmation", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  let storedBeforeDispatch = false;
  routes["/api/builderlab/delete"] = (request) => {
    storedBeforeDispatch = localStorage.getItem(DELETION_PENDING_KEY) !== null;
    return Response.json(accepted(request), { status: 202 });
  };
  renderCard();
  const dialog = await openDeletion();
  expect(dialog).toHaveTextContent("cannot be canceled by an owner");
  expect(dialog).toHaveTextContent("All community content will be deleted");
  expect(dialog).toHaveTextContent("permanently reserved");
  expect(dialog).toHaveTextContent("logical cleanup finishes");
  const input = within(dialog).getByLabelText("Type the exact host");
  const submit = within(dialog).getByRole("button", {
    name: "Start deletion",
  });
  fireEvent.change(input, {
    target: { value: archived.normalized_host.toLowerCase() },
  });
  fireEvent.click(
    within(dialog).getByRole("checkbox", {
      name: /I understand this cannot be canceled/,
    }),
  );
  expect(submit).toBeDisabled();
  fireEvent.change(input, {
    target: { value: ` ${archived.normalized_host}` },
  });
  expect(submit).toBeDisabled();
  fireEvent.change(input, { target: { value: archived.normalized_host } });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  expect(await screen.findByText("Deletion started")).toBeVisible();
  expect(storedBeforeDispatch).toBe(true);
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
  const request = calls.find(([url]) => url === "/api/builderlab/delete")?.[1];
  expect(request).toEqual({
    community_id: archived.id,
    host: archived.normalized_host,
    request_id: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
    acknowledgement_version: 1,
  });
});

it("keeps deletion hidden when the capability is absent", async () => {
  routes["/api/builderlab/auth"] = () => ({
    auth: { email: "a@example.com", expiresAt: "2030", capabilities: {} },
  });
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  renderCard();
  expect(
    await screen.findByRole("button", { name: "Unarchive" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Delete" }),
  ).not.toBeInTheDocument();
});

it("does not dispatch when the pending envelope cannot be persisted", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("storage full");
  });
  renderCard();
  await confirmDeletion();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Deletion was not sent because its recovery record could not be saved",
  );
  expect(calls.map(([url]) => url)).not.toContain("/api/builderlab/delete");
});

it("replays an aborted 202 with the stored UUID and restores the archived row", async () => {
  const request = {
    community_id: archived.id,
    host: archived.normalized_host,
    request_id: "77777777-7777-4777-8777-777777777777",
    acknowledgement_version: 1,
  };
  localStorage.setItem(
    DELETION_PENDING_KEY,
    JSON.stringify({
      version: 1,
      owner_pubkey: local,
      backend_origin: window.location.origin,
      request,
    }),
  );
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = (body) =>
    Response.json({ ...body, status: "aborted" }, { status: 202 });
  renderCard();
  expect(await screen.findByText("Deletion status is unknown")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Check deletion status" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    `Deletion of ${archived.normalized_host} stopped. This community is not being deleted.`,
  );
  expect(calls.filter(([url]) => url === "/api/builderlab/delete")).toEqual([
    ["/api/builderlab/delete", request],
  ]);
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
  expect(screen.queryByText("Deletion started")).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled(),
  );
});

it("clears a fresh must_archive rejection and restores deletion after remount", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = () =>
    Response.json(
      {
        error: { code: "must_archive" },
        correlation_id: "corr-must-archive",
      },
      { status: 409 },
    );
  const view = renderCard();
  await confirmDeletion();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Archive the community before deleting it",
  );
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
  expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();

  view.unmount();
  renderCard();
  expect(await screen.findByRole("button", { name: "Delete" })).toBeEnabled();
  expect(
    screen.queryByText("Deletion status is unknown"),
  ).not.toBeInTheDocument();
});

it("preserves one UUID across an ambiguous response and manual same-UUID replay", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = () =>
    new Response("{", {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  renderCard();
  await confirmDeletion();
  expect(await screen.findByText("Deletion status is unknown")).toBeVisible();
  const saved = JSON.parse(localStorage.getItem(DELETION_PENDING_KEY) ?? "");
  const requestId = saved.request.request_id;
  expect(
    calls.filter(([url]) => url === "/api/builderlab/delete"),
  ).toHaveLength(1);
  routes["/api/builderlab/delete"] = (request) =>
    Response.json({ ...request, status: "retention_pending" }, { status: 202 });
  fireEvent.click(
    screen.getByRole("button", { name: "Check deletion status" }),
  );
  expect(await screen.findByText("Deletion started")).toBeVisible();
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
  const admissions = calls.filter(([url]) => url === "/api/builderlab/delete");
  expect(admissions).toHaveLength(2);
  expect(admissions[1]?.[1]).toEqual(saved.request);
  expect(admissions[1]?.[1].request_id).toBe(requestId);
});

it("shows a stored request for explicit manual checking without background recovery", async () => {
  const request = {
    community_id: archived.id,
    host: archived.normalized_host,
    request_id: "22222222-2222-4222-8222-222222222222",
    acknowledgement_version: 1,
  };
  localStorage.setItem(
    DELETION_PENDING_KEY,
    JSON.stringify({
      version: 1,
      owner_pubkey: local,
      backend_origin: window.location.origin,
      request,
    }),
  );
  routes["/api/builderlab/auth"] = () => ({
    auth: { email: "a@example.com", expiresAt: "2030", capabilities: {} },
  });
  routes["/api/builderlab/list"] = () => ({ communities: [] });
  routes["/api/builderlab/delete"] = (body) =>
    Response.json({ ...body, status: "submitted" }, { status: 202 });
  const view = renderCard();
  expect(await screen.findByText("Deletion status is unknown")).toBeVisible();
  expect(screen.getByText(request.request_id)).toHaveClass("select-all");
  expect(screen.getByText(/will not check automatically/i)).toBeVisible();
  expect(screen.getByText(/contact support/i)).toBeVisible();
  expect(
    screen.getByText(
      "Community deletion is unavailable right now, so this request can't be checked. It stays saved on this device.",
    ),
  ).toBeVisible();
  expect(calls.map(([url]) => url)).not.toContain("/api/builderlab/delete");
  expect(
    screen.getByRole("button", { name: "Check deletion status" }),
  ).toBeDisabled();
  view.unmount();
  routes["/api/builderlab/auth"] = () => ({
    auth: {
      email: "a@example.com",
      expiresAt: "2030",
      capabilities: { can_delete_buzz_communities: true },
    },
  });
  renderCard();
  fireEvent.click(
    await screen.findByRole("button", { name: "Check deletion status" }),
  );
  expect(await screen.findByText("Deletion started")).toBeVisible();
  expect(calls.filter(([url]) => url === "/api/builderlab/delete")).toEqual([
    ["/api/builderlab/delete", request],
  ]);
});

it("retains another owner's recovery envelope without showing or dispatching it", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  localStorage.setItem(
    DELETION_PENDING_KEY,
    JSON.stringify({
      version: 1,
      owner_pubkey: other,
      backend_origin: window.location.origin,
      request: {
        community_id: archived.id,
        host: "Private.communities.buzz.xyz",
        request_id: "33333333-3333-4333-8333-333333333333",
        acknowledgement_version: 1,
      },
    }),
  );
  const original = localStorage.getItem(DELETION_PENDING_KEY);
  renderCard();
  await screen.findByText(npubEncode(local));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
  );
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBe(original);
  expect(
    screen.queryByText("33333333-3333-4333-8333-333333333333"),
  ).not.toBeInTheDocument();
  expect(calls.map(([url]) => url)).not.toContain("/api/builderlab/delete");
  expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  expect(
    screen.getByText(
      `A deletion request from ${npubEncode(other)} is still pending on this device. Switch to that Buzz identity and use Check deletion status before starting another deletion here. If you no longer have that identity, contact support.`,
    ),
  ).toBeVisible();
  expect(
    screen.queryByText("33333333-3333-4333-8333-333333333333"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Private.communities.buzz.xyz"),
  ).not.toBeInTheDocument();
});

it("does not reveal another owner's blocked notice when deletion is unavailable", async () => {
  localStorage.setItem(
    DELETION_PENDING_KEY,
    JSON.stringify({
      version: 1,
      owner_pubkey: other,
      backend_origin: window.location.origin,
      request: {
        community_id: archived.id,
        host: archived.normalized_host,
        request_id: "33333333-3333-4333-8333-333333333333",
        acknowledgement_version: 1,
      },
    }),
  );
  const original = localStorage.getItem(DELETION_PENDING_KEY);
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/auth"] = () => ({
    auth: { expiresAt: "2030", capabilities: {} },
  });
  renderCard();
  await screen.findByText(npubEncode(local));
  expect(screen.queryByText(/A deletion request from/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Delete" }),
  ).not.toBeInTheDocument();
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBe(original);
  expect(deletionPosts()).toHaveLength(0);
});

it("rejects a newly occupied slot at final confirmation without claiming a storage failure", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  renderCard();
  const dialog = await openDeletion();
  fireEvent.change(within(dialog).getByLabelText("Type the exact host"), {
    target: { value: archived.normalized_host },
  });
  fireEvent.click(
    within(dialog).getByRole("checkbox", {
      name: /I understand this cannot be canceled/,
    }),
  );
  const original = JSON.stringify({
    version: 1,
    owner_pubkey: other,
    backend_origin: window.location.origin,
    request: {
      community_id: archived.id,
      host: archived.normalized_host,
      request_id: "33333333-3333-4333-8333-333333333333",
      acknowledgement_version: 1,
    },
  });
  localStorage.setItem(DELETION_PENDING_KEY, original);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Start deletion" }),
  );
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBe(original);
  expect(deletionPosts()).toHaveLength(0);
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    `Deletion was not sent. A deletion request from ${npubEncode(other)} is already pending on this device.`,
  );
  expect(
    screen.queryByText(/recovery record could not be saved/),
  ).not.toBeInTheDocument();
});

it("explains a same-owner slot occupied at final confirmation", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  renderCard();
  const dialog = await openDeletion();
  fireEvent.change(within(dialog).getByLabelText("Type the exact host"), {
    target: { value: archived.normalized_host },
  });
  fireEvent.click(
    within(dialog).getByRole("checkbox", {
      name: /I understand this cannot be canceled/,
    }),
  );
  const bytes = JSON.stringify({
    version: 1,
    owner_pubkey: local,
    backend_origin: window.location.origin,
    request: {
      community_id: archived.id,
      host: archived.normalized_host,
      request_id: "33333333-3333-4333-8333-333333333333",
      acknowledgement_version: 1,
    },
  });
  localStorage.setItem(DELETION_PENDING_KEY, bytes);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Start deletion" }),
  );
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Deletion was not sent. This identity already has a pending deletion request. Use Check deletion status.",
  );
  expect(deletionPosts()).toHaveLength(0);
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBe(bytes);
});

it("explains when another context cleared the blocked slot before final confirmation", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  renderCard();
  const dialog = await openDeletion();
  fireEvent.change(within(dialog).getByLabelText("Type the exact host"), {
    target: { value: archived.normalized_host },
  });
  fireEvent.click(
    within(dialog).getByRole("checkbox", {
      name: /I understand this cannot be canceled/,
    }),
  );
  const bytes = JSON.stringify({
    version: 1,
    owner_pubkey: other,
    backend_origin: window.location.origin,
    request: {
      community_id: archived.id,
      host: archived.normalized_host,
      request_id: "33333333-3333-4333-8333-333333333333",
      acknowledgement_version: 1,
    },
  });
  localStorage.setItem(DELETION_PENDING_KEY, bytes);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Start deletion" }),
  );
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    `A deletion request from ${npubEncode(other)}`,
  );
  localStorage.removeItem(DELETION_PENDING_KEY);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Start deletion" }),
  );
  expect(within(dialog).getByRole("alert")).toHaveTextContent(/^Try again\.$/);
  expect(deletionPosts()).toHaveLength(0);
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
  // The copy promises that pressing Start deletion again is enough.
  const admission = hold();
  routes["/api/builderlab/delete"] = admission.answer as Handler;
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Start deletion" }),
  );
  await waitFor(() => expect(deletionPosts()).toHaveLength(1));
  const stored = JSON.parse(localStorage.getItem(DELETION_PENDING_KEY) ?? "");
  expect(stored.owner_pubkey).toBe(local);
  expect(deletionPosts()[0]?.[1]).toEqual(stored.request);
  await act(async () =>
    admission.release(Response.json(accepted(stored.request), { status: 202 })),
  );
  expect(await screen.findByText("Deletion started")).toBeVisible();
  expect(deletionPosts()).toHaveLength(1);
});

it("explains a same-owner envelope saved for another origin without asking to switch identity", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  localStorage.setItem(
    DELETION_PENDING_KEY,
    JSON.stringify({
      version: 1,
      owner_pubkey: local,
      backend_origin: "https://other.example",
      request: {
        community_id: archived.id,
        host: archived.normalized_host,
        request_id: "33333333-3333-4333-8333-333333333333",
        acknowledgement_version: 1,
      },
    }),
  );
  const original = localStorage.getItem(DELETION_PENDING_KEY);
  renderCard();
  expect(
    await screen.findByText(
      "This identity has a deletion request saved from a different app address on this device. It can't be checked here, so contact support before starting another deletion.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByText(/Switch to that Buzz identity/),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBe(original);
  expect(deletionPosts()).toHaveLength(0);
});

it("explains a same-owner other-origin slot occupied at final confirmation", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  renderCard();
  const dialog = await openDeletion();
  fireEvent.change(within(dialog).getByLabelText("Type the exact host"), {
    target: { value: archived.normalized_host },
  });
  fireEvent.click(
    within(dialog).getByRole("checkbox", {
      name: /I understand this cannot be canceled/,
    }),
  );
  const original = JSON.stringify({
    version: 1,
    owner_pubkey: local,
    backend_origin: "https://other.example",
    request: {
      community_id: archived.id,
      host: archived.normalized_host,
      request_id: "33333333-3333-4333-8333-333333333333",
      acknowledgement_version: 1,
    },
  });
  localStorage.setItem(DELETION_PENDING_KEY, original);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Start deletion" }),
  );
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Deletion was not sent. This identity has a deletion request saved from a different app address on this device. Contact support before starting another deletion.",
  );
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBe(original);
  expect(deletionPosts()).toHaveLength(0);
});

it("keeps and retries the same UUID after a wrong-status pre-admission rejection", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = () =>
    Response.json(
      { error: { code: "must_archive" }, correlation_id: "corr-wrong-status" },
      { status: 503 },
    );
  renderCard();
  await confirmDeletion();
  expect(await screen.findByText("Deletion status is unknown")).toBeVisible();
  const original = localStorage.getItem(DELETION_PENDING_KEY);
  expect(original).not.toBeNull();
  const first = calls.find(([url]) => url === "/api/builderlab/delete")?.[1];
  expect(first?.request_id).toBe(JSON.parse(original ?? "").request.request_id);
  routes["/api/builderlab/delete"] = (request) =>
    Response.json(accepted(request), { status: 202 });
  fireEvent.click(
    screen.getByRole("button", { name: "Check deletion status" }),
  );
  expect(await screen.findByText("Deletion started")).toBeVisible();
  const admissions = calls.filter(([url]) => url === "/api/builderlab/delete");
  expect(admissions).toHaveLength(2);
  expect(admissions[1]?.[1]).toEqual(first);
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
  expect(calls.filter(([url]) => url === "/api/builderlab/auth")).toHaveLength(
    3,
  ); // StrictMode startup twice, then the fresh capability check.
  expect(
    calls.filter(([url]) => url === "/api/builderlab/list").length,
  ).toBeGreaterThan(2); // Startup and the fresh bound-owner check before replay.
});

it("ends pending recovery on a definitive UUID retarget conflict", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = () =>
    new Response("{", {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  renderCard();
  await confirmDeletion();
  expect(await screen.findByText("Deletion status is unknown")).toBeVisible();
  const saved = JSON.parse(localStorage.getItem(DELETION_PENDING_KEY) ?? "");
  routes["/api/builderlab/delete"] = () =>
    Response.json({ error: { code: "deletion_conflict" } }, { status: 409 });
  fireEvent.click(
    screen.getByRole("button", { name: "Check deletion status" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This deletion conflicts with another community lifecycle change",
  );
  expect(calls.filter(([url]) => url === "/api/builderlab/delete")).toEqual([
    ["/api/builderlab/delete", saved.request],
    ["/api/builderlab/delete", saved.request],
  ]);
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
  expect(screen.queryByText("Deletion started")).not.toBeInTheDocument();
});

it("ends pending recovery when the owner unarchived before the replay", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = () =>
    new Response("{", {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  renderCard();
  await confirmDeletion();
  expect(await screen.findByText("Deletion status is unknown")).toBeVisible();
  const saved = JSON.parse(localStorage.getItem(DELETION_PENDING_KEY) ?? "");
  routes["/api/builderlab/list"] = () => ({
    communities: [{ ...archived, archived_at: null }],
  });
  routes["/api/builderlab/delete"] = () =>
    Response.json({ error: { code: "must_archive" } }, { status: 409 });
  fireEvent.click(
    screen.getByRole("button", { name: "Check deletion status" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Archive the community before deleting it.",
  );
  expect(calls.filter(([url]) => url === "/api/builderlab/delete")).toEqual([
    ["/api/builderlab/delete", saved.request],
    ["/api/builderlab/delete", saved.request],
  ]);
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Check deletion status" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Deletion started")).not.toBeInTheDocument();
});

it("terminates pending recovery on a bound aborted 202", async () => {
  const request = {
    community_id: archived.id,
    host: archived.normalized_host,
    request_id: "44444444-4444-4444-8444-444444444444",
    acknowledgement_version: 1,
  };
  localStorage.setItem(
    DELETION_PENDING_KEY,
    JSON.stringify({
      version: 1,
      owner_pubkey: local,
      backend_origin: window.location.origin,
      request,
    }),
  );
  routes["/api/builderlab/delete"] = () =>
    Response.json(
      {
        ...request,
        status: "aborted",
        correlation_id: "corr-aborted",
      },
      { status: 202 },
    );
  renderCard();
  expect(await screen.findByText("Deletion status is unknown")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Check deletion status" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    `Deletion of ${archived.normalized_host} stopped. This community is not being deleted. Correlation ID: corr-aborted`,
  );
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
  expect(
    screen.queryByText("Deletion status is unknown"),
  ).not.toBeInTheDocument();
});

it("keeps an unbound aborted result pending", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = () =>
    Response.json(
      {
        status: "aborted",
        correlation_id: "corr-unbound-abort",
      },
      { status: 202 },
    );
  renderCard();
  await confirmDeletion();
  expect(await screen.findByText("Deletion status is unknown")).toBeVisible();
  expect(localStorage.getItem(DELETION_PENDING_KEY)).not.toBeNull();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Correlation ID: corr-unbound-abort",
  );
});

it("disables deletion for every row when a pending slot exists in another mounted card", async () => {
  const south = {
    ...archived,
    id: "22222222-2222-4222-8222-222222222222",
    name: "south",
    normalized_host: "South.communities.buzz.xyz",
  };
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = () =>
    Response.json(
      { error: { code: "acceptance_unknown" }, correlation_id: "corr-slot" },
      { status: 503 },
    );
  render(<HostedCommunities api={brokerApi} active={() => true} />);
  fireEvent.click(
    (
      await screen.findAllByRole("button", { name: "Delete" })
    )[0] as HTMLElement,
  );
  const dialog = await screen.findByRole("dialog", {
    name: /Permanently delete north/,
  });
  fireEvent.change(within(dialog).getByLabelText("Type the exact host"), {
    target: { value: archived.normalized_host },
  });
  fireEvent.click(
    within(dialog).getByRole("checkbox", {
      name: /I understand this cannot be canceled/,
    }),
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Start deletion" }),
  );
  await screen.findByText("Deletion status is unknown");
  const original = localStorage.getItem(DELETION_PENDING_KEY);
  routes["/api/builderlab/list"] = () => ({
    communities: [archived, south],
  });
  render(<HostedCommunities api={brokerApi} active={() => true} />);
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(3),
  );
  for (const button of screen.getAllByRole("button", { name: "Delete" }))
    expect(button).toBeDisabled();
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBe(original);
  expect(
    calls.filter(([url]) => url === "/api/builderlab/delete"),
  ).toHaveLength(1);
});

it("does not replay when capability is revoked on the fresh check", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = () =>
    Response.json(
      { error: { code: "acceptance_unknown" }, correlation_id: "corr-first" },
      { status: 503 },
    );
  renderCard();
  await confirmDeletion();
  await screen.findByText("Deletion status is unknown");
  routes["/api/builderlab/auth"] = () => ({
    auth: { email: "a@example.com", expiresAt: "2030", capabilities: {} },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Check deletion status" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Community deletion is no longer available",
  );
  expect(
    screen.getByRole("button", { name: "Check deletion status" }),
  ).toBeDisabled();
  expect(
    calls.filter(([url]) => url === "/api/builderlab/delete"),
  ).toHaveLength(1);
  expect(localStorage.getItem(DELETION_PENDING_KEY)).not.toBeNull();
});

it("replays the same UUID when the archived owner row is no longer listed", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = () =>
    Response.json({ error: { code: "acceptance_unknown" } }, { status: 503 });
  renderCard();
  await confirmDeletion();
  await screen.findByText("Deletion status is unknown");
  const original = JSON.parse(localStorage.getItem(DELETION_PENDING_KEY) ?? "");
  routes["/api/builderlab/list"] = () => ({ communities: [] });
  routes["/api/builderlab/delete"] = (body) =>
    Response.json({ ...body, status: "postgres_purged" }, { status: 202 });
  fireEvent.click(
    screen.getByRole("button", { name: "Check deletion status" }),
  );
  expect(await screen.findByText("Deletion started")).toBeVisible();
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
  const admissions = calls.filter(([url]) => url === "/api/builderlab/delete");
  expect(admissions).toHaveLength(2);
  expect(admissions[0]?.[1]).toEqual(original.request);
  expect(admissions[1]?.[1]).toEqual(original.request);
});

it("rechecks capability after the fresh owner list resolves", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = () =>
    Response.json(
      { error: { code: "acceptance_unknown" }, correlation_id: "corr-first" },
      { status: 503 },
    );
  renderCard();
  await confirmDeletion();
  await screen.findByText("Deletion status is unknown");
  const list = hold();
  routes["/api/builderlab/list"] = list.answer as Handler;
  const listCalls = calls.filter(
    ([url]) => url === "/api/builderlab/list",
  ).length;
  const retry = screen.getByRole("button", {
    name: "Check deletion status",
  });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await waitFor(() =>
    expect(
      calls.filter(([url]) => url === "/api/builderlab/list").length,
    ).toBeGreaterThan(listCalls),
  );
  routes["/api/builderlab/auth"] = () => ({
    auth: { email: "a@example.com", expiresAt: "2030", capabilities: {} },
  });
  await act(async () => list.release({ communities: [archived] }));
  await screen.findByRole("alert");
  expect(
    calls.filter(([url]) => url === "/api/builderlab/delete"),
  ).toHaveLength(1);
  expect(localStorage.getItem(DELETION_PENDING_KEY)).not.toBeNull();
});

it("keeps an accepted row hidden if a stale list returns after an omission", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = (body) =>
    Response.json(accepted(body), { status: 202 });
  renderCard();
  await confirmDeletion();
  expect(await screen.findByText("Deletion started")).toBeVisible();
  const refresh = screen.getByRole("button", { name: "Refresh" });
  await waitFor(() => expect(refresh).toBeEnabled());
  routes["/api/builderlab/list"] = () => ({ communities: [] });
  let listCalls = calls.filter(
    ([url]) => url === "/api/builderlab/list",
  ).length;
  fireEvent.click(refresh);
  await waitFor(() =>
    expect(
      calls.filter(([url]) => url === "/api/builderlab/list").length,
    ).toBeGreaterThan(listCalls),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
  );
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  listCalls = calls.filter(([url]) => url === "/api/builderlab/list").length;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(
      calls.filter(([url]) => url === "/api/builderlab/list").length,
    ).toBeGreaterThan(listCalls),
  );
  expect(
    screen.queryByText("North.communities.buzz.xyz"),
  ).not.toBeInTheDocument();
  const original = deletionPosts()[0]?.[1];
  expect(deletionPosts()).toEqual([
    ["/api/builderlab/delete", original],
    ["/api/builderlab/delete", original],
  ]);
});

it.each([
  [
    "uncertain",
    () =>
      Response.json({ error: { code: "acceptance_unknown" } }, { status: 503 }),
  ],
  [
    "in progress",
    (request: Record<string, string | number>) =>
      Response.json({ ...request, status: "cache_purged" }, { status: 202 }),
  ],
])(
  "retains an accepted row on a stale-list %s replay",
  async (_label, replay) => {
    routes["/api/builderlab/list"] = () => ({ communities: [archived] });
    routes["/api/builderlab/delete"] = (body) =>
      Response.json(accepted(body), { status: 202 });
    renderCard();
    await confirmDeletion();
    expect(await screen.findByText("Deletion started")).toBeVisible();
    const original = deletionPosts()[0]?.[1];
    routes["/api/builderlab/delete"] = replay;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(deletionPosts()).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
    );
    expect(deletionPosts().map(([, body]) => body)).toEqual([
      original,
      original,
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(deletionPosts()).toHaveLength(3));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
    );
    expect(deletionPosts().map(([, body]) => body)).toEqual([
      original,
      original,
      original,
    ]);
    expect(
      screen.queryByText(/North\.communities\.buzz\.xyz · Archived/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Deletion started")).toBeVisible();
    expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
  },
);

it("does not replay an accepted row during Refresh when capability is off", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = (body) =>
    Response.json(accepted(body), { status: 202 });
  renderCard();
  await confirmDeletion();
  await screen.findByText("Deletion started");
  routes["/api/builderlab/auth"] = () => ({
    auth: { expiresAt: "2030", capabilities: {} },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
  );
  expect(deletionPosts()).toHaveLength(1);
  expect(
    screen.queryByText(/North\.communities\.buzz\.xyz · Archived/),
  ).not.toBeInTheDocument();
});

it("stops accepted-row replay when the card retires mid-Refresh", async () => {
  const second = {
    ...archived,
    id: "22222222-2222-4222-8222-222222222222",
    name: "south",
    normalized_host: "South.communities.buzz.xyz",
  };
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = (body) =>
    Response.json(accepted(body), { status: 202 });
  let live = true;
  render(<HostedCommunities api={brokerApi} active={() => live} />);
  await confirmDeletion();
  await screen.findByText("Deletion started");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
  );
  routes["/api/builderlab/list"] = () => ({ communities: [archived, second] });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  const secondDialog = await screen.findByRole("dialog", {
    name: /Permanently delete south/,
  });
  fireEvent.change(within(secondDialog).getByLabelText("Type the exact host"), {
    target: { value: second.normalized_host },
  });
  fireEvent.click(
    within(secondDialog).getByRole("checkbox", {
      name: /I understand this cannot be canceled/,
    }),
  );
  fireEvent.click(
    within(secondDialog).getByRole("button", { name: "Start deletion" }),
  );
  await waitFor(() => expect(deletionPosts()).toHaveLength(3));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
  );
  const beforeReplay = deletionPosts().length;
  const firstReplay = hold();
  routes["/api/builderlab/delete"] = firstReplay.answer as Handler;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(deletionPosts()).toHaveLength(beforeReplay + 1));
  live = false;
  await act(async () =>
    firstReplay.release(
      Response.json(
        { ...deletionPosts()[beforeReplay]?.[1], status: "aborted" },
        { status: 202 },
      ),
    ),
  );
  expect(deletionPosts()).toHaveLength(beforeReplay + 1);
  expect(
    screen.queryByRole("button", { name: "Delete" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Deletion started")).toBeVisible();
  expect(
    screen.queryByText(
      `Deletion of ${archived.normalized_host} stopped. This community is not being deleted.`,
    ),
  ).not.toBeInTheDocument();
});

it("shows a Refresh replay error without uncovering an accepted row", async () => {
  routes["/api/builderlab/list"] = () => ({ communities: [archived] });
  routes["/api/builderlab/delete"] = (body) =>
    Response.json(accepted(body), { status: 202 });
  renderCard();
  await confirmDeletion();
  await screen.findByText("Deletion started");
  const replay = hold();
  routes["/api/builderlab/delete"] = replay.answer as Handler;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(deletionPosts()).toHaveLength(2));
  await act(async () =>
    replay.release(
      Response.json({ error: { code: "relay_unavailable" } }, { status: 503 }),
    ),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't check deletion status.",
  );
  expect(screen.getByText("Deletion started")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Delete" }),
  ).not.toBeInTheDocument();
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
});

it.each(["accepted", "bound abort", "definitive rejection"])(
  "generation-fences a late %s after an A to B to A account sequence",
  async (outcome) => {
    routes["/api/builderlab/list"] = () => ({ communities: [archived] });
    const admission = hold();
    routes["/api/builderlab/delete"] = admission.answer as Handler;
    const view = render(
      <HostedCommunities api={brokerApi} active={() => true} />,
    );
    await confirmDeletion();
    await waitFor(() =>
      expect(calls.map(([url]) => url)).toContain("/api/builderlab/delete"),
    );
    const old = JSON.parse(localStorage.getItem(DELETION_PENDING_KEY) ?? "");
    view.unmount();
    const middle = {
      ...old,
      owner_pubkey: other,
      request: {
        ...old.request,
        request_id: "55555555-5555-4555-8555-555555555555",
      },
    };
    localStorage.setItem(DELETION_PENDING_KEY, JSON.stringify(middle));
    routes["/api/builderlab/identity"] = () => ({
      identity: { pubkey_hex: other },
    });
    const middleView = render(
      <HostedCommunities api={brokerApi} active={() => true} />,
    );
    await screen.findByText(middle.request.request_id);
    middleView.unmount();
    const next = {
      ...old,
      request: {
        ...old.request,
        request_id: "66666666-6666-4666-8666-666666666666",
      },
    };
    localStorage.setItem(DELETION_PENDING_KEY, JSON.stringify(next));
    routes["/api/builderlab/identity"] = () => ({
      identity: { pubkey_hex: local },
    });
    render(<HostedCommunities api={brokerApi} active={() => true} />);
    await screen.findByText(next.request.request_id);
    await act(async () =>
      admission.release(
        outcome === "accepted"
          ? Response.json(accepted(old.request), { status: 202 })
          : outcome === "bound abort"
            ? Response.json(
                {
                  ...old.request,
                  status: "aborted",
                  correlation_id: "corr-late-abort",
                },
                { status: 202 },
              )
            : Response.json(
                {
                  error: { code: "must_archive" },
                  correlation_id: "corr-late-rejection",
                },
                { status: 409 },
              ),
      ),
    );
    await act(async () => Promise.resolve());
    expect(
      JSON.parse(localStorage.getItem(DELETION_PENDING_KEY) ?? ""),
    ).toEqual(next);
  },
);
