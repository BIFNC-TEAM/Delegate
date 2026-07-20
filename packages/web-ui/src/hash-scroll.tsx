"use client";

import { useEffect } from "react";

export function HashScrollRestorer({ offset = 112 }: { offset?: number }) {
  useEffect(() => {
    let frame = 0;
    let timeout = 0;

    function scrollToHash() {
      const hash = window.location.hash.slice(1);
      if (!hash) {
        return;
      }

      const target = document.getElementById(decodeURIComponent(hash));
      if (!target) {
        return;
      }

      const top = target.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
    }

    scrollToHash();
    frame = window.requestAnimationFrame(scrollToHash);
    timeout = window.setTimeout(scrollToHash, 180);
    window.addEventListener("hashchange", scrollToHash);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
      window.removeEventListener("hashchange", scrollToHash);
    };
  }, [offset]);

  return null;
}
