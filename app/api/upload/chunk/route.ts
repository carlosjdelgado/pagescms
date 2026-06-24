import { after } from "next/server";
import { db } from "@/db";
import { uploadChunkTable } from "@/db/schema";
import { eq, lt } from "drizzle-orm";
import { requireApiUserSession } from "@/lib/session-server";
import { createHttpError, toErrorResponse } from "@/lib/api-error";

const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const STALE_CHUNK_AGE_MS = 60 * 60 * 1000;

export async function POST(request: Request) {
  try {
    const sessionResult = await requireApiUserSession();
    if ("response" in sessionResult) return sessionResult.response;
    const user = sessionResult.user;

    const formData = await request.formData();
    const uploadId = formData.get("uploadId");
    const idxRaw = formData.get("idx");
    const chunk = formData.get("chunk");

    if (typeof uploadId !== "string" || uploadId.length === 0 || uploadId.length > 64) {
      throw createHttpError(`Invalid "uploadId".`, 400);
    }
    const idx = typeof idxRaw === "string" ? parseInt(idxRaw, 10) : NaN;
    if (!Number.isInteger(idx) || idx < 0 || idx > 9999) {
      throw createHttpError(`Invalid "idx".`, 400);
    }
    if (!(chunk instanceof Blob)) {
      throw createHttpError(`Invalid "chunk".`, 400);
    }
    if (chunk.size === 0 || chunk.size > MAX_CHUNK_BYTES) {
      throw createHttpError(`Chunk size must be between 1 and ${MAX_CHUNK_BYTES} bytes.`, 413);
    }

    const buffer = Buffer.from(await chunk.arrayBuffer());
    const base64 = buffer.toString("base64");

    await db.insert(uploadChunkTable).values({
      uploadId,
      userId: user.id,
      chunkIdx: idx,
      data: base64,
    }).onConflictDoUpdate({
      target: [uploadChunkTable.uploadId, uploadChunkTable.chunkIdx],
      set: { data: base64, createdAt: new Date() },
      setWhere: eq(uploadChunkTable.userId, user.id),
    });

    // ponytail: oportunistic stale-chunk cleanup runs after the response; cron-free housekeeping for Hobby
    after(async () => {
      try {
        await db.delete(uploadChunkTable).where(
          lt(uploadChunkTable.createdAt, new Date(Date.now() - STALE_CHUNK_AGE_MS)),
        );
      } catch (error) {
        console.error("Stale chunk cleanup failed", error);
      }
    });

    return Response.json({ status: "success" });
  } catch (error: any) {
    if (!error?.status || error.status >= 500) console.error(error);
    return toErrorResponse(error);
  }
}
