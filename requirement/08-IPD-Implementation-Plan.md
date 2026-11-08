# Implementation Plan Document — AI Job Search Assistant

**Versi:** 0.2 · **Status:** backlog dan estimasi usulan; bukan komitmen jadwal  
**Terkait:** [PRD](01-PRD.md) · [Technical Requirements](02-TRD.md) · [UAT](11-Test-Plan-UAT.md)

## 1. Tujuan dan prasyarat

P0 membangun satu alur lengkap dari profil dan lowongan hingga catatan lamaran yang dikirim sendiri. P1 menambahkan pengiriman browser dengan preflight, approval, kuota, bukti, dan penahanan setelah restore. Discovery menetapkan repo tujuan, prioritas, provider dan sumber awal sebelum integrasi live. Lihat [Decision Register](14-Decision-Register.md).

Tidak ada layanan eksternal, akun portal, subscription, atau data kandidat asli yang diperlukan untuk unit/integration test lokal. Live UAT dilakukan terpisah menggunakan akun dan target yang secara eksplisit disetujui pemilik.

## 2. Fase dan definisi selesai

| Fase | Hasil | Dependensi | Gerbang/DoD |
|---|---|---|---|
| 0. Discovery & integrasi | Keputusan kebutuhan; inventaris source/lisensi; spike portal dan provider tanpa submit. | Repo/hosting, izin, prioritas. | Decision register diperbarui; source yang tidak diizinkan dinonaktifkan; kontrak fixture disepakati. |
| 1. Fondasi privat | Repo, CI, Compose, provisioning CLI, auth, DB/migration, penyimpanan privat, audit, queue/worker. | Fase 0. | Owner hanya bisa dibuat lokal satu kali. Tes race provisioning, isolasi owner, dan restore dasar lulus. |
| 2. Profil & pencarian P0 | Profil/fakta, impor CV dan teks lowongan, normalisasi, dedup dan UI. Integrasikan satu sumber jika lolos pemeriksaan. | Fondasi. | AC-02–04 lulus. Alur manual berfungsi saat adapter belum aktif. |
| 3. Evaluasi, dokumen & tracker P0 | Filter dan ranking, satu adapter AI diuji, draft CV/cover, review fakta, pencatatan kirim manual dan pengelolaan data. | Profil dan lowongan. | AC-05, AC-07, AC-08, AC-11, AC-13 dan AC-16 untuk P0. Uji satu alur lengkap dan siklus ekspor/penghapusan. |
| 4. Portal assist P1 | Login manual, dry-run lokal, preflight form, approval, dispatch dan rekonsiliasi pada satu portal. | Kemampuan adapter dan bukti, keamanan, kuota, serta UAT. | Lulus snapshot berubah, duplikat lintas listing, kuota lintas hari, race stop, hasil unknown dan restore yang kehilangan attempt. |
| 5. Perluasan P1 | Adapter portal lain yang memenuhi kebijakan, jadwal, dashboard lanjutan, notifikasi, Gemini/Anthropic. | Fase 4 untuk submit; jadwal dapat paralel setelah fondasi. | Uji tiap adapter dengan versi/fixture dan pembatasan; source down tidak merusak run lain. |
| 6. Ekstensi P2 | Gmail/Notion, learning plan, opsi autopilot bila disetujui. | Keputusan pemilik, izin source, hasil pilot dan threat review. | Tidak ada pengiriman pesan tanpa instruksi; autopilot default off dan diuji khusus. |

Skenario pilot P0 memakai satu profil fiktif dan satu lowongan. Owner mencari atau mengimpor lowongan, meninjau skor dan draf, mencatat kirim manual, lalu mengelola data lewat ekspor/purge. Jika konektor belum lolos pemeriksaan, jalur impor manual tetap tersedia.

## 3. Backlog rinci

