import { createConsola } from "consola";
import { Context } from "@deepseek-ai/cordis";
import { HostService } from "../src/features/host/service.ts";
import { authTagOwner } from "../src/features/agents/owner-attestation.ts";
import { publishAgentRecord } from "../src/features/agents/relay-removal.ts";
import { logSocketFrame } from "../src/features/developer/traffic.ts";
import { getLogger, setLogLevel } from "../src/features/developer/logging.ts";
import { brokerSocket, openBrokerSocket } from "../tests/broker-socket.mjs";
import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";
import { createRelayReader } from "../src/features/relay/reader.ts";
import { createServer, get, request } from "node:http";
import { createHash, createHmac } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { ReadableStream } from "node:stream/web";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  nip44,
  generateSecretKey,
} from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import {
  CANVAS_MAX_EVENT_BYTES,
  LIVE_CANVAS_BYTES,
} from "../src/features/channel-templates/canvas-limits.ts";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { createOutbox, PublishRejected } from "../src/features/relay/outbox.ts";
import { createRelaySession } from "../src/features/relay/session.ts";
import { feedbackEvent } from "../src/features/relay/product-feedback.ts";
import { archiveRequestTemplate } from "../src/features/relay/identity-archive-protocol.ts";

// Only wall time is controlled. Real timers/performance.now still exercise HTTP admission.
let wallClock;
beforeEach(() => {
  wallClock = 1700000000999;
  vi.spyOn(Date, "now").mockImplementation(() => wallClock);
});
afterEach(() => vi.restoreAllMocks());

// Real browser HTTP -> production broker. Ephemeral key; upstream I/O is entirely local.
async function harness(
  respond,
  capabilities = {},
  relayUrl = fixtureRelayUrl,
  builderlab = {},
) {
  const key = new Uint8Array(32);
  key[31] = 7;
  const viewer = getPublicKey(key);
  const event = finalizeEvent(
    { kind: 9, content: "fixture", created_at: 1700000000, tags: [["h", "c"]] },
    key,
  );
  const calls = [];
  const socket = brokerSocket();
  let live;
  let handler;
  const server = createServer((req, res) => {
    req.headers.origin = `http://${req.headers.host}`;
    handler?.(req, res);
  });
  const plugin = relayBrokerPlugin({
    archiveFile: ":memory:",
    relayUrl,
    builderlab,
    communityAliases: fixtureAliases,
    identity: () => key,
    socketFactory: socket.factory,
    authority: async () => ({ relayAuthor: viewer, ...capabilities }),
    upstreamFetch: async (url, init) => {
      const upstreamUrl = String(url);
      const authorization = new Headers(init?.headers).get("Authorization");
      const auth = authorization
        ? JSON.parse(Buffer.from(authorization.slice(6), "base64").toString())
        : undefined;
      if (
        upstreamUrl === fixtureRelayUrl ||
        upstreamUrl === `${fixtureRelayUrl}/api/join-policy`
      )
        expect(auth).toBeUndefined();
      else expect(auth).toBeDefined();
      if (auth) {
        expect(verifyEvent(auth)).toBe(true);
        expect(auth.created_at).toBe(Math.floor(Date.now() / 1000));
      }
      const call = {
        url: upstreamUrl,
        body: init?.body ? JSON.parse(init.body) : undefined,
        signal: init?.signal,
        headers: init?.headers,
        auth,
        at: performance.now(),
      };
      calls.push(call);
      return respond(call, calls.length, event);
    },
  });
  await plugin.configureServer({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(cb) {
        handler = cb;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    server,
    event,
    calls,
    publications: socket.publications,
    async start() {
      live = await openBrokerSocket(await connectBrokerTransport(base));
    },
    get(route, signal) {
      return fetch(`${base}/api/relay/${route}`, { signal });
    },
    post(route, body, signal, priority) {
      return fetch(`${base}/api/relay/${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(live ? { "X-Buzz-Live-ID": live.identity() } : {}),
          ...(priority ? { "X-Buzz-Read-Priority": priority } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    },
    async close() {
      live?.dispose();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
/** Native media URLs name one sha256 blob; the broker enforces the same shape. */
const blob = "c".repeat(64);
const filters = [{ kinds: [0], limit: 1 }];

test.each([
  [202, { status: "aborted" }],
  [409, { error: { code: "must_archive" } }],
])(
  "Builderlab HTTP forwards structured deletion status %s",
  async (status, result) => {
    let openLogin;
    const loginOpened = new Promise((resolve) => {
      openLogin = resolve;
    });
    const request = {
      community_id: "11111111-1111-4111-8111-111111111111",
      host: "north.communities.buzz.xyz",
      request_id: "22222222-2222-4222-8222-222222222222",
      acknowledgement_version: 1,
    };
    const upstream = [];
    const h = await harness(() => Response.json([]), {}, fixtureRelayUrl, {
      open: async (url) => openLogin(url),
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/v1/auth/login/exchange"))
          return Response.json({
            session_credential: "fixture-only",
            expires_at: "2030",
          });
        if (path.endsWith("/v1/auth/me"))
          return Response.json({
            subject: "auth0|owner",
            email: "fixture@example.com",
            expires_at: "2030",
          });
        if (path.endsWith("/v1/buzz/communities/delete")) {
          upstream.push(JSON.parse(init.body));
          return Response.json({ ...request, ...result }, { status });
        }
        throw new Error(`Unexpected fixture request: ${path}`);
      },
    });
    try {
      const login = fetch(`${h.base}/api/builderlab/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const opened = new URL(await loginOpened);
      const callback = opened.searchParams.get("redirect_uri");
      expect(callback).toBeTruthy();
      expect(
        (
          await fetch(
            `${callback}?state=${opened.searchParams.get("state")}&code=fixture`,
          )
        ).status,
      ).toBe(200);
      expect((await login).status).toBe(200);
      const response = await fetch(`${h.base}/api/builderlab/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ ...request, ...result });
      expect(upstream).toEqual([request]);
    } finally {
      await h.close();
    }
  },
);

const success = (call) =>
  Response.json(
    call.url.endsWith("/events")
      ? { accepted: true, event_id: call.body.id }
      : [],
  );

test("remote agent authorization is owner-bound and works without a community", async () => {
  // No default community is selected, and any upstream request fails.
  const h = await harness(
    () => {
      throw new Error("Authorization must not contact upstream");
    },
    {},
    "",
  );
  try {
    const owner = (await (await h.get("identity")).json()).viewer;
    const agentPubkey = getPublicKey(generateSecretKey());
    const http = globalThis.fetch;
    vi.stubGlobal("fetch", (url, input) => http(new URL(url, h.base), input));
    vi.stubEnv("VITE_BUZZ_LIVE", "1");
    const context = new Context();
    const host = new HostService(context);
    const tag = await host.prepareRemoteAgentAuthorization(agentPubkey);
    // The host returns an unconditional proof for the requested agent and owner.
    expect(await authTagOwner(agentPubkey, tag)).toBe(owner);
    expect(tag.slice(0, 3)).toEqual(["auth", h.event.pubkey, ""]);
    // The signature binds the exact agent key to the NIP-OA domain.
    expect(
      schnorr.verify(
        Buffer.from(tag[3], "hex"),
        createHash("sha256")
          .update(`nostr:agent-auth:${agentPubkey}:`)
          .digest(),
        Buffer.from(tag[1], "hex"),
      ),
    ).toBe(true);
    const route = "prepare-remote-agent-authorization";
    for (const rejected of [
      "invalid", // Malformed key.
      "A".repeat(64), // Uppercase hex.
      h.event.pubkey, // Self-attestation.
      null, // Null agent key.
      42, // Non-string agent key.
    ]) {
      expect(
        (await h.post(route, { owner: h.event.pubkey, agentPubkey: rejected }))
          .status,
      ).toBe(400);
    }
    // A different owner cannot use the broker's identity to sign.
    expect(
      (await h.post(route, { owner: "f".repeat(64), agentPubkey })).status,
    ).toBe(403);
    // The request must explicitly bind the current owner.
    expect((await h.post(route, { agentPubkey })).status).toBe(403);
    // A non-object request body is rejected.
    expect((await h.post(route, null)).status).toBe(400);
    // Oversized requests are rejected before signing.
    expect(
      (await h.post(route, { owner, agentPubkey: "a".repeat(4096) })).status,
    ).toBe(413);
    // Successful and rejected authorization requests stay local.
    expect(h.calls).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await h.close();
  }
});

test("production transport obtains scoped broker harness log proofs for aliases and canonical origins", async () => {
  const h = await harness(success);
  const key = new Uint8Array(32);
  key[31] = 7;
  const viewer = getPublicKey(key);
  const pubkey = "ab".repeat(32);
  const relayUrl = "wss://primary.example";
  const id = `${pubkey}-${createHash("sha256").update(relayUrl).digest("hex")}`;
  const nonce = "12345678-1234-1234-1234-123456789abc";
  const target = { id, pubkey, relayUrl };
  try {
    for (const community of ["primary", fixtureRelayUrl]) {
      const transport = await connectBrokerTransport(
        h.base,
        undefined,
        community,
      );
      expect(transport.authorizeAgentLog).toBeTypeOf("function");
      const signature = await transport.authorizeAgentLog(target, nonce);
      const digest = createHash("sha256")
        .update(`buzz-app:harness-log:v1:${id}:${pubkey}:${relayUrl}:${nonce}`)
        .digest();
      expect(
        schnorr.verify(
          Buffer.from(signature, "hex"),
          digest,
          Buffer.from(viewer, "hex"),
        ),
      ).toBe(true);
      await expect(
        transport.authorizeAgentLog(
          { ...target, relayUrl: "wss://secondary.example" },
          nonce,
        ),
      ).rejects.toThrow("Log authorization unavailable");
    }
    const other = await connectBrokerTransport(h.base, undefined, "secondary");
    await expect(other.authorizeAgentLog(target, nonce)).rejects.toThrow(
      "Log authorization unavailable",
    );
  } finally {
    await h.close();
  }
});

test("harness log proof signs only exact scoped community and agent inputs", async () => {
  const h = await harness(success);
  const key = new Uint8Array(32);
  key[31] = 7;
  const viewer = getPublicKey(key);
  const pubkey = "ab".repeat(32);
  const relayUrl = "wss://primary.example";
  const id = `${pubkey}-${createHash("sha256").update(relayUrl).digest("hex")}`;
  const nonce = "12345678-1234-1234-1234-123456789abc";
  const target = { id, pubkey, relayUrl, nonce };
  try {
    const registered = await h.post("register", { url: fixtureRelayUrl });
    expect(registered.status).toBe(200);
    const route = "primary/agent-log-proof";
    expect((await h.post("agent-log-proof", target)).status).toBe(400);
    for (const invalid of [
      { ...target, id: `${"f".repeat(64)}-${id.slice(65)}` },
      { ...target, pubkey: viewer },
      { ...target, relayUrl: "wss://secondary.example" },
      { ...target, relayUrl: "file:///private" },
      { ...target, nonce: "invalid" },
      { ...target, extra: true },
    ])
      expect((await h.post(route, invalid)).status).toBe(400);
    const result = await h.post(route, target);
    expect(result.status).toBe(200);
    const { signature } = await result.json();
    const digest = createHash("sha256")
      .update(`buzz-app:harness-log:v1:${id}:${pubkey}:${relayUrl}:${nonce}`)
      .digest();
    expect(
      schnorr.verify(
        Buffer.from(signature, "hex"),
        digest,
        Buffer.from(viewer, "hex"),
      ),
    ).toBe(true);
    expect(
      schnorr.verify(
        Buffer.from(signature, "hex"),
        createHash("sha256")
          .update(
            `buzz-app:harness-log:v1:${id}:${pubkey}:wss://secondary.example:${nonce}`,
          )
          .digest(),
        Buffer.from(viewer, "hex"),
      ),
    ).toBe(false);
  } finally {
    await h.close();
  }
});

test("Git authorization signs only this community's exact repository URL", async () => {
  const h = await harness(success);
  const key = new Uint8Array(32);
  key[31] = 7;
  const viewer = getPublicKey(key);
  const repository = `https://primary.example/git/${"ab".repeat(32)}/plugins`;
  try {
    expect((await h.post("register", { url: fixtureRelayUrl })).status).toBe(
      200,
    );
    expect((await h.post("git-authorization", { repository })).status).toBe(
      400,
    );
    for (const invalid of [
      { repository: `https://secondary.example/git/${"ab".repeat(32)}/x` },
      { repository: ` ${repository}` },
      { repository: `${repository}/info/refs` },
      { repository, extra: true },
      { url: repository },
    ])
      expect((await h.post("primary/git-authorization", invalid)).status).toBe(
        400,
      );
    const result = await h.post("primary/git-authorization", { repository });
    expect(result.status).toBe(200);
    const { token } = await result.json();
    const auth = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    expect(verifyEvent(auth)).toBe(true);
    expect(auth).toMatchObject({
      kind: 27235,
      pubkey: viewer,
      content: "",
      tags: [
        ["u", repository],
        ["method", "GET"],
      ],
    });
  } finally {
    await h.close();
  }
});

test("saved community presentation survives join-policy failure without changing join discovery", async () => {
  const icon = "https://images.example/icon@2x.png";
  const h = await harness((call) => {
    if (call.url === fixtureRelayUrl)
      return Response.json({
        icon,
        name: "Published",
        description: "Not projected",
      });
    if (call.url === `${fixtureRelayUrl}/api/join-policy`)
      return new Response("unavailable", { status: 503 });
    return new Response(null, { status: 404 });
  });
  try {
    const iconResponse = await h.get("icon-info");
    expect(iconResponse.status).toBe(200);
    expect(await iconResponse.json()).toEqual({ icon, name: "Published" });
    expect(h.calls.map(({ url }) => url)).toEqual([fixtureRelayUrl]);

    const joinResponse = await h.get("info");
    const joinBody = await joinResponse.json();
    expect([joinResponse.status, joinBody]).toEqual([
      503,
      { error: "Could not load join policy" },
    ]);
    expect(h.calls.map(({ url }) => url)).toEqual([
      fixtureRelayUrl,
      fixtureRelayUrl,
      `${fixtureRelayUrl}/api/join-policy`,
    ]);
  } finally {
    await h.close();
  }
});

test("GIF discovery retries unsupported relays and caches confirmed support", async () => {
  let supported = false;
  const descriptor = {
    supported_extensions: ["buzz-gif"],
    gif: { provider: "klipy", search: "/gifs/search" },
  };
  const h = await harness(() => Response.json(supported ? descriptor : {}));
  try {
    expect(await (await h.get("gif-info")).json()).toEqual({});
    supported = true;
    expect(await (await h.get("gif-info")).json()).toEqual(descriptor);
    expect(await (await h.get("gif-info")).json()).toEqual(descriptor);
    expect(h.calls.map(({ url }) => url)).toEqual([
      fixtureRelayUrl,
      fixtureRelayUrl,
    ]);
  } finally {
    await h.close();
  }
});

test("GIF search follows the relay-advertised KLIPY path with signed, bounded input", async () => {
  const responseBody = {
    result: true,
    data: { data: [{ id: 1, type: "gif", slug: "hello" }] },
  };
  const h = await harness((call) => {
    if (call.url === fixtureRelayUrl)
      return Response.json({
        supported_extensions: ["buzz-gif"],
        gif: { provider: "klipy", search: "/gifs/search" },
      });
    if (call.url === `${fixtureRelayUrl}/gifs/search`)
      return Response.json(responseBody);
    return new Response(null, { status: 404 });
  });
  try {
    const body = {
      customer_id: "fixture-customer",
      locale: "en-US",
      query: "hello",
    };
    const response = await h.post("gifs", body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(responseBody);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]).toMatchObject({
      url: fixtureRelayUrl,
      body: undefined,
      auth: undefined,
    });
    expect(h.calls[1]).toMatchObject({
      url: `${fixtureRelayUrl}/gifs/search`,
      body,
    });
    expect(h.calls[1].auth.tags).toEqual(
      expect.arrayContaining([
        ["u", `${fixtureRelayUrl}/gifs/search`],
        ["method", "POST"],
        [
          "payload",
          createHash("sha256").update(JSON.stringify(body)).digest("hex"),
        ],
      ]),
    );

    const rejected = await h.post("gifs", { ...body, query: "x".repeat(101) });
    expect(rejected.status).toBe(400);
    expect(h.calls).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("profile search forwards only the name-search shape to the relay endpoint, signed", async () => {
  const profiles = [{ id: "a".repeat(64), kind: 0 }];
  let status = 200;
  const h = await harness((call) =>
    call.url === `${fixtureRelayUrl}/profiles/search`
      ? status === 200
        ? Response.json(profiles)
        : Response.json({ error: "not found" }, { status })
      : new Response(null, { status: 500 }),
  );
  try {
    const body = { query: "wes", limit: 40, page: 2 };
    const response = await h.post("profile-search", body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(profiles);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      url: `${fixtureRelayUrl}/profiles/search`,
      body,
    });
    expect(h.calls[0].auth.tags).toEqual(
      expect.arrayContaining([
        ["u", `${fixtureRelayUrl}/profiles/search`],
        ["method", "POST"],
        [
          "payload",
          createHash("sha256").update(JSON.stringify(body)).digest("hex"),
        ],
      ]),
    );

    // An older relay's 404 reaches the app, which then uses NIP-50 search.
    status = 404;
    expect((await h.post("profile-search", body)).status).toBe(404);

    // The limit counts code points: 100 astral characters are 200 UTF-16
    // units, and surrounding whitespace does not count.
    status = 200;
    const astral = { query: ` ${"𠮷".repeat(100)} `, limit: 1 };
    expect((await h.post("profile-search", astral)).status).toBe(200);
    expect(h.calls[2]).toMatchObject({ body: astral });

    for (const rejected of [
      { query: "", limit: 1 },
      { query: "x".repeat(101), limit: 1 },
      { query: "𠮷".repeat(101), limit: 1 },
      { query: "wes", limit: 0 },
      { query: "wes", limit: 101 },
      { query: "wes", limit: 1, search_mode: "prefix" },
      { query: "wes", limit: 1, page: 0 },
      { query: "wes", limit: 1, page: 1001 },
      { query: "wes", limit: 1, page: 1.5 },
    ])
      expect((await h.post("profile-search", rejected)).status).toBe(400);
    expect(h.calls).toHaveLength(3);
  } finally {
    await h.close();
  }
});

test("media proxy returns generic files as neutralized authenticated downloads", async () => {
  const bytes = Buffer.from("%PDF-1.7\nfixture pdf\n");
  const h = await harness((call) => {
    expect(call.url).toBe(`${fixtureRelayUrl}/media/${blob}.pdf`);
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.length),
        "Accept-Ranges": "bytes",
      },
    });
  });
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/${blob}.pdf`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(h.calls).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("media proxy neutralizes active content as downloads", async () => {
  const activeTypes = [
    "text/html",
    "image/svg+xml",
    "image/svg+xml; charset=utf-8",
    "IMAGE/SVG+XML",
  ];
  for (const contentType of activeTypes) {
    const bytes = Buffer.from(`<script>${contentType}</script>`);
    const h = await harness(
      () =>
        new Response(bytes, {
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(bytes.length),
          },
        }),
    );
    try {
      const response = await fetch(
        `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/${blob}`)}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("content-disposition")).toBe("attachment");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      await h.close();
    }
  }
});

test("media proxy neutralizes comma-joined content types as downloads", async () => {
  const bytes = Buffer.from("fake png then svg");
  const h = await harness(
    () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "image/png, image/svg+xml",
          "Content-Length": String(bytes.length),
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/${blob}`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    await h.close();
  }
});

