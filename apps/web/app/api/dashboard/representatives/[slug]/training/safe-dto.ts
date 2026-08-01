import type {
  CreatorFeedbackSignalSnapshot,
  CreatorTrainingDashboardSnapshot,
  CreatorTrainingReviewWorkflowSnapshot,
  CreatorTrainingSourceSnapshot,
  CreatorTrainingSuggestionSnapshot,
  CreatorTrainingVersionSnapshot,
} from "@delegate/web-data";

export function toDashboardDevelopmentWorkflowDto(
  workflow: CreatorTrainingReviewWorkflowSnapshot,
) {
  return {
    id: workflow.id,
    status: workflow.status,
    scheduledAt: workflow.scheduledAt,
    nextWakeAt: workflow.nextWakeAt,
    createdAt: workflow.createdAt,
  };
}

export function toDashboardDevelopmentSourceDto(
  source: CreatorTrainingSourceSnapshot,
) {
  return {
    id: source.id,
    kind: source.kind,
    status: source.status,
    title: source.title,
    locator: source.locator,
    contentText: source.contentText,
    lastSyncedAt: source.lastSyncedAt,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

export function toDashboardDevelopmentFeedbackDto(
  signal: CreatorFeedbackSignalSnapshot,
) {
  return {
    id: signal.id,
    signalType: signal.signalType,
    status: signal.status,
    publicSafe: signal.publicSafe,
    note: signal.note,
    suggestedText: signal.suggestedText,
    createdAt: signal.createdAt,
    updatedAt: signal.updatedAt,
  };
}

export function toDashboardDevelopmentSuggestionDto(
  suggestion: CreatorTrainingSuggestionSnapshot,
) {
  return {
    id: suggestion.id,
    sourceId: suggestion.sourceId,
    feedbackSignalId: suggestion.feedbackSignalId,
    suggestionType: suggestion.suggestionType,
    status: suggestion.status,
    title: suggestion.title,
    rationale: suggestion.rationale,
    draftPayload: suggestion.draftPayload,
    riskLevel: suggestion.riskLevel,
    reviewedAt: suggestion.reviewedAt,
    reviewNote: suggestion.reviewNote,
    createdAt: suggestion.createdAt,
    updatedAt: suggestion.updatedAt,
  };
}

export function toDashboardDevelopmentVersionDto(
  version: CreatorTrainingVersionSnapshot,
) {
  return {
    id: version.id,
    revisionNumber: version.revisionNumber,
    status: version.status,
    title: version.title,
    ownerReviewed: Boolean(version.publishedBy),
    publishedAt: version.publishedAt,
    ownerReverted: Boolean(version.rolledBackBy),
    rolledBackAt: version.rolledBackAt,
    createdAt: version.createdAt,
  };
}

export function toDashboardRepresentativeDevelopmentDto(
  snapshot: CreatorTrainingDashboardSnapshot,
) {
  return {
    sources: snapshot.sources.map(toDashboardDevelopmentSourceDto),
    feedbackSignals: snapshot.feedbackSignals.map(
      toDashboardDevelopmentFeedbackDto,
    ),
    suggestions: snapshot.suggestions.map(
      toDashboardDevelopmentSuggestionDto,
    ),
    versions: snapshot.versions.map(toDashboardDevelopmentVersionDto),
    latestWorkflow: snapshot.latestWorkflow
      ? toDashboardDevelopmentWorkflowDto(snapshot.latestWorkflow)
      : null,
    summary: snapshot.summary,
  };
}
