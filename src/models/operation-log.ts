// ============================================================
// OperationLog — append-only log with merge support
// ============================================================

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Operation } from '../core/types.js';

export interface OperationLogOptions {
  readonly filePath: string;
}

export class OperationLog {
  private operations: ReadonlyArray<Operation>;
  private readonly filePath: string;

  constructor(options: OperationLogOptions) {
    this.filePath = options.filePath;
    this.operations = [];
  }

  getAll(): ReadonlyArray<Operation> {
    return this.operations;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      this.operations = Array.isArray(parsed) ? (parsed as ReadonlyArray<Operation>) : [];
    } catch (error: unknown) {
      if (isFileNotFoundError(error)) {
        this.operations = [];
        return;
      }
      throw error;
    }
  }

  async save(): Promise<void> {
    const serialized = JSON.stringify(this.operations, null, 2);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, serialized, 'utf-8');
  }

  append(op: Operation): void {
    this.operations = [...this.operations, op];
  }

  getAfter(timestamp: number): ReadonlyArray<Operation> {
    return this.operations.filter((op) => op.timestamp > timestamp);
  }

  /**
   * Merge remote operations into the local log.
   * Deduplicates by operation id; sorts by timestamp.
   */
  merge(remoteOps: ReadonlyArray<Operation>): void {
    const existingIds = new Set(this.operations.map((op) => op.id));
    const newOps = remoteOps.filter((op) => !existingIds.has(op.id));

    const merged = [...this.operations, ...newOps];
    merged.sort((a, b) => a.timestamp - b.timestamp);

    this.operations = merged;
  }

  clear(): void {
    this.operations = [];
  }
}

// --- Internal helpers ---

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