test("media proxy strips smuggled inline content type parameters", async () => {
  const bytes = Buffer.from("fake png then svg");
  const h = await harness(
    () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "image/png;x, image/svg+xml",
          "Content-Length": String(bytes.length),
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/${blob}`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    await h.close();
  }
});

test("media proxy neutralizes missing or empty content types as downloads", async () => {
  for (const headers of [{}, { "Content-Type": "" }]) {
    const bytes = Buffer.from("unknown bytes");
    const h = await harness(
      () =>
        new Response(bytes, {
          headers: { ...headers, "Content-Length": String(bytes.length) },
        }),
    );
    try {
      const response = await fetch(
        `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/${blob}`)}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("content-disposition")).toBe("attachment");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      await h.close();
    }
  }
});

test("media proxy keeps raster images inline with exact bytes", async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const h = await harness(
    () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(bytes.length),
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/${blob}.png`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    await h.close();
  }
});

test.each([
  ["application/zip", 100],
  ["image/png", 50],
  ["image/gif", 10],
  ["video/mp4", 500],
])(
  "media proxy rejects %s above its %i MiB declared budget",
  async (type, mib) => {
    let cancelled = false;
    const h = await harness(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              "Content-Type": type,
              "Content-Length": String(mib * 1024 * 1024 + 1),
            },
          },
        ),
    );
    try {
      const response = await fetch(
        `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/${blob}`)}`,
      );
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "Media budget exceeded" });
      expect(cancelled).toBe(true);
    } finally {
      await h.close();
    }
  },
);

test("unknown-length media is metered, cancelled on overflow and leaves the broker usable", async () => {
  let cancelled = false;
  let oversized = true;
  const chunk = new Uint8Array(1024 * 1024);
  const h = await harness(() =>
    oversized
      ? new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "image/gif" } },
        )
      : new Response("ok", { headers: { "Content-Type": "text/plain" } }),
  );
  try {
    // Either the initial read or the body must fail: an over-budget stream must
    // never complete successfully after headers have already reached the client.
    await expect(
      (async () => {
        const response = await h.get(
          `media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/${blob}.gif`)}`,
        );
        await response.arrayBuffer();
      })(),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(cancelled).toBe(true));
    oversized = false;
    const next = await h.get(
      `media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/${blob}.txt`)}`,
    );
    expect(next.headers.get("content-disposition")).toBe("attachment");
    expect(await next.text()).toBe("ok");
  } finally {
    await h.close();
  }
});

test("media deadline cancels the response pipeline after headers", async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  let cancelled = false;
  const h = await harness(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "video/mp4" } },
      ),
  );
  try {
    const response = await h.get(
      `media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/${blob}.mp4`)}`,
    );
    const reader = response.body.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    deadline.abort();
    await expect(reader.read()).rejects.toThrow();
    await vi.waitFor(() => expect(cancelled).toBe(true));
  } finally {
    await h.close();
  }
});

test("media proxy streams authenticated video ranges and preserves seek headers", async () => {
  const bytes = Buffer.from("video-range");
  const h = await harness((call) => {
    expect(call.url).toBe(`${fixtureRelayUrl}/media/${blob}.mp4`);
    expect(call.headers.Range).toBe("bytes=100-");
    return new Response(bytes, {
      status: 206,
      headers: {
        "Content-Type": 'video/mp4; codecs="avc1.42E01E"',
        "Content-Length": String(bytes.length),
        "Content-Range": "bytes 100-110/1000",
        "Accept-Ranges": "bytes",
      },
    });
  });
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/${blob}.mp4`)}`,
      { headers: { Range: "bytes=100-" } },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-range")).toBe("bytes 100-110/1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(h.calls).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("media proxy streams authenticated audio ranges and preserves seek headers", async () => {
  const bytes = Buffer.from("audio-range");
  const h = await harness((call) => {
    expect(call.url).toBe(`${fixtureRelayUrl}/media/${blob}.mp3`);
    expect(call.headers.Range).toBe("bytes=100-");
    return new Response(bytes, {
      status: 206,
      headers: {
        "Content-Type": "Audio/MPEG; charset=utf-8",
        "Content-Length": String(bytes.length),
        "Content-Range": "bytes 100-110/1000",
        "Accept-Ranges": "bytes",
      },
    });
  });
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/${blob}.mp3`)}`,
      { headers: { Range: "bytes=100-" } },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("content-range")).toBe("bytes 100-110/1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(h.calls).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("media proxy rejects oversized non-range audio", async () => {
  const h = await harness(
    () =>
      new Response("too large", {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(20 * 1024 * 1024 + 1),
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/${blob}.mp3`)}`,
    );
    expect(response.status).toBe(413);
  } finally {
    await h.close();
  }
});

test("media proxy neutralizes non-media content types as downloads", async () => {
  const bytes = Buffer.from("plain");
  const h = await harness(
    () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": String(bytes.length),
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/${blob}.txt`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("accept-ranges")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    await h.close();
  }
});

test("an upstream video stream error closes only that response, not the broker", async () => {
  const h = await harness(() => {
    let controller;
    const body = new ReadableStream({
      start(value) {
        controller = value;
        value.enqueue(new Uint8Array([1, 2, 3]));
      },
    });
    queueMicrotask(() =>
      controller.error(new DOMException("timed out", "TimeoutError")),
    );
    return new Response(body, {
      status: 206,
      headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-2/10" },
    });
  });
  try {
    await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/${blob}.mp4`)}`,
      { headers: { Range: "bytes=0-" } },
    )
      .then((response) => response.arrayBuffer())
      .catch(() => {});
    const session = await fetch(`${h.base}/api/relay/session`);
    expect(session.status).toBe(200);
    // The HTTP base lets the workflows page display `/hooks/{workflow_id}` addresses.
    expect(await session.json()).toMatchObject({
      relayUrl: fixtureRelayUrl,
      relayHttpUrl: fixtureRelayUrl,
    });
  } finally {
    await h.close();
  }
});

test("media proxy rejects malformed ranges before upstream I/O", async () => {
  const h = await harness(() => {
    throw new Error("unexpected upstream call");
  });
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/${blob}.mp4`)}`,
      { headers: { Range: "items=0-1" } },
    );
    expect(response.status).toBe(416);
    expect(h.calls).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test("media proxy accepts only the media URLs the native proxy accepts", async () => {
  const relayHost = new URL(fixtureRelayUrl).host;
  const scheme = new URL(fixtureRelayUrl).protocol;
  const still = `${fixtureRelayUrl}/media/${blob}.png`;
  const rejected = [
    // Desktop's animated-avatar suffix; clients must request the still image.
    `${still}#buzz-anim=${encodeURIComponent(`${fixtureRelayUrl}/media/${"d".repeat(64)}.png`)}`,
    `${still}#`,
    `${still}?size=small`,
    `${still}?`,
    `${scheme}//user@${relayHost}/media/${blob}.png`,
    `/media/${blob}.png`,
    `https://other.test/media/${blob}.png`,
    `${fixtureRelayUrl}/media/file.png`,
    `${fixtureRelayUrl}/media/${"C".repeat(64)}.png`,
    `${fixtureRelayUrl}/media/${blob}.PNG`,
    `${fixtureRelayUrl}/media/${blob}.toolongext`,
    `${fixtureRelayUrl}/media/${blob}.tar.gz`,
    `${fixtureRelayUrl}/media/${blob}/nested.png`,
    `${fixtureRelayUrl}/other/${blob}.png`,
  ];
  const accepted = [
    `${fixtureRelayUrl}/media/${blob}`,
    still,
    `${fixtureRelayUrl}/media/${blob}.thumb.jpg`,
  ];
  const h = await harness(
    () => new Response("ok", { headers: { "Content-Type": "image/png" } }),
  );
  try {
    for (const target of rejected) {
      const response = await fetch(
        `${h.base}/api/relay/media?url=${encodeURIComponent(target)}`,
      );
      expect(response.status, target).toBe(403);
    }
    expect(h.calls).toHaveLength(0);
    for (const target of accepted) {
      const response = await fetch(
        `${h.base}/api/relay/media?url=${encodeURIComponent(target)}`,
      );
      expect(response.status, target).toBe(200);
    }
    expect(h.calls.map((call) => call.url)).toEqual(accepted);
  } finally {
    await h.close();
  }
});

test("upstream quota survives browser recreation, gates reads/profile and leaves other communities independent", async () => {
  const h = await harness((call, count, event) =>
    count === 1
      ? Response.json(
          {
            error: "rate-limited: quota exceeded; retry in 0s",
            secret: "not forwarded",
          },
          { status: 429 },
        )
      : success(call, count, event),
  );
  try {
    const first = await connectBrokerTransport(h.base);
    await expect(first.query(filters)).rejects.toMatchObject({
      kind: "unavailable",
      status: 429,
      retryAfterMs: 1000,
    });
    const replacement = await connectBrokerTransport(h.base);
    await expect(replacement.query(filters)).rejects.toMatchObject({
      kind: "unavailable",
      status: 429,
      retryAfterMs: expect.any(Number),
    });
    await expect(
      replacement.writer.publish(h.event, new AbortController().signal),
    ).rejects.toBeInstanceOf(PublishRejected);
    const profile = await h.post("profile", { name: "Fixture", picture: "" });
    expect(profile.status).toBe(429);
    expect(await profile.json()).toMatchObject({ paused: true, sent: false });
    expect(h.calls).toHaveLength(1);
    const independent = await connectBrokerTransport(
      h.base,
      undefined,
      "secondary",
    );
    await independent.query(filters);
    expect(h.calls).toHaveLength(2);
    await delay(1050);
    expect(
      (await h.post("profile", { name: "Fixture", picture: "" })).status,
    ).toBe(200);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2].body.kind).toBe(0);
    expect(h.calls[2].at - h.calls[0].at).toBeGreaterThanOrEqual(1000);
  } finally {
    await h.close();
  }
});

test("foreground profile publication starts while background I/O is outstanding; cancellation does not replay", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(async (call, count, event) => {
    if (call.url.endsWith("/query")) await held;
    return success(call, count, event);
  });
  const cancel = new AbortController();
  try {
    const background = h.post("query", filters, cancel.signal, "background");
    const rejection = expect(background).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    const write = await h.post("profile", { name: "Fixture", picture: "" });
    expect(write.status).toBe(200);
    await write.text();
    cancel.abort();
    await rejection;
    release();
    expect(h.calls.map((c) => c.url.split("/").at(-1))).toEqual([
      "query",
      "events",
    ]);
  } finally {
    release();
    cancel.abort();
    await h.close();
  }
});

