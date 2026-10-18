"use client";

import { useEffect, useState } from "react";

import type { StyleSummary } from "@/lib/domain/types";
import { listStyles } from "@/lib/http/workspace-api";

export interface StyleSelectorProps {
  /** The style the active script is associated with, or `null` if none is. */
  readonly styleId: string | null;
  /**
   * Called with the style the user chose. `null` when no script is open: the
   * selector still shows the catalogue but cannot change an association that
   * does not exist.
   */
  readonly onChoose: ((styleId: string) => void) | null;
  /**
   * Shown under the selector when the last choice could not be saved. The
   * selector itself keeps no copy of the choice: what it shows is `styleId`,
   * so a refused change is visible as the selection reverting.
   */
  readonly error?: string | null;
}

/**
 * The single style association (FR-007, FR-009).
 *
 * The options are exactly the predefined catalogue — there is no "new style"
 * entry (FR-008). Choosing a style reports it to the caller, which persists the
 * association; the selector itself decides nothing about the script.
 */
export function StyleSelector({ styleId, onChoose, error = null }: StyleSelectorProps) {
  const [styles, setStyles] = useState<readonly StyleSummary[]>([]);

  useEffect(() => {
    let current = true;

    void listStyles().then((result) => {
      if (current && result.ok) {
        setStyles(result.data);
      }
    });

    return () => {
      current = false;
    };
  }, []);

  const disabled = onChoose === null || styles.length === 0;

  return (
    <label className="text-foreground-muted flex flex-col gap-1 text-xs">
      Style
      <select
        aria-label="Style"
        value={styleId ?? styles[0]?.id ?? ""}
        disabled={disabled}
        onChange={(event) => onChoose?.(event.target.value)}
        className="text-foreground rounded border px-2 py-1 text-sm"
      >
        {/* A script with no style yet shows the catalogue's first entry as the
            initial value (spec Assumptions), without claiming it is assigned. */}
        {styles.map((style) => (
          <option key={style.id} value={style.id} title={style.description}>
            {style.name}
          </option>
        ))}
      </select>
      {error ? (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      ) : null}
    </label>
  );
}
