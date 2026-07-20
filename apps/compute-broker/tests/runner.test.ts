import { describe, expect, it } from "vitest";

import {
  buildDockerCreateLeaseArgs,
  buildDockerExecArgs,
  buildDockerLeaseContainerName,
  buildDockerLeaseVolumeName,
} from "../src/runner";

describe("docker lease runner", () => {
  it("creates an isolated reusable lease container with a mounted session volume", () => {
    const args = buildDockerCreateLeaseArgs({
      image: "debian:bookworm-slim",
      hostWorkspaceRoot: "/Users/a/repos/Delegate",
      networkMode: "no_network",
      filesystemMode: "read_only_workspace",
      sessionId: "session_1234567890",
    });

    expect(args).toContain("-d");
    expect(args).toContain("--network");
    expect(args).toContain("none");
    expect(args).toContain("--read-only");
    expect(args).toContain("/Users/a/repos/Delegate:/workspace:ro");
    expect(args).toContain(`${buildDockerLeaseVolumeName("session_1234567890")}:/delegate-session:rw`);
    expect(args).toContain(buildDockerLeaseContainerName("session_1234567890"));
  });

  it("does not silently grant full egress when the policy says allowlist", () => {
    const args = buildDockerCreateLeaseArgs({
      image: "debian:bookworm-slim",
      hostWorkspaceRoot: "/Users/a/repos/Delegate",
      networkMode: "allowlist",
      filesystemMode: "workspace_only",
      sessionId: "session_allowlist_1234",
    });

    expect(args).toContain("--network");
    expect(args).toContain("none");
  });

  it("mounts only the private lease volume into an ephemeral workspace", () => {
    const sessionId = "public_session_1234";
    const args = buildDockerCreateLeaseArgs({
      image: "debian:bookworm-slim",
      hostWorkspaceRoot: "/Users/a/repos/Delegate",
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      sessionId,
    });

    expect(args).not.toContain("/Users/a/repos/Delegate:/workspace:rw");
    expect(args).toContain(`${buildDockerLeaseVolumeName(sessionId)}:/workspace:rw`);
  });

  it("executes commands inside the existing lease container", () => {
    const args = buildDockerExecArgs({
      lease: {
        runnerType: "docker",
        leaseId: "delegate-lease-vol-session123",
        containerId: "delegate-lease-session123",
        containerName: "delegate-lease-session123",
        sessionRoot: "/delegate-session",
      },
      command: "pwd",
      filesystemMode: "workspace_only",
      workingDirectory: "apps/bot",
    });

    expect(args[0]).toBe("exec");
    expect(args).toContain("delegate-lease-session123");
    expect(args).toContain("/workspace/apps/bot");
  });

  it("uses the session root for ephemeral-full exec working directories", () => {
    const args = buildDockerExecArgs({
      lease: {
        runnerType: "docker",
        leaseId: "delegate-lease-vol-session456",
        containerId: "delegate-lease-session456",
        containerName: "delegate-lease-session456",
        sessionRoot: "/delegate-session",
      },
      command: "pwd",
      filesystemMode: "ephemeral_full",
      workingDirectory: "scratch",
    });

    expect(args).toContain("/delegate-session/scratch");
  });
});
