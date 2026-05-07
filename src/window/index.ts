// ============================================================
// Eagle Cloud Sync - Window Plugin Logic
// ============================================================

// --- Types ---

interface SyncStatus {
  readonly phase: string;
  readonly lastSyncAt: number;
  readonly pendingOperations: number;
  readonly syncedItems: number;
  readonly errors: ReadonlyArray<string>;
}

// --- Constants ---

const PHASE_LABELS: Record<string, string> = {
  idle: '空闲',
  pushing: '推送中',
  pulling: '拉取中',
  reconciling: '合并中',
  error: '错误',
};

// --- Helpers ---

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function formatTime(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
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

// --- Tab Navigation ---

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

// --- Status Rendering ---

function renderStatus(status: SyncStatus): void {
  const statusDot = $('statusDot');
  const headerStatusText = $('headerStatusText');
  const lastSyncTime = $('lastSyncTime');
  const syncedCount = $('syncedCount');
  const currentPhase = $('currentPhase');
  const pendingOps = $('pendingOps');
  const syncNowBtn = $('syncNowBtn') as HTMLButtonElement | null;

  const dotStatus = status.phase === 'idle'
    ? (status.lastSyncAt > 0 ? 'synced' : 'idle')
    : status.phase === 'error'
      ? 'error'
      : 'syncing';

  if (statusDot) statusDot.dataset['status'] = dotStatus;

  const statusTexts: Record<string, string> = {
    synced: '已同步',
    idle: '等待配置',
    syncing: '同步中...',
    error: '同步错误',
  };
  if (headerStatusText) headerStatusText.textContent = statusTexts[dotStatus] ?? '未知';
  if (lastSyncTime) lastSyncTime.textContent = status.lastSyncAt > 0 ? formatTime(status.lastSyncAt) : '--';
  if (syncedCount) syncedCount.textContent = String(status.syncedItems);
  if (currentPhase) currentPhase.textContent = PHASE_LABELS[status.phase] ?? status.phase;
  if (pendingOps) pendingOps.textContent = String(status.pendingOperations);

  if (syncNowBtn) {
    const isBusy = status.phase !== 'idle' && status.phase !== 'error';
    syncNowBtn.disabled = isBusy;
    syncNowBtn.textContent = isBusy ? '同步中...' : '立即同步';
  }
}

// --- Event Handlers ---

function bindEvents(): void {
  const syncNowBtn = $('syncNowBtn');
  if (syncNowBtn) {
    syncNowBtn.addEventListener('click', () => {
      syncNowBtn.textContent = '同步中...';
      (syncNowBtn as HTMLButtonElement).disabled = true;
      // Will trigger sync via background service when wired up
      console.log('[eagle-cloud] Manual sync triggered');
    });
  }

  const syncModeSelect = $('syncModeSelect') as HTMLSelectElement | null;
  const intervalGroup = $('intervalGroup');
  if (syncModeSelect && intervalGroup) {
    syncModeSelect.addEventListener('change', () => {
      if (syncModeSelect.value === 'interval') {
        intervalGroup.classList.add('visible');
      } else {
        intervalGroup.classList.remove('visible');
      }
    });
  }

  const providerSelect = $('providerSelect') as HTMLSelectElement | null;
  const authGroup = $('authGroup');
  const syncFolderGroup = $('syncFolderGroup');
  if (providerSelect) {
    providerSelect.addEventListener('change', () => {
      const isApi = providerSelect.value === 'baidupan';
      if (authGroup) authGroup.style.display = isApi ? '' : 'none';
      if (syncFolderGroup) syncFolderGroup.style.display = isApi ? 'none' : '';
    });
  }
}

// --- Initialization ---

function init(): void {
  initTabs();
  bindEvents();

  // Show default idle status
  renderStatus({
    phase: 'idle',
    lastSyncAt: 0,
    pendingOperations: 0,
    syncedItems: 0,
    errors: [],
  });

  console.log('[eagle-cloud] Window plugin initialized');
}

// Boot when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
