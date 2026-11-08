# Product Requirements Document — AI Job Search Assistant

**Versi:** 0.2 · **Tanggal:** 8 November 2026 · **Status:** draf usulan untuk validasi pemilik produk  
**Terkait:** [Business Spec](07-BSD-Business-Spec.md) · [App Flow](03-AFD-App-Flow.md) · [Implementation Plan](08-IPD-Implementation-Plan.md)

## 1. Ringkasan produk

AJSA adalah aplikasi self-hosted untuk membantu seorang pencari kerja mengelola profil, menemukan dan menilai lowongan, menyiapkan materi yang sesuai, mengisi lamaran, dan memantau proses rekrutmen. Sistem menggabungkan dashboard serta adapter portal dengan alur AI yang menjelaskan kecocokan dan menyiapkan materi berdasarkan fakta kandidat.

P0 mencakup pencarian atau impor lowongan, review dokumen dan pencatatan lamaran manual. P1 menambahkan jadwal serta pengiriman melalui browser setelah pemilik menyetujui formulir final. Mode submit otomatis penuh dapat dirancang pada P2 setelah kebijakan sumber, keamanan, dan UAT disetujui.

## 2. Masalah dan tujuan

| Masalah | Tujuan hasil |
|---|---|
| Lowongan tersebar di banyak sumber dan dapat muncul berulang. | Tampilkan satu antrean dengan sumber asli, deduplikasi yang dapat ditinjau, dan status kesegaran. |
| Membaca seluruh job description memakan waktu. | Urutkan kandidat pekerjaan dengan alasan, gap, dan data yang tidak diketahui. |
| CV, surat, dan jawaban screening sering harus disesuaikan. | Siapkan draf yang relevan dari fakta kandidat yang terkonfirmasi. |
| Pengisian portal berulang dan status lamaran mudah terlupakan. | Bantu mengisi, catat upaya dan bukti pengiriman, serta tampilkan pipeline. |
| Data CV, API key, dan sesi portal sensitif. | Batasi akses, minimalkan pengiriman data, dan sediakan backup/penghapusan yang dapat diaudit. |

## 3. Pengguna dan konteks

| Pengguna | Kebutuhan | Batas hak |
|---|---|---|
| Pemilik/kandidat tunggal | Mengelola profil, pencarian, persetujuan, dokumen, dan lamaran. | Mengakses data pribadi dan konfigurasi miliknya. |
| Worker sistem | Menjalankan jadwal dan tindakan yang telah diizinkan. | Hanya kredensial dan aksi yang diperlukan pada pekerjaan tersebut; tidak dapat menyetujui atas nama kandidat. |
| Penyedia eksternal | Memproses permintaan model, pencarian, email, atau notifikasi yang diaktifkan pengguna. | Hanya menerima data yang diperlukan dan disetujui untuk integrasi tersebut. |

Usulan pilot memakai satu owner per instalasi dengan provisioning lokal. Setiap resource terkait pemilik melalui `owner_id`. Lingkup peran dan deployment tercatat pada `DEC-01`.

## 4. Ringkasan alur

Profil dan fakta terkonfirmasi → pencarian atau impor → deduplikasi dan evaluasi → draf dan review → kirim sendiri dan catat hasil. Pada P1, pengguna juga dapat memilih preflight portal, menyetujui formulir final, lalu memantau bukti pengiriman atau merekonsiliasi hasilnya.

## 5. Kebutuhan produk dan penerimaan

