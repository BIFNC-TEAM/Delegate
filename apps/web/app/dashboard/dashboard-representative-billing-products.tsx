"use client";

import {
  useCallback,
  useEffect,
  useState,
} from "react";

import type {
  OwnerBillingCatalog,
  OwnerBillingProduct,
} from "@delegate/web-data";
import type { Locale } from "@delegate/web-ui";

type ProductEditor =
  | {
      kind: "create";
      idempotencyKey: string;
      name: string;
      description: string;
      amountMinor: number;
      entitlementUnits: number;
      revenuePolicyCreatorShareBps: number;
    }
  | {
      kind: "metadata";
      idempotencyKey: string;
      productId: string;
      expectedRevision: number;
      name: string;
      description: string;
    }
  | {
      kind: "price";
      idempotencyKey: string;
      productId: string;
      productName: string;
      expectedRevision: number;
      expectedActivePriceVersionId: string;
      amountMinor: number;
      entitlementUnits: number;
      revenuePolicyCreatorShareBps: number;
    };

export function DashboardRepresentativeBillingProducts({
  locale,
  representativeSlug,
}: {
  locale: Locale;
  representativeSlug: string;
}) {
  const zh = locale === "zh";
  const [catalog, setCatalog] = useState<OwnerBillingCatalog | null>(null);
  const [editor, setEditor] = useState<ProductEditor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const loadCatalog = useCallback(async () => {
    const response = await fetch(
      `/api/dashboard/representatives/${encodeURIComponent(representativeSlug)}/billing-products`,
      { cache: "no-store" },
    );
    return readResponse<OwnerBillingCatalog>(response);
  }, [representativeSlug]);

  useEffect(() => {
    let current = true;
    setCatalog(null);
    setEditor(null);
    setError(null);
    setMessage(null);
    setIsPending(true);
    void loadCatalog()
      .then((payload) => {
        if (current) setCatalog(payload);
      })
      .catch((nextError: unknown) => {
        if (current) setError(errorMessage(nextError, zh));
      })
      .finally(() => {
        if (current) setIsPending(false);
      });
    return () => {
      current = false;
    };
  }, [loadCatalog, zh]);

  function commitEditor() {
    if (!editor) return;
    setError(null);
    setMessage(null);

    if (
      (editor.kind === "create" || editor.kind === "price")
      && !confirmPricePublication(editor, locale)
    ) {
      return;
    }

    setIsPending(true);
    void saveEditor(editor)
      .then((product) => {
        mergeProduct(product);
        setEditor(null);
        setMessage(
          editor.kind === "metadata"
            ? zh
              ? "服务包信息已更新。"
              : "Service package details updated."
            : zh
              ? `已发布 ${product.name} 的价格版本 v${product.activePriceVersion?.version ?? "—"}。`
              : `Published ${product.name} price version v${product.activePriceVersion?.version ?? "—"}.`,
        );
      })
      .catch((nextError: unknown) => {
        setError(errorMessage(nextError, zh));
      })
      .finally(() => setIsPending(false));
  }

  function archiveProduct(product: OwnerBillingProduct) {
    const confirmed = window.confirm(
      zh
        ? `归档“${product.name}”？归档后将停止新购买，现有订单仍会继续处理。`
        : `Archive “${product.name}”? New purchases will stop while existing orders continue processing.`,
    );
    if (!confirmed) return;
    setError(null);
    setMessage(null);
    setIsPending(true);
    void mutateProduct(
      `/api/dashboard/representatives/${encodeURIComponent(representativeSlug)}/billing-products/${encodeURIComponent(product.id)}/archive`,
      "POST",
      { expectedRevision: product.revision },
      `billing:archive:${product.id}:${product.revision}`,
    )
      .then((archived) => {
        mergeProduct(archived);
        setEditor(null);
        setMessage(
          zh
            ? `${archived.name} 已归档并停止新购买。`
            : `${archived.name} is archived and no longer accepts new purchases.`,
        );
      })
      .catch((nextError: unknown) => {
        setError(errorMessage(nextError, zh));
      })
      .finally(() => setIsPending(false));
  }

  async function saveEditor(current: ProductEditor) {
    if (current.kind === "create") {
      return mutateProduct(
        `/api/dashboard/representatives/${encodeURIComponent(representativeSlug)}/billing-products`,
        "POST",
        {
          name: current.name,
          description: current.description || null,
          price: pricePayload(current),
        },
        current.idempotencyKey,
      );
    }
    if (current.kind === "metadata") {
      return mutateProduct(
        `/api/dashboard/representatives/${encodeURIComponent(representativeSlug)}/billing-products/${encodeURIComponent(current.productId)}`,
        "PATCH",
        {
          expectedRevision: current.expectedRevision,
          name: current.name,
          description: current.description || null,
        },
        current.idempotencyKey,
      );
    }
    return mutateProduct(
      `/api/dashboard/representatives/${encodeURIComponent(representativeSlug)}/billing-products/${encodeURIComponent(current.productId)}/price-versions`,
      "POST",
      {
        expectedRevision: current.expectedRevision,
        expectedActivePriceVersionId:
          current.expectedActivePriceVersionId,
        price: pricePayload(current),
      },
      current.idempotencyKey,
    );
  }

  async function mutateProduct(
    url: string,
    method: "PATCH" | "POST",
    body: unknown,
    idempotencyKey: string,
  ) {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    const payload = await readResponse<{ product: OwnerBillingProduct }>(
      response,
    );
    return payload.product;
  }

  function mergeProduct(product: OwnerBillingProduct) {
    setCatalog((current) => {
      if (!current) return current;
      const exists = current.products.some(
        (candidate) => candidate.id === product.id,
      );
      return {
        ...current,
        products: exists
          ? current.products.map((candidate) =>
              candidate.id === product.id ? product : candidate
            )
          : [...current.products, product],
      };
    });
  }

  return (
    <section
      aria-labelledby="representative-service-packages-title"
      className="representative-billing-products"
    >
      <header className="representative-billing-products-header">
        <div>
          <p>WECHAT PAY / CNY SERVICE PACKAGES</p>
          <h3 id="representative-service-packages-title">
            {zh
              ? "管理一次性服务包与不可变价格版本。"
              : "Manage one-time packages and immutable price versions."}
          </h3>
          <span>
            {zh
              ? "服务包独立于代表发布版本；发布新价格后立即用于新订单，历史订单继续使用原快照。"
              : "Packages are independent from representative releases. New prices apply to new orders while historical orders keep their snapshots."}
          </span>
        </div>
        <button
          className="button-primary"
          disabled={
            isPending
            || !catalog
            || !catalog.revenueSharePolicy
          }
          onClick={() => {
            const policy = catalog?.revenueSharePolicy;
            if (!policy) return;
            setEditor({
              kind: "create",
              idempotencyKey: createBrowserRequestId(),
              name: "",
              description: "",
              amountMinor: 500,
              entitlementUnits: 500,
              revenuePolicyCreatorShareBps:
                policy.creatorRevenueShareBps,
            });
          }}
          type="button"
        >
          {zh ? "新建服务包" : "New package"}
        </button>
      </header>

      {message ? (
        <div
          className="representative-billing-feedback is-success"
          role="status"
        >
          {message}
        </div>
      ) : null}
      {error ? (
        <div
          className="representative-billing-feedback is-error"
          role="alert"
        >
          <span>{error}</span>
          <button
            disabled={isPending}
            onClick={() => {
              setError(null);
              setIsPending(true);
              void loadCatalog()
                .then(setCatalog)
                .catch((nextError: unknown) => {
                  setError(errorMessage(nextError, zh));
                })
                .finally(() => setIsPending(false));
            }}
            type="button"
          >
            {zh ? "刷新" : "Refresh"}
          </button>
        </div>
      ) : null}
      {catalog && !catalog.revenueSharePolicy ? (
        <div className="representative-billing-feedback is-error" role="alert">
          {zh
            ? "当前代表缺少有效的 CNY 平台分成政策，暂不能发布服务包。"
            : "This representative has no valid CNY platform revenue-share policy, so package publication is disabled."}
        </div>
      ) : null}

      {!catalog && !error ? (
        <div className="representative-billing-empty" role="status">
          {zh ? "正在读取真实服务包…" : "Loading live service packages…"}
        </div>
      ) : catalog && !catalog.products.length ? (
        <div className="representative-billing-empty">
          {zh
            ? "当前代表还没有服务包。新建后会直接发布首个价格版本。"
            : "This representative has no packages. Creating one publishes its first price version."}
        </div>
      ) : catalog ? (
        <div className="representative-billing-product-list">
          {catalog.products.map((product) => (
            <BillingProductCard
              isPending={isPending}
              key={product.id}
              locale={locale}
              revenuePolicyAvailable={Boolean(catalog.revenueSharePolicy)}
              onArchive={() => archiveProduct(product)}
              onEdit={() =>
                setEditor({
                  kind: "metadata",
                  idempotencyKey: createBrowserRequestId(),
                  productId: product.id,
                  expectedRevision: product.revision,
                  name: product.name,
                  description: product.description ?? "",
                })
              }
              onPublishPrice={() => {
                const price = product.activePriceVersion;
                const policy = catalog.revenueSharePolicy;
                if (!price || !policy) return;
                setEditor({
                  kind: "price",
                  idempotencyKey:
                    `billing:price:${product.id}:${product.revision}`,
                  productId: product.id,
                  productName: product.name,
                  expectedRevision: product.revision,
                  expectedActivePriceVersionId: price.id,
                  amountMinor: price.amountMinor,
                  entitlementUnits: price.entitlementUnits,
                  revenuePolicyCreatorShareBps:
                    policy.creatorRevenueShareBps,
                });
              }}
              product={product}
            />
          ))}
        </div>
      ) : null}

      {editor ? (
        <BillingProductEditor
          editor={editor}
          isPending={isPending}
          locale={locale}
          onCancel={() => setEditor(null)}
          onChange={setEditor}
          onCommit={commitEditor}
        />
      ) : null}
    </section>
  );
}

