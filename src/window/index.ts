// ============================================================
// Eagle Cloud Sync - Window Plugin Logic
// Communication with background service + UI state management
// ============================================================

// --- Eagle Plugin API type stubs ---

interface EaglePlugin {
  extraModule: {
    /** Read JSON config from plugin data directory */
    readConfig(): Promise<PluginConfig | null>;
    /** Write JSON config to plugin data directory */
    writeConfig(config: PluginConfig): Promise<void>;
    /** Get current sync engine status from background service */
    getSyncStatus(): Promise<SyncStatus>;
    /** Get recent log entries */
    getLogs(): Promise<ReadonlyArray<LogEntry>>;
    /** Trigger manual sync */
    triggerSync(): Promise<void>;
    /** Start OAuth flow for a provider */
    startOAuth(provider: string): Promise<void>;
  };
}

interface PluginConfig {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly provider: 'baidupan' | 'webdav' | 's3';
  readonly syncMode: 'realtime' | 'interval' | 'manual';
  readonly syncIntervalMs: number;
  readonly lazyPull: boolean;
  readonly maxConcurrentUploads: number;
  readonly maxConcurrentDownloads: number;
  readonly providers: Readonly<Partial<Record<string, ProviderAuth>>>;
}

interface ProviderAuth {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenExpiresAt: number;
}

interface SyncStatus {
  readonly phase: 'idle' | 'pushing' | 'pulling' | 'reconciling' | 'error';
  readonly lastSyncAt: number;
  readonly pendingOperations: number;
  readonly syncedItems: number;
  readonly errors: ReadonlyArray<string>;
}

interface LogEntry {
  readonly timestamp: string;
  readonly level: 'info' | 'warn' | 'error' | 'debug';
  readonly message: string;
}

declare const eagle: EaglePlugin;

// --- Constants ---

const STATUS_POLL_INTERVAL = 2000;
const LOG_POLL_INTERVAL = 3000;
const MAX_LOG_DISPLAY = 200;

const PHASE_LABELS: Record<string, string> = {
  idle: '空闲',
  pushing: '推送中',
  pulling: '拉取中',
  reconciling: '合并中',
  error: '错误',
};

// --- State ---

let currentConfig: PluginConfig | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let logTimer: ReturnType<typeof setInterval> | null = null;
let displayedLogCount = 0;

// --- DOM References ---

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

const dom = {
  // Header
  statusDot: $('statusDot') as HTMLElement,
  headerStatusText: $('headerStatusText') as HTMLElement,

  // Status tab
  lastSyncTime: $('lastSyncTime') as HTMLElement,
  syncedCount: $('syncedCount') as HTMLElement,
  currentPhase: $('currentPhase') as HTMLElement,
  pendingOps: $('pendingOps') as HTMLElement,
  syncNowBtn: $('syncNowBtn') as HTMLButtonElement,

  // Settings tab
  providerSelect: $('providerSelect') as HTMLSelectElement,
  authGroup: $('authGroup') as HTMLElement,
  authDot: $('authDot') as HTMLElement,
  authText: $('authText') as HTMLElement,
  authBtn: $('authBtn') as HTMLButtonElement,
  deviceNameInput: $('deviceNameInput') as HTMLInputElement,
  syncModeSelect: $('syncModeSelect') as HTMLSelectElement,
  intervalGroup: $('intervalGroup') as HTMLElement,
  intervalInput: $('intervalInput') as HTMLInputElement,
  lazyPullCheck: $('lazyPullCheck') as HTMLInputElement,

  // Log tab
  logContainer: $('logContainer') as HTMLElement,
  logEmpty: $('logEmpty') as HTMLElement,
};

// --- Tab Navigation ---

function initTabs(): void {
  const tabBtns = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
  const panels = document.querySelectorAll<HTMLElement>('.tab-panel');

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset['tab'];
      if (!tabId) return;

      tabBtns.forEach((b) => b.classList.remove('active'));
      panels.forEach((p) => p.classList.remove('active'));

      btn.classList.add('active');
      const panel = document.getElementById(`panel-${tabId}`);
      if (panel) panel.classList.add('active');
    });
  });
}

