import {
  createWeChatPayApiV3PaymentProviderAdapter,
  loadWeChatPayApiV3ConfigFromEnv,
  type WeChatPayApiV3Config,
  type WeChatPayEnvironment,
} from "./wechat-pay-api-v3";

const LEGACY_RELEASE_FLAG = "DELEGATE_WECHAT_PAY_ENABLED";
const COLLECTION_RELEASE_FLAG =
  "DELEGATE_WECHAT_PAY_COLLECTION_ENABLED";
const PROCESSING_RELEASE_FLAG =
  "DELEGATE_WECHAT_PAY_PROCESSING_ENABLED";

export type WeChatPayReleaseFlags = {
  collectionEnabled: boolean;
  processingEnabled: boolean;
  legacyFallbackUsed: boolean;
};

export type WeChatPayRuntimePreflight = {
  ready: boolean;
  status: "disabled" | "ready" | "misconfigured";
  collectionEnabled: boolean;
  processingEnabled: boolean;
  errorCode: string | null;
};

export class WeChatPayReleaseConfigurationError extends Error {
  readonly code = "WECHAT_PAY_RELEASE_CONFIGURATION_ERROR";

  constructor(
    message =
      `${COLLECTION_RELEASE_FLAG}=true requires `
      + `${PROCESSING_RELEASE_FLAG}=true.`,
  ) {
    super(message);
    this.name = "WeChatPayReleaseConfigurationError";
  }
}

/**
 * The explicit split flags take precedence over the legacy flag. The fallback
 * keeps existing deployments running while operators migrate to independent
 * collection and processing controls.
 */
export function resolveWeChatPayReleaseFlags(
  env: WeChatPayEnvironment = process.env,
): WeChatPayReleaseFlags {
  const collectionValue = env[COLLECTION_RELEASE_FLAG];
  const processingValue = env[PROCESSING_RELEASE_FLAG];
  const collectionExplicit =
    collectionValue !== undefined && collectionValue !== "";
  const processingExplicit =
    processingValue !== undefined && processingValue !== "";
  if (collectionExplicit !== processingExplicit) {
    throw new WeChatPayReleaseConfigurationError(
      `${COLLECTION_RELEASE_FLAG} and ${PROCESSING_RELEASE_FLAG} `
      + "must be configured together.",
    );
  }
  const splitFlagsExplicit =
    collectionExplicit && processingExplicit;
  if (splitFlagsExplicit) {
    assertExactBooleanFlag(
      collectionValue!,
      COLLECTION_RELEASE_FLAG,
    );
    assertExactBooleanFlag(
      processingValue!,
      PROCESSING_RELEASE_FLAG,
    );
  }
  const legacyValue = env[LEGACY_RELEASE_FLAG];
  const legacyExplicit =
    legacyValue !== undefined && legacyValue !== "";
  if (!splitFlagsExplicit && legacyExplicit) {
    assertExactBooleanFlag(legacyValue, LEGACY_RELEASE_FLAG);
  }
  const legacyEnabled =
    !splitFlagsExplicit && legacyValue === "true";
  const collectionEnabled = splitFlagsExplicit
    ? collectionValue === "true"
    : legacyEnabled;
  const processingEnabled = splitFlagsExplicit
    ? processingValue === "true"
    : legacyEnabled;

  if (collectionEnabled && !processingEnabled) {
    throw new WeChatPayReleaseConfigurationError();
  }

  return {
    collectionEnabled,
    processingEnabled,
    legacyFallbackUsed: !splitFlagsExplicit,
  };
}

function assertExactBooleanFlag(
  value: string,
  flag: string,
): void {
  if (value !== "true" && value !== "false") {
    throw new WeChatPayReleaseConfigurationError(
      `${flag} must be exactly "true" or "false".`,
    );
  }
}

/**
 * Convenience gates deliberately fail closed when the release combination is
 * invalid. Startup preflight exposes the stable configuration error.
 */
export function isWeChatPayCollectionEnabled(
  env: WeChatPayEnvironment = process.env,
): boolean {
  try {
    return resolveWeChatPayReleaseFlags(env).collectionEnabled;
  } catch {
    return false;
  }
}

export function isWeChatPayProcessingEnabled(
  env: WeChatPayEnvironment = process.env,
): boolean {
  try {
    return resolveWeChatPayReleaseFlags(env).processingEnabled;
  } catch {
    return false;
  }
}

/**
 * Bridges the split processing flag to the legacy API-v3 configuration
 * loader. The cloned environment avoids mutating process.env while the old
 * loader remains backward compatible for callers outside this release slice.
 */
export function loadWeChatPayProcessingConfigFromEnv(
  env: WeChatPayEnvironment = process.env,
): WeChatPayApiV3Config {
  const flags = resolveWeChatPayReleaseFlags(env);
  if (!flags.processingEnabled) {
    throw new WeChatPayReleaseConfigurationError(
      `${PROCESSING_RELEASE_FLAG}=true is required to load processing credentials.`,
    );
  }
  return loadWeChatPayApiV3ConfigFromEnv({
    ...env,
    DELEGATE_WECHAT_PAY_ENABLED: "true",
  });
}

type WeChatPayRuntimePreflightDependencies = {
  loadConfig?: (
    env: WeChatPayEnvironment,
  ) => WeChatPayApiV3Config;
  validateConfig?: (config: WeChatPayApiV3Config) => void;
};

/**
 * Performs local-only configuration and cryptographic material validation.
 * It never contacts WeChat Pay and never returns an underlying error message.
 */
export function preflightWeChatPayRuntime(
  env: WeChatPayEnvironment = process.env,
  dependencies: WeChatPayRuntimePreflightDependencies = {},
): WeChatPayRuntimePreflight {
  let flags: WeChatPayReleaseFlags;
  try {
    flags = resolveWeChatPayReleaseFlags(env);
  } catch {
    return {
      ready: false,
      status: "misconfigured",
      collectionEnabled: false,
      processingEnabled: false,
      errorCode: "wechat_pay_release_flags_invalid",
    };
  }

  if (!flags.processingEnabled) {
    return {
      ready: true,
      status: "disabled",
      collectionEnabled: false,
      processingEnabled: false,
      errorCode: null,
    };
  }

  try {
    const loadConfig =
      dependencies.loadConfig ?? loadWeChatPayProcessingConfigFromEnv;
    const validateConfig =
      dependencies.validateConfig
      ?? ((config) => {
        // Adapter construction resolves and validates every key, certificate,
        // URL and bounded setting without issuing an upstream request.
        createWeChatPayApiV3PaymentProviderAdapter(config);
      });
    validateConfig(loadConfig(env));
    return {
      ready: true,
      status: "ready",
      collectionEnabled: flags.collectionEnabled,
      processingEnabled: true,
      errorCode: null,
    };
  } catch {
    return {
      ready: false,
      status: "misconfigured",
      collectionEnabled: flags.collectionEnabled,
      processingEnabled: true,
      errorCode: "wechat_pay_configuration_invalid",
    };
  }
}