function BillingProductCard({
  isPending,
  locale,
  onArchive,
  onEdit,
  onPublishPrice,
  product,
  revenuePolicyAvailable,
}: {
  isPending: boolean;
  locale: Locale;
  onArchive: () => void;
  onEdit: () => void;
  onPublishPrice: () => void;
  product: OwnerBillingProduct;
  revenuePolicyAvailable: boolean;
}) {
  const zh = locale === "zh";
  const price = product.activePriceVersion;
  return (
    <article
      className={`representative-billing-product-card is-${product.status.toLowerCase()}`}
    >
      <header>
        <div>
          <span
            className={`representative-billing-status is-${product.status.toLowerCase()}`}
          >
            {productStatusLabel(product.status, locale)}
          </span>
          <code>{product.code}</code>
        </div>
        <strong>{product.name}</strong>
        <p>
          {product.description
            ?? (zh ? "未填写服务包说明。" : "No package description.")}
        </p>
      </header>
      {price ? (
        <dl className="representative-billing-facts">
          <div>
            <dt>{zh ? "当前价格" : "Current price"}</dt>
            <dd>{formatCny(price.amountMinor, locale)}</dd>
          </div>
          <div>
            <dt>{zh ? "服务额度" : "Credits"}</dt>
            <dd>{formatInteger(price.entitlementUnits, locale)}</dd>
          </div>
          <div>
            <dt>{zh ? "分成" : "Split"}</dt>
            <dd>
              {price.creatorRevenueShareBps / 100}% /{" "}
              {price.platformRevenueShareBps / 100}%
            </dd>
          </div>
          <div>
            <dt>{zh ? "价格版本" : "Price version"}</dt>
            <dd>v{price.version}</dd>
          </div>
        </dl>
      ) : (
        <p className="representative-billing-no-price">
          {zh
            ? "没有活动价格，当前不可购买。"
            : "No active price; this package cannot be purchased."}
        </p>
      )}
      <footer>
        <span>
          {zh
            ? "永久有效 · 完全未使用时全额退款"
            : "No expiry · full refund only when wholly unused"}
        </span>
        <div>
          <button
            disabled={isPending || product.status === "ARCHIVED"}
            onClick={onEdit}
            type="button"
          >
            {zh ? "编辑说明" : "Edit details"}
          </button>
          <button
            disabled={
              isPending
              || product.status !== "ACTIVE"
              || !product.activePriceVersion
              || !revenuePolicyAvailable
            }
            onClick={onPublishPrice}
            type="button"
          >
            {zh ? "发布新价格" : "Publish new price"}
          </button>
          <button
            className="is-danger"
            disabled={isPending || product.status === "ARCHIVED"}
            onClick={onArchive}
            type="button"
          >
            {zh ? "归档" : "Archive"}
          </button>
        </div>
      </footer>
    </article>
  );
}

