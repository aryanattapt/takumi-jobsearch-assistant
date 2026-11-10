# Deployment, Security & Operations — AI Job Search Assistant

**Versi:** 0.2 · **Status:** rancangan operasional
**Terkait:** [TRD](02-TRD.md) · [Database](05-DBD-Database-Design.md) · [UAT](11-Test-Plan-UAT.md)

## 1. Topologi usulan untuk homelab

Docker Compose di satu VM Linux pada Proxmox: `web-api`, `worker`, `postgres`, dan volume privat untuk database, dokumen, serta profil browser. Proses browser/worker memiliki izin dan network minimum; GUI login memerlukan display/remote session privat yang aman. Tailscale atau Cloudflare Access dapat menjadi lapisan akses jarak jauh; tetap gunakan autentikasi aplikasi dan HTTPS pada jalur remote. Tunnel/reverse proxy saja tidak otomatis memberikan autentikasi.

Port database dan browser debug tidak dipublikasikan ke internet. Dashboard lokal dibind ke interface privat/localhost sesuai topologi, origin frontend dibatasi, dan service backend tidak menggunakan kredensial database superuser. Tinjau kebutuhan menjalankan browser dengan sandbox; jangan menonaktifkan sandbox secara default hanya untuk membuat container berjalan.

## 2. Konfigurasi yang diperlukan

| Kategori | Contoh nilai/secret | Perlakuan |
|---|---|---|
| App | URL origin, environment, timezone default | Tidak bersifat secret; validasi startup. |
| Auth | Secret sesi/CSRF dan konfigurasi password | Secret environment/file manager yang dapat dirotasi; jangan commit. |
| PostgreSQL | Host internal, user terbatas, password | Secret terpisah; database privat. |
| Enkripsi | Master key untuk API key dan material sensitif | Di luar database dan backup data; backup key terpisah serta uji recovery. |
| AI | Provider, model, base URL, API key | Key write-only dan terenkripsi; fallback/transfer data memerlukan konfigurasi. |
| Portal | Profil browser privat, label dan status | Tidak log cookie/OTP/password; izin file terbatas. |
| Notifikasi | Telegram token/chat ID jika diaktifkan | Secret dan tujuan diset oleh owner; isi pesan minimal. |

Nama environment variable final ditentukan pada implementasi dan didokumentasikan pada `.env.example` tanpa nilai nyata. Jangan menyalin profil browser, `.env`, atau database ke repository publik.

## 3. Instalasi dan upgrade yang direncanakan

1. Periksa hardware, ruang storage, konektivitas sumber, kebijakan portal, dan versi image yang disetujui.
2. Siapkan direktori volume privat, pemilik/permissions, backup key dan secret; buat akun database terbatas.
3. Jalankan migration dan health check. Buat owner pertama melalui CLI pada host atau container privat dengan akses operator. Isi password lewat prompt terlindung. Uji provisioning paralel dan aktifkan akses dashboard setelah owner dapat login.
4. Konfigurasi sumber dan AI, lalu jalankan test koneksi dan fixture. Aktifkan scheduler atau pengiriman browser setelah gerbang fase terkait terpenuhi.
5. Sebelum upgrade: backup dan uji restore terbaru; baca perubahan schema dan perilaku worker; hentikan penjadwalan dan pastikan tak ada submit aktif/unknown yang terabaikan.
6. Deploy image terpin, jalankan migration terverifikasi, periksa health dan audit. Jika gagal, rollback image hanya bila kompatibilitas schema sudah dipastikan; sebaliknya ikuti rencana recovery migration yang diuji.

Dokumen ini tidak menyertakan perintah Docker sebagai instruksi siap jalan karena image, path, dan file Compose belum dibuat.

## 4. Keamanan

