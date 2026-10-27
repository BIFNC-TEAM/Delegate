"use client";

import { useEffect, useState } from "react";
import { copyFor, marketingMenu, type MarketingLocale } from "./marketing-copy";

export function SiteSectionNavigation({ locale }: { locale: MarketingLocale }) {
  const [active, setActive] = useState("");
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(`#${entry.target.id}`);
        }
      },
      { rootMargin: "-20% 0px -55% 0px", threshold: 0 },
    );
    for (const id of ["top", "network", "experience", "create", "faq"]) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, []);
  return (
    <nav
      className="desktop-nav"
      aria-label={copyFor(locale)("主导航", "Main navigation")}
    >
      {marketingMenu(locale).map((item) => (
        <a
          key={item.href}
          href={item.href}
          className={active === item.href ? "active" : undefined}
          aria-current={active === item.href ? "location" : undefined}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}
