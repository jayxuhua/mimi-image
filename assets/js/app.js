import {
  VERSION,
  CHANNEL,
  KV_ASYNC_MODE,
  KV_USAGE_STATS,
  KV_BUNDLED_VERSION,
  KV_RELEASE_ACK_VERSION,
  RELEASE_JSON_PATH,
  POLL_INTERVAL,
  POLL_JITTER_MAX,
  POLL_MAX,
  REF_UPLOAD_MAX_BYTES,
  REF_UPLOAD_MAX_COUNT,
  MODAL_GALLERY_PAGE_SIZE,
  CANVAS_INITIAL_IMAGE_LIMIT,
  EYE_OPEN,
  EYE_SHUT,
  PLAY_ICON,
  SIZE_RATIO_PRESETS,
  SIZE_PIXEL_PRESETS,
  SIZE_CUSTOM_PX_MIN,
  SIZE_CUSTOM_PX_MAX,
  SIZE_PIXEL_BUDGET_MIN,
  SIZE_PIXEL_BUDGET_MAX,
  CND_PX_TO_RATIO,
  CND_RATIO_TO_PX,
} from './config.js';
import {
  genId,
  base64ToBlob,
  esc,
  escapeAttr,
  cardWidth,
  parseAspectRatio,
  compareSemver,
} from './utils.js';
import db from './db.js';
import { generateOpenAIImages } from './providers/openai-image.js';
import Viewer from '/vendor/viewerjs/viewer.esm.js';

// ─────────────────────────────────────────────────────────────────────────────
// Application State
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  channel: 'openai',
  asyncMode: 'sync',
  keys: { openai: '' },
  size: '2:3',
  quality: 'high',
  format: 'PNG',
  compression: 100,
  count: 1,
  loading: false,          // true only while a sync request is in flight
  refImages: [],
  sizeMode: 'ratio',  // 'ratio' | 'pixel'
  ratioSize: '2:3',        // last explicit ratio selection (independent of pixel mode)
  pixelSize: '1024x1536',  // last explicit pixel selection (independent of ratio mode)
  moderation:    false,    // CND：true = 开启 moderation 参数
  streamEnabled: false,    // CND：流式 + partial_images
  /** 与生成记录分离，内存镜像 + `kv` 持久化 */
  usageStats: { input: 0, output: 0, total: 0 },
  pendingPolls: new Map(), // taskId → { timerId, attempts, cardId, finalizeState }
};

/** 异步模式单次最多 4 张（多任务提交）；同步模式最多 10 张（n 参数） */
function maxCount() {
  return 3;
}

function syncCountStepperUi() {
  const cap = maxCount();
  const elMinus = document.getElementById('minusBtn');
  const elPlus  = document.getElementById('plusBtn');
  const elVal   = document.getElementById('countVal');
  const elMax   = document.getElementById('maxCount');
  if (!elMinus || !elPlus || !elVal) return;
  elVal.textContent = state.count;
  elMinus.disabled = state.count <= 1;
  elPlus.disabled  = state.count >= cap;
  if (elMax) elMax.textContent = String(cap);
}

function clampCount() {
  const cap = maxCount();
  state.count = Math.min(cap, Math.max(1, state.count));
  syncCountStepperUi();
}

let _refUploadBusy = false;
let _activeSyncRow = null;
let _historyGalleryPage = 1;
let _historyRecords = null;
let _examplesGalleryPage = 1;
let _historyModalObjectUrls = [];
let _cacheSizeDirty = true;
let _cacheSizeText = '—';
let _asyncFinalizeRunning = false;
const _asyncFinalizeQueue = [];

// Cached example data
let _examples = null;

function nextPaint() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function asyncTaskEndpoint() {
  return CHANNEL.openai.asyncEndpoint || '/openai-image-task.php';
}

function asyncTaskPollUrl(taskId) {
  const base = CHANNEL.openai.asyncPollBase || '/openai-image-task.php?id=';
  return `${base}${encodeURIComponent(taskId)}`;
}

