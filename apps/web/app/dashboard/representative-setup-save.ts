export async function saveRepresentativeSetupRequests(params: {
  representativeSlug: string;
  setup: unknown;
  knowledgeAssetIds: string[];
  bindingChanged: boolean;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = params.fetchImpl ?? fetch;
  const setupResponse = await fetchImpl(
    `/api/dashboard/representatives/${params.representativeSlug}/setup`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params.setup),
    },
  );
  let bindingResponse: Response | null = null;
  let bindingError: unknown = null;
  if (setupResponse.ok && params.bindingChanged) {
    try {
      bindingResponse = await fetchImpl(
        `/api/dashboard/representatives/${params.representativeSlug}/knowledge-assets`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assetIds: params.knowledgeAssetIds }),
        },
      );
    } catch (error) {
      // Preserve the successful setup response so the caller can adopt its
      // committed revision even when the follow-up binding request never
      // receives an HTTP response.
      bindingError = error;
    }
  }

  return { setupResponse, bindingResponse, bindingError };
}
