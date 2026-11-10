# Backend Schema Document — AI Job Search Assistant

**Versi:** 0.2 · **Status:** rancangan REST/JSON; belum ada endpoint terimplementasi  
**Terkait:** [TRD](02-TRD.md) · [Database](05-DBD-Database-Design.md) · [Business Spec](07-BSD-Business-Spec.md)

## 1. Konvensi kontrak

- Base path `/api/v1`, JSON UTF-8, ID UUID, waktu ISO 8601 UTC, dan timezone IANA. API memakai session cookie HttpOnly/Secure pada HTTPS. Route pengguna selain login memeriksa sesi dan owner resource. Endpoint health dibatasi pada jaringan internal. Provisioning owner dilakukan lewat CLI lokal.
- Mutasi cookie-auth memerlukan CSRF token dan validasi Origin; CORS spesifik daftar origin yang disetujui. Tidak ada secret lengkap pada respons API.
- Berkas diunggah multipart melalui endpoint privat dengan validasi konten; download memeriksa otorisasi. Body/filename tidak dieksekusi atau dicatat secara sensitif.
- Respons sukses: `{ "data": {...}, "meta": { "requestId": "..." } }`; list ditambah `meta.nextCursor`. Error: `{ "error": { "code": "...", "message": "...", "requestId": "...", "details": {} } }`; details tidak memuat rahasia/CV.
- `Idempotency-Key` wajib untuk perintah asinkron, impor manual, approval, pencatatan manual, submit, cancel, rekonsiliasi, dan privasi. Scope owner, method, dan path resource aktual yang dinormalisasi. Request sama mengembalikan referensi operasi. Request dengan payload berbeda menghasilkan `409`. Usulan retensi tujuh hari. Server mengecek ulang otorisasi dan ketersediaan artefak saat akses, termasuk setelah replay.
- Resource yang dapat diubah memakai `version`. Mutasi atas versi tertentu memakai `If-Match` atau `expectedVersion`. Konflik versi menghasilkan `409 VERSION_CONFLICT`. Payload snapshot dan otorisasi yang disetujui bersifat immutable. Revokasi dan konsumsi dicatat terpisah.
- `202 Accepted` berarti task diterima, bukan proses/submit sukses. Gunakan status task dan audit untuk hasil.

## 2. Model respons ringkas

| Model | Field minimum | Keterangan |
|---|---|---|
| `Profile` | `id`, `version`, `displayName`, `timezone`, `preferences` | Tidak menyertakan secret provider. |
| `ProfileFact` | `id`, `type`, `value`, `verificationStatus`, `sourceDocumentId`, `version` | `unverified`, `verified`, `retracted`; hanya fakta terverifikasi dipakai sebagai klaim final. |
| `SearchRun` | `id`, `status`, `sources[]`, `startedAt`, `finishedAt` | Status per source; partial success dimungkinkan. |
| `Job` | `id`, `title`, `company`, `location`, `listings[]`, `postingStatus` | Setiap listing memiliki source, URL, ID eksternal dan `retrievedAt`. |
| `Evaluation` | `jobId`, `score`, `dimensions`, `matches`, `gaps`, `unknowns`, `vetoes`, `sourceRefs` | Score boleh `null`; jangan sebut probabilitas. |
| `Application` | `id`, `jobId`, `submissionStatus`, `recruitmentStage`, `version` | Kedua status tidak saling menggantikan. |
| `ReviewSnapshot` | `id`, `applicationId`, `listingId`, `postingRevisionId`, `portalAccountId`, `target`, `formFingerprint`, `documentVersions`, `answers`, `consents`, `preSubmitTransfers`, `snapshotHash`, `validUntil` | Isi form akhir yang ditampilkan untuk review. Data sensitif hanya tampil bagi owner. |
| `Approval` | `id`, `applicationId`, `snapshotId`, `snapshotHash`, `approvedAt`, `expiresAt`, `revokedAt`, `consumedAt` | Konsumsi mengikat satu attempt. |
| `Attempt` | `id`, `applicationId`, `mode`, `state`, `version`, `confirmationSource`, `evidence`, `createdAt` | `confirmationSource` berupa `portal` atau `manual` untuk hasil terkonfirmasi. |
| `PrivacyRequest` | `id`, `kind`, `scope`, `status`, `expiresAt`, `backupExpiresAt`, `errorCode` | Status `queued/running/completed/failed`. Unduhan hanya tersedia selama artefak siap, aktif dan belum kedaluwarsa. |
| `Task` | `id`, `type`, `status`, `progress`, `errorCode` | Error sudah disanitasi. |

