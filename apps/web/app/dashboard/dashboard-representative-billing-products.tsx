"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  OwnerBillingCatalog,
  OwnerBillingProduct,
} from "@delegate/web-data";
import type { Locale } from "@delegate/web-ui";

import {
  editorIsValid,
  editorRequiresPackageHandoff,
  editorValidationErrors,
  type HandoffAllowance,
  type HandoffServiceLevel,
  type PriceTerms,
  type ProductEditor,
  type ProductKind,
} from "./dashboard-representative-billing-products-logic";

type CommerceSettings = OwnerBillingCatalog["representative"];

type RequestFailure = {
  message: string;
  fieldErrors: Record<string, string[]>;
};

type CommerceNotice = {
  kind: "error" | "success";
  message: string;
};

type CatalogCategory = ProductKind | "ARCHIVED";

type HandoffConfiguration = {
  prompt: string;
  reviewWindowHours: number;
  savedPrompt: string;
  savedReviewWindowHours: number;
  isPending: boolean;
  onChange: (value: { prompt: string; reviewWindowHours: number }) => void;
  onSave: () => Promise<boolean>;
};

export function DashboardRepresentativeBillingProducts({
  handoffConfiguration,
  locale,
  onCommerceSettingsSaved,
  representativeSlug,
}: {
  handoffConfiguration: HandoffConfiguration;
  locale: Locale;
  onCommerceSettingsSaved: (settings: CommerceSettings) => void;
  representativeSlug: string;
}) {
  const zh = locale === "zh";
  const [catalog, setCatalog] = useState<OwnerBillingCatalog | null>(null);
  const [settings, setSettings] = useState<CommerceSettings | null>(null);
  const [editor, setEditor] = useState<ProductEditor | null>(null);
  const [catalogCategory, setCatalogCategory] = useState<CatalogCategory>("SERVICE_PACKAGE");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<RequestFailure | null>(null);
  const [productError, setProductError] = useState<RequestFailure | null>(null);
  const [notice, setNotice] = useState<CommerceNotice | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSettingsPending, setIsSettingsPending] = useState(false);
  const [isProductPending, setIsProductPending] = useState(false);
  const catalogLoadEpoch = useRef(0);

  const loadCatalog = useCallback(async () => {
    const response = await fetch(
      `/api/dashboard/representatives/${encodeURIComponent(representativeSlug)}/billing-products`,
      { cache: "no-store" },
    );
    return readResponse<OwnerBillingCatalog>(response);
  }, [representativeSlug]);

  const refreshCatalog = useCallback(async () => {
    const requestedEpoch = ++catalogLoadEpoch.current;
    setIsLoading(true);
    setLoadError(null);
    try {
      const nextCatalog = await loadCatalog();
      if (requestedEpoch !== catalogLoadEpoch.current) return;
      setCatalog(nextCatalog);
      setSettings(nextCatalog.representative);
    } catch (error) {
      if (requestedEpoch !== catalogLoadEpoch.current) return;
      setLoadError(localizedError(error, zh));
    } finally {
      if (requestedEpoch === catalogLoadEpoch.current) {
        setIsLoading(false);
      }
    }
  }, [loadCatalog, zh]);

  useEffect(() => {
    setCatalog(null);
    setSettings(null);
    setEditor(null);
    setCatalogCategory("SERVICE_PACKAGE");
    setSettingsError(null);
    setProductError(null);
    setNotice(null);
    setIsSettingsPending(false);
    setIsProductPending(false);
    void refreshCatalog();
    return () => {
      catalogLoadEpoch.current += 1;
    };
  }, [refreshCatalog]);

  useEffect(() => {
    if (notice?.kind !== "success") return;
    const timeout = window.setTimeout(() => setNotice(null), 6_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const settingsDirty = Boolean(
    catalog
    && settings
    && commerceSettingsChanged(catalog.representative, settings),
  );
  const handoffConfigurationDirty =
    handoffConfiguration.prompt !== handoffConfiguration.savedPrompt
    || handoffConfiguration.reviewWindowHours
      !== handoffConfiguration.savedReviewWindowHours;

  const productsByCategory = useMemo(() => ({
    SERVICE_PACKAGE: sortProducts(
      catalog?.products.filter((product) => product.kind === "SERVICE_PACKAGE" && product.status !== "ARCHIVED") ?? [],
    ),
    TIP: sortProducts(
      catalog?.products.filter((product) => product.kind === "TIP" && product.status !== "ARCHIVED") ?? [],
    ),
    ARCHIVED: sortProducts(
      catalog?.products.filter((product) => product.status === "ARCHIVED") ?? [],
    ),
  }), [catalog]);

  const managedProduct = useMemo(() => {
    if (!editor || editor.mode === "create") return null;
    return catalog?.products.find((product) => product.id === editor.productId) ?? null;
  }, [catalog, editor]);

  async function saveSettings(
    nextSettings = settings,
    options: { preserveEditor?: boolean; successMessage?: string } = {},
  ) {
    if (
      !catalog
      || !nextSettings
      || !commerceSettingsChanged(catalog.representative, nextSettings)
    ) return false;
    const requestEpoch = catalogLoadEpoch.current;
    setSettingsError(null);
    setNotice(null);
    setIsSettingsPending(true);
    try {
      const response = await fetch(
        `/api/dashboard/representatives/${encodeURIComponent(representativeSlug)}/billing-products`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": createBrowserRequestId("commerce-settings"),
          },
          // Send only fields changed from this tab's baseline. A stale tab
          // must not roll back unrelated settings saved by another tab.
          body: JSON.stringify(commerceSettingsPatch(
            catalog.representative,
            nextSettings,
          )),
        },
      );
      const payload = await readResponse<{ representative: CommerceSettings }>(response);
      if (requestEpoch !== catalogLoadEpoch.current) return false;
      setCatalog((current) => current
        ? { ...current, representative: payload.representative }
        : current);
      setSettings(payload.representative);
      onCommerceSettingsSaved(payload.representative);
      if (!options.preserveEditor) setEditor(null);
      setNotice({
        kind: "success",
        message: options.successMessage ?? (zh
          ? "价格页的访问与人工接管设置已保存并实时生效。"
          : "Pricing access and handoff settings are saved and live."),
      });
      return true;
    } catch (error) {
      if (requestEpoch !== catalogLoadEpoch.current) return false;
      const failure = requestFailure(error, zh);
      setSettingsError(failure);
      setNotice({ kind: "error", message: failure.message });
      return false;
    } finally {
      if (requestEpoch === catalogLoadEpoch.current) {
        setIsSettingsPending(false);
      }
    }
  }

  async function saveAccessAndHandoffSettings() {
    const commerceWasDirty = settingsDirty;
    const handoffWasDirty = handoffConfigurationDirty;
    if (!commerceWasDirty && !handoffWasDirty) return;

    if (handoffWasDirty && !await handoffConfiguration.onSave()) {
      return;
    }
    if (commerceWasDirty) {
      await saveSettings(settings, {
        successMessage: zh
          ? "访问与人工接管设置已保存。"
          : "Access and human handoff settings are saved.",
      });
      return;
    }
    setNotice({
      kind: "success",
      message: zh
        ? "人工接管提示语与评估时窗已保存。"
        : "Human handoff copy and review window are saved.",
    });
  }

  async function enablePackageRequiredHandoff() {
    if (!catalog) return;
    const confirmed = window.confirm(zh
      ? "启用后，访客需要拥有有效的套餐人工权益才能请求人工接管。确认启用并继续配置套餐？"
      : "Visitors will need valid package handoff access before requesting a human. Enable this policy and continue?");
    if (!confirmed) return;
    setProductError(null);
    await saveSettings(
      {
        ...catalog.representative,
        humanInLoop: true,
        handoffAccessMode: "PACKAGE_REQUIRED",
      },
      {
        preserveEditor: true,
        successMessage: zh
          ? "已启用套餐人工权益，现在可以发布包含人工次数或优先级的套餐。"
          : "Package-required handoff is enabled. You can now publish paid handoff access.",
      },
    );
  }

  function openCreate(productKind: ProductKind) {
    setProductError(null);
    setNotice(null);
    setEditor({
      mode: "create",
      idempotencyKey: createBrowserRequestId("commerce-create"),
      productKind,
      name: "",
      description: "",
      sortOrder: nextSortOrder(productsByCategory[productKind]),
      isRecommended: false,
      price: defaultPriceTerms(productKind),
    });
  }

  function openMetadata(product: OwnerBillingProduct) {
    setProductError(null);
    setNotice(null);
    setEditor({
      mode: "metadata",
      idempotencyKey: createBrowserRequestId("commerce-metadata"),
      productKind: product.kind,
      productId: product.id,
      expectedRevision: product.revision,
      name: product.name,
      description: product.description ?? "",
      sortOrder: product.sortOrder,
      isRecommended: product.isRecommended,
    });
  }

  function openPrice(product: OwnerBillingProduct) {
    const price = product.activePriceVersion;
    if (!price) return;
    setProductError(null);
    setNotice(null);
    setEditor({
      mode: "price",
      idempotencyKey: createBrowserRequestId("commerce-price"),
      productKind: product.kind,
      productId: product.id,
      productName: product.name,
      expectedRevision: product.revision,
      expectedActivePriceVersionId: price.id,
      price: {
        amountMinor: price.amountMinor,
        entitlementUnits: price.entitlementUnits,
        handoffAllowance: price.handoffAllowance,
        handoffUnits: price.handoffUnits,
        handoffServiceLevel: price.handoffServiceLevel,
        handoffValidityDays: price.handoffValidityDays,
      },
    });
  }

  function closeEditor() {
    if (isProductPending) return;
    setEditor(null);
    setProductError(null);
  }

  async function commitEditor() {
    if (!editor || !editorIsValid(editor)) return;
    if (editor.mode !== "metadata" && !catalog?.revenueSharePolicy) return;
    setProductError(null);
    setNotice(null);
    if (
      editor.mode !== "metadata"
      && !confirmPricePublication(editor, locale)
    ) return;

    const requestEpoch = catalogLoadEpoch.current;
    setIsProductPending(true);
    try {
      const product = await saveEditor(editor);
      if (requestEpoch !== catalogLoadEpoch.current) return;
      mergeProduct(product);
      setEditor(null);
      setNotice({
        kind: "success",
        message: editor.mode === "metadata"
          ? zh
            ? `${product.name} 的公开信息、排序与推荐状态已更新。`
            : `${product.name} details, order, and recommendation are updated.`
          : zh
            ? `已发布 ${product.name} 的不可变价格版本 v${product.activePriceVersion?.version ?? "—"}。`
            : `Published immutable price v${product.activePriceVersion?.version ?? "—"} for ${product.name}.`,
      });
    } catch (error) {
      if (requestEpoch !== catalogLoadEpoch.current) return;
      const failure = requestFailure(error, zh);
      setProductError(failure);
      setNotice({ kind: "error", message: failure.message });
    } finally {
      if (requestEpoch === catalogLoadEpoch.current) {
        setIsProductPending(false);
      }
    }
  }

  async function saveEditor(current: ProductEditor) {
    if (current.mode === "create") {
      return mutateProduct(
        `/api/dashboard/representatives/${encodeURIComponent(representativeSlug)}/billing-products`,
        "POST",
        {
          kind: current.productKind,
          name: current.name,
          description: current.description || null,
          sortOrder: current.sortOrder,
          isRecommended: current.isRecommended,
          price: pricePayload(current.productKind, current.price),
        },
        current.idempotencyKey,
      );
    }
    if (current.mode === "metadata") {
      return mutateProduct(
        `/api/dashboard/representatives/${encodeURIComponent(representativeSlug)}/billing-products/${encodeURIComponent(current.productId)}`,
        "PATCH",
        {
          expectedRevision: current.expectedRevision,
          name: current.name,
          description: current.description || null,
          sortOrder: current.sortOrder,
          isRecommended: current.isRecommended,
        },
        current.idempotencyKey,
      );
    }
    return mutateProduct(
      `/api/dashboard/representatives/${encodeURIComponent(representativeSlug)}/billing-products/${encodeURIComponent(current.productId)}/price-versions`,
      "POST",
      {
        expectedRevision: current.expectedRevision,
        expectedActivePriceVersionId: current.expectedActivePriceVersionId,
        price: pricePayload(current.productKind, current.price),
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
    const payload = await readResponse<{ product: OwnerBillingProduct }>(response);
    return payload.product;
  }

  function mergeProduct(product: OwnerBillingProduct) {
    setCatalog((current) => {
      if (!current) return current;
      const exists = current.products.some((candidate) => candidate.id === product.id);
      return {
        ...current,
        products: exists
          ? current.products.map((candidate) => candidate.id === product.id ? product : candidate)
          : [...current.products, product],
      };
    });
  }

  function archiveProduct(product: OwnerBillingProduct) {
    if (!window.confirm(
      zh
        ? `归档“${product.name}”？归档后将停止新购买，现有订单仍会继续处理。`
        : `Archive “${product.name}”? New purchases will stop while existing orders continue processing.`,
    )) return;
    setProductError(null);
    setNotice(null);
    const requestEpoch = catalogLoadEpoch.current;
    setIsProductPending(true);
    void mutateProduct(
      `/api/dashboard/representatives/${encodeURIComponent(representativeSlug)}/billing-products/${encodeURIComponent(product.id)}/archive`,
      "POST",
      { expectedRevision: product.revision },
      // Archiving a specific immutable revision is one logical operation.
      // A deterministic key lets an ambiguous network failure replay the
      // exact request instead of turning the retry into a revision conflict.
      `commerce-archive:${product.id}:revision:${product.revision}`,
    )
      .then((archived) => {
        if (requestEpoch !== catalogLoadEpoch.current) return;
        mergeProduct(archived);
        setEditor(null);
        setNotice({
          kind: "success",
          message: zh
            ? `${archived.name} 已归档并停止新购买。`
            : `${archived.name} is archived and no longer accepts new purchases.`,
        });
      })
      .catch((error: unknown) => {
        if (requestEpoch === catalogLoadEpoch.current) {
          const failure = requestFailure(error, zh);
          setProductError(failure);
          setNotice({ kind: "error", message: failure.message });
        }
      })
      .finally(() => {
        if (requestEpoch === catalogLoadEpoch.current) {
          setIsProductPending(false);
        }
      });
  }

  const serviceCreationBlocked = Boolean(
    !catalog?.revenueSharePolicy
    || catalog?.representative.accessMode === "FREE",
  );
  const tipCreationBlocked = Boolean(
    !catalog?.revenueSharePolicy
    || !catalog?.representative.tipsEnabled,
  );

  return (
    <section
      aria-labelledby="representative-commerce-title"
      className="representative-billing-products"
    >
      <header className="representative-billing-products-header">
        <div>
          <p>PRICING / CNY</p>
          <h3 id="representative-commerce-title">
            {zh ? "价格设置" : "Pricing"}
          </h3>
          <span>
            {zh
              ? "访问策略实时生效；公开销售只读取此处的服务套餐与打赏档位。历史订单继续使用原价格快照。"
              : "Access policy applies live. Public sales read only these packages and tip options; historical orders retain their price snapshots."}
          </span>
        </div>
      </header>

      {notice ? (
        <div className="representative-config-notification-viewport representative-commerce-notification-viewport">
          <div
            className={`representative-config-notification is-${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            <span aria-hidden="true" className="representative-config-notification-mark">
              {notice.kind === "error" ? "!" : "✓"}
            </span>
            <div className="representative-config-notification-copy">
              <strong>
                {notice.kind === "error"
                  ? zh ? "设置操作失败" : "Settings request failed"
                  : zh ? "设置已更新" : "Settings updated"}
              </strong>
              <p>{notice.message}</p>
            </div>
            <button
              aria-label={zh ? "关闭价格通知" : "Dismiss pricing notification"}
              className="representative-config-notification-close"
              onClick={() => setNotice(null)}
              type="button"
            >
              ×
            </button>
          </div>
        </div>
      ) : null}

      {isLoading ? (
        <div className="representative-billing-empty" role="status">
          {zh ? "正在读取价格配置…" : "Loading pricing configuration…"}
        </div>
      ) : null}
      {loadError ? (
        <Feedback kind="error" message={loadError}>
          <button disabled={isLoading} onClick={() => void refreshCatalog()} type="button">
            {zh ? "刷新" : "Refresh"}
          </button>
        </Feedback>
      ) : null}

      {catalog && settings ? (
        <CommerceSettingsPanel
          error={settingsError}
          handoffConfiguration={handoffConfiguration}
          isDirty={settingsDirty || handoffConfigurationDirty}
          isPending={
            isSettingsPending
            || isProductPending
            || handoffConfiguration.isPending
          }
          locale={locale}
          onChange={(next) => {
            setSettings(next);
            setSettingsError(null);
            setNotice(null);
          }}
          onDiscard={() => {
            setSettings(catalog.representative);
            handoffConfiguration.onChange({
              prompt: handoffConfiguration.savedPrompt,
              reviewWindowHours: handoffConfiguration.savedReviewWindowHours,
            });
            setSettingsError(null);
            setNotice(null);
          }}
          onSave={() => void saveAccessAndHandoffSettings()}
          settings={settings}
        />
      ) : null}

      {catalog && !catalog.revenueSharePolicy ? (
        <Feedback
          kind="error"
          message={zh
            ? "当前代表缺少有效的 CNY 平台分成政策，暂不能发布价格。"
            : "This representative has no valid CNY revenue-share policy, so price publication is disabled."}
        />
      ) : null}

      {catalog ? (
        <section aria-labelledby="representative-commerce-catalog-title" className="representative-commerce-catalog">
          <header>
            <div>
              <p>PRICING CATALOG / CNY</p>
              <h4 id="representative-commerce-catalog-title">
                {zh ? "服务套餐与价格版本" : "Packages and price versions"}
              </h4>
            </div>
            <span>
              {zh
                ? "金额与额度比例可自由配置；新价格仅影响之后创建的订单。"
                : "Set any price-to-credit ratio. New prices affect only future orders."}
            </span>
          </header>

          <CatalogCategoryTabs
            activeCategory={catalogCategory}
            counts={{
              SERVICE_PACKAGE: productsByCategory.SERVICE_PACKAGE.length,
              TIP: productsByCategory.TIP.length,
              ARCHIVED: productsByCategory.ARCHIVED.length,
            }}
            locale={locale}
            onChange={setCatalogCategory}
          />

          <ProductGroup
            createBlocked={catalogCategory === "ARCHIVED"
              ? false
              : catalogCategory === "SERVICE_PACKAGE"
                ? serviceCreationBlocked
                : tipCreationBlocked}
            emptyCopy={catalogCategory === "ARCHIVED"
              ? (zh ? "还没有已归档商品。" : "No archived products.")
              : catalogCategory === "TIP"
                ? (zh ? "还没有打赏档位。" : "No tip options yet.")
                : (zh ? "还没有服务套餐。" : "No service packages yet.")}
            hint={catalogCategory === "ARCHIVED"
              ? (zh ? "归档商品不再接受新购买，仅保留历史价格与订单审计。" : "Archived products no longer accept purchases and remain visible for price and order history.")
              : catalogCategory === "TIP"
                ? !catalog.representative.tipsEnabled
                  ? (zh ? "先在上方启用打赏，才能创建或发布打赏档位。" : "Enable tips above before creating or publishing tip options.")
                  : (zh ? "打赏不赠送服务额度或人工权益，支付后不可退款。" : "Tips grant no credits or handoff access and are non-refundable.")
                : catalog.representative.accessMode === "FREE"
                  ? (zh ? "免费模式不能创建或发布服务套餐；先保存其他 AI 访问模式。" : "Free access cannot publish service packages. Save another AI access mode first.")
                  : (zh ? "服务额度可叠加人工接管次数、优先级与有效期。" : "Credits can include handoff uses, priority, and a validity window.")}
            isPending={
              isProductPending
              || isSettingsPending
              || settingsDirty
              || handoffConfigurationDirty
            }
            locale={locale}
            onArchive={archiveProduct}
            onCreate={catalogCategory === "ARCHIVED" ? undefined : () => openCreate(catalogCategory)}
            onManage={openMetadata}
            products={productsByCategory[catalogCategory]}
            productKind={catalogCategory}
            title={catalogCategory === "ARCHIVED"
              ? (zh ? "已归档" : "Archived")
              : catalogCategory === "TIP"
                ? (zh ? "打赏档位" : "Tip options")
                : (zh ? "服务套餐" : "Service packages")}
          />
        </section>
      ) : null}

      {editor && catalog ? (
        <BillingProductEditorModal
          editor={editor}
          fieldErrors={productError?.fieldErrors ?? {}}
          isPending={
            isProductPending
            || isSettingsPending
            || handoffConfiguration.isPending
          }
          locale={locale}
          managedProduct={managedProduct}
          handoffPolicyBlocked={editorRequiresPackageHandoff(editor)
            && (
              !catalog.representative.humanInLoop
              || catalog.representative.handoffAccessMode !== "PACKAGE_REQUIRED"
            )}
          onCancel={closeEditor}
          onChange={(next) => {
            setEditor({
              ...next,
              idempotencyKey: createBrowserRequestId("commerce-edit"),
            });
            setProductError(null);
            setNotice(null);
          }}
          onCommit={() => void commitEditor()}
          onEnablePackageHandoff={() => void enablePackageRequiredHandoff()}
          onSelectDetails={() => {
            if (managedProduct && confirmEditorModeSwitch(editor, managedProduct, locale)) {
              openMetadata(managedProduct);
            }
          }}
          onSelectPrice={() => {
            if (managedProduct && confirmEditorModeSwitch(editor, managedProduct, locale)) {
              openPrice(managedProduct);
            }
          }}
          publishingBlocked={managedProduct?.kind === "TIP"
            ? !catalog.representative.tipsEnabled || !catalog.revenueSharePolicy
            : catalog.representative.accessMode === "FREE" || !catalog.revenueSharePolicy}
          revenuePolicy={catalog.revenueSharePolicy}
        />
      ) : null}
    </section>
  );
}

function CommerceSettingsPanel({
  error,
  handoffConfiguration,
  isDirty,
  isPending,
  locale,
  onChange,
  onDiscard,
  onSave,
  settings,
}: {
  error: RequestFailure | null;
  handoffConfiguration: HandoffConfiguration;
  isDirty: boolean;
  isPending: boolean;
  locale: Locale;
  onChange: (settings: CommerceSettings) => void;
  onDiscard: () => void;
  onSave: () => void;
  settings: CommerceSettings;
}) {
  const zh = locale === "zh";
  const errors = {
    accessMode: fieldError(error, "accessMode"),
    freeReplyLimit: fieldError(error, "freeReplyLimit"),
    handoffAccessMode: fieldError(error, "handoffAccessMode"),
    humanInLoop: fieldError(error, "humanInLoop"),
    tipsEnabled: fieldError(error, "tipsEnabled"),
  };
  return (
    <section aria-labelledby="representative-commerce-settings-title" className="representative-commerce-settings">
      <header>
        <div>
          <p>LIVE ACCESS POLICY</p>
          <h4 id="representative-commerce-settings-title">
            {zh ? "访问与人工服务" : "Access and human service"}
          </h4>
        </div>
        <span className={`representative-billing-status ${isDirty ? "is-dirty" : ""}`}>
          {isDirty ? (zh ? "未保存" : "Unsaved") : (zh ? "已同步" : "Synced")}
        </span>
      </header>

      <div className="representative-commerce-settings-grid">
        <label className="representative-commerce-field">
          <span>{zh ? "AI 访问模式" : "AI access mode"}</span>
          <select
            aria-describedby={errors.accessMode ? fieldErrorId("settings-access-mode") : undefined}
            aria-invalid={Boolean(errors.accessMode)}
            disabled={isPending}
            onChange={(event) => onChange({
              ...settings,
              accessMode: event.target.value as CommerceSettings["accessMode"],
            })}
            value={settings.accessMode}
          >
            <option value="FREE">{zh ? "永久免费" : "Free"}</option>
            <option value="TRIAL_THEN_CREDITS">{zh ? "免费试用后扣额度" : "Trial, then credits"}</option>
            <option value="CREDITS_ONLY">{zh ? "仅服务额度" : "Credits only"}</option>
          </select>
          <small>
            {settings.accessMode === "FREE"
              ? zh
                ? "所有回复免费；不能创建或发布服务套餐。"
                : "All replies are free; service packages cannot be published."
              : settings.accessMode === "CREDITS_ONLY"
                ? zh
                  ? "首次回复起即消耗服务额度。"
                  : "Service credits are required from the first reply."
                : zh
                  ? "先使用免费回复，之后消耗服务额度。"
                  : "Free replies are used first, then service credits."}
          </small>
          <FieldError id={fieldErrorId("settings-access-mode")} message={errors.accessMode} />
        </label>

        {settings.accessMode === "TRIAL_THEN_CREDITS" ? (
          <label className="representative-commerce-field">
            <span>{zh ? "免费回复次数" : "Free reply limit"}</span>
            <input
              aria-describedby={errors.freeReplyLimit ? fieldErrorId("settings-free-reply-limit") : undefined}
              aria-invalid={Boolean(errors.freeReplyLimit)}
              disabled={isPending}
              max={1_000_000}
              min={0}
              onChange={(event) => onChange({
                ...settings,
                freeReplyLimit: Number(event.target.value || 0),
              })}
              type="number"
              value={settings.freeReplyLimit}
            />
            <small>{zh ? "仅试用模式可配置；0 表示不提供免费回复。" : "Available only in trial mode; 0 means no free replies."}</small>
            <FieldError id={fieldErrorId("settings-free-reply-limit")} message={errors.freeReplyLimit} />
          </label>
        ) : null}

        <fieldset className="representative-commerce-field representative-commerce-handoff">
          <legend>{zh ? "人工接管" : "Human handoff"}</legend>
          <label className="representative-commerce-toggle">
            <input
              aria-describedby={errors.humanInLoop ? fieldErrorId("settings-human-in-loop") : undefined}
              aria-invalid={Boolean(errors.humanInLoop)}
              checked={settings.humanInLoop}
              disabled={isPending}
              onChange={(event) => onChange({ ...settings, humanInLoop: event.target.checked })}
              type="checkbox"
            />
            <span>{settings.humanInLoop ? (zh ? "已启用" : "Enabled") : (zh ? "未启用" : "Disabled")}</span>
          </label>
          <FieldError id={fieldErrorId("settings-human-in-loop")} message={errors.humanInLoop} />
          <select
            aria-describedby={errors.handoffAccessMode ? fieldErrorId("settings-handoff-access-mode") : undefined}
            aria-invalid={Boolean(errors.handoffAccessMode)}
            aria-label={zh ? "人工接管访问方式" : "Handoff access mode"}
            disabled={isPending || !settings.humanInLoop}
            onChange={(event) => onChange({
              ...settings,
              handoffAccessMode: event.target.value as CommerceSettings["handoffAccessMode"],
            })}
            value={settings.handoffAccessMode}
          >
            <option value="FREE">{zh ? "所有访客可请求" : "Free for all visitors"}</option>
            <option value="PACKAGE_REQUIRED">{zh ? "需要套餐权益" : "Package required"}</option>
          </select>
          <small>{zh ? "套餐权益的次数与优先级在每个服务套餐中配置。" : "Configure handoff uses and priority on each service package."}</small>
          <FieldError id={fieldErrorId("settings-handoff-access-mode")} message={errors.handoffAccessMode} />

          <label className="representative-commerce-handoff-copy">
            <span>{zh ? "人工接手提示语" : "Handoff prompt"}</span>
            <textarea
              disabled={isPending}
              onChange={(event) => handoffConfiguration.onChange({
                prompt: event.target.value,
                reviewWindowHours: handoffConfiguration.reviewWindowHours,
              })}
              rows={3}
              value={handoffConfiguration.prompt}
            />
            <small>
              {zh
                ? "只说明如何提交和预期处理方式；联系人、预算和时间由真人接手后再确认。"
                : "Explain submission and next steps; contact, budget, and timing are confirmed after takeover."}
            </small>
          </label>

          <label className="representative-commerce-handoff-window">
            <span>{zh ? "人工评估时窗（小时）" : "Human review window (hours)"}</span>
            <input
              disabled={isPending}
              min={1}
              onChange={(event) => handoffConfiguration.onChange({
                prompt: handoffConfiguration.prompt,
                reviewWindowHours: Number(event.target.value || 0),
              })}
              type="number"
              value={handoffConfiguration.reviewWindowHours}
            />
          </label>
        </fieldset>

        <fieldset className="representative-commerce-field">
          <legend>{zh ? "打赏" : "Tips"}</legend>
          <label className="representative-commerce-toggle">
            <input
              aria-describedby={errors.tipsEnabled ? fieldErrorId("settings-tips-enabled") : undefined}
              aria-invalid={Boolean(errors.tipsEnabled)}
              checked={settings.tipsEnabled}
              disabled={isPending}
              onChange={(event) => onChange({ ...settings, tipsEnabled: event.target.checked })}
              type="checkbox"
            />
            <span>{settings.tipsEnabled ? (zh ? "允许访客打赏" : "Visitors can tip") : (zh ? "关闭打赏" : "Tips disabled")}</span>
          </label>
          <small>{zh ? "关闭前必须先归档全部销售中的打赏档位。" : "Archive all active tip options before disabling tips."}</small>
          <FieldError id={fieldErrorId("settings-tips-enabled")} message={errors.tipsEnabled} />
        </fieldset>
      </div>

      <footer>
        <span>
          {zh
            ? "访问策略保存后立即生效；提示语和评估时窗保存到代表草稿，发布后生效。"
            : "Access policy applies immediately; handoff copy and the review window save to the representative draft and apply after publishing."}
        </span>
        <div>
          <button disabled={isPending || !isDirty} onClick={onDiscard} type="button">
            {zh ? "放弃更改" : "Discard"}
          </button>
          <button className="button-primary" disabled={isPending || !isDirty} onClick={onSave} type="button">
            {isPending ? (zh ? "保存中…" : "Saving…") : (zh ? "保存访问与人工设置" : "Save access and handoff")}
          </button>
        </div>
      </footer>
    </section>
  );
}

function CatalogCategoryTabs({
  activeCategory,
  counts,
  locale,
  onChange,
}: {
  activeCategory: CatalogCategory;
  counts: Record<CatalogCategory, number>;
  locale: Locale;
  onChange: (category: CatalogCategory) => void;
}) {
  const zh = locale === "zh";
  const categories: Array<{ id: CatalogCategory; label: string }> = [
    { id: "SERVICE_PACKAGE", label: zh ? "服务套餐" : "Service packages" },
    { id: "TIP", label: zh ? "打赏档位" : "Tip options" },
    { id: "ARCHIVED", label: zh ? "已归档" : "Archived" },
  ];
  return (
    <nav aria-label={zh ? "价格商品分类" : "Pricing product categories"} className="representative-commerce-category-tabs">
      {categories.map((category) => (
        <button
          aria-pressed={activeCategory === category.id}
          className={activeCategory === category.id ? "is-active" : undefined}
          key={category.id}
          onClick={() => onChange(category.id)}
          type="button"
        >
          <span>{category.label}</span>
          <strong>{counts[category.id]}</strong>
        </button>
      ))}
    </nav>
  );
}

function ProductGroup({
  createBlocked,
  emptyCopy,
  hint,
  isPending,
  locale,
  onArchive,
  onCreate,
  onManage,
  products,
  productKind,
  title,
}: {
  createBlocked: boolean;
  emptyCopy: string;
  hint: string;
  isPending: boolean;
  locale: Locale;
  onArchive: (product: OwnerBillingProduct) => void;
  onCreate: (() => void) | undefined;
  onManage: (product: OwnerBillingProduct) => void;
  products: OwnerBillingProduct[];
  productKind: CatalogCategory;
  title: string;
}) {
  const zh = locale === "zh";
  return (
    <section className="representative-commerce-product-group">
      <header>
        <div>
          <h5>{title}</h5>
          <span>{hint}</span>
        </div>
        {onCreate ? (
          <button className="button-primary" disabled={isPending || createBlocked} onClick={onCreate} type="button">
            {productKind === "TIP"
              ? zh ? "新建打赏档位" : "New tip option"
              : zh ? "新建服务套餐" : "New service package"}
          </button>
        ) : null}
      </header>
      {!products.length ? (
        <div className="representative-billing-empty">{emptyCopy}</div>
      ) : (
        <div className="representative-billing-product-list">
          {products.map((product) => (
            <BillingProductCard
              isPending={isPending}
              key={product.id}
              locale={locale}
              onArchive={() => onArchive(product)}
              onManage={() => onManage(product)}
              product={product}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function BillingProductCard({
  isPending,
  locale,
  onArchive,
  onManage,
  product,
}: {
  isPending: boolean;
  locale: Locale;
  onArchive: () => void;
  onManage: () => void;
  product: OwnerBillingProduct;
}) {
  const zh = locale === "zh";
  const price = product.activePriceVersion ?? product.priceVersions[0] ?? null;
  return (
    <article className={`representative-billing-product-card is-${product.status.toLowerCase()}`}>
      <header>
        <div>
          <span className={`representative-billing-status is-${product.status.toLowerCase()}`}>
            {productStatusLabel(product.status, locale)}
          </span>
          <span className="representative-billing-kind">
            {product.kind === "TIP" ? (zh ? "打赏" : "Tip") : (zh ? "服务套餐" : "Package")}
          </span>
          {product.isRecommended ? <span className="representative-billing-status is-recommended">{zh ? "推荐" : "Recommended"}</span> : null}
          <code>{product.code}</code>
        </div>
        <strong>{product.name}</strong>
        <p>{product.description ?? (zh ? "未填写公开说明。" : "No public description.")}</p>
      </header>
      {price ? (
        <dl className="representative-billing-facts">
          <Fact
            label={product.activePriceVersion
              ? (zh ? "当前价格" : "Current price")
              : (zh ? "最后价格" : "Last price")}
            value={formatCny(price.amountMinor, locale)}
          />
          {product.kind === "SERVICE_PACKAGE" ? (
            <>
              <Fact label={zh ? "服务额度" : "Credits"} value={formatInteger(price.entitlementUnits, locale)} />
              <Fact label={zh ? "人工接管" : "Handoff"} value={formatHandoff(price, locale)} />
              <Fact label={zh ? "权益有效期" : "Handoff validity"} value={price.handoffValidityDays ? `${price.handoffValidityDays}${zh ? " 天" : " days"}` : (zh ? "不适用" : "N/A")} />
            </>
          ) : (
            <Fact label={zh ? "购买权益" : "Entitlement"} value={zh ? "纯打赏" : "Tip only"} />
          )}
          <Fact label={zh ? "排序" : "Order"} value={`${product.sortOrder}`} />
          <Fact label={zh ? "价格版本" : "Price version"} value={`v${price.version}`} />
        </dl>
      ) : (
        <p className="representative-billing-no-price">{zh ? "没有活动价格，当前不可购买。" : "No active price; this product cannot be purchased."}</p>
      )}
      <footer>
        <span>
          {product.kind === "TIP"
            ? zh ? "打赏不赠送额度或人工权益 · 支付后不可退款" : "No credits or handoff access · non-refundable"
            : zh ? "服务额度永久有效 · 完全未使用时可全额退款" : "Credits never expire · full refund only when wholly unused"}
        </span>
        <div>
          {product.status !== "ARCHIVED" ? (
            <button
              className="button-primary"
              disabled={isPending}
              onClick={onManage}
              type="button"
            >
              {product.kind === "TIP"
                ? (zh ? "管理打赏档位" : "Manage tip option")
                : (zh ? "管理服务套餐" : "Manage service package")}
            </button>
          ) : null}
          {product.status !== "ARCHIVED" ? (
            <button className="is-danger" disabled={isPending} onClick={onArchive} type="button">{zh ? "归档" : "Archive"}</button>
          ) : (
            <span className="representative-billing-archived-note">{zh ? "历史记录只读" : "Read-only history"}</span>
          )}
        </div>
      </footer>
    </article>
  );
}

function BillingProductEditorModal({
  editor,
  fieldErrors,
  handoffPolicyBlocked,
  isPending,
  locale,
  managedProduct,
  onCancel,
  onChange,
  onCommit,
  onEnablePackageHandoff,
  onSelectDetails,
  onSelectPrice,
  publishingBlocked,
  revenuePolicy,
}: {
  editor: ProductEditor;
  fieldErrors: Record<string, string[]>;
  handoffPolicyBlocked: boolean;
  isPending: boolean;
  locale: Locale;
  managedProduct: OwnerBillingProduct | null;
  onCancel: () => void;
  onChange: (value: ProductEditor) => void;
  onCommit: () => void;
  onEnablePackageHandoff: () => void;
  onSelectDetails: () => void;
  onSelectPrice: () => void;
  publishingBlocked: boolean;
  revenuePolicy: OwnerBillingCatalog["revenueSharePolicy"];
}) {
  const zh = locale === "zh";
  const dialogRef = useRef<HTMLDivElement>(null);
  const isPendingRef = useRef(isPending);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    isPendingRef.current = isPending;
    onCancelRef.current = onCancel;
  }, [isPending, onCancel]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !isPendingRef.current) {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  return (
    <div
      className="representative-billing-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isPending) onCancel();
      }}
    >
      <div
        aria-labelledby="representative-billing-editor-title"
        aria-modal="true"
        className="representative-billing-modal"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        {managedProduct ? (
          <nav
            aria-label={managedProduct.kind === "TIP"
              ? (zh ? "打赏档位管理" : "Tip option management")
              : (zh ? "服务套餐管理" : "Service package management")}
            className="representative-billing-modal-tabs"
          >
            <button
              aria-pressed={editor.mode === "metadata"}
              className={editor.mode === "metadata" ? "is-active" : undefined}
              disabled={isPending}
              onClick={onSelectDetails}
              type="button"
            >
              {zh ? "套餐信息" : "Package details"}
            </button>
            <button
              aria-pressed={editor.mode === "price"}
              className={editor.mode === "price" ? "is-active" : undefined}
              disabled={isPending || publishingBlocked || !managedProduct.activePriceVersion}
              onClick={onSelectPrice}
              type="button"
            >
              {zh ? "发布新价格" : "Publish new price"}
            </button>
          </nav>
        ) : null}
        <BillingProductEditor
          editor={editor}
          fieldErrors={fieldErrors}
          handoffPolicyBlocked={handoffPolicyBlocked}
          isPending={isPending}
          locale={locale}
          onCancel={onCancel}
          onChange={onChange}
          onCommit={onCommit}
          onEnablePackageHandoff={onEnablePackageHandoff}
          revenuePolicy={revenuePolicy}
        />
      </div>
    </div>
  );
}

function BillingProductEditor({
  editor,
  fieldErrors,
  handoffPolicyBlocked,
  isPending,
  locale,
  onCancel,
  onChange,
  onCommit,
  onEnablePackageHandoff,
  revenuePolicy,
}: {
  editor: ProductEditor;
  fieldErrors: Record<string, string[]>;
  handoffPolicyBlocked: boolean;
  isPending: boolean;
  locale: Locale;
  onCancel: () => void;
  onChange: (value: ProductEditor) => void;
  onCommit: () => void;
  onEnablePackageHandoff: () => void;
  revenuePolicy: OwnerBillingCatalog["revenueSharePolicy"];
}) {
  const zh = locale === "zh";
  const editsPrice = editor.mode !== "metadata";
  const localFieldErrors = editorValidationErrors(editor, locale);
  if (editor.mode === "create" && editor.name === "") {
    delete localFieldErrors.name;
  }
  const displayedFieldErrors = {
    ...localFieldErrors,
    ...fieldErrors,
  };
  const nameError = firstError(displayedFieldErrors, "name");
  const sortOrderError = firstError(displayedFieldErrors, "sortOrder");
  const descriptionError = firstError(displayedFieldErrors, "description");
  return (
    <section aria-labelledby="representative-billing-editor-title" className="representative-billing-editor">
      <header>
        <div>
          <p>
            {editor.productKind === "TIP" ? "TIP OPTION" : "SERVICE PACKAGE"}
            {editor.mode === "create" ? " / NEW" : editor.mode === "metadata" ? " / DETAILS" : " / NEW PRICE"}
          </p>
          <h4 id="representative-billing-editor-title">
            {editor.mode === "price"
              ? editor.productName
              : editor.name.trim() || (editor.productKind === "TIP"
                ? (zh ? "新建打赏档位" : "New tip option")
                : (zh ? "新建服务套餐" : "New service package"))}
          </h4>
        </div>
        <button aria-label={zh ? "关闭编辑器" : "Close editor"} disabled={isPending} onClick={onCancel} type="button">×</button>
      </header>

      <fieldset
        aria-busy={isPending}
        className="representative-billing-editor-grid"
        disabled={isPending}
      >
        {editor.mode !== "price" ? (
          <>
            <label>
              <span>{zh ? "名称" : "Name"}</span>
              <input aria-describedby={nameError ? fieldErrorId("product-name") : undefined} aria-invalid={Boolean(nameError)} maxLength={80} onChange={(event) => onChange({ ...editor, name: event.target.value })} value={editor.name} />
              <FieldError id={fieldErrorId("product-name")} message={nameError} />
            </label>
            <label>
              <span>{zh ? "排序（小值优先）" : "Order (lower first)"}</span>
              <input aria-describedby={sortOrderError ? fieldErrorId("product-sort-order") : undefined} aria-invalid={Boolean(sortOrderError)} max={1_000_000} min={0} onChange={(event) => onChange({ ...editor, sortOrder: Number(event.target.value || 0) })} type="number" value={editor.sortOrder} />
              <FieldError id={fieldErrorId("product-sort-order")} message={sortOrderError} />
            </label>
            <label className="representative-commerce-toggle is-editor-toggle">
              <input checked={editor.isRecommended} onChange={(event) => onChange({ ...editor, isRecommended: event.target.checked })} type="checkbox" />
              <span>{zh ? "标记为推荐" : "Mark as recommended"}</span>
            </label>
            <label className="is-wide">
              <span>{zh ? "公开说明" : "Public description"}</span>
              <textarea aria-describedby={descriptionError ? fieldErrorId("product-description") : undefined} aria-invalid={Boolean(descriptionError)} maxLength={500} onChange={(event) => onChange({ ...editor, description: event.target.value })} rows={3} value={editor.description} />
              <FieldError id={fieldErrorId("product-description")} message={descriptionError} />
            </label>
          </>
        ) : null}

        {editsPrice ? (
          <PriceFields editor={editor} fieldErrors={displayedFieldErrors} locale={locale} onChange={onChange} revenuePolicy={revenuePolicy} />
        ) : null}
      </fieldset>

      {handoffPolicyBlocked ? (
        <div className="representative-billing-policy-blocker" role="alert">
          <div>
            <strong>{zh ? "先启用套餐人工权益" : "Enable package-required handoff first"}</strong>
            <span>
              {zh
                ? "当前人工接管仍面向所有访客免费开放，不能同时销售限次、不限次或优先人工服务。启用后，只有持有有效套餐权益的访客才能请求人工。"
                : "Human handoff is currently free for every visitor, so limited, unlimited, or priority handoff cannot be sold. After enabling this policy, visitors need valid package access to request a human."}
            </span>
          </div>
          <button disabled={isPending} onClick={onEnablePackageHandoff} type="button">
            {isPending
              ? (zh ? "启用中…" : "Enabling…")
              : (zh ? "启用套餐人工权益" : "Enable package handoff")}
          </button>
        </div>
      ) : null}

      <footer>
        <p>
          {editsPrice
            ? editor.productKind === "TIP"
              ? zh ? "打赏不赠送服务额度或人工权益，且支付后不可退款；价格版本发布后不可修改。" : "Tips grant no credits or handoff access, are non-refundable, and published prices cannot be edited."
              : zh ? "价格版本发布后不可修改；金额、额度或人工权益调整必须发布新版本。" : "Published prices cannot be edited. Publish another version to change price, credits, or handoff terms."
            : zh ? "信息、排序和推荐状态不会改写历史订单快照。" : "Details, order, and recommendation do not rewrite historical order snapshots."}
        </p>
        <div>
          <button disabled={isPending} onClick={onCancel} type="button">{zh ? "取消" : "Cancel"}</button>
          <button className="button-primary" disabled={isPending || handoffPolicyBlocked || !editorIsValid(editor)} onClick={onCommit} type="button">
            {isPending ? (zh ? "保存中…" : "Saving…") : editsPrice ? (zh ? "审核并发布" : "Review and publish") : (zh ? "保存信息" : "Save details")}
          </button>
        </div>
      </footer>
    </section>
  );
}

function PriceFields({
  editor,
  fieldErrors,
  locale,
  onChange,
  revenuePolicy,
}: {
  editor: Extract<ProductEditor, { mode: "create" | "price" }>;
  fieldErrors: Record<string, string[]>;
  locale: Locale;
  onChange: (value: ProductEditor) => void;
  revenuePolicy: OwnerBillingCatalog["revenueSharePolicy"];
}) {
  const zh = locale === "zh";
  const price = editor.price;
  const changePrice = (next: Partial<PriceTerms>) => onChange({ ...editor, price: { ...price, ...next } });
  const errors = {
    amountMinor: firstError(fieldErrors, "amountMinor"),
    entitlementUnits: firstError(fieldErrors, "entitlementUnits"),
    handoffAllowance: firstError(fieldErrors, "handoffAllowance"),
    handoffUnits: firstError(fieldErrors, "handoffUnits"),
    handoffServiceLevel: firstError(fieldErrors, "handoffServiceLevel"),
    handoffValidityDays: firstError(fieldErrors, "handoffValidityDays"),
  };
  return (
    <>
      <label>
        <span>{zh ? "价格（元）" : "Price (CNY)"}</span>
        <input aria-describedby={errors.amountMinor ? fieldErrorId("product-amount-minor") : undefined} aria-invalid={Boolean(errors.amountMinor)} inputMode="decimal" max={10_000} min={0.01} onChange={(event) => changePrice({ amountMinor: yuanToMinor(event.target.value) })} step="0.01" type="number" value={price.amountMinor / 100} />
        <FieldError id={fieldErrorId("product-amount-minor")} message={errors.amountMinor} />
      </label>

      {editor.productKind === "SERVICE_PACKAGE" ? (
        <>
          <label>
            <span>{zh ? "包含服务额度" : "Included credits"}</span>
            <input aria-describedby={errors.entitlementUnits ? fieldErrorId("product-entitlement-units") : undefined} aria-invalid={Boolean(errors.entitlementUnits)} max={10_000_000} min={1} onChange={(event) => changePrice({ entitlementUnits: Number(event.target.value || 0) })} type="number" value={price.entitlementUnits} />
            <small>{zh ? "金额与额度可使用任意正整数比例。" : "Any positive price-to-credit ratio is allowed."}</small>
            <FieldError id={fieldErrorId("product-entitlement-units")} message={errors.entitlementUnits} />
          </label>
          <label>
            <span>{zh ? "人工接管权益" : "Handoff allowance"}</span>
            <select
              aria-describedby={errors.handoffAllowance ? fieldErrorId("product-handoff-allowance") : undefined}
              aria-invalid={Boolean(errors.handoffAllowance)}
              onChange={(event) => {
                const allowance = event.target.value as HandoffAllowance;
                changePrice(allowance === "NONE"
                  ? { handoffAllowance: allowance, handoffUnits: null, handoffServiceLevel: null, handoffValidityDays: null }
                  : { handoffAllowance: allowance, handoffUnits: allowance === "LIMITED" ? (price.handoffUnits ?? 1) : null, handoffServiceLevel: price.handoffServiceLevel ?? "STANDARD", handoffValidityDays: price.handoffValidityDays ?? 30 });
              }}
              value={price.handoffAllowance}
            >
              <option value="NONE">{zh ? "不包含" : "None"}</option>
              <option value="LIMITED">{zh ? "限次" : "Limited"}</option>
              <option value="UNLIMITED">{zh ? "不限次" : "Unlimited"}</option>
            </select>
            <FieldError id={fieldErrorId("product-handoff-allowance")} message={errors.handoffAllowance} />
          </label>
          {price.handoffAllowance === "LIMITED" ? (
            <label>
              <span>{zh ? "人工接管次数" : "Handoff uses"}</span>
              <input aria-describedby={errors.handoffUnits ? fieldErrorId("product-handoff-units") : undefined} aria-invalid={Boolean(errors.handoffUnits)} max={1_000_000} min={1} onChange={(event) => changePrice({ handoffUnits: Number(event.target.value || 0) })} type="number" value={price.handoffUnits ?? 1} />
              <FieldError id={fieldErrorId("product-handoff-units")} message={errors.handoffUnits} />
            </label>
          ) : null}
          {price.handoffAllowance !== "NONE" ? (
            <>
              <label>
                <span>{zh ? "人工服务级别" : "Handoff service level"}</span>
                <select aria-describedby={errors.handoffServiceLevel ? fieldErrorId("product-handoff-service-level") : undefined} aria-invalid={Boolean(errors.handoffServiceLevel)} onChange={(event) => changePrice({ handoffServiceLevel: event.target.value as HandoffServiceLevel })} value={price.handoffServiceLevel ?? "STANDARD"}>
                  <option value="STANDARD">{zh ? "标准" : "Standard"}</option>
                  <option value="PRIORITY">{zh ? "优先" : "Priority"}</option>
                </select>
                <FieldError id={fieldErrorId("product-handoff-service-level")} message={errors.handoffServiceLevel} />
              </label>
              <label>
                <span>{zh ? "人工权益有效期（天）" : "Handoff validity (days)"}</span>
                <input aria-describedby={errors.handoffValidityDays ? fieldErrorId("product-handoff-validity-days") : undefined} aria-invalid={Boolean(errors.handoffValidityDays)} max={3_650} min={1} onChange={(event) => changePrice({ handoffValidityDays: Number(event.target.value || 0) })} type="number" value={price.handoffValidityDays ?? 30} />
                <FieldError id={fieldErrorId("product-handoff-validity-days")} message={errors.handoffValidityDays} />
              </label>
            </>
          ) : null}
        </>
      ) : (
        <div className="representative-billing-editor-callout">
          <strong>{zh ? "纯打赏" : "Tip only"}</strong>
          <span>{zh ? "服务额度 0 · 人工接管 0 · 不可退款" : "0 credits · 0 handoff access · non-refundable"}</span>
        </div>
      )}

      <div className="representative-billing-editor-summary">
        <span>{zh ? "将发布" : "Will publish"}</span>
        <strong>{formatCny(price.amountMinor, locale)}{editor.productKind === "SERVICE_PACKAGE" ? ` · ${formatInteger(price.entitlementUnits, locale)} ${zh ? "额度" : "credits"}` : ""}</strong>
        <small>Creator {revenuePolicy ? revenuePolicy.creatorRevenueShareBps / 100 : "—"}% · Platform {revenuePolicy ? revenuePolicy.platformRevenueShareBps / 100 : "—"}% · {zh ? "平台政策只读" : "read-only platform policy"}</small>
      </div>
    </>
  );
}

function Feedback({ children, kind, message }: { children?: ReactNode; kind: "error" | "success"; message: string }) {
  return (
    <div className={`representative-billing-feedback is-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span>{message}</span>
      {children}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return message ? <small className="representative-billing-field-error" id={id}>{message}</small> : null;
}

function fieldErrorId(field: string) {
  return `representative-commerce-${field}-error`;
}

function defaultPriceTerms(kind: ProductKind): PriceTerms {
  return {
    amountMinor: kind === "TIP" ? 100 : 1_000,
    entitlementUnits: kind === "TIP" ? 0 : 100_000,
    handoffAllowance: "NONE",
    handoffUnits: null,
    handoffServiceLevel: null,
    handoffValidityDays: null,
  };
}

function pricePayload(kind: ProductKind, price: PriceTerms) {
  if (kind === "TIP") return { amountMinor: price.amountMinor };
  if (price.handoffAllowance === "NONE") {
    return {
      amountMinor: price.amountMinor,
      entitlementUnits: price.entitlementUnits,
      handoffAllowance: "NONE" as const,
    };
  }
  return {
    amountMinor: price.amountMinor,
    entitlementUnits: price.entitlementUnits,
    handoffAllowance: price.handoffAllowance,
    ...(price.handoffAllowance === "LIMITED" ? { handoffUnits: price.handoffUnits } : {}),
    handoffServiceLevel: price.handoffServiceLevel,
    handoffValidityDays: price.handoffValidityDays,
  };
}

function confirmPricePublication(editor: Extract<ProductEditor, { mode: "create" | "price" }>, locale: Locale) {
  const zh = locale === "zh";
  const name = editor.mode === "create" ? editor.name.trim() : editor.productName;
  const terms = editor.productKind === "TIP"
    ? (zh ? "纯打赏、不可退款" : "tip only, non-refundable")
    : `${formatInteger(editor.price.entitlementUnits, locale)} ${zh ? "额度" : "credits"} · ${formatHandoff(editor.price, locale)}`;
  return window.confirm(
    zh
      ? `确认发布“${name}”：${formatCny(editor.price.amountMinor, locale)} · ${terms}？发布后该价格版本不可修改。`
      : `Publish “${name}” at ${formatCny(editor.price.amountMinor, locale)} · ${terms}? This price version cannot be edited.`,
  );
}

function confirmEditorModeSwitch(
  editor: ProductEditor,
  product: OwnerBillingProduct,
  locale: Locale,
) {
  if (!editorDiffersFromProduct(editor, product)) return true;
  return window.confirm(locale === "zh"
    ? "当前页签有未保存的更改。切换后将丢弃这些更改，是否继续？"
    : "This tab has unsaved changes. Switching will discard them. Continue?");
}

function editorDiffersFromProduct(editor: ProductEditor, product: OwnerBillingProduct) {
  if (editor.mode === "create") return false;
  if (editor.mode === "metadata") {
    return editor.name !== product.name
      || editor.description !== (product.description ?? "")
      || editor.sortOrder !== product.sortOrder
      || editor.isRecommended !== product.isRecommended;
  }
  const price = product.activePriceVersion;
  if (!price) return false;
  return editor.price.amountMinor !== price.amountMinor
    || editor.price.entitlementUnits !== price.entitlementUnits
    || editor.price.handoffAllowance !== price.handoffAllowance
    || editor.price.handoffUnits !== price.handoffUnits
    || editor.price.handoffServiceLevel !== price.handoffServiceLevel
    || editor.price.handoffValidityDays !== price.handoffValidityDays;
}

function formatHandoff(
  price: Pick<PriceTerms, "handoffAllowance" | "handoffUnits" | "handoffServiceLevel">,
  locale: Locale,
) {
  const zh = locale === "zh";
  if (price.handoffAllowance === "NONE") return zh ? "不包含" : "None";
  const uses = price.handoffAllowance === "UNLIMITED"
    ? (zh ? "不限次" : "Unlimited")
    : `${price.handoffUnits ?? 0}${zh ? " 次" : " uses"}`;
  const level = price.handoffServiceLevel === "PRIORITY" ? (zh ? "优先" : "Priority") : (zh ? "标准" : "Standard");
  return `${uses} · ${level}`;
}

function commerceSettingsChanged(current: CommerceSettings, next: CommerceSettings) {
  return current.accessMode !== next.accessMode
    || current.handoffAccessMode !== next.handoffAccessMode
    || current.tipsEnabled !== next.tipsEnabled
    || current.humanInLoop !== next.humanInLoop
    || (next.accessMode === "TRIAL_THEN_CREDITS" && current.freeReplyLimit !== next.freeReplyLimit);
}

function commerceSettingsPatch(
  current: CommerceSettings,
  next: CommerceSettings,
) {
  return {
    ...(current.accessMode !== next.accessMode
      ? { accessMode: next.accessMode }
      : {}),
    ...(current.handoffAccessMode !== next.handoffAccessMode
      ? { handoffAccessMode: next.handoffAccessMode }
      : {}),
    ...(current.tipsEnabled !== next.tipsEnabled
      ? { tipsEnabled: next.tipsEnabled }
      : {}),
    ...(current.humanInLoop !== next.humanInLoop
      ? { humanInLoop: next.humanInLoop }
      : {}),
    ...(next.accessMode === "TRIAL_THEN_CREDITS"
      && current.freeReplyLimit !== next.freeReplyLimit
      ? { freeReplyLimit: next.freeReplyLimit }
      : {}),
  };
}

function sortProducts(products: OwnerBillingProduct[]) {
  return [...products].sort((a, b) =>
    Number(a.status === "ARCHIVED") - Number(b.status === "ARCHIVED")
    || a.sortOrder - b.sortOrder
    || a.name.localeCompare(b.name)
  );
}

function nextSortOrder(products: OwnerBillingProduct[]) {
  return products.reduce((highest, product) => Math.max(highest, product.sortOrder), -10) + 10;
}

function yuanToMinor(value: string) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as {
    error?: unknown;
    fieldErrors?: unknown;
  } | null;
  if (!response.ok) {
    throw new BillingRequestError(
      typeof payload?.error === "string" ? payload.error : "The commerce request failed.",
      normalizeFieldErrors(payload?.fieldErrors),
    );
  }
  return payload as T;
}

class BillingRequestError extends Error {
  constructor(message: string, readonly fieldErrors: Record<string, string[]>) {
    super(message);
    this.name = "BillingRequestError";
  }
}

function requestFailure(error: unknown, zh: boolean): RequestFailure {
  return {
    message: localizedError(error, zh),
    fieldErrors: error instanceof BillingRequestError ? error.fieldErrors : {},
  };
}

function localizedError(error: unknown, zh: boolean) {
  const message = error instanceof Error ? error.message : "";
  if (!zh) return message || "The commerce request failed. Refresh and retry.";
  if (message.includes("Archive every active service package")) return "切换为永久免费前，请先归档全部销售中的服务套餐。";
  if (message.includes("Archive every active tip option")) return "关闭打赏前，请先归档全部销售中的打赏档位。";
  if (message.includes("Free representatives cannot publish")) return "永久免费模式不能发布服务套餐。";
  if (message.includes("Enable tips before publishing")) return "请先启用打赏，再发布打赏档位。";
  if (message.includes("Enable package-required human handoff")) return "套餐包含付费人工权益，请先启用“需要套餐权益”的人工接管方式。";
  if (message.includes("changed concurrently") || message.includes("active price changed")) return "商品目录已被其他操作更新，请刷新后重新确认。";
  return message || "价格请求失败，请刷新后重试。";
}

function normalizeFieldErrors(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([field, messages]) => Array.isArray(messages)
      ? [[field, messages.filter((message): message is string => typeof message === "string")]]
      : []),
  );
}

function fieldError(error: RequestFailure | null, ...fields: string[]) {
  return firstError(error?.fieldErrors ?? {}, ...fields);
}

function firstError(fieldErrors: Record<string, string[]>, ...fields: string[]) {
  for (const field of fields) {
    const message = fieldErrors[field]?.[0];
    if (message) return message;
  }
  return undefined;
}

function createBrowserRequestId(prefix: string) {
  const id = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${id}`;
}

function productStatusLabel(status: OwnerBillingProduct["status"], locale: Locale) {
  const labels = {
    DRAFT: ["草稿", "Draft"],
    ACTIVE: ["销售中", "Active"],
    ARCHIVED: ["已归档", "Archived"],
  } as const;
  return labels[status][locale === "zh" ? 0 : 1];
}

function formatCny(amountMinor: number, locale: Locale) {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

function formatInteger(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US").format(value);
}
