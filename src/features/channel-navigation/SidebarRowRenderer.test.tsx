// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SidebarRowRenderer } from "./SidebarRowRenderer";
import type { SidebarRow } from "./sidebar-rows-service";

afterEach(cleanup);

it("leaves host output identical with no plugin", () => {
  const Default = (
    <button type="button" aria-current="page">
      Host row
    </button>
  );
  const plain = render(Default);
  const expected = plain.container.innerHTML;
  plain.unmount();
  const row: SidebarRow = {
    id: "row",
    kind: "team",
    label: "Host row",
    sectionKey: "channels",
    channel: { id: "row", name: "Host row" },
    unread: {
      target: { kind: "channel", channelId: "row" },
      observedCount: null,
      attentionCount: null,
      coverage: "unknown",
      freshness: "unknown",
      manual: "none",
    },
  };
  const mounted = render(
    <SidebarRowRenderer row={row} entries={[]}>
      {Default}
    </SidebarRowRenderer>,
  );
  expect(mounted.container.innerHTML).toBe(expected);
});