async function readJsonResponse(res, label = '接口') {
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(`${label}返回为空（HTTP ${res.status}）`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label}返回不是有效 JSON：${text.slice(0, 160)}`);
  }
}

function setMobileWorkbenchOpen(open) {
  const app = document.querySelector('.app');
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('mobileWorkbenchBtn');
  if (!app) return;
  app.classList.toggle('sidebar-open', !!open);
  sidebar?.classList.toggle('is-open', !!open);
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function toggleMobileWorkbench() {
  const app = document.querySelector('.app');
  setMobileWorkbenchOpen(!app?.classList.contains('sidebar-open'));
}

function closeMobileWorkbench() {
  setMobileWorkbenchOpen(false);
}

function resetHistoryModalObjectUrls() {
  _historyModalObjectUrls.forEach(revokeObjectUrl);
  _historyModalObjectUrls = [];
}

function setHistoryRecords(records) {
  _historyRecords = Array.isArray(records) ? records : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
(async function init() {
  const verEl = document.getElementById('version');
  if (verEl) verEl.textContent = VERSION;

  await db.init();
  if (db.hasDb()) {
    // 清理旧渠道遗留的 KV 条目（duomi / custom 渠道已移除）
    try {
      await Promise.all([
        db.kvRemove('cnd_ai_duomi_key'),
        db.kvRemove('cnd_ai_custom_key'),
        db.kvRemove('cnd_ai_custom_base_url'),
        db.kvRemove('cnd_ai_channel'),
      ]);
    } catch (_) { /* non-critical */ }
    try {
      await db.hydrateState(state, CHANNEL);
      // Restore async mode
      const savedMode = await db.kvGet(KV_ASYNC_MODE);
      if (savedMode === 'sync' || savedMode === 'async') state.asyncMode = savedMode;
      // Sync mode-specific size vars from restored state (these fields are new, not in DB)
      if (state.sizeMode === 'pixel') {
        if (state.size && state.size.includes('x')) state.pixelSize = state.size;
        else state.size = state.pixelSize;
      } else {
        if (state.size && (state.size.includes(':') || state.size === 'auto')) state.ratioSize = state.size;
        else state.size = state.ratioSize;
      }
    } catch (e) { console.warn('[hydrate state]', e); }
    try {
      await db.kvSet(KV_BUNDLED_VERSION, VERSION);
    } catch (e) { console.warn('[kv bundled version]', e); }
  } else {
    toast('IndexedDB 不可用，设置与记录无法保存', 'error', 6000);
  }

  // ── Wire up all event listeners ──
  wireEvents();

  // ── Sync UI ──
  syncModeButtons();
  updateKeyStatus();
  updateRefImageButton();
  clampCount();
  syncSizeSection();
  syncFormatSection();
  syncCompressionSection();
  syncExperimentalSection();

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const hint  = document.getElementById('shortcutHint');
  if (hint) hint.innerHTML = isMac
    ? '<kbd>⌘</kbd> <kbd>Return</kbd>'
    : '<kbd>Ctrl</kbd> + <kbd>Enter</kbd>';

  await loadRecordsToCanvas();
  updateCumulativeTokens();

  await maybeShowReleaseNotes();

  await resumePendingTasks();

  // Final scroll after all rows (completed + pending) are in the DOM
  requestAnimationFrame(() => scrollToLatest(true));
})();

// ─────────────────────────────────────────────────────────────────────────────
// Event Wiring (all addEventListener — no inline onclick in HTML)
// ─────────────────────────────────────────────────────────────────────────────
function wireEvents() {
  // Mode selector (sync / async)
  document.getElementById('asyncModeSeg').addEventListener('click', e => {
    const btn = e.target.closest('[data-async-mode]');
    if (btn) void setAsyncMode(btn.dataset.asyncMode, true);
  });

  // Settings open / close
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
  document.getElementById('cancelSettingsBtn').addEventListener('click', closeSettings);
  // Settings actions
  document.getElementById('saveSettingsBtn').addEventListener('click', () => void saveSettings());
  document.getElementById('clearKeyBtn').addEventListener('click', () => void clearCurrentKey());
  document.getElementById('clearRecordsBtn').addEventListener('click', clearAllRecords);

  // Eye toggle button (CND only)
  const cndEyeBtn = document.getElementById('modalCndEyeBtn');
  if (cndEyeBtn) cndEyeBtn.addEventListener('click', () => toggleEye('modalCndKey', cndEyeBtn));

  // Enter-to-save on CND key input
  const cndKeyEl = document.getElementById('modalCndKey');
  if (cndKeyEl) cndKeyEl.addEventListener('keydown', e => { if (e.key === 'Enter') void saveSettings(); });

  // CND size mode seg
  document.getElementById('sizeModeSeg').addEventListener('click', e => {
    const btn = e.target.closest('[data-size-mode]');
    if (!btn) return;
    const newMode = btn.dataset.sizeMode;
    if (newMode === state.sizeMode) return;
    // Save current value to the outgoing mode's store
    if (state.sizeMode === 'ratio' && state.size && (state.size.includes(':') || state.size === 'auto')) {
      state.ratioSize = state.size;
    } else if (state.sizeMode === 'pixel' && state.size && state.size.includes('x')) {
      state.pixelSize = state.size;
    }
    state.sizeMode = newMode;
    // Restore from incoming mode's store — no conversion, fully independent
    state.size = newMode === 'ratio' ? state.ratioSize : state.pixelSize;
    document.getElementById('customSizeError').textContent = '';
    syncSizeSection();
  });

  // CND ratio chips（事件代理，因为 innerHTML 动态渲染）
  document.getElementById('ratioPanel').addEventListener('click', e => {
    const chip = e.target.closest('[data-ratio]');
    if (!chip) return;
    state.size = chip.dataset.ratio;
    state.ratioSize = state.size;
    renderRatioPanel();
  });

  // CND pixel preset tiles
  document.getElementById('pixelPresetGrid').addEventListener('click', e => {
    const tile = e.target.closest('[data-size-px]');
    if (!tile) return;
    state.size = tile.dataset.sizePx;
    state.pixelSize = state.size;
    document.querySelectorAll('#pixelPresetGrid .size-option').forEach(el =>
      el.classList.toggle('active', el.dataset.sizePx === state.size));
    document.getElementById('customWidthInput').value  = '';
    document.getElementById('customHeightInput').value = '';
    document.getElementById('customSizeError').textContent = '';
  });

  // CND custom size apply
  document.getElementById('customSizeApplyBtn').addEventListener('click', applyCustomSize);
  document.getElementById('customWidthInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') applyCustomSize();
  });
  document.getElementById('customHeightInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') applyCustomSize();
  });

  // Quality seg
  document.querySelectorAll('[data-q]').forEach(el =>
    el.addEventListener('click', () => selectQuality(el)));

  // Format seg
  document.querySelectorAll('[data-fmt]').forEach(el =>
    el.addEventListener('click', () => selectFormat(el)));

  // Compression slider
  document.getElementById('compression').addEventListener('input', function () {
    document.getElementById('compressionVal').textContent = this.value;
    state.compression = parseInt(this.value);
  });

  // Count stepper
  document.getElementById('minusBtn').addEventListener('click', () => adjustCount(-1));
  document.getElementById('plusBtn').addEventListener('click',  () => adjustCount(1));

  // Prompt
  document.getElementById('prompt').addEventListener('input', updateCharCount);
  document.getElementById('prompt').addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate();
  });
  document.getElementById('clearPromptBtn').addEventListener('click', clearPrompt);
  document.getElementById('fillExampleBtn').addEventListener('click', openExamplesModal);
  document.getElementById('openHistoryBtn').addEventListener('click', openHistoryModal);

  // Ref image button + upload modal
  document.getElementById('refImageBtn').addEventListener('click', handleRefImageBtnClick);
  document.getElementById('refUploadInput').addEventListener('change', function () {
    // 必须先复制 FileList：清空 value 后部分浏览器会清空同一 FileList，导致无法上传
    const files = this.files && this.files.length ? Array.from(this.files) : [];
    this.value = '';
    if (files.length) processRefUploadFiles(files);
  });
  const refZone = document.getElementById('refUploadZone');
  refZone.addEventListener('dragenter', e => { e.preventDefault(); refZone.classList.add('ref-upload-drag'); });
  refZone.addEventListener('dragover', e => {
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch (_) { /* ignore */ }
  });
  refZone.addEventListener('dragleave', e => {
    if (!refZone.contains(e.relatedTarget)) refZone.classList.remove('ref-upload-drag');
  });
  refZone.addEventListener('drop', e => {
    e.preventDefault();
    refZone.classList.remove('ref-upload-drag');
    if (_refUploadBusy) return;
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) processRefUploadFiles(dt.files);
  });
  document.getElementById('refUploadModalCloseX').addEventListener('click', closeRefUploadModal);
  document.getElementById('refUploadModalCloseBtn').addEventListener('click', closeRefUploadModal);

  document.getElementById('releaseNotesOkBtn').addEventListener('click', () => void dismissReleaseNotesModal());
  document.getElementById('releaseNotesCloseBtn').addEventListener('click', () => void dismissReleaseNotesModal());
  document.getElementById('releaseNotesModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) void dismissReleaseNotesModal();
  });

  // Generate button
  document.getElementById('genBtn').addEventListener('click', generate);

  // Toolbar
  document.getElementById('clearBtn').addEventListener('click', clearCanvas);
  document.getElementById('toolbarBadge').addEventListener('click', openHistoryModal);
  document.getElementById('mobileWorkbenchBtn')?.addEventListener('click', toggleMobileWorkbench);
  document.getElementById('mobileSidebarCloseBtn')?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    closeMobileWorkbench();
  });
  document.querySelector('.app')?.addEventListener('click', e => {
    if (e.target === e.currentTarget && e.currentTarget.classList.contains('sidebar-open')) {
      closeMobileWorkbench();
    }
  });

  // Detail modal
  document.getElementById('detailCloseBtn').addEventListener('click', closeDetailModal);
  // Examples modal
  document.getElementById('examplesCloseBtn').addEventListener('click', closeExamplesModal);
  document.getElementById('examplesModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeExamplesModal();
  });
  // History modal
  document.getElementById('historyCloseBtn').addEventListener('click', closeHistoryModal);
  document.getElementById('historyModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeHistoryModal();
  });

  // Global keyboard
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeLightbox();
    closeSettings();
    closeDetailModal();
    closeExamplesModal();
    closeHistoryModal();
    closeRefUploadModal();
    closeMobileWorkbench();
    void dismissReleaseNotesModal();
  });

  // CND 实验性：moderation
  document.getElementById('cndModerationToggle').addEventListener('change', function () {
    state.moderation = this.checked;
  });

  // CND 实验性：stream
  document.getElementById('cndStreamToggle').addEventListener('change', function () {
    state.streamEnabled = this.checked;
  });

  // 同步生成进行中：离开 / 刷新 / 关闭标签页时由浏览器弹出原生确认框（无法真正拦截，用户仍可确认离开）
  window.addEventListener('beforeunload', e => {
    if (!state.loading) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Async Mode
// ─────────────────────────────────────────────────────────────────────────────
async function setAsyncMode(mode, showToast = false) {
  mode = mode === 'async' ? 'async' : 'sync';
  if (state.asyncMode === mode) return;
  state.asyncMode = mode;
  if (db.hasDb()) {
    try { await db.kvSet(KV_ASYNC_MODE, mode); } catch (e) { console.warn('[kv async mode]', e); }
  }
  syncModeButtons();
  clampCount();
  syncFormatSection();
  syncCompressionSection();
  if (showToast) toast(mode === 'async' ? '已切换到异步生图' : '已切换到同步生图', 'info');
}

function syncModeButtons() {
  document.querySelectorAll('#asyncModeSeg [data-async-mode]').forEach(b =>
    b.classList.toggle('active', b.dataset.asyncMode === state.asyncMode));
}

function updateKeyStatus() {
  const hasKey = !!state.keys.openai;
  const dot    = document.getElementById('keyDot');
  const btn    = document.getElementById('settingsBtn');
  dot.classList.toggle('active', hasKey);
  dot.title = hasKey ? 'API Key 已配置' : 'API Key 未配置';
  btn.classList.toggle('has-key', hasKey);
}

function updateRefImageButton() {
  const btn = document.getElementById('refImageBtn');
  if (!btn) return;
  btn.classList.add('ref-supported');
  btn.classList.remove('ref-disabled');
  btn.title = '添加参考图';
}

function handleRefImageBtnClick() {
  openRefUploadModal();
}

function openRefUploadModal() {
  const maxRef = REF_UPLOAD_MAX_COUNT;
  document.getElementById('refUploadModal').classList.add('open');
  document.getElementById('refUploadInput').value = '';
  document.getElementById('refUploadZone').classList.remove('ref-upload-drag');
  const hintEl = document.querySelector('#refUploadModal .ref-upload-zone-hint');
  if (hintEl) {
    hintEl.textContent = `JPG / JPEG / PNG，单张不超过 3MB，最多 ${maxRef} 张`;
  }
}

function closeRefUploadModal() {
  document.getElementById('refUploadModal').classList.remove('open');
  document.getElementById('refUploadZone').classList.remove('ref-upload-drag');
}

/** release.json 中 `type` → 列表前缀文案 */
const RELEASE_TYPE_LABEL = {
  add: '[新增]',
  optimize: '[优化]',
  fix: '[修复]',
  refactor: '[重构]',
  change: '[变更]',
  doc: '[文档]',
  security: '[安全]',
  remove: '[移除]',
  deprecate: '[废弃]',
  perf: '[性能]',
  style: '[样式]',
  deps: '[依赖]',
  breaking: '[破坏性变更]',
  chore: '[杂项]',
  test: '[测试]',
};

let _releaseNotesAckOnDismiss = null;

function releaseTypeLabel(type) {
  const t = String(type || '').toLowerCase();
  return RELEASE_TYPE_LABEL[t] || `[${esc(t || '其他')}]`;
}

function normalizeReleaseEntries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(e => e && typeof e.version === 'string' && e.version.trim());
}

/** 取「尚未确认已读」的最新一条（semver 最大） */
function pickLatestUnackedRelease(entries, ackVersion) {
  const ack = (ackVersion && String(ackVersion).trim()) || '0.0.0';
  const unseen = entries.filter(e => compareSemver(e.version, ack) > 0);
  if (!unseen.length) return null;
  unseen.sort((a, b) => compareSemver(b.version, a.version));
  return unseen[0];
}

function renderReleaseNotesModal(entry) {
  const heading = document.getElementById('releaseNotesHeading');
  const meta = document.getElementById('releaseNotesMeta');
  const list = document.getElementById('releaseNotesList');
  heading.textContent = '通知|公告|教程|更新';
  const time = entry.update_time ? esc(String(entry.update_time)) : '';
  meta.innerHTML = time
    ? `<span class="release-notes-ver">v${esc(entry.version)}</span><span class="release-notes-time">${time}</span>`
    : `<span class="release-notes-ver">v${esc(entry.version)}</span>`;
  const items = Array.isArray(entry.update_content) ? entry.update_content : [];
  list.innerHTML = items
    .map(row => {
      if (!row || typeof row.text !== 'string') return '';
      const tag = releaseTypeLabel(row.type);
      return `<li class="release-notes-item"><span class="release-notes-type">${tag}</span><span>${esc(row.text)}</span></li>`;
    })
    .filter(Boolean)
    .join('') || `<li class="release-notes-item release-notes-empty">暂无说明条目</li>`;
}

function openReleaseNotesModal(entry) {
  _releaseNotesAckOnDismiss = entry.version;
  renderReleaseNotesModal(entry);
  document.getElementById('releaseNotesModal').classList.add('open');
}

async function dismissReleaseNotesModal() {
  const modal = document.getElementById('releaseNotesModal');
  if (!modal.classList.contains('open')) return;
  const v = _releaseNotesAckOnDismiss;
  modal.classList.remove('open');
  _releaseNotesAckOnDismiss = null;
  if (v && db.hasDb()) {
    try {
      await db.kvSet(KV_RELEASE_ACK_VERSION, String(v));
    } catch (e) {
      console.warn('[kv release ack]', e);
    }
  }
  location.reload();
}

async function maybeShowReleaseNotes() {
  if (!db.hasDb()) return;
  let ackRaw;
  try {
    ackRaw = await db.kvGet(KV_RELEASE_ACK_VERSION);
  } catch {
    return;
  }
  const url = new URL(RELEASE_JSON_PATH, window.location.href);
  url.searchParams.set('v', VERSION);
  url.searchParams.set('_', String(Date.now()));
  let data;
  try {
    const res = await fetch(url.href, { cache: 'no-store' });
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  const entries = normalizeReleaseEntries(data);
  const next = pickLatestUnackedRelease(entries, ackRaw);
  if (!next) return;
  openReleaseNotesModal(next);
}

function setRefUploadBusy(busy) {
  _refUploadBusy = busy;
  const zone = document.getElementById('refUploadZone');
  const busyEl = document.getElementById('refUploadBusy');
  if (zone) zone.classList.toggle('ref-upload-disabled', busy);
  if (busyEl) busyEl.style.display = busy ? 'flex' : 'none';
}

function isValidRefUploadFile(file) {
  const mime = (file.type || '').toLowerCase().trim();
  const extOk = /\.(jpe?g|png)$/i.test(file.name || '');
  const mimeOk = mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/pjpeg';
  if (mime.startsWith('image/') && !mimeOk) {
    return { ok: false, reason: '仅支持 JPG、JPEG、PNG' };
  }
  if (!mimeOk && !extOk) {
    return { ok: false, reason: '仅支持 JPG、JPEG、PNG' };
  }
  if (file.size > REF_UPLOAD_MAX_BYTES) {
    return { ok: false, reason: '单张不能超过 3MB' };
  }
  if (file.size <= 0) {
    return { ok: false, reason: '文件无效' };
  }
  return { ok: true };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取参考图失败'));
    reader.readAsDataURL(file);
  });
}

async function processRefUploadFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.size > 0);
  if (!files.length) return;

  const maxRef = REF_UPLOAD_MAX_COUNT;
  const slots = maxRef - state.refImages.length;
  if (slots <= 0) {
    toast(`最多 ${maxRef} 张参考图`, 'info');
    return;
  }

  const toProcess = files.slice(0, slots);
  if (files.length > slots) {
    toast(`已达上限，仅处理前 ${slots} 张`, 'info');
  }

  const validFiles = [];
  for (const file of toProcess) {
    const v = isValidRefUploadFile(file);
    if (!v.ok) {
      toast(`${file.name}: ${v.reason}`, 'error');
      continue;
    }
    validFiles.push(file);
  }
  if (!validFiles.length) return;

  setRefUploadBusy(true);
  let added = 0;
  try {
    for (const file of validFiles) {
      if (state.refImages.length >= maxRef) break;
      try {
        const dataUrl = await readFileAsDataUrl(file);
        state.refImages.push({ name: file.name, url: dataUrl, dataUrl });
        renderRefImages();
        added++;
      } catch (err) {
        toast(`${file.name}: ${err.message || '读取失败'}`, 'error');
      }
    }
    if (added) {
      toast(`已添加 ${added} 张参考图`, 'success');
      closeRefUploadModal();
    }
  } finally {
    setRefUploadBusy(false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings Modal
// ─────────────────────────────────────────────────────────────────────────────
function openSettings() {
  document.getElementById('modalCndKey').value = state.keys.openai;
  void updateCacheSize();
  document.getElementById('settingsModal').classList.add('open');
  setTimeout(() => document.getElementById('modalCndKey')?.focus(), 60);
}

function closeSettings() {
  document.getElementById('settingsModal').classList.remove('open');
}

async function saveSettings() {
  if (!db.hasDb()) {
    toast('IndexedDB 不可用，无法保存设置', 'error');
    return;
  }
  const openaiKey = document.getElementById('modalCndKey').value.trim();
  state.keys.openai = openaiKey;

  try {
    if (openaiKey) await db.kvSet(CHANNEL.openai.lsKey, openaiKey);
    else await db.kvRemove(CHANNEL.openai.lsKey);
  } catch (e) {
    toast(e.message || '设置保存失败', 'error');
    return;
  }

  updateKeyStatus();
  toast('设置已保存', 'success');
  closeSettings();
}

async function clearCurrentKey() {
  if (!confirm('确定清除 OpenAI API Key？')) return;
  state.keys.openai = '';
  if (db.hasDb()) await db.kvRemove(CHANNEL.openai.lsKey);
  const el = document.getElementById('modalCndKey');
  if (el) el.value = '';
  updateKeyStatus();
  toast('已清除 API Key', 'info');
}

function toggleEye(inputId, btn) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.type      = el.type === 'password' ? 'text' : 'password';
  btn.innerHTML = el.type === 'text' ? EYE_SHUT : EYE_OPEN;
}

// ─────────────────────────────────────────────────────────────────────────────
// Controls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 统一设置尺寸：感知当前渠道，自动更新 state.size 和对应 UI。
 */
function applySize(value) {
  // CND：支持比例和像素模式（API 端 resolveSizeForChannel 负责转换）
  const mapped = CND_PX_TO_RATIO[value];
  if (mapped) {
    // 标准 CND 像素预设 → 映射为比例展示
    state.size = mapped;
    state.ratioSize = mapped;
    state.sizeMode = 'ratio';
  } else if (value === 'auto' || value.includes(':')) {
    state.size = value;
    state.ratioSize = value;
    state.sizeMode = 'ratio';
  } else if (value.includes('x')) {
    // 自定义像素尺寸
    state.size = value;
    state.pixelSize = value;
    state.sizeMode = 'pixel';
    if (!SIZE_PIXEL_PRESETS.some(p => p.value === value)) {
      const [w, h] = value.split('x');
      const wEl = document.getElementById('customWidthInput');
      const hEl = document.getElementById('customHeightInput');
      if (wEl) wEl.value = w;
      if (hEl) hEl.value = h;
    }
  } else {
    state.size = value;
    state.ratioSize = value;
    state.sizeMode = 'ratio';
  }
  document.getElementById('customSizeError').textContent = '';
  syncSizeSection();
}

// ─────────────────────────────────────────────────────────────────────────────
// CND 尺寸 UI
// ─────────────────────────────────────────────────────────────────────────────

/** 同步尺寸区块：显示 CND 对应面板，并更新选中状态 */
function syncSizeSection() {
  document.getElementById('sizeSection').style.display  = 'block';

  // 确保 state.size 与当前模式一致（防御性修复，正常流程不应产生不一致）
  if (state.sizeMode === 'pixel') {
    if (!state.size || !state.size.includes('x')) state.size = state.pixelSize;
  } else {
    if (!state.size || (!state.size.includes(':') && state.size !== 'auto')) state.size = state.ratioSize;
  }

  // 模式切换 seg：所有渠道均显示
  const modeSegEl = document.getElementById('sizeModeSeg');
  modeSegEl.style.display = '';

  document.querySelectorAll('#sizeModeSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.sizeMode === state.sizeMode));

  document.getElementById('ratioPanel').style.display  = state.sizeMode === 'ratio' ? '' : 'none';
  document.getElementById('pixelPanel').style.display  = state.sizeMode === 'pixel' ? '' : 'none';
  if (state.sizeMode === 'ratio') {
    renderRatioPanel();
  } else {
    syncPixelPanel();
  }
}

/** 渲染 CND 比例 chip 网格（innerHTML，靠父级事件代理响应点击） */
function renderRatioPanel() {
  const panel = document.getElementById('ratioPanel');
  const MAX_DIM = 22;
  panel.innerHTML =
    '<div class="size-ratio-grid">' +
    SIZE_RATIO_PRESETS.map(s => {
      const isActive = state.size === s.value;
      const isAuto   = s.value === 'auto';
      let thumbHtml;
      if (isAuto) {
        thumbHtml = `<div class="size-ratio-thumb-auto">A</div>`;
      } else {
        const { w, h } = parseAspectRatio(s.value);
        const bw = Math.round(w / Math.max(w, h) * MAX_DIM);
        const bh = Math.round(h / Math.max(w, h) * MAX_DIM);
        thumbHtml = `<div class="size-rect" style="width:${bw}px;height:${bh}px;"></div>`;
      }
      return `<button type="button" class="size-ratio-chip${isActive ? ' active' : ''}" data-ratio="${s.value}" title="${esc(s.desc)}">
        <div class="size-ratio-thumb">${thumbHtml}</div>
        <span class="size-ratio-label">${s.label}</span>
      </button>`;
    }).join('') +
    '</div>';
}

/** 同步 CND 像素面板的选中状态（tiles + 自定义输入） */
function syncPixelPanel() {
  document.querySelectorAll('#pixelPresetGrid .size-option').forEach(el =>
    el.classList.toggle('active', el.dataset.sizePx === state.size));
  // 仅当当前是自定义尺寸时才填入输入框（预设 tile 选中后由 tile click 清空输入框）
  const isPreset = SIZE_PIXEL_PRESETS.some(p => p.value === state.size);
  const isCustomPx = state.size.includes('x') && !isPreset;
  if (isCustomPx) {
    const [w, h] = state.size.split('x');
    document.getElementById('customWidthInput').value  = w;
    document.getElementById('customHeightInput').value = h;
  } else if (isPreset) {
    // 预设被选中时清空自定义输入框，避免残留上次自定义数值
    document.getElementById('customWidthInput').value  = '';
    document.getElementById('customHeightInput').value = '';
  }
}

/** 校验自定义尺寸，返回错误文案或 null */
function validateCustomSize(w, h) {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return '请输入有效的宽度和高度';
  if (w < SIZE_CUSTOM_PX_MIN || w > SIZE_CUSTOM_PX_MAX)
    return `宽度须在 ${SIZE_CUSTOM_PX_MIN}–${SIZE_CUSTOM_PX_MAX} 之间（当前: ${w}）`;
  if (h < SIZE_CUSTOM_PX_MIN || h > SIZE_CUSTOM_PX_MAX)
    return `高度须在 ${SIZE_CUSTOM_PX_MIN}–${SIZE_CUSTOM_PX_MAX} 之间（当前: ${h}）`;
  if (w % 16 !== 0) return `宽度须被 16 整除（当前: ${w}）`;
  if (h % 16 !== 0) return `高度须被 16 整除（当前: ${h}）`;
  const px = w * h;
  if (px < SIZE_PIXEL_BUDGET_MIN)
    return `总像素不足（${w}×${h} = ${px.toLocaleString()}，最小 ${SIZE_PIXEL_BUDGET_MIN.toLocaleString()}）`;
  if (px > SIZE_PIXEL_BUDGET_MAX)
    return `总像素超限（${w}×${h} = ${px.toLocaleString()}，最大 ${SIZE_PIXEL_BUDGET_MAX.toLocaleString()}）`;
  return null;
}

/** 应用自定义像素尺寸（由按钮 / Enter 触发） */
function applyCustomSize() {
  const wEl  = document.getElementById('customWidthInput');
  const hEl  = document.getElementById('customHeightInput');
  const errEl = document.getElementById('customSizeError');
  const w = parseInt(wEl.value, 10);
  const h = parseInt(hEl.value, 10);
  const err = validateCustomSize(w, h);
  if (err) {
    errEl.textContent = err;
    return;
  }
  errEl.textContent = '';
  state.size = `${w}x${h}`;
  state.pixelSize = state.size;
  // 取消预设 tile 高亮
  document.querySelectorAll('#pixelPresetGrid .size-option').forEach(el => el.classList.remove('active'));
  toast(`自定义尺寸已应用：${w}×${h}`, 'success');
}

function selectQuality(el) {
  document.querySelectorAll('[data-q]').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  state.quality = el.dataset.q;
}

function selectFormat(el) {
  document.querySelectorAll('[data-fmt]').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  state.format = el.dataset.fmt;
  syncCompressionSection();
}

/** 异步模式时隐藏输出格式区块 */
function syncFormatSection() {
  const el = document.getElementById('formatSection');
  if (el) el.style.display = state.asyncMode === 'async' ? 'none' : '';
}

/** 根据当前格式和模式显示/隐藏压缩滑块（仅同步 + JPEG/WEBP 需要） */
function syncCompressionSection() {
  const el = document.getElementById('compressionSection');
  if (!el) return;
  if (state.asyncMode === 'async') {
    el.style.display = 'none';
    return;
  }
  const fmt = state.format.toUpperCase();
  el.style.display = (fmt === 'JPEG' || fmt === 'WEBP') ? '' : 'none';
}

/** CND/自定义渠道显示实验性功能区块（当前暂时隐藏） */
function syncExperimentalSection() {
  const el = document.getElementById('cndExperimentalSection');
  if (el) el.style.display = 'none';
}

function adjustCount(d) {
  const cap = maxCount();
  const next = state.count + d;
  if (next < 1 || next > cap) return;
  state.count = next;
  syncCountStepperUi();
}

function updateCharCount() {
  const text = document.getElementById('prompt').value;
  document.getElementById('charCount').textContent  = text.length;
  document.getElementById('tokenCount').textContent = Math.ceil(text.length / 2.5);
}

function clearPrompt() {
  document.getElementById('prompt').value = '';
  updateCharCount();
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast
// ─────────────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className   = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  const tid = setTimeout(() => el.remove(), duration);
  // auto-remove on click too
  el.addEventListener('click', () => { clearTimeout(tid); el.remove(); }, { once: true });
}

let _syncGenToastWrap = null;

/** 同步生成进行中：底部居中 danger 风格提示（与顶部 Toast 样式一致） */
function showSyncGenerationToast() {
  if (_syncGenToastWrap?.isConnected) return;
  const wrap = document.createElement('div');
  wrap.className = 'sync-gen-toast-wrap';
  wrap.setAttribute('role', 'status');
  const el = document.createElement('div');
  el.className = 'toast error sync-gen-toast';
  el.textContent = '正在同步生成图像，请勿关闭、刷新或离开本页';
  wrap.appendChild(el);
  document.body.appendChild(wrap);
  _syncGenToastWrap = wrap;
}

function hideSyncGenerationToast() {
  _syncGenToastWrap?.remove();
  _syncGenToastWrap = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat Feed helpers
// ─────────────────────────────────────────────────────────────────────────────
function scrollToLatest(instant = false) {
  const body = document.getElementById('canvasBody');
  if (!body) return;
  body.scrollTo({ top: body.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
}

function updateToolbarBadge() {
  const feed = document.getElementById('chatFeed');
  const count = feed ? feed.querySelectorAll('.image-card').length : 0;
  const badge = document.getElementById('toolbarBadge');
  if (count > 0) {
    badge.textContent = `${count} 张`;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

/** 友好时间：今天/昨天/前天/2026年5月8日 周五，附 HH:mm */
function friendlyTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const msgDay    = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays  = Math.round((todayStart - msgDay) / 86400000);
  const hhmm      = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const weekdays  = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  if (diffDays === 0)  return `今天 ${hhmm}`;
  if (diffDays === 1)  return `昨天 ${hhmm}`;
  if (diffDays === 2)  return `前天 ${hhmm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${weekdays[d.getDay()]} ${hhmm}`;
}

function buildParamsBubble(prompt, params) {
  const { size, quality, format, channel, count } = params;
  const chDef   = CHANNEL[channel] || CHANNEL.openai;
  const chClass = 'ch-cnd';

  const tags = [
    size      && `<span class="chat-tag">${esc(size).toLocaleUpperCase()}</span>`,
    quality   && `<span class="chat-tag">${esc(quality).toLocaleUpperCase()}</span>`,
    format    && `<span class="chat-tag">${esc(format).toLocaleUpperCase()}</span>`,
    count > 1 && `<span class="chat-tag">×${count}</span>`,
    `<span class="chat-tag ${chClass}">${esc(chDef.name)}</span>`,
  ].filter(Boolean).join('');

  return `<div class="chat-bubble-params">
    ${prompt ? `<div class="chat-prompt">${esc(prompt)}</div>` : ''}
    <div class="chat-tags">${tags}</div>
  </div>`;
}

function createChatRow(prompt, params) {
  const feed = document.getElementById('chatFeed');

  // Time divider above each row
  if (params.ts) {
    const divider = document.createElement('div');
    divider.className = 'chat-divider';
    divider.innerHTML = `<span class="chat-divider-text">${friendlyTime(params.ts)}</span>`;
    feed.appendChild(divider);
  }

  const row = document.createElement('div');
  row.className = 'chat-row';

  // Left: A avatar + images column
  const leftSide = document.createElement('div');
  leftSide.className = 'chat-left';
  leftSide.innerHTML = `<div class="chat-avatar av-a"><img src="/assets/images/logo.png" alt="AI"></div>`;

  const colImages = document.createElement('div');
  colImages.className = 'chat-col-images';
  leftSide.appendChild(colImages);

  // Right: bubble + U avatar
  const rightSide = document.createElement('div');
  rightSide.className = 'chat-right';
  rightSide.innerHTML = `${buildParamsBubble(prompt, params)}<div class="chat-avatar av-u">✦</div>`;

  row.appendChild(rightSide);
  row.appendChild(leftSide);
  feed.appendChild(row);

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('clearBtn').style.display   = 'inline-block';

  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton (sync loading placeholder)
// ─────────────────────────────────────────────────────────────────────────────
function showSkeletonInRow(row, n, size) {
  _activeSyncRow = row;
  const col = row.querySelector('.chat-col-images');
  const { w, h } = parseAspectRatio(size);
  const ratio = h / w;
  const cw = cardWidth(size);
  col.innerHTML = Array.from({ length: n }, () => `
    <div class="skeleton-card" style="width:${cw}px;flex-shrink:0;">
      <div class="skeleton-img" style="padding-bottom:${(ratio * 100).toFixed(1)}%;position:relative;">
        <div class="skeleton-generating-label">正在生成中…</div>
      </div>
      <div class="skeleton-footer">
        <div class="skeleton-line" style="width:70px;height:12px;"></div>
        <div class="skeleton-line" style="width:40px;height:12px;"></div>
      </div>
    </div>
  `).join('');
}

function hideSkeletonInRow(row) {
  if (!row) return;
  const col = row.querySelector('.chat-col-images');
  if (col) col.querySelectorAll('.skeleton-card').forEach(c => c.remove());
  if (_activeSyncRow === row) _activeSyncRow = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lightbox (Viewer.js)
// ─────────────────────────────────────────────────────────────────────────────
let _viewer = null;

function openLightbox(srcs, initialIndex = 0) {
  if (_viewer) { _viewer.destroy(); _viewer = null; }

  const srcList = Array.isArray(srcs) ? srcs : [srcs];
  const idx = Math.max(0, Math.min(initialIndex, srcList.length - 1));

  const container = document.createElement('ul');
  container.style.display = 'none';
  srcList.forEach(s => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = s;
    li.appendChild(img);
    container.appendChild(li);
  });
  document.body.appendChild(container);

  _viewer = new Viewer(container, {
    navbar:           srcList.length > 1,
    title:            false,
    initialViewIndex: idx,
    toolbar: {
      zoomIn:      4,
      zoomOut:     4,
      oneToOne:    4,
      reset:       4,
      rotateLeft:  4,
      rotateRight: 4,
    },
    hidden() {
      _viewer.destroy();
      _viewer = null;
      container.remove();
    },
  });
  _viewer.show();
}

function closeLightbox() {
  _viewer?.hide();
}

// ─────────────────────────────────────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────────────────────────────────────
function imageMimeFromFormat(fmt) {
  switch (String(fmt || '').toUpperCase()) {
    case 'JPEG': return 'image/jpeg';
    case 'WEBP': return 'image/webp';
    default:     return 'image/png';
  }
}

async function transcodeBlobForOutput(blob, fmt, compression = 100) {
  const targetMime = imageMimeFromFormat(fmt);
  if (!blob || targetMime === 'image/png') return blob;

  const quality = Math.max(0.01, Math.min(1, (Number(compression) || 100) / 100));
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0);
    const out = await new Promise(resolve => canvas.toBlob(resolve, targetMime, quality));
    return out || blob;
  } catch (err) {
    console.warn('[transcode output]', err);
    return blob;
  } finally {
    try { bitmap?.close?.(); } catch (_) { /* ignore */ }
  }
}

function fileExtFromMime(mime, fallbackFmt = 'PNG') {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/png') return 'png';
  return String(fallbackFmt || 'png').toLowerCase();
}

function revokeObjectUrl(url) {
  if (!url || !String(url).startsWith('blob:')) return;
  try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
}

function revokeCardObjectUrl(card) {
  const url = card?.dataset?.objectUrl;
  if (url) revokeObjectUrl(url);
}

function revokeObjectUrlsIn(root) {
  if (!root) return;
  root.querySelectorAll('[data-object-url]').forEach(el => revokeObjectUrl(el.dataset.objectUrl));
}

async function materializeStoredImage(image, fmt) {
  if (!image) return null;
  if (!image.imageId) return null;
  const asset = await db.getImageAssetById(image.imageId).catch(() => null);
  if (!asset?.blob) return null;
  const src = URL.createObjectURL(asset.blob);
  return {
    src,
    ref: { imageId: image.imageId, mime: image.mime || asset.mime || imageMimeFromFormat(fmt) },
    objectUrl: src,
  };
}

async function materializeStoredImages(images, fmt) {
  const rows = await Promise.all((images || []).map(img => materializeStoredImage(img, fmt)));
  return rows.filter(Boolean);
}

async function downloadImageRef(imageRef, fmt, idx) {
  if (!imageRef) return;
  if (!imageRef.imageId) return;
  const asset = await db.getImageAssetById(imageRef.imageId).catch(() => null);
  if (!asset?.blob) {
    toast('本地图片不存在或已损坏', 'error');
    return;
  }
  const url = URL.createObjectURL(asset.blob);
  const a  = document.createElement('a');
  a.href   = url;
  a.download = `gpt-image-${Date.now()}-${idx + 1}.${fileExtFromMime(asset.mime || imageRef.mime, fmt)}`;
  a.click();
  setTimeout(() => revokeObjectUrl(url), 1000);
}

async function persistBlobImages(recordId, blobs, fallbackMime) {
  const storedImages = [];
  const preparedImages = [];
  try {
    for (let i = 0; i < blobs.length; i++) {
      const rawBlob = blobs[i];
      const mime = rawBlob?.type || fallbackMime || 'application/octet-stream';
      const blob = rawBlob instanceof Blob ? rawBlob : new Blob([rawBlob], { type: mime });
      const imageId = genId();
      await db.putImageAsset({
        id: imageId,
        recordId,
        mime,
        blob,
        ts: Date.now(),
      });
      const objectUrl = URL.createObjectURL(blob);
      storedImages.push({ imageId, mime });
      preparedImages.push({ src: objectUrl, ref: { imageId, mime }, objectUrl });
    }
  } catch (err) {
    await deleteStoredImageRefs(storedImages);
    preparedImages.forEach(item => revokeObjectUrl(item.objectUrl));
    throw err;
  }
  markCacheSizeDirty();
  return { storedImages, preparedImages };
}

async function deleteStoredImageRefs(images) {
  const list = Array.isArray(images) ? images : [];
  for (const image of list) {
    if (image?.imageId) {
      await db.deleteImageAssetById(image.imageId).catch(() => {});
    }
  }
  if (list.some(image => image?.imageId)) markCacheSizeDirty();
}

async function deleteRecordWithAssets(recId) {
  const rec = await getRecord(recId);
  if (!rec) return;
  await deleteStoredImageRefs(rec.images);
  await deleteRecord(recId);
  if (Array.isArray(_historyRecords)) {
    _historyRecords = _historyRecords.filter(row => row.id !== recId);
  }
  const feed = document.getElementById('chatFeed');
  feed.querySelectorAll(`.image-card[data-rec-id="${recId}"]`).forEach(card => {
    revokeCardObjectUrl(card);
    const row = card.closest('.chat-row');
    card.remove();
    if (row && !row.querySelector('.chat-col-images')?.children.length) removeRowWithDivider(row);
  });
  if (!feed.children.length) {
    setEmptyState(true);
    document.getElementById('tokenInfo').style.display = 'none';
  }
  updateToolbarBadge();
}

// ─────────────────────────────────────────────────────────────────────────────
// Records（IndexedDB `records` 表）
// ─────────────────────────────────────────────────────────────────────────────
async function getRecords() {
  return await db.getRecordsSorted();
}

async function getRecord(recId) {
  if (!recId) return null;
  return await db.getRecordById(recId);
}

function markCacheSizeDirty() {
  _cacheSizeDirty = true;
}

async function saveRecord(rec) {
  if (!db.hasDb()) {
    toast('IndexedDB 不可用，记录未保存', 'error');
    return false;
  }
  try {
    await db.putRecord(rec);
    markCacheSizeDirty();
    return true;
  } catch (e) {
    const q = e && e.name === 'QuotaExceededError';
    toast(q ? '存储空间不足，记录未保存' : (e.message || '记录保存失败'), 'error');
    return false;
  }
}

async function deleteRecord(id) {
  if (!db.hasDb()) return;
  await db.deleteRecordById(id);
  markCacheSizeDirty();
}

function clearAllRecords() {
  if (!confirm('确定清除生成记录与待恢复任务？API Key、Token 统计等设置仍会保留。此操作不可恢复。')) return;
  void (async () => {
    stopAllPendingPolls();
    try {
      if (db.hasDb()) {
        await db.clearRecords();
        await db.clearPendingTasks();
        await db.clearImageAssets();
      }
    } catch (_) { /* ignore */ }
    markCacheSizeDirty();
    resetHistoryModalObjectUrls();
    const feed = document.getElementById('chatFeed');
    revokeObjectUrlsIn(feed);
    setEmptyState(true);
    document.getElementById('tokenInfo').style.display = 'none';
    await updateCacheSize();
    updateCumulativeTokens();
    toast('生成记录与待恢复任务已清除', 'info');
    closeSettings();
  })();
}

async function updateCacheSize() {
  const el = document.getElementById('cacheSize');
  if (!el) return;
  if (!_cacheSizeDirty) {
    el.textContent = _cacheSizeText;
    return;
  }
  try {
    if (!db.hasDb()) {
      el.textContent = '—';
      _cacheSizeText = '—';
      _cacheSizeDirty = false;
      return;
    }
    el.textContent = '计算中…';
    await nextPaint();
    const bytes = await db.estimateDbBytes();
    const kb = (bytes / 1024).toFixed(1);
    const mb = (bytes / 1048576).toFixed(2);
    _cacheSizeText = bytes > 102400 ? mb + ' MB' : kb + ' KB';
    _cacheSizeDirty = false;
    el.textContent = _cacheSizeText;
  } catch {
    el.textContent = '—';
  }
}

function getUsageStats() {
  const u = state.usageStats;
  return { input: u.input, output: u.output, total: u.total };
}

async function saveUsageStats(s) {
  state.usageStats = {
    input:  Number(s.input)  || 0,
    output: Number(s.output) || 0,
    total:  Number(s.total)  || 0,
  };
  if (!db.hasDb()) return;
  try {
    await db.kvSet(KV_USAGE_STATS, JSON.stringify(state.usageStats));
  } catch {
    toast('Token 统计写入失败', 'error');
  }
}

/** 将接口返回的 usage 累加到独立缓存（清除生成记录不会动此项） */
async function accumulateUsageStats(usage) {
  if (!usage) return;
  const has = usage.input_tokens != null || usage.output_tokens != null || usage.total_tokens != null;
  if (!has) return;
  const cur = getUsageStats();
  cur.input  += Number(usage.input_tokens)  || 0;
  cur.output += Number(usage.output_tokens) || 0;
  cur.total  += Number(usage.total_tokens)  || 0;
  await saveUsageStats(cur);
  updateCumulativeTokens();
}

function updateCumulativeTokens() {
  const s = getUsageStats();
  document.getElementById('cumulativeIn').textContent    = s.input;
  document.getElementById('cumulativeOut').textContent   = s.output;
  document.getElementById('cumulativeTotal').textContent = s.total;
}

function setEmptyState(empty) {
  document.getElementById('emptyState').style.display    = empty ? 'flex' : 'none';
  document.getElementById('clearBtn').style.display      = empty ? 'none' : 'inline-block';
  if (empty) {
    document.getElementById('toolbarTitle').textContent  = '等待生成…';
    document.getElementById('toolbarBadge').style.display = 'none';
    document.getElementById('chatFeed').innerHTML = '';
  }
}

async function loadRecordsToCanvas() {
  const records = await db.getRecentRecordsByImageLimit(CANVAS_INITIAL_IMAGE_LIMIT);
  if (!records.length) return;

  // getRecentRecordsByImageLimit 返回从新到旧；翻转为从旧到新 append，保持时间顺序
  const ordered = records.slice().reverse();

  // Group records with the same batchId into one chat row
  const batches = [];
  const batchIdMap = new Map(); // batchId → index in batches[]
  for (const rec of ordered) {
    if (!rec.images?.length) continue;
    if (rec.batchId && batchIdMap.has(rec.batchId)) {
      batches[batchIdMap.get(rec.batchId)].push(rec);
    } else {
      const idx = batches.length;
      batches.push([rec]);
      if (rec.batchId) batchIdMap.set(rec.batchId, idx);
    }
  }

  for (const batch of batches) {
    const first = batch[0];
    const totalImages = batch.reduce((sum, r) => sum + (r.images?.length || 0), 0);
    const row = createChatRow(first.prompt, {
      size:    first.size,
      quality: first.quality,
      format:  first.format,
      channel: first.channel || 'openai',
      count:   totalImages,
      ts:      first.ts,
    });
    row.dataset.recId = first.id;
    for (const rec of batch) {
      await renderStoredRecordImages(rec, row);
    }
  }

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('clearBtn').style.display   = 'inline-block';
  updateToolbarBadge();

  const rendered = document.getElementById('chatFeed').querySelectorAll('.image-card').length;
  document.getElementById('toolbarTitle').textContent =
    rendered >= CANVAS_INITIAL_IMAGE_LIMIT
      ? `最近记录（仅显示最近 ${rendered} 张）`
      : '咪咪Image创意工作台';
  updateCumulativeTokens();

  requestAnimationFrame(() => scrollToLatest(true));
}

// ─────────────────────────────────────────────────────────────────────────────
// Image Card Rendering
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Render prepared images into the images column of a chat row.
 */
function renderImagesInRow(row, displayImages, fmt, size, recId, channel, usage) {
  const col = row.querySelector('.chat-col-images');
  if (!col) return;

  row.dataset.recId = recId;

  const cw = cardWidth(size);
  const { w: sw, h: sh } = parseAspectRatio(size);
  const frag = document.createDocumentFragment();

  displayImages.forEach((item, i) => {
    const card = buildImageCard(item.src, item.ref, fmt, size, sw, sh, cw, recId, channel, i, item.objectUrl || '');
    frag.appendChild(card);
  });
  col.appendChild(frag);

  if (usage) {
    document.getElementById('tokIn').textContent    = usage.input_tokens  ?? '—';
    document.getElementById('tokOut').textContent   = usage.output_tokens ?? '—';
    document.getElementById('tokTotal').textContent = usage.total_tokens  ?? '—';
    document.getElementById('tokenInfo').style.display = 'block';
  }

  updateToolbarBadge();
}

async function renderStoredRecordImages(rec, row) {
  const displayImages = await materializeStoredImages(rec.images, rec.format);
  if (!displayImages.length) return;
  renderImagesInRow(row, displayImages, rec.format, rec.size, rec.id, rec.channel || 'openai', null);
}

function buildImageCard(src, imageRef, fmt, size, sw, sh, cw, recId, channel, idx, objectUrl = '') {
  const card = document.createElement('div');
  card.className      = 'image-card';
  card.style.width    = cw + 'px';
  card.dataset.recId  = recId  || '';
  card.dataset.imgIdx = idx;
  if (objectUrl) card.dataset.objectUrl = objectUrl;

  // Channel tag label & class
  const chDef  = CHANNEL[channel] || CHANNEL.openai;
  const tagCls = '';

  card.innerHTML = `
    <button class="card-del-btn" title="删除">✕</button>
    <img src="${escapeAttr(src)}" alt="Generated ${idx + 1}" loading="lazy"
      style="${size === 'auto' ? 'width:100%;display:block;height:auto;' : `aspect-ratio:${sw}/${sh};width:100%;display:block;object-fit:cover;`}" />
    <div class="image-card-footer">
      <span class="image-meta" title="${size.toLocaleUpperCase()} · ${fmt}">${size.toLocaleUpperCase()} · ${fmt}</span>
      <span class="card-channel-tag${tagCls ? ' ' + tagCls : ''}">${chDef.name}</span>
      <div class="image-actions">
        <button class="icon-btn" title="下载">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>
        <button class="icon-btn" title="使用配置">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
      </div>
    </div>`;

  // Event listeners on card elements
  card.querySelector('.card-del-btn').addEventListener('click', e => {
    e.stopPropagation();
    void deleteImageCard(card);
  });
  card.querySelector('img').addEventListener('click', () => {
    const col = card.closest('.chat-col-images');
    const allCards = col ? [...col.querySelectorAll('.image-card')] : [card];
    const srcs = allCards.map(c => c.querySelector('img')?.src).filter(Boolean);
    const idx = Math.max(0, allCards.indexOf(card));
    openLightbox(srcs, idx);
  });
  card.querySelector('.image-meta').addEventListener('click', e => {
    e.stopPropagation();
    void showImageDetail(card.dataset.recId);
  });
  card.querySelectorAll('.icon-btn')[0].addEventListener('click', e => {
    e.stopPropagation();
    void downloadImageRef(imageRef, fmt, idx);
  });
  card.querySelectorAll('.icon-btn')[1].addEventListener('click', e => {
    e.stopPropagation();
    void useConfig(card.dataset.recId);
  });

  return card;
}

async function deleteImageCard(card) {
  if (!confirm('确定删除此图片？')) return;
  const recId  = card.dataset.recId;
  const imgIdx = parseInt(card.dataset.imgIdx, 10);

  if (recId) {
    const rec = await getRecord(recId);
    if (rec && rec.images) {
      const [removed] = rec.images.splice(imgIdx, 1);
      if (removed?.imageId) {
        await db.deleteImageAssetById(removed.imageId).catch(() => {});
        markCacheSizeDirty();
      }
      if (!rec.images.length) {
        await deleteRecord(recId);
      } else {
        await db.putRecord(rec);
        markCacheSizeDirty();
      }
    }
  }

  revokeCardObjectUrl(card);
  const row = card.closest('.chat-row');
  card.remove();
  if (row) {
    const col = row.querySelector('.chat-col-images');
    if (col && !col.children.length) removeRowWithDivider(row);
  }

  const feed = document.getElementById('chatFeed');
  if (!feed || !feed.querySelector('.image-card, .image-card-pending')) {
    setEmptyState(true);
    document.getElementById('tokenInfo').style.display = 'none';
  }
  updateToolbarBadge();
}

// ─────────────────────────────────────────────────────────────────────────────
// Row Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Remove a .chat-row and its preceding .chat-divider sibling (if any). */
function removeRowWithDivider(row) {
  if (!row) return;
  const prev = row.previousElementSibling;
  if (prev?.classList.contains('chat-divider')) prev.remove();
  row.remove();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending Card (async task placeholder)
// ─────────────────────────────────────────────────────────────────────────────
function createPendingCard(cardId, taskId, size, channel) {
  const cw = cardWidth(size);
  const { w: sw, h: sh } = parseAspectRatio(size);
  const chName = CHANNEL[channel]?.name || channel;

  const card = document.createElement('div');
  card.className        = 'image-card-pending';
  card.style.width      = cw + 'px';
  card.dataset.cardId   = cardId;
  card.dataset.taskId   = taskId;

  card.innerHTML = `
    <div class="pending-img-area" style="aspect-ratio:${sw}/${sh};">
      <div class="pending-spinner"></div>
      <div class="pending-label" id="pl-${cardId}">排队中</div>
      <div class="pending-progress" id="pp-${cardId}"></div>
    </div>
    <div class="pending-track"><div class="pending-bar" id="pb-${cardId}" style="width:0%"></div></div>
    <div class="pending-footer">
      <span class="pending-meta">${size.toLocaleUpperCase()} · ${chName}</span>
      <button class="pending-cancel-btn" data-task-id="${taskId}">暂停</button>
    </div>`;

  card.querySelector('.pending-cancel-btn').onclick = e => {
    e.stopPropagation();
    pausePendingTask(taskId);
  };

  return card;
}

function updatePendingStatus(cardId, label, progressText = '', progressPct = null) {
  const labelEl = document.getElementById(`pl-${cardId}`);
  const progressEl = document.getElementById(`pp-${cardId}`);
  const barEl = document.getElementById(`pb-${cardId}`);
  if (labelEl && label) labelEl.textContent = label;
  if (progressEl) progressEl.textContent = progressText || '';
  if (barEl && progressPct != null) barEl.style.width = progressPct + '%';
}

function updatePendingFromTaskState(cardId, taskState, progress) {
  const stateText = taskState === 'running'
    ? '进行中'
    : taskState === 'queued' || taskState === 'pending'
      ? '排队中'
      : '处理中';
  const progressText = taskState === 'running' && progress != null ? `${progress}%` : '';
  updatePendingStatus(cardId, stateText, progressText);
}

function registerPendingTask(taskId, cardId, attempts = 0) {
  state.pendingPolls.set(taskId, {
    attempts,
    timerId: null,
    cardId,
    finalizeState: null,
  });
}

function pollDelayForTask(taskId) {
  let hash = 0;
  for (let i = 0; i < taskId.length; i++) {
    hash = (hash * 31 + taskId.charCodeAt(i)) & 0xffff;
  }
  return POLL_INTERVAL + (hash % POLL_JITTER_MAX);
}

function removeQueuedFinalizeTask(taskId) {
  const idx = _asyncFinalizeQueue.findIndex(job => job.taskId === taskId);
  if (idx >= 0) _asyncFinalizeQueue.splice(idx, 1);
}

function queueAsyncFinalizeTask(taskId, prompt, compression, data, usage) {
  const poll = state.pendingPolls.get(taskId);
  if (!poll || poll.finalizeState) return;
  poll.finalizeState = 'queued';
  updatePendingStatus(poll.cardId, '结果整理中', '');
  _asyncFinalizeQueue.push({ taskId, prompt, compression, data, usage });
  void pumpAsyncFinalizeQueue();
}

async function pumpAsyncFinalizeQueue() {
  if (_asyncFinalizeRunning) return;
  _asyncFinalizeRunning = true;
  try {
    while (_asyncFinalizeQueue.length) {
      const job = _asyncFinalizeQueue.shift();
      if (!job) continue;
      const poll = state.pendingPolls.get(job.taskId);
      if (!poll) continue;
      poll.finalizeState = 'running';
      updatePendingStatus(poll.cardId, '结果整理中', '');
      await nextPaint();
      try {
        await finishAsyncTask(job.taskId, poll, job.data, job.prompt, job.compression, job.usage);
      } catch (err) {
        failAsyncTask(job.taskId, poll, err.message || '结果整理失败');
      }
      await nextPaint();
    }
  } finally {
    _asyncFinalizeRunning = false;
  }
}

/**
 * Replace a pending card with actual image card(s), keeping them in the same chat row.
 */
function resolvePendingCard(cardId, taskId, displayImages, fmt, size, recId, channel) {
  const feed = document.getElementById('chatFeed');
  const pendingCard = feed.querySelector(`[data-card-id="${cardId}"]`);
  const row = pendingCard?.closest('.chat-row');
  if (!row) return;

  const col = row.querySelector('.chat-col-images');
  const cw = cardWidth(size);
  const { w: sw, h: sh } = parseAspectRatio(size);
  const frag = document.createDocumentFragment();

  displayImages.forEach((item, i) => {
    const card = buildImageCard(item.src, item.ref, fmt, size, sw, sh, cw, recId, channel, i, item.objectUrl || '');
    card.style.animation = 'cardAppear 0.22s ease forwards';
    frag.appendChild(card);
  });

  if (pendingCard) {
    col.insertBefore(frag, pendingCard.nextSibling);
    pendingCard.remove();
  } else {
    col.appendChild(frag);
  }
  updateToolbarBadge();
}

function pausePendingTask(taskId) {
  const poll = state.pendingPolls.get(taskId);
  if (poll) {
    if (poll.finalizeState === 'running') {
      toast('结果整理中，当前无法暂停，请稍候', 'info');
      return;
    }
    clearTimeout(poll.timerId);
    removeQueuedFinalizeTask(taskId);
    state.pendingPolls.delete(taskId);
  }

  // Mark as paused in DB so page refresh won't auto-resume it
  db.getTaskById(taskId).then(task => {
    if (task) db.saveTask({ ...task, paused: true }).catch(() => {});
  }).catch(() => {});

  const feed = document.getElementById('chatFeed');
  const card = feed.querySelector(`[data-task-id="${taskId}"]`);
  if (card) setPendingCardPaused(card, taskId);

  updateToolbarBadge();
  toast('已暂停，刷新页面或点击继续可恢复', 'info');
}

function setPendingCardPaused(card, taskId) {
  const cardId = card.dataset.cardId;
  card.classList.add('is-paused');
  const labelEl = document.getElementById(`pl-${cardId}`);
  if (labelEl) labelEl.textContent = '已暂停';
  const progressEl = document.getElementById(`pp-${cardId}`);
  if (progressEl) progressEl.textContent = '';
  const barEl = document.getElementById(`pb-${cardId}`);
  if (barEl) barEl.style.width = '0%';
  const btn = card.querySelector('.pending-cancel-btn');
  if (btn) {
    btn.textContent = '继续';
    btn.onclick = e => { e.stopPropagation(); resumePausedTask(taskId); };
  }
}

async function resumePausedTask(taskId) {
  const stored = await db.getTaskById(taskId).catch(() => null);
  if (!stored) {
    toast('任务记录已丢失，无法恢复', 'error');
    return;
  }

  // Clear paused flag in DB
  db.saveTask({ ...stored, paused: false }).catch(() => {});

  const { cardId, prompt, compression } = stored;
  registerPendingTask(taskId, cardId, 0);

  const feed = document.getElementById('chatFeed');
  const card = feed.querySelector(`[data-task-id="${taskId}"]`);
  if (card) {
    card.classList.remove('is-paused');
    updatePendingStatus(cardId, '排队中', '', 0);
    const btn = card.querySelector('.pending-cancel-btn');
    if (btn) {
      btn.textContent = '暂停';
      btn.onclick = e => { e.stopPropagation(); pausePendingTask(taskId); };
    }
  }

  schedulePoll(taskId, prompt, compression);
  updateToolbarBadge();
  toast('已继续轮询', 'info');
}

/** 停止所有异步轮询（不清 DB；用于整页清理前） */
function stopAllPendingPolls() {
  for (const poll of state.pendingPolls.values()) {
    if (poll.timerId) clearTimeout(poll.timerId);
  }
  _asyncFinalizeQueue.length = 0;
  state.pendingPolls.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate — Entry Point
// ─────────────────────────────────────────────────────────────────────────────
async function generate() {
  if (state.loading) return;

  const prompt      = document.getElementById('prompt').value.trim();
  const compression = parseInt(document.getElementById('compression').value);

  if (!state.keys.openai) {
    toast('请先在设置中配置 API Key', 'error');
    openSettings();
    return;
  }
  if (!prompt) { toast('请输入描述词', 'error'); return; }

  closeMobileWorkbench();
  if (state.asyncMode === 'async') {
    await generateAsync(prompt, compression);
  } else {
    await generateSync(prompt, compression);
  }
}

/** CND 渠道将比例字符串转换为 API 所需像素尺寸 */
function resolveSizeForChannel(size, channelId) {
  if (channelId !== 'cnd') return size;
  if (!size || size === 'auto' || size.includes('x')) return size || 'auto';
  return CND_RATIO_TO_PX[size] || '1024x1024';
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync Generation (CND 同步)
// ─────────────────────────────────────────────────────────────────────────────
async function generateSync(prompt, compression) {
  const btn = document.getElementById('genBtn');

  state.loading = true;
  showSyncGenerationToast();
  btn.disabled  = true;
  btn.innerHTML = '<div class="spinner"></div> 生成中…';
  document.getElementById('toolbarTitle').textContent = '正在生成，请稍候…';

  // 先创建对话行，放骨架屏
  const chatRow = createChatRow(prompt, {
    size:    state.size,
    quality: state.quality,
    format:  state.format,
    channel: state.channel,
    count:   state.count,
    ts:      Date.now(),
  });
  showSkeletonInRow(chatRow, state.count, state.size);
  scrollToLatest();

  try {
    const result = await generateOpenAIImages({
      apiKey: state.keys.openai,
      prompt,
      size: state.size,
      quality: state.quality,
      format: state.format,
      compression,
      count: state.count,
      refImages: state.refImages,
    });
    const json = result.raw;
    const images = result.images;

    hideSkeletonInRow(chatRow);

    const recId = genId();
    const mime = imageMimeFromFormat(state.format);
    const blobs = [];
    for (const item of images) {
      if (!item?.b64_json) continue;
      const sourceMime = item.output_format ? imageMimeFromFormat(item.output_format) : 'image/png';
      const rawBlob = base64ToBlob(item.b64_json, sourceMime);
      blobs.push(await transcodeBlobForOutput(rawBlob, state.format, compression));
      if (images.length > 1) await nextPaint();
    }
    const { storedImages, preparedImages } = await persistBlobImages(recId, blobs, mime);
    const rec   = {
      id:          recId,
      ts:          Date.now(),
      channel:     state.channel,
      prompt,
      size:        state.size,
      quality:     state.quality,
      format:      state.format,
      compression,
      count:       state.count,
      images:      storedImages,
      usage:       json.usage || null,
    };
    const saved = await saveRecord(rec);
    if (!saved) {
      await deleteStoredImageRefs(storedImages);
      preparedImages.forEach(item => revokeObjectUrl(item.objectUrl));
      throw new Error('本地记录保存失败');
    }

    renderImagesInRow(chatRow, preparedImages, state.format, state.size, recId, state.channel, json.usage || null);
    await accumulateUsageStats(json.usage);

    document.getElementById('emptyState').style.display    = 'none';
    document.getElementById('toolbarTitle').textContent     = '生成完成';
    toast(`成功生成 ${images.length} 张图像`, 'success');
    scrollToLatest();

  } catch (err) {
    hideSkeletonInRow(chatRow);
    // 如果出错且行内没有任何内容，移除这个空行
    const col = chatRow.querySelector('.chat-col-images');
    if (col && !col.children.length) chatRow.remove();
    const feed = document.getElementById('chatFeed');
    if (!feed.children.length) setEmptyState(true);
    document.getElementById('toolbarTitle').textContent = '生成失败';
    toast(err.message || '请求失败，请检查 API Key 和网络', 'error');
    console.error('[generateSync]', err);
  } finally {
    state.loading = false;
    hideSyncGenerationToast();
    btn.disabled  = false;
    btn.innerHTML = `${PLAY_ICON} 开始生成`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream response parser (流式 SSE 解析，用于 stream + partial_images)
// ─────────────────────────────────────────────────────────────────────────────
async function parseStreamResponse(res) {
  if (!res.ok) {
    let errJson = {};
    try { errJson = await res.json(); } catch (_) {}
    throw new Error(errJson?.error?.message || `HTTP ${res.status}`);
  }
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(raw); } catch (_) { continue; }
      if (ev.type === 'partial_image' && (ev.partial_image_b64 || ev.b64)) {
        updateSkeletonWithPartial(ev.index ?? ev.partial_image_index ?? 0, ev.partial_image_b64 || ev.b64);
      } else if (ev.type === 'response.done' && ev.response) {
        finalResponse = ev.response;
      }
    }
  }
  if (!finalResponse) throw new Error('流式响应未返回最终结果');
  return finalResponse;
}

/** 将 SSE 局部预览图渲染到对应骨架屏格子 */
function updateSkeletonWithPartial(index, b64) {
  if (!_activeSyncRow) return;
  const col  = _activeSyncRow.querySelector('.chat-col-images');
  if (!col) return;
  const cards = col.querySelectorAll('.skeleton-card');
  const card  = cards[index];
  if (!card) return;
  const imgArea = card.querySelector('.skeleton-img');
  if (!imgArea) return;
  const mime = imageMimeFromFormat(state.format);
  imgArea.style.backgroundImage    = `url(data:${mime};base64,${b64})`;
  imgArea.style.backgroundSize     = 'cover';
  imgArea.style.backgroundPosition = 'center';
  imgArea.classList.add('has-partial');
}

// ─────────────────────────────────────────────────────────────────────────────
// Async Generation (CND 异步)
// ─────────────────────────────────────────────────────────────────────────────
async function generateAsync(prompt, compression) {
  const ch  = CHANNEL.openai;
  const btn = document.getElementById('genBtn');

  btn.disabled  = true;
  btn.innerHTML = '<div class="spinner"></div> 提交中…';

  let chatRow = null;
  let col = null;

  try {
    const batchN = Math.min(maxCount(), Math.max(1, state.count));
    const batchId = genId();
    const submittedAt = Date.now();

    // Create one shared chat row for all tasks in this batch
    chatRow = createChatRow(prompt, {
      size:    state.size,
      quality: state.quality,
      format:  state.format,
      channel: state.channel,
      count:   batchN,
      ts:      submittedAt,
    });
    col = chatRow.querySelector('.chat-col-images');
    scrollToLatest();

    for (let i = 0; i < batchN; i++) {
      const body = {
        model:   CHANNEL.openai.defaultModel,
        prompt,
        size:    state.size,
        quality: state.quality,
        output_format: String(state.format || 'PNG').toLowerCase(),
        response_format: 'b64_json',
        n: 1,
      };

      // 异步模式：参考图用 images 字段，支持多张 data URL
      if (state.refImages.length) {
        body.images = state.refImages.map(r => ({ image_url: r.dataUrl }));
        body.input_fidelity = 'high';
      }

      const endpoint = asyncTaskEndpoint();
      const taskUrl = state.refImages.length ? `${endpoint}?mode=edit` : endpoint;
      const res  = await fetch(taskUrl, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${state.keys.openai}`,
        },
        body: JSON.stringify(body),
      });

      const json = await readJsonResponse(res, `异步任务提交 ${taskUrl}`);
      if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);

      const taskId = json.id;
      if (!taskId) throw new Error('未返回任务 ID');

      const cardId = genId();
      registerPendingTask(taskId, cardId, 0);

      const card = createPendingCard(cardId, taskId, state.size, state.channel);
      col.appendChild(card);
      updatePendingStatus(cardId, '排队中', '');

      await db.saveTask({
        taskId,
        cardId,
        batchId,
        channel: state.channel,
        prompt,
        compression,
        params: {
          size: state.size,
          quality: state.quality,
          format: state.format,
          count: 1,
        },
        submittedAt,
        ts: submittedAt,
      });
      markCacheSizeDirty();

      schedulePoll(taskId, prompt, compression);
    }

    updateToolbarBadge();
    toast(
      batchN > 1
        ? `已提交 ${batchN} 个异步任务，后台轮询中…`
        : '任务已提交，后台轮询中…',
      'info',
    );
    document.getElementById('toolbarTitle').textContent = '异步任务处理中…';
  } catch (err) {
    if (chatRow && !col?.children.length) removeRowWithDivider(chatRow);
    toast(err.message || '提交失败，请检查 API Key 和网络', 'error');
    console.error('[generateAsync]', err);
  } finally {
    btn.disabled  = false;
    btn.innerHTML = `${PLAY_ICON} 开始生成`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling
// ─────────────────────────────────────────────────────────────────────────────
function schedulePoll(taskId, prompt, compression) {
  const poll = state.pendingPolls.get(taskId);
  if (!poll) return;

  const tid = setTimeout(() => doPoll(taskId, prompt, compression), pollDelayForTask(taskId));
  poll.timerId = tid;
}

async function doPoll(taskId, prompt, compression) {
  const poll = state.pendingPolls.get(taskId);
  if (!poll) return;   // task was cancelled

  poll.attempts++;
  try {
    const res  = await fetch(asyncTaskPollUrl(taskId), {
      headers: { 'Authorization': `Bearer ${state.keys.openai}` },
    });
    const json = await readJsonResponse(res, '异步任务查询');
    if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);

    // Async task response: { status: "queued"|"running"|"completed"|"failed", data: [...] }
    const status = json.status || 'unknown';

    if (status === 'queued') {
      updatePendingStatus(poll.cardId, '排队中', '');
      if (poll.attempts >= POLL_MAX) throw new Error('任务超时，请稍后刷新页面重试');
      schedulePoll(taskId, prompt, compression);

    } else if (status === 'running' || status === 'in_progress') {
      const pct = Math.min(88, Math.round(Math.sqrt(poll.attempts / POLL_MAX) * 110));
      updatePendingStatus(poll.cardId, '进行中', pct + '%', pct);
      if (poll.attempts >= POLL_MAX) throw new Error('任务超时，请稍后刷新页面重试');
      schedulePoll(taskId, prompt, compression);

    } else if (status === 'completed') {
      const images = Array.isArray(json.data) ? json.data : [];
      if (!images.length) throw new Error('任务完成但未返回图片');
      const data = { images };
      queueAsyncFinalizeTask(taskId, prompt, compression, data, json.usage || null);

    } else if (status === 'failed') {
      throw new Error('任务处理失败');

    } else {
      // unknown — keep polling
      updatePendingStatus(poll.cardId, '处理中', '');
      if (poll.attempts >= POLL_MAX) throw new Error('任务超时，请稍后刷新页面重试');
      schedulePoll(taskId, prompt, compression);
    }

  } catch (err) {
    failAsyncTask(taskId, poll, err.message);
  }
}

