---
name: ajsa-implementasi-fase
description: Menambah satu fase/fitur ke repo AJSA (Next.js + PostgreSQL, modular monolith) dengan urutan migration → service → DTO → route → UI → test. Gunakan saat pengguna menulis "lanjutkan progress", "lanjutkan fase", "implementasikan fase 3", "kerjakan backlog berikutnya", atau "tambah endpoint dan UI untuk <domain>" di repo takumi-jobsearch-assistant.
metadata:
  created-by: semut-jalur
---

# Implementasi fase/fitur AJSA

Menambah satu potong kemampuan ke aplikasi AJSA dengan mengikuti konvensi yang
sudah ada: migration SQL, service ber-`owner_id`, DTO, route handler, UI, dan
test terhadap PostgreSQL asli. Tidak mencakup pemasangan environment Windows
(lihat skill `nextjs-postgres-windows-tanpa-docker`) atau deployment produksi.

## Kapan dipakai

- Pengguna meminta melanjutkan fase berikutnya dari `requirement/08-IPD-Implementation-Plan.md`.
- Pengguna menyebut nama domain baru, mis. "profil", "lowongan", "lamaran", "scoring".
- Pengguna meminta endpoint + UI sekaligus untuk repo ini.
- `docs/implementation-status.md` menunjukkan fase yang belum selesai.

## Langkah

1. **Tentukan scope dari dokumen, bukan tebakan.**
   Baca `docs/implementation-status.md`, fase terkait di
   `requirement/08-IPD-Implementation-Plan.md`, dan bagian UAT/AC di
   `requirement/01-PRD.md` + `requirement/11-Test-Plan-UAT.md`.
   `requirement/` bersifat read-only; asumsi dicatat di `docs/decisions.md`.

2. **Baca pola yang sudah ada sebelum menulis.** Minimal:
   `db/migrations/` (migration terakhir), `src/lib/<domain-sejenis>/service.ts`,
   `src/lib/api/dto.ts`, `src/app/api/v1/documents/route.ts`,
   `src/app/api/v1/documents/[id]/route.ts`, `src/components/dashboard.tsx`,
   `tests/integration/documents.test.ts`, dan `tests/helpers/db.ts`.
   Tiru nama fungsi, bentuk error, dan gaya query; jangan membuat lapisan baru.

3. **Tambah migration bernomor.** Buat `db/migrations/000N_<domain>.sql` dengan
   nomor berikutnya. Jangan pernah mengedit migration yang sudah diterapkan:
   `runMigrations` memeriksa checksum dan akan menolak. Periksa migration lama
   dulu: tabel domain sering sudah ada (mis. applications/attempts/events di
   `0004_applications.sql`), jadi tambah hanya kolom yang benar-benar kurang.
   Setiap tabel yang menyimpan data owner wajib punya `owner_id` + FK ke
   `users`; kolom mutable yang dipakai UI sebaiknya punya `version`.

4. **Buat pure logic terpisah.** Normalisasi/aturan identitas masuk ke
   `src/lib/<domain>/normalize.ts` agar bisa diuji tanpa database. Contoh yang
   terbukti: `normalizeText`, `canonicalizeUrl`, `manualExternalId`,
   `duplicateConfidence` di `src/lib/jobs/normalize.ts`.

5. **Buat service domain.** File `src/lib/<domain>/service.ts`:
   - semua query memakai `owner_id = $1` (atau join ke tabel yang punya owner);
   - mutasi multi-tabel memakai `withTransaction` dari `@/lib/db/pool`;
   - baris yang diubah dikunci `FOR UPDATE` di dalam transaksi;
   - perubahan memakai `version` + `expectedVersion` → `apiErrors.versionConflict()`;
   - resource orang lain → `apiErrors.notFound()` (jangan bocorkan keberadaan);
   - aksi penting dicatat dengan `recordAudit(client, { ... })`;
   - perintah async/manual memakai `executeIdempotent` di route, bukan di service.
   Untuk perintah terminal (mis. catat kirim manual): kunci parent `FOR UPDATE`,
   validasi state asal, cek target lock dan attempt `submit_unknown`, lalu tulis
   attempt + event + audit dalam satu transaksi. Pola lengkap ada di
   `references/manual-command-tracker.md`.
   Untuk query daftar + detail, buat helper terpisah (`listX`, `getX`,
   `getXListRow`) daripada memfilter hasil `listX` di memori.

6. **Tambahkan DTO di `src/lib/api/dto.ts`.** Ubah snake_case → camelCase, `Date`
   → `toISOString()`. Kolom PostgreSQL `numeric` kembali sebagai string, jadi
   konversi eksplisit (`Number(row.confidence)`). `bigserial` (mis. ID event)
   sudah diparse menjadi `number` oleh `types.setTypeParser(20, ...)` di
   `src/lib/db/pool.ts`; tipenya `number`, bukan string. Jangan pernah
   mengembalikan row mentah yang memuat `object_key`, hash, atau secret.

7. **Buat route handler di `src/app/api/v1/<domain>/`.**
   - `export const runtime = 'nodejs'` untuk route yang memakai `pg`;
   - bungkus dengan `apiRoute` (tanpa params) atau `apiRouteCtx<{ params: Promise<{ id: string }> }>`;
   - `const session = await requireOwner(request)`;
   - mutasi: `assertMutationAllowed(request, session)` (Origin + `x-csrf-token`);
   - validasi body dengan `parseJson(request, zodSchema)` dan `.strict()` untuk
     objek yang tidak boleh punya field liar;
   - ID path lewat `uuidParam(...)`;
   - respons `jsonData(request, dto)` dan error dilempar sebagai `apiErrors.*`;
   - perintah yang wajib idempoten (impor manual, approval, submit, privasi):
     `executeIdempotent({ ownerId, method, route, key: request.headers.get('idempotency-key') ?? '', payload, handler })`.
   PATCH resource tunggal diletakkan di `route.ts` dalam folder `[id]`, bukan di
   route koleksi.

