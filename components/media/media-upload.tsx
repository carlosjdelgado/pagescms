"use client";

import { useRef, cloneElement, useMemo, useCallback, createContext, useContext, useState } from "react";
import { useConfig } from "@/contexts/config-context";
import { getUploadFileName, joinPathSegments } from "@/lib/utils/file";
import { toast } from "sonner";
import { getSchemaByName } from "@/lib/schema";
import { cn } from "@/lib/utils";
import { requireApiSuccess } from "@/lib/api-client";
import type { FileSaveData } from "@/types/api";

interface MediaUploadContextValue {
  handleFiles: (files: File[]) => Promise<void>;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
}

const MediaUploadContext = createContext<MediaUploadContextValue | null>(null);

interface MediaUploadProps {
  children: React.ReactNode;
  path?: string;
  onUpload?: (entry: FileSaveData) => void;
  media?: string;
  extensions?: string[];
  multiple?: boolean;
  rename?: boolean | "safe" | "random";
  disabled?: boolean;
}

interface MediaUploadTriggerProps {
  children: React.ReactElement<{ onClick?: () => void }>;
}

interface MediaUploadDropZoneProps {
  children: React.ReactNode;
  className?: string;
}

function MediaUploadRoot({ children, path, onUpload, media, extensions, multiple, rename, disabled = false }: MediaUploadProps) {
  const { config } = useConfig();
  if (!config) throw new Error(`Configuration not found.`);

  const configMedia = useMemo(() => 
    media
      ? getSchemaByName(config.object, media, "media")
      : config.object.media[0],
    [media, config.object]
  );

  const accept = useMemo(() => {
    if (!configMedia?.extensions && !extensions) return undefined;
    
    const allowedExtensions = extensions 
      ? configMedia?.extensions
        ? extensions.filter(ext => configMedia.extensions.includes(ext))
        : extensions
      : configMedia?.extensions;

    return allowedExtensions?.length > 0
      ? allowedExtensions.map((extension: string) => `.${extension}`).join(",")
      : undefined;
  }, [extensions, configMedia?.extensions]);

  const handleFiles = useCallback(async (files: File[]) => {
    // ponytail: 3 MB keeps base64 + JSON envelope under Vercel's 4.5 MB body limit
    const DIRECT_UPLOAD_BYTES = 3 * 1024 * 1024;
    // ponytail: 4 MB binary fits in multipart body (overhead < 1 KB); raise above 4 MB at your own risk
    const CHUNK_BYTES = 4 * 1024 * 1024;
    const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
    const CHUNK_CONCURRENCY = 4;

    const readAsBase64 = (file: File) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).replace(/^(.+,)/, ""));
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });

    try {
      for (const file of files) {
        const uploadFilename = getUploadFileName(
          file.name,
          rename ?? configMedia?.rename,
        );
        const fullPath = joinPathSegments([path ?? "", uploadFilename]);

        const uploadPromise = (async () => {
          if (file.size === 0) throw new Error("File is empty");
          if (file.size > MAX_TOTAL_BYTES) {
            throw new Error(`File too large. Max ${Math.floor(MAX_TOTAL_BYTES / 1024 / 1024)} MB.`);
          }

          if (file.size <= DIRECT_UPLOAD_BYTES) {
            const content = await readAsBase64(file);
            const response = await fetch(`/api/${config.owner}/${config.repo}/${encodeURIComponent(config.branch)}/files/${encodeURIComponent(fullPath)}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "media", name: configMedia.name, content }),
            });
            const data = await requireApiSuccess<any>(response, "Failed to upload file");
            return data.data as FileSaveData;
          }

          const uploadId = crypto.randomUUID();
          const totalChunks = Math.ceil(file.size / CHUNK_BYTES);
          const stagedChunks = totalChunks - 1; // ponytail: last chunk rides inline in finalize

          const uploadChunk = async (idx: number) => {
            const start = idx * CHUNK_BYTES;
            const end = Math.min(start + CHUNK_BYTES, file.size);
            const blob = file.slice(start, end);
            const form = new FormData();
            form.set("uploadId", uploadId);
            form.set("idx", String(idx));
            form.set("chunk", blob);
            const chunkResponse = await fetch("/api/upload/chunk", { method: "POST", body: form });
            await requireApiSuccess(chunkResponse, `Failed to upload chunk ${idx + 1}/${totalChunks}`);
          };

          // ponytail: batched parallelism (4); switch to rolling pool if uneven chunk times matter
          for (let i = 0; i < stagedChunks; i += CHUNK_CONCURRENCY) {
            const batch = [];
            for (let j = i; j < Math.min(i + CHUNK_CONCURRENCY, stagedChunks); j++) {
              batch.push(uploadChunk(j));
            }
            await Promise.all(batch);
          }

          const lastStart = (totalChunks - 1) * CHUNK_BYTES;
          const lastBlob = file.slice(lastStart, file.size);
          const finalizeForm = new FormData();
          finalizeForm.set("uploadId", uploadId);
          finalizeForm.set("totalChunks", String(totalChunks));
          finalizeForm.set("owner", config.owner);
          finalizeForm.set("repo", config.repo);
          finalizeForm.set("branch", config.branch);
          finalizeForm.set("path", fullPath);
          finalizeForm.set("name", configMedia.name);
          finalizeForm.set("lastChunk", lastBlob);

          const finalizeResponse = await fetch("/api/upload/finalize", {
            method: "POST",
            body: finalizeForm,
          });

          const data = await requireApiSuccess<any>(finalizeResponse, "Failed to upload file");
          return data.data as FileSaveData;
        })();

        await toast.promise(uploadPromise, {
          loading: `Uploading ${file.name}`,
          success: (savedEntry) => {
            onUpload?.(savedEntry);
            return `Uploaded ${file.name}`;
          },
          error: (error: unknown) => error instanceof Error ? error.message : "Upload failed",
        });
      }
    } catch (error) {
      console.error(error);
    }
  }, [config, path, configMedia?.name, configMedia?.rename, onUpload, rename]);

  const contextValue = useMemo(() => ({
    handleFiles,
    accept,
    multiple,
    disabled,
  }), [handleFiles, accept, multiple, disabled]);

  return (
    <MediaUploadContext.Provider value={contextValue}>
      {children}
    </MediaUploadContext.Provider>
  );
}

function MediaUploadTrigger({ children }: MediaUploadTriggerProps) {
  const context = useContext(MediaUploadContext);
  if (!context) throw new Error("MediaUploadTrigger must be used within a MediaUpload component");
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filterAcceptedFiles = useCallback((files: File[]) => {
    const acceptedExtensions = context.accept?.split(",").map((ext) => ext.trim().toLowerCase());
    if (!acceptedExtensions?.length) return files;

    const validFiles = files.filter((file) => {
      const ext = `.${file.name.split(".").pop()?.toLowerCase()}`;
      return acceptedExtensions.includes(ext);
    });

    if (validFiles.length === 0) {
      toast.error(`Invalid file type. Allowed: ${context.accept}`);
      return [];
    }

    if (validFiles.length !== files.length) {
      toast.error(`Some files were skipped. Allowed: ${context.accept}`);
    }

    return validFiles;
  }, [context.accept]);

  const handleClick = useCallback(() => {
    if (context.disabled) return;
    fileInputRef.current?.click();
  }, [context.disabled]);

  const handleFileInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (context.disabled) return;
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const validFiles = filterAcceptedFiles(Array.from(files));
    if (validFiles.length === 0) return;

    context.handleFiles(validFiles);
  }, [context, filterAcceptedFiles]);

  return (
    <>
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInput}
        accept={context.accept}
        multiple={context.multiple}
        hidden
      />
      {cloneElement(children, { onClick: handleClick })}
    </>
  );
}

function MediaUploadDropZone({ children, className }: MediaUploadDropZoneProps) {
  const context = useContext(MediaUploadContext);
  if (!context) throw new Error("MediaUploadDropZone must be used within a MediaUpload component");
  
  const [isDragging, setIsDragging] = useState(false);

  const filterAcceptedFiles = useCallback((files: File[]) => {
    const acceptedExtensions = context.accept?.split(",").map((ext) => ext.trim().toLowerCase());
    if (!acceptedExtensions?.length) return files;

    const validFiles = files.filter((file) => {
      const ext = `.${file.name.split(".").pop()?.toLowerCase()}`;
      return acceptedExtensions.includes(ext);
    });

    if (validFiles.length === 0) {
      toast.error(`Invalid file type. Allowed: ${context.accept}`);
      return [];
    }

    if (validFiles.length !== files.length) {
      toast.error(`Some files were skipped. Allowed: ${context.accept}`);
    }

    return validFiles;
  }, [context.accept]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (context.disabled) return;
    e.preventDefault();
    setIsDragging(true);
  }, [context.disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (context.disabled) return;
    e.preventDefault();
    setIsDragging(false);
  }, [context.disabled]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (context.disabled) return;
    e.preventDefault();
    setIsDragging(false);
    
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const validFiles = filterAcceptedFiles(Array.from(files));
    if (validFiles.length === 0) return;

    context.handleFiles(validFiles);
  }, [context, filterAcceptedFiles]);

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn("relative", className)}
    >
      {children}
      {!context.disabled && isDragging && (
        <div className="absolute inset-0 bg-primary/10 rounded-lg flex items-center justify-center">
          <p className="text-sm text-foreground font-medium bg-background rounded-full px-3 py-1">
            Drop files here to upload
          </p>
        </div>
      )}
    </div>
  );
}

export const MediaUpload = Object.assign(MediaUploadRoot, {
  Trigger: MediaUploadTrigger,
  DropZone: MediaUploadDropZone,
});