function BillingProductEditor({
  editor,
  isPending,
  locale,
  onCancel,
  onChange,
  onCommit,
}: {
  editor: ProductEditor;
  isPending: boolean;
  locale: Locale;
  onCancel: () => void;
  onChange: (value: ProductEditor) => void;
  onCommit: () => void;
}) {
  const zh = locale === "zh";
  const editsPrice = editor.kind === "create" || editor.kind === "price";
  const creatorRevenueShareBps =
    editor.kind === "metadata"
      ? 0
      : editor.revenuePolicyCreatorShareBps;
  return (
    <section
      aria-labelledby="representative-billing-editor-title"
      className="representative-billing-editor"
    >
      <header>
        <div>
          <p>
            {editor.kind === "create"
              ? zh ? "新服务包" : "New package"
              : editor.kind === "metadata"
                ? zh ? "商品信息" : "Package details"
                : zh ? "新价格版本" : "New price version"}
          </p>
          <h4 id="representative-billing-editor-title">
            {editor.kind === "price"
              ? editor.productName
              : zh
                ? "确认后保存"
                : "Save after review"}
          </h4>
        </div>
        <button
          aria-label={zh ? "关闭编辑器" : "Close editor"}
          disabled={isPending}
          onClick={onCancel}
          type="button"
        >
          ×
        </button>
      </header>
      <div className="representative-billing-editor-grid">
        {editor.kind !== "price" ? (
          <>
            <label>
              <span>{zh ? "服务包名称" : "Package name"}</span>
              <input
                maxLength={80}
                onChange={(event) =>
                  onChange({ ...editor, name: event.target.value })
                }
                value={editor.name}
              />
            </label>
            <label className="is-wide">
              <span>{zh ? "公开说明" : "Public description"}</span>
              <textarea
                maxLength={500}
                onChange={(event) =>
                  onChange({
                    ...editor,
                    description: event.target.value,
                  })
                }
                rows={3}
                value={editor.description}
              />
            </label>
          </>
        ) : null}
        {editsPrice ? (
          <>
            <label>
              <span>{zh ? "价格（分）" : "Price (fen)"}</span>
              <input
                min={1}
                onChange={(event) =>
                  onChange({
                    ...editor,
                    amountMinor: Number(event.target.value || 0),
                  })
                }
                type="number"
                value={editor.amountMinor}
              />
            </label>
            <label>
              <span>{zh ? "包含服务额度" : "Included credits"}</span>
              <input
                min={1}
                onChange={(event) =>
                  onChange({
                    ...editor,
                    entitlementUnits: Number(
                      event.target.value || 0,
                    ),
                  })
                }
                type="number"
                value={editor.entitlementUnits}
              />
            </label>
            <div className="representative-billing-editor-summary">
              <span>{zh ? "将发布" : "Will publish"}</span>
              <strong>
                {formatCny(editor.amountMinor, locale)}
                {" · "}
                {formatInteger(editor.entitlementUnits, locale)}
                {zh ? " 额度" : " credits"}
              </strong>
              <small>
                Creator {creatorRevenueShareBps / 100}% · Platform{" "}
                {(10_000 - creatorRevenueShareBps) / 100}%
                {" · "}
                {zh ? "平台政策只读" : "platform policy, read-only"}
              </small>
            </div>
          </>
        ) : null}
      </div>
      <footer>
        <p>
          {editsPrice
            ? zh
              ? "价格版本发布后不可修改；调整必须再次发布新版本。"
              : "Published price versions cannot be edited. Further changes require another version."
            : zh
              ? "修改名称不会改写历史订单中的商品快照。"
              : "Renaming does not rewrite historical order snapshots."}
        </p>
        <div>
          <button
            disabled={isPending}
            onClick={onCancel}
            type="button"
          >
            {zh ? "取消" : "Cancel"}
          </button>
          <button
            className="button-primary"
            disabled={
              isPending
              || (editor.kind !== "price" && !editor.name.trim())
              || (
                editsPrice
                && (
                  editor.amountMinor <= 0
                  || editor.entitlementUnits <= 0
                  || editor.amountMinor % editor.entitlementUnits !== 0
                )
              )
            }
            onClick={onCommit}
            type="button"
          >
            {isPending
              ? zh ? "保存中…" : "Saving…"
              : editsPrice
                ? zh ? "审核并发布" : "Review and publish"
                : zh ? "保存信息" : "Save details"}
          </button>
        </div>
      </footer>
    </section>
  );
}

