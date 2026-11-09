import { z } from 'zod';
import { profileDto } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRoute } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import {
  getProfile,
  isValidTimeZone,
  updateProfile,
} from '@/lib/profile/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PreferencesSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 20_000, {
    message: 'preferences is too large',
  });

const UpdateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).nullable().optional(),
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine(isValidTimeZone, { message: 'timezone must be a valid IANA zone' })
      .optional(),
    preferences: PreferencesSchema.optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.displayName !== undefined ||
      value.timezone !== undefined ||
      value.preferences !== undefined,
    { message: 'At least one profile field is required' },
  );

export const GET = apiRoute(async (request) => {
  const session = await requireOwner(request);
  const profile = await getProfile(session.ownerId);
  return jsonData(request, profileDto(profile));
});

export const PATCH = apiRoute(async (request) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const body = await parseJson(request, UpdateProfileSchema);
  const profile = await updateProfile(session.ownerId, body, requestId(request));
  return jsonData(request, profileDto(profile));
});
