import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Compute SHA-256 hash of a file using streaming to handle large files
 * without loading the entire content into memory.
 */
export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);

    stream.on('data', (chunk: Buffer) => {
      hash.update(chunk);
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });

    stream.on('error', (err: Error) => {
      reject(new Error(`Failed to hash file "${filePath}": ${err.message}`));
    });
  });
}

/**
 * Compute SHA-256 hash of an in-memory buffer.
 */
export function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
