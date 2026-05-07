// ============================================================
// Eagle Cloud Sync - Window Plugin
// Uses Node.js fs directly (Eagle plugins support Node 16)
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');

// Import sync runner
require('./sync-runner');
const SyncRunner = (globalThis as any).__SyncRunner;

// --- Eagle global type ---
declare const eagle: {
  library: { name: string; path: string };
  onPluginCreate: (cb: (plugin: { path: string }) => void) => void;
};

// --- State ---
let pluginPath = '';
let syncEnabled = false;
let selectedSyncFolder = '';
let syncRunner: any = null;

// --- Config persistence ---

interface Config {
  syncFolder: string;
  deviceName: string;
  syncMode: string;
  syncIntervalSec: number;
  lazyPull: boolean;
  enabledLibraries: string[];
}

function getConfigPath(): string {
  return path.join(pluginPath, 'config.json');
}

function loadConfig(): Config {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {
      syncFolder: '',
      deviceName: os.hostname(),
      syncMode: 'realtime',
      syncIntervalSec: 60,
      lazyPull: true,
      enabledLibraries: [],
    };
  }
}

function saveConfig(config: Config): void {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}

// --- Sync folder detection ---

function detectSyncFolders(): Array<{ name: string; path: string }> {
  const home = os.homedir();
  const platform = os.platform();

  const candidates: Array<{ name: string; path: string }> = [];

  if (platform === 'darwin') {
    // macOS paths
    candidates.push(
      // BaiduPan - multiple possible locations
      { name: '百度网盘同步空间', path: path.join(home, 'BaiduNetdiskSync') },
      { name: '百度网盘同步空间', path: path.join(home, '百度网盘同步空间') },
      { name: '百度网盘同步空间', path: path.join(home, '百度网盘', '同步空间') },
      { name: '百度网盘同步空间', path: path.join(home, 'Documents', 'BaiduNetdiskSync') },
      { name: '百度网盘同步空间', path: path.join(home, 'Library', 'CloudStorage', 'BaiduNetdiskSync') },
      // JianguoYun
      { name: '坚果云', path: path.join(home, 'Nutstore Files') },
      { name: '坚果云', path: path.join(home, 'Nutstore') },
      // OneDrive
      { name: 'OneDrive', path: path.join(home, 'OneDrive') },
      { name: 'OneDrive', path: path.join(home, 'Library', 'CloudStorage', 'OneDrive-Personal') },
      // Dropbox
      { name: 'Dropbox', path: path.join(home, 'Dropbox') },
      { name: 'Dropbox', path: path.join(home, 'Library', 'CloudStorage', 'Dropbox') },
      // iCloud
      { name: 'iCloud Drive', path: path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs') },
    );
  } else if (platform === 'win32') {
    // Windows paths
    candidates.push(
      // BaiduPan - Windows common locations
      { name: '百度网盘同步空间', path: path.join(home, 'BaiduNetdiskSync') },
      { name: '百度网盘同步空间', path: path.join(home, '百度网盘同步空间') },
      { name: '百度网盘同步空间', path: path.join(home, '百度网盘', '同步空间') },
      { name: '百度网盘同步空间', path: path.join('D:', '百度网盘同步空间') },
      { name: '百度网盘同步空间', path: path.join('D:', 'BaiduNetdiskSync') },
      { name: '百度网盘同步空间', path: path.join('E:', '百度网盘同步空间') },
      { name: '百度网盘同步空间', path: path.join('E:', 'BaiduNetdiskSync') },
      { name: '百度网盘同步空间', path: path.join(home, 'Documents', 'BaiduNetdiskSync') },
      // JianguoYun
      { name: '坚果云', path: path.join(home, 'Nutstore') },
      { name: '坚果云', path: path.join(home, 'Nutstore Files') },
      // OneDrive
      { name: 'OneDrive', path: path.join(home, 'OneDrive') },
      { name: 'OneDrive', path: path.join(home, 'OneDrive - Personal') },
      // Dropbox
      { name: 'Dropbox', path: path.join(home, 'Dropbox') },
    );
  } else {
    // Linux
    candidates.push(
      { name: 'OneDrive', path: path.join(home, 'OneDrive') },
      { name: 'Dropbox', path: path.join(home, 'Dropbox') },
      { name: '坚果云', path: path.join(home, 'Nutstore Files') },
    );
  }

  // Also try to find BaiduPan sync folder from its config file (macOS)
  if (platform === 'darwin') {
    try {
      const configDir = path.join(home, 'Library', 'Application Support', 'com.baidu.BaiduNetdisk');
      if (fs.existsSync(configDir)) {
        // Look for sync folder path in plist or json configs
        const files = fs.readdirSync(configDir);
        for (const f of files) {
          if (f.includes('sync') || f.includes('Sync')) {
            const content = fs.readFileSync(path.join(configDir, f), 'utf-8');
            // Try to extract path from content
            const match = content.match(/"syncPath"\s*:\s*"([^"]+)"/);
            if (match && match[1]) {
              candidates.push({ name: '百度网盘同步空间 (配置)', path: match[1] });
            }
          }
        }
      }
    } catch { /* best-effort */ }
  }

  // Deduplicate by path and filter to existing directories
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.path)) return false;
    seen.add(c.path);
    try {
      return fs.statSync(c.path).isDirectory();
    } catch {
      return false;
    }
  });
}