// --- Config Loading & Persistence ---

async function loadConfig(): Promise<void> {
  try {
    const config = await eagle.extraModule.readConfig();
    if (config) {
      currentConfig = config;
      renderSettings(config);
    }
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

async function saveConfig(partial: Partial<PluginConfig>): Promise<void> {
  if (!currentConfig) return;

  const updated: PluginConfig = { ...currentConfig, ...partial };
  currentConfig = updated;

  try {
    await eagle.extraModule.writeConfig(updated);
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}

// --- Settings Rendering ---

function renderSettings(config: PluginConfig): void {
  dom.providerSelect.value = config.provider;
  dom.deviceNameInput.value = config.deviceName;
  dom.syncModeSelect.value = config.syncMode;
  dom.intervalInput.value = String(Math.round(config.syncIntervalMs / 1000));
  dom.lazyPullCheck.checked = config.lazyPull;

  updateIntervalVisibility(config.syncMode);
  updateAuthDisplay(config);
}

function updateIntervalVisibility(mode: string): void {
  if (mode === 'interval') {
    dom.intervalGroup.classList.add('visible');
  } else {
    dom.intervalGroup.classList.remove('visible');
  }
}

function updateAuthDisplay(config: PluginConfig): void {
  const provider = config.provider;
  const auth = config.providers[provider];

  // Only show auth section for providers that need OAuth
  if (provider === 'baidupan') {
    dom.authGroup.classList.remove('hidden');
  } else {
    dom.authGroup.classList.add('hidden');
    return;
  }

  const isConnected = auth != null && auth.tokenExpiresAt > Date.now();

  if (isConnected) {
    dom.authDot.classList.add('connected');
    dom.authText.textContent = '已授权';
    dom.authBtn.textContent = '已连接';
    dom.authBtn.classList.add('connected');
    dom.authBtn.disabled = true;
  } else {
    dom.authDot.classList.remove('connected');
    dom.authText.textContent = '未授权';
    dom.authBtn.textContent = '授权';
    dom.authBtn.classList.remove('connected');
    dom.authBtn.disabled = false;
  }
}

// --- Status Polling ---

async function pollStatus(): Promise<void> {
  try {
    const status = await eagle.extraModule.getSyncStatus();
    renderStatus(status);
  } catch {
    // Background service might not be ready yet
    renderStatus({
      phase: 'idle',
      lastSyncAt: 0,
      pendingOperations: 0,
      syncedItems: 0,
      errors: [],
    });
  }
}

function renderStatus(status: SyncStatus): void {
  // Header indicator
  const dotStatus = status.phase === 'idle'
    ? (status.lastSyncAt > 0 ? 'synced' : 'idle')
    : status.phase === 'error'
      ? 'error'
      : 'syncing';

  dom.statusDot.dataset['status'] = dotStatus;

  const statusTexts: Record<string, string> = {
    synced: '已同步',
    idle: '未连接',
    syncing: '同步中...',
    error: '同步错误',
  };
  dom.headerStatusText.textContent = statusTexts[dotStatus] ?? '未知';

  // Status cards
  dom.lastSyncTime.textContent = status.lastSyncAt > 0
    ? formatTime(status.lastSyncAt)
    : '--';
  dom.syncedCount.textContent = String(status.syncedItems);
  dom.currentPhase.textContent = PHASE_LABELS[status.phase] ?? status.phase;
  dom.pendingOps.textContent = String(status.pendingOperations);

  // Sync button state
  const isBusy = status.phase !== 'idle' && status.phase !== 'error';
  dom.syncNowBtn.disabled = isBusy;
  dom.syncNowBtn.textContent = isBusy ? '同步中...' : '立即同步';
}

function formatTime(ts: number): string {
  const date = new Date(ts);
  const now = new Date();

  // If today, show only time
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// --- Log Polling ---

async function pollLogs(): Promise<void> {
  try {
    const entries = await eagle.extraModule.getLogs();
    renderLogs(entries);
  } catch {
    // Silently ignore log fetch failures
  }
}

function renderLogs(entries: ReadonlyArray<LogEntry>): void {
  if (entries.length === 0) {
    dom.logEmpty.classList.remove('hidden');
    return;
  }

  dom.logEmpty.classList.add('hidden');

  // Only render new entries
  const newEntries = entries.slice(displayedLogCount);
  if (newEntries.length === 0) return;

  const fragment = document.createDocumentFragment();

  for (const entry of newEntries) {
    const el = document.createElement('div');
    el.className = 'log-entry';
    el.dataset['level'] = entry.level;

    const time = document.createElement('span');
    time.className = 'log-timestamp';
    time.textContent = entry.timestamp.slice(11, 19); // HH:MM:SS

    const msg = document.createElement('span');
    msg.className = 'log-message';
    msg.textContent = entry.message;

    el.appendChild(time);
    el.appendChild(msg);
    fragment.appendChild(el);
  }

  dom.logContainer.appendChild(fragment);
  displayedLogCount = entries.length;

  // Trim old entries from DOM if too many
  while (dom.logContainer.children.length > MAX_LOG_DISPLAY + 1) {
    const firstEntry = dom.logContainer.querySelector('.log-entry');
    if (firstEntry) firstEntry.remove();
  }

  // Auto-scroll to bottom
  dom.logContainer.scrollTop = dom.logContainer.scrollHeight;
}

// --- Event Handlers ---

function bindEvents(): void {
  // Sync Now
  dom.syncNowBtn.addEventListener('click', async () => {
    dom.syncNowBtn.disabled = true;
    dom.syncNowBtn.textContent = '同步中...';
    try {
      await eagle.extraModule.triggerSync();
    } catch (err) {
      console.error('Trigger sync failed:', err);
    }
  });

  // Provider change
  dom.providerSelect.addEventListener('change', () => {
    const provider = dom.providerSelect.value as PluginConfig['provider'];
    saveConfig({ provider });
    if (currentConfig) {
      updateAuthDisplay({ ...currentConfig, provider });
    }
  });

  // Auth button
  dom.authBtn.addEventListener('click', async () => {
    if (!currentConfig) return;
    try {
      await eagle.extraModule.startOAuth(currentConfig.provider);
    } catch (err) {
      console.error('OAuth flow failed:', err);
    }
  });

  // Device name (debounced save)
  let deviceNameTimer: ReturnType<typeof setTimeout> | null = null;
  dom.deviceNameInput.addEventListener('input', () => {
    if (deviceNameTimer) clearTimeout(deviceNameTimer);
    deviceNameTimer = setTimeout(() => {
      saveConfig({ deviceName: dom.deviceNameInput.value.trim() });
    }, 500);
  });

  // Sync mode
  dom.syncModeSelect.addEventListener('change', () => {
    const mode = dom.syncModeSelect.value as PluginConfig['syncMode'];
    updateIntervalVisibility(mode);
    saveConfig({ syncMode: mode });
  });

  // Interval
  let intervalTimer: ReturnType<typeof setTimeout> | null = null;
  dom.intervalInput.addEventListener('input', () => {
    if (intervalTimer) clearTimeout(intervalTimer);
    intervalTimer = setTimeout(() => {
      const seconds = parseInt(dom.intervalInput.value, 10);
      if (seconds >= 10 && seconds <= 3600) {
        saveConfig({ syncIntervalMs: seconds * 1000 });
      }
    }, 500);
  });

  // Lazy pull
  dom.lazyPullCheck.addEventListener('change', () => {
    saveConfig({ lazyPull: dom.lazyPullCheck.checked });
  });
}

// --- Initialization ---

function startPolling(): void {
  pollStatus();
  pollLogs();

  statusTimer = setInterval(pollStatus, STATUS_POLL_INTERVAL);
  logTimer = setInterval(pollLogs, LOG_POLL_INTERVAL);
}

function stopPolling(): void {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }
}

async function init(): Promise<void> {
  initTabs();
  bindEvents();
  await loadConfig();
  startPolling();
}

// Pause polling when window is hidden to save resources
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else {
    startPolling();
  }
});

// Boot
init().catch((err) => {
  console.error('Window plugin init failed:', err);
});
