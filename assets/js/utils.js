/**
 * 通用工具函数
 */

export function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function base64ToBlob(b64, mime = 'application/octet-stream') {
  const clean = String(b64 || '').trim();
  const binary = atob(clean);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/** Escape double-quoted HTML attribute values (e.g. img src URL) */
export function escapeAttr(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;');
}

/** Minimal HTML escaping to prevent XSS when building innerHTML */
export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 不足 60 秒为 Ns；≥60 秒为 MM分SS秒（异步占位卡计时等） */
export function formatElapsedSeconds(totalSec) {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}分${String(r).padStart(2, '0')}秒`;
}

/** 简单 x.y.z 版本比较；用于 release 与 ack。相等返回 0，a 新于 b 返回 1 */
export function compareSemver(a, b) {
  const pa = String(a ?? '').split('.').map(p => parseInt(p, 10) || 0);
  const pb = String(b ?? '').split('.').map(p => parseInt(p, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

/** Parse any size string to {w, h} ratio — handles 'WxH', 'W:H', 'auto' */
export function parseAspectRatio(size) {
  if (!size || size === 'auto') return { w: 1, h: 1 };
  if (size.includes('x')) {
    const [w, h] = size.split('x').map(Number);
    return { w: w || 1, h: h || 1 };
  }
  if (size.includes(':')) {
    const [w, h] = size.split(':').map(Number);
    return { w: w || 1, h: h || 1 };
  }
  return { w: 1, h: 1 };
}

export function cardWidth(size) {
  const { w, h } = parseAspectRatio(size);
  const r = h / w;
  if (r < 0.8) return 360;
  if (r > 1.3) return 220;
  return 280;
}

/**
 * @param {object} ch  config.CHANNEL 项
 * @param {string} customBaseUrl  自定义 API 根 URL
 */
export function getChannelEndpoint(ch, customBaseUrl) {
  if (ch.id === 'custom') {
    const b = String(customBaseUrl || '').replace(/\/$/, '');
    return b ? `${b}/images/generations` : '';
  }
  return ch.endpoint;
}