// --- DOM helpers ---

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// --- UI Logic ---

function initTabs(): void {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabId = (btn as HTMLElement).dataset['tab'];
      if (!tabId) return;
      tabBtns.forEach((b) => b.classList.remove('active'));
      panels.forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById(`panel-${tabId}`);
      if (panel) panel.classList.add('active');
    });
  });
}

function populateSyncFolders(): void {
  const select = $('syncFolderSelect') as HTMLSelectElement | null;
  if (!select) return;

  const folders = detectSyncFolders();
  select.innerHTML = '';

  if (folders.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '未检测到同步盘，请手动选择';
    select.appendChild(opt);
  } else {
    for (const folder of folders) {
      const opt = document.createElement('option');
      opt.value = folder.path;
      opt.textContent = `${folder.name} (${folder.path})`;
      select.appendChild(opt);
    }
  }

  // Select saved folder if present
  const savedConfig = loadConfig();
  if (savedConfig.syncFolder) {
    select.value = savedConfig.syncFolder;
    if (!select.value) {
      // Saved folder not in list, add it
      const opt = document.createElement('option');
      opt.value = savedConfig.syncFolder;
      opt.textContent = savedConfig.syncFolder;
      select.appendChild(opt);
      select.value = savedConfig.syncFolder;
    }
  }
  selectedSyncFolder = select.value;

  // Auto-save first detected folder if config is empty
  if (!savedConfig.syncFolder && selectedSyncFolder) {
    savedConfig.syncFolder = selectedSyncFolder;
    saveConfig(savedConfig);
  }

  const detectedInfo = $('detectedInfo');
  if (detectedInfo && folders.length > 0) {
    detectedInfo.textContent = `✓ 检测到 ${folders.length} 个同步盘目录`;
  }
}

function updateLibrarySyncUI(): void {
  const config = loadConfig();
  const libraryName = $('currentLibraryName');
  const badge = $('librarySyncBadge');
  const btn = $('toggleSyncBtn');

  let currentLibName = '当前库';
  try {
    currentLibName = eagle.library.name || currentLibName;
  } catch { /* ignore */ }

  if (libraryName) libraryName.textContent = currentLibName;

  const libraryPath = (() => { try { return eagle.library.path; } catch { return ''; } })();
  syncEnabled = config.enabledLibraries.includes(libraryPath);

  if (badge) {
    badge.dataset['enabled'] = String(syncEnabled);
    badge.textContent = syncEnabled ? '已启用' : '未启用';
  }
  if (btn) {
    btn.textContent = syncEnabled ? '停止同步' : '启用同步';
    if (syncEnabled) {
      btn.classList.add('enabled');
    } else {
      btn.classList.remove('enabled');
    }
  }
}

