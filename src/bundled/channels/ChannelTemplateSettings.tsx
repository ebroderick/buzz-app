import { useLayoutEffect, useRef, useState } from "react";
import { useAgentsSnapshot, useTeams } from "../../features/agents/react";
import type { Agent, Agents, Team } from "../../features/agents/service";
import {
  channelTemplates,
  useChannelTemplates,
  type ChannelTemplate,
} from "../../features/channel-templates/local";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import { CopyIcon, PlusIcon } from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Field } from "../../shared/design-system/ui/Field";
import { Header } from "../../shared/design-system/ui/Header";
import { Input } from "../../shared/design-system/ui/Input";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import styles from "./ChannelTemplates.module.css";

/** Templates a new channel can start from: its agents, teams and Canvas. */
export function ChannelTemplateSettings({
  agents,
  active,
}: {
  agents?: Agents | undefined;
  active(): boolean;
}) {
  const templates = useChannelTemplates();
  const teams = useTeams(agents);
  const choices = useAgentsSnapshot(agents)?.agents ?? noAgents;
  // A template's id while it is edited, or "new" for one being made.
  const [editing, setEditing] = useState<string>();
  const template = templates.find((item) => item.id === editing);
  const newTemplate = () => {
    if (active()) setEditing("new");
  };
  return (
    <section aria-label="Channel templates settings">
      <Header title="Channel templates" />
      {templates.length ? (
        <div className={styles.stack}>
          <SettingsGroup>
            {templates.map((item) => (
              <PreferenceRow
                key={item.id}
                title={item.name}
                subtitle={summary(item, choices, teams)}
                trailing={
                  <Button
                    aria-label={`Edit ${item.name}`}
                    onClick={() => {
                      if (active()) setEditing(item.id);
                    }}
                  >
                    Edit
                  </Button>
                }
              />
            ))}
          </SettingsGroup>
          <div className={styles.actions}>
            <Button onClick={newTemplate}>
              <PlusIcon size={14} aria-hidden="true" /> New template
            </Button>
          </div>
        </div>
      ) : (
        <EmptyState
          icon={<CopyIcon />}
          title="No channel templates yet"
          description="Start new channels with your agents, teams and a Canvas already in place."
          action={<Button onClick={newTemplate}>New template</Button>}
        />
      )}
      {(editing === "new" || template) && (
        <TemplateDialog
          key={editing}
          agents={choices}
          teams={teams}
          {...(template ? { template } : {})}
          onClose={() => setEditing(undefined)}
        />
      )}
    </section>
  );
}

const noAgents: readonly never[] = Object.freeze([]);

function AgentLabel({ agent }: { agent: Agent }) {
  const src = useAvatarPreview(
    agent.picture ?? "",
    agent.relay || undefined,
    "small",
  );
  return (
    <span className={styles.agentLabel}>
      <Avatar
        src={src}
        alt=""
        fallback={agent.name}
        size="small"
        shape="squircle"
      />
      <span>{agent.name}</span>
    </span>
  );
}

function summary(
  template: ChannelTemplate,
  agents: readonly Agent[],
  teams: readonly Team[],
) {
  const names = [
    ...template.agents.flatMap(
      (pubkey) => agents.find((agent) => agent.pubkey === pubkey)?.name ?? [],
    ),
    ...template.teams.flatMap(
      (id) => teams.find((team) => team.id === id)?.name ?? [],
    ),
  ];
  return (
    [names.join(", "), template.canvas.trim() ? "Canvas" : ""]
      .filter(Boolean)
      .join(" · ") || "Empty"
  );
}

