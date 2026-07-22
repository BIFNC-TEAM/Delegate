import { posix as pathPosix } from "node:path";

import { SessionError } from "./session-error";

export function normalizeContainerPath(rawPath: string) {
  const trimmed = rawPath.trim();
  const normalized = pathPosix.normalize(
    trimmed.startsWith("/") ? trimmed : `/workspace/${trimmed}`,
  );

  if (isWithinDirectory(normalized, "/workspace") || isWithinDirectory(normalized, "/tmp")) {
    return normalized;
  }

  throw new SessionError(400, "path_outside_allowed_workspace");
}

function isWithinDirectory(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`);
}
