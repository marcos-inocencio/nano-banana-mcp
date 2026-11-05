import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MAX_RESPONSE_BYTES, MiB, PublicError, readLimited } from './config.js';
import { base64Bytes, imageSignature } from './schema.js';
import type { ImageInput } from './schema.js';

const outputBlock = z.object({
  type: z.string(), text: z.string().optional(),
  mime_type: z.string().optional(), data: z.string().optional(),
});
const interactionSchema = z.object({
  status: z.string(),
  steps: z.array(z.object({ type: z.string(), content: z.array(outputBlock).optional() })).default([]),
});

export async function createImage(input: ImageInput, apiKey: string, signal?: AbortSignal): Promise<CallToolResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 120_000);
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey, 'Api-Revision': '2026-05-20' },
      body: JSON.stringify({
        model: input.model,
        store: false,
        input: [
          { type: 'text', text: input.prompt },
          ...(input.reference_images ?? []).map(image => ({ type: 'image', ...image })),
        ],
        response_format: {
          type: 'image', mime_type: 'image/png', aspect_ratio: input.aspect_ratio,
          ...(input.model === 'gemini-2.5-flash-image' ? {} : { image_size: input.resolution }),
        },
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) throw new PublicError(429, 'Gemini quota or rate limit reached. Try again later.');
      if (response.status === 400) throw new PublicError(400, 'Gemini rejected the image request. Check the model options and content.');
      if (response.status === 404) throw new PublicError(502, 'Selected Gemini model is unavailable for this API key.');
      if (response.status === 401 || response.status === 403) throw new PublicError(502, 'Gemini credentials or model permissions require administrator attention.');
      throw new PublicError(502, 'Gemini is temporarily unavailable.');
    }
    const result = interactionSchema.parse(JSON.parse(await readLimited(response, MAX_RESPONSE_BYTES)));
    if (result.status !== 'completed') throw new PublicError(502, 'Gemini did not complete the image request.');
    const content: CallToolResult['content'] = [];
    let imageBytes = 0;
    for (const step of result.steps) {
      // Never return thought images or internal reasoning to the client.
      if (step.type !== 'model_output') continue;
      for (const block of step.content ?? []) {
        if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text });
        if (block.type === 'image' && block.data && block.mime_type) {
          const bytes = base64Bytes(block.data);
          imageBytes += bytes;
          if (bytes < 0 || imageBytes > 16 * MiB || !imageSignature(block.data, block.mime_type)) {
            throw new PublicError(502, 'Gemini returned an invalid or oversized image.');
          }
          content.push({ type: 'image', data: block.data, mimeType: block.mime_type });
        }
      }
    }
    if (!content.some(block => block.type === 'image')) {
      throw new PublicError(422, 'No image was returned. Gemini may have declined the request; revise the prompt.');
    }
    return { content };
  } catch (error) {
    if (controller.signal.aborted) throw new PublicError(504, 'Image request timed out or was cancelled.');
    if (error instanceof PublicError) throw error;
    throw new PublicError(502, 'Invalid response or connection failure from Gemini.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
