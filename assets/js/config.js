export const VERSION = '1.0.4-openai';

export const KV_ASYNC_MODE = 'cnd_ai_async_mode';
export const KV_USAGE_STATS = 'cnd_ai_usage_stats';
export const KV_BUNDLED_VERSION = 'cnd_ai_bundled_version';
export const KV_RELEASE_ACK_VERSION = 'cnd_ai_release_ack_version';
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
export const REF_UPLOAD_MAX_BYTES = 3 * 1024 * 1024;
export const REF_UPLOAD_MAX_COUNT = 2;
export const MODAL_GALLERY_PAGE_SIZE = 15;
export const CANVAS_INITIAL_IMAGE_LIMIT = 24;

export const CHANNEL = {
  openai: {
    id: 'openai',
    name: '咪咪Image',
    supportsRef: true,
    endpoint: '/openai-image.php',
    asyncEndpoint: '/openai-image-task.php',
    asyncPollBase: '/openai-image-task.php?id=',
    lsKey: 'oneday_openai_key',
    label: 'OpenAI API Key',
    link: 'https://tokenstation.top',
    defaultModel: 'gpt-image-2',
  },
};

export const SIZE_RATIO_PRESETS = [
  { value: 'auto', label: 'Auto', desc: 'Model decides' },
  { value: '1:1', label: '1:1', desc: 'Square' },
  { value: '3:2', label: '3:2', desc: 'Landscape' },
  { value: '2:3', label: '2:3', desc: 'Portrait' },
  { value: '16:9', label: '16:9', desc: 'Landscape' },
  { value: '9:16', label: '9:16', desc: 'Portrait' },
  { value: '4:3', label: '4:3', desc: 'Landscape' },
  { value: '3:4', label: '3:4', desc: 'Portrait' },
  { value: '5:4', label: '5:4', desc: 'Landscape' },
  { value: '4:5', label: '4:5', desc: 'Portrait' },
  { value: '2:1', label: '2:1', desc: 'Wide' },
  { value: '1:2', label: '1:2', desc: 'Tall' },
];

export const SIZE_PIXEL_PRESETS = [
  { value: '1024x1024', label: '1:1', sub: '1024x1024' },
  { value: '1024x1536', label: 'Portrait', sub: '1024x1536' },
  { value: '1536x1024', label: 'Landscape', sub: '1536x1024' },
];

export const SIZE_CUSTOM_PX_MIN = 16;
export const SIZE_CUSTOM_PX_MAX = 3840;
export const SIZE_PIXEL_BUDGET_MIN = 655_360;
export const SIZE_PIXEL_BUDGET_MAX = 8_294_400;

export const CND_PX_TO_RATIO = {
  '1024x1024': '1:1',
  '1024x1536': '2:3',
  '1536x1024': '3:2',
};

export const RATIO_TO_CND_PX = {
  '1:1': '1024x1024',
  '2:3': '1024x1536',
  '3:2': '1536x1024',
  '1024x1024': '1024x1024',
  '1024x1536': '1024x1536',
  '1536x1024': '1536x1024',
};

export const CND_RATIO_TO_PX = {
  '1:1': '1024x1024',
  '2:3': '1024x1536',
  '3:2': '1536x1024',
  '1:2': '1024x1536',
  '2:1': '1536x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:3': '1536x1024',
  '3:4': '1024x1536',
  '5:4': '1536x1024',
  '4:5': '1024x1536',
};

export const EYE_OPEN =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
export const EYE_SHUT =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
export const PLAY_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