async function persistAsyncImages(rawImages, cardId, recordId, fallbackMime, fmt = 'PNG', compression = 100) {
  const list = Array.isArray(rawImages) ? rawImages : [];
  const blobs = [];
  for (let i = 0; i < list.length; i++) {
    const img = list[i];
    updatePendingStatus(cardId, '结果整理中', list.length > 1 ? `${i + 1}/${list.length}` : '');
    await nextPaint();
    try {
      if (img.b64_json) {
        const sourceMime = img.output_format ? imageMimeFromFormat(img.output_format) : fallbackMime;
        const rawBlob = base64ToBlob(img.b64_json, sourceMime);
        blobs.push(await transcodeBlobForOutput(rawBlob, fmt, compression));
      } else if (img.url) {
        const r = await fetch(img.url);
        if (!r.ok) continue;
        blobs.push(await r.blob());
      }
    } catch {
      // ignore and continue; if all fail, caller will surface an error
    }
  }
  if (!blobs.length) return { storedImages: [], preparedImages: [] };
  return await persistBlobImages(recordId, blobs, fallbackMime);
}

async function finishAsyncTask(taskId, poll, data, prompt, compression, usage) {
  const stored = await db.getTaskById(taskId).catch(() => null);
  const params = stored?.params || { size: state.size, format: state.format, quality: state.quality, count: 1 };

  const recId = genId();
  const mime = imageMimeFromFormat(params.format);
  const { storedImages, preparedImages } = await persistAsyncImages(
    data.images || [],
    poll.cardId,
    recId,
    mime,
    params.format,
    stored?.compression ?? compression,
  );

  if (!storedImages.length) {
    throw new Error('无法加载生成的图像');
  }

  updatePendingStatus(poll.cardId, '写入本地中', '');
  await nextPaint();

  const rec   = {
      id:          recId,
      ts:          Date.now(),
      channel:     'openai',
      prompt:      stored?.prompt || prompt,
      size:        params.size,
      quality:     params.quality,
      format:      params.format,
      compression: stored?.compression ?? compression,
      count:       storedImages.length,
      images:      storedImages,
      usage:       usage || null,
      batchId:     stored?.batchId || null,
    };
  const saved = await saveRecord(rec);
  if (!saved) {
    await deleteStoredImageRefs(storedImages);
    preparedImages.forEach(item => revokeObjectUrl(item.objectUrl));
    throw new Error('本地记录保存失败');
  }

  resolvePendingCard(poll.cardId, taskId, preparedImages, params.format, params.size, recId, 'openai');
  await accumulateUsageStats(usage);

  // Clean up
  state.pendingPolls.delete(taskId);
  await db.deleteTask(taskId).catch(() => {});
  markCacheSizeDirty();

  scrollToLatest();
  document.getElementById('toolbarTitle').textContent = '生成完成';
  toast(`异步任务完成，已生成 ${storedImages.length} 张图像`, 'success');
}

