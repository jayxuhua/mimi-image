import { CHANNEL, CND_RATIO_TO_PX } from '../config.js';

function roundTo16(value) {
  return Math.max(16, Math.round(value / 16) * 16);
}

function parseRatio(size) {
  if (!size || size === 'auto') return { w: 1, h: 1 };
  const px = String(size).match(/^(\d+)x(\d+)$/);
  if (px) return { w: Number(px[1]), h: Number(px[2]) };
  const ratio = String(size).match(/^(\d+):(\d+)$/);
  if (ratio) return { w: Number(ratio[1]), h: Number(ratio[2]) };
  const mapped = CND_RATIO_TO_PX[size] || '1024x1024';
  const [w, h] = mapped.split('x').map(Number);
  return { w, h };
}

function fitToImage2Limits(w, h) {
  const MAX_EDGE = 3840;
  const MAX_PIXELS = 8_294_400;
  const MIN_PIXELS = 655_360;
  const ratio = Math.max(w, h) / Math.max(1, Math.min(w, h));
  if (ratio > 3) {
    if (w >= h) h = w / 3;
    else w = h / 3;
  }
  let scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  if (w * h * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (w * h));
  if (w * h * scale * scale < MIN_PIXELS) scale = Math.sqrt(MIN_PIXELS / (w * h));
  return `${roundTo16(w * scale)}x${roundTo16(h * scale)}`;
}

export function resolveOpenAIImageSize(size, resolution = '1k') {
  const res = String(resolution || '1k').toLowerCase();
  const { w, h } = parseRatio(size);
  const landscape = w >= h;
  const ratio = Math.max(w, 1) / Math.max(h, 1);
  if (res === '1k') {
    const longEdge = 1024;
    return landscape
      ? fitToImage2Limits(longEdge, longEdge / ratio)
      : fitToImage2Limits(longEdge * ratio, longEdge);
  }
  if (res === '2k') {
    const longEdge = 2048;
    return landscape
      ? fitToImage2Limits(longEdge, longEdge / ratio)
      : fitToImage2Limits(longEdge * ratio, longEdge);
  }
  if (res === '4k') {
    const longEdge = 3840;
    return landscape
      ? fitToImage2Limits(longEdge, longEdge / ratio)
      : fitToImage2Limits(longEdge * ratio, longEdge);
  }
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

async function postImageRequest({ ch, apiKey, body, editMode = false }) {
  const url = editMode ? `${ch.endpoint}?mode=edit` : ch.endpoint;
  const res = await fetch(url, {
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
  resolution = '1k',
  quality,
  format,
  compression,
  count,
  refImages = [],
}) {
  const ch = CHANNEL.openai;
  const outputFormat = String(format || 'PNG').toLowerCase();
  const totalCount = Math.max(1, Math.min(3, Number(count) || 1));
  const refs = Array.isArray(refImages)
    ? refImages.map(r => r?.dataUrl || r?.url || r).filter(Boolean)
    : [];
  const editMode = refs.length > 0;
  const body = {
    model: ch.defaultModel,
    prompt,
    size: resolveOpenAIImageSize(size, resolution),
    quality: normalizeOpenAIQuality(quality),
    output_format: outputFormat,
    response_format: 'b64_json',
    n: 1,
  };

  if ((outputFormat === 'jpeg' || outputFormat === 'webp') && Number.isFinite(compression)) {
    body.output_compression = Math.max(0, Math.min(100, Number(compression)));
  }

  if (editMode) {
    body.images = refs.map(imageUrl => ({ image_url: imageUrl }));
    body.input_fidelity = 'high';
  }

  const allImages = [];
  let usage = null;
  let lastRaw = null;
  for (let i = 0; i < totalCount; i++) {
    const json = await postImageRequest({ ch, apiKey, body, editMode });
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
