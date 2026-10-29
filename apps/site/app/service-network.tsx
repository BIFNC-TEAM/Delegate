"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { copyFor, type MarketingLocale } from "./marketing-copy";

const connections = {
  wide: [
    "M320 120 C440 50 660 50 780 120",
    "M320 480 C440 550 660 550 780 480",
    "M112 190 C20 235 20 365 112 410",
    "M988 190 C1080 235 1080 365 988 410",
    "M320 190 C450 205 650 395 780 410",
    "M780 190 C650 205 450 395 320 410",
  ],
  compact: [
    "M184 118 Q200 106 216 118",
    "M184 542 Q200 554 216 542",
    "M88 252 C58 300 58 360 88 408",
    "M312 252 C342 300 342 360 312 408",
    "M142 250 C176 285 224 375 258 410",
    "M258 250 C224 285 176 375 142 410",
  ],
};

export function ServiceNetwork({ locale }: { locale: MarketingLocale }) {
  const t = copyFor(locale);
  const root = useRef<HTMLElement>(null);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPaused(reduced.matches);
    update();
    reduced.addEventListener("change", update);
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { threshold: 0.15 },
    );
    if (root.current) observer.observe(root.current);
    return () => {
      observer.disconnect();
      reduced.removeEventListener("change", update);
    };
  }, []);
  const people = [
    ["ceo", "ceo", "CEO", t("创业经营 · 战略咨询", "Business · Strategy")],
    [
      "doctor",
      "nutrition-doctor",
      t("营养科医生", "Nutrition doctor"),
      t("营养科普 · 健康咨询", "Nutrition · Health education"),
    ],
    [
      "designer",
      "designer",
      t("设计师", "Designer"),
      t("产品设计 · 方案评审", "Product design · Reviews"),
    ],
    [
      "sales",
      "sales-advisor",
      t("销售顾问", "Sales advisor"),
      t("销售策略 · 客户沟通", "Sales strategy · Outreach"),
    ],
  ];
  return (
    <section
      ref={root}
      className={`network-section${visible ? " in-view" : ""}${paused ? " motion-paused" : ""}`}
      id="network"
    >
      <div className="section-wrap">
        <div className="section-heading centered">
          <p className="eyebrow">
            {t("01 / 服务网络", "01 / SERVICE NETWORK")}
          </p>
          <h2>
            {t(
              "为彼此的对外代理充值，",
              "Top up each other’s representatives.",
            )}
            <br />
            <span>
              {t("让专业服务相互连接。", "Connect a world of expertise.")}
            </span>
          </h2>
          <p>
            {t(
              "每个人都能提供服务，也能向其他人的对外代理充值、发起咨询。",
              "Offer your own services, and consult other people’s representatives when you need their expertise.",
            )}
          </p>
        </div>
        <figure
          className="service-mesh"
          aria-label={t(
            "CEO、营养科医生、设计师、销售顾问两两双向连接，每个人都可以提供服务，也获得服务。",
            "A CEO, nutrition doctor, designer, and sales advisor connect in both directions. Everyone can offer and receive services.",
          )}
        >
          {(["wide", "compact"] as const).map((size) => (
            <svg
              key={size}
              className={`mesh-lines mesh-lines-${size}`}
              viewBox={size === "wide" ? "0 0 1100 600" : "0 0 400 660"}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <marker
                  id={`mesh-arrow-${size}`}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path
                    d="M2 2 L8 5 L2 8"
                    fill="none"
                    stroke="#86a9e9"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </marker>
              </defs>
              {connections[size].map((d, index) => (
                <g key={d}>
                  <path
                    className="mesh-link"
                    d={d}
                    markerStart={`url(#mesh-arrow-${size})`}
                    markerEnd={`url(#mesh-arrow-${size})`}
                  />
                  <path
                    className="mesh-flow mesh-flow-out"
                    d={d}
                    pathLength="100"
                    style={
                      { "--flow-delay": `${-index * 1.3}s` } as CSSProperties
                    }
                  />
                  <path
                    className="mesh-flow mesh-flow-back"
                    d={d}
                    pathLength="100"
                    style={
                      {
                        "--flow-delay": `${-index * 1.3 - 3.6}s`,
                      } as CSSProperties
                    }
                  />
                </g>
              ))}
            </svg>
          ))}
          {people.map(([id, image, name, expertise]) => (
            <article className={`mesh-person mesh-person-${id}`} key={id}>
              <div className="mesh-portrait">
                <img
                  src={`/marketing/${image}.jpg`}
                  alt={t(
                    `${name}角色示意头像`,
                    `Illustrative ${name} portrait`,
                  )}
                  width="88"
                  height="88"
                  loading="lazy"
                />
              </div>
              <h3>{name}</h3>
              <p>{expertise}</p>
              <span className="mesh-agent">
                {t("对外代理", "AI representative")}
              </span>
            </article>
          ))}
        </figure>
        <div className="mesh-caption">
          <span className="mesh-direction" aria-hidden="true">
            ↔
          </span>
          <p>
            {t(
              "彼此充值，互相咨询。每个人都在网络中提供服务，也获得服务。",
              "Support and consult one another. Everyone offers expertise and benefits from someone else’s.",
            )}
          </p>
        </div>
        <div className="network-bottom">
          <div className="network-meta">
            <small>
              {t(
                "角色与服务关系为示意 · 头像由 AI 生成",
                "Illustrative roles and service relationships · AI-generated portraits",
              )}
            </small>
            <button
              className="motion-toggle"
              aria-pressed={paused}
              onClick={() => setPaused(!paused)}
            >
              {paused
                ? t("开启动效", "Resume animation")
                : t("暂停动效", "Pause animation")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
