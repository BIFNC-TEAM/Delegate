import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const baseComposeSource = readFileSync(
  new URL("../../../compose.yml", import.meta.url),
  "utf8",
);
const localComposeSource = readFileSync(
  new URL("../../../compose.local.yml", import.meta.url),
  "utf8",
);
const rootPackage = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as {
  scripts?: Record<string, string>;
};
const composeEnvironment = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
};
const dockerComposeAvailable =
  spawnSync("docker", ["compose", "version"], {
    cwd: repositoryRoot,
    env: composeEnvironment,
    stdio: "ignore",
  }).status === 0;

function parseServiceBlocks(source: string) {
  const headers = [...source.matchAll(/^  ([a-z0-9-]+):\s*$/gm)];
  return new Map(
    headers.map((header, index) => {
      const start = header.index ?? 0;
      const end = headers[index + 1]?.index ?? source.length;
      return [header[1], source.slice(start, end)] as const;
    }),
  );
}

describe("local Compose source synchronization contract", () => {
  const baseServices = parseServiceBlocks(baseComposeSource);
  const services = parseServiceBlocks(localComposeSource);

  it("runs local Next.js applications with Turbopack and source mounts", () => {
    for (const serviceName of ["dashboard", "reps"]) {
      const block = services.get(serviceName);

      expect(block, `${serviceName} must have a local service override`).toBeDefined();
      expect(block, `${serviceName} must regenerate Prisma for the mounted schema`).toContain(
        "pnpm db:generate",
      );
      expect(block, `${serviceName} must run the Turbopack development server`).toContain(
        "next dev --turbopack",
      );
      expect(block, `${serviceName} must not fall back to Webpack`).not.toContain(
        "--webpack",
      );
      expect(block, `${serviceName} must not run a precompiled Next.js server`).not.toContain(
        "next start",
      );
      expect(block, `${serviceName} must mount current app source`).toContain(
        ":/app/apps/",
      );
      expect(block, `${serviceName} must mount current workspace package source`).toContain(
        ":/app/packages/",
      );
      expect(block, `${serviceName} must mount the current web-data export map`).toContain(
        "./packages/web-data/package.json:/app/packages/web-data/package.json:ro",
      );
      expect(block, `${serviceName} must mount the current Prisma schema read-only`).toContain(
        "./prisma/schema.prisma:/app/prisma/schema.prisma:ro",
      );
      expect(block, `${serviceName} must not shadow the image node_modules`).not.toContain(
        ":/app/node_modules",
      );
      expect(block, `${serviceName} must not shadow the whole image workspace`).not.toMatch(
        /^\s*-\s+\.:\/app(?::|\s|$)/mu,
      );
    }

    const dashboard = services.get("dashboard") ?? "";
    const dashboardGenerateIndex = dashboard.indexOf("pnpm db:generate");
    const bootstrapIndex = dashboard.indexOf("pnpm local:auth:bootstrap");
    const dashboardDevIndex = dashboard.indexOf("next dev --turbopack");
    expect(dashboardGenerateIndex).toBeGreaterThan(-1);
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(dashboardDevIndex).toBeGreaterThan(-1);
    expect(dashboardGenerateIndex).toBeLessThan(bootstrapIndex);
    expect(bootstrapIndex).toBeLessThan(dashboardDevIndex);

    const reps = services.get("reps") ?? "";
    expect(reps.indexOf("pnpm db:generate")).toBeLessThan(
      reps.indexOf("next dev --turbopack"),
    );

    const bot = services.get("bot");
    expect(bot).not.toContain("next dev");
    expect(bot).not.toContain(":/app/apps/");
    expect(bot).not.toContain(":/app/packages/");
    expect(baseServices.get("bot")).not.toContain("pnpm db:generate");
  });

  it("runs local migrations from the current Prisma tree", () => {
    const migrate = services.get("migrate");

    expect(migrate).toContain("./prisma:/app/prisma:ro");
    expect(migrate).toContain(
      "pnpm db:generate && pnpm db:deploy && pnpm db:seed",
    );
    expect(rootPackage.scripts?.["db:generate"]).toBe(
      "prisma generate --schema prisma/schema.prisma",
    );
  });

  it("isolates Logto client secrets to their owning web application", () => {
    const dashboard = baseServices.get("dashboard");
    const reps = baseServices.get("reps");
    const sharedEnvironment = baseComposeSource.slice(
      baseComposeSource.indexOf("x-app-environment:"),
      baseComposeSource.indexOf("x-app-service:"),
    );
    for (const applicationCredential of [
      "LOGTO_DASHBOARD_APP_ID",
      "LOGTO_DASHBOARD_APP_SECRET",
      "LOGTO_REPS_APP_ID",
      "LOGTO_REPS_APP_SECRET",
      "LOGTO_REPS_LEGACY_APP_ID",
      "LOGTO_REPS_LEGACY_APP_SECRET",
    ]) {
      expect(
        sharedEnvironment,
        `shared environment must not contain ${applicationCredential}`,
      ).not.toContain(applicationCredential);
    }

    expect(dashboard).toContain("LOGTO_DASHBOARD_APP_ID");
    expect(dashboard).toContain("LOGTO_DASHBOARD_APP_SECRET");
    expect(dashboard).not.toContain("LOGTO_REPS_APP_ID");
    expect(dashboard).not.toContain("LOGTO_REPS_APP_SECRET");
    expect(dashboard).not.toContain("LOGTO_REPS_LEGACY_APP_SECRET");

    expect(reps).toContain("LOGTO_REPS_APP_ID");
    expect(reps).toContain("LOGTO_REPS_APP_SECRET");
    expect(reps).toContain("LOGTO_REPS_LEGACY_APP_SECRET");
    expect(reps).not.toContain("LOGTO_DASHBOARD_APP_ID");
    expect(reps).not.toContain("LOGTO_DASHBOARD_APP_SECRET");

    const forbiddenOutsideWebApps = [
      "LOGTO_DASHBOARD_APP_ID",
      "LOGTO_DASHBOARD_APP_SECRET",
      "LOGTO_REPS_APP_ID",
      "LOGTO_REPS_APP_SECRET",
      "LOGTO_REPS_LEGACY_APP_ID",
      "LOGTO_REPS_LEGACY_APP_SECRET",
    ];
    for (const [serviceName, block] of baseServices) {
      if (serviceName === "dashboard" || serviceName === "reps") {
        continue;
      }
      for (const secret of forbiddenOutsideWebApps) {
        expect(block, `${serviceName} must not receive ${secret}`).not.toContain(
          secret,
        );
      }
    }
  });

  it("uses a trusted container backchannel without changing public canonical origins", () => {
    const dashboard = services.get("dashboard");
    const reps = services.get("reps");
    const migrate = services.get("migrate");

    for (const [serviceName, block] of [
      ["dashboard", dashboard],
      ["reps", reps],
    ] as const) {
      expect(block, `${serviceName} needs the Logto host backchannel`).toContain(
        "LOGTO_BACKCHANNEL_ENDPOINT",
      );
      expect(block, `${serviceName} needs host-gateway resolution`).toContain(
        "host.docker.internal:host-gateway",
      );
    }
    expect(reps).toContain("LOGTO_REPS_LEGACY_BACKCHANNEL_ENDPOINT");
    expect(migrate).not.toContain("LOGTO_BACKCHANNEL_ENDPOINT");
  });

  it("keeps a static migration-ordering fallback when Docker Compose is unavailable", () => {
    for (const serviceName of ["dashboard", "reps", "bot"]) {
      const service = baseServices.get(serviceName);
      expect(service, `${serviceName} must exist in the base Compose file`).toBeDefined();
      expect(service, `${serviceName} must depend on migrate`).toMatch(
        /depends_on:[\s\S]*?\bmigrate:\s*[\s\S]*?condition:\s*service_completed_successfully/u,
      );
    }
  });

  it.skipIf(!dockerComposeAvailable)(
    "preserves migration ordering in the merged Compose configuration",
    () => {
      const mergedConfig = JSON.parse(
        execFileSync(
          "docker",
          [
            "compose",
            "--env-file",
            "/dev/null",
            "-f",
            "compose.yml",
            "-f",
            "compose.local.yml",
            "config",
            "--format",
            "json",
          ],
          {
            cwd: repositoryRoot,
            env: composeEnvironment,
            encoding: "utf8",
          },
        ),
      ) as {
        services?: Record<
          string,
          {
            command?: string[];
            depends_on?: Record<
              string,
              {
                condition?: string;
                required?: boolean;
              }
            >;
            volumes?: Array<{
              source?: string;
              target?: string;
              type?: string;
            }>;
          }
        >;
      };

      for (const serviceName of ["dashboard", "reps", "bot"]) {
        expect(
          mergedConfig.services?.[serviceName]?.depends_on?.migrate,
          `${serviceName} must wait for migrations`,
        ).toMatchObject({
          condition: "service_completed_successfully",
          required: true,
        });
      }

      expect(mergedConfig.services?.dashboard?.command?.join(" ")).toContain(
        "pnpm db:generate && pnpm local:auth:bootstrap && exec pnpm --filter @delegate/dashboard exec next dev --turbopack",
      );
      expect(mergedConfig.services?.reps?.command?.join(" ")).toContain(
        "pnpm db:generate && exec pnpm --filter @delegate/reps exec next dev --turbopack",
      );
      expect(mergedConfig.services?.bot?.command?.join(" ")).toContain(
        "exec node --import tsx src/index.ts",
      );

      for (const serviceName of ["dashboard", "reps"]) {
        const command = mergedConfig.services?.[serviceName]?.command?.join(" ") ?? "";
        const volumes = mergedConfig.services?.[serviceName]?.volumes ?? [];
        const targets = volumes.map((volume) => volume.target);
        expect(command).toContain("pnpm db:generate");
        expect(command).toContain("next dev --turbopack");
        expect(command).not.toContain("--webpack");
        expect(command).not.toContain("next start");
        expect(targets).toContain("/app/packages/web-data/src");
        expect(targets).toContain("/app/packages/web-data/package.json");
        expect(targets).toContain("/app/packages/web-ui/styles");
        expect(targets).toContain("/app/prisma/schema.prisma");
        expect(targets).not.toContain("/app");
        expect(targets).not.toContain("/app/node_modules");
      }

      expect(mergedConfig.services?.dashboard?.volumes?.map(({ target }) => target))
        .toContain("/app/apps/web/app");
      expect(mergedConfig.services?.reps?.volumes?.map(({ target }) => target))
        .toContain("/app/apps/reps/app");
      expect(mergedConfig.services?.bot?.command?.join(" ")).not.toContain(
        "pnpm db:generate",
      );
      expect(mergedConfig.services?.bot?.command?.join(" ")).not.toContain(
        "next dev",
      );
      expect(mergedConfig.services?.bot?.volumes ?? []).toEqual([]);
    },
  );
});
