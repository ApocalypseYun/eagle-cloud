// ============================================================
// Core shared types for Eagle Cloud Sync
// ============================================================

// --- Storage Provider types ---

export interface FileEntry {
  readonly key: string;
  readonly size: number;
  readonly lastModified: number;
  readonly etag?: string;
}

export interface FileMeta {
  readonly size: number;
  readonly lastModified: number;
  readonly etag?: string;
  readonly contentType?: string;
}

export interface PartInfo {
  readonly partNumber: number;
  readonly etag: string;
}

export interface StorageProvider {
  readonly name: string;

  // Basic operations
  list(prefix: string): Promise<ReadonlyArray<FileEntry>>;
  get(key: string): Promise<Buffer>;
  put(key: string, data: Buffer, meta?: Partial<FileMeta>): Promise<void>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<FileMeta | null>;
  exists(key: string): Promise<boolean>;

  // Multipart upload (for large files)
  initMultipartUpload(key: string): Promise<string>;
  uploadPart(uploadId: string, partNumber: number, data: Buffer): Promise<string>;
  completeMultipartUpload(uploadId: string, parts: ReadonlyArray<PartInfo>): Promise<void>;
  abortMultipartUpload(uploadId: string): Promise<void>;

  // Auth lifecycle
  isAuthenticated(): boolean;
  authenticate(): Promise<void>;
  refreshAuth(): Promise<void>;
}

// --- Sync State types ---

export type SyncStatus = 'synced' | 'local_modified' | 'remote_modified' | 'conflict';
export type FileStatus = 'synced' | 'remote_only' | 'downloading';

export interface ItemSyncState {
  readonly itemId: string;
  readonly localModifiedAt: number;
  readonly remoteModifiedAt: number;
  readonly metadataHash: string;
  readonly fileHash: string;
  readonly thumbnailHash: string;
  readonly syncStatus: SyncStatus;
  readonly fileStatus: FileStatus;
}

export interface SyncState {
  readonly deviceId: string;
  readonly lastSyncTimestamp: number;
  readonly itemStates: Readonly<Record<string, ItemSyncState>>;
}

// --- Operation Log types (CRDT-like) ---

export interface ItemMetadata {
  readonly id: string;
  readonly name: string;
  readonly tags: ReadonlyArray<string>;
  readonly folders: ReadonlyArray<string>;
  readonly annotation: string;
  readonly star: number;
  readonly modificationTime: number;
  readonly ext: string;
  readonly url?: string;
  readonly width?: number;
  readonly height?: number;
}

export type OpType =
  | { readonly kind: 'item_add'; readonly itemId: string; readonly metadata: ItemMetadata }
  | { readonly kind: 'item_delete'; readonly itemId: string }
  | { readonly kind: 'metadata_update'; readonly itemId: string; readonly field: string; readonly value: string | number | boolean }
  | { readonly kind: 'tags_add'; readonly itemId: string; readonly tags: ReadonlyArray<string> }
  | { readonly kind: 'tags_remove'; readonly itemId: string; readonly tags: ReadonlyArray<string> }
  | { readonly kind: 'folders_add'; readonly itemId: string; readonly folderIds: ReadonlyArray<string> }
  | { readonly kind: 'folders_remove'; readonly itemId: string; readonly folderIds: ReadonlyArray<string> }
  | { readonly kind: 'file_update'; readonly itemId: string; readonly fileHash: string };

export interface Operation {
  readonly id: string;
  readonly deviceId: string;
  readonly timestamp: number;
  readonly op: OpType;
}

// --- Queue Types ---

export type TaskPriority = 'metadata' | 'thumbnail' | 'source';

export interface QueueTask {
  readonly id: string;
  readonly itemId: string;
  readonly priority: TaskPriority;
  readonly type: 'upload' | 'download';
  readonly key: string;
  readonly data?: Buffer;
  readonly retryCount: number;
  readonly createdAt: number;
}

export interface QueueStatus {
  readonly pending: number;
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly paused: boolean;
}

// --- Conflict Resolution ---

export interface MergedResult {
  readonly resolvedMetadata: ItemMetadata;
  readonly conflictReport: ReadonlyArray<ConflictEntry>;
}

export type ConflictStrategy = 'add-wins-set' | 'lww';

export interface ConflictEntry {
  readonly itemId: string;
  readonly field: string;
  readonly strategy: ConflictStrategy;
  readonly localValue: string | number | boolean | ReadonlyArray<string>;
  readonly remoteValue: string | number | boolean | ReadonlyArray<string>;
  readonly resolvedValue: string | number | boolean | ReadonlyArray<string>;
}

// --- Sync Engine ---

export type SyncPhase = 'idle' | 'pushing' | 'pulling' | 'reconciling' | 'error';

export interface SyncEngineStatus {
  readonly phase: SyncPhase;
  readonly lastSyncAt: number;
  readonly pendingOperations: number;
  readonly errors: ReadonlyArray<string>;
}

// --- Plugin Configuration ---

export type SyncMode = 'realtime' | 'interval' | 'manual';
export type ProviderType = 'local-directory' | 'baidupan' | 'webdav' | 's3';

export interface ProviderAuthConfig {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenExpiresAt: number;
}

export interface PluginConfig {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly provider: ProviderType;
  readonly syncMode: SyncMode;
  readonly syncIntervalMs: number;
  readonly lazyPull: boolean;
  readonly maxConcurrentUploads: number;
  readonly maxConcurrentDownloads: number;
  readonly providers: Readonly<Partial<Record<ProviderType, ProviderAuthConfig>>>;
}