| Epic | Task implementasi | Keluaran | Kebutuhan |
|---|---|---|---|
| E00 Repository | Tetapkan repo, lisensi/NOTICE, struktur modular monolith, CI lint/typecheck/test dan dependency scan. | Repo privat/terpilih dan pipeline tanpa secret. | Semua |
| E01 Security | Provisioning CLI dan lock singleton, hash password, sesi aman, CSRF, CORS allowlist, owner authorization, rate limit. | Auth, provisioning, dan tes akses. | PR-01, PR-16 |
| E02 Storage | Migration, penyimpanan privat, upload/download, audit, idempotency, ekspor dan purge dengan generasi privasi. | Schema terversi, backup dan kontrol data. | PR-02, PR-15, PR-16 |
| E03 Queue | Claim/lease/fencing, heartbeat, scheduler occurrence, outbox dan shutdown aman. | Worker dapat pulih; observability backlog. | PR-03, PR-14, PR-15 |
| E04 Profil | Edit profil/versioning; unggah CV; ekstraksi; sumber dan verifikasi fakta. | Wizard profil dan review fakta. | PR-02 |
| E05 Sumber | Kontrak adapter, fixture, search/detail, serta impor teks dan URL rujukan tanpa fetch otomatis. | Pencarian dan impor lowongan dengan provenance. | PR-03 |
| E06 Job model | Canonical URL/ID per sumber, dugaan duplikat, resolve/merge, filter dan bookmark. | Job store dan UI. | PR-04, PR-05 |
| E07 AI dasar | Provider abstraction, prompt/schema version, timeout/budget, validasi output dan audit metadata. | Minimal satu provider yang diuji; model tidak memiliki kuasa submit. | PR-05, PR-13 |
| E08 Dokumen/Q&A | CV/cover draft, provenance fakta, edit/version, PDF compiler terisolasi, bank jawaban. | Preview, ekspor, kebutuhan input. | PR-07, PR-08 |
| E09 Tracker | Pencatatan submit manual idempoten, waktu, versi materi, event timeline dan tahap rekrutmen terpisah. | Pipeline manual yang dapat dipakai sejak P0. | PR-11, PR-15 |
| E10 Browser | Profil privat, login manual, deteksi logout/OTP/CAPTCHA, fixture dan preflight form lengkap. | Kapabilitas satu adapter sesuai DEC-16. | PR-09, PR-10 |
| E11 Submit | Snapshot final, approval, pengunci application dan target, kuota tanggal intent, bukti dan rekonsiliasi. | Review-before-submit dengan status yang dapat dibuktikan. | PR-04, PR-10, PR-11 |
| E12 Integrasi | Riset bersumber, provider lain, scheduler, Telegram; kemudian Gmail/Notion bila disetujui. | Adaptor terpisah, koneksi dapat dinonaktifkan. | PR-06, PR-13, PR-14 |
| E13 Interview | Prep pack dengan versi CV/posting dan provenance; learning plan opsional. | Dokumen interview dan gap skill. | PR-12 |
| E14 Ops/UAT | Health, metrics, backup, restore, recovery hold, upgrade dan UAT. | Runbook serta bukti uji, termasuk celah histori setelah checkpoint. | PR-15, PR-16 |

## 4. Estimasi upaya awal

Kisaran berikut adalah **jam kerja efektif engineer**, bukan janji tanggal selesai. Asumsi satu developer full-stack, tidak ada pengalaman awal pada codebase, menggunakan source adapter yang legal/diizinkan, dan belum termasuk waktu tunggu keputusan/akun atau perubahan UI portal. Range dapat berubah besar setelah spike.

| Kelompok | Rentang jam usulan |
|---|---:|
| Discovery, desain, review lisensi, spike sumber | 16–32 |
| Fondasi auth, DB, queue, CI, penyimpanan dan audit | 35–70 |
| Profil, pencarian, dedup dan UI dasar | 40–80 |
| AI, ranking, dokumen, Q&A dan tracker | 50–100 |
| Ekspor, purge, revokasi artefak dan pengujian privasi | 16–32 |
| Satu adapter portal assist, preflight, approval, bukti, kuota dan concurrency | 65–130 |
| Jadwal, notifikasi, operasi, recovery hold dan UAT | 30–60 |

Estimasi kerja yang dijumlahkan adalah **252–504 jam**. Portal tambahan, provider tambahan, Gmail/Notion, autopilot, dan perubahan portal dapat menambah waktu. Hitung kalender dari jam tersedia per minggu dan waktu tunggu. Perbarui estimasi setelah spike sumber dan provider.

