import { Prisma, PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export function generatedPrismaClientHasFields(
  requiredFields: Readonly<Record<string, readonly string[]>>,
): boolean {
  const generatedModels = new Map(
    Prisma.dmmf.datamodel.models.map((model) => [
      model.name,
      new Set(model.fields.map((field) => field.name)),
    ]),
  );

  return Object.entries(requiredFields).every(([modelName, fields]) => {
    const generatedFields = generatedModels.get(modelName);
    return (
      generatedFields !== undefined &&
      fields.every((field) => generatedFields.has(field))
    );
  });
}
