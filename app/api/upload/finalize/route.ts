import { db } from "@/db";
import { uploadChunkTable } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { requireApiUserSession } from "@/lib/session-server";
import { createHttpError, toErrorResponse } from "@/lib/api-error";
import { getToken } from "@/lib/token";
import { getConfig } from "@/lib/config-store";
import { getSchemaByName } from "@/lib/schema";
import { getFileExtension, getFileName, normalizePath } from "@/lib/utils/file";
import { resolveCommitIdentity } from "@/lib/commit-message";
import { githubSaveFile } from "@/lib/utils/github-save-file";
import { updateFileCache } from "@/lib/github-cache-file";

const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_CHUNKS = 50;

export async function POST(request: Request) {
  try {
    const sessionResult = await requireApiUserSession();
    if ("response" in sessionResult) return sessionResult.response;
    const user = sessionResult.user;

    const data: any = await request.json();
    const uploadId = typeof data.uploadId === "string" ? data.uploadId : "";
    const totalChunks = Number.isInteger(data.totalChunks) ? data.totalChunks : -1;
    const owner = typeof data.owner === "string" ? data.owner : "";
    const repo = typeof data.repo === "string" ? data.repo : "";
    const branch = typeof data.branch === "string" ? data.branch : "";
    const path = typeof data.path === "string" ? data.path : "";
    const name = typeof data.name === "string" ? data.name : "";
    const sha = typeof data.sha === "string" ? data.sha : undefined;
    const onConflict = data.onConflict === "error" ? "error" : "rename";

    if (!uploadId || uploadId.length > 64) throw createHttpError(`Invalid "uploadId".`, 400);
    if (totalChunks < 1 || totalChunks > MAX_CHUNKS) {
      throw createHttpError(`"totalChunks" must be between 1 and ${MAX_CHUNKS}.`, 400);
    }
    if (!owner || !repo || !branch || !path || !name) {
      throw createHttpError(`Missing required fields.`, 400);
    }

    const { token } = await getToken(user, owner, repo, true);
    if (!token) throw new Error("Token not found");

    const normalizedPath = normalizePath(path);

    const config = await getConfig(owner, repo, branch, { getToken: async () => token });
    if (!config) throw new Error(`Configuration not found for ${owner}/${repo}/${branch}.`);

    const schema = getSchemaByName(config.object, name, "media");
    if (!schema) throw new Error(`Media schema not found for ${name}.`);
    if (!normalizedPath.startsWith(schema.input)) {
      throw new Error(`Invalid path "${path}" for media "${name}".`);
    }
    if (
      schema.extensions?.length > 0 &&
      !schema.extensions.includes(getFileExtension(normalizedPath))
    ) {
      throw new Error(`Invalid extension "${getFileExtension(normalizedPath)}" for media.`);
    }
    if (getFileName(normalizedPath) === ".gitkeep") {
      throw createHttpError(`Use the files endpoint to create empty folders.`, 400);
    }

    const chunks = await db
      .select({ chunkIdx: uploadChunkTable.chunkIdx, data: uploadChunkTable.data })
      .from(uploadChunkTable)
      .where(and(
        eq(uploadChunkTable.uploadId, uploadId),
        eq(uploadChunkTable.userId, user.id),
      ))
      .orderBy(asc(uploadChunkTable.chunkIdx));

    if (chunks.length !== totalChunks) {
      throw createHttpError(
        `Expected ${totalChunks} chunks but found ${chunks.length}.`,
        400,
      );
    }
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].chunkIdx !== i) {
        throw createHttpError(`Missing chunk at index ${i}.`, 400);
      }
    }

    const buffers = chunks.map(c => Buffer.from(c.data, "base64"));
    const totalSize = buffers.reduce((acc, b) => acc + b.length, 0);
    if (totalSize > MAX_TOTAL_BYTES) {
      throw createHttpError(
        `File too large (${totalSize} bytes). Max ${MAX_TOTAL_BYTES} bytes.`,
        413,
      );
    }
    const contentBase64 = Buffer.concat(buffers).toString("base64");

    const schemaCommitTemplates = schema?.commit?.templates;
    const schemaCommitIdentity = schema?.commit?.identity;
    const commitIdentity = resolveCommitIdentity({
      configObject: config.object,
      identityOverride: schemaCommitIdentity,
    });
    const committer = (commitIdentity === "user" && user.email)
      ? { name: user.name?.trim() || user.email, email: user.email }
      : undefined;

    const response = await githubSaveFile(
      token,
      owner,
      repo,
      branch,
      normalizedPath,
      contentBase64,
      sha,
      {
        configObject: config.object,
        templatesOverride: schemaCommitTemplates,
        contentName: name,
        user: user.email || user.name || String(user.id || ""),
        onConflict,
        committer,
      }
    );

    const savedPath = response?.data.content?.path;

    if (response?.data.content && response?.data.commit) {
      await updateFileCache(
        'media',
        owner,
        repo,
        branch,
        {
          type: sha ? 'modify' : 'add',
          path: response.data.content.path!,
          sha: response.data.content.sha!,
          content: Buffer.from(contentBase64, 'base64').toString('utf-8'),
          size: response.data.content.size,
          downloadUrl: response.data.content.download_url,
          commit: {
            sha: response.data.commit.sha!,
            timestamp: new Date(response.data.commit.committer?.date ?? new Date().toISOString()).getTime()
          }
        }
      );
    }

    await db.delete(uploadChunkTable).where(and(
      eq(uploadChunkTable.uploadId, uploadId),
      eq(uploadChunkTable.userId, user.id),
    ));

    return Response.json({
      status: "success",
      message: savedPath !== normalizedPath
        ? `File "${normalizedPath}" saved successfully but renamed to "${savedPath}" to avoid naming conflict.`
        : `File "${normalizedPath}" saved successfully.`,
      data: {
        type: response?.data.content?.type,
        sha: response?.data.content?.sha,
        name: response?.data.content?.name,
        path: savedPath,
        extension: getFileExtension(response?.data.content?.name || ""),
        size: response?.data.content?.size,
        url: response?.data.content?.download_url,
      }
    });
  } catch (error: any) {
    if (!error?.status || error.status >= 500) console.error(error);
    return toErrorResponse(error);
  }
}
