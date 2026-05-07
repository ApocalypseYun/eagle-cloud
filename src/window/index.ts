// ============================================================
// Eagle Cloud Sync - Window Plugin
// Uses Node.js fs directly (Eagle plugins support Node 16)
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Eagle global type ---
declare const eagle: {
  library: { name: string; path: string };
  onPluginCreate: (cb: (plugin: { path: string }) => void) => void;
};

// --- State ---
let pluginPath = '';
let syncEnabled = false;
let selectedSyncFolder = '';

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
  const candidates = [
    { name: '百度网盘同步空间', path: path.join(home, 'BaiduNetdiskSync') },
    { name: '百度网盘/同步空间', path: path.join(home, '百度网盘', '同步空间') },
    { name: '坚果云', path: path.join(home, 'Nutstore Files') },
    { name: 'OneDrive', path: path.join(home, 'OneDrive') },
    { name: 'Dropbox', path: path.join(home, 'Dropbox') },
    { name: 'iCloud Drive', path: path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs') },
  ];

  return candidates.filter((c) => {
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
  const config = loadConfig();
  if (config.syncFolder) {
    select.value = config.syncFolder;
    if (!select.value) {
      // Saved folder not in list, add it
      const opt = document.createElement('option');
      opt.value = config.syncFolder;
      opt.textContent = config.syncFolder;
      select.appendChild(opt);
      select.value = config.syncFolder;
    }
  }
  selectedSyncFolder = select.value;

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

      if (syncEnabled) {
        config.enabledLibraries = config.enabledLibraries.filter((p) => p !== libraryPath);
      } else {
        if (!config.enabledLibraries.includes(libraryPath)) {
          config.enabledLibraries = [...config.enabledLibraries, libraryPath];
        }
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
    syncNowBtn.addEventListener('click', () => {
      if (!syncEnabled) {
        alert('请先启用当前库的同步');
        return;
      }
      syncNowBtn.textContent = '同步中...';
      (syncNowBtn as HTMLButtonElement).disabled = true;
      // TODO: actual sync trigger
      setTimeout(() => {
        syncNowBtn.textContent = '立即同步';
        (syncNowBtn as HTMLButtonElement).disabled = false;
      }, 2000);
    });
  }
}

// --- Init ---

function init(): void {
  initTabs();
  populateSyncFolders();
  updateLibrarySyncUI();
  loadSettingsUI();
  bindEvents();

  // Update header status
  const headerStatusText = $('headerStatusText');
  const statusDot = $('statusDot');
  if (headerStatusText) headerStatusText.textContent = syncEnabled ? '已同步' : '等待配置';
  if (statusDot) statusDot.dataset['status'] = syncEnabled ? 'synced' : 'idle';
}

// Eagle provides plugin.path via onPluginCreate
eagle.onPluginCreate((plugin) => {
  pluginPath = plugin.path;
  init();
});
