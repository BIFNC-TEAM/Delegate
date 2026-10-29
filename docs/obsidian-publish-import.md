# Obsidian Publish import

Entry: Knowledge Library → Import → Third-party import → Obsidian Publish.

## Supported flow

- Public HTTPS Publish sites, including custom domains and path prefixes.
- A site URL lists notes; a note URL also selects that note by default.
- Read the site's sitemap without executing JavaScript or downloading its rich cache or note bodies.
- Select notes or folders, then add their Markdown to the existing upload queue. Preview, naming conflicts, permissions, indexing and retries use the existing Obsidian pipeline.
- Missing/unreadable/truncated sitemaps show an incomplete-list notice. Users can add same-site note URLs; those bodies are read only after selection.
- Password-protected sites are unsupported. No account connection, cookies or Sync credentials are used.
- Notes are snapshots. No background synchronization, automatic linked-note download or multimedia download.

## Implementation boundaries

- `packages/web-data/src/obsidian-publish.ts`: public-network transport, Publish identification, sitemap discovery and selected Markdown reads.
- `apps/web/app/api/dashboard/obsidian-publish/route.ts`: owner authentication, request validation, cancellation and private responses.
- `knowledge-obsidian-publish.tsx`: URL input, shared directory tree, explicit selection, bounded batches and cancel control.
- `knowledge-obsidian-import.tsx`: shared note preparation and collision handling.
- Provenance is stored as optional `obsidianImport.publishSource` JSON metadata; the asset's `sourceUrl` supports opening the original. No database migration is required.

Publish's `siteInfo` and `preloadPage` are website implementation details, not a documented stable third-party API. Keep their parsing in the adapter. A changed/unrecognized shell must fail explicitly, never import its title as note text. Permalinks are resolved to the actual Markdown path only when reading a selected note. Before selection, directory labels reflect public URL paths.

Transport validates public IPv4 DNS results and pins the address to the TLS connection, validates every redirect, accepts HTTPS only, limits response sizes and never executes site JavaScript. IPv6-only origins currently return an access error. Listing is capped at 5,000 entries with an incomplete notice; selection uses the existing 1,000-note / 40 MB limits. Client download requests contain up to 8 selected URLs; the adapter reads at most 4 concurrently. Cancelling discards that pending selection's downloaded files without adding a partial batch to the queue.

## Verification

Automated coverage: metadata-only listing, selected-only reads, missing sitemap fallback, custom-domain prefixes, permalinks, cross-site rejection, HTML-shell rejection, source metadata validation, private-network blocking and owner/origin checks.

Live samples verified: `https://publish.obsidian.md/tasks/Introduction` (107 sitemap entries) and `https://help.obsidian.md/publish` (179 entries at its redirected custom-domain site). One Tasks Introduction note was imported through the browser into the local database with Owner-only visibility and reached Ready, including OpenViking indexing. These counts describe the verification samples, not a guarantee that every site's sitemap includes every published note.

For a manual regression: import a single note, confirm only one checkbox is selected, preview it, upload it, open its provenance, then repeat to check numbered copies. Test a folder selection, add a missing same-site link, reject a different-site link, and cancel a download. Test local and Sync tabs after changes to the shared tree.