function loadSettingsUI(): void {
  const config = loadConfig();
  const deviceNameInput = $('deviceNameInput') as HTMLInputElement | null;
  const syncModeSelect = $('syncModeSelect') as HTMLSelectElement | null;
  const intervalInput = $('intervalInput') as HTMLInputElement | null;
  const lazyPullCheck = $('lazyPullCheck') as HTMLInputElement | null;
  const intervalGroup = $('intervalGroup');

  if (deviceNameInput) deviceNameInput.value = config.deviceName;
  if (syncModeSelect) syncModeSelect.value = config.syncMode;
  if (intervalInput) intervalInput.value = String(config.syncIntervalSec);
  if (lazyPullCheck) lazyPullCheck.checked = config.lazyPull;
  if (intervalGroup) {
    intervalGroup.classList.toggle('visible', config.syncMode === 'interval');
  }
}

function bindEvents(): void {
  // Toggle library sync
  const toggleSyncBtn = $('toggleSyncBtn');
  if (toggleSyncBtn) {
    toggleSyncBtn.addEventListener('click', () => {
      const config = loadConfig();
      const libraryPath = (() => { try { return eagle.library.path; } catch { return ''; } })();
      if (!libraryPath) return;

      if (!config.syncFolder && !selectedSyncFolder) {
        alert('请先选择同步目录');
        return;
      }

      // Ensure syncFolder is saved
      if (!config.syncFolder && selectedSyncFolder) {
        config.syncFolder = selectedSyncFolder;
      }

      if (syncEnabled) {
        config.enabledLibraries = config.enabledLibraries.filter((p) => p !== libraryPath);
        appendLog('info', '已停止当前库同步');
        stopSyncRunner();
      } else {
        if (!config.enabledLibraries.includes(libraryPath)) {
          config.enabledLibraries = [...config.enabledLibraries, libraryPath];
        }
        appendLog('info', `已启用库同步: ${(() => { try { return eagle.library.name; } catch { return libraryPath; } })()}`);
        startSyncRunner(config);
      }
      saveConfig(config);
      updateLibrarySyncUI();
    });
  }

  // Sync folder change
  const syncFolderSelect = $('syncFolderSelect') as HTMLSelectElement | null;
  if (syncFolderSelect) {
    syncFolderSelect.addEventListener('change', () => {
      selectedSyncFolder = syncFolderSelect.value;
      const config = loadConfig();
      config.syncFolder = selectedSyncFolder;
      saveConfig(config);
      appendLog('info', `同步目录已设置: ${selectedSyncFolder}`);
    });
  }

  // Browse folder button — manual directory selection
  const browseFolderBtn = $('browseFolderBtn');
  if (browseFolderBtn && syncFolderSelect) {
    browseFolderBtn.addEventListener('click', async () => {
      try {
        const eagleRef = (globalThis as any).eagle;
        // Eagle plugin API: show native folder picker dialog
        const result = await eagleRef.dialog.showOpenDialog({
          properties: ['openDirectory'],
          title: '选择同步目录',
          message: '请选择云盘同步空间的本地目录（如百度网盘同步空间）',
        });

        if (result && result.filePaths && result.filePaths.length > 0) {
          const chosenPath = result.filePaths[0];

          // Add to dropdown if not already there
          let found = false;
          for (let i = 0; i < syncFolderSelect.options.length; i++) {
            if (syncFolderSelect.options[i]!.value === chosenPath) {
              found = true;
              break;
            }
          }
          if (!found) {
            const opt = document.createElement('option');
            opt.value = chosenPath;
            opt.textContent = chosenPath;
            syncFolderSelect.appendChild(opt);
          }

          syncFolderSelect.value = chosenPath;
          selectedSyncFolder = chosenPath;

          const config = loadConfig();
          config.syncFolder = chosenPath;
          saveConfig(config);
          appendLog('info', `手动设置同步目录: ${chosenPath}`);
        }
      } catch (err: any) {
        appendLog('error', `选择目录失败: ${err.message || err}`);
      }
    });
  }

  // Sync mode change
  const syncModeSelect = $('syncModeSelect') as HTMLSelectElement | null;
  const intervalGroup = $('intervalGroup');
  if (syncModeSelect) {
    syncModeSelect.addEventListener('change', () => {
      const config = loadConfig();
      config.syncMode = syncModeSelect.value;
      saveConfig(config);
      if (intervalGroup) {
        intervalGroup.classList.toggle('visible', syncModeSelect.value === 'interval');
      }
    });
  }

  // Device name
  const deviceNameInput = $('deviceNameInput') as HTMLInputElement | null;
  if (deviceNameInput) {
    deviceNameInput.addEventListener('change', () => {
      const config = loadConfig();
      config.deviceName = deviceNameInput.value.trim() || os.hostname();
      saveConfig(config);
    });
  }

  // Interval
  const intervalInput = $('intervalInput') as HTMLInputElement | null;
  if (intervalInput) {
    intervalInput.addEventListener('change', () => {
      const val = parseInt(intervalInput.value, 10);
      if (val >= 10 && val <= 3600) {
        const config = loadConfig();
        config.syncIntervalSec = val;
        saveConfig(config);
      }
    });
  }

  // Lazy pull
  const lazyPullCheck = $('lazyPullCheck') as HTMLInputElement | null;
  if (lazyPullCheck) {
    lazyPullCheck.addEventListener('change', () => {
      const config = loadConfig();
      config.lazyPull = lazyPullCheck.checked;
      saveConfig(config);
    });
  }

  // Sync Now
  const syncNowBtn = $('syncNowBtn');
  if (syncNowBtn) {
    syncNowBtn.addEventListener('click', async () => {
      if (!syncEnabled || !syncRunner) {
        alert('请先启用当前库的同步');
        return;
      }
      syncNowBtn.textContent = '同步中...';
      (syncNowBtn as HTMLButtonElement).disabled = true;
      appendLog('info', '手动触发同步...');
      try {
        await syncRunner.triggerSync();
        appendLog('info', '手动同步完成');
      } catch (err: any) {
        appendLog('error', `手动同步失败: ${err.message || err}`);
      }
      syncNowBtn.textContent = '立即同步';
      (syncNowBtn as HTMLButtonElement).disabled = false;
      updateStatusUI();
    });
  }
}