## 3. Endpoint usulan

| Area | Method dan path | Hasil/perlindungan |
|---|---|---|
| Setup | CLI lokal operator | Lock singleton dan buat owner dalam satu transaksi. Web mulai dari login. |
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/session` | Rotasi/revokasi sesi dan CSRF; login di-rate-limit. |
| Profil | `GET/PATCH /profile`, `GET/POST /profile/facts`, `PATCH /profile/facts/{id}` | Versi; verifikasi fakta oleh pemilik. |
| Dokumen | `POST /documents`, `GET /documents`, `GET /documents/{id}/download`, `DELETE /documents/{id}` | Upload dan unduh privat. Delete membuat request purge asinkron dan menarik akses dokumen. |
| Sumber | `GET /sources`, `PATCH /sources/{id}` | Kapabilitas source, status login dan kebijakan; tidak ada cookie pada output. |
| Portal login | `POST /portal-accounts`, `POST /portal-accounts/{id}/login-session`, `GET /portal-accounts/{id}` | Buat akun portal lokal dan buka sesi login manual melalui sarana remote yang terotorisasi. Password dimasukkan di portal. |
| Search | `POST /search-runs`, `GET /search-runs/{id}`, `GET /search-runs/{id}/results` | Async; idempotency; detail keberhasilan per source. |
| Jobs | `GET /jobs`, `GET /jobs/{id}`, `PATCH /jobs/{id}` | Filter, detail, bookmark/ignore, data sumber. |
| Impor lowongan | `POST /jobs/imports` | Simpan teks yang ditempel dengan provenance `manual` dan URL rujukan opsional. Request ini tidak melakukan fetch URL. |
| Duplikat | `GET /duplicate-suggestions`, `POST /duplicate-suggestions/{id}/resolve` | Review/merge hanya setelah pemeriksaan konflik application. |
| Penilaian | `POST /jobs/{id}/evaluations`, `GET /jobs/{id}/evaluations/{evaluationId}` | Async; profil dan posting versi tertentu; schema output divalidasi. |
| Riset | `POST /jobs/{id}/research`, `GET /jobs/{id}/research` | Async; klaim dan referensi, tanpa mengikuti instruksi posting. |
| Application | `POST /applications`, `GET /applications`, `GET /applications/{id}`, `PATCH /applications/{id}` | Buat draft unik dan edit materi/catatan. Transisi memakai endpoint khusus. |
| Lifecycle | `POST /applications/{id}/cancel`, `POST /applications/{id}/reopen` | Cancel memeriksa intent di bawah lock. Reopen membuka kembali draft yang dibatalkan atau memulai review baru setelah `not_submitted`. |
| Materi | `POST /applications/{id}/documents/generate`, `GET /applications/{id}/documents`, `PATCH /applications/{id}/answers` | Generate async; fakta belum diverifikasi ditandai; perubahan membatalkan approval. |
| Simulasi | `POST /applications/{id}/dry-runs` | Jalankan fixture/form lokal. Hasil hanya catatan simulasi. |
| Preflight | `POST /applications/{id}/preflights`, `GET /applications/{id}/review` | P1. Inspeksi form tanpa mengirim data kandidat, simpan snapshot dan tampilkan perubahan untuk review. |
| Approval | `POST /applications/{id}/approvals`, `POST /approvals/{approvalId}/revoke` | Approval mengikat snapshot valid. Revokasi sebelum intent menghentikan dispatch. |
| Kontrol submit | `GET/PATCH /submission-settings` | Owner mengatur toggle, timezone kuota, batas global dan per sumber. Aktivasi memerlukan limit dan adapter yang tervalidasi. Penonaktifan menahan reservasi dan intent baru. Perubahan memakai versi dan lock kontrol owner. |
| Submit | `POST /applications/{id}/attempts`, `GET /applications/{id}/attempts/{attemptId}` | Membutuhkan approval aktif, pemeriksaan kuota, dan idempotency key. |
| Rekonsiliasi | `POST /attempts/{id}/reconcile`, `GET/POST /attempts/{id}/evidence` | Owner mengajukan hasil dan bukti. Server memeriksa versi, status, dan kriteria bukti adapter. |
| Lamaran manual | `POST /applications/{id}/manual-submissions` | P0. Catat pengiriman eksternal yang dilaporkan owner. Periksa konflik dengan attempt aktif, unknown, atau pengiriman terkonfirmasi. |
| Tracker | `PATCH /applications/{id}/recruitment-stage`, `GET /applications/{id}/events` | Status rekrutmen diperbarui manual dengan sumber dan waktu. |
| Interview | `POST /applications/{id}/interview-packs`, `GET /applications/{id}/interview-packs` | Asinkron; tidak mengirim pesan eksternal. |
| AI | `GET/POST /ai-providers`, `PATCH /ai-providers/{id}`, `POST /ai-providers/{id}/test` | Secret write-only; endpoint custom divalidasi berdasarkan konfigurasi administrator. |
| Jadwal | `GET/POST /saved-searches`, `PATCH /saved-searches/{id}`, `GET/POST /schedules`, `PATCH /schedules/{id}`, `GET /schedules/{id}/occurrences` | Jadwal memakai saved search, zona IANA, dan aktivasi eksplisit. |
| Notifikasi | `GET/POST /notification-channels`, `POST /notification-channels/{id}/test` | Token write-only, kirim test hanya atas perintah pemilik. |
| Privasi | `POST /privacy/exports`, `POST /privacy/deletions`, `GET /privacy/requests/{id}`, `GET /privacy/requests/{id}/download` | Request terotorisasi dan idempoten. Unduh hanya untuk ekspor aktif. |
| Recovery | `GET /submission-recovery/holds`, `GET /submission-recovery/holds/{id}/attempts`, `POST /submission-recovery/holds/{id}/attempts/{attemptId}`, `POST /submission-recovery/holds/{id}/release` | Owner mencatat hasil per attempt dengan bukti manual. Hasil unknown mempertahankan status dan pengunci. Pelepasan hold memerlukan coverage lengkap, pemeriksaan proses lama/aktivitas eksternal/kuota, tidak ada attempt aktif yang terdampak, dan audit atomik; browser submission tetap nonaktif. |
| Operasi | `GET /tasks/{id}`, `POST /tasks/{id}/cancel`, `GET /events` | Cancel task generik mengikuti pembatasan per jenis task. Lamaran memakai lifecycle command. |
| Health | `GET /health/live`, `GET /health/ready` | Tidak mengungkap versi sensitif; akses readiness dibatasi pada deployment. |

## 4. Contoh pencarian dan respons

```http
POST /api/v1/search-runs
Idempotency-Key: run-20261108-001
X-CSRF-Token: <token>
Content-Type: application/json