## 5. Strategi pengujian

- Unit: filter tiga nilai, perhitungan skor, transisi state, parsing URL, validasi snapshot/approval, redaksi log.
- Integrasi: PostgreSQL nyata untuk unique/locking, kuota, lease/fencing, scheduler occurrence, rollback, idempotency/outbox.
- Contract: fixture search/detail dan halaman portal yang disanitasi; stub model, email, notifikasi, dan remote network.
- E2E: UI sampai review/submit memakai portal test/dummy yang dapat mensimulasikan kegagalan sebelum dan sesudah dispatch.
- Live: hanya setelah fixture/e2e lulus dan pemilik menyetujui akun/target; setiap portal diuji sendiri. Lihat [UAT](11-Test-Plan-UAT.md).

## 6. Gerbang pilot dan rilis

1. Scope P0 dan sumber yang diperbolehkan ditetapkan; fitur eksperimen disabled secara default.
2. P0 lulus provisioning paralel, impor lowongan, pencatatan manual, akses dokumen, ekspor/purge dan restore dasar. Periksa redaksi log dan kemampuan pemulihan key.
3. Skenario UAT fase terkait lulus dengan bukti dan versi commit. Selesaikan temuan integritas atau privasi sebelum fitur terdampak diaktifkan.
4. Untuk P1, pilih adapter yang lulus DEC-16. Buktikan pencocokan snapshot, duplikat target, kuota, pembatalan sebelum intent, pemulihan setelah intent dan restore dengan histori yang hilang. Dokumentasikan bukti yang dapat didukung tiap portal.
5. Pemilik menyetujui uji live dan memeriksa setiap hasil; tidak ada KPI pilot yang mengharuskan jumlah lamaran tertentu.

## 7. Risiko dan mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Portal menolak otomasi atau mengubah UI | Sumber berhenti/akun dibatasi. | Periksa kebijakan, adapter dapat dimatikan, fixture/version dan fallback manual; tidak bypass challenge. |
| AI mengarang fakta | Lamaran salah. | Fakta verified, grounding, output terstruktur, review manusia. |
| Submit berhasil tapi respons hilang | Duplikasi jika retry. | Status unknown, blokir retry, rekonsiliasi berbukti. |
| Session/API key bocor | Akses tidak sah dan biaya. | Auth, secret terpisah/enkripsi, log redaction, rotasi dan backup aman. |
| Waktu part-time terbatas | Proyek terlalu besar. | Pilot P0 tanpa auto-submit, kerjakan epic berurutan, batasi sumber awal. |

## 8. Keterlacakan

| Requirement | Epic | UAT utama |
|---|---|---|
| PR-01 | E01 | UAT-01, UAT-02, UAT-25 |
| PR-02 | E04 | UAT-03, UAT-04, UAT-05 |
| PR-03 | E05 | UAT-06, UAT-38 |
| PR-04 | E06, E11 | UAT-07, UAT-08, UAT-09, UAT-49 |
| PR-05 | E06, E07 | UAT-10, UAT-11, UAT-12 |
| PR-06 | E12 | UAT-48 |
| PR-07 | E08 | UAT-13, UAT-14, UAT-51 |
| PR-08 | E08 | UAT-15, UAT-42 |
| PR-09 | E10 | UAT-17, UAT-42 |
| PR-10 | E10, E11 | UAT-16, UAT-18–UAT-22, UAT-28–UAT-30, UAT-42–UAT-47, UAT-49, UAT-50 |
| PR-11 | E09, E11 | UAT-23, UAT-32, UAT-37 |
| PR-12 | E13 | UAT-31 |
| PR-13 | E07, E12 | UAT-24, UAT-35, UAT-53 |
| PR-14 | E03, E12 | UAT-33, UAT-34, UAT-36, UAT-52 |
| PR-15 | E03, E09, E14 | UAT-06, UAT-23, UAT-54 |
| PR-16 | E01, E02, E14 | UAT-24–UAT-27, UAT-39–UAT-41, UAT-47 |
