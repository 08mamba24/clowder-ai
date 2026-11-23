import { randomUUID } from 'node:crypto';
import * as zlib from 'node:zlib';
import sharp from 'sharp';
import { detectImageMime } from '../../../../../../../utils/image-mime.js';
import { MAX_IMAGE_FILE_SIZE, mimeToImageExt } from '../../../../../../../utils/image-storage.js';
import { MAX_ACP_IMAGES } from '../acp-image-input.js';
import { flattenAcpPrompt, zcodeModelSupportsImages } from './zcode-acp-protocol.js';

interface ZcodeImageAttachment {
  kind: 'image';
  filename: string;
  mimeType: string;
  dataBase64: string;
}

// Available since Node 22.2; the workspace still ships Node 20 type declarations.
const crc32 = (zlib as typeof zlib & { crc32: (data: Uint8Array) => number }).crc32;
function verifyPngChunks(bytes: Buffer): void {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 8 + length;
    if (end + 4 > bytes.length || crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)) {
      throw new Error('Invalid PNG chunk');
    }
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IEND') return;
    offset = end + 4;
  }
  throw new Error('Incomplete PNG');
}

/** Use only snapshotted ACP bytes, never caller-supplied native file paths or URLs. */
export async function prepareZcodePrompt(prompt: unknown, model: string | undefined) {
  const content = flattenAcpPrompt(prompt);
  const blocks: unknown[] = Array.isArray(prompt) ? prompt : [];
  const images = blocks.filter(
    (block): block is Record<string, unknown> =>
      typeof block === 'object' && block !== null && 'type' in block && block.type === 'image',
  );
  if (images.length === 0) return { content, attachments: [] as ZcodeImageAttachment[] };
  if (!zcodeModelSupportsImages(model)) throw new Error('image_input_unsupported: 当前模型未启用图片输入。');
  if (images.length > MAX_ACP_IMAGES) throw new Error('image_input_too_large: 图片数量超过限制。');
  const attachments: ZcodeImageAttachment[] = [];
  const nonce = randomUUID();
  for (const [index, image] of images.entries()) {
    if (typeof image.data !== 'string' || typeof image.mimeType !== 'string') {
      throw new Error('image_input_invalid: 图片数据无效，请重新上传。');
    }
    const data = image.data;
    if (data.length > Math.ceil(MAX_IMAGE_FILE_SIZE / 3) * 4) {
      throw new Error('image_input_too_large: 图片超过大小限制。');
    }
    const bytes = Buffer.from(data, 'base64');
    const mime = detectImageMime(bytes);
    if (!mime || mime !== image.mimeType || bytes.toString('base64') !== data) {
      throw new Error('image_input_invalid: 图片格式或编码无效，请重新上传。');
    }
    if (bytes.length > MAX_IMAGE_FILE_SIZE) throw new Error('image_input_too_large: 图片超过大小限制。');
    try {
      if (mime === 'image/png') verifyPngChunks(bytes);
      // Decode before admission: corrupt images must never prompt a model with a text placeholder.
      // Keep the original bytes; this bounded decode only verifies integrity and processing limits.
      await sharp(bytes, { failOn: 'warning', limitInputPixels: 40_000_000 })
        .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
        .toBuffer();
    } catch {
      throw new Error('image_input_invalid: 图片损坏或尺寸过大，无法处理，请换一张图片重试。');
    }
    attachments.push({
      kind: 'image',
      filename: `clowder-${nonce}-${index}${mimeToImageExt(mime)}`,
      mimeType: mime,
      dataBase64: data,
    });
  }
  return { content, attachments };
}

/** The native admission receipt alone does not prove image materialization succeeded. */
export function assertZcodeImagesMaterialized(result: unknown, attachments: readonly ZcodeImageAttachment[]): void {
  const messages = (result as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) throw new Error('image_input_unavailable: 无法确认图片已处理，请重试。');
  type Part = {
    type?: string;
    mime?: string;
    metadata?: { errorCode?: string; recoverability?: string; storageKind?: string };
  };
  const user = messages.find((message) => message?.info?.role === 'user');
  const parts: Part[] = Array.isArray(user?.parts)
    ? user.parts.filter((part: Part) => part.type === 'file' && part.mime?.startsWith('image/'))
    : [];
  if (parts.length !== attachments.length) throw new Error('image_input_unavailable: 图片未能完整处理，请重试。');
  for (const [index, image] of attachments.entries()) {
    const part = parts[index];
    if (
      part?.mime !== image.mimeType ||
      part.metadata?.errorCode ||
      part.metadata?.recoverability !== 'provider_ready' ||
      part.metadata?.storageKind !== 'artifact'
    )
      throw new Error('image_input_unavailable: 图片未能完整处理，回答已阻止，请检查图片后重试。');
  }
}

/** Anchor the proof at this turn rather than dropping the input behind a long tool exchange. */
export function zcodeImageMessageCursor(result: unknown): string | undefined {
  const messages = (result as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) throw new Error('image_input_unavailable: 无法确认图片会话状态，请重试。');
  if (messages.length === 0) return undefined;
  // session/messages serializes the internal info.id as info.messageId.
  const id = messages.at(-1)?.info?.messageId;
  if (typeof id !== 'string' || !id) throw new Error('image_input_unavailable: 无法确认图片会话状态，请重试。');
  return id;
}
