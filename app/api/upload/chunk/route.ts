import { db } from "@/db";
import { uploadChunkTable } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireApiUserSession } from "@/lib/session-server";
import { createHttpError, toErrorResponse } from "@/lib/api-error";

const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

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

    await db.insert(uploadChunkTable).values({
      uploadId,
      userId: user.id,
      chunkIdx: idx,
      data: buffer,
    }).onConflictDoUpdate({
      target: [uploadChunkTable.uploadId, uploadChunkTable.chunkIdx],
      set: { data: buffer, createdAt: new Date() },
      setWhere: eq(uploadChunkTable.userId, user.id),
    });

    return Response.json({ status: "success" });
  } catch (error: any) {
    if (!error?.status || error.status >= 500) console.error(error);
    return toErrorResponse(error);
  }
}
