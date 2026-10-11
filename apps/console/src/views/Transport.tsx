import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { PAGE } from "../engine/lists.ts";
import { useClock, usePlayer, useWorldVersion } from "../engine/react.tsx";
import { timecode } from "../engine/select.ts";
import { Link } from "../router.tsx";

const RATES = [1, 4, 16];

/** Play, pause, speed and a scrubber over a test fixture's whole log. It is loaded in development only. */
export function Transport() {
  const player = usePlayer();
  useWorldVersion();
  useClock(10);
  // A story holding at a question can sit past its last event, so the scale runs to whichever is later.
  const end = Math.max(player.end, player.horizon, 1);
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <button
        type="button"
        className="a-transport-button"
        aria-label={player.playing ? "Pause" : "Play"}
        onClick={() => (player.playing ? player.pause() : player.play())}
      >
        {player.playing ? (
          <PauseIcon size={16} weight="fill" />
        ) : (
          <PlayIcon size={16} weight="fill" />
        )}
      </button>
      <fieldset
        className="flex overflow-hidden rounded-md border border-kumo-line"
        aria-label="Playback speed"
      >
        {RATES.map((rate) => (
          <button
            key={rate}
            type="button"
            className="a-rate"
            aria-pressed={player.rate === rate}
            onClick={() => player.setRate(rate)}
          >
            {rate}×
          </button>
        ))}
      </fieldset>
      <input
        type="range"
        className="a-scrub w-56"
        aria-label="Position in the log"
        min={0}
        max={end}
        step={1000}
        value={Math.min(player.t, end)}
        onChange={(event) => player.seek(Number(event.currentTarget.value))}
      />
      <span className="a-num w-24 text-kumo-subtle">
        <span className="font-medium text-kumo-strong">{timecode(player.t)}</span> / {timecode(end)}
      </span>
      {player.held && (
        <Link
          to={{ at: "escalations", filter: "open", shown: PAGE }}
          className="a-chip"
          data-tone="person"
        >
          Holding: a person is being asked
        </Link>
      )}
    </div>
  );
}
