# Knowledge ingestion and storage

Delegate treats a knowledge asset as three coordinated records:

1. The source file is stored in the private S3-compatible bucket `delegate-1324808004` under an owner/date/UUID key, so identical filenames never collide at the object-storage layer.
2. Postgres stores ownership, permissions, source object coordinates, normalized text, processing state, checksums, and vector-index metadata.
3. OpenViking stores the parsed semantic resource and its vector index. Each asset has a workspace URI, with additional representative-scoped copies only for enabled and approved bindings.

## Processing lifecycle

`POST /api/dashboard/knowledge-assets` persists the original file before it creates a `PROCESSING` database row. Next.js post-response work then reloads the source object, parses PDF/DOCX/PPTX/XLSX/PNG/JPG/TXT/Markdown content, normalizes it, computes SHA-256, prepares overlapping retrieval chunks, and waits for OpenViking indexing. The asset changes to `READY` only after this completes.

When `MINERU_API_BASE_URL` is configured, PDF, DOCX, PPTX, XLSX, PNG, JPG, and JPEG files are submitted to MinerU's asynchronous FastAPI task API first. Delegate polls only the configured origin, ignores server-returned result URLs, requests Markdown without images or the original file, and then stores the normalized Markdown as the extracted source. Searchable PDF and DOCX files retain local PDF.js/OOXML fallback when MinerU is unavailable. PPTX, XLSX, images, and scanned PDFs fail with an actionable MinerU error rather than creating an empty index. TXT and Markdown remain local-only parsers.

The dashboard accepts up to 20 files in one queue and uploads at most three concurrently. Browser upload progress is reported per file; parsing and indexing are then polled separately. A failed upload can retransmit the original file, while an asset that was stored but failed during parsing/indexing uses the existing reprocess action.

## Browser capture and manual verification

The URL import dialog supports two paths:

Local Docker development mounts both the source and the collector assets through `compose.local.yml`. After changing package subpath exports, restart the Dashboard so Turbopack reloads package metadata. After adding the public-assets mount, apply it with `bash scripts/docker-compose-local.sh up -d --no-deps dashboard`.

- **Browser capture (default):** use the Owner's local Chrome or Edge session to open the source, sign in or complete website verification manually, and collect the visible text. Internal/VPN addresses and domains resolved through a local proxy are supported because the Dashboard receives a text snapshot rather than fetching that URL. HTTP/HTTPS source URLs without embedded credentials are accepted. The server's public-URL network checks remain in place for direct fetches.
- **Direct fetch:** the existing unauthenticated server request for public pages. HTTP 401/403/429 and recognized verification-page titles direct the Owner to browser capture. The server does not solve CAPTCHAs or inherit browser cookies.

Download the local collector from the import dialog, unzip it, and load the unpacked extension in Chrome or Edge's extension manager. The bundle lives in `apps/web/public/knowledge-collector/`; its only permissions are `activeTab` and `scripting`. It has no background worker, cookie access, persistent host access, or outbound upload endpoint. The Owner clicks the extension after verification, previews the text, and saves a `.delegate-webpage.json` file. The file contains the final source URL, title, text, and capture time; treat it with the same confidentiality as the source page.

Select the capture file in the URL import dialog, inspect the final URL and editable text preview, choose visibility and representative bindings, then explicitly confirm import. Changing the preview requires confirmation again. Until submission there is no persisted knowledge job; closing the dialog cancels the pending import. The file is bounded to 3 MiB and the text to 20–400,000 characters. Known login/verification titles, unsupported formats, unknown fields, credential-bearing URLs, and non-HTTP schemes are rejected.

Snapshots remain `kind=url` with `sourceUrl` and `sourceText` persisted. Reprocessing uses the saved text and records the extraction backend as `browser_capture`; it does not revisit the original website. For existing failed URL assets, **Capture in browser** in the details drawer supplies a snapshot in place via an authenticated, Owner-scoped endpoint. It preserves the asset ID, title, tags, visibility and bindings and claims the failed-to-processing transition atomically. Archived, already-processing, ready, non-URL and another Owner's assets cannot be replaced through this repair endpoint.

The collector reads the selected text, or prefers visible `article`/`main` content before falling back to the page body. The user must expand or scroll lazy-loaded content first. It does not capture browser PDF viewers, text drawn in canvas/images, cross-origin iframe bodies, closed shadow roots, or content the logged-in account cannot view. A capture is user-supplied knowledge, not cryptographic proof of a website's contents. Some sites will still refuse access even in a normal browser; keep manual text and file import available.

### Verification

```bash
pnpm exec vitest run packages/web-data/tests/knowledge-web-capture.test.ts apps/web/tests/knowledge-browser-capture-routes.test.ts
```

