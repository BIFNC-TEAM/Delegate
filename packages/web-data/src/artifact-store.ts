import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { artifactStoreConfigSchema } from "@delegate/artifacts";

const artifactStoreConfig = artifactStoreConfigSchema.parse({
  endpoint: process.env.ARTIFACT_STORE_ENDPOINT?.trim() || "http://localhost:9000",
  bucket: process.env.ARTIFACT_STORE_BUCKET?.trim() || "delegate-compute-artifacts",
  accessKeyId: process.env.ARTIFACT_STORE_ACCESS_KEY?.trim() || "delegate",
  secretAccessKey: process.env.ARTIFACT_STORE_SECRET_KEY?.trim() || "delegate-secret-key",
  region: process.env.ARTIFACT_STORE_REGION?.trim() || "us-east-1",
  forcePathStyle: true,
});

const artifactClient = new S3Client({
  region: artifactStoreConfig.region,
  endpoint: artifactStoreConfig.endpoint,
  forcePathStyle: artifactStoreConfig.forcePathStyle,
  credentials: {
    accessKeyId: artifactStoreConfig.accessKeyId,
    secretAccessKey: artifactStoreConfig.secretAccessKey,
  },
});

export function getArtifactStoreBucket() {
  return artifactStoreConfig.bucket;
}

export async function readArtifactObject(objectKey: string): Promise<{
  buffer: Buffer;
  contentType?: string;
}> {
  const response = await artifactClient.send(
    new GetObjectCommand({
      Bucket: artifactStoreConfig.bucket,
      Key: objectKey,
    }),
  );

  const chunks: Buffer[] = [];
  const body = response.Body;
  if (!body) {
    return {
      buffer: Buffer.alloc(0),
      ...(response.ContentType ? { contentType: response.ContentType } : {}),
    };
  }

  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }

  return {
    buffer: Buffer.concat(chunks),
    ...(response.ContentType ? { contentType: response.ContentType } : {}),
  };
}

export async function writeArtifactObject(params: {
  objectKey: string;
  body: Buffer;
  contentType: string;
}) {
  await artifactClient.send(
    new PutObjectCommand({
      Bucket: artifactStoreConfig.bucket,
      Key: params.objectKey,
      Body: params.body,
      ContentType: params.contentType,
    }),
  );
}

export async function deleteArtifactObject(objectKey: string) {
  await artifactClient.send(
    new DeleteObjectCommand({
      Bucket: artifactStoreConfig.bucket,
      Key: objectKey,
    }),
  );
}
