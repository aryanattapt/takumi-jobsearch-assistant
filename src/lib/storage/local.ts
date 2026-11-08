import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '@/lib/config';

export class StorageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageValidationError';
  }
}

const KEY_PATTERN = /^[a-z0-9_-]{1,32}\/[a-z0-9][a-z0-9._-]{0,127}$/;

export interface PutOptions {
  prefix?: string;
  mediaType: string;
  originalName: string;
  maxBytes?: number;
}

export interface StoredObject {
  objectKey: string;
  sha256: string;
  sizeBytes: number;
}

export interface PrivateStorage {
  put(buffer: Buffer, options: PutOptions): Promise<StoredObject>;
  read(objectKey: string): Promise<Buffer>;
  delete(objectKey: string): Promise<void>;
}

/**
 * Local private volume. Objects are named randomly, written 0600 under a 0700
 * directory, and never served as public URLs. S3-compatible storage can
 * implement the same interface later.
 */
export class LocalPrivateStorage implements PrivateStorage {
  private readonly root: string;

  constructor(root = getConfig().STORAGE_DIR) {
    this.root = path.resolve(root);
  }

  async put(buffer: Buffer, options: PutOptions): Promise<StoredObject> {
    if (buffer.length === 0) {
      throw new StorageValidationError('File is empty');
    }
    const max = options.maxBytes ?? getConfig().STORAGE_MAX_BYTES;
    if (buffer.length > max) {
      throw new StorageValidationError(`File exceeds the ${max} byte limit`);
    }
    const prefix = options.prefix ?? buffer.toString('hex', 0, 1).padEnd(2, '0').slice(0, 2);
    const objectKey = `${sanitizePrefix(prefix)}/${randomUUID()}`;
    const filePath = this.resolveKey(objectKey);
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, buffer, { mode: 0o600, flag: 'wx' });
    return {
      objectKey,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      sizeBytes: buffer.length,
    };
  }

  async read(objectKey: string): Promise<Buffer> {
    return readFile(this.resolveKey(objectKey));
  }

  async delete(objectKey: string): Promise<void> {
    const filePath = this.resolveKey(objectKey);
    try {
      await unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** Exposed for tests and maintenance scripts. */
  pathFor(objectKey: string): string {
    return this.resolveKey(objectKey);
  }

  private resolveKey(objectKey: string): string {
    if (!KEY_PATTERN.test(objectKey)) {
      throw new StorageValidationError('Invalid object key');
    }
    const resolved = path.resolve(this.root, objectKey);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    if (!resolved.startsWith(rootWithSep)) {
      throw new StorageValidationError('Object key escapes the storage root');
    }
    return resolved;
  }
}

function sanitizePrefix(prefix: string): string {
  if (!/^[a-z0-9_-]{1,32}$/.test(prefix)) {
    throw new StorageValidationError('Invalid storage prefix');
  }
  return prefix;
}

export function sanitizeFileName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? 'file';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned || 'file').slice(0, 200);
}

const TEXT_LIMIT = 2 * 1024 * 1024;

export interface DetectedFile {
  mediaType: string;
  extension: string;
}

/**
 * Content-first detection. Declared MIME/extension are advisory only and must
 * agree with bytes; we never execute or parse uploads with elevated privileges.
 */
export function detectFileType(buffer: Buffer, fileName: string): DetectedFile | null {
  if (buffer.length === 0) return null;
  const lower = fileName.toLowerCase();
  if (buffer.length >= 5 && buffer.toString('latin1', 0, 5) === '%PDF-') {
    return { mediaType: 'application/pdf', extension: 'pdf' };
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mediaType: 'image/png', extension: 'png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mediaType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  ) {
    if (lower.endsWith('.docx')) {
      return {
        mediaType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extension: 'docx',
      };
    }
    return null;
  }
  if (buffer.length <= TEXT_LIMIT && !buffer.includes(0)) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (/^[\s\S]*$/.test(text)) {
        return { mediaType: 'text/plain', extension: lower.endsWith('.md') ? 'md' : 'txt' };
      }
    } catch {
      return null;
    }
  }
  return null;
}

const ALLOWED_DECLARED = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'application/octet-stream',
]);

export function validateUpload(
  buffer: Buffer,
  declaredMediaType: string,
  fileName: string,
): { mediaType: string; originalName: string; extension: string } {
  const safeName = sanitizeFileName(fileName);
  const declared = (declaredMediaType || 'application/octet-stream')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (!ALLOWED_DECLARED.has(declared)) {
    throw new StorageValidationError('File type is not allowed');
  }
  const detected = detectFileType(buffer, safeName);
  if (!detected) {
    throw new StorageValidationError('File content does not match an allowed type');
  }
  const compatible =
    declared === 'application/octet-stream' ||
    declared === detected.mediaType ||
    (detected.mediaType === 'text/plain' && (declared === 'text/plain' || declared === 'text/markdown'));
  if (!compatible) {
    throw new StorageValidationError('Declared file type does not match the content');
  }
  return { mediaType: detected.mediaType, originalName: safeName, extension: detected.extension };
}

let storageSingleton: LocalPrivateStorage | null = null;

export function getStorage(): PrivateStorage {
  storageSingleton ??= new LocalPrivateStorage();
  return storageSingleton;
}

/** Test hook. */
export function resetStorageForTests(): void {
  storageSingleton = null;
}