// Delivers bytes in two HTTP chunks, the second only after the broker has read the first.
async function postSplit(h, path, bytes, at) {
  const read = new Promise((resolve) =>
    h.server.once("request", (req) => resolve(vi.spyOn(req, "read"))),
  );
  const client = request(`${h.base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const response = new Promise((resolve, reject) =>
    client.once("response", resolve).once("error", reject),
  );
  client.write(bytes.subarray(0, at));
  const spy = await read;
  await vi.waitFor(() =>
    expect(spy.mock.results.some(({ value }) => value?.length)).toBe(true),
  );
  client.end(bytes.subarray(at));
  const res = await response;
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return {
    status: res.statusCode,
    body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
  };
}

const profileName = "café €🛩";
const profileBody = Buffer.from(
  JSON.stringify({ name: profileName, picture: "" }),
);
// Every interior byte of each 2-, 3- and 4-byte UTF-8 sequence.
const profileSplits = [...profileName]
  .filter((char) => Buffer.byteLength(char) > 1)
  .flatMap((char) =>
    Array.from({ length: Buffer.byteLength(char) - 1 }, (_, byte) => [
      char,
      byte + 1,
      profileBody.indexOf(char) + byte + 1,
    ]),
  );

test.each(profileSplits)(
  "signed profile text survives %s split after byte %i across HTTP chunks",
  async (_char, _byte, at) => {
    const h = await harness(success);
    try {
      const response = await postSplit(
        h,
        "/api/relay/profile",
        profileBody,
        at,
      );
      expect(response.status).toBe(200);
      const [published] = h.calls.filter((call) =>
        call.url.endsWith("/events"),
      );
      expect(published.body.kind).toBe(0);
      expect(verifyEvent(published.body)).toBe(true);
      expect(JSON.parse(published.body.content).name).toBe(profileName);
    } finally {
      await h.close();
    }
  },
);

test.each([
  ["/api/builderlab/delete", 4096, "chars", "Request too large"],
  ["/api/relay/register", 4096, "chars", "Relay URL too large"],
  [
    "/api/relay/prepare-remote-agent-authorization",
    4096,
    "bytes",
    "Authorization request is too large",
  ],
  ["/api/relay/archive", 4096, "bytes", "Archive request too large"],
  ["/api/relay/stream-presence", 256, "bytes", "Live control too large"],
  ["/api/relay/stream", 64 * 1024 * 1024, "bytes", "Live interests too large"],
  ["/api/relay/query", 65536, "chars", "Filter body too large"],
  ["/api/relay/presence-snapshot", 20 * 1024, "bytes", "Filter body too large"],
])(
  "%s measures a split multibyte body exactly at its %i %s limit",
  async (path, limit, unit, tooLarge) => {
    const size = (body) =>
      unit === "bytes" ? Buffer.byteLength(body) : body.length;
    const padded = (extra) =>
      Buffer.from(
        JSON.stringify({
          pad: `é${"a".repeat(limit - size(JSON.stringify({ pad: "é" })) + extra)}`,
        }),
      );
    const at = padded(0).indexOf("é") + 1;
    const h = await harness(success);
    try {
      const whole = await fetch(`${h.base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: padded(0),
      });
      const split = await postSplit(h, path, padded(0), at);
      expect(split.status).not.toBe(413);
      expect(split).toEqual({
        status: whole.status,
        body: await whole.json(),
      });
      expect(await postSplit(h, path, padded(1), at)).toEqual({
        status: 413,
        body: { error: tooLarge },
      });
    } finally {
      await h.close();
    }
  },
);

test("local capacity is explicitly unsent, not relay quota; unknown upstream publication is never resent", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(async (call, count, event) => {
    await held;
    return success(call, count, event);
  });
  const controllers = [];
  try {
    const requests = Array.from({ length: 6 }, () => {
      const controller = new AbortController();
      controllers.push(controller);
      return h.post("query", filters, controller.signal);
    });
    await vi.waitFor(() => expect(h.calls).toHaveLength(6));
    const refused = await h.post("profile", { name: "Fixture", picture: "" });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "Query concurrency limit",
      sent: false,
    });
    release();
    await Promise.all(
      requests.map(async (response) => (await response).text()),
    );
    expect(h.calls).toHaveLength(6);
    const transport = await connectBrokerTransport(h.base);
    // Generic upstream 503 is not proof of non-delivery (separate fixture below).
    await transport.query(filters);
    expect(h.calls).toHaveLength(7); // Local capacity did not introduce a relay cooldown.
  } finally {
    release();
    for (const c of controllers) c.abort();
    await h.close();
  }
  const uncertain = await harness(
    () => new Response("private upstream detail", { status: 503 }),
  );
  try {
    const response = await uncertain.post("profile", {
      name: "Fixture",
      picture: "",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("sent");
    expect(uncertain.calls).toHaveLength(1);
    await delay(550);
    expect(uncertain.calls).toHaveLength(1);
  } finally {
    await uncertain.close();
  }
}, 10000);

test("strong channel confirmation filters reach the upstream query unchanged", async () => {
  const h = await harness(() => Response.json([]));
  try {
    const transport = await connectBrokerTransport(h.base);
    const filters = [
      {
        kinds: [39002],
        "#d": ["11111111-1111-4111-8111-111111111111"],
        limit: 1,
        consistency: "strong",
      },
    ];
    await transport.query(filters);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe(`${fixtureRelayUrl}/query`);
    expect(h.calls[0].body).toEqual(filters);
  } finally {
    await h.close();
  }
});

// Reader-to-host priority propagation control contributed by Brain.
test("reader and transport start foreground work without waiting for background completion", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(async (call, count, event) => {
    if (call.body?.[0]?.limit === 2) await held;
    return success(call, count, event);
  });
  let reader;
  try {
    const t = await connectBrokerTransport(h.base);
    reader = createRelayReader(t);
    await reader.reader.read([{ kinds: [0], limit: 1 }]);
    const background = reader.reader.read([{ kinds: [0], limit: 2 }], {
      priority: "background",
    });
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    await reader.reader.read([{ kinds: [0], limit: 3 }], {
      priority: "foreground",
    });
    expect(h.calls.map((c) => c.body[0].limit)).toEqual([1, 2, 3]);
    release();
    await background;
  } finally {
    release();
    reader?.dispose();
    await h.close();
  }
});

test("each request mints fresh auth at dispatch after wall time advances", async () => {
  const h = await harness(success);
  try {
    await (await h.post("query", filters)).text();
    wallClock += 61000;
    const response = await h.post("query", [{ kinds: [0], limit: 2 }]);
    expect(response.status).toBe(200);
    await response.text();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].auth.created_at - h.calls[0].auth.created_at).toBe(61);
  } finally {
    await h.close();
  }
});

test("query keeps relay 403 refusals but turns an edge 403 page into a gateway failure", async () => {
  let edge = false;
  const h = await harness(() =>
    edge
      ? new Response("<html><body>Forbidden</body></html>", {
          status: 403,
          headers: { "Content-Type": "text/html" },
        })
      : Response.json({ error: "restricted: not a member" }, { status: 403 }),
  );
  try {
    const refused = await h.post("query", filters);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ denied: true });
    edge = true;
    const page = await h.post("query", filters);
    expect(page.status).toBe(502);
    expect(await page.json()).toEqual({ error: "Relay request failed (502)" });
  } finally {
    await h.close();
  }
});

test("Canvas sign and publish bound content and the complete signed event", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    await h.start();
    const template = {
      kind: 40100,
      created_at: 1700000000,
      tags: [["h", "11111111-1111-4111-8111-111111111111"]],
    };
    const sign = (content) => h.post("sign", { ...template, content });
    const size = (event) => Buffer.byteLength(JSON.stringify(event));
    const largest = await sign("x".repeat(LIVE_CANVAS_BYTES));
    expect(largest.status).toBe(200);
    const event = await largest.json();
    expect(verifyEvent(event)).toBe(true);
    expect((await h.post("publish", event)).status).toBe(200);
    expect(h.publications).toHaveLength(1);
    expect((await sign("x".repeat(LIVE_CANVAS_BYTES + 1))).status).toBe(400);

    // Quotes escape to two bytes, so in-limit content can make a complete
    // event exactly at, then one byte over, the relay's bound.
    const overhead = size(await (await sign("")).json());
    const quotes = CANVAS_MAX_EVENT_BYTES - overhead - LIVE_CANVAS_BYTES;
    const escaped = (extra) =>
      `${'"'.repeat(quotes + extra)}${"x".repeat(LIVE_CANVAS_BYTES - quotes - extra)}`;
    const atBound = await sign(escaped(0));
    expect(atBound.status).toBe(200);
    const boundary = await atBound.json();
    expect(size(boundary)).toBe(CANVAS_MAX_EVENT_BYTES);
    expect((await h.post("publish", boundary)).status).toBe(200);
    const over = await sign(escaped(1));
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual({
      error: "Relay event is too large",
      sent: false,
    });
    // An event signed elsewhere is held to the same bound before publication;
    // its request body is the event, so the body bound refuses it first.
    const outside = finalizeEvent(
      { ...template, content: escaped(1) },
      generateSecretKey(),
    );
    expect(size(outside)).toBe(CANVAS_MAX_EVENT_BYTES + 1);
    expect((await h.post("publish", outside)).status).toBe(413);
    expect(h.publications).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("reaction sign and publish preserve kind 7 and reject malformed targets before upstream I/O", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    await h.start();
    const template = {
      ...h.event,
      kind: 7,
      content: ":party:",
      tags: [
        ["h", "c"],
        ["e", "a".repeat(64)],
        ["emoji", "party", "https://a.test/party.png"],
      ],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(7);
    expect(event.tags).toEqual(template.tags);
    expect((await h.post("publish", event)).status).toBe(200);
    expect(h.publications).toHaveLength(1);
    expect(h.publications[0]).toEqual(JSON.parse(JSON.stringify(event)));
    for (const length of [62, 63, 64]) {
      const content = `:${"a".repeat(length)}:`;
      const signed = await h.post("sign", { ...template, content });
      expect(signed.status).toBe(200);
      const boundaryEvent = await signed.json();
      expect(boundaryEvent.content).toBe(content);
      expect((await h.post("publish", boundaryEvent)).status).toBe(200);
    }
    expect(h.publications).toHaveLength(4);
    for (const route of ["sign", "publish"]) {
      for (const tags of [
        [],
        [["e", "bad"]],
        [["e", "a".repeat(64), "", "reply"]],
        [
          ["e", "a".repeat(64)],
          ["e", "b".repeat(64)],
        ],
      ]) {
        expect(
          (await h.post(route, { ...event, tags: [["h", "c"], ...tags] }))
            .status,
        ).toBe(400);
      }
      expect(
        (await h.post(route, { ...event, content: "x".repeat(65) })).status,
      ).toBe(400);
      expect(
        (await h.post(route, { ...event, content: `:${"a".repeat(65)}:` }))
          .status,
      ).toBe(400);
      expect(
        (await h.post(route, { ...event, content: ` ${"x".repeat(64)}` }))
          .status,
      ).toBe(400);
    }
    expect(h.publications).toHaveLength(4);
  } finally {
    await h.close();
  }
});

test("both real sign and publish routes admit direct and nested replies but reject arbitrary references before upstream I/O", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    await h.start();
    const template = {
      ...h.event,
      tags: [
        ["h", "c"],
        ["e", "a".repeat(64), "", "reply"],
        ["p", "b".repeat(64)],
      ],
    };
    const signed = await h.post("sign", template);
    expect(signed.status).toBe(200);
    const event = await signed.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event.tags).toEqual(template.tags);
    expect(h.publications).toHaveLength(0);
    const published = await h.post("publish", event);
    expect(published.status).toBe(200);
    expect(h.publications).toHaveLength(1);
    expect(h.publications[0]).toEqual(JSON.parse(JSON.stringify(event)));
    const root = ["e", "c".repeat(64), "", "root"];
    const reply = ["e", "d".repeat(64), "", "reply"];
    const nestedSigned = await h.post("sign", {
      ...template,
      tags: [["h", "c"], root, reply],
    });
    expect(nestedSigned.status).toBe(200);
    const nested = await nestedSigned.json();
    expect(verifyEvent(nested)).toBe(true);
    expect(nested.tags).toEqual([["h", "c"], root, reply]);
    expect((await h.post("publish", nested)).status).toBe(200);
    expect(h.publications[1]).toEqual(JSON.parse(JSON.stringify(nested)));
    for (const route of ["sign", "publish"]) {
      for (const references of [
        [reply, root],
        [root, ["e", root[1], "", "reply"]],
        [root, reply, reply],
        [[...root, "extra"], reply],
        [["e", "C".repeat(64), "", "root"], reply],
        [["e", root[1], "relay", "root"], reply],
        [["e", "a".repeat(64)]],
        [["e", "a".repeat(64), "", "root"]],
        [["e", "invalid", "", "reply"]],
        [
          ["e", "a".repeat(64), "", "reply"],
          ["e", "b".repeat(64), "", "reply"],
        ],
      ]) {
        const rejected = await h.post(route, {
          ...event,
          tags: [["h", "c"], ...references],
        });
        expect(rejected.status).toBe(400);
        expect(await rejected.json()).toEqual({ error: "Message rejected" });
      }
    }
    expect(h.publications).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("held optional snapshot body leaves ordinary broker capacity free and start credit untouched", async () => {
  let release;
  const h = await harness((call) => {
    if (call.body?.[0]?.kinds?.includes(20001))
      return new Response(
        new ReadableStream({
          start(controller) {
            release = () => {
              controller.enqueue(new TextEncoder().encode("[]"));
              controller.close();
            };
          },
        }),
      );
    return Response.json([]);
  });
  const presence = [{ kinds: [20001], authors: [h.event.pubkey], limit: 1 }];
  try {
    const snapshot = h.post("presence-snapshot", presence);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const duplicate = await h.post("presence-snapshot", presence);
    expect(duplicate.status).toBe(204);
    expect((await h.post("query", filters)).status).toBe(200);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].at - h.calls[0].at).toBeLessThan(400);
    release();
    release = undefined;
    expect(await (await snapshot).json()).toEqual([]);
    expect(
      (await h.post("presence-snapshot", [{ ...presence[0], authors: [] }]))
        .status,
    ).toBe(400);
    expect(
      (
        await h.post("presence-snapshot", [
          { ...presence[0], authors: Array(257).fill(h.event.pubkey) },
        ])
      ).status,
    ).toBe(400);
    expect(h.calls).toHaveLength(2);
  } finally {
    release?.();
    await h.close();
  }
});

