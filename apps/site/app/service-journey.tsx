"use client";

import { useRef, useState, type ReactNode } from "react";
import { copyFor, type MarketingLocale } from "./marketing-copy";

export function ServiceJourney({ locale }: { locale: MarketingLocale }) {
  const t = copyFor(locale);
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState("lin");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recommended");
  const [humanOnly, setHumanOnly] = useState(false);
  const [takenOver, setTakenOver] = useState(false);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const agents = [
    {
      id: "mia",
      name: "Mia",
      image: "sales-advisor",
      price: 99,
      human: false,
      expertise: t("销售获客 · 客户转化", "Sales leads · Conversion"),
      focus: t(
        "梳理目标客户与销售路径",
        "Define your ideal customers and sales path",
      ),
      keywords:
        "销售 营销 市场 客户 获客 拓客 转化 策略 咨询 建议 新市场销售策略 sales marketing strategy customers",
    },
    {
      id: "lin",
      name: "Lin",
      image: "ceo",
      price: 199,
      human: true,
      expertise: t("创业经营 · 市场进入", "Business · Market entry"),
      focus: t(
        "结合业务阶段分析市场进入策略",
        "Plan market entry around your business stage",
      ),
      keywords:
        "销售 营销 市场 创业 增长 经营 策略 咨询 建议 新市场销售策略 sales startup growth market strategy",
    },
    {
      id: "alex",
      name: "Alex",
      image: "designer",
      price: 159,
      human: true,
      expertise: t("产品增长 · 购买体验", "Product growth · Buying experience"),
      focus: t(
        "从产品卖点与购买路径分析增长机会",
        "Find growth opportunities in your buying experience",
      ),
      keywords:
        "销售 营销 市场 增长 产品 体验 转化 策略 咨询 建议 新市场销售策略 sales product design growth strategy",
    },
  ];
  const agent = agents.find((item) => item.id === selected)!;
  const name = (owner: string) =>
    t(`${owner} 的对外代理`, `${owner}’s representative`);
  const filtered = agents.filter(
    (item) =>
      (!humanOnly || item.human) &&
      `${item.name} ${item.keywords} ${item.expertise}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  if (sort === "price") filtered.sort((a, b) => a.price - b.price);
  const steps = [
    t("寻找与对比", "Find & compare"),
    t("按需充值", "Choose a plan"),
    t("获得服务", "Get support"),
  ];
  const titles = [
    t(
      "先去广场，找到合适的对外代理。",
      "Find the right representative for you.",
    ),
    t("选好服务，按需充值。", "Choose a service. Top up as needed."),
    t("从对话，到交付。", "From conversation to delivery."),
  ];
  const descriptions = [
    t(
      "通过搜索、推荐和筛选，找到能处理你需求的对外代理。同一个任务，可以比较不同服务方的报价，再决定选谁。",
      "Explore this example directory with search and filters. Compare services and quotes before deciding who fits your needs.",
    ),
    t(
      "确认服务内容、金额与人工服务权益，为选中的对外代理充值，再开始你需要的服务。",
      "Review the scope, price, and human support included before topping up your chosen representative.",
    ),
    agent.human
      ? t(
          "说清需求，拿到可用的成果。遇到需要本人决定的事，对外代理会带着上下文转交人工。",
          "Explain what you need and receive a useful result. Decisions that need the owner are handed over with context.",
        )
      : t(
          "说清需求，拿到可用的成果。当前所选服务由对外代理完成；需要本人参与时，可另选支持人工接管的服务。",
          "Get a useful result from your representative. This service does not include human support; choose another provider if you need it.",
        ),
  ];
  function go(index: number) {
    setStep(index);
    tabs.current[index]?.focus({ preventScroll: true });
  }
  function message(kind: "visitor" | "agent" | "owner", content: ReactNode) {
    const speaker =
      kind === "visitor"
        ? t("你", "You")
        : kind === "owner"
          ? t(`${agent.name} · 本人`, `${agent.name} · Human`)
          : name(agent.name);
    return (
      <div
        className={`service-chat-row${kind === "visitor" ? " visitor" : ""}${kind === "owner" ? " owner-message" : ""}`}
        role="group"
        aria-label={speaker}
      >
        <img
          className="service-chat-avatar"
          src={
            kind === "visitor"
              ? "/marketing/visitor-avatar.svg"
              : `/marketing/${agent.image}.jpg`
          }
          alt=""
          width="34"
          height="34"
        />
        <div className="service-chat-bubble">
          {kind === "owner" && (
            <strong className="owner-label">{speaker}</strong>
          )}
          {content}
        </div>
      </div>
    );
  }
  return (
    <section className="content-section section-wrap" id="experience">
      <div className="section-heading">
        <p className="eyebrow">{t("02 / 使用方式", "02 / HOW IT WORKS")}</p>
        <h2>
          {t("从找到对外代理，", "From finding your representative,")}
          <br />
          {t("到获得需要的服务。", "to getting the help you need.")}
        </h2>
        <p>
          {t(
            "找到合适的对外代理，按需充值，获得需要的服务。",
            "Find the right expertise, choose a plan, and get support.",
          )}
        </p>
      </div>
      <div
        className="journey-steps"
        role="group"
        aria-label={t("选择服务流程步骤", "Explore the service journey")}
      >
        {steps.map((label, index) => (
          <button
            key={label}
            ref={(node) => {
              tabs.current[index] = node;
            }}
            className={`journey-step${step === index ? " active" : ""}`}
            aria-pressed={step === index}
            onClick={() => setStep(index)}
          >
            <span>0{index + 1}</span>
            {label}
          </button>
        ))}
      </div>
      <div
        className={`journey-stage${step === 0 ? " is-plaza" : step === 2 ? " is-service" : ""}`}
      >
        <div className="journey-copy">
          <span className="section-number">0{step + 1}</span>
          <h3>{titles[step]}</h3>
          <p>{descriptions[step]}</p>
          <p className="journey-note">
            {step === 1
              ? t(
                  "实际金额、额度及使用条件，以服务页为准。",
                  "Actual pricing, credits, and terms are shown on each service page.",
                )
              : t(
                  "交互示例 · 不会发起真实交易或请求",
                  "Interactive demo · No real transactions or requests",
                )}
          </p>
          <button
            className="button secondary"
            onClick={() => go((step + 1) % 3)}
          >
            {step === 0
              ? t("查看充值选项", "View plan options")
              : step === 1
                ? t("查看服务演示", "View service demo")
                : t("回到寻找与对比", "Back to discovery")}
          </button>
        </div>
        <div
          className={`service-preview${step === 0 ? " plaza-preview" : step === 2 ? " delivery-preview" : ""}`}
        >
          <div className="preview-topline">
            <span>
              {step === 0
                ? t("对外代理广场", "Representative directory")
                : name(agent.name)}
            </span>
            <span>{t("交互示意", "Interactive example")}</span>
          </div>
          <div className="preview-inner">
            {step === 0 && (
              <>
                <div className="plaza-search-row">
                  <form
                    role="search"
                    aria-label={t(
                      "搜索示例对外代理",
                      "Search example representatives",
                    )}
                    onSubmit={(event) => {
                      event.preventDefault();
                      setQuery(queryInput);
                    }}
                  >
                    <input
                      type="search"
                      value={queryInput}
                      onChange={(event) => setQueryInput(event.target.value)}
                      placeholder={t(
                        "搜索需求或擅长领域",
                        "Search needs or expertise",
                      )}
                      aria-label={t(
                        "搜索需求或擅长领域",
                        "Search needs or expertise",
                      )}
                    />
                    <button type="submit">{t("搜索", "Search")}</button>
                  </form>
                </div>
                <div className="plaza-toolbar">
                  <div
                    role="group"
                    aria-label={t("广场排序", "Sort representatives")}
                  >
                    <button
                      aria-pressed={sort === "recommended"}
                      onClick={() => setSort("recommended")}
                    >
                      {t("推荐", "Recommended")}
                    </button>
                    <button
                      aria-pressed={sort === "price"}
                      onClick={() => setSort("price")}
                    >
                      {t("低价优先", "Lowest price")}
                    </button>
                  </div>
                  <select
                    value={humanOnly ? "supported" : "all"}
                    onChange={(event) =>
                      setHumanOnly(event.target.value === "supported")
                    }
                    aria-label={t("筛选人工支持", "Filter human support")}
                  >
                    <option value="all">
                      {t("人工支持：不限", "All services")}
                    </option>
                    <option value="supported">
                      {t("可申请人工", "Human support")}
                    </option>
                  </select>
                </div>
                <div aria-live="polite">
                  {filtered.length ? (
                    filtered.map((item) => (
                      <article
                        className={`plaza-agent${item.id === selected ? " selected" : ""}`}
                        key={item.id}
                      >
                        <img
                          src={`/marketing/${item.image}.jpg`}
                          alt=""
                          width="40"
                          height="40"
                          loading="lazy"
                        />
                        <div className="plaza-agent-info">
                          <h4>{name(item.name)}</h4>
                          <p>{item.expertise}</p>
                          <span>{item.focus}</span>
                          <small>
                            {item.human
                              ? t("可申请人工接管", "Human support available")
                              : t("仅对外代理服务", "AI service only")}
                          </small>
                        </div>
                        <div className="plaza-quote">
                          <span>{t("示例报价", "Example price")}</span>
                          <strong>
                            ¥{item.price}
                            <small>{t(" / 次", " / service")}</small>
                          </strong>
                          <button
                            aria-label={t(
                              `选择${name(item.name)}`,
                              `Select ${name(item.name)}`,
                            )}
                            aria-pressed={selected === item.id}
                            onClick={() => {
                              setSelected(item.id);
                              setTakenOver(false);
                            }}
                          >
                            {item.id === selected
                              ? t("已选择", "Selected")
                              : t("选择", "Select")}
                          </button>
                        </div>
                      </article>
                    ))
                  ) : (
                    <div className="plaza-empty">
                      <strong>
                        {t("没有匹配的示例", "No matching examples")}
                      </strong>
                      <p>
                        {t(
                          "试试“销售”“增长”，或重置搜索与筛选。",
                          "Try “sales” or “growth”, or reset the filters.",
                        )}
                      </p>
                      <button
                        onClick={() => {
                          setQuery("");
                          setQueryInput("");
                          setHumanOnly(false);
                        }}
                      >
                        {t("重置条件", "Reset filters")}
                      </button>
                    </div>
                  )}
                </div>
                <div className="plaza-selection">
                  <span>
                    {t("已选：", "Selected: ")}
                    {name(agent.name)}
                  </span>
                  <button onClick={() => go(1)}>
                    {t("查看充值选项", "View plan")}
                  </button>
                </div>
                <p className="plaza-disclaimer">
                  {t(
                    "角色与报价均为示例；实际报价、交付及人工服务条件以服务页为准。",
                    "Roles and prices are examples. Actual pricing, deliverables, and human support terms are shown on each service page.",
                  )}
                </p>
              </>
            )}
            {step === 1 && (
              <>
                <div className="recharge-person">
                  <img
                    src={`/marketing/${agent.image}.jpg`}
                    alt=""
                    width="42"
                    height="42"
                  />
                  <div>
                    <strong>{name(agent.name)}</strong>
                    <span>{agent.expertise}</span>
                  </div>
                </div>
                <div className="recharge-plan">
                  <div className="recharge-plan-heading">
                    <h4>{t("新市场策略咨询", "New market strategy")}</h4>
                    <span>{t("示例服务", "Example service")}</span>
                  </div>
                  <div className="recharge-price">
                    ¥{agent.price}
                    <span>{t(" / 次", " / service")}</span>
                  </div>
                  <p>
                    {t(
                      "梳理业务方向，整理一份可执行的行动清单。",
                      "Clarify your business direction with an actionable checklist.",
                    )}
                  </p>
                  <dl>
                    <div>
                      <dt>{t("充值对象", "Recipient")}</dt>
                      <dd>{name(agent.name)}</dd>
                    </div>
                    <div>
                      <dt>{t("人工接管", "Human support")}</dt>
                      <dd>
                        {agent.human
                          ? t(
                              "可申请，按套餐权益提供",
                              "Available under plan terms",
                            )
                          : t("不包含人工接管", "Not included")}
                      </dd>
                    </div>
                  </dl>
                </div>
                <p className="recharge-caption">
                  {t(
                    "按自己的需求选择服务，确认后再充值。",
                    "Choose what fits your needs. Review the terms before paying.",
                  )}
                </p>
              </>
            )}
            {step === 2 && (
              <>
                <div className="service-conversation delivery-conversation">
                  {message(
                    "visitor",
                    t(
                      "我们想面向中小团队拓展新市场。能帮我整理一份行动清单吗？",
                      "We want to reach small teams in a new market. Can you put together an action plan?",
                    ),
                  )}
                  {message(
                    "agent",
                    t(
                      "可以，我把目标客户、触达话术和第一周要做的事整理好了。你先看看这份清单。",
                      "Here’s a checklist covering target customers, outreach, and your first week’s actions.",
                    ),
                  )}
                  <div className="service-deliverable">
                    <div className="deliverable-heading">
                      <span className="deliverable-icon" aria-hidden="true">
                        ↳
                      </span>
                      <div>
                        <strong>
                          {t(
                            "新市场拓客行动清单",
                            "New market outreach checklist",
                          )}
                        </strong>
                        <span>
                          {t(
                            "客户画像 · 触达话术 · 7 天行动",
                            "Customer profile · Outreach · 7-day plan",
                          )}
                        </span>
                      </div>
                      <span className="delivered-label">
                        {t("已交付", "Delivered")}
                      </span>
                    </div>
                    <details>
                      <summary>{t("查看交付内容", "View deliverable")}</summary>
                      <ol>
                        <li>
                          <strong>{t("先找谁", "Who to contact")}</strong>
                          <p>
                            {t(
                              "优先联系与现有成功客户相似的中小团队，列出首批 10 家目标客户。",
                              "List 10 small teams similar to your existing successful customers.",
                            )}
                          </p>
                        </li>
                        <li>
                          <strong>{t("怎么开口", "How to reach out")}</strong>
                          <p>
                            {t(
                              "“我们正在帮助同类团队解决获客问题，想了解你们目前最想改善哪个环节？”",
                              "“We help teams like yours acquire customers. Which part of that process would you most like to improve?”",
                            )}
                          </p>
                        </li>
                        <li>
                          <strong>
                            {t("第一周做什么", "Your first week")}
                          </strong>
                          <p>
                            {t(
                              "前两天整理客户名单与案例，随后分批沟通；周末汇总反馈，调整下一轮方向。",
                              "Prepare your list and examples, reach out in small batches, then review feedback at the end of the week.",
                            )}
                          </p>
                        </li>
                      </ol>
                    </details>
                  </div>
                  {message(
                    "visitor",
                    t(
                      `这份清单很有用。能请 ${agent.name} 本人周三 14:00 和我们评审一下吗？`,
                      `This is helpful. Could ${agent.name} review it with us on Wednesday at 14:00?`,
                    ),
                  )}
                  {message(
                    "agent",
                    agent.human
                      ? t(
                          `参会时间需要 ${agent.name} 本人确认，我不能代为答应。我已把邀请和清单一起转交，等本人接手。`,
                          `${agent.name} needs to confirm the time personally. I’ve passed along the invitation and checklist.`,
                        )
                      : t(
                          `这个服务暂不支持人工接管，我不能替 ${agent.name} 安排参会。我们可以继续把评审材料准备好。`,
                          `This plan does not include human support. I cannot schedule a meeting for ${agent.name}, but I can help prepare review materials.`,
                        ),
                  )}
                  <div
                    className={`service-handoff${!agent.human ? " unavailable" : takenOver ? " accepted" : ""}`}
                  >
                    <div className="handoff-state">
                      <span className="handoff-dot" />
                      <strong>
                        {!agent.human
                          ? t(
                              "当前服务不含人工接管",
                              "Human support is not included",
                            )
                          : takenOver
                            ? t(
                                `${agent.name} · 本人已接手`,
                                `${agent.name} · Human has joined`,
                              )
                            : t(
                                `已转交 ${agent.name} · 等待接手`,
                                `Sent to ${agent.name} · Waiting for a human`,
                              )}
                      </strong>
                    </div>
                    <p>
                      {agent.human
                        ? t(
                            "评审邀请、会话与行动清单已一并附上。",
                            "The invitation, conversation, and checklist are attached.",
                          )
                        : t(
                            "本次参会邀请未提交，可返回广场选择支持人工的服务。",
                            "No invitation was submitted. Choose a service with human support.",
                          )}
                    </p>
                    {agent.human ? (
                      <button
                        disabled={takenOver}
                        onClick={() => setTakenOver(true)}
                      >
                        {takenOver
                          ? t("本人已接手", "Human has joined")
                          : t("演示本人接手", "Simulate human takeover")}
                      </button>
                    ) : (
                      <button onClick={() => go(0)}>
                        {t("返回广场", "Back to directory")}
                      </button>
                    )}
                  </div>
                  <div aria-live="polite">
                    {takenOver &&
                      agent.human &&
                      message(
                        "owner",
                        t(
                          `你好，我是 ${agent.name}。清单和邀请我看过了，接下来由我和你沟通。我们先确认一下评审范围，再一起敲定时间。`,
                          `Hi, I’m ${agent.name}. I’ve read the checklist and invitation. Let’s confirm the review scope and find a time together.`,
                        ),
                      )}
                  </div>
                </div>
                <p className="service-demo-note">
                  {t(
                    "服务过程演示 · 不会发起真实充值或人工请求",
                    "Service demo · No real payments or human requests",
                  )}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
