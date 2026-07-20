export async function saveRepresentativeSetupRequests(params: {
  representativeSlug: string;
  setup: unknown;
  knowledgeAssetIds: string[];
  bindingChanged: boolean;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = params.fetchImpl ?? fetch;
  const [setupResponse, bindingResponse] = await Promise.all([
    fetchImpl(`/api/dashboard/representatives/${params.representativeSlug}/setup`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params.setup),
    }),
    params.bindingChanged
      ? fetchImpl(`/api/dashboard/representatives/${params.representativeSlug}/knowledge-assets`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assetIds: params.knowledgeAssetIds }),
        })
      : Promise.resolve(null),
  ]);

  return { setupResponse, bindingResponse };
}
