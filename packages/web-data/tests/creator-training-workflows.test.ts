import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enqueueCreatorTrainingReviewWorkflow } from "../src/creator-training";

describe("creator training workflow enqueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.WORKFLOW_ENGINE;
    delete process.env.WORKFLOW_TEMPORAL_ADDRESS;
    delete process.env.WORKFLOW_TEMPORAL_NAMESPACE;
    delete process.env.WORKFLOW_TEMPORAL_TASK_QUEUE;
  });

  it("writes WorkflowRun and START outbox intent in Temporal mode", async () => {
    process.env.WORKFLOW_ENGINE = "temporal";
    process.env.WORKFLOW_TEMPORAL_ADDRESS = "127.0.0.1:7233";
    process.env.WORKFLOW_TEMPORAL_NAMESPACE = "delegate";
    process.env.WORKFLOW_TEMPORAL_TASK_QUEUE = "delegate-public-runtime";
    const client = new FakeCreatorTrainingWorkflowClient();

    const workflow = await enqueueCreatorTrainingReviewWorkflow(
      "lin",
      {
        now: new Date("2026-07-04T12:30:00.000Z"),
      },
      client,
    );

    expect(workflow).toMatchObject({
      workflowKind: "creator_training_review",
      engine: "temporal",
      status: "queued",
      dedupeKey: "creator_training_review:lin:2026-07-04T12",
      queueName: "delegate-public-runtime",
      externalWorkflowId: "delegate:lin:creator_training_review:training-review:2026-07-04T12",
    });
    expect(client.workflowRun.createCalls[0]?.data).toEqual(
      expect.objectContaining({
        kind: "CREATOR_TRAINING_REVIEW",
        engine: "TEMPORAL",
        enginePhase: "DISPATCH_PENDING",
        commandOutbox: {
          create: expect.objectContaining({
            commandType: "START",
            payload: expect.objectContaining({
              source: "creator_training_review_enqueue",
              scheduledAt: "2026-07-04T12:30:00.000Z",
            }),
          }),
        },
      }),
    );
    expect(client.eventAudit.createCalls[0]?.data.payload).toEqual(
      expect.objectContaining({
        workflowKind: "creator_training_review",
        effectiveEngine: "temporal",
      }),
    );
  });

  it("keeps local runner enqueue free of Temporal outbox intent", async () => {
    process.env.WORKFLOW_ENGINE = "local_runner";
    const client = new FakeCreatorTrainingWorkflowClient();

    await enqueueCreatorTrainingReviewWorkflow(
      "lin",
      {
        now: new Date("2026-07-04T13:00:00.000Z"),
      },
      client,
    );

    const workflowData = client.workflowRun.createCalls[0]?.data;
    expect(workflowData).toEqual(
      expect.objectContaining({
        engine: "LOCAL_RUNNER",
        status: "QUEUED",
        dedupeKey: "creator_training_review:lin:2026-07-04T13",
      }),
    );
    expect(workflowData).not.toHaveProperty("commandOutbox");
    expect(workflowData).not.toHaveProperty("enginePhase");
  });

  it("returns the existing workflow for the same hourly dedupe window", async () => {
    process.env.WORKFLOW_ENGINE = "temporal";
    process.env.WORKFLOW_TEMPORAL_ADDRESS = "127.0.0.1:7233";
    process.env.WORKFLOW_TEMPORAL_NAMESPACE = "delegate";
    process.env.WORKFLOW_TEMPORAL_TASK_QUEUE = "delegate-public-runtime";
    const client = new FakeCreatorTrainingWorkflowClient();
    await enqueueCreatorTrainingReviewWorkflow("lin", {
      now: new Date("2026-07-04T12:10:00.000Z"),
    }, client);

    const second = await enqueueCreatorTrainingReviewWorkflow("lin", {
      now: new Date("2026-07-04T12:50:00.000Z"),
    }, client);

    expect(second.id).toBe("workflow-1");
    expect(client.workflowRun.createCalls).toHaveLength(1);
  });
});

type WorkflowRow = {
  id: string;
  kind: string;
  engine: string;
  status: string;
  dedupeKey: string;
  queueName: string | null;
  externalWorkflowId: string | null;
  scheduledAt: Date;
  nextWakeAt: Date | null;
  createdAt: Date;
};

class FakeCreatorTrainingWorkflowClient {
  representatives = [{ id: "rep-1", slug: "lin" }];
  workflows: WorkflowRow[] = [];

  $transaction = async (callback: any) => callback(this);

  representative = {
    findUnique: async (args: any) =>
      this.representatives.find((rep) => rep.slug === args.where.slug) ?? null,
  };

  workflowRun = {
    createCalls: [] as any[],
    findUnique: async (args: any) =>
      this.workflows.find((workflow) => workflow.dedupeKey === args.where.dedupeKey) ?? null,
    create: async (args: any) => {
      this.workflowRun.createCalls.push(args);
      const workflow: WorkflowRow = {
        id: `workflow-${this.workflows.length + 1}`,
        kind: args.data.kind,
        engine: args.data.engine,
        status: args.data.status,
        dedupeKey: args.data.dedupeKey,
        queueName: args.data.queueName,
        externalWorkflowId: args.data.externalWorkflowId,
        scheduledAt: args.data.scheduledAt,
        nextWakeAt: args.data.nextWakeAt ?? null,
        createdAt: args.data.scheduledAt,
      };
      this.workflows.push(workflow);
      return workflow;
    },
  };

  eventAudit = {
    createCalls: [] as any[],
    create: async (args: any) => {
      this.eventAudit.createCalls.push(args);
      return { id: `event-${this.eventAudit.createCalls.length}` };
    },
  };
}
