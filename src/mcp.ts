import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PublicError } from './config.js';
import type { Env } from './config.js';
import { generateSchema, editSchema, imageSchema } from './schema.js';
import { createImage } from './gemini.js';
import { deliverImages } from './images.js';

export async function handleMcp(request: Request, body: unknown, env: Env, subject: string): Promise<Response> {
  const server = new McpServer({ name: 'nano-banana-mcp', version: '0.1.0' });
  const execute = async (input: unknown, signal: AbortSignal): Promise<CallToolResult> => {
    const parsed = imageSchema.safeParse(input);
    if (!parsed.success) return {
      isError: true,
      content: [{ type: 'text', text: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }],
    };
    try {
      const { success } = await env.IMAGE_RATE_LIMITER.limit({ key: subject });
      if (!success) throw new PublicError(429, 'Image rate limit reached (5 requests/minute). Try again later.');
      return await deliverImages(await createImage(parsed.data, env.GEMINI_API_KEY, signal), env);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof PublicError ? error.message : 'Image service unavailable.' }],
      };
    }
  };
  const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  server.registerTool('generate_image', {
    description: 'Generate an image with Google Gemini Nano Banana. Supports model, aspect ratio, and resolution selection, including native 4K on supported models. Calls consume Gemini quota.',
    inputSchema: generateSchema,
    annotations,
  }, (input, extra) => execute(input, extra.signal));
  server.registerTool('edit_image', {
    description: 'Edit or combine reference images with Google Gemini Nano Banana. Provide PNG/JPEG/WebP bytes as raw base64 in reference_images (4 MiB each, 10 MiB combined). URLs and local file paths are not accepted. Calls consume Gemini quota.',
    inputSchema: editSchema,
    annotations,
  }, (input, extra) => execute(input, extra.signal));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { parsedBody: body });
  } finally {
    await server.close();
  }
}