8. **Sambungkan UI tanpa `<main>` kedua.**
   `src/app/page.tsx` adalah server component dan `Dashboard` adalah client
   component. Ambil data lewat service + mapper DTO, lalu render komponen client
   baru sebagai children: `<Dashboard ...><FiturBaru ... /></Dashboard>`.
   Untuk beberapa section sekaligus, bungkus fragment:
   `<Dashboard ...><><FiturA /><FiturB /></></Dashboard>`.
   Di komponen client (`'use client'`):
   - salin pola `callApi` + state `busy/message/error` dari `dashboard.tsx`;
   - kirim `x-csrf-token` dan `crypto.randomUUID()` sebagai `Idempotency-Key`;
   - `router.refresh()` untuk memperbarui props server, tetapi **refetch daftar
     lokal** setelah mutasi karena `useState(props.x)` tidak ikut berubah;
   - jangan taruh fungsi/service server di komponen client.

9. **Tulis test di dua lapis.**
   - Unit untuk pure logic: `tests/unit/<domain>.test.ts`.
   - Integrasi untuk SQL/transaksi: `tests/integration/<domain>.test.ts`, mulai
     dengan `await resetDatabase()` di `beforeEach`, lalu `createTestOwner()` dan
     `insertExtraUser()` dari `../helpers/db`. Wajib menguji: version conflict,
     isolasi owner (user lain `NOT_FOUND`), idempotensi/dedup, dan aturan bisnis
     yang disebut UAT.
   Jangan menguji route handler lewat HTTP bila service sudah menguji jalur yang
   sama; test service lebih cepat dan tetap memakai PostgreSQL asli.

10. **Verifikasi berurutan.**
    ```bash
    npm run typecheck
    npm run lint
    npx vitest run tests/unit/<domain>.test.ts tests/integration/<domain>.test.ts
    npm test
    ```
    `npm run build` di checkout exFAT akan gagal `EISDIR/readlink`; itu masalah
    filesystem, bukan kode. Verifikasi build di salinan NTFS memakai
    `scripts/build-on-ntfs.sh` dari skill `nextjs-postgres-windows-tanpa-docker`,
    atau catat bahwa build belum dijalankan. Catat jumlah file/test persis dari
    output `npm test`, bukan perkiraan.

11. **Perbarui dokumentasi.** Ubah `README.md` (fitur + tabel endpoint),
    `docs/implementation-status.md` (tabel fase, traceability AC/UAT, jumlah test,
    catatan build), dan `docs/decisions.md` bila ada asumsi baru. Jumlah test di
    dokumen harus sama dengan output `npm test`. Jangan menulis tanggal/nomor
    issue ke skill, tetapi tanggal verifikasi di status dokumen boleh.

## Pitfalls

- Jangan menambah kolom ke tabel lewat edit migration lama: checksum berubah dan
  `runMigrations` gagal; selalu buat file migration baru.
- Jangan memakai `z.record(z.unknown())` di Zod 4; bentuk yang benar
  `z.record(z.string(), z.unknown())`.
- Jangan mengandalkan `router.refresh()` untuk daftar yang disimpan di
  `useState`: props baru tidak menimpa state; panggil ulang endpoint daftar
  setelah impor/merge.
- Jangan membuat dua `<main>` saat menaruh komponen baru di halaman; gunakan
  `children` pada `Dashboard`.
- Jangan memfilter 100 baris di memori untuk mencari satu resource; tambahkan
  query `getXListRow(ownerId, id)` yang langsung memakai `WHERE id = $2`.
- Jangan lupa menambah kolom baru ke query export di
  `src/lib/privacy/export.ts`; kalau tidak, data baru hilang dari ZIP ekspor.
  Untuk tracker, tambahkan juga tabel anak (`application_attempts`) ke
  `applications.json`, bukan hanya kolom di tabel induk.
- Jangan memanggil helper/DTO yang belum ada (mis. `getXListRowDto`); baca dulu
  daftar export modul service/DTO, lalu pakai nama yang benar-benar ada.
- Jangan mengandalkan status application saja untuk mencegah kirim ganda: query
  juga `target_key` dan state `submit_unknown` di transaksi yang sama, karena
  attempt lama bisa ada tanpa status application yang konsisten.
- Jangan membuat task worker atau reservasi kuota untuk pencatatan manual; uji
  dengan hitungan `tasks = 0` dan `quota_reservations = 0`.
- Jangan biarkan nilai fakta yang diedit tetap `verified`; koreksi harus kembali
  `unverified` agar pemilik meninjau ulang.
- Jangan membuat duplikat otomatis dari kemiripan judul/perusahaan; hanya buat
  `duplicate_suggestions` dengan confidence dan keputusan manual.
- Saat merge dua job, tolak bila keduanya sudah punya application
  (`MERGE_CONFLICT`); pindahkan listing, jangan hapus histori.
- Jangan menganggap log "could not receive data from client" saat teardown test
  sebagai kegagalan; pool ditutup bersamaan dengan cluster.
- Jangan menyentuh `requirement/`; catat keputusan implementasi di
  `docs/decisions.md`.

## Verify

`npm run typecheck && npm run lint` keluar kode 0, test unit + integrasi baru
lulus di cluster PostgreSQL asli, dan `npm test` melaporkan seluruh suite lulus.
