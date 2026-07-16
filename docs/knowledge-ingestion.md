# Knowledge ingestion and storage

Delegate treats a knowledge asset as three coordinated records:

1. The immutable source file is stored in the private S3-compatible bucket `delegate-1324808004`.
2. Postgres stores ownership, permissions, source object coordinates, normalized text, processing state, checksums, and vector-index metadata.
3. OpenViking stores the parsed semantic resource and its vector index. Each asset has a workspace URI, with additional representative-scoped copies only for enabled and approved bindings.

## Processing lifecycle

`POST /api/dashboard/knowledge-assets` persists the original file before it creates a `PROCESSING` database row. Next.js post-response work then reloads the source object, parses PDF/DOCX/TXT/Markdown content, normalizes it, computes SHA-256, prepares overlapping retrieval chunks, and waits for OpenViking indexing. The asset changes to `READY` only after this completes.

Reprocessing always reads the original object again, so parser upgrades apply to existing assets. Failed extraction or indexing leaves the asset in `FAILED` with an ordered processing log and a retry action.

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