{
  "queries": ["Backend Developer", "Java Developer"],
  "locations": ["Jakarta"],
  "sourceCodes": ["linkedin", "jobstreet"],
  "workModes": ["hybrid", "remote"]
}
```

Respons `202` mengembalikan `{ "data": { "runId": "<uuid>", "taskId": "<uuid>", "status": "queued" }, "meta": { "requestId": "<uuid>" } }`. Gunakan kode source yang aktif. Untuk impor manual, kirim `{ "title": "...", "company": "...", "description": "...", "referenceUrl": "https://example.com/jobs/123" }` ke `POST /jobs/imports`. Balasan `201` memuat job dan listing dengan sumber `manual`. URL opsional hanya disimpan jika lolos validasi.

## 5. Preview, approval dan submit

`POST /applications/{id}/preflights` menerima `listingId`, `portalAccountId`, dan `expectedVersion`. Setelah task sukses, `GET /applications/{id}/review` menampilkan `ReviewSnapshot` dan perubahan material. Jika adapter tidak bisa menampilkan formulir akhir tanpa mengirim data kandidat, task mengembalikan `MANUAL_SUBMISSION_REQUIRED` dan aplikasi menawarkan jalur manual.

```http
POST /api/v1/applications/<id>/approvals
Idempotency-Key: approval-001
X-CSRF-Token: <token>
Content-Type: application/json