| ID | Fitur dan prioritas usulan | Kebutuhan | Kriteria penerimaan minimum |
|---|---|---|---|
| PR-01 | Setup dan akses — P0 | Operator membuat owner melalui CLI lokal. Pemilik login, logout, dan mengatur timezone. | AC-01. Dashboard dan API privat meminta sesi sah. Provisioning paralel hanya dapat membuat satu owner. |
| PR-02 | Profil kandidat — P0 | Kelola kontak, lokasi, pendidikan, riwayat kerja, skill, bahasa, gaji, preferensi, dan sumber fakta. | AC-02: perubahan terversi; fakta hasil ekstraksi berstatus belum diverifikasi sampai dikonfirmasi; satu field dapat diberi sumber. |
| PR-03 | Pencarian dan impor — P0/P1 | P0 mendukung impor teks lowongan dan satu konektor pencarian jika sumber lolos pemeriksaan. Target JobStreet, Glints, Indeed, dan LinkedIn mengikuti kelayakan dan UAT. | AC-03. Hasil menyimpan provenance, URL jika tersedia, tanggal, dan status. Kegagalan satu sumber tetap menampilkan hasil lain. Pengguna dapat menempel detail tanpa mengakses portal dari server. |
| PR-04 | Normalisasi/deduplikasi — P0/P1 | Normalisasi identitas listing. Pada P1, cocokkan target submit yang terverifikasi. | AC-04. Listing dengan source dan ID sama tidak berulang. Dugaan lintas portal perlu review. Target submit yang sama menahan pengiriman ganda lintas listing. |
| PR-05 | Filter dan ranking — P0 | Terapkan preferensi, pengecualian, alasan skor, dan gap yang bisa ditinjau. | AC-05. Hasil veto dan unknown dijelaskan. Skor total hanya dihitung jika empat dimensi punya bukti yang cukup. |
| PR-06 | Riset perusahaan — P1 | Buat ringkasan dan lampirkan sumber serta tanggal akses. | AC-06. Klaim memiliki sumber. Status outsourcing, bank, atau penempatan tetap unknown bila bukti kurang atau bertentangan. Sumber konflik tetap terlihat. |
| PR-07 | Dokumen lamaran — P0/P1 | Siapkan CV dan cover letter per lowongan; ekspor PDF setelah template tersedia. | AC-07: klaim ditautkan ke fakta terverifikasi atau diberi tanda perlu review; versi yang dikirim dibekukan; PDF diperiksa teks dan layout. |
| PR-08 | Screening Q&A — P0/P1 | Simpan jawaban kandidat dan sarankan jawaban formulir; gunakan AI hanya bila diaktifkan. | AC-08: jawaban sensitif/tidak diketahui tidak ditebak; nilai dan sumber ditampilkan sebelum submit. |
| PR-09 | Sesi portal — P1 | Login manual, simpan sesi secara privat, tampilkan status kedaluwarsa, dan minta intervensi untuk OTP/CAPTCHA. | AC-09. Kredensial dan cookie terlindungi. Sesi kedaluwarsa menghentikan pekerjaan dan meminta tindakan. |
| PR-10 | Isi dan kirim lamaran — P1 | Simulasi lokal, preflight, approval atas formulir final, pengiriman browser dan rekonsiliasi. | AC-10. Dry-run tidak mengirim data kandidat. Form, akun, tujuan dan lampiran harus cocok dengan snapshot. Kuota memakai tanggal intent. Hasil tanpa bukti tetap `submit_unknown`. |
| PR-11 | Tracker dan status — P0/P1 | Kelola pipeline dan catat lamaran manual. Gmail sync opsional P2. | AC-11. Catatan manual menyimpan target, tanggal, sumber, dan versi dokumen jika diketahui. Status pengiriman terpisah dari tahap rekrutmen. Perubahan dari email ditampilkan sebagai usulan. |
| PR-12 | Interview dan learning — P1/P2 | Buat prep pack sesuai lowongan, STAR, gap skill, dan catatan; learning plan P2. | AC-12: pengalaman/angka disertai sumber profil; konten tidak diketahui dinyatakan belum tersedia. |
| PR-13 | Provider AI — P0/P1 | Konfigurasi provider dan model dari dashboard: minimum satu adapter yang diuji pada P0; OpenAI-compatible, Gemini, dan Anthropic native ditargetkan P1. | AC-13: secret tidak dikembalikan via API; uji koneksi menunjukkan provider/model; kegagalan tidak diam-diam mengganti provider tanpa kebijakan yang dipilih. |
| PR-14 | Jadwal dan notifikasi — P1 | Atur pencarian periodik menurut timezone dengan notifikasi opsional. | AC-14. Jadwal bertahan setelah restart. Satu slot waktu lokal menghasilkan satu run. Penerima dan isi notifikasi dikonfigurasi pengguna. |
| PR-15 | Dashboard dan audit — P0/P1 | Tampilkan hasil, antrean, riwayat aksi, status job, dan alasan gagal. | AC-15: pencarian/attempt dapat ditelusuri dengan ID; log tidak menampilkan rahasia, cookie, atau CV penuh. |
| PR-16 | Privasi, backup, operasi — P0/P1 | P0 menyediakan ekspor privat, penghapusan data aktif dan backup. P1 menahan submit browser setelah restore sampai riwayat yang hilang direkonsiliasi. | AC-16. Ekspor mencantumkan isi dan file yang tidak tersedia. Penghapusan mencabut ekspor serta approval terdampak dan menampilkan status serta retensi backup. Restore diuji pada lingkungan terisolasi. |