function TemplateDialog({
  agents,
  teams,
  template,
  onClose,
}: {
  agents: readonly Agent[];
  teams: readonly Team[];
  template?: ChannelTemplate;
  onClose(): void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [chosenAgents, setChosenAgents] = useState<readonly string[]>(
    template?.agents ?? [],
  );
  const [chosen, setChosen] = useState<readonly string[]>(
    template?.teams ?? [],
  );
  const [canvas, setCanvas] = useState(template?.canvas ?? "");
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const previousDiscard = useRef(confirmDiscard);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (confirmDiscard !== previousDiscard.current)
      (confirmDiscard ? keepEditing.current : input.current)?.focus();
    previousDiscard.current = confirmDiscard;
  }, [confirmDiscard]);
  // Compare the raw draft with the saved template as it is now (or empty
  // fields for a new one), so a name of only spaces still counts and a box
  // unchecked then checked again (which moves it to the end) does not.
  const unsaved =
    name !== (template?.name ?? "") ||
    canvas !== (template?.canvas ?? "") ||
    !sameSet(chosenAgents, template?.agents ?? []) ||
    !sameSet(chosen, template?.teams ?? []);
  const requestClose = () => {
    if (confirmDiscard) setConfirmDiscard(false);
    else if (unsaved) setConfirmDiscard(true);
    else onClose();
  };
  const act = (work: () => void) => {
    setError("");
    try {
      work();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
      dismissOnOutsideClick
      step={
        confirmDiscard
          ? { key: "discard", scale: 0.95 }
          : { key: "edit", scale: 1.05 }
      }
      title={
        confirmDiscard
          ? "Discard changes?"
          : template
            ? "Edit template"
            : "New template"
      }
      description={
        confirmDiscard ? "Your template has unsaved changes." : undefined
      }
      closeLabel={confirmDiscard ? "Back to template" : "Close template"}
      initialFocus={input}
      actions={
        confirmDiscard ? (
          <>
            <Button ref={keepEditing} onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={onClose}>
              Discard changes
            </Button>
          </>
        ) : (
          <>
            {template && (
              <Button
                variant="destructive"
                onClick={() => act(() => channelTemplates.remove(template.id))}
              >
                Delete
              </Button>
            )}
            <Button
              variant="prominent"
              type="submit"
              form="channel-template-form"
              disabled={!name.trim()}
            >
              Save template
            </Button>
          </>
        )
      }
    >
      {confirmDiscard ? null : (
        <form
          id="channel-template-form"
          className={styles.stack}
          onSubmit={(event) => {
            event.preventDefault();
            act(() =>
              channelTemplates.save({
                ...(template ? { id: template.id } : {}),
                name,
                teams: chosen,
                agents: chosenAgents,
                canvas,
              }),
            );
          }}
        >
          <Field label="Name">
            <Input
              ref={input}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <fieldset className={styles.teams}>
            <legend className="text-label-sm">Agents</legend>
            {agents.length ? (
              agents.map((agent) => (
                <Checkbox
                  key={agent.pubkey}
                  label={<AgentLabel agent={agent} />}
                  checked={chosenAgents.includes(agent.pubkey)}
                  onCheckedChange={(checked) =>
                    setChosenAgents((last) =>
                      checked
                        ? [...last, agent.pubkey]
                        : last.filter((pubkey) => pubkey !== agent.pubkey),
                    )
                  }
                />
              ))
            ) : (
              <p className="m-0 text-body-sm text-secondary">No agents yet.</p>
            )}
          </fieldset>
          <fieldset className={styles.teams}>
            <legend className="text-label-sm">Teams</legend>
            {teams.length ? (
              teams.map((team) => (
                <Checkbox
                  key={team.id}
                  label={team.name}
                  checked={chosen.includes(team.id)}
                  onCheckedChange={(checked) =>
                    setChosen((last) =>
                      checked
                        ? [...last, team.id]
                        : last.filter((id) => id !== team.id),
                    )
                  }
                />
              ))
            ) : (
              <p className="m-0 text-body-sm text-secondary">
                Make teams on the Agents page.
              </p>
            )}
          </fieldset>
          <Field
            label="Starting Canvas"
            description="Markdown, copied into each new channel made from this template."
          >
            <Textarea
              rows={8}
              value={canvas}
              onChange={(event) => setCanvas(event.target.value)}
              placeholder={"# Goal\n\n# Scope\n\n# Success criteria"}
            />
          </Field>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}

function sameSet(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((item) => b.includes(item));
}