function failAsyncTask(taskId, poll, message) {
  clearTimeout(poll.timerId);
  removeQueuedFinalizeTask(taskId);
  state.pendingPolls.delete(taskId);
  db.deleteTask(taskId).catch(() => {});
  markCacheSizeDirty();

  const feed = document.getElementById('chatFeed');
  const card = feed.querySelector(`[data-card-id="${poll.cardId}"]`);
  if (card) {
    const row = card.closest('.chat-row');
    card.remove();
    if (row) {
      const col = row.querySelector('.chat-col-images');
      if (col && !col.children.length) removeRowWithDivider(row);
    }
  }

  if (!feed.querySelector('.image-card, .image-card-pending')) setEmptyState(true);
  updateToolbarBadge();

  document.getElementById('toolbarTitle').textContent = '异步任务失败';
  toast(`任务失败：${message}`, 'error');
  console.error('[doPoll]', message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Page-reload Recovery
// ─────────────────────────────────────────────────────────────────────────────
async function resumePendingTasks() {
  const tasks = await db.getAllTasks().catch(() => []);
  if (!tasks.length) return;

  toast(`发现 ${tasks.length} 个待恢复的异步任务，正在恢复…`, 'info', 4000);

  // Group by batchId; tasks without batchId (legacy) each get their own group
  const groups = new Map();
  for (const task of tasks) {
    const key = task.batchId || task.taskId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }

  for (const groupTasks of groups.values()) {
    const first = groupTasks[0];
    const { channel, prompt, params } = first;

    const chatRow = createChatRow(prompt || '', {
      size:    params?.size    || '1024x1536',
      quality: params?.quality || 'high',
      format:  params?.format  || 'PNG',
      channel: channel || 'openai',
      count:   groupTasks.length,
      ts:      first.submittedAt ?? first.ts,
    });
    const col = chatRow.querySelector('.chat-col-images');

    for (const task of groupTasks) {
      const { taskId, cardId, compression, params: tp } = task;
      const card = createPendingCard(cardId, taskId, tp?.size || '1024x1536', task.channel || 'openai');
      col.appendChild(card);
      if (task.paused) {
        setPendingCardPaused(card, taskId);
      } else {
        registerPendingTask(taskId, cardId, 0);
        updatePendingStatus(cardId, '排队中', '');
        setTimeout(() => doPoll(taskId, task.prompt, compression), 1500);
      }
    }
  }

  updateToolbarBadge();
  requestAnimationFrame(() => scrollToLatest(true));
}

// ─────────────────────────────────────────────────────────────────────────────
// Examples & History — gallery grid (2:3 frame, pagination)
// ─────────────────────────────────────────────────────────────────────────────
function flattenHistoryItems(records) {
  const flat = [];
  for (const rec of records) {
    (rec.images || []).forEach((_, imgIdx) => flat.push({ rec, imgIdx }));
  }
  return flat;
}

function historyGalleryCardHtml(item, src) {
  const { rec, imgIdx } = item;
  if (!rec.images?.[imgIdx] || !src) return '';
  return `
    <div class="modal-gallery-card image-card modal-gallery-card-compact example-gallery-card" data-rec-id="${escapeAttr(rec.id)}" data-img-idx="${imgIdx}">
      <button type="button" class="card-del-btn" title="删除整条记录">✕</button>
      <div class="modal-card-media-23">
        <img src="${escapeAttr(src)}" alt="" loading="lazy" />
      </div>
      <div class="modal-gallery-card-footer example-gallery-card-footer">
        <div class="modal-gallery-title" title="${escapeAttr(rec.prompt)}">${esc(rec.prompt)}</div>
        <div class="modal-gallery-sub">${esc(rec.size)} · ${esc(rec.quality)} · ${esc(rec.format)}</div>
        <div class="modal-gallery-actions">
          <button type="button" class="btn-ghost modal-gallery-action-btn hist-copy-prompt">复制提示词</button>
          <button type="button" class="btn-ghost modal-gallery-action-btn hist-use-config">使用配置</button>
        </div>
      </div>
    </div>`;
}

function exampleGalleryCardHtml(ex, globalIdx) {
  const imgSrc = ex.image ? String(ex.image) : '';
  const cover = imgSrc
    ? `<img src="${escapeAttr(imgSrc)}" alt="" loading="lazy" />`
    : `<div class="modal-card-media-placeholder">无预览</div>`;
  const fmt = ex.output_format != null ? String(ex.output_format) : '';
  return `
    <div class="modal-gallery-card image-card modal-gallery-card-compact example-gallery-card" data-ex-idx="${globalIdx}">
      <div class="modal-card-media-23">${cover}</div>
      <div class="modal-gallery-card-footer example-gallery-card-footer">
        <div class="modal-gallery-title" title="${escapeAttr(ex.prompt || '')}">${esc(ex.prompt || '')}</div>
        <div class="modal-gallery-sub">${esc(ex.size)} · ${esc(ex.quality)} · ${esc(fmt)}</div>
        <div class="modal-gallery-actions">
          <button type="button" class="btn-ghost modal-gallery-action-btn ex-copy-prompt">复制提示词</button>
          <button type="button" class="btn-ghost modal-gallery-action-btn ex-use-config">使用配置</button>
        </div>
      </div>
    </div>`;
}

function bindHistoryGalleryCards(body, records, srcMap) {
  const recordMap = new Map(records.map(rec => [rec.id, rec]));
  body.querySelectorAll('.modal-gallery-card').forEach(card => {
    const recId = card.dataset.recId;
    const imgIdx = parseInt(card.dataset.imgIdx, 10);
    const rec = recordMap.get(recId);
    if (!rec || !rec.images?.[imgIdx]) return;

    const src = srcMap.get(`${recId}:${imgIdx}`) || '';

    card.querySelector('.card-del-btn').addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm('确定删除整条生成记录？')) return;
      void (async () => {
        await deleteRecordWithAssets(recId);
        const left = await getRecords();
        if (!left.length) {
          closeHistoryModal();
          return;
        }
        await renderHistoryGallery(_historyGalleryPage);
      })();
    });

    card.querySelector('.modal-card-media-23 img').addEventListener('click', e => {
      e.stopPropagation();
      openLightbox(src);
    });

    card.querySelector('.hist-copy-prompt').addEventListener('click', e => {
      e.stopPropagation();
      if (!rec) return;
      navigator.clipboard.writeText(rec.prompt).then(() => toast('提示词已复制', 'success'));
    });

    card.querySelector('.hist-use-config').addEventListener('click', e => {
      e.stopPropagation();
      void useConfig(recId).then(() => closeHistoryModal());
    });
  });
}

