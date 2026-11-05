import { z } from 'zod';
import { MiB } from './config.js';

export const models = [
  'gemini-nano-banana-2.1', 'gemini-3.1-flash-image',
  'gemini-3-pro-image', 'gemini-2.5-flash-image',
] as const;
const standardRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const;
export const aspectRatios = [...standardRatios, '1:4', '4:1', '1:8', '8:1'] as const;
export const MAX_IMAGE_BYTES = 4 * MiB;
export const MAX_REFERENCE_BYTES = 10 * MiB;

export function base64Bytes(data: string): number {
  if (!data.length || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return -1;
  return data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}

export function imageSignature(data: string, mime: string): boolean {
  const head = atob(data.slice(0, 24));
  if (mime === 'image/png') return head.startsWith('\x89PNG\r\n\x1a\n');
  if (mime === 'image/jpeg') return head.startsWith('\xff\xd8\xff');
  return mime === 'image/webp' && head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP';
}

const reference = z.object({
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  data: z.string().min(4).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
    .describe('Raw base64 image bytes; no data URI, URL or local path.'),
}).strict().superRefine((image, ctx) => {
  const bytes = base64Bytes(image.data);
  if (bytes < 0 || bytes > MAX_IMAGE_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'Invalid base64 or image larger than 4 MiB.' });
  } else if (!imageSignature(image.data, image.mime_type)) {
    ctx.addIssue({ code: 'custom', message: 'Image signature does not match MIME type.' });
  }
});

export const commonShape = {
  prompt: z.string().trim().min(1).max(8000),
  model: z.enum(models).default('gemini-nano-banana-2.1'),
  aspect_ratio: z.enum(aspectRatios).default('1:1'),
  resolution: z.enum(['512px', '1K', '2K', '4K']).default('1K')
    .describe('2.5 Flash Image: 1K only. 512px: 3.1 Flash Image only. Other listed models support 1K/2K/4K.'),
};

const baseSchema = z.object({
  ...commonShape,
  reference_images: z.array(reference).min(1).max(14).optional(),
}).strict();

export const imageSchema = baseSchema.superRefine((input, ctx) => {
  const legacy = input.model === 'gemini-2.5-flash-image';
  if ((legacy && input.resolution !== '1K') ||
      (input.resolution === '512px' && input.model !== 'gemini-3.1-flash-image')) {
    ctx.addIssue({ code: 'custom', path: ['resolution'], message: 'Resolution unsupported by the selected model.' });
  }
  if ((legacy || input.model === 'gemini-3-pro-image') && !(standardRatios as readonly string[]).includes(input.aspect_ratio)) {
    ctx.addIssue({ code: 'custom', path: ['aspect_ratio'], message: 'Aspect ratio unsupported by the selected model.' });
  }
  if (legacy && (input.reference_images?.length ?? 0) > 3) {
    ctx.addIssue({ code: 'custom', path: ['reference_images'], message: '2.5 Flash Image is limited to 3 references on this server.' });
  }
  if ((input.reference_images ?? []).reduce((n, image) => n + Math.max(0, base64Bytes(image.data)), 0) > MAX_REFERENCE_BYTES) {
    ctx.addIssue({ code: 'custom', path: ['reference_images'], message: 'References exceed the combined 10 MiB limit.' });
  }
});
export const generateSchema = z.object(commonShape).strict();
export const editSchema = baseSchema.required({ reference_images: true });
export type ImageInput = z.infer<typeof imageSchema>;
