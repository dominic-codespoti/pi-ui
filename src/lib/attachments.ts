/**
 * Client-side attachment processing: file readers, text-extension allowlist,
 * and in-browser image downscaling. Keeps prompt payloads under the WS frame
 * cap and trims token cost from full-res phone photos.
 */

/** File extensions accepted as plain-text attachments. */
export const TEXT_FILE_EXTENSIONS = new Set([
  'txt',
  'md',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'css',
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'sh',
  'bash',
  'zsh',
  'fish',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'gitignore',
  'svelte',
  'vue',
  'sass',
  'scss',
  'less',
  'sql',
  'graphql',
  'r',
  'mjs',
  'cjs',
  'npmrc',
  'editorconfig',
  'prettierrc',
  'eslintrc',
]);

/** Max base64 image payload per attachment (keeps prompt messages under the
 *  4 MB WS frame cap even with a couple of images attached). */
export const MAX_IMAGE_PAYLOAD = 3 * 1024 * 1024;

/** Max image dimension after in-browser attachment downscale. */
const MAX_IMAGE_DIM = 1600;

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve((reader.result as string).split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result as string);
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

/**
 * Read an image attachment, downscaling oversized sources in-browser —
 * full-res phone photos (12 MP+) inflate the WS payload ~4x as base64 and
 * cost real tokens at the model. Falls back to the raw file when the
 * browser can't decode it (createImageBitmap unsupported/unknown codec).
 */
export async function prepareImage(file: File): Promise<{ data: string; mimeType: string } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(bitmap.width, bitmap.height));
      if (scale >= 1) return { data: await fileToBase64(file), mimeType: file.type };
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return { data: await fileToBase64(file), mimeType: file.type };
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      // Keep PNG/WebP (alpha channel); anything else re-encodes as JPEG.
      const mimeType =
        file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg';
      const dataUrl = canvas.toDataURL(mimeType, 0.85);
      return { data: dataUrl.split(',')[1], mimeType };
    } finally {
      bitmap.close();
    }
  } catch {
    return { data: await fileToBase64(file), mimeType: file.type };
  }
}