async function renderHistoryGallery(page, recordsInput = null) {
  const records = recordsInput || _historyRecords || await getRecords();
  const body = document.getElementById('historyModalBody');
  if (!records.length) {
    closeHistoryModal();
    return;
  }
  const flat = flattenHistoryItems(records);
  if (!flat.length) {
    closeHistoryModal();
    return;
  }

  const totalPages = Math.max(1, Math.ceil(flat.length / MODAL_GALLERY_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);
  _historyGalleryPage = p;
  const start = (p - 1) * MODAL_GALLERY_PAGE_SIZE;
  let slice = flat.slice(start, start + MODAL_GALLERY_PAGE_SIZE);
  if (!slice.length && p > 1) {
    return await renderHistoryGallery(p - 1);
  }
  resetHistoryModalObjectUrls();
  const srcMap = new Map();
  const sliceSources = await Promise.all(slice.map(async item => {
    const img = item.rec.images?.[item.imgIdx];
    const row = await materializeStoredImage(img, item.rec.format);
    if (row?.objectUrl) _historyModalObjectUrls.push(row.objectUrl);
    const key = `${item.rec.id}:${item.imgIdx}`;
    if (row?.src) srcMap.set(key, row.src);
    return row?.src || '';
  }));

  const pager = totalPages > 1 ? `
    <div class="modal-gallery-pager">
      <button type="button" class="btn-ghost hist-gallery-prev">上一页</button>
      <span class="modal-gallery-pageinfo">${p} / ${totalPages}</span>
      <button type="button" class="btn-ghost hist-gallery-next">下一页</button>
    </div>` : '';

  body.innerHTML =
    '<div class="modal-gallery-grid">' +
    slice.map((item, idx) => historyGalleryCardHtml(item, sliceSources[idx])).join('') +
    '</div>' +
    pager;

  if (totalPages > 1) {
    const prev = body.querySelector('.hist-gallery-prev');
    const next = body.querySelector('.hist-gallery-next');
    prev.disabled = p <= 1;
    next.disabled = p >= totalPages;
    prev.addEventListener('click', () => void renderHistoryGallery(p - 1));
    next.addEventListener('click', () => void renderHistoryGallery(p + 1));
  }

  bindHistoryGalleryCards(body, records, srcMap);
}

function renderExamplesGallery(page) {
  const body = document.getElementById('examplesModalBody');
  const list = _examples || [];
  const totalPages = Math.max(1, Math.ceil(list.length / MODAL_GALLERY_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);
  _examplesGalleryPage = p;
  const start = (p - 1) * MODAL_GALLERY_PAGE_SIZE;
  const slice = list.slice(start, start + MODAL_GALLERY_PAGE_SIZE);

  const pager = totalPages > 1 ? `
    <div class="modal-gallery-pager">
      <button type="button" class="btn-ghost examples-gallery-prev">上一页</button>
      <span class="modal-gallery-pageinfo">${p} / ${totalPages}</span>
      <button type="button" class="btn-ghost examples-gallery-next">下一页</button>
    </div>` : '';

  body.innerHTML =
    '<div class="modal-gallery-grid">' +
    slice.map((ex, i) => exampleGalleryCardHtml(ex, start + i)).join('') +
    '</div>' +
    pager;

  if (totalPages > 1) {
    const prev = body.querySelector('.examples-gallery-prev');
    const next = body.querySelector('.examples-gallery-next');
    prev.disabled = p <= 1;
    next.disabled = p >= totalPages;
    prev.addEventListener('click', () => renderExamplesGallery(p - 1));
    next.addEventListener('click', () => renderExamplesGallery(p + 1));
  }

  body.querySelectorAll('.example-gallery-card').forEach(card => {
    const idx = parseInt(card.dataset.exIdx, 10);
    const img = card.querySelector('.modal-card-media-23 img');
    if (img) {
      img.addEventListener('click', e => {
        e.stopPropagation();
        openLightbox(img.src);
      });
    }
    card.querySelector('.ex-copy-prompt').addEventListener('click', e => {
      e.stopPropagation();
      const ex = _examples?.[idx];
      if (!ex) return;
      navigator.clipboard.writeText(ex.prompt).then(() => toast('提示词已复制', 'success'));
    });
    card.querySelector('.ex-use-config').addEventListener('click', e => {
      e.stopPropagation();
      applyExample(idx);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Examples Modal
// ─────────────────────────────────────────────────────────────────────────────
async function openExamplesModal() {
  if (!_examples) {
    try {
      const res = await fetch('assets/examples/list.json');
      if (!res.ok) throw new Error();
      _examples = await res.json();
    } catch {
      toast('加载示例失败', 'error');
      return;
    }
  }
  if (!_examples.length) {
    toast('暂无示例', 'info');
    return;
  }

  _examplesGalleryPage = 1;
  renderExamplesGallery(1);
  document.getElementById('examplesModal').classList.add('open');
}

function closeExamplesModal() {
  document.getElementById('examplesModal').classList.remove('open');
}

function applyExample(idx) {
  const ex = _examples?.[idx];
  if (!ex) return;

  document.getElementById('prompt').value = ex.prompt;
  updateCharCount();

  applySize(ex.size);

  const qualEl = document.querySelector(`[data-q="${ex.quality}"]`);
  if (qualEl) selectQuality(qualEl);

  const fmtEl = document.querySelector(`[data-fmt="${ex.output_format}"]`);
  if (fmtEl) selectFormat(fmtEl);

  document.getElementById('compression').value     = ex.output_compression;
  document.getElementById('compressionVal').textContent = ex.output_compression;
  state.compression = ex.output_compression;

  state.count = 1;
  syncCountStepperUi();

  closeExamplesModal();
  toast('已应用示例', 'success');
}

// ─────────────────────────────────────────────────────────────────────────────
// History Modal
// ─────────────────────────────────────────────────────────────────────────────
async function openHistoryModal() {
  const records = await getRecords();
  if (!records.length) { toast('暂无历史记录', 'info'); return; }
  if (!flattenHistoryItems(records).length) { toast('暂无历史记录', 'info'); return; }

  setHistoryRecords(records);
  _historyGalleryPage = 1;
  await renderHistoryGallery(1, records);
  document.getElementById('historyModal').classList.add('open');
}

function closeHistoryModal() {
  setHistoryRecords(null);
  resetHistoryModalObjectUrls();
  document.getElementById('historyModal').classList.remove('open');
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail Modal
// ─────────────────────────────────────────────────────────────────────────────
async function showImageDetail(recId) {
  if (!recId) return;
  const rec = await getRecord(recId);
  if (!rec) return;

  const time = new Date(rec.ts).toLocaleString('zh-CN', {
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit',
  });

  const row = (label, value) => `
    <div>
      <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px;">${label}</div>
      <div style="font-size:13px;color:var(--text);">${value}</div>
    </div>`;

  let html = `
    ${row('生成时间', time)}
    <div style="margin:16px 0;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <div style="font-size:12px;font-weight:600;color:var(--text-muted);">提示词</div>
        <button class="btn-ghost copy-prompt-btn" data-rec-id="${rec.id}"
          style="padding:4px 10px;font-size:11px;">复制</button>
      </div>
      <div style="font-size:13px;color:var(--text);line-height:1.6;white-space:pre-wrap;word-break:break-word;">
        ${esc(rec.prompt)}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
      ${row('画面比例', esc(rec.size))}
      ${row('生成质量', esc(rec.quality))}
      ${row('输出格式', esc(rec.format))}
      ${row('压缩级别', rec.compression ?? '—')}
      ${row('渠道', esc(CHANNEL[rec.channel]?.name || rec.channel || 'OpenAI'))}
    </div>`;

  // Usage — only render if present and has at least one valid value
  const u = rec.usage;
  const hasUsage = u && (u.input_tokens != null || u.output_tokens != null || u.total_tokens != null);
  if (hasUsage) {
    html += `
      <div style="margin-bottom:16px;">
        <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px;">Token 消耗</div>
        <div style="display:flex;gap:12px;font-size:13px;color:var(--text);">
          <span>输入: ${u.input_tokens ?? '—'}</span>
          <span>输出: ${u.output_tokens ?? '—'}</span>
          <span>合计: ${u.total_tokens ?? '—'}</span>
        </div>
      </div>`;
  } else {
    html += `
      <div style="margin-bottom:16px;">
        <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px;">Token 消耗</div>
        <div style="font-size:12px;color:var(--text-dim);">暂无 Token 数据（异步渠道可能不返回）</div>
      </div>`;
  }

  html += `
    <div style="margin-top:20px;display:flex;justify-content:flex-end;">
      <button class="btn-ghost use-config-btn" data-rec-id="${rec.id}"
        style="padding:8px 16px;">使用配置</button>
    </div>`;

  const modalBody = document.getElementById('detailModalBody');
  modalBody.innerHTML = html;

  modalBody.querySelector('.copy-prompt-btn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(rec.prompt).then(() => toast('提示词已复制', 'success'));
  });
  modalBody.querySelector('.use-config-btn')?.addEventListener('click', () => {
    void useConfig(rec.id);
    closeDetailModal();
  });

  document.getElementById('detailModal').classList.add('open');
}

function closeDetailModal() {
  document.getElementById('detailModal').classList.remove('open');
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Config
// ─────────────────────────────────────────────────────────────────────────────
async function useConfig(recId) {
  if (!recId) return;
  const rec = await getRecord(recId);
  if (!rec) return;

  document.getElementById('prompt').value = rec.prompt;
  updateCharCount();

  applySize(rec.size);

  const qualEl = document.querySelector(`[data-q="${rec.quality}"]`);
  if (qualEl) selectQuality(qualEl);

  const fmtEl = document.querySelector(`[data-fmt="${rec.format}"]`);
  if (fmtEl) selectFormat(fmtEl);

  document.getElementById('compression').value      = rec.compression ?? 100;
  document.getElementById('compressionVal').textContent = rec.compression ?? 100;
  state.compression = rec.compression ?? 100;

  state.count = Math.min(maxCount(), Math.max(1, rec.count || 1));
  syncCountStepperUi();

  toast('配置已应用', 'success');
}

// ─────────────────────────────────────────────────────────────────────────────
// Clear Canvas
// ─────────────────────────────────────────────────────────────────────────────
function clearCanvas() {
  const feed = document.getElementById('chatFeed');
  revokeObjectUrlsIn(feed);
  setEmptyState(true);
  document.getElementById('tokenInfo').style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference Images
// ─────────────────────────────────────────────────────────────────────────────
function removeRefImage(idx) {
  state.refImages.splice(idx, 1);
  renderRefImages();
}

function clearRefImages() {
  state.refImages = [];
  renderRefImages();
}

function renderRefImages() {
  const el = document.getElementById('refImages');
  if (!state.refImages.length) {
    el.style.display = 'none';
    el.innerHTML     = '';
    return;
  }
  el.style.display = 'flex';
  el.innerHTML = `
    <div class="ref-images-label">
      <span>参考图 (${state.refImages.length})</span>
      <button class="ref-images-clear" id="refClearAll">全部删除</button>
    </div>
    ${state.refImages.map((img, i) => `
      <div class="ref-img-item" data-idx="${i}">
        <img src="${escapeAttr(img.url)}" alt="${esc(img.name)}" title="${esc(img.name)}" />
        <button class="ref-img-del" title="移除">✕</button>
      </div>`).join('')}`;

  document.getElementById('refClearAll').addEventListener('click', () => {
    if (confirm('确定清除所有参考图？')) clearRefImages();
  });

  el.querySelectorAll('.ref-img-item').forEach(item => {
    const i = parseInt(item.dataset.idx);
    item.querySelector('img').addEventListener('click', () =>
      openLightbox(state.refImages[i].url));
    item.querySelector('.ref-img-del').addEventListener('click', e => {
      e.stopPropagation();
      removeRefImage(i);
    });
  });
}
