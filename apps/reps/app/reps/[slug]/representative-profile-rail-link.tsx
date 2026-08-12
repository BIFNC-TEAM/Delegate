"use client";

import { useEffect, useState } from "react";

import {
  REPRESENTATIVE_PROFILE_RAIL_OPEN_EVENT,
  REPRESENTATIVE_PROFILE_RAIL_STATE_EVENT,
} from "./representative-profile-rail-events";

export function RepresentativeProfileRailLink({
  ariaLabel,
  label,
}: {
  ariaLabel: string;
  label: string;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const handleState = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: boolean }>).detail;
      setExpanded(detail?.open === true);
    };
    window.addEventListener(REPRESENTATIVE_PROFILE_RAIL_STATE_EVENT, handleState);
    return () => window.removeEventListener(
      REPRESENTATIVE_PROFILE_RAIL_STATE_EVENT,
      handleState,
    );
  }, []);

  return (
    <button
      aria-controls="representative-profile-rail"
      aria-expanded={expanded}
      aria-haspopup="dialog"
      aria-label={ariaLabel}
      className="marketing-nav-link representative-profile-info-link"
      onClick={(event) => window.dispatchEvent(
        new CustomEvent(REPRESENTATIVE_PROFILE_RAIL_OPEN_EVENT, {
          detail: { opener: event.currentTarget },
        }),
      )}
      type="button"
    >
      <span aria-hidden="true">ⓘ</span>
      <span>{label}</span>
    </button>
  );
}