{ "snapshotId": "<uuid>", "snapshotHash": "sha256:<hash-dari-preview>", "expectedVersion": 7 }
```

Server membuat approval ketika snapshot dan versi cocok, data wajib lengkap, dan source memenuhi kebijakan. Usulan awal masa berlaku approval adalah 30 menit, dibatasi waktu valid snapshot. Nilai final ada pada `DEC-05`.

```http
POST /api/v1/applications/<id>/attempts
Idempotency-Key: submit-001
X-CSRF-Token: <token>
Content-Type: application/json

{ "approvalId": "<uuid>", "expectedVersion": 8 }
```

`202` menghasilkan `attemptId` dan state `reserved`. Transaksi memeriksa application, identitas target, hold, approval dan kuota, lalu mengonsumsi approval untuk attempt tersebut. Sebelum transfer yang tercantum dan sebelum submit, worker memeriksa ulang formulir, tujuan, akun, versi dokumen, jawaban, consent dan approval. Transaksi intent juga memvalidasi kuota tanggal aktif. Setelah intent tercatat, hanya worker pemiliknya dapat memanggil dispatch sekali. Timeout atau crash setelah intent menghasilkan `submit_unknown` bila hasil belum terbukti.

## 6. Lamaran manual dan rekonsiliasi

```http
POST /api/v1/applications/<id>/manual-submissions
Idempotency-Key: manual-001
X-CSRF-Token: <token>
Content-Type: application/json

{ "listingId": "<uuid>", "submittedAt": "2026-11-08T06:00:00Z",
  "documentVersionsKnown": true, "documentVersionIds": ["<uuid>"], "expectedVersion": 3 }
```

`201` menyimpan `mode=manual`, `submissionStatus=submitted_confirmed` dan `confirmationSource=manual`. Tampilkan **Dilaporkan terkirim oleh pemilik**. Jika versi dokumen tidak tersedia, `documentVersionsKnown=false` dan list kosong. Waktu dan listing dicatat sesuai laporan. Command tidak membuat task browser atau mengonsumsi kuota. Jika attempt lama masih `submit_unknown`, kembalikan konflik dan arahkan ke rekonsiliasi.

```http
POST /api/v1/attempts/<id>/reconcile
Idempotency-Key: reconcile-001
X-CSRF-Token: <token>
Content-Type: application/json

{ "outcome": "confirmed_sent", "evidenceId": "<uuid-bukti-portal>",
  "reason": "Receipt cocok dengan akun dan requisition", "expectedVersion": 12 }
