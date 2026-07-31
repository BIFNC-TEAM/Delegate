import { readFileSync } from "node:fs";

import {
  IdentityLinkProvider,
  OwnerIdentityLinkProvider,
  Prisma,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { generatedPrismaClientHasFields } from "../src/prisma";

const prismaSchema = readFileSync(
  new URL("../../../prisma/schema.prisma", import.meta.url),
  "utf8",
);

function listSchemaModelFields(source: string) {
  const models = new Map<string, string[]>();
  let currentModel: string | null = null;
  let currentFields: string[] = [];

  const sourceWithoutBlockComments = source.replace(
    /\/\*[\s\S]*?\*\//gu,
    (comment) => comment.replace(/[^\r\n]/gu, " "),
  );
  for (const rawLine of sourceWithoutBlockComments.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;

    if (!currentModel) {
      const model = line.match(/^model\s+(\w+)\s*\{\s*$/)?.[1];
      if (model) {
        currentModel = model;
        currentFields = [];
      }
      continue;
    }

    if (line === "}") {
      models.set(currentModel, currentFields);
      currentModel = null;
      currentFields = [];
      continue;
    }
    if (line.startsWith("@@")) continue;

    const field = line.match(/^(\w+)\s+/)?.[1];
    if (field) currentFields.push(field);
  }
  return models;
}

describe("generated Prisma client auth enums", () => {
  it("includes providers used by representative auth routes", () => {
    expect(IdentityLinkProvider.LOGTO).toBe("LOGTO");
    expect(OwnerIdentityLinkProvider.LOGTO).toBe("LOGTO");
  });

  it("contains every model field declared by the current Prisma schema", () => {
    const generatedModels = new Map(
      Prisma.dmmf.datamodel.models.map((model) => [
        model.name,
        new Set(model.fields.map((field) => field.name)),
      ]),
    );
    const missingFields: string[] = [];

    for (const [modelName, fields] of listSchemaModelFields(prismaSchema)) {
      const generatedFields = generatedModels.get(modelName);
      if (!generatedFields) {
        missingFields.push(`${modelName}.*`);
        continue;
      }
      for (const field of fields) {
        if (!generatedFields.has(field)) {
          missingFields.push(`${modelName}.${field}`);
        }
      }
    }

    expect(missingFields).toEqual([]);
  });

  it("parses indented models without treating block-comment text as fields", () => {
    const fields = listSchemaModelFields(`
      model Example {
        id String @id /* comment
          continued words
        */
        name String
      }
    `);

    expect(fields.get("Example")).toEqual(["id", "name"]);
  });

  it("accepts fields that exist in the generated Prisma Client", () => {
    expect(
      generatedPrismaClientHasFields({
        Owner: ["id", "accountDisplayName"],
      }),
    ).toBe(true);
  });

  it("rejects a field missing from the generated Prisma Client", () => {
    expect(
      generatedPrismaClientHasFields({
        Owner: ["definitelyMissingField"],
      }),
    ).toBe(false);
  });

  it("rejects a model missing from the generated Prisma Client", () => {
    expect(
      generatedPrismaClientHasFields({
        DefinitelyMissingModel: ["id"],
      }),
    ).toBe(false);
  });

  it("generates the exact issuer/subject compound key for audience identities", () => {
    const identityLink = Prisma.dmmf.datamodel.models.find(
      (model) => model.name === "IdentityLink",
    );
    expect(identityLink?.uniqueFields).toContainEqual([
      "provider",
      "issuer",
      "providerSubject",
    ]);
  });
});