- Autentikasi endpoint privat, validasi owner dan CSRF. Batasi login dan origin CORS. Provisioning owner membutuhkan akses lokal operator.
- Gunakan TLS dari client ke pintu masuk dan di hop lain sesuai model ancaman. Aktifkan akses remote yang terotorisasi; jangan membuka debugging CDP/browser pada interface publik.
- Agent berjalan dengan izin minimal; tidak mengakses shell umum/secret. URL posting tidak boleh mengakses internal network; endpoint model lokal ditetapkan secara eksplisit pada konfigurasi terpisah.
- Rahasia provider terenkripsi saat disimpan; master key di luar database, akses terbatas, dan prosedur rotasi. Jika master key hilang, ciphertext tidak bisa dipulihkan tanpa backup key.
- Validasi upload berdasarkan konten/ukuran, hindari parse dengan privilege tinggi, dan tetapkan lokasi privat; batasi MIME dan extension tetapi jangan mengandalkan keduanya saja.
- Hindari menyimpan screenshot, DOM penuh, jawaban sensitif, dan isi email jika tidak diperlukan. Jika bukti disimpan, enkripsi, batasi akses, retensi, dan sediakan penghapusan.
- Periksa dependency, lockfile, integritas image, serta source extension/adapter sebelum dipasang. Izin ekstensi cookie adalah akses sensitif dan membutuhkan review khusus.

## 5. Observability

| Sinyal | Minimum | Respons |
|---|---|---|
| API liveness/readiness dan DB | Status naik/turun, tanpa menampilkan rahasia | Periksa service, koneksi dan migration. |
| Worker heartbeat dan lease | Worker aktif, tugas tersangkut/lease habis | Bedakan task aman untuk retry dari submission unknown. |
| Search source | Sukses/gagal/latency per source | Matikan adapter bermasalah dan tampilkan hasil sumber lain. |
| Submission | `submitted_confirmed`, `not_submitted`, `submit_unknown`, jumlah reservasi dan recovery hold | Selidiki hasil yang belum pasti dan tahan cakupan yang belum direkonsiliasi. |
| AI provider | Error code aman, latency, token/biaya jika tersedia | Hentikan bila budget habis; fallback sesuai izin. |
| Storage/backup | Ruang tersisa, waktu backup dan hasil restore uji | Atasi kapasitas dan lakukan restore test. |

Log wajib memuat timestamp, request/run/task/attempt ID, jenis operasi, hasil, durasi dan actor terotorisasi. Jangan log CV, body email, jawaban, secret, cookie, token, atau isi prompt. Audit dan log teknis dipisah; retensi dikonfigurasi pemilik dan tidak boleh diklaim terenkripsi tanpa verifikasi.

## 6. Backup dan restore

**Backup.** Buat snapshot database dan salinan file privat pada checkpoint yang kompatibel. Simpan manifest waktu checkpoint, cakupan file, versi aplikasi dan status scheduler/submit. Enkripsi backup, simpan setidaknya satu salinan terpisah dari host, dan lindungi key di lokasi berbeda. Untuk profil browser, putuskan apakah akan disimpan atau login ulang. Manifest mencatat dokumen yang tidak ikut dibackup dan dampaknya pada restore.

**Restore dan pengaktifan kembali.**

1. Hentikan proses lama atau cabut akses browser dan jaringan eksekusinya. Pulihkan di lingkungan terisolasi dengan scheduler, notifikasi, dan submit browser nonaktif pada konfigurasi runtime, termasuk jika konfigurasi dalam backup sebelumnya aktif. Jangan jalankan worker pada instance hasil restore sebelum guard selesai.
2. Jalankan `npm run migrate`, lalu preview guard: `npm run post-restore-guard -- --checkpoint-at 2026-11-10T06:00:00Z --window-end-at 2026-11-10T08:00:00Z`. Gunakan timestamp ISO 8601 beserta zona waktu; hilangkan `--window-end-at` jika waktu berhentinya proses lama belum diketahui. Tinjau preview, lalu tambahkan `--apply` untuk menonaktifkan browser submission, membuat atau memperlebar hold global, dan menulis audit operator. Perintah ini tidak menghentikan worker atau mencabut akses jaringan; langkah isolasi tetap wajib dilakukan lebih dulu.
3. Validasi DB, file, hash, owner dan audit. Pastikan hold global aktif sebelum worker diaktifkan. Tentukan rentang sejak checkpoint terakhir yang pulih hingga proses lama berhenti. Jika rentang, akun, atau portal terdampak belum diketahui, gunakan hold global dengan waktu akhir yang belum diketahui.
4. Jika histori transaksi atau audit yang lebih baru tersedia, pulihkan dan cocokkan attempt, intent, bukti dan kuota dengan data eksternal. Periksa juga aktivitas setelah checkpoint yang tidak punya row attempt di backup. Misalnya, lamaran berstatus `draft` pada checkpoint dapat sudah terkirim sebelum insiden. Bukti portal yang cocok boleh dipakai untuk merekonstruksi event dan status. Riwayat kosong tidak cukup untuk melepaskan hold jika ada dispatch yang mungkin terjadi.
5. Proses intent yang sudah ada dan belum punya hasil sebagai `submit_unknown`. Nonaktifkan task submit dari snapshot serta approval yang tidak lagi valid. Buat review dan approval baru untuk target yang terbukti boleh dikirim lagi. Rekonsiliasi counter kuota berdasarkan intent yang berhasil dipulihkan. Jika histori kuota hari berjalan belum lengkap, tetap tahan submit pada cakupan tersebut sampai kuota dapat diverifikasi atau hari kuota itu berakhir. Hold atas risiko duplikasi tetap berlaku sesuai bukti.
6. Terapkan kembali penghapusan/rotasi yang terjadi setelah checkpoint sebelum mengaktifkan akses normal. Gunakan catatan perubahan minimum yang disimpan terpisah dari snapshot, atau verifikasi data secara manual. Data yang status penghapusannya belum dapat dipastikan tetap diisolasi.
7. Owner mencatat bukti, cakupan, serta alasan pelepasan hold. API reservasi dan worker memeriksa hold sampai cakupan tersebut diselesaikan. Aktifkan kembali scheduler dan notifikasi setelah konfigurasi diverifikasi. Jalankan tes restore dengan contoh lamaran yang hilang dari snapshot, lalu catat gap, waktu pemulihan dan hasil. Target RPO/RTO mengikuti hasil pengukuran.

