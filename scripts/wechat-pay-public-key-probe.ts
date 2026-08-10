import { pathToFileURL } from "node:url";

import {
  loadWeChatPayPublicKeyProbeConfigFromEnv,
  probeWeChatPayPublicKey,
  WeChatPayConfigurationError,
  WeChatPayProtocolError,
  type WeChatPayPublicKeyProbeConfig,
  type WeChatPayPublicKeyProbeResult,
} from "../packages/web-data/src/index";

export type WeChatPayPublicKeyProbeCliDependencies = {
  loadConfig: () => WeChatPayPublicKeyProbeConfig;
  probe: (
    config: WeChatPayPublicKeyProbeConfig,
  ) => Promise<WeChatPayPublicKeyProbeResult>;
};

export type WeChatPayPublicKeyProbeCliIo = {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
};

const defaultDependencies: WeChatPayPublicKeyProbeCliDependencies = {
  loadConfig: () => loadWeChatPayPublicKeyProbeConfigFromEnv(),
  probe: probeWeChatPayPublicKey,
};

const defaultIo: WeChatPayPublicKeyProbeCliIo = {
  stdout: (value) => process.stdout.write(`${value}\n`),
  stderr: (value) => process.stderr.write(`${value}\n`),
};

export async function runWeChatPayPublicKeyProbeCli(
  argv: readonly string[] = [],
  options: {
    dependencies?: WeChatPayPublicKeyProbeCliDependencies;
    io?: WeChatPayPublicKeyProbeCliIo;
  } = {},
): Promise<number> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const io = options.io ?? defaultIo;
  if (argv.length > 0) {
    io.stderr(JSON.stringify({
      status: "failed",
      reason: "unexpected_arguments",
    }));
    return 2;
  }

  try {
    const result = await dependencies.probe(dependencies.loadConfig());
    io.stdout(JSON.stringify(result));
    return 0;
  } catch (error) {
    if (error instanceof WeChatPayConfigurationError) {
      io.stderr(JSON.stringify({
        status: "failed",
        reason: "configuration_invalid",
      }));
      return 2;
    }
    if (error instanceof WeChatPayProtocolError) {
      io.stderr(JSON.stringify({
        status: "failed",
        reason: "probe_failed",
      }));
      return 1;
    }
    io.stderr(JSON.stringify({
      status: "failed",
      reason: "unexpected_error",
    }));
    return 3;
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  process.exitCode = await runWeChatPayPublicKeyProbeCli(argv);
}

const entryPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;
if (entryPath && import.meta.url === entryPath) {
  main().catch(() => {
    process.stderr.write(JSON.stringify({
      status: "failed",
      reason: "unexpected_error",
    }) + "\n");
    process.exitCode = 3;
  });
}
