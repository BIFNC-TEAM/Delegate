import type { KnowledgeAssetRecord } from "@delegate/web-data";
export type FileUploadResponse = {
  asset: KnowledgeAssetRecord;
  upload: {
    outcome: "created" | "replaced" | "skipped_duplicate";
    conflictType?: "exact" | "same_name";
    conflictAssetId?: string;
  };
};

export function uploadKnowledgeFile(
  activeSlug: string,
  form: FormData,
  onProgress: (progress: number) => void,
): Promise<FileUploadResponse> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/dashboard/knowledge-assets");
    request.setRequestHeader("X-Delegate-Representative", activeSlug);
    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      onProgress(
        Math.max(
          1,
          Math.min(78, Math.round((event.loaded / event.total) * 78)),
        ),
      );
    });
    request.addEventListener("load", () => {
      let payload: (FileUploadResponse & { error?: string }) | null = null;
      try {
        payload = JSON.parse(request.responseText) as FileUploadResponse & {
          error?: string;
        };
      } catch {
        reject(new Error(`Request failed (${request.status || 0})`));
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        reject(
          new Error(payload.error || `Request failed (${request.status})`),
        );
        return;
      }
      onProgress(80);
      resolve(payload);
    });
    request.addEventListener("error", () =>
      reject(new Error("Network error while uploading file")),
    );
    request.addEventListener("abort", () =>
      reject(new Error("File upload was cancelled")),
    );
    request.send(form);
  });
}