For the actual Chromium/UI smoke test, start an isolated local Dashboard with no database and authentication optional (never change a shared deployment):

```bash
DATABASE_URL='' OPENVIKING_ENABLED=false DELEGATE_DASHBOARD_AUTH_MODE=optional NEXT_PUBLIC_DASHBOARD_URL=http://localhost:3311 pnpm --filter @delegate/dashboard exec next dev --hostname 127.0.0.1 --port 3311
```

In a second terminal run `node scripts/tests/knowledge-browser-capture.mjs`. It uses an existing Playwright installation; set `BROWSER_CAPTURE_PLAYWRIGHT_MODULE` to that installation's absolute `index.mjs` path if Playwright is supplied by local QA tooling. No browser dependency is added to the application. The smoke test runs a local login fixture, tests actual DOM capture, preview confirmation, import, and failed-asset repair. Its assets remain in the isolated demo process's memory. Screenshots and results are written to `/tmp/delegate-browser-capture-test` by default.

## Duplicate and overwrite behavior

The API hashes file bytes before object storage and checks only active, non-archived assets owned by the current workspace owner:

- `skip_duplicates` (default): byte-identical content returns the existing asset without writing another object. A same-name file with different content is stored as a new asset and receives a numbered title such as `Guide (2)`.
- `keep_both`: always creates a new asset and a unique object key; title collisions receive a numeric suffix.
- `replace_existing`: replaces the exact-content match first, otherwise the active same-name match. The existing asset ID, title, tags, visibility, and representative links remain stable. Delegate writes the new object first, removes the old vector resource, switches the source metadata, rebuilds extraction and vectors, and then deletes the previous object.

Archived assets do not participate in conflict detection. Uploading their former filename or content creates a new active asset; restoring an archive remains an explicit action.

For uploaded files, reprocessing always reads the original object again, so parser upgrades apply to existing assets. Failed extraction or indexing leaves the asset in `FAILED` with an ordered processing log and a retry action.

## MinerU configuration

Delegate integrates with a trusted, self-hosted MinerU FastAPI service. Start `mineru-api` according to the MinerU deployment documentation, then configure:

```dotenv
MINERU_API_BASE_URL="http://127.0.0.1:8000"
MINERU_DOCKER_API_BASE_URL="http://host.docker.internal:8000"
MINERU_API_TOKEN=""
MINERU_API_TIMEOUT_MS="600000"
MINERU_API_POLL_INTERVAL_MS="1000"
MINERU_PARSE_METHOD="auto"
MINERU_LANGUAGE="ch"
MINERU_BACKEND=""
```

`MINERU_DOCKER_API_BASE_URL` is forwarded only to the Dashboard container and takes precedence there; it is useful when MinerU runs on the host. Keep `MINERU_API_TOKEN` blank for an unprotected private service, or set it when a trusted reverse proxy requires a Bearer token. Leaving `MINERU_BACKEND` blank lets the MinerU server select its configured default. Uploaded files may contain private Owner knowledge, so the configured endpoint must be trusted and transport security must match the deployment boundary.

For the staging deployment, set `MINERU_STAGING_API_BASE_URL` and optionally `MINERU_STAGING_API_TOKEN` in the private source environment. The staging environment generator maps them to the Dashboard runtime variables and defaults `MINERU_BACKEND` to `pipeline`. See the [MinerU GPU deployment runbook](../deploy/mineru/README.md) for the WireGuard topology and proxy hardening requirements.

MinerU's official GPU Docker deployment is intended for Linux/WSL2, not Docker Desktop on macOS. On Apple Silicon, run the native MinerU CLI/API on the host or use a remote Linux MinerU service, then point the Dashboard container at `host.docker.internal` or the remote HTTPS origin.

Archive removes the asset's workspace and representative OpenViking resources before marking the row archived. Restore rebuilds the vector index. Permanent deletion is allowed only after archive and removes both the source object and database row.

## Tencent COS production configuration

COS is S3-compatible. Configure:

```dotenv
KNOWLEDGE_OBJECT_STORE_ENDPOINT="https://cos.ap-guangzhou.myqcloud.com"
KNOWLEDGE_OBJECT_STORE_BUCKET="delegate-1324808004"
KNOWLEDGE_OBJECT_STORE_REGION="ap-guangzhou"
KNOWLEDGE_OBJECT_STORE_FORCE_PATH_STYLE="false"
KNOWLEDGE_OBJECT_STORE_ACCESS_KEY="..."
KNOWLEDGE_OBJECT_STORE_SECRET_KEY="..."
```

Never commit cloud credentials. Local Compose uses the same bucket name in MinIO and keeps it private.
