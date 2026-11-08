import { describe, expect, it } from 'vitest';
import {
  LocalPrivateStorage,
  StorageValidationError,
  detectFileType,
  sanitizeFileName,
  validateUpload,
} from '@/lib/storage/local';

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100, 0x20)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(50)]);

describe('content detection', () => {
  it('detects allowed types from bytes', () => {
    expect(detectFileType(PDF, 'cv.pdf')).toEqual({
      mediaType: 'application/pdf',
      extension: 'pdf',
    });
    expect(detectFileType(PNG, 'image.png')?.mediaType).toBe('image/png');
    expect(detectFileType(JPEG, 'photo.jpg')?.mediaType).toBe('image/jpeg');
    expect(detectFileType(DOCX, 'cv.docx')?.extension).toBe('docx');
    expect(detectFileType(Buffer.from('plain text'), 'notes.md')).toEqual({
      mediaType: 'text/plain',
      extension: 'md',
    });
  });

  it('rejects unknown or ambiguous content', () => {
    expect(detectFileType(Buffer.from([0x00, 0x01, 0x02]), 'blob.bin')).toBeNull();
    expect(detectFileType(DOCX, 'archive.zip')).toBeNull();
    expect(detectFileType(Buffer.alloc(0), 'empty.pdf')).toBeNull();
  });

  it('rejects a declared type that disagrees with bytes', () => {
    expect(() => validateUpload(PNG, 'application/pdf', 'cv.pdf')).toThrow(
      StorageValidationError,
    );
    expect(() => validateUpload(PDF, 'image/png', 'cv.png')).toThrow(
      StorageValidationError,
    );
  });

  it('rejects disallowed declared types and invalid content', () => {
    expect(() => validateUpload(PDF, 'application/x-msdownload', 'cv.exe')).toThrow(
      /not allowed/,
    );
    expect(() => validateUpload(Buffer.from([0x4d, 0x5a, 0x00]), 'application/octet-stream', 'x.exe')).toThrow(
      /allowed type/,
    );
  });
});

describe('file names', () => {
  it('strips paths and control characters', () => {
    expect(sanitizeFileName('C:\\Users\\owner\\cv.pdf')).toBe('cv.pdf');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('a\u0000b.pdf')).toBe('ab.pdf');
    expect(sanitizeFileName('')).toBe('file');
  });
});

describe('private local storage', () => {
  it('stores, reads and deletes objects through validated keys', async () => {
    const storage = new LocalPrivateStorage('./.data/test-storage');
    const stored = await storage.put(PDF, {
      mediaType: 'application/pdf',
      originalName: 'cv.pdf',
    });
    expect(stored.objectKey).toMatch(/^[a-z0-9_-]+\/[0-9a-f-]{36}$/);
    expect(stored.sha256).toHaveLength(64);
    expect(await storage.read(stored.objectKey)).toEqual(PDF);
    await storage.delete(stored.objectKey);
    await expect(storage.read(stored.objectKey)).rejects.toThrow(/ENOENT/);
  });

  it('rejects traversal attempts', () => {
    const storage = new LocalPrivateStorage('./.data/test-storage');
    expect(() => storage.pathFor('../escape')).toThrow(StorageValidationError);
    expect(() => storage.pathFor('ab/../../escape')).toThrow(StorageValidationError);
    expect(() => storage.pathFor('/etc/passwd')).toThrow(StorageValidationError);
  });

  it('enforces the maximum size', async () => {
    const storage = new LocalPrivateStorage('./.data/test-storage');
    await expect(
      storage.put(PDF, {
        mediaType: 'application/pdf',
        originalName: 'cv.pdf',
        maxBytes: 4,
      }),
    ).rejects.toThrow(/exceeds/);
  });

  it('rejects empty files', async () => {
    const storage = new LocalPrivateStorage('./.data/test-storage');
    await expect(
      storage.put(Buffer.alloc(0), {
        mediaType: 'application/pdf',
        originalName: 'cv.pdf',
      }),
    ).rejects.toThrow(/empty/);
  });
});