// --- Sync Runner Control ---

function deriveLibraryId(): string {
  try {
    const libPath = eagle.library.path;
    const name = path.basename(libPath).replace(/\.library$/, '');
    const hash = require('crypto').createHash('sha256').update(libPath).digest('hex').slice(0, 8);
    return `${name}-${hash}`;
  } catch {
    return 'unknown-library';
  }
}

function startSyncRunner(config: Config): void {
  if (syncRunner) {
    syncRunner.stop();
    syncRunner = null;
  }

  if (!config.syncFolder) {
    appendLog('warn', '无法启动同步: 未设置同步目录');
    return;
  }

  const libraryId = deriveLibraryId();
  const intervalMs = config.syncMode === 'realtime' ? 5000
    : config.syncMode === 'interval' ? config.syncIntervalSec * 1000
    : 0; // manual = no auto sync

  syncRunner = new SyncRunner(config.syncFolder, libraryId, config.deviceName, appendLog);

  if (config.syncMode === 'manual') {
    // Just initialize, don't start auto loop
    syncRunner.start(999999999).catch((err: any) => {
      appendLog('error', `启动失败: ${err.message || err}`);
    });
  } else {
    syncRunner.start(intervalMs).catch((err: any) => {
      appendLog('error', `启动失败: ${err.message || err}`);
    });
  }
}

function stopSyncRunner(): void {
  if (syncRunner) {
    syncRunner.stop();
    syncRunner = null;
  }
}

