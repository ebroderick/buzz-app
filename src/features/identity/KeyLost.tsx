import { WarningCircleIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import type { OwnedCommunity } from "./builderlab-account";
import { WireframePanel } from "./Wireframe";

/** Recovery guidance and consequences before replacing a linked key.
 * The replacement is automatically backed up after linking. */
export function KeyLost({
  owned,
  onBack,
  onStartOver,
}: {
  /** The communities the old key owns; `undefined` when the list could not be loaded. */
  owned: readonly OwnedCommunity[] | undefined;
  onBack: () => void;
  onStartOver: () => void;
}) {
  return (
    <>
      <div>
        <h1
          id="welcome-title"
          tabIndex={-1}
          className="text-heading text-standard"
        >
          Lost your key?
        </h1>
        <p className="mt-2 text-body text-subtle">
          Check another device where you’re signed in to Buzz, or look for a
          backup. Without a copy or a usable backup, we can’t recover your key.
        </p>
        <p className="mt-2 text-body text-subtle">
          Starting over replaces the key linked to your Builderlab account. Your
          profile, messages, and community access won’t carry over. Your old
          content won’t be deleted. The new key will be backed up to your
          Builderlab account automatically. Block can use that copy to restore
          this key, including anywhere else you use it.
        </p>
      </div>
      {(owned === undefined || owned.length > 0) && (
        <WireframePanel>
          <h2 className="m-0 text-body text-subtle">Communities you own</h2>
          {owned === undefined ? (
            <p className="m-0 text-body text-standard">
              We couldn’t load your owned communities. Other communities may be
              affected.
            </p>
          ) : (
            <ul
              aria-label="Communities you own"
              className="m-0 flex list-none flex-col gap-1 p-0"
            >
              {owned.map(({ host, url }) => (
                <li key={url} className="truncate text-label text-standard">
                  {host}
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 text-body-sm text-subtle">
            Other communities you’ve joined aren’t listed.
          </p>
        </WireframePanel>
      )}
      {/* kgoose revokes an unlinked key: binding it again answers 409. */}
      <InlineHeader
        icon={<WarningCircleIcon size={16} aria-hidden="true" />}
        title="Your old key can’t be linked again"
        subtitle="Starting over permanently unlinks your old key."
      />
      {/* Footer order: secondary first, primary last. */}
      <div data-onboarding-actions="">
        <Button size="lg" onClick={onBack}>
          Go back
        </Button>
        <Button size="lg" variant="destructive" onClick={onStartOver}>
          Start over with a new key
        </Button>
      </div>
    </>
  );
}
