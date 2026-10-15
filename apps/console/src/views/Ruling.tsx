// Ruling on a question, where a person meets it: the two changes in words, a button for each answer that says
// what it does, and a confirmation before the ruling is sent. Whoever may not rule reads who rules instead.

import { Button } from "@cloudflare/kumo";
import { useState } from "react";
import type { RulingWords } from "../engine/ruling.ts";
import { ChangeLink } from "./links.tsx";

export function RulingLines({ words }: { words: RulingWords }) {
  if (words.relies === undefined && words.changes === undefined) return null;
  return (
    <ul className="flex flex-col gap-1 text-base text-kumo-default">
      {words.relies !== undefined && (
        <li>
          <ChangeLink id={words.relies.changeId} className="a-link font-semibold">
            {words.relies.label}
          </ChangeLink>{" "}
          relies on <b className="font-semibold text-kumo-strong">{words.relies.on}</b>
          {words.relies.goal !== "" && (
            <span className="text-sm text-kumo-subtle"> · {words.relies.goal}</span>
          )}
        </li>
      )}
      {words.changes !== undefined && (
        <li>
          <ChangeLink id={words.changes.changeId} className="a-link font-semibold">
            {words.changes.label}
          </ChangeLink>{" "}
          <b className="font-semibold text-kumo-strong">{words.changes.does}</b>
          {words.changes.goal !== "" && (
            <span className="text-sm text-kumo-subtle"> · {words.changes.goal}</span>
          )}
        </li>
      )}
    </ul>
  );
}

export function RulingActions({
  words,
  answerable,
  readOnly,
  onRule,
}: {
  words: RulingWords;
  /** Whether this reader may rule. */
  answerable: boolean;
  /** What a reader who may not rule is told. */
  readOnly: string;
  onRule: (option: string, rationale?: string) => Promise<void>;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  if (!answerable) return <p className="text-sm text-kumo-subtle">{readOnly}</p>;
  const chosen = words.options.find((option) => option.id === picked);
  const send = async (): Promise<void> => {
    if (chosen === undefined) return;
    setSending(true);
    setRefused(null);
    try {
      await onRule(chosen.id, rationale.trim() === "" ? undefined : rationale.trim());
      setPicked(null);
    } catch (error) {
      setRefused(error instanceof Error ? error.message : "The ruling could not be sent.");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {words.options.map((option, index) => (
          <div key={option.id} className="flex flex-col gap-0.5">
            <Button
              variant={index === 0 ? "primary" : "secondary"}
              aria-pressed={picked === option.id}
              disabled={sending}
              onClick={() => setPicked(option.id)}
            >
              {option.label}
            </Button>
            <span className="a-mono px-1 text-xs text-kumo-inactive">{option.id}</span>
          </div>
        ))}
      </div>
      {chosen !== undefined && (
        <div className="flex flex-col gap-2 rounded-lg border border-kumo-line p-3">
          <p className="text-base text-kumo-strong">
            Rule: <b className="font-semibold">{chosen.label}</b>
          </p>
          {chosen.consequence !== "" && (
            <p className="text-sm text-kumo-subtle">{chosen.consequence}</p>
          )}
          <label className="flex flex-col gap-1 text-sm text-kumo-default">
            Rationale (optional)
            <textarea
              className="min-h-16 rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-base text-kumo-strong"
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <Button variant="primary" loading={sending} onClick={() => void send()}>
              Confirm ruling
            </Button>
            <Button variant="secondary" disabled={sending} onClick={() => setPicked(null)}>
              Cancel
            </Button>
          </div>
          {refused !== null && (
            <p role="alert" className="text-sm" style={{ color: "var(--a-fail-ink)" }}>
              Refused: {refused}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
