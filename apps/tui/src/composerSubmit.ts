// @effect-diagnostics nodeBuiltinImport:off -- The TUI runs on Bun outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
const SUPPORTED_INLINE_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".avif",
  ".heic",
  ".heif",
  ".tiff",
  ".svg",
]);

const MIME_TYPE_BY_IMAGE_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

export type ResolvedComposerImageAttachment = {
  type: "image";
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
  localPath?: string;
};

function expandHomePath(inputPath: string, homeDir: string): string {
  if (inputPath === "~") {
    return homeDir;
  }
  if (inputPath.startsWith("~/")) {
    return NodePath.join(homeDir, inputPath.slice(2));
  }
  return inputPath;
}

function inferImageMimeType(filePath: string): string | null {
  const extension = NodePath.extname(filePath).toLowerCase();
  if (!SUPPORTED_INLINE_IMAGE_EXTENSIONS.has(extension)) {
    return null;
  }
  return MIME_TYPE_BY_IMAGE_EXTENSION[extension] ?? null;
}

export async function resolveImageAttachmentFromPath(input: {
  filePath: string;
  homeDir: string;
}): Promise<ResolvedComposerImageAttachment | null> {
  const expandedPath = NodePath.resolve(expandHomePath(input.filePath, input.homeDir));
  const mimeType = inferImageMimeType(expandedPath);
  if (!mimeType) {
    return null;
  }

  let stat;
  try {
    stat = await NodeFSP.stat(expandedPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    return null;
  }

  const bytes = await NodeFSP.readFile(expandedPath);
  return {
    type: "image",
    name: NodePath.basename(expandedPath),
    mimeType,
    sizeBytes: bytes.byteLength,
    dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
    localPath: expandedPath,
  };
}

/**
 * The image path in a paste that is only that path, as terminals paste a dropped file
 * (quoted, or with escaped spaces). Null for any other text.
 */
export function pastedImagePath(text: string): string | null {
  const trimmed = text
    .trim()
    .replace(/^'(.*)'$/u, "$1")
    .replace(/\\ /gu, " ");
  if (trimmed.includes("\n")) return null;
  const extension = NodePath.extname(trimmed).toLowerCase();
  return /^(?:~|\/)/u.test(trimmed) && SUPPORTED_INLINE_IMAGE_EXTENSIONS.has(extension)
    ? trimmed
    : null;
}
