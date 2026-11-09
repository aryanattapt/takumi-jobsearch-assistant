import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/pool';
import { uploadDocument } from '@/lib/documents/service';
import {
  createFact,
  getFact,
  getProfile,
  listFacts,
  updateFact,
  updateProfile,
} from '@/lib/profile/service';
import { createTestOwner, insertExtraUser, resetDatabase } from '../helpers/db';

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('profile fixture')]);

describe('candidate profile and facts', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('creates a profile lazily and rejects stale version updates', async () => {
    const owner = await createTestOwner();
    const profile = await getProfile(owner.ownerId);
    expect(profile.version).toBe(1);
    expect(profile.timezone).toBe('Asia/Jakarta');

    const updated = await updateProfile(
      owner.ownerId,
      {
        displayName: 'Budi',
        timezone: 'Asia/Makassar',
        preferences: { roles: ['Backend Engineer'], workModes: ['remote'] },
        expectedVersion: 1,
      },
      undefined,
    );
    expect(updated.version).toBe(2);
    expect(updated.display_name).toBe('Budi');
    expect(updated.timezone).toBe('Asia/Makassar');

    await expect(
      updateProfile(owner.ownerId, { displayName: 'Stale', expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('versions fact corrections, keeps unverified after edit, and supports retraction', async () => {
    const owner = await createTestOwner();
    const created = await createFact(owner.ownerId, {
      type: 'work_experience',
      value: { company: 'Acme', startYear: 2020, endYear: 2023 },
    });
    expect(created.verification_status).toBe('unverified');
    expect(created.version_no).toBe(1);

    const corrected = await updateFact(owner.ownerId, created.id, {
      value: { company: 'Acme', startYear: 2019, endYear: 2023 },
      expectedVersion: 1,
    });
    expect(corrected.version_no).toBe(2);
    expect(corrected.verification_status).toBe('unverified');

    await expect(
      updateFact(owner.ownerId, created.id, {
        value: { company: 'Acme', startYear: 2018 },
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const verified = await updateFact(owner.ownerId, created.id, {
      verificationStatus: 'verified',
      expectedVersion: 2,
    });
    expect(verified.verification_status).toBe('verified');
    expect(verified.verified_at).not.toBeNull();

    const retracted = await updateFact(owner.ownerId, created.id, {
      verificationStatus: 'retracted',
      expectedVersion: 2,
    });
    expect(retracted.verification_status).toBe('retracted');

    const versions = await getPool().query<{ count: number }>(
      'SELECT count(*)::int AS count FROM profile_fact_versions WHERE fact_id = $1',
      [created.id],
    );
    expect(versions.rows[0]?.count).toBe(2);
  });

  it('links facts to an owner document and rejects another owner document', async () => {
    const owner = await createTestOwner();
    const otherId = await insertExtraUser('other@example.com');
    const document = await uploadDocument(owner.ownerId, {
      buffer: PDF,
      mediaType: 'application/pdf',
      fileName: 'cv.pdf',
      kind: 'cv',
    });

    const fact = await createFact(owner.ownerId, {
      type: 'skill',
      value: { name: 'TypeScript', years: 5 },
      sourceDocumentId: document.id,
    });
    expect(fact.source_document_id).toBe(document.id);

    await expect(
      createFact(otherId, {
        type: 'skill',
        value: 'Rust',
        sourceDocumentId: document.id,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('does not expose another owner facts', async () => {
    const owner = await createTestOwner();
    const otherId = await insertExtraUser('other@example.com');
    const fact = await createFact(owner.ownerId, {
      type: 'skill',
      value: 'TypeScript',
    });

    expect(await listFacts(otherId)).toHaveLength(0);
    await expect(getFact(otherId, fact.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      updateFact(otherId, fact.id, { verificationStatus: 'verified' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
