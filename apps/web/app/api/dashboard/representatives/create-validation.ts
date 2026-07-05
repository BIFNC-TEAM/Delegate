export type RepresentativeCreateInputFromRequest = {
  ownerName: string;
  representativeName: string;
  slug?: string;
  tagline?: string;
};

export type RepresentativeCreateFieldErrors = Partial<{
  ownerName: string;
  representativeName: string;
}>;

export type RepresentativeCreateValidationResult =
  | {
      ok: true;
      input: RepresentativeCreateInputFromRequest;
    }
  | {
      ok: false;
      error: string;
      fieldErrors: RepresentativeCreateFieldErrors;
    };

export const MISSING_REPRESENTATIVE_CREATE_FIELDS_MESSAGE =
  "请填写 owner name / representative name";

export function normalizeRepresentativeCreateBody(
  body: Record<string, unknown>,
): RepresentativeCreateValidationResult {
  const ownerName = getTrimmedString(body.ownerName);
  const representativeName = getTrimmedString(body.representativeName);
  const fieldErrors: RepresentativeCreateFieldErrors = {};

  if (!ownerName) {
    fieldErrors.ownerName = "请填写 owner name";
  }

  if (!representativeName) {
    fieldErrors.representativeName = "请填写 representative name";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      error: buildMissingFieldsMessage(fieldErrors),
      fieldErrors,
    };
  }

  const slug = getTrimmedString(body.slug);
  const tagline = getTrimmedString(body.tagline);

  return {
    ok: true,
    input: {
      ownerName,
      representativeName,
      ...(slug ? { slug } : {}),
      ...(tagline ? { tagline } : {}),
    },
  };
}

function getTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildMissingFieldsMessage(fieldErrors: RepresentativeCreateFieldErrors): string {
  const missingFields = [
    fieldErrors.ownerName ? "owner name" : null,
    fieldErrors.representativeName ? "representative name" : null,
  ].filter(Boolean);

  return missingFields.length === 2
    ? MISSING_REPRESENTATIVE_CREATE_FIELDS_MESSAGE
    : `请填写 ${missingFields[0]}`;
}