## 6. Batas dan pengecualian

- Tidak menjamin semua portal dapat diotomasi, lolos CAPTCHA, atau terus kompatibel saat tampilan berubah.
- Tidak menjamin lamaran akan diterima perusahaan atau CV pasti lolos ATS.
- Tidak merekayasa pengalaman, ijazah, status kerja, gaji, atau identitas; AI tidak boleh memberikan persetujuan hukum atas nama pengguna.
- Tidak mengirim massal tanpa mode yang dipilih dan konfigurasi batas; tidak menjanjikan bahwa nilai batas tertentu aman dari pembatasan akun.
- Tidak membuat akun, membayar layanan, mengirim pesan, atau mengubah profil portal secara otomatis di luar aksi yang dipilih.
- Tidak menyertakan aplikasi mobile native, dukungan multi-tenant, dan layanan recruiter pada pilot. Telegram, sinkronisasi Gmail/Notion, autopilot, dan learning plan adalah perluasan yang ditandai P1/P2, bukan fitur yang sudah tersedia.

## 7. Kebutuhan kualitas

| Kategori | Sasaran awal yang harus diukur saat implementasi |
|---|---|
| Integritas | Tidak ada status `submitted_confirmed` tanpa bukti sesuai BR-12; tidak ada retry otomatis pada `submit_unknown`. |
| Keamanan | Dashboard/API autentikasi, izin per owner, CSRF untuk sesi cookie, konfigurasi origin ketat, enkripsi secret; detail pada dokumen operasi. |
| Kejelasan | Tampilkan alasan tidak lolos, sumber, kapan diperiksa, status tidak diketahui, dan biaya/ketergantungan provider yang diketahui. |
| Recovery | Pekerjaan yang dapat diulang dipulihkan setelah crash; upaya submit yang mungkin dikirim tidak diulang otomatis. |
| Observability | Run/attempt ID dan status per sumber dapat dicari; data sensitif tidak dicatat. |
| Aksesibilitas | Navigasi keyboard, label form, kontras, focus state dan teks alternatif diperiksa pada layar prioritas. |

## 8. Metrik pilot usulan

| Metrik | Definisi | Kegunaan |
|---|---|---|
| Review berguna | Lowongan shortlist yang oleh kandidat dinilai relevan ÷ shortlist yang dinilai. | Kalibrasi ranking; target ditetapkan setelah baseline. |
| False confirmed | Jumlah status terkonfirmasi tanpa bukti yang valid. | Target pilot 0; audit sampel setiap run. |
| Duplicate submit | Attempt pengiriman ganda untuk satu lowongan akibat sistem. | Target pilot 0 yang terverifikasi; review tiap kasus unknown. |
| Unknown rate | Attempt `submit_unknown` ÷ seluruh attempt submit. | Memahami kualitas adapter; unknown bukan otomatis kegagalan portal. |
| Waktu manual | Menit yang digunakan untuk meninjau dan mengirim satu lamaran. | Bandingkan baseline manual; bukan target angka yang dijanjikan. |

## 9. Keputusan yang masih terbuka

Sumber dan izin pemakaian, target deployment, apakah mode auto-submit penuh benar-benar diinginkan, provider/model, batas pengiriman, mekanisme approval, dan kebijakan retensi belum disepakati. Nilai dalam dokumen ditandai usulan dan tidak boleh dianggap persetujuan untuk mengirim lamaran. Rincian: [Decision Register](14-Decision-Register.md).