```

Untuk `confirmed_sent` dan `confirmed_not_sent`, `evidenceId` wajib merujuk bukti dari attempt yang sama. Jenis bukti dan identitas target/akun mengikuti BR-12–14. Sebelum menerima hasil negatif setelah intent, server harus mengetahui bahwa sesi lama berhenti atau aksesnya dicabut dan bukti negatif otoritatif memenuhi [Business Spec §7](07-BSD-Business-Spec.md#7-bukti-dan-rekonsiliasi). Riwayat kosong atau alasan teks saja menghasilkan `422 INSUFFICIENT_EVIDENCE`, dengan state tetap `submit_unknown`. Hasil negatif yang valid membuka `not_submitted`. Pemilik memulai review baru melalui `/reopen` dan membuat approval baru. Simpan keputusan, bukti dan audit atomik dengan pemeriksaan versi attempt dan state application.

## 7. Ekspor dan penghapusan data

| Perintah | Kontrak dan hasil |
|---|---|
| `POST /privacy/exports` | Menerima scope `workspace_data` dan membalas `202` dengan request ID. Paket ZIP memuat manifest versi, profil/fakta, preferensi, catatan lowongan dan lamaran, tahap, versi CV serta lampiran yang masih tersedia, jawaban yang disimpan, dan metadata konfigurasi nonrahasia. Manifest menunjukkan file tidak tersedia dan alasannya. |
| `GET /privacy/requests/{id}` | Status request, waktu siap atau gagal, waktu kedaluwarsa ekspor dan batas kedaluwarsa backup terdampak jika dapat ditentukan. |
| `GET /privacy/requests/{id}/download` | Stream privat melalui API dengan sesi owner aktif. Usulan TTL 24 jam sejak artefak selesai. Tolak setelah expiry, revokasi, perubahan generasi privasi, atau reset. |
| `DELETE /documents/{id}` | Menerima `If-Match` dan `Idempotency-Key`. Menutup baca/unduh segera, membatalkan draft/approval terdampak dan memulai purge blob, cache serta artefak turunan yang memuat isi. Jika attempt browser aktif memakai dokumen itu, balas `409 DOCUMENT_IN_USE` dan tampilkan proses yang perlu ditutup. |
| `POST /privacy/deletions` | Reset scope `workspace_data` setelah konfirmasi eksplisit di UI. Jeda tugas baru dan integrasi, cabut akses pada payload yang terdampak, lalu purge profil kandidat, dokumen, jawaban, konfigurasi integrasi dan histori workspace sesuai kebijakan. Akun login lokal tetap tersedia untuk setup ulang. Saat masih ada operasi eksternal aktif, tahan reset sampai pekerjaan aman dihentikan. |

Ekspor hanya memuat data pengguna dalam scope. Rahasia, cookie, token, profil browser, prompt mentah, dan backup tidak dimasukkan. Saat penghapusan diterima, tingkatkan generasi privasi owner, cabut semua ekspor lama, dan tahan publikasi hasil worker dari generasi lama. Tarik fakta turunan yang hanya didukung dokumen yang dihapus. Histori yang masih diperlukan menampilkan referensi versi berstatus terhapus dan metadata audit minimum. Reset menghentikan submit browser. Sebelum mengaktifkannya lagi, periksa histori portal yang sudah tidak tersedia di workspace. Status purge `completed` menandai verifikasi pembersihan penyimpanan aktif. Penanganan backup mengikuti [Operations §8](12-Deployment-Security-Operations.md#8-retensi-dan-penghapusan).

## 8. Matriks kesalahan

| HTTP | Code | Makna/tindakan |
|---|---|---|
| 400/422 | `INVALID_INPUT` / `VALIDATION_ERROR` | Input atau aturan bisnis tidak valid. |
| 401/403 | `UNAUTHENTICATED` / `FORBIDDEN` | Login atau izin owner/CSRF tidak valid. |
| 404 | `NOT_FOUND` | Resource tidak ada atau tidak boleh diungkapkan. |
| 409 | `VERSION_CONFLICT`, `APPROVAL_STALE`, `IDEMPOTENCY_CONFLICT` | Refresh dan review ulang; key berbeda tidak boleh mengubah hasil lama. |
| 409 | `SUBMISSION_UNKNOWN`, `ALREADY_SUBMITTED`, `ATTEMPT_IN_PROGRESS` | Rekonsiliasi/lihat status; jangan retry otomatis. |
| 409 | `TARGET_ALREADY_CLAIMED`, `SUBMISSION_RECOVERY_HOLD`, `DISPATCH_ALREADY_INTENDED` | Review identitas target, selesaikan hold, atau tunggu hasil attempt aktif sesuai state. |
| 409 | `DOCUMENT_IN_USE`, `PRIVACY_OPERATION_IN_PROGRESS` | Tutup attempt atau tunggu proses privasi yang sedang berlangsung. |
| 410 | `EXPORT_UNAVAILABLE` | Artefak dicabut atau kedaluwarsa. |
| 422 | `MISSING_VERIFIED_FACT`, `SOURCE_NOT_ENABLED`, `LOGIN_REQUIRED` | Lengkapi data atau lakukan intervensi. |
| 422 | `INSUFFICIENT_EVIDENCE`, `MANUAL_SUBMISSION_REQUIRED` | Lengkapi bukti atau teruskan secara manual bila preflight tidak dapat dilakukan. |
| 429 | `QUOTA_EXCEEDED`, `RATE_LIMITED` | Tunda sampai kebijakan mengizinkan; bukan jaminan aman dari portal. |
| 502/503 | `PROVIDER_UNAVAILABLE`, `SOURCE_UNAVAILABLE` | Simpan error aman dan tawarkan fallback yang telah disetujui. |

## 9. Otorisasi dan validasi minimum

Semua operasi kandidat dibatasi ke owner. Worker memakai identitas internal dengan izin tipe task dan resource, bukan cookie pengguna secara umum. Perubahan state harus divalidasi server-side; frontend tidak dapat mengirim `submitted_confirmed` melalui PATCH umum. Tindakan koneksi eksternal, pengiriman, dan notifikasi hanya menerima endpoint yang disetujui; URL lowongan tidak diperbolehkan mengakses alamat internal. Event stream memakai sesi terotorisasi dan tidak membocorkan detail sensitif.
