export const VERSION = '1.2.7';

export const KV_ASYNC_MODE = 'cnd_ai_async_mode';
export const KV_USAGE_STATS = 'cnd_ai_usage_stats';
/** 当前加载的前端 `VERSION`（每次启动写入，便于对照） */
export const KV_BUNDLED_VERSION = 'cnd_ai_bundled_version';
/** 用户已确认「已读」的 release.json 版本号；小于该版本的更新说明不再弹 */
export const KV_RELEASE_ACK_VERSION = 'cnd_ai_release_ack_version';
/** 相对站点根路径，与 index 同目录即可 */
export const RELEASE_JSON_PATH = 'release.json';

export const DB_NAME = 'cnd_ai_image';
export const DB_VER = 4;
export const DB_STORE = 'pending_tasks';
export const DB_RECORDS_STORE = 'records';
export const DB_KV_STORE = 'kv';
export const DB_IMAGES_STORE = 'record_images';

export const POLL_INTERVAL = 5_000;
export const POLL_MAX = 72;
export const POLL_JITTER_MAX = 900;
export const REF_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const MODAL_GALLERY_PAGE_SIZE = 15;
export const CANVAS_INITIAL_IMAGE_LIMIT = 24;

export const CHANNEL = {
  cnd: {
    id: 'cnd',
    name: 'CND',
    supportsRef: true,
    endpoint: 'https://api.cnd.cool/v1/images/generations',
    asyncEndpoint: 'https://api.cnd.cool/v1/images/generations?async=true',
    asyncPollBase: 'https://api.cnd.cool/v1/images/',
    lsKey: 'cnd_ai_cnd_key',
    label: 'CND API Key',
    link: 'https://api.cnd.cool/register?aff=O3iX',
  },
};

/** CND 支持的比例枚举（含 auto） */
export const SIZE_RATIO_PRESETS = [
  { value: 'auto',  label: 'Auto',  desc: '由模型自动决定' },
  { value: '1:1',   label: '1:1',   desc: '正方形' },
  { value: '3:2',   label: '3:2',   desc: '横版' },
  { value: '2:3',   label: '2:3',   desc: '竖版' },
  { value: '16:9',  label: '16:9',  desc: '宽屏' },
  { value: '9:16',  label: '9:16',  desc: '竖屏' },
  { value: '4:3',   label: '4:3',   desc: '横版' },
  { value: '3:4',   label: '3:4',   desc: '竖版' },
  { value: '5:4',   label: '5:4',   desc: '横版' },
  { value: '4:5',   label: '4:5',   desc: '竖版' },
  { value: '2:1',   label: '2:1',   desc: '超宽' },
  { value: '1:2',   label: '1:2',   desc: '超竖' },
];

/** CND 像素预设 */
export const SIZE_PIXEL_PRESETS = [
  { value: '1024x1024', label: '1:1',  sub: '1024×1024' },
  { value: '1024x1792', label: '竖版', sub: '1024×1792' },
  { value: '1792x1024', label: '横版', sub: '1792×1024' },
];

/** 自定义尺寸约束：每边 [16, 3840]，像素积 [655360, 8294400]，须被 16 整除 */
export const SIZE_CUSTOM_PX_MIN    = 16;
export const SIZE_CUSTOM_PX_MAX    = 3840;
export const SIZE_PIXEL_BUDGET_MIN = 655_360;
export const SIZE_PIXEL_BUDGET_MAX = 8_294_400;

/** CND 像素尺寸 → 比例映射 */
export const CND_PX_TO_RATIO = {
  '1024x1024': '1:1',
  '1024x1536': '2:3',
  '1536x1024': '3:2',
};

/** 比例/像素 → 最接近的 CND 像素尺寸（切换回 CND/自定义时用） */
export const RATIO_TO_CND_PX = {
  '1:1':       '1024x1024',
  '2:3':       '1024x1536',
  '3:2':       '1536x1024',
  '1024x1024': '1024x1024',
  '1024x1792': '1024x1536',
  '1792x1024': '1536x1024',
};

/** 比例字符串 → CND API 所需像素尺寸（生成请求时转换用） */
export const CND_RATIO_TO_PX = {
  '1:1':  '1024x1024',
  '2:3':  '1024x1536',
  '3:2':  '1536x1024',
  '1:2':  '1024x2048',
  '2:1':  '2048x1024',
  '16:9': '1792x1008',
  '9:16': '1008x1792',
  '4:3':  '1024x768',
  '3:4':  '768x1024',
  '5:4':  '1280x1024',
  '4:5':  '1024x1280',
};

export const EYE_OPEN =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
export const EYE_SHUT =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
export const PLAY_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