## 7. Runbook insiden

| Insiden | Langkah penanganan |
|---|---|
| API key bocor | Nonaktifkan provider, cabut/rotasi pada penyedia, audit usage, perbarui penyimpanan, cek log/backup dan dampak. |
| Portal mengunci akun atau challenge terus muncul | Nonaktifkan adapter, hentikan attempt baru, cek portal secara manual; tidak bypass challenge. |
| Submit unknown | Hentikan sesi lama jika masih aktif. Gunakan bukti positif atau negatif sesuai BR-12–14. Biarkan status unknown jika bukti belum cukup. |
| Worker restart atau lease habis saat submit | Setelah intent, jangan berikan hak dispatch pada worker recovery. Catat unknown jika bukti belum ada. Fencing menolak write database dari worker lama. |
| Restore tertinggal dari transaksi portal | Buat hold sesuai cakupan, lalu pulihkan atau rekonsiliasi seluruh jendela yang mungkin hilang. |
| Disk penuh | Jeda task penulisan baru, backup/bersihkan data sesuai kebijakan, verifikasi konsistensi file dan DB. |
| Data kandidat salah dikirim ke provider | Hentikan provider terkait, catat data yang mungkin dikirim, ikuti kebijakan provider dan keputusan pemilik untuk mitigasi. |

## 8. Retensi dan penghapusan

Usulan awal adalah ekspor privat tersedia 24 jam sejak selesai dan backup bergulir disimpan maksimal 30 hari. Tetapkan angka final, periode audit dan bukti, serta cakupan reset sebelum pilot melalui `DEC-08`.

- Setelah request penghapusan diterima, akses aktif dan artefak ekspor terdampak ditarik. Pekerjaan purge menghapus blob, cache, salinan turunan, dan payload privat yang terkait. Fakta yang hanya bergantung pada dokumen tersebut ditarik. Audit menyimpan metadata minimum sesuai kebijakan. Laporkan kegagalan pembersihan dan retry purge secara idempoten.
- Salinan backup yang sudah dibuat mengikuti jadwal expiry terpisah. Tampilkan batas kedaluwarsa backup terdampak jika dapat ditentukan dari manifest. Bila salinan di luar cakupan inventaris, tampilkan status yang perlu diperiksa operator. Restore harus memeriksa dan menerapkan kembali penghapusan setelah checkpoint.
- Untuk reset workspace, cabut integrasi dan akhiri pekerjaan aktif sebelum purge. Submit browser kembali nonaktif dan ditahan sampai histori portal yang hilang diperiksa. Salinan yang telah diunduh pengguna dan data yang diproses pihak ketiga ditangani di luar purge lokal.

## 9. Kesiapan produksi/pilot

Periksa daftar source yang diizinkan, review source code/dependency, auth dan batas jaringan, session handling, pengujian UAT, backup/restore, log redaction, ketersediaan dukungan pengguna, kontrol biaya provider, dan prosedur `submit_unknown`. Tidak ada akses live/otomasi yang dijanjikan oleh dokumen ini.