function updateStatusUI(): void {
  const lastSyncTime = $('lastSyncTime');
  const syncedCount = $('syncedCount');
  const currentPhase = $('currentPhase');
  const headerStatusText = $('headerStatusText');
  const statusDot = $('statusDot');

  if (syncRunner) {
    const status = syncRunner.getStatus();
    if (lastSyncTime) lastSyncTime.textContent = status.lastSync > 0 ? new Date(status.lastSync).toLocaleTimeString('zh-CN') : '--';
    if (syncedCount) syncedCount.textContent = String(status.synced);
    if (currentPhase) currentPhase.textContent = status.running ? '运行中' : '空闲';
    if (headerStatusText) headerStatusText.textContent = status.running ? '同步中' : '已同步';
    if (statusDot) statusDot.dataset['status'] = status.running ? 'syncing' : 'synced';
  } else {
    if (lastSyncTime) lastSyncTime.textContent = '--';
    if (syncedCount) syncedCount.textContent = '0';
    if (currentPhase) currentPhase.textContent = '空闲';
    if (headerStatusText) headerStatusText.textContent = '等待配置';
    if (statusDot) statusDot.dataset['status'] = 'idle';
  }
}

// --- Logging System ---

const MAX_LOG_ENTRIES = 500;
const LOG_POLL_MS = 1500;

interface LogEntry {
  time: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

function getLogPath(): string {
  return path.join(pluginPath, 'sync.log');
}

function appendLog(level: LogEntry['level'], msg: string): void {
  const entry: LogEntry = {
    time: new Date().toISOString(),
    level,
    msg,
  };

  let entries: LogEntry[] = [];
  try {
    const raw = fs.readFileSync(getLogPath(), 'utf-8');
    entries = JSON.parse(raw);
  } catch { /* first time or corrupt */ }

  entries.push(entry);

  // Rotate: keep only last MAX_LOG_ENTRIES
  if (entries.length > MAX_LOG_ENTRIES) {
    entries = entries.slice(entries.length - MAX_LOG_ENTRIES);
  }

  fs.writeFileSync(getLogPath(), JSON.stringify(entries), 'utf-8');
}

function readLogs(): LogEntry[] {
  try {
    const raw = fs.readFileSync(getLogPath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function renderLogs(): void {
  const container = $('logContainer');
  const emptyMsg = $('logEmpty');
  if (!container) return;

  const entries = readLogs();

  if (entries.length === 0) {
    if (emptyMsg) emptyMsg.style.display = '';
    return;
  }

  if (emptyMsg) emptyMsg.style.display = 'none';

  // Rebuild log display
  const fragment = document.createDocumentFragment();
  for (const entry of entries.slice(-200)) {
    const el = document.createElement('div');
    el.className = 'log-entry';
    el.dataset['level'] = entry.level;

    const time = document.createElement('span');
    time.className = 'log-timestamp';
    time.textContent = entry.time.slice(11, 19);

    const msg = document.createElement('span');
    msg.className = 'log-message';
    msg.textContent = entry.msg;

    el.appendChild(time);
    el.appendChild(msg);
    fragment.appendChild(el);
  }

  // Replace all children except logEmpty
  const existingEntries = container.querySelectorAll('.log-entry');
  existingEntries.forEach((e) => e.remove());
  container.appendChild(fragment);

  // Auto-scroll
  container.scrollTop = container.scrollHeight;
}

function startLogPolling(): void {
  renderLogs();
  setInterval(renderLogs, LOG_POLL_MS);
}

// --- Init ---

function init(): void {
  initTabs();
  populateSyncFolders();
  updateLibrarySyncUI();
  loadSettingsUI();
  bindEvents();
  startLogPolling();

  // Log plugin init
  appendLog('info', '插件已启动');
  appendLog('info', `当前库: ${(() => { try { return eagle.library.name; } catch { return '未知'; } })()}`);

  const config = loadConfig();
  if (config.syncFolder) {
    appendLog('info', `同步目录: ${config.syncFolder}`);
  } else {
    appendLog('warn', '未配置同步目录，请在设置中选择');
  }

  // Auto-start sync if enabled
  if (syncEnabled && config.syncFolder) {
    appendLog('info', '自动启动同步引擎...');
    startSyncRunner(config);
  }

  // Periodic status update
  updateStatusUI();
  setInterval(updateStatusUI, 2000);
}

// Eagle provides plugin.path via onPluginCreate
eagle.onPluginCreate((plugin) => {
  pluginPath = plugin.path;
  // Delay init slightly — eagle.library may not be ready immediately
  setTimeout(init, 300);
});
