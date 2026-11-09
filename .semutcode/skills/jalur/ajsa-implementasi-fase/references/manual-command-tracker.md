# Pola perintah terminal manual (tracker)

Pola untuk aksi yang dicatat owner dan **tidak** menjalankan worker: catat kirim
manual, tandai hasil, atau terminal command lain pada application. Contoh
implementasi: `src/lib/applications/service.ts` dan test
`tests/integration/applications.test.ts`.

## Tabel yang dipakai

- `applications` — status pengiriman, tahap rekrutmen, `current_version`, `notes`
- `application_attempts` — satu baris terminal (`mode`, `state`,
  `confirmation_source`, `target_key`, `reported_submitted_at`,
  `document_version_ids`)
- `application_events` — timeline (`event_type`, `from_state`, `to_state`,
  `actor_type`, `actor_id`)
- `document_versions` — validasi ID versi dokumen milik owner

## Alur transaksi

1. Kunci application: `SELECT ... WHERE id = $1 AND owner_id = $2 FOR UPDATE`.
   Tidak ada baris → `apiErrors.notFound()`.
2. Cocokkan `expectedVersion` dengan `current_version`; beda →
   `apiErrors.versionConflict()`.
3. Validasi state asal. Untuk kirim manual hanya `draft`, `ready_for_review`,
   `not_submitted`; state lain → `new ApiError(409, 'APPLICATION_STATE_CONFLICT', ...)`.
4. Validasi `listingId` dengan join `job_listings` pada `owner_id` dan
   `job_id` application. Salah → `apiErrors.validation({ field: 'listingId' })`.
5. Validasi `documentVersionIds`: buang duplikat, hitung
   `document_versions WHERE owner_id = $1 AND id = ANY($2::uuid[])`; jumlah harus
   sama. Jika `documentVersionsKnown = false`, daftar harus kosong.
6. Kunci target: `target_key = 'job:' || job_id`, state yang memblokir
   (`reserved`, `running`, `submitting`, `submitted_confirmed`, `submit_unknown`)
   dengan `FOR UPDATE`.
   - `submit_unknown` → `409 SUBMIT_UNKNOWN_REQUIRES_RECONCILIATION`
   - state lain → `409 TARGET_ALREADY_RECORDED`
7. Insert attempt terminal, update application ke `submitted_confirmed` dan
   `current_version + 1`, insert event, lalu `recordAudit`, semuanya dalam
   transaksi yang sama.
8. Route memanggil `executeIdempotent` dengan payload yang sudah dinormalisasi
   (tanggal ISO, array versi, `expectedVersion`), dan mengembalikan
   `operationId = attempt.id`.

## Yang harus diuji

- Dua request dengan idempotency key berbeda → request kedua
  `APPLICATION_STATE_CONFLICT`.
- Attempt `submit_unknown` yang sudah ada → rekonsiliasi, bukan overwrite.
- `listingId` milik job lain → `VALIDATION_ERROR`.
- Versi dokumen milik owner lain / tidak ada → `VALIDATION_ERROR`.
- Setelah sukses: `tasks = 0` dan `quota_reservations = 0`.
- Tahap rekrutmen berubah tanpa mengubah `submission_status`, dan setiap
  perubahan menghasilkan event.
- Owner lain mendapat `NOT_FOUND` untuk list/detail/update/manual report.
