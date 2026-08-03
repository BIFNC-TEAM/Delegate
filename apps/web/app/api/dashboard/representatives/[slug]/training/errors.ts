import { NextResponse } from "next/server";

import { withPrivateNoStore } from "../../../../private-response";

type PublicTrainingError = {
  code:
    | "TRAINING_NOT_FOUND"
    | "SUGGESTION_NOT_PENDING"
    | "REVISION_NOT_LATEST"
    | "REVISION_HISTORY_AMBIGUOUS"
    | "KNOWLEDGE_DRAFT_CHANGED"
    | "SAFETY_REVIEW_FAILED"
    | "CREATOR_ANSWER_REQUIRED"
    | "INVALID_TRAINING_REQUEST";
  message: string;
  status: 400 | 404 | 409 | 422;
};

export const CREATOR_TRAINING_RETIRED_ERROR = {
  error: "Legacy representative development writes are retired and no longer accepted.",
  code: "CREATOR_TRAINING_RETIRED",
} as const;

export function creatorTrainingWriteRetiredResponse() {
  return withPrivateNoStore(
    NextResponse.json(CREATOR_TRAINING_RETIRED_ERROR, { status: 410 }),
  );
}

export function creatorTrainingApiErrorResponse(
  error: unknown,
  fallbackMessage: string,
) {
  const publicError = classifyCreatorTrainingError(error);
  return withPrivateNoStore(
    NextResponse.json(
      {
        error: publicError?.message ?? fallbackMessage,
        code: publicError?.code ?? "CREATOR_TRAINING_ERROR",
      },
      { status: publicError?.status ?? 500 },
    ),
  );
}

function classifyCreatorTrainingError(error: unknown): PublicTrainingError | null {
  if (!(error instanceof Error)) return null;

  if (
    error.message === "Representative not found."
    || error.message === "Creator training source not found."
    || error.message === "Creator training suggestion not found."
    || error.message === "Creator training version not found."
  ) {
    return {
      code: "TRAINING_NOT_FOUND",
      message: error.message,
      status: 404,
    };
  }

  if (error.message === "Creator training suggestion is no longer pending.") {
    return {
      code: "SUGGESTION_NOT_PENDING",
      message: "This suggestion is no longer pending. Refresh and review its current state.",
      status: 409,
    };
  }

  if (error.message === "Only the latest applied creator training version can be rolled back.") {
    return {
      code: "REVISION_NOT_LATEST",
      message: "Only the latest applied development revision can be reverted.",
      status: 409,
    };
  }

  if (
    error.message
    === "Creator training history is ambiguous for the current knowledge draft. Publish a new update before rolling back."
  ) {
    return {
      code: "REVISION_HISTORY_AMBIGUOUS",
      message: "This development history is ambiguous. Publish a new update before reverting.",
      status: 409,
    };
  }

  if (error.message.startsWith("Knowledge draft changed after this creator training version.")) {
    return {
      code: "KNOWLEDGE_DRAFT_CHANGED",
      message: "The knowledge draft changed after this revision. Refresh before reverting it.",
      status: 409,
    };
  }

  if (error.message === "Creator training evaluation failed.") {
    return {
      code: "SAFETY_REVIEW_FAILED",
      message: "This suggestion did not pass the server-side safety review.",
      status: 422,
    };
  }

  if (error.message === "Knowledge gap requires a creator-authored answer.") {
    return {
      code: "CREATOR_ANSWER_REQUIRED",
      message: "Add a real owner-approved answer before approving this knowledge gap.",
      status: 422,
    };
  }

  if (
    error.message.endsWith(" is required.")
    || error.message.startsWith("Unsupported creator training ")
    || error.message.startsWith("Unsupported creator feedback ")
  ) {
    return {
      code: "INVALID_TRAINING_REQUEST",
      message: "The development request contains an unsupported or missing value.",
      status: 400,
    };
  }

  return null;
}
