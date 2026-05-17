import { CHANNEL, CND_RATIO_TO_PX } from '../config.js';

export function resolveOpenAIImageSize(size) {
  if (!size || size === 'auto') return 'auto';
  if (size === '1024x1024' || size === '1024x1536' || size === '1536x1024') return size;
  return CND_RATIO_TO_PX[size] || '1024x1024';
}

export function normalizeOpenAIQuality(quality) {
  const q = String(quality || '').toLowerCase();
  if (q === 'low' || q === 'medium' || q === 'high') return q;
  return 'high';
}

function mergeUsage(a, b) {
  if (!a && !b) return null;
  const out = { ...(a || {}) };
  for (const [key, value] of Object.entries(b || {})) {
    if (typeof value === 'number') {
      out[key] = (typeof out[key] === 'number' ? out[key] : 0) + value;
    } else if (!(key in out)) {
      out[key] = value;
    }
  }
  return out;
}

async function postImageRequest({ ch, apiKey, body }) {
  const res = await fetch(ch.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error?.message || `中转站接口 HTTP ${res.status}`);
  }
  return json;
}

export async function generateOpenAIImages({
  apiKey,
  prompt,
  size,
  quality,
  format,
  compression,
  count,
  refImages = [],
}) {
  const ch = CHANNEL.openai;
  const outputFormat = String(format || 'PNG').toLowerCase();
  const totalCount = Math.max(1, Math.min(3, Number(count) || 1));
  const body = {
    model: ch.defaultModel,
    prompt,
    size: resolveOpenAIImageSize(size),
    quality: normalizeOpenAIQuality(quality),
    output_format: outputFormat,
    n: 1,
  };

  if ((outputFormat === 'jpeg' || outputFormat === 'webp') && Number.isFinite(compression)) {
    body.output_compression = Math.max(0, Math.min(100, Number(compression)));
  }

  const refs = Array.isArray(refImages)
    ? refImages.map(r => r?.url || r).filter(Boolean)
    : [];
  if (refs.length === 1) {
    body.image = refs[0];
  } else if (refs.length > 1) {
    body.image = refs;
  }

  const allImages = [];
  let usage = null;
  let lastRaw = null;
  for (let i = 0; i < totalCount; i++) {
    const json = await postImageRequest({ ch, apiKey, body });
    lastRaw = json;
    const images = Array.isArray(json.data) ? json.data : [];
    allImages.push(...images);
    usage = mergeUsage(usage, json.usage || null);
  }

  return {
    raw: { ...(lastRaw || {}), data: allImages, usage },
    images: allImages,
    usage,
  };
}
