import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Maximum size of each attached image before base64 encoding. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const IMAGE_EXTENSIONS = Object.keys(MIME_TYPES).map((ext) => ext.slice(1)).join('|');
const IMAGE_REFERENCE = new RegExp(
  `@(?:"([^"\\r\\n]+\\.(?:${IMAGE_EXTENSIONS}))"|'([^'\\r\\n]+\\.(?:${IMAGE_EXTENSIONS}))'|([^\\s"'<>]+\\.(?:${IMAGE_EXTENSIONS})))`,
  'gi',
);

function expandHome(value) {
  return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

/**
 * Turn inline @image references in user text into OpenAI-compatible
 * multimodal message content. Supported syntax: @./image.png or
 * @"./image with spaces.png". Relative paths resolve from the workspace.
 * Text without image references remains a plain string for compatibility.
 */
export function buildUserContent(text, { cwd = process.cwd(), maxImageBytes = MAX_IMAGE_BYTES } = {}) {
  const input = String(text ?? '');
  const matches = [...input.matchAll(IMAGE_REFERENCE)];
  if (!matches.length) return input;

  const parts = [];
  let cursor = 0;
  for (const match of matches) {
    const reference = match[1] || match[2] || match[3];
    const absolute = path.resolve(cwd, expandHome(reference));
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      throw new Error(`image attachment not found: ${reference}`);
    }
    if (!stat.isFile()) throw new Error(`image attachment is not a file: ${reference}`);
    if (stat.size > maxImageBytes) {
      throw new Error(`image attachment is too large (${stat.size} bytes; limit ${maxImageBytes}): ${reference}`);
    }

    const ext = path.extname(absolute).toLowerCase();
    const mime = MIME_TYPES[ext];
    if (!mime) continue; // the regexp limits this, but keep the check defensive
    const textBefore = input.slice(cursor, match.index);
    if (textBefore) parts.push({ type: 'text', text: textBefore });
    parts.push({ type: 'text', text: `[Image attached: ${path.basename(absolute)}]` });
    const data = fs.readFileSync(absolute).toString('base64');
    parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${data}`, detail: 'auto' } });
    cursor = match.index + match[0].length;
  }
  const trailing = input.slice(cursor);
  if (trailing) parts.push({ type: 'text', text: trailing });
  return parts;
}
