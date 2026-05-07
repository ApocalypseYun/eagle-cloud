import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SyncState, ItemSyncState } from '../core/types.js';

// ─── Serialization Types ──────────────────────────────────────────────────────

interface SerializedSyncState {
  readonly deviceId: string;
  readonly lastSyncTimestamp: number;
  readonly itemStates: Record<string, ItemSyncState>;
}

// ─── Sync State Manager ───────────────────────────────────────────────────────

export class SyncStateManager {
  private state: SyncState;
  private readonly filePath: string;

  constructor(dataDir: string, deviceId: string) {
    this.filePath = join(dataDir, 'sync-state.json');
    this.state = {
      deviceId,
      lastSyncTimestamp: 0,
      itemStates: {},
    };
  }

  async load(): Promise<SyncState> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed: SerializedSyncState = JSON.parse(raw);
      this.state = {
        deviceId: parsed.deviceId,
        lastSyncTimestamp: parsed.lastSyncTimestamp,
        itemStates: { ...parsed.itemStates },
      };
    } catch (err: unknown) {
      // File doesn't exist yet — use default state
      if (isNodeError(err) && err.code === 'ENOENT') {
        return this.state;
      }
      throw err;
    }
    return this.state;
  }

  async save(): Promise<void> {
    const serialized: SerializedSyncState = {
      deviceId: this.state.deviceId,
      lastSyncTimestamp: this.state.lastSyncTimestamp,
      itemStates: this.state.itemStates,
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(serialized, null, 2), 'utf-8');
  }

  getItemState(id: string): ItemSyncState | undefined {
    return this.state.itemStates[id];
  }

  setItemState(id: string, itemState: ItemSyncState): void {
    this.state = {
      ...this.state,
      itemStates: {
        ...this.state.itemStates,
        [id]: itemState,
      },
    };
  }

  getModifiedItems(): readonly ItemSyncState[] {
    return Object.values(this.state.itemStates).filter(
      (item) => item.syncStatus !== 'synced',
    );
  }

  markSynced(id: string): void {
    const existing = this.state.itemStates[id];
    if (!existing) return;

    this.setItemState(id, {
      ...existing,
      syncStatus: 'synced',
      remoteModifiedAt: existing.localModifiedAt,
    });
  }

  getState(): SyncState {
    return this.state;
  }

  setLastSyncTimestamp(timestamp: number): void {
    this.state = {
      ...this.state,
      lastSyncTimestamp: timestamp,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface NodeError extends Error {
  readonly code?: string;
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && 'code' in err;
}
