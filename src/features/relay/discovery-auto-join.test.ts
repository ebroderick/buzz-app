import { expect, it } from "vitest";
import { DiscoveryState } from "./discovery";
import { keypair, metadata, roster } from "./testing";

it("marks a channel auto-join from the relay-signed auto_join tag", () => {
  const viewer = keypair(),
    relay = keypair();
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  state.accept(roster(relay, "general", [viewer.pubkey]));
  state.accept(metadata(relay, "general", "General"));
  expect(state.get("general")?.autoJoin).toBeUndefined();

  state.accept(
    metadata(relay, "general", "General", 1_700_000_001, [["auto_join"]]),
  );
  expect(state.get("general")).toMatchObject({ id: "general", autoJoin: true });

  // The tag is effective-state: the relay drops it when it stops auto-adding.
  state.accept(metadata(relay, "general", "General", 1_700_000_002));
  expect(state.get("general")?.autoJoin).toBeUndefined();
});

it("ignores a non-relay-authored auto_join tag", () => {
  const viewer = keypair(),
    relay = keypair(),
    stranger = keypair();
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  state.accept(roster(relay, "general", [viewer.pubkey]));
  state.accept(metadata(relay, "general", "General"));
  expect(
    state.accept(
      metadata(stranger, "general", "General", 1_700_000_001, [["auto_join"]]),
    ),
  ).toBe(false);
  expect(state.get("general")?.autoJoin).toBeUndefined();
});