test("presence snapshot progresses while an ordinary response body is held", async () => {
  let release;
  const h = await harness((call) => {
    if (call.body?.[0]?.kinds?.includes(20001)) return Response.json([]);
    return new Response(
      new ReadableStream({
        start(controller) {
          release = () => {
            controller.enqueue(new TextEncoder().encode("[]"));
            controller.close();
          };
        },
      }),
    );
  });
  let ordinary;
  try {
    ordinary = h.post("query", filters, undefined, "background");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const snapshot = await h.post("presence-snapshot", [
      { kinds: [20001], authors: [h.event.pubkey], limit: 1 },
    ]);
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toEqual([]);
    expect(h.calls).toHaveLength(2);
    const missing = await h.post("stream-presence", {
      streamId: "0".repeat(32),
      status: "online",
    });
    expect(await missing.json()).toEqual({ accepted: null });
  } finally {
    release?.();
    await ordinary;
    await h.close();
  }
});
test("real outbox creates, invites and sends", async () => {
  const h = await harness(
    (call) =>
      Response.json(
        call.url.endsWith("/events")
          ? { accepted: true, event_id: call.body.id }
          : [],
      ),
    { channelCreation: true },
  );
  let owner;
  let traffic;
  try {
    const transport = await connectBrokerTransport(h.base);
    traffic = await openBrokerSocket(transport);
    expect(transport.writer.kinds).toContain(9007);
    owner = createOutbox(transport.viewer, transport.writer, {
      load: () => [],
      save: () => {},
    });
    const id = "11111111-1111-4111-8111-111111111111";
    const creationId = owner.outbox.send({
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", "Work"],
        ["visibility", "private"],
        ["channel_type", "stream"],
        ["ttl", "600"],
        ["t", "buzz.solo"],
      ],
    });
    await vi.waitFor(() =>
      expect(
        owner.local.snapshot().find((row) => row.event.id === creationId)
          ?.delivery,
      ).toBe("accepted"),
    );
    const creation = owner.local
      .snapshot()
      .find((row) => row.event.id === creationId)?.event;
    expect(creation).toBeDefined();
    const fixtureKey = new Uint8Array(32);
    fixtureKey[31] = 7;
    for (const ttl of ["", "2147483648"]) {
      const invalid = {
        ...creation,
        tags: [
          ...creation.tags.filter(
            ([key]) => key !== "ttl" && key !== "client-id",
          ),
          ["ttl", ttl],
        ],
      };
      expect((await h.post("sign", invalid)).status).toBe(400);
      const signed = finalizeEvent(structuredClone(invalid), fixtureKey);
      expect((await h.post("publish", signed)).status).toBe(400);
    }
    const temporaryCreationId = owner.outbox.send({
      kind: 9007,
      content: "",
      tags: [
        ["h", "33333333-3333-4333-8333-333333333333"],
        ["name", "Standup"],
        ["visibility", "open"],
        ["channel_type", "stream"],
        ["ttl", "604800"],
      ],
    });
    await vi.waitFor(() =>
      expect(
        owner.local
          .snapshot()
          .find((row) => row.event.id === temporaryCreationId)?.delivery,
      ).toBe("accepted"),
    );
    const invitationId = owner.outbox.send({
      kind: 9000,
      content: "",
      tags: [
        ["h", id],
        ["p", "a".repeat(64)],
      ],
    });
    await vi.waitFor(() =>
      expect(
        owner.local.snapshot().find((row) => row.event.id === invitationId)
          ?.delivery,
      ).toBe("accepted"),
    );
    const messageId = owner.outbox.send({
      kind: 9,
      content: "Hello",
      tags: [
        ["h", id],
        ["p", "a".repeat(64)],
      ],
    });
    await vi.waitFor(() =>
      expect(
        owner.local.snapshot().find((row) => row.event.id === messageId)
          ?.delivery,
      ).toBe("accepted"),
    );
    expect(h.publications.map((event) => event.kind)).toEqual([
      9007, 9007, 9000, 9,
    ]);
  } finally {
    owner?.dispose();
    traffic?.dispose();
    await h.close();
  }
});

test("member and guest additions work without channel creation, while role elevation remains rejected", async () => {
  const h = await harness(success);
  let traffic;
  let owner;
  try {
    const transport = await connectBrokerTransport(h.base);
    traffic = await openBrokerSocket(transport);
    expect(transport.writer.kinds).toContain(9000);
    expect(transport.writer.kinds).not.toContain(9007);
    owner = createOutbox(transport.viewer, transport.writer, {
      load: () => [],
      save: () => {},
    });
    const tags = [
      ["h", "11111111-1111-4111-8111-111111111111"],
      ["p", "a".repeat(64)],
    ];
    const id = owner.outbox.send({ kind: 9000, content: "", tags });
    await vi.waitFor(() =>
      expect(
        owner.local.snapshot().find((row) => row.event.id === id)?.delivery,
      ).toBe("accepted"),
    );
    expect(h.publications).toHaveLength(1);
    const participantId = owner.outbox.send({
      kind: 9000,
      content: "",
      tags: [...tags, ["role", "member"]],
    });
    await vi.waitFor(() =>
      expect(
        owner.local.snapshot().find((row) => row.event.id === participantId)
          ?.delivery,
      ).toBe("accepted"),
    );
    expect(h.publications).toHaveLength(2);
    // Bestie joins a private channel as a guest: the same template through
    // the outbox, with its trailing client-id, is signed and published.
    const guestId = owner.outbox.send({
      kind: 9000,
      content: "",
      tags: [...tags, ["role", "guest"]],
    });
    await vi.waitFor(() =>
      expect(
        owner.local.snapshot().find((row) => row.event.id === guestId)
          ?.delivery,
      ).toBe("accepted"),
    );
    expect(h.publications).toHaveLength(3);
    expect(h.publications[2].tags).toEqual(
      expect.arrayContaining([["role", "guest"]]),
    );
    // block/buzz#8575: one addition may name several people.
    const people = [
      ["p", "b".repeat(64)],
      ["p", "c".repeat(64)],
    ];
    for (const role of [
      [],
      [["role", "member"]],
      [["role", "guest"]],
      [["role", "bot"]],
    ]) {
      const batchId = owner.outbox.send({
        kind: 9000,
        content: "",
        tags: [...tags, ...people, ...role],
      });
      await vi.waitFor(() =>
        expect(
          owner.local.snapshot().find((row) => row.event.id === batchId)
            ?.delivery,
        ).toBe("accepted"),
      );
    }
    expect(h.publications).toHaveLength(7);
    for (const role of ["owner", "admin"]) {
      for (const named of [tags, [...tags, ...people]]) {
        const denied = await h.post("sign", {
          kind: 9000,
          content: "",
          created_at: 1700000000,
          tags: [...named, ["role", role]],
        });
        expect(denied.status).toBe(400);
      }
    }
  } finally {
    owner?.dispose();
    traffic?.dispose();
    await h.close();
  }
});

test("agent removal publishes only one member's exact 9001 through the outbox", async () => {
  const h = await harness(success);
  let traffic;
  let owner;
  try {
    const transport = await connectBrokerTransport(h.base);
    traffic = await openBrokerSocket(transport);
    expect(transport.writer.kinds).toContain(9001);
    owner = createOutbox(transport.viewer, transport.writer, {
      load: () => [],
      save: () => {},
    });
    const tags = [
      ["h", "11111111-1111-4111-8111-111111111111"],
      ["p", "a".repeat(64)],
    ];
    const id = owner.outbox.send({ kind: 9001, content: "", tags });
    await vi.waitFor(() =>
      expect(
        owner.local.snapshot().find((row) => row.event.id === id)?.delivery,
      ).toBe("accepted"),
    );
    expect(h.publications.map((event) => event.kind)).toEqual([9001]);
    const clientId = ["client-id", "22222222-2222-4222-8222-222222222222"];
    for (const invalid of [
      [...tags, clientId, ["reason", "x"]],
      [tags[0], clientId],
      [tags[0], ["p", "A".repeat(64)], clientId],
      [["h", "not-a-channel"], tags[1], clientId],
    ]) {
      const denied = await h.post("sign", {
        kind: 9001,
        content: "",
        created_at: 1700000000,
        tags: invalid,
      });
      expect(denied.status).toBe(400);
    }
    const content = await h.post("sign", {
      kind: 9001,
      content: "reason",
      created_at: 1700000000,
      tags: [...tags, clientId],
    });
    expect(content.status).toBe(400);
  } finally {
    owner?.dispose();
    traffic?.dispose();
    await h.close();
  }
});

test("edit capability signs and publishes canonical replacements, rejecting malformed edits locally", async () => {
  const h = await harness(success);
  try {
    await h.start();
    expect((await (await h.get("session")).json()).writeKinds).toContain(40003);
    const template = {
      ...h.event,
      kind: 40003,
      content: "corrected **message**",
      tags: [
        ["h", "c"],
        ["e", h.event.id],
      ],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event).toMatchObject({
      kind: 40003,
      content: template.content,
      tags: template.tags,
      pubkey: h.event.pubkey,
    });
    expect((await h.post("publish", event)).status).toBe(200);
    expect(h.publications).toEqual([JSON.parse(JSON.stringify(event))]);
    // Preserve older clients' metadata as well as current upload descriptors.
    for (const imeta of [
      [
        "imeta",
        "url https://example.com/image.png",
        "m image/png",
        "dim 320x200",
      ],
      [
        "imeta",
        `url ${fixtureRelayUrl}/media/${"a".repeat(64)}.pdf`,
        "m application/pdf",
        "size 3",
        `x ${"a".repeat(64)}`,
        "filename report.pdf",
      ],
    ]) {
      const caption = { ...template, tags: [...template.tags, imeta] };
      const signed = await h.post("sign", caption);
      expect(signed.status).toBe(200);
      const replacement = await signed.json();
      expect(verifyEvent(replacement)).toBe(true);
      expect(replacement.tags).toEqual(caption.tags);
      expect((await h.post("publish", replacement)).status).toBe(200);
      expect(h.publications.at(-1)).toEqual(
        JSON.parse(JSON.stringify(replacement)),
      );
    }
    for (const route of ["sign", "publish"]) {
      for (const tags of [
        [["h", "c"]],
        [
          ["h", "c"],
          ["e", "bad"],
        ],
        [
          ["h", "c"],
          ["e", h.event.id, "", "reply"],
        ],
        [...event.tags, ["e", "a".repeat(64)]],
        [...event.tags, ["p", "a".repeat(64)]],
        [...event.tags, ["imeta", 42]],
      ])
        expect((await h.post(route, { ...event, tags })).status).toBe(400);
      expect((await h.post(route, { ...event, content: " " })).status).toBe(
        400,
      );
      expect(
        (await h.post(route, { ...event, content: "x".repeat(32001) })).status,
      ).toBe(400);
    }
    expect(h.publications).toHaveLength(3);
  } finally {
    await h.close();
  }
});

