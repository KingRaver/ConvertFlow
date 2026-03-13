import fs from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { FileStore } from "./index";

const DOWNLOAD_TTL_SECONDS = 15 * 60;

function getRequiredEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required when STORAGE_DRIVER=s3.`);
  }

  return value;
}

function buildAttachmentDisposition(filename: string) {
  const fallback = filename.replace(/[^A-Za-z0-9._-]+/g, "_") || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export class S3FileStore implements FileStore {
  readonly driver = "s3" as const;

  private readonly bucket = getRequiredEnv("AWS_BUCKET");
  private readonly client = new S3Client({
    credentials: {
      accessKeyId: getRequiredEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: getRequiredEnv("AWS_SECRET_ACCESS_KEY"),
    },
    region: getRequiredEnv("AWS_REGION"),
  });

  async save(localPath: string, key: string) {
    try {
      await this.client.send(
        new PutObjectCommand({
          Body: await fs.readFile(localPath),
          Bucket: this.bucket,
          Key: key,
        }),
      );
      console.info(`[filestore/s3] Uploaded: ${key}`);
    } catch (error) {
      throw new Error(`S3 upload failed for ${key}: ${(error as Error).message}`);
    }
  }

  async get(key: string, localPath: string) {
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
    } catch (error) {
      throw new Error(`S3 download failed for ${key}: ${(error as Error).message}`);
    }

    if (!response.Body || typeof response.Body.transformToByteArray !== "function") {
      throw new Error(`S3 returned empty body for: ${key}`);
    }

    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, Buffer.from(await response.Body.transformToByteArray()));
    console.info(`[filestore/s3] Retrieved: ${key}`);
  }

  async delete(key: string) {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      console.info(`[filestore/s3] Deleted: ${key}`);
    } catch (error) {
      throw new Error(`S3 delete failed for ${key}: ${(error as Error).message}`);
    }
  }

  async exists(key: string) {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async getDownloadUrl(key: string, filename: string) {
    try {
      const url = await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ResponseContentDisposition: buildAttachmentDisposition(filename),
        }),
        {
          expiresIn: DOWNLOAD_TTL_SECONDS,
        },
      );
      console.info(`[filestore/s3] Generated pre-signed URL for: ${key}`);
      return url;
    } catch (error) {
      throw new Error(`S3 pre-sign failed for ${key}: ${(error as Error).message}`);
    }
  }
}
