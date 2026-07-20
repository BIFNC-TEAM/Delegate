import { describe, expect, it } from "vitest";

import {
  MISSING_REPRESENTATIVE_CREATE_FIELDS_MESSAGE,
  normalizeRepresentativeCreateBody,
} from "../app/api/dashboard/representatives/create-validation";

describe("dashboard representative creation validation", () => {
  it("returns friendly field errors instead of raw validation details", () => {
    const result = normalizeRepresentativeCreateBody({
      ownerName: "",
      representativeName: "   ",
    });

    expect(result).toEqual({
      ok: false,
      error: MISSING_REPRESENTATIVE_CREATE_FIELDS_MESSAGE,
      fieldErrors: {
        ownerName: "请填写 owner name",
        representativeName: "请填写 representative name",
      },
    });
  });

  it("trims valid input and omits empty optional fields", () => {
    const result = normalizeRepresentativeCreateBody({
      ownerName: " Lin ",
      representativeName: " Founder Rep ",
      slug: " ",
      tagline: " Helps users ",
    });

    expect(result).toEqual({
      ok: true,
      input: {
        ownerName: "Lin",
        representativeName: "Founder Rep",
        tagline: "Helps users",
      },
    });
  });
});