function pricePayload(
  editor: Extract<ProductEditor, { kind: "create" | "price" }>,
) {
  return {
    amountMinor: editor.amountMinor,
    entitlementUnits: editor.entitlementUnits,
  };
}

function confirmPricePublication(
  editor: Extract<ProductEditor, { kind: "create" | "price" }>,
  locale: Locale,
) {
  const zh = locale === "zh";
  const productName =
    editor.kind === "create" ? editor.name.trim() : editor.productName;
  const creatorRevenueShareBps = editor.revenuePolicyCreatorShareBps;
  return window.confirm(
    zh
      ? `确认发布“${productName}”：${formatCny(editor.amountMinor, locale)} / ${formatInteger(editor.entitlementUnits, locale)} 额度，Creator ${creatorRevenueShareBps / 100}%（平台政策只读）？发布后价格版本不可修改。`
      : `Publish “${productName}” at ${formatCny(editor.amountMinor, locale)} for ${formatInteger(editor.entitlementUnits, locale)} credits with the read-only ${creatorRevenueShareBps / 100}% Creator policy? The version cannot be edited after publication.`,
  );
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as {
    error?: unknown;
  } | null;
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string"
        ? payload.error
        : "The service package request failed.",
    );
  }
  return payload as T;
}

function createBrowserRequestId() {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `billing-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown, zh: boolean) {
  return error instanceof Error
    ? error.message
    : zh
      ? "服务包请求失败，请刷新后重试。"
      : "The service package request failed. Refresh and retry.";
}

function productStatusLabel(
  status: OwnerBillingProduct["status"],
  locale: Locale,
) {
  const labels = {
    DRAFT: ["草稿", "Draft"],
    ACTIVE: ["销售中", "Active"],
    ARCHIVED: ["已归档", "Archived"],
  } as const;
  return labels[status][locale === "zh" ? 0 : 1];
}

function formatCny(amountMinor: number, locale: Locale) {
  return new Intl.NumberFormat(
    locale === "zh" ? "zh-CN" : "en-US",
    {
      style: "currency",
      currency: "CNY",
      minimumFractionDigits: 2,
    },
  ).format(amountMinor / 100);
}

function formatInteger(value: number, locale: Locale) {
  return new Intl.NumberFormat(
    locale === "zh" ? "zh-CN" : "en-US",
  ).format(value);
}