test("report capability signs and publishes NIP-56 message reports, rejecting other shapes locally", async () => {
  const h = await harness(success);
  try {
    await h.start();
    expect((await (await h.get("session")).json()).writeKinds).toContain(1984);
    const template = {
      kind: 1984,
      content: "",
      created_at: h.event.created_at,
      tags: [
        ["p", h.event.pubkey],
        ["e", h.event.id, "spam"],
      ],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event).toMatchObject({ kind: 1984, tags: template.tags });
    expect((await h.post("publish", event)).status).toBe(200);
    expect(h.publications).toEqual([JSON.parse(JSON.stringify(event))]);
    for (const route of ["sign", "publish"]) {
      for (const tags of [
        [["e", h.event.id, "spam"]],
        [
          ["p", h.event.pubkey],
          ["e", h.event.id, "rude"],
        ],
        [
          ["p", h.event.pubkey],
          ["e", "bad", "spam"],
        ],
        [...template.tags, ["h", "c"]],
      ])
        expect((await h.post(route, { ...event, tags })).status).toBe(400);
      expect(
        (await h.post(route, { ...event, content: " padded " })).status,
      ).toBe(400);
      expect(
        (await h.post(route, { ...event, content: "x".repeat(32001) })).status,
      ).toBe(400);
    }
    expect(h.publications).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("message/reaction deletions pass real signing and publication without admitting workflow or arbitrary deletion shapes", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    await h.start();
    const template = {
      kind: 5,
      content: "",
      created_at: h.event.created_at,
      tags: [
        ["h", "c"],
        ["e", "a".repeat(64)],
        ["k", "7"],
      ],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(5);
    expect((await h.post("publish", event)).status).toBe(200);
    for (const route of ["sign", "publish"]) {
      for (const tags of [
        [
          ["h", "c"],
          ["e", "invalid"],
          ["k", "7"],
        ],
        [
          ["h", "c"],
          ["e", "a".repeat(64)],
          ["k", "30030"],
        ],
        [...template.tags, ["a", `30620:${h.event.pubkey}:workflow`]],
        [...template.tags, ["h", "other"]],
        [
          ["h", "c"],
          ["k", "7"],
        ],
      ])
        expect((await h.post(route, { ...event, tags })).status).toBe(400);
    }
    expect(h.publications).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("agent profile saves publish owner-signed listings through the broker outbox", async () => {
  const h = await harness(success);
  let traffic;
  let owner;
  try {
    const transport = await connectBrokerTransport(h.base);
    traffic = await openBrokerSocket(transport);
    owner = createOutbox(transport.viewer, transport.writer, {
      load: () => [],
      save: () => {},
    });
    const entry = {
      pubkey: "ab".repeat(32),
      name: "Renamed agent",
      picture: "https://example.com/new.png",
      runtime: "block.builderlab/builderlab",
      prior: {
        content: {
          name: "Old name",
          picture: "https://example.com/old.png",
          parallelism: 2,
          respond_to: "mentions",
        },
        tags: [
          ["d", "ab".repeat(32)],
          ["runtime", "block.builderlab/builderlab"],
          ["legacy-setting", "kept"],
        ],
      },
    };
    const record = await publishAgentRecord(
      { outbox: owner.outbox },
      entry,
      new AbortController().signal,
    );
    expect(h.publications).toHaveLength(1);
    const published = h.publications[0];
    expect(verifyEvent(published)).toBe(true);
    expect(published).toMatchObject({
      kind: 30177,
      pubkey: transport.viewer,
      content: JSON.stringify(record.content),
    });
    expect(JSON.parse(published.content)).toEqual({
      name: entry.name,
      picture: entry.picture,
      parallelism: 2,
      respond_to: "mentions",
    });
    expect(published.tags).toEqual([
      ["d", entry.pubkey],
      ["runtime", entry.runtime],
      ["legacy-setting", "kept"],
      ["client-id", expect.any(String)],
    ]);
    expect(owner.outbox.snapshot()).toEqual([]);
    const stranger = finalizeEvent({ ...published }, generateSecretKey());
    expect((await h.post("publish", stranger)).status).toBe(400);
    expect(
      (await h.post("publish", { ...published, sig: "00".repeat(64) })).status,
    ).toBe(400);
    expect(h.publications).toHaveLength(1);
  } finally {
    owner?.dispose();
    traffic?.dispose();
    await h.close();
  }
});

test("agent record signing refuses malformed coordinates, content and timestamps", async () => {
  const h = await harness(success);
  const content = { name: "Agent", parallelism: 1, respond_to: "owner-only" };
  const template = {
    kind: 30177,
    created_at: 1700000000,
    content: JSON.stringify(content),
    tags: [["d", "ab".repeat(32)]],
  };
  try {
    const signed = await h.post("sign", template);
    expect(signed.status).toBe(200);
    expect(verifyEvent(await signed.json())).toBe(true);
    for (const invalid of [
      { tags: [] },
      { tags: [...template.tags, ...template.tags] },
      { tags: [["d", "AB".repeat(32)]] },
      { tags: [["d", "agent"]] },
      { tags: [["d", "ab".repeat(32), "extra"]] },
      { tags: [null] },
      { tags: [...template.tags, ["extra", 1]] },
      { created_at: -1 },
      { created_at: 1.5 },
      { content: "not JSON" },
      { content: "null" },
      { content: "[]" },
      ...[
        { name: "Agent" },
        { ...content, name: " " },
        { ...content, parallelism: undefined },
        { ...content, parallelism: -1 },
        { ...content, parallelism: 1.5 },
        { ...content, parallelism: "1" },
        { ...content, respond_to: undefined },
        { ...content, respond_to: null },
        { ...content, respond_to: [] },
      ].map((body) => ({ content: JSON.stringify(body) })),
    ])
      expect((await h.post("sign", { ...template, ...invalid })).status).toBe(
        400,
      );
    expect(h.publications).toEqual([]);
  } finally {
    await h.close();
  }
});

test.each(["a", "é"])(
  "agent record signing admits publishable UTF-8 boundary frames with %s content",
  async (character) => {
    const h = await harness(success);
    try {
      await h.start();
      const content = (prompt) =>
        JSON.stringify({
          name: "Agent",
          parallelism: 0,
          respond_to: "owner-only",
          system_prompt: prompt,
        });
      const template = {
        kind: 30177,
        created_at: 1700000000,
        content: content(""),
        tags: [["d", "ab".repeat(32)]],
      };
      const baseline = await h.post("sign", template);
      expect(baseline.status).toBe(200);
      const signedTemplate = await baseline.json();
      const size = (event) =>
        Buffer.byteLength(JSON.stringify(["EVENT", event]));
      const room = 64 * 1024 - size(signedTemplate);
      const bytes = Buffer.byteLength(character);
      const prompt =
        character.repeat(Math.floor(room / bytes)) + "a".repeat(room % bytes);
      const largest = { ...template, content: content(prompt) };
      const signed = await h.post("sign", largest);
      expect(signed.status).toBe(200);
      const event = await signed.json();
      expect(verifyEvent(event)).toBe(true);
      expect(size(event)).toBe(64 * 1024);
      expect((await h.post("publish", event)).status).toBe(200);
      expect(h.publications).toEqual([JSON.parse(JSON.stringify(event))]);

      const oversized = { ...template, content: content(`${prompt}a`) };
      expect(size({ ...event, content: oversized.content })).toBe(
        64 * 1024 + 1,
      );
      expect((await h.post("sign", oversized)).status).toBe(400);
      expect(h.publications).toHaveLength(1);
    } finally {
      await h.close();
    }
  },
);

test("agent record deletions sign and publish only the viewer's own kind 30177 coordinate", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    await h.start();
    const agent = "b".repeat(64);
    const template = {
      kind: 5,
      content: "",
      created_at: h.event.created_at,
      tags: [
        ["a", `30177:${h.event.pubkey}:${agent}`],
        ["client-id", "11111111-1111-4111-8111-111111111111"],
      ],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(verifyEvent(event)).toBe(true);
    expect((await h.post("publish", event)).status).toBe(200);
    for (const tags of [
      [["a", `30177:${"c".repeat(64)}:${agent}`]],
      [["a", `30178:${h.event.pubkey}:${agent}`]],
      [["a", `30177:${h.event.pubkey}:${agent}:extra`]],
      [["a", `30177:${h.event.pubkey}:invalid`]],
      [...template.tags, ["e", "a".repeat(64)]],
    ])
      expect((await h.post("sign", { ...template, tags })).status).toBe(400);
    expect(h.publications).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("direct-message transport signs only bounded participants and binds the returned channel to its receipt", async () => {
  const channelId = "11111111-1111-4111-8111-111111111111";
  const h = await harness((call) =>
    Response.json({
      accepted: true,
      event_id: call.body.id,
      message: `response:${JSON.stringify({ channel_id: channelId })}`,
    }),
  );
  try {
    const transport = await connectBrokerTransport(h.base);
    const recipients = ["a".repeat(64), "b".repeat(64)];
    await expect(
      transport.openDirectMessage(recipients, new AbortController().signal),
    ).resolves.toBe(channelId);
    const event = h.calls[0].body;
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(41010);
    expect(event.pubkey).toBe(h.event.pubkey);
    expect(event.content).toBe("");
    expect(event.tags.filter(([tag]) => tag === "p")).toEqual(
      recipients.map((key) => ["p", key]),
    );
    await transport.openDirectMessage(recipients, new AbortController().signal);
    expect(h.calls[1].body.id).not.toBe(event.id);
    for (const pubkeys of [
      [],
      [h.event.pubkey],
      [recipients[0], recipients[0]],
      Array(9).fill(recipients[0]),
      ["invalid"],
      ["A".repeat(64)],
      [123],
      null,
      "a".repeat(64),
    ]) {
      expect((await h.post("direct-message", { pubkeys })).status).toBe(400);
    }
    expect(h.calls).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test.each([
  {
    accepted: false,
    message: 'response:{"channel_id":"11111111-1111-4111-8111-111111111111"}',
  },
  {
    accepted: true,
    event_id: "wrong",
    message: 'response:{"channel_id":"11111111-1111-4111-8111-111111111111"}',
  },
  { accepted: true, message: 'response:{"channel_id":"not-a-channel"}' },
])("direct-message rejects an invalid command receipt: %j", async (receipt) => {
  const h = await harness((call) =>
    Response.json({ event_id: call.body.id, ...receipt }),
  );
  try {
    const response = await h.post("direct-message", {
      pubkeys: ["a".repeat(64)],
    });
    expect(response.status).toBe(502);
    expect(await response.json()).not.toHaveProperty("channelId");
  } finally {
    await h.close();
  }
});

test("status signing and publication preserve scoped replacements and explicit clears", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    await h.start();
    for (const input of [
      {
        content: "Working remotely",
        tags: [
          ["d", "general"],
          ["emoji", ":party:"],
          ["expiration", "1700086400"],
        ],
      },
      {
        content: "Celebrating",
        tags: [
          ["d", "general"],
          ["emoji", ":party:", "https://emoji.test/party.svg"],
        ],
      },
      { content: "", tags: [["d", "general"]] },
    ]) {
      const response = await h.post("sign", {
        kind: 30315,
        created_at: 1700000000,
        ...input,
      });
      expect(response.status).toBe(200);
      const event = await response.json();
      expect(verifyEvent(event)).toBe(true);
      expect(event).toMatchObject({ kind: 30315, ...input });
      expect((await h.post("channel-lifecycle-sign", event)).status).toBe(400);
      expect((await h.post("channel-lifecycle-publish", event)).status).toBe(
        400,
      );
      expect((await h.post("publish", event)).status).toBe(200);
      expect(h.publications.at(-1)).toEqual(JSON.parse(JSON.stringify(event)));
    }
    for (const tags of [
      [["d", "music"]],
      [
        ["d", "general"],
        ["h", "private"],
      ],
    ]) {
      expect(
        (
          await h.post("sign", {
            kind: 30315,
            created_at: 1700000000,
            content: "x",
            tags,
          })
        ).status,
      ).toBe(400);
    }
    const future = {
      kind: 30315,
      created_at: Math.floor(Date.now() / 1000) + 3600,
      content: "Future",
      tags: [["d", "general"]],
    };
    expect((await h.post("sign", future)).status).toBe(400);
    const secret = new Uint8Array(32);
    secret[31] = 7;
    expect(
      (await h.post("publish", finalizeEvent(future, secret))).status,
    ).toBe(400);
    for (const input of [
      { content: "😀".repeat(51) },
      { content: "one\ntwo" },
      {
        content: "x",
        tags: [
          ["d", "general"],
          ["emoji", " "],
        ],
      },
      {
        content: "x",
        tags: [
          ["d", "general"],
          ["emoji", "😀".repeat(51)],
        ],
      },
    ]) {
      const template = { ...future, created_at: 1700000000, ...input };
      expect((await h.post("sign", template)).status).toBe(400);
      expect(
        (await h.post("publish", finalizeEvent(template, secret))).status,
      ).toBe(400);
    }
    expect(h.publications).toHaveLength(3);
  } finally {
    await h.close();
  }
});

test("custom emoji sets sign and publish only as one canonical own coordinate", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    await h.start();
    expect((await (await h.get("session")).json()).writeKinds).toContain(30030);
    const template = {
      kind: 30030,
      created_at: 1700000000,
      content: "",
      tags: [
        ["d", "buzz:custom-emoji"],
        ["emoji", "party", "https://relay.test/media/party.png"],
      ],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event).toMatchObject(template);
    expect((await h.post("publish", event)).status).toBe(200);
    expect(h.publications.at(-1)).toEqual(JSON.parse(JSON.stringify(event)));
    for (const tags of [
      [["d", "other"]],
      [
        ["d", "buzz:custom-emoji"],
        ["emoji", "Party", "https://relay.test/p.png"],
      ],
      [
        ["d", "buzz:custom-emoji"],
        ["emoji", "party", "https://relay.test/a.png"],
        ["emoji", "party", "https://relay.test/b.png"],
      ],
      [
        ["d", "buzz:custom-emoji"],
        ["h", "channel"],
      ],
    ])
      expect((await h.post("sign", { ...template, tags })).status).toBe(400);
    expect(h.publications).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("catalog publications sign only the owner-to-self NIP-AP envelope", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    await h.start();
    const { writeKinds } = await (await h.get("session")).json();
    expect(writeKinds).toEqual(expect.arrayContaining([30175, 30178]));
    const now = Math.floor(Date.now() / 1000);
    const agent = {
      kind: 30175,
      created_at: now,
      content: '{"display_name":"Fixture"}',
      tags: [
        ["d", "ab".repeat(32)],
        ["shared", "true"],
      ],
    };
    const team = {
      kind: 30178,
      created_at: now,
      content: '{"v":1,"name":"Crew","members":[]}',
      tags: [["d", "builtin-team:welcome"]],
    };
    for (const template of [agent, team]) {
      const response = await h.post("sign", template);
      expect(response.status).toBe(200);
      const event = await response.json();
      expect(verifyEvent(event)).toBe(true);
      expect(event).toMatchObject(template);
      expect((await h.post("publish", event)).status).toBe(200);
    }
    for (const template of [
      { ...agent, tags: [["d", "Not A Slug"]] },
      {
        ...agent,
        tags: [
          ["d", "a"],
          ["shared", "false"],
        ],
      },
      {
        ...agent,
        tags: [
          ["d", "a"],
          ["shared", "true", "x"],
        ],
      },
      {
        ...agent,
        tags: [
          ["d", "a"],
          ["p", "ab".repeat(32)],
        ],
      },
      { ...agent, content: '{"display_name":"X","env_vars":{}}' },
      { ...team, tags: [["d", "has space"]] },
      { ...team, content: '{"v":1,"name":"Crew"}' },
    ])
      expect((await h.post("sign", template)).status).toBe(400);
    expect(h.publications).toHaveLength(2);
    // NIP-AP content may reach 65,535 bytes; each `"` doubles once more when
    // the event is serialized, so only catalog kinds get the larger body bound.
    const pad = (size) => {
      const room = size - '{"display_name":"Big","system_prompt":""}'.length;
      return JSON.stringify({
        display_name: "Big",
        system_prompt: '"'.repeat(Math.floor(room / 2)) + "a".repeat(room % 2),
      });
    };
    const largest = { ...agent, content: pad(65_535) };
    expect(Buffer.byteLength(largest.content)).toBe(65_535);
    const signed = await h.post("sign", largest);
    expect(signed.status).toBe(200);
    const big = await signed.json();
    expect(verifyEvent(big)).toBe(true);
    expect(JSON.stringify(big).length).toBeGreaterThan(128 * 1024);
    expect((await h.post("publish", big)).status).toBe(200);
    expect(h.publications).toHaveLength(3);
    expect(
      (await h.post("sign", { ...agent, content: pad(65_536) })).status,
    ).toBe(400);
    expect(
      (
        await h.post("sign", {
          kind: 9,
          created_at: now,
          content: "x".repeat(70_000),
          tags: [["h", "channel"]],
        })
      ).status,
    ).toBe(413);
  } finally {
    await h.close();
  }
});

test("memory reads use captured relay and owner, not submitted identity/filter authority, through HTTP host and transport", async () => {
  const owner = new Uint8Array(32);
  owner[31] = 7;
  const viewer = getPublicKey(owner),
    agent = generateSecretKey(),
    author = getPublicKey(agent);
  const key = nip44.v2.utils.getConversationKey(agent, viewer);
  const memory = finalizeEvent(
    {
      kind: 30174,
      created_at: 1,
      tags: [
        ["p", viewer],
        [
          "d",
          createHmac("sha256", key)
            .update("agent-memory/v1/d-tag\0mem/test")
            .digest("hex"),
        ],
      ],
      content: nip44.v2.encrypt(
        JSON.stringify({ slug: "mem/test", value: "private" }),
        key,
      ),
    },
    agent,
  );
  let forbidden = false;
  const h = await harness((call) => {
    expect(call.url).toBe(`${fixtureRelayUrl}/query`);
    expect(call.body).toEqual([
      { kinds: [30174], authors: [author], "#p": [viewer], limit: 256 },
    ]);
    expect(call.auth.pubkey).toBe(viewer);
    return forbidden
      ? Response.json({ error: "restricted: not the owner" }, { status: 403 })
      : Response.json([memory]);
  });
  try {
    const transport = await connectBrokerTransport(
      h.base,
      undefined,
      fixtureRelayUrl,
    );
    expect(transport.readAgentMemories).toBeDefined();
    const listing = await transport.readAgentMemories(
      author,
      new AbortController().signal,
    );
    expect(listing).toEqual({
      entries: [
        { slug: "mem/test", body: "private", eventId: memory.id, createdAt: 1 },
      ],
      partial: false,
    });
    const scoped = `${encodeURIComponent(fixtureRelayUrl)}/agent-memories`;
    for (const body of [
      { agent: viewer },
      { agent: author, owner: viewer },
      { agent: author, kinds: [9] },
    ]) {
      expect((await h.post(scoped, body)).status).toBe(400);
    }
    expect((await h.post("agent-memories", { agent: author })).status).toBe(
      400,
    );
    expect(h.calls).toHaveLength(1);
    forbidden = true;
    await expect(
      transport.readAgentMemories(author, new AbortController().signal),
    ).rejects.toMatchObject({ name: "MemoryDenied" });
    expect(h.calls).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("broker advertises, signs and publishes bounded edits through the real HTTP contract", async () => {
  const h = await harness(() => new Response("[]"));
  try {
    await h.start();
    const session = await (await h.get("session")).json();
    expect(session.writeKinds).toContain(40003);
    const template = {
      kind: 40003,
      content: "corrected text",
      created_at: 1700000000,
      tags: [
        ["h", "c"],
        ["e", h.event.id],
        ["client-id", "edit-test"],
      ],
    };
    const signed = await h.post("sign", template);
    expect(signed.status).toBe(200);
    const event = await signed.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(h.event.pubkey);
    const published = await h.post("publish", event);
    expect(published.status).toBe(200);
    expect(h.publications.some((item) => item.id === event.id)).toBe(true);
    for (const route of ["sign", "publish"]) {
      const rejected = await h.post(route, {
        ...event,
        tags: [...event.tags, ["p", "b".repeat(64)]],
      });
      expect(rejected.status).toBe(400);
    }
  } finally {
    await h.close();
  }
});

// Owner/admin community commands: community-bound, bounded before upstream I/O.
async function communityAdmin(respond) {
  const h = await harness(respond);
  const registered = await fetch(`${h.base}/api/relay/register`, {
    method: "POST",
    headers: { Origin: h.base },
    body: JSON.stringify({ url: fixtureRelayUrl }),
  });
  const { id } = await registered.json();
  return {
    h,
    post: (route, body) => h.post(`${encodeURIComponent(id)}/${route}`, body),
  };
}

test("invite claim forwards relay-shaped codes and names exact refusals", async () => {
  let refusal;
  const { h, post } = await communityAdmin((call) =>
    !call.url.endsWith("/api/invites/claim")
      ? new Response(null, { status: 404 })
      : refusal
        ? Response.json({ error: refusal }, { status: 403 })
        : Response.json({ status: "joined" }),
  );
  try {
    for (const code of ["v2.mvQwZTr9C31MUkGj_-", "eyJjIjoxfQ.bWFj"]) {
      const response = await post("claim", { code });
      expect(response.status).toBe(200);
      expect(h.calls.at(-1)).toMatchObject({
        url: `${fixtureRelayUrl}/api/invites/claim`,
        body: { code },
      });
    }
    const calls = h.calls.length;
    for (const code of ["", "a b", "a/b", "x".repeat(257)])
      expect((await post("claim", { code })).status).toBe(400);
    expect(h.calls).toHaveLength(calls);
    for (const error of [
      "invite_exhausted",
      "invite_expired",
      "invite_invalid",
      "database said: secret detail",
    ]) {
      refusal = error;
      const response = await post("claim", { code: "v2.abc" });
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe(
        error.startsWith("invite_") ? error : "Relay request failed (403)",
      );
    }
  } finally {
    await h.close();
  }
});

test("invite mint forwards only bounded ttl/max_uses and returns the relay invite", async () => {
  const minted = {
    code: "abc",
    expires_at: 1700003600,
    max_uses: 1,
    uses_remaining: 1,
    url: "https://primary.example/invite/abc",
  };
  const { h, post } = await communityAdmin((call) =>
    call.url.endsWith("/api/invites")
      ? Response.json(minted)
      : new Response(null, { status: 404 }),
  );
  try {
    const response = await post("invite", {
      ttl_secs: 3600,
      max_uses: 1,
      extra: "dropped",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(minted);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      url: `${fixtureRelayUrl}/api/invites`,
      body: { ttl_secs: 3600, max_uses: 1 },
    });
    expect(h.calls[0].auth.tags).toContainEqual([
      "u",
      `${fixtureRelayUrl}/api/invites`,
    ]);
    const unlimited = await post("invite", { ttl_secs: 2592000 });
    expect(unlimited.status).toBe(200);
    expect(h.calls[1].body).toEqual({ ttl_secs: 2592000, max_uses: null });

    for (const body of [
      {},
      { ttl_secs: 59 },
      { ttl_secs: 2592001 },
      { ttl_secs: 3600.5 },
      { ttl_secs: "3600" },
      { ttl_secs: 3600, max_uses: 0 },
      { ttl_secs: 3600, max_uses: 10001 },
      { ttl_secs: 3600, max_uses: "1" },
      null,
    ])
      expect((await post("invite", body)).status).toBe(400);
    // Unscoped requests have no community to administer.
    expect((await h.post("invite", { ttl_secs: 3600 })).status).toBe(400);
    expect(h.calls).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("member changes sign exact NIP-43 admin kinds and reject malformed changes locally", async () => {
  const { h, post } = await communityAdmin((call) =>
    Response.json({ accepted: true, event_id: call.body.id, message: "" }),
  );
  const target = "a".repeat(64);
  try {
    for (const [change, kind, tags] of [
      [
        { action: "add", pubkey: target, role: "member" },
        9030,
        [
          ["p", target],
          ["role", "member"],
        ],
      ],
      [
        { action: "add", pubkey: target, role: "admin" },
        9030,
        [
          ["p", target],
          ["role", "admin"],
        ],
      ],
      [{ action: "remove", pubkey: target }, 9031, [["p", target]]],
      [
        { action: "role", pubkey: target, role: "admin" },
        9032,
        [
          ["p", target],
          ["role", "admin"],
        ],
      ],
    ]) {
      const response = await post("member", change);
      expect(response.status).toBe(200);
      const sent = h.calls.at(-1);
      expect(sent.url).toBe(`${fixtureRelayUrl}/events`);
      expect(verifyEvent(sent.body)).toBe(true);
      expect(sent.body).toMatchObject({
        kind,
        tags,
        content: "",
        pubkey: h.event.pubkey,
        created_at: Math.floor(Date.now() / 1000),
      });
      expect(await response.json()).toMatchObject({
        accepted: true,
        event_id: sent.body.id,
      });
    }
    for (const change of [
      { action: "role", pubkey: target, role: "owner" },
      { action: "add", pubkey: target },
      { action: "remove", pubkey: target, role: "member" },
      { action: "ban", pubkey: target },
      { action: "toString", pubkey: target, role: "member" },
      { action: "add", pubkey: "A".repeat(64), role: "member" },
      { action: "add", pubkey: "a".repeat(63), role: "member" },
      { kind: 9030, tags: [["p", target]] },
    ])
      expect((await post("member", change)).status).toBe(400);
    expect(
      (await h.post("member", { action: "remove", pubkey: target })).status,
    ).toBe(400);
    expect(h.calls).toHaveLength(4);
  } finally {
    await h.close();
  }
});

test("member change receipts must match the signed command", async () => {
  const { h, post } = await communityAdmin(() =>
    Response.json({ accepted: true, event_id: "wrong" }),
  );
  try {
    const response = await post("member", {
      action: "remove",
      pubkey: "a".repeat(64),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Member change could not be confirmed",
    });
  } finally {
    await h.close();
  }
});

test("leave requests sign the exact NIP-43 shape for the selected community only", async () => {
  const { h, post } = await communityAdmin((call) =>
    Response.json({ accepted: true, event_id: call.body.id, message: "" }),
  );
  try {
    const response = await post("leave", {});
    expect(response.status).toBe(200);
    const sent = h.calls.at(-1);
    expect(sent.url).toBe(`${fixtureRelayUrl}/events`);
    expect(verifyEvent(sent.body)).toBe(true);
    expect(sent.body).toMatchObject({
      kind: 28936,
      tags: [["-"]],
      content: "",
      pubkey: h.event.pubkey,
      created_at: Math.floor(Date.now() / 1000),
    });
    expect(await response.json()).toMatchObject({
      accepted: true,
      event_id: sent.body.id,
    });
    // The request body carries nothing: a client cannot smuggle another kind
    // or extra tags into the signed event.
    const shaped = await post("leave", {
      kind: 9031,
      tags: [["p", "a".repeat(64)]],
      content: "bye",
    });
    expect(shaped.status).toBe(200);
    expect(h.calls.at(-1).body).toMatchObject({
      kind: 28936,
      tags: [["-"]],
      content: "",
    });
    // Unscoped requests name no community to leave.
    expect((await h.post("leave", {})).status).toBe(400);
    expect(h.calls).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("leave receipts must match the signed request", async () => {
  const { h, post } = await communityAdmin(() =>
    Response.json({ accepted: true, event_id: "wrong" }),
  );
  try {
    const response = await post("leave", {});
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Leave request could not be confirmed",
    });
  } finally {
    await h.close();
  }
});

test.each([
  [
    400,
    "invalid: you are not a relay member",
    "invalid: you are not a relay member",
  ],
  [
    400,
    "invalid: relay membership is not enabled",
    "invalid: relay membership is not enabled",
  ],
  [
    400,
    "invalid: relay owner cannot leave",
    "invalid: relay owner cannot leave",
  ],
  [
    403,
    "blocked: you are banned from this community",
    "blocked: you are banned from this community",
  ],
  [
    503,
    "community writes are temporarily unavailable",
    "community writes are temporarily unavailable",
  ],
  // Admin refusals are not leave refusals.
  [400, "invalid: cannot remove yourself", "Relay request failed (400)"],
  [
    400,
    "invalid: database error: connection reset <script>",
    "Relay request failed (400)",
  ],
])(
  "leave refusal %i %j is surfaced only when whitelisted",
  async (status, error, shown) => {
    const { h, post } = await communityAdmin(() =>
      Response.json({ error }, { status }),
    );
    try {
      const response = await post("leave", {});
      expect(response.status).toBe(status);
      expect((await response.json()).error).toBe(shown);
    } finally {
      await h.close();
    }
  },
);

test.each([
  [400, "invalid: cannot remove yourself", "invalid: cannot remove yourself"],
  [
    400,
    "invalid: cannot remove the relay owner",
    "invalid: cannot remove the relay owner",
  ],
  [
    400,
    `invalid: member not found: ${"a".repeat(64)}`,
    `invalid: member not found: ${"a".repeat(64)}`,
  ],
  [
    400,
    "invalid: actor not authorized: must be admin or owner",
    "invalid: actor not authorized: must be admin or owner",
  ],
  [
    403,
    "blocked: you are banned from this community",
    "blocked: you are banned from this community",
  ],
  [
    403,
    "only relay owners and admins can create invites",
    "only relay owners and admins can create invites",
  ],
  [
    400,
    "ttl_secs must be between 60 and 2592000",
    "ttl_secs must be between 60 and 2592000",
  ],
  [
    400,
    "invalid: database error: connection reset <script>",
    "Relay request failed (400)",
  ],
  [
    400,
    "invalid: event timestamp out of range: created_at=1",
    "Relay request failed (400)",
  ],
  [500, "error: database error: secret", "Relay request failed (500)"],
])(
  "admin refusal %i %j is surfaced only when whitelisted",
  async (status, error, shown) => {
    const { h, post } = await communityAdmin(() =>
      Response.json({ error }, { status }),
    );
    try {
      for (const [route, body] of [
        ["member", { action: "remove", pubkey: "a".repeat(64) }],
        ["invite", { ttl_secs: 3600 }],
      ]) {
        const response = await post(route, body);
        expect(response.status).toBe(status);
        expect((await response.json()).error).toBe(shown);
      }
    } finally {
      await h.close();
    }
  },
);

test("admin refusals are read through the bounded error reader", async () => {
  let pulled = 0;
  const { h, post } = await communityAdmin(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled++;
            // Would be 4 MiB if fully consumed; the valid-looking prefix must not survive.
            if (pulled > 1024) return controller.close();
            controller.enqueue(
              new TextEncoder().encode(
                pulled === 1
                  ? '{"error":"invalid: cannot remove yourself","pad":"'
                  : "x".repeat(4096),
              ),
            );
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
  );
  try {
    for (const [route, body] of [
      ["member", { action: "remove", pubkey: "a".repeat(64) }],
      ["invite", { ttl_secs: 3600 }],
    ]) {
      pulled = 0;
      const response = await post(route, body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("Relay request failed (400)");
      expect(pulled).toBeLessThan(8);
    }
  } finally {
    await h.close();
  }
});

test("relay quota on admin routes stays a quota failure, not a refusal", async () => {
  const { h, post } = await communityAdmin(() =>
    Response.json(
      { error: "rate-limited: quota exceeded; retry in 5s" },
      { status: 429 },
    ),
  );
  try {
    const response = await post("invite", { ttl_secs: 3600 });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: "rate-limited: quota exceeded; retry in 5s",
      quota: "api",
    });
    // The shared lane is paused: the next admin request is not sent upstream.
    const paused = await post("invite", { ttl_secs: 3600 });
    expect(paused.status).toBe(429);
    expect(await paused.json()).toMatchObject({ paused: true, sent: false });
    expect(h.calls).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("identity archive requests use dedicated exact-shape routes behind archive authority", async () => {
  const respond = (call) =>
    Response.json(
      call.url.endsWith("/events")
        ? { accepted: true, event_id: call.body.id }
        : [],
    );
  const target = "b".repeat(64);
  const auth = ["auth", "c".repeat(64), "", "d".repeat(128)];
  const template = archiveRequestTemplate("archive", target, auth);
  const unavailable = await harness(respond);
  try {
    expect(
      (await unavailable.post("identity-archive-sign", template)).status,
    ).toBe(400);
  } finally {
    await unavailable.close();
  }
  const h = await harness(respond, {
    // The harness relay author is its viewer key; NIP-11 self must match it.
    archiveAuthority: getPublicKey(
      Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 7 : 0)),
    ),
  });
  let live;
  try {
    const transport = await connectBrokerTransport(h.base);
    expect(transport.writer.kinds).not.toContain(9035);
    expect(transport.writer.kinds).not.toContain(9036);
    const invalid = [
      { ...template, kind: 9037 },
      { ...template, content: "reason" },
      { ...template, tags: [["p", target]] },
      { ...template, tags: [...template.tags, ["reason", "spam"]] },
      { ...template, tags: [["-"], ["p", target], ["p", target]] },
      { ...template, tags: [["-"], ["p", "B".repeat(64)]] },
      {
        ...template,
        tags: [["-"], ["p", target], ["auth", target, "", "d".repeat(128)]],
      },
      { ...template, tags: [["-"], ["p", target], auth.slice(0, 3)] },
    ];
    for (const event of invalid) {
      expect((await h.post("identity-archive-sign", event)).status).toBe(400);
      expect((await h.post("identity-archive-publish", event)).status).toBe(
        400,
      );
    }
    const signal = new AbortController().signal;
    expect((await h.post("sign", template)).status).toBe(400);
    const signed = await transport.identityArchive.sign(template, signal);
    expect(verifyEvent(signed)).toBe(true);
    expect(signed).toMatchObject(template);
    expect((await h.post("publish", signed)).status).toBe(400);
    live = await openBrokerSocket(transport);
    await transport.identityArchive.publish(signed, signal);
    expect(h.publications).toHaveLength(1);
    const foreign = finalizeEvent(
      { ...template, tags: template.tags.map((tag) => [...tag]) },
      new Uint8Array(32).fill(5),
    );
    expect((await h.post("identity-archive-publish", foreign)).status).toBe(
      400,
    );
    expect(h.publications).toHaveLength(1);
  } finally {
    live?.dispose();
    await h.close();
  }
});

test("lifecycle uses dedicated shape-limited host routes, never the message writer", async () => {
  const h = await harness((call) =>
    Response.json(
      call.url.endsWith("/events")
        ? { accepted: true, event_id: call.body.id }
        : [],
    ),
  );
  let live;
  try {
    const transport = await connectBrokerTransport(h.base);
    expect(transport.writer.kinds).not.toContain(9008);
    const id = "11111111-1111-4111-8111-111111111111";
    const template = {
      kind: 9008,
      tags: [["h", id]],
      content: "",
      created_at: 1700000000,
    };
    expect((await h.post("sign", template)).status).toBe(400);
    const invalid = [
      {
        ...template,
        kind: 9002,
        tags: [
          ["h", id],
          ["name", "rename"],
        ],
      },
      { ...template, kind: 9002, tags: [["h", id], ["auto_join"]] },
      {
        ...template,
        kind: 9002,
        tags: [
          ["h", id],
          ["auto_join", "maybe"],
        ],
      },
      {
        ...template,
        kind: 9002,
        tags: [
          ["h", id],
          ["archived", "true"],
          ["auto_join", "true"],
        ],
      },
      {
        ...template,
        kind: 9022,
        tags: [
          ["h", id],
          ["p", transport.viewer],
        ],
      },
      { ...template, content: "extra" },
      {
        ...template,
        tags: [
          ["h", id],
          ["h", id],
        ],
      },
    ];
    for (const event of invalid) {
      expect((await h.post("channel-lifecycle-sign", event)).status).toBe(400);
      expect((await h.post("channel-lifecycle-publish", event)).status).toBe(
        400,
      );
    }
    const signal = new AbortController().signal;
    const signed = await transport.channelLifecycle.sign(template, signal);
    expect(verifyEvent(signed)).toBe(true);
    expect(signed).toMatchObject(template);
    expect((await h.post("publish", signed)).status).toBe(400);
    await expect(
      transport.channelLifecycle.publish(signed, signal),
    ).rejects.toBeInstanceOf(PublishRejected);
    expect(h.publications).toHaveLength(0);
    live = await openBrokerSocket(transport);
    await transport.channelLifecycle.publish(signed, signal);
    expect(h.publications).toHaveLength(1);
    const foreignKey = new Uint8Array(32).fill(5);
    const foreign = finalizeEvent(
      { ...template, tags: template.tags.map((tag) => [...tag]) },
      foreignKey,
    );
    expect((await h.post("channel-lifecycle-publish", foreign)).status).toBe(
      400,
    );
    expect(h.publications).toHaveLength(1);
    const unarchive = {
      ...template,
      kind: 9002,
      tags: [
        ["h", id],
        ["archived", "false"],
      ],
    };
    expect((await h.post("sign", unarchive)).status).toBe(400);
    const restore = await transport.channelLifecycle.sign(unarchive, signal);
    expect(verifyEvent(restore)).toBe(true);
    expect(restore).toMatchObject(unarchive);
    expect((await h.post("publish", restore)).status).toBe(400);
    await transport.channelLifecycle.publish(restore, signal);
    for (const value of ["true", "false"]) {
      const flag = {
        ...template,
        kind: 9002,
        tags: [
          ["h", id],
          ["auto_join", value],
        ],
      };
      expect((await h.post("sign", flag)).status).toBe(400);
      expect((await h.post("channel-details-sign", flag)).status).toBe(400);
      const flagged = await transport.channelLifecycle.sign(flag, signal);
      expect(verifyEvent(flagged)).toBe(true);
      expect(flagged).toMatchObject(flag);
      await transport.channelLifecycle.publish(flagged, signal);
    }
    expect(h.publications).toHaveLength(4);
  } finally {
    live?.dispose();
    await h.close();
  }
});

test("product feedback signs and publishes only private bounded text/category", async () => {
  const h = await harness(success);
  try {
    await h.start();
    expect((await (await h.get("session")).json()).writeKinds).toContain(42000);
    const template = {
      ...h.event,
      kind: 42000,
      content: "This broke",
      tags: [
        ["category", "bug"],
        ["client-id", "fixture"],
      ],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event).toMatchObject({
      kind: 42000,
      content: template.content,
      tags: template.tags,
    });
    expect((await h.post("publish", event)).status).toBe(200);
    expect(h.publications).toEqual([JSON.parse(JSON.stringify(event))]);
    for (const route of ["sign", "publish"]) {
      for (const invalid of [
        { tags: [["h", "c"]] },
        {
          tags: [
            ["category", "bug"],
            ["category", "praise"],
          ],
        },
        { tags: [["category", "idea"]] },
        { tags: [null] },
        { content: " \n " },
        { content: "é".repeat(16_385) },
      ])
        expect((await h.post(route, { ...event, ...invalid })).status).toBe(
          400,
        );
    }
    expect(h.publications).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("feedback media tags pass broker signing only for tenant-local bounded descriptors", async () => {
  const h = await harness(success);
  const hash = "a".repeat(64);
  const valid = [
    "imeta",
    `url ${fixtureRelayUrl}/media/${hash}.png`,
    "m image/png",
    "size 64",
    `x ${hash}`,
    "filename capture.png",
  ];
  try {
    await h.start();
    const template = {
      ...h.event,
      kind: 42000,
      content: `Broken\n\n![capture](<${fixtureRelayUrl}/media/${hash}.png>)`,
      tags: [valid],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const signed = await response.json();
    expect((await h.post("publish", signed)).status).toBe(200);
    for (const tag of [
      valid.map((part) =>
        part.startsWith("url ")
          ? `url https://other.test/media/${hash}.png`
          : part,
      ),
      valid.map((part) => (part.startsWith("size ") ? "size NaN" : part)),
      valid.map((part) =>
        part.startsWith("filename ") ? "filename ../capture.png" : part,
      ),
      [...valid, "x duplicated"],
      valid.slice(0, -1),
    ]) {
      expect((await h.post("sign", { ...template, tags: [tag] })).status).toBe(
        400,
      );
      expect((await h.post("publish", { ...signed, tags: [tag] })).status).toBe(
        400,
      );
    }
    expect(h.publications).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("private feedback crosses the real broker and session without a readback or shared view", async () => {
  const h = await harness(success);
  let owner;
  try {
    const transport = await connectBrokerTransport(h.base);
    owner = createRelaySession(transport, {
      outboxStorage: { load: () => [], save() {} },
    });
    // The session owns its own stream; waiting on a separate subscription does
    // not establish that the publication owner's live ID has been admitted.
    await vi.waitFor(() =>
      expect(owner.session.live.snapshot().status).toBe("connected"),
    );
    const outbox = owner.session.outbox;
    expect(outbox).toBeDefined();
    await outbox.ready();
    const id = outbox.send(feedbackEvent("Controlled private text", "bug"));
    await vi.waitFor(() => {
      const result = outbox.snapshot()[0];
      if (result?.delivery === "failed")
        throw new Error(result.error ?? "failed");
      expect(result?.delivery).toBe("accepted");
    });
    expect(h.publications).toHaveLength(1);
    expect(h.publications[0]).toMatchObject({
      id,
      kind: 42000,
      content: "Controlled private text",
    });
    expect(verifyEvent(h.publications[0])).toBe(true);
    expect(h.publications[0].tags.some(([name]) => name === "h")).toBe(false);
    const feedbackReads = h.calls.filter(
      ({ body }) =>
        Array.isArray(body) && body.some(({ ids }) => ids?.includes(id)),
    );
    expect(feedbackReads).toEqual([]);
    expect(
      owner.session.observe([{ kinds: [42000], limit: 20 }]).snapshot().events,
    ).toEqual([]);
  } finally {
    owner?.dispose();
    await h.close();
  }
});

test("broker HTTP summaries respect live levels and trace excludes private filters", async () => {
  const logger = getLogger("relay-broker");
  const reporters = [...logger.options.reporters];
  const lines = [];
  logger.setReporters([{ log: (entry) => lines.push(entry.args.join(" ")) }]);
  const h = await harness(success);
  try {
    setLogLevel("trace");
    expect(
      (
        await h.post("query", [
          {
            kinds: [0],
            limit: 1,
            authors: ["a".repeat(64)],
            search: "private search",
          },
        ])
      ).status,
    ).toBe(200);
    expect(lines.some((line) => line.includes("POST /relay/query → 200"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes('"authors":1'))).toBe(true);
    expect(lines.join(" ")).not.toContain("private search");
    expect(lines.join(" ")).not.toContain("a".repeat(64));
    lines.length = 0;
    setLogLevel("info");
    expect((await h.post("query", filters)).status).toBe(200);
    expect(lines).toHaveLength(0);
  } finally {
    await h.close();
    logger.setReporters(reporters);
    setLogLevel("info");
  }
});

test.each([
  [
    new DOMException("private timeout detail", "TimeoutError"),
    "TimeoutError",
    500,
  ],
  [
    new TypeError("private URL", { cause: { code: "ECONNREFUSED" } }),
    "TypeError (ECONNREFUSED)",
    502,
  ],
  [
    Object.assign(new Error("private message"), {
      name: "private name",
      code: "private code",
    }),
    "Error",
    500,
  ],
])(
  "broker failure logs preserve safe categories/codes, not private exception text (%#)",
  async (error, summary, status) => {
    const logger = getLogger("relay-broker");
    const reporters = [...logger.options.reporters];
    const lines = [];
    logger.setReporters([{ log: (entry) => lines.push(entry.args.join(" ")) }]);
    setLogLevel("info");
    const h = await harness(() => {
      throw error;
    });
    try {
      expect((await h.post("query", filters)).status).toBe(status);
      expect(lines).toContain(`Request failed: POST /relay/query: ${summary}`);
      expect(lines.join(" ")).not.toContain("private");
    } finally {
      await h.close();
      logger.setReporters(reporters);
      setLogLevel("info");
    }
  },
);

test("Trace metadata uses the real Node reporter without fabricated stacks", async () => {
  const logger = getLogger("relay-broker");
  const socket = getLogger("relay-ws");
  const originals = [logger, socket].map((log) => ({
    log,
    reporters: [...log.options.reporters],
    stdout: log.options.stdout,
    stderr: log.options.stderr,
  }));
  const lines = [];
  const output = {
    write: (line) => {
      lines.push(String(line));
      return true;
    },
  };
  const fancy = createConsola({ fancy: true, stdout: output, stderr: output });
  for (const { log } of originals) {
    log.setReporters(fancy.options.reporters);
    log.options.stdout = output;
    log.options.stderr = output;
  }
  const h = await harness(success);
  try {
    lines.length = 0; // Exclude the harness startup lifecycle message.
    setLogLevel("trace");
    expect((await h.post("query", filters)).status).toBe(200);
    logSocketFrame("relay.test", "→", "[]", ["REQ", "live-1", { kinds: [9] }]);
    expect(lines.join("")).toContain("filters");
    expect(lines.join("")).toContain("query");
    expect(lines.join("")).not.toMatch(/\n\s+at |FancyReporter|formatLogObj/);
    expect(lines).toHaveLength(4); // HTTP summary + metadata, frame summary + metadata.
    expect(lines.every((line) => line.trim().split("\n").length === 1)).toBe(
      true,
    );
  } finally {
    await h.close();
    for (const { log, reporters, stdout, stderr } of originals) {
      log.setReporters(reporters);
      log.options.stdout = stdout;
      log.options.stderr = stderr;
    }
    setLogLevel("info");
  }
});

test("server-wide stats work without a default community and do not start upstream I/O", async () => {
  const h = await harness(success, {}, "");
  try {
    // Use node:http: Undici diagnostics also count the test client's own socket.
    const result = await new Promise((resolve, reject) => {
      get(`${h.base}/api/relay/stats`, (response) => {
        let raw = "";
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode, raw }));
      }).on("error", reject);
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.raw)).toEqual({
      queries: 0,
      errors: 0,
      media: 0,
      connects: 0,
    });
    expect(h.calls).toEqual([]);
  } finally {
    await h.close();
  }
});

test("community setup signs explicit owner intent without inventory or enrollment", async () => {
  const key = new Uint8Array(32);
  key[31] = 7;
  const viewer = getPublicKey(key);
  const pubkey = "ab".repeat(32);
  const h = await harness(() => {
    throw new Error("No relay read permitted");
  });
  const route = `${encodeURIComponent(fixtureRelayUrl)}/resolve-agent-community`;
  const input = { pubkey, owner: viewer, confirmed: true };
  try {
    for (const invalid of [
      { ...input, confirmed: false },
      { ...input, owner: pubkey },
      { ...input, pubkey: viewer },
      { ...input, pubkey: "invalid" },
      { ...input, extra: true },
    ])
      expect((await h.post(route, invalid)).status).toBe(400);
    const response = await h.post(route, input);
    expect(response.status).toBe(200);
    const resolution = await response.json();
    expect(resolution).toMatchObject({
      pubkey,
      owner: viewer,
      relayUrl: fixtureRelayUrl.replace(/^https:/, "wss:"),
    });
    const { schnorr } = await import("@noble/curves/secp256k1.js");
    expect(
      schnorr.verify(
        Buffer.from(resolution.signature, "hex"),
        createHash("sha256")
          .update(`nostr:agent-community:${pubkey}:${resolution.relayUrl}`)
          .digest(),
        Buffer.from(viewer, "hex"),
      ),
    ).toBe(true);
    expect(h.calls).toHaveLength(0);
    expect(h.publications).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test("details routes are narrow, require the live owner, and do not widen lifecycle/outbox", async () => {
  const h = await harness(success);
  let live;
  try {
    const transport = await connectBrokerTransport(h.base);
    const template = {
      kind: 9002,
      created_at: 1700000000,
      content: "",
      tags: [
        ["h", "11111111-1111-4111-8111-111111111111"],
        ["name", "renamed"],
        ["about", ""],
        ["visibility", "private"],
      ],
    };
    expect(transport.writer.kinds).not.toContain(9002);
    expect((await h.post("sign", template)).status).toBe(400);
    expect((await h.post("channel-lifecycle-sign", template)).status).toBe(400);
    for (const invalid of [
      { ...template, kind: 9001 },
      { ...template, content: "extra" },
      { ...template, tags: [...template.tags, ["archived", "true"]] },
      ...["0", "-1", "1.5", "2147483648"].map((ttl) => ({
        ...template,
        tags: [...template.tags, ["ttl", ttl]],
      })),
      { ...template, tags: [...template.tags, ["ttl", "60"], ["ttl", "60"]] },
      {
        ...template,
        tags: [...template.tags.slice(0, 3), ["visibility", "public"]],
      },
      { ...template, tags: [template.tags[0], ["topic", "x"]] },
      {
        ...template,
        tags: [template.tags[0], ["name", "n"], ["about", "x".repeat(1001)]],
      },
    ]) {
      for (const route of ["channel-details-sign", "channel-details-publish"])
        expect((await h.post(route, invalid)).status).toBe(400);
    }
    const signal = new AbortController().signal;
    const event = await transport.channelDetails.sign(template, signal);
    expect(verifyEvent(event)).toBe(true);
    expect(event).toMatchObject(template);
    expect((await h.post("publish", event)).status).toBe(400);
    await expect(
      transport.channelDetails.publish(event, signal),
    ).rejects.toBeInstanceOf(PublishRejected);
    expect(h.publications).toHaveLength(0);
    live = await openBrokerSocket(transport);
    await transport.channelDetails.publish(event, signal);
    expect(h.publications).toHaveLength(1);
    for (const ttl of ["604800", ""]) {
      const change = { ...template, tags: [...template.tags, ["ttl", ttl]] };
      expect((await h.post("sign", change)).status).toBe(400);
      expect((await h.post("channel-lifecycle-sign", change)).status).toBe(400);
      const signed = await transport.channelDetails.sign(change, signal);
      expect(signed).toMatchObject(change);
      await transport.channelDetails.publish(signed, signal);
    }
    for (const role of ["member", "guest"]) {
      const change = {
        ...template,
        tags: [...template.tags, ["join_role", role]],
      };
      expect((await h.post("sign", change)).status).toBe(400);
      expect((await h.post("channel-lifecycle-sign", change)).status).toBe(400);
      const signed = await transport.channelDetails.sign(change, signal);
      expect(signed).toMatchObject(change);
      await transport.channelDetails.publish(signed, signal);
    }
    for (const tags of [
      [...template.tags, ["join_role", "admin"]],
      [...template.tags, ["join_role", "guest"], ["join_role", "member"]],
      [...template.tags.slice(0, 3), ["ttl", "+1"]],
      [...template.tags.slice(0, 3), ["ttl", "1\n"]],
      [...template.tags.slice(0, 3), ["ttl", "1"], ["ttl", ""]],
      [template.tags[0], ["ttl", "1"], template.tags[1]],
    ]) {
      const change = { ...template, tags };
      expect((await h.post("channel-details-sign", change)).status).toBe(400);
      // Sign externally so publish's independent guard, not a missing signature, rejects.
      const fixtureKey = new Uint8Array(32);
      fixtureKey[31] = 7;
      expect(getPublicKey(fixtureKey)).toBe(transport.viewer);
      const signed = finalizeEvent(structuredClone(change), fixtureKey);
      expect((await h.post("channel-details-publish", signed)).status).toBe(
        400,
      );
    }
    const reopening = {
      ...template,
      tags: [...template.tags.slice(0, 3), ["visibility", "open"]],
    };
    expect((await h.post("sign", reopening)).status).toBe(400);
    expect((await h.post("channel-lifecycle-sign", reopening)).status).toBe(
      400,
    );
    const reopened = await transport.channelDetails.sign(reopening, signal);
    expect(reopened).toMatchObject(reopening);
    expect((await h.post("publish", reopened)).status).toBe(400);
    await transport.channelDetails.publish(reopened, signal);
    expect(h.publications).toHaveLength(6);
    const foreign = finalizeEvent(
      structuredClone(template),
      new Uint8Array(32).fill(5),
    );
    expect((await h.post("channel-details-publish", foreign)).status).toBe(400);
    expect(h.publications).toHaveLength(6);
  } finally {
    live?.dispose();
    await h.close();
  }
});

test("member administration uses isolated shape-limited routes and the current community socket", async () => {
  const h = await harness(success);
  let live;
  try {
    const transport = await connectBrokerTransport(h.base);
    const id = "11111111-1111-4111-8111-111111111111";
    const target = getPublicKey(new Uint8Array(32).fill(5));
    const signal = new AbortController().signal;
    const template = {
      kind: 9000,
      created_at: 1700000000,
      content: "",
      tags: [
        ["h", id],
        ["p", target],
        ["role", "admin"],
      ],
    };
    const invalid = [
      { ...template, kind: 9002 },
      { ...template, content: "metadata" },
      {
        ...template,
        tags: [
          ["h", id],
          ["p", target],
          ["role", "owner"],
        ],
      },
      {
        ...template,
        tags: [
          ["h", id],
          ["p", target],
          ["role", "bot"],
        ],
      },
      {
        ...template,
        tags: [
          ["h", id],
          ["p", transport.viewer],
          ["role", "member"],
        ],
      },
      {
        ...template,
        kind: 9001,
        tags: [
          ["h", id],
          ["p", transport.viewer],
        ],
      },
      { ...template, tags: [...template.tags, ["h", id]] },
      { ...template, tags: null },
      { ...template, tags: [null] },
    ];
    for (const event of invalid)
      for (const route of [
        "member-administration-sign",
        "member-administration-publish",
      ])
        expect((await h.post(route, event)).status).toBe(400);
    expect((await h.post("sign", template)).status).toBe(400);
    const signed = await transport.memberAdministration.sign(template, signal);
    expect(verifyEvent(signed)).toBe(true);
    expect(signed).toMatchObject(template);
    expect((await h.post("publish", signed)).status).toBe(400);
    await expect(
      transport.memberAdministration.publish(signed, signal),
    ).rejects.toBeInstanceOf(PublishRejected);
    expect(h.publications).toHaveLength(0);
    live = await openBrokerSocket(transport);
    await transport.memberAdministration.publish(signed, signal);
    const removal = await transport.memberAdministration.sign(
      { ...template, kind: 9001, tags: template.tags.slice(0, 2) },
      signal,
    );
    expect(
      (
        await h.post("sign", {
          ...template,
          kind: 9001,
          tags: template.tags.slice(0, 2),
        })
      ).status,
    ).toBe(400);
    await transport.memberAdministration.publish(removal, signal);
    const foreign = finalizeEvent(
      structuredClone(template),
      new Uint8Array(32).fill(5),
    );
    expect(
      (await h.post("member-administration-publish", foreign)).status,
    ).toBe(400);
    expect(h.publications).toHaveLength(2);
  } finally {
    live?.dispose();
    await h.close();
  }
});

test("inventory inspection returns saved identities without owner resolution or publication", async () => {
  const key = new Uint8Array(32);
  key[31] = 7;
  const pubkey = "ab".repeat(32);
  let forged = false;
  let member = true;
  const h = await harness(
    () => {
      const event = finalizeEvent(
        {
          kind: 30177,
          created_at: 1700000000,
          content: JSON.stringify({ name: "Saved agent" }),
          tags: [["d", member ? pubkey : "cd".repeat(32)]],
        },
        key,
      );
      if (forged) event.sig = "00".repeat(64);
      return Response.json([event]);
    },
    { archiveAuthority: getPublicKey(key) },
  );
  const route = `${encodeURIComponent(fixtureRelayUrl)}/agent-inventory`;
  try {
    expect((await h.post("agent-inventory", {})).status).toBe(400);
    expect((await h.post(route, { confirmed: true })).status).toBe(400);
    expect(h.calls).toHaveLength(0);
    expect(await (await h.post(route, {})).json()).toEqual({
      identities: [pubkey],
    });
    member = false;
    expect(await (await h.post(route, {})).json()).toEqual({
      identities: ["cd".repeat(32)],
    });
    forged = true;
    expect((await h.post(route, {})).status).toBe(409);
    expect(h.publications).toHaveLength(0);
  } finally {
    await h.close();
  }
  const unavailable = await harness(() => Response.json([]));
  try {
    expect(await (await unavailable.post(route, {})).json()).toEqual({
      identities: [],
    });
    expect(unavailable.calls).toHaveLength(1);
  } finally {
    await unavailable.close();
  }
});

test("inventory rejects foreign pages, ignores invalid heads and follows exact-key pages", async () => {
  const key = new Uint8Array(32);
  key[31] = 7;
  const foreign = new Uint8Array(32);
  foreign[31] = 8;
  const pubkey = "ab".repeat(32);
  const record = (
    d,
    content = '{"name":"Same name"}',
    time = 1,
    author = key,
    kind = 30177,
  ) =>
    finalizeEvent(
      { kind, created_at: time, content, tags: [["d", d]] },
      author,
    );
  let rows = [];
  const h = await harness(({ body }) =>
    Response.json(body[0].before_id ? [record(pubkey)] : rows),
  );
  const route = `${encodeURIComponent(fixtureRelayUrl)}/agent-inventory`;
  const input = {};
  try {
    rows = [record(pubkey, undefined, 1, foreign)];
    expect((await h.post(route, input)).status).toBe(409);
    for (const invalid of [
      [record(pubkey, "not JSON")],
      [record(pubkey), record(pubkey, "null", 2)],

      [record(pubkey, '{"display_name":"Template"}', 1, key, 30175)],
    ]) {
      rows = invalid;
      expect(await (await h.post(route, input)).json()).toEqual({
        identities: [],
      });
    }
    rows = Array.from({ length: 200 }, (_, i) =>
      record(i.toString(16).padStart(64, "0")),
    );
    expect((await h.post(route, input)).status).toBe(200);
    expect(h.calls.at(-1).body[0]).toMatchObject({
      until: 1,
      before_id: [...rows]
        .map((e) => e.id)
        .sort()
        .at(-1),
    });
    expect(h.publications).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test.each([[], [1, 42], [1, 42, 43]])(
  "join discovery exposes membership enforcement for %j",
  async (...nips) => {
    const h = await harness((call) =>
      Response.json(
        call.url === fixtureRelayUrl
          ? { name: "Community", supported_nips: nips }
          : { policy: null },
      ),
    );
    try {
      expect(await (await h.get("info")).json()).toMatchObject({
        membershipRequired: nips.includes(43),
      });
    } finally {
      await h.close();
    }
  },
);

test("Builderlab HTTP accepts full agent instructions and isolates the fixed native routes", async () => {
  let openLogin;
  const opened = new Promise((resolve) => {
    openLogin = resolve;
  });
  const instructions = "\\".repeat(20_000);
  let received;
  const nativeCalls = [];
  const h = await harness(() => Response.json([]), {}, fixtureRelayUrl, {
    open: async (url) => openLogin(new URL(url)),
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/v1/auth/login/exchange"))
        return Response.json({
          session_credential: "fixture-only",
          expires_at: "2030",
        });
      if (path.endsWith("/v1/auth/me"))
        return Response.json({
          subject: "fixture-account",
          expires_at: "2030",
          capabilities: { can_use_remote_agents: true },
        });
      if (path.endsWith("/nostr-identities/challenge"))
        return Response.json({
          error: { code: "missing_mapping", setup_needed: true },
        });
      if (path.endsWith("/v3/beekeeper/update-agent")) {
        received = JSON.parse(init.body);
        return Response.json({ status: 1 });
      }
      if (
        path.endsWith("/v3/builderlab/decisions") ||
        path.endsWith("/v1/auth/hosted-site/native-session")
      ) {
        nativeCalls.push({
          path,
          body: JSON.parse(init.body),
          headers: init.headers,
        });
        return Response.json({ fixture: "native reply" });
      }
      throw new Error(`Unexpected Builderlab request ${path}`);
    },
  });
  try {
    const login = fetch(`${h.base}/api/builderlab/login`, {
      method: "POST",
      body: "{}",
    });
    const authorization = await opened;
    await fetch(
      `${authorization.searchParams.get("redirect_uri")}?code=fixture&state=${authorization.searchParams.get("state")}`,
    );
    expect((await login).status).toBe(200);
    const stream = await fetch(`${h.base}/api/builderlab/events`);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let event = "";
    try {
      while (!event.includes("\n\n")) {
        const part = await reader.read();
        if (part.done) throw new Error("Missing development session metadata");
        event += decoder.decode(part.value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }
    const { revision } = JSON.parse(
      event.slice("data: ".length).split("\n\n")[0],
    );
    const body = JSON.stringify({
      agent_pubkey: "a".repeat(64),
      agent_instructions: instructions,
    });
    const envelope = JSON.stringify({
      revision,
      path: "/v3/beekeeper/update-agent",
      method: "POST",
      body,
    });
    expect(envelope.length).toBeGreaterThan(64 * 1024);
    const response = await fetch(`${h.base}/api/builderlab/request`, {
      method: "POST",
      body: envelope,
    });
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe(200);
    expect(received.agent_instructions).toBe(instructions);
    for (const [action, path, header] of [
      ["decisions", "/v3/builderlab/decisions", "X-BB-Session-Credential"],
      [
        "viewer",
        "/v1/auth/hosted-site/native-session",
        "X-Buzz-Builderlab-Revision",
      ],
    ]) {
      const refused = await fetch(`${h.base}/api/builderlab/request`, {
        method: "POST",
        body: JSON.stringify({ revision, path, method: "POST", body: "{}" }),
      });
      expect(await refused.json()).toEqual({
        error: "Unsupported Builderlab request",
      });
      const forwarded = await fetch(`${h.base}/api/builderlab/${action}`, {
        method: "POST",
        headers: { [header]: revision, "X-Buzz-Community": "buzz.example" },
        body: JSON.stringify({ fixture: action }),
      });
      expect(forwarded.status).toBe(200);
      expect(await forwarded.json()).toEqual({ fixture: "native reply" });
      expect(nativeCalls.at(-1)).toMatchObject({
        path: `/api/goose${path}`,
        body: { fixture: action },
        headers: { "X-BB-Session-Credential": "fixture-only" },
      });
    }
    expect(nativeCalls).toHaveLength(2);
    expect(nativeCalls[0].headers["X-Buzz-Community"]).toBe("buzz.example");
  } finally {
    await h.close();
  }
});

test("Builderlab pending sign-in survives its initiating page disconnecting", async () => {
  let openLogin;
  const opened = new Promise((resolve) => {
    openLogin = resolve;
  });
  const h = await harness(() => Response.json([]), {}, fixtureRelayUrl, {
    open: async (url) => openLogin(new URL(url)),
    fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/v1/auth/login/exchange"))
        return Response.json({
          session_credential: "fixture-only",
          expires_at: "2030",
        });
      if (path.endsWith("/v1/auth/me"))
        return Response.json({
          subject: "fixture-account",
          expires_at: "2030",
        });
      if (path.endsWith("/nostr-identities/challenge"))
        return Response.json({
          error: { code: "missing_mapping", setup_needed: true },
        });
      throw new Error(`Unexpected Builderlab request ${path}`);
    },
  });
  const disconnected = new Promise((resolve) => {
    h.server.on("request", (req, res) => {
      if (req.url === "/api/builderlab/login") res.once("close", resolve);
    });
  });
  const abort = new AbortController();
  let reader;
  try {
    const login = fetch(`${h.base}/api/builderlab/login`, {
      method: "POST",
      body: "{}",
      signal: abort.signal,
    }).catch((error) => error);
    const authorization = await opened;
    abort.abort();
    await login;
    await disconnected;
    const stream = await fetch(`${h.base}/api/builderlab/events`);
    reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const next = async () => {
      while (!buffered.includes("\n\n")) {
        const part = await reader.read();
        if (part.done) throw new Error("Development session stream ended");
        buffered += decoder.decode(part.value, { stream: true });
      }
      const end = buffered.indexOf("\n\n");
      const event = JSON.parse(buffered.slice("data: ".length, end));
      buffered = buffered.slice(end + 2);
      return event;
    };
    expect(await next()).toMatchObject({ pending: true, auth: null });
    await fetch(
      `${authorization.searchParams.get("redirect_uri")}?code=fixture&state=${authorization.searchParams.get("state")}`,
    );
    let signedIn;
    do {
      signedIn = await next();
    } while (signedIn.pending);
    expect(signedIn.auth).toMatchObject({ subject: "fixture-account" });
    const auth = await (await fetch(`${h.base}/api/builderlab/auth`)).json();
    expect(auth.auth).toMatchObject({ subject: "fixture-account" });
  } finally {
    abort.abort();
    await reader?.cancel();
    await h.close();
  }
});
