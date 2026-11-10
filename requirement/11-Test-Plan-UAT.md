# Test Plan & UAT — AI Job Search Assistant

**Versi:** 0.2 · **Status:** rencana pengujian; belum ada pengujian yang dijalankan  
**Terkait:** [PRD](01-PRD.md) · [Business Spec](07-BSD-Business-Spec.md) · [Implementation Plan](08-IPD-Implementation-Plan.md)

## 1. Tujuan, data, dan bukti

Memastikan kandidat dapat mencari dan menilai pekerjaan, menyiapkan dokumen, serta mengelola lamaran tanpa status palsu atau pengiriman ganda akibat recovery. Gunakan identitas/CV fiktif, portal dummy, model/provider stub, bucket privat dan database PostgreSQL khusus test. Jangan mengarahkan tes ke akun nyata atau portal publik tanpa otorisasi dan persetujuan pemilik.

Setiap hasil dicatat sebagai `not_run/pass/fail/blocked` dengan commit, tanggal, penguji, environment, expected/actual dan ID bukti yang disanitasi. Daftar di bawah adalah skenario yang **direncanakan**, bukan hasil UAT. Tidak memakai screenshot yang berisi akun atau informasi pribadi nyata sebagai bukti yang dibagikan.

## 2. Lapisan pengujian

| Lapisan | Fokus | Contoh |
|---|---|---|
| Unit | Fungsi domain tanpa jaringan | Filter tiga nilai, status, validasi sumber fakta dan approval. |
| Integration | Database/queue/service nyata dalam lingkungan uji | Constraint, transaksi, lease/fencing, idempotensi dan kuota konkuren. |
| Adapter contract | Fixture HTML/JSON dan stub provider | URL normalizer, pagination, detail, timeout, schema/error. |
| E2E | UI + API + worker + portal dummy | Review/submit/konfirmasi, reconnect, crash dan rekonsiliasi. |
| Live UAT | Portal/provider yang diizinkan, dengan pemilik | Login, pencarian, pengisian tanpa submit; submit hanya jika secara terpisah disetujui. |

## 3. Skenario UAT minimum

| ID | Skenario dan langkah ringkas | Hasil yang diharapkan |
|---|---|---|
| UAT-01 | Pada DB baru, coba provisioning dari jaringan dan jalankan dua CLI operator bersamaan. Ulangi setelah satu berhasil. | HTTP tidak dapat membuat owner. Satu transaksi CLI menghasilkan owner. Transaksi lain dan provisioning berikutnya ditolak. |
| UAT-02 | Akses dashboard/API privat tanpa sesi dan dengan CSRF/origin salah. | Akses ditolak; tidak ada data profil atau secret bocor. |
| UAT-03 | Isi profil manual dan simpan ulang dengan versi lama. | Profil tersimpan; versi lama menerima konflik tanpa menimpa perubahan terbaru. |
| UAT-04 | Upload CV fiktif, ekstrak, lalu koreksi tahun kerja yang keliru. | Fakta ekstraksi `unverified` sampai dikonfirmasi; koreksi terversi dan bersumber. |
| UAT-05 | Upload file salah tipe, terlalu besar, atau berisi konten tidak sesuai. | Ditolak dengan pesan aman; file tidak bisa diakses publik dan tidak dieksekusi. |
| UAT-06 | Cari dengan dua sumber stub; satu sukses, satu timeout. | Hasil sumber sukses tersimpan; sumber gagal dan alasan tampil, run ditandai partial. |
| UAT-07 | Dua kali ingest listing dengan source dan external ID sama. | Tidak ada duplikat listing; riwayat pengambilan tetap bisa ditelusuri. |
| UAT-08 | Ingest dua listing yang judul/perusahaannya mirip dari source berbeda. | Diajukan sebagai kandidat duplikat; tidak digabung otomatis hanya berdasarkan kemiripan. |
| UAT-09 | Coba gabung dua job yang masing-masing memiliki application. | Merge berhenti; pengguna diminta menyelesaikan konflik; histori tetap utuh. |
| UAT-10 | Terapkan blacklist industri bank terhadap job yang industri `unknown`. | Hasil ditandai butuh pemeriksaan; sistem tidak mengarang klasifikasi. |
| UAT-11 | Jalankan ranking dengan empat dimensi valid, lalu ulangi dengan satu dimensi kurang bukti dan satu filter wajib unknown. | Hitung total bobot untuk empat dimensi valid. Jika satu dimensi tidak tersedia, total null. Filter wajib unknown masuk review. |
| UAT-12 | Posting detail tidak dapat diambil atau berisi prompt injection. | Detail ditandai unreachable atau peringatan; instruksi dari posting tidak diikuti; skor tidak dibuat hanya dari judul. |
| UAT-13 | Generate CV dan cover berdasarkan profil fiktif yang tidak menyebut sertifikasi. | Sertifikasi tidak diciptakan; setiap klaim penting dapat ditautkan ke fakta; pemilik dapat mereview. |
| UAT-14 | Generator PDF gagal atau PDF tidak memiliki text layer yang benar. | Kegagalan terlihat; dokumen tidak disebut lulus pemeriksaan ATS/layout. |
| UAT-15 | Screening menanyakan gaji/izin kerja yang belum ada dalam profil. | `needs_user_input`; bot tidak menebak atau memilih persetujuan sensitif. |
| UAT-16 | Jalankan dry-run pada fixture yang mencoba mengirim form atau upload. Pantau request eksternal dan counter kuota. | Tidak ada pengiriman data kandidat atau submit ke jaringan eksternal. Catatan `dry_run` terpisah. Kuota dan status aplikasi tetap. |
| UAT-17 | Login portal dummy kedaluwarsa, lalu tampilkan OTP/CAPTCHA. | Adapter berhenti pada `needs_user_action`; tidak mencoba menyelesaikan challenge otomatis. |
| UAT-18 | Setujui preview lalu ubah satu jawaban/CV. | Approval lama dicabut/tidak valid; submit ditolak sampai review baru. |
| UAT-19 | Dua permintaan/worker bersamaan mencoba submit application yang sama. | Maksimal satu attempt aktif dan satu dispatch ke portal dummy; request lain konflik/status existing. |
| UAT-20 | Klik submit di dummy; portal menyimpan tetapi koneksi putus sebelum respons. | `submit_unknown`; tidak auto-retry, tidak ada klaim sukses, dan retry diblokir. |
| UAT-21 | Worker crash sebelum dispatch intent tercatat, dengan bukti tidak ada request. | Menjadi `not_submitted` atau state recovery yang terbukti aman; attempt berikutnya wajib approval baru. |
| UAT-22 | Rekonsiliasi UAT-20 sebagai unknown. Coba receipt dari akun lain, lalu receipt resmi yang cocok. | Receipt pertama ditolak. Receipt yang cocok mencatat sumber dan waktu lalu menghasilkan `submitted_confirmed`. |
| UAT-23 | Ubah recruitment stage menjadi interview lalu rejected. | Timeline dan actor tercatat; submission status tidak otomatis berubah. |
| UAT-24 | Simpan API key fiktif lalu cek respons API, logs, UI, dan export. | Hanya status/mask; key utuh tidak keluar atau tercatat. |
| UAT-25 | Coba baca CV/bukti owner lain dengan ID yang diketahui. | Akses ditolak tanpa mengungkap eksistensi resource. |
| UAT-26 | Backup database + file terenkripsi, pulihkan di lingkungan terisolasi dengan key yang benar. | Profil dan metadata konsisten; tidak ada job submit yang otomatis dijalankan saat restore. |
| UAT-27 | Uji URL posting yang mengarah ke loopback, metadata, private IPv4/IPv6, redirect dan DNS berubah. | Permintaan diblokir sesuai kebijakan; tidak membatasi endpoint model lokal yang secara eksplisit diizinkan admin. |
| UAT-28 | Jalankan submit attempt di dua run berbeda dengan sisa kuota satu secara bersamaan. | Satu reservation diterima dan satu ditolak; tidak melampaui kuota. |
| UAT-29 | Catat intent, hilangkan respons, restart, lalu buat run baru pada hari yang sama. | Konsumsi kuota tetap tercatat dan target unknown tetap menahan kiriman berikutnya. |
| UAT-30 | Habiskan lease setelah intent. Jalankan recovery, kemudian hidupkan kembali worker lama. | Worker recovery tidak dispatch. Write worker lama ditolak. Hasil tetap unknown sampai bukti yang sesuai tersedia. |
| UAT-31 | Generate interview prep dengan tanggal kerja yang saling bertentangan. | Konflik ditampilkan dan diminta klarifikasi; jawaban tidak merekayasa tanggal. |
| UAT-32 | Gmail sync diaktifkan dengan email stub ambigu. | Usulan menyertakan sumber; tidak mengubah tracker sebelum pengguna menyetujui dan tidak mengirim email. |
| UAT-33 | Jalankan dua scheduler pada slot tanggal dan jam lokal yang sama. | Satu occurrence, satu search run dan satu task tercatat. |
| UAT-34 | Hidupkan scheduler setelah slot lewat, pertama di dalam lalu di luar toleransi keterlambatan. | Slot dalam toleransi bisa diproses sekali. Slot yang terlalu lama dilewati. Scheduler hanya membuat pencarian. |
| UAT-35 | Provider utama gagal dengan fallback belum diaktifkan. | Tidak ada permintaan ke provider kedua; user dapat memilih fallback/manual. |
| UAT-36 | Event notifikasi dicoba ulang setelah kegagalan penyedia. | Event memiliki dedupe key dan status; tidak menyatakan terkirim tanpa respons; batas jaminan provider dicatat. |
| UAT-37 | Pada P0, catat lamaran yang dikirim sendiri beserta tanggal dan versi CV. Ulangi request. Coba pada application yang memiliki attempt unknown. | Satu catatan terminal `manual` dan audit. Tahap rekrutmen tetap terpisah. Tidak ada task browser atau kuota. Attempt unknown diarahkan ke rekonsiliasi. |
| UAT-38 | Matikan semua adapter, tempel deskripsi lowongan, dan coba URL internal atau URL rujukan biasa. | Lowongan valid tersimpan sebagai `manual`. URL berbahaya ditolak. Server tidak melakukan fetch untuk impor. |
| UAT-39 | Ekspor workspace fixture. Periksa manifest, isi, owner lain, replay key, dan unduhan setelah TTL. | Data dalam scope dan file yang tidak tersedia tercatat. Secret dan cookie dikecualikan. Akses owner lain serta unduhan kedaluwarsa ditolak. |
| UAT-40 | Buat draft, approval dan ekspor dari satu CV. Hapus CV saat attempt aktif, lalu ulangi setelah attempt ditutup. | Request pertama `DOCUMENT_IN_USE`. Request kedua mencabut unduhan dan approval serta menarik fakta yang hanya berasal dari CV itu. Purge menghapus blob dan salinan turunan. Status mencatat expiry backup. |
| UAT-41 | Reset workspace ketika worker ekspor memakai snapshot lama. Pulihkan salinan DB lama pada lingkungan uji. | Worker lama gagal menerbitkan ekspor. Reset mencabut integrasi dan submit browser. Restore menerapkan kembali penghapusan sebelum membuka akses. |
| UAT-42 | Setelah approval, ubah field wajib, pilihan consent, akun portal, tujuan redirect atau lampiran pada fixture. Tambahkan handler yang mengubah payload saat request dibuat. | Perbedaan menahan transfer yang tidak tercantum. Snapshot lama tidak dapat dipakai lagi. Jika intent sudah ada dan hasil belum dapat dibuktikan, pertahankan unknown. Form atau request yang tak bisa diperiksa memakai jalur manual. |
| UAT-43 | Portal menerima request tetapi riwayat sementara kosong. Hentikan sesi lama dan coba `confirmed_not_sent` dengan catatan saja. | Hasil tetap `submit_unknown`. API menolak bukti yang tidak cukup dan tidak membuka retry. Receipt yang muncul kemudian bisa direkonsiliasi. |
| UAT-44 | Sediakan bukti resmi bahwa portal menolak request sebelum membuat lamaran, dan pastikan sesi lama berhenti. Rekonsiliasi lalu buka review baru. | `not_submitted` lalu `ready_for_review`. Konsumsi kuota lama tetap tercatat. Attempt baru hanya dapat dibuat dengan snapshot dan approval baru. |
| UAT-45 | Reserve pukul 23.59 waktu kuota. Jalankan intent pukul 00.01 dengan dua kondisi, kuota hari baru tersedia dan habis. | Jika tersedia, konsumsi masuk hari baru dan reservasi lama dilepas. Jika habis, attempt berhenti tanpa intent dan reservasi lama dilepas. |
| UAT-46 | Gunakan sebagian kuota, buat reservasi aktif, lalu ubah limit di hari lokal yang sama. | Counter tidak kembali nol. Pemeriksaan intent memakai limit baru dan bucket yang sama. Attempt yang tidak memenuhi limit berhenti sebelum intent. |
| UAT-47 | Backup saat application masih draft. Kirim setelah checkpoint, restore DB lama, jalankan preview post-restore guard, lalu apply sebelum worker aktif. Ulangi apply dengan rentang lebih lebar dan uji juga perubahan hold bersamaan dengan intent. | Preview tidak mengubah DB. Apply menonaktifkan browser submission, membuat hold global, dan menulis audit; pengulangan memperlebar rentang dan tidak mempersempit waktu akhir yang tidak diketahui. Recovery hold memblokir attempt baru walau row pengiriman hilang. Bukti portal yang cocok merekonstruksi status. Lock kontrol menserialisasi hold dengan intent. Hold tetap aktif pada cakupan yang belum terbukti. |
| UAT-48 | Riset status outsourcing dari dua sumber relevan yang bertentangan. Periksa juga contoh perusahaan dengan nama mirip. | Status tetap unknown. Tampilkan kedua sumber dan waktu akses. Sumber dari entitas berbeda tidak digunakan untuk menetapkan klaim. |
| UAT-49 | Dua listing dari portal berbeda terverifikasi menunjuk requisition yang sama. Buat attempt paralel. | Pengunci target hanya mengizinkan satu attempt. Konflik dapat ditinjau melalui canonical job tanpa menghapus histori. |
| UAT-50 | Balapkan cancel atau revoke approval dengan transaksi intent. Ulangi dengan approval yang kedaluwarsa di antrean. | Jika pembatalan menang, intent tidak dibuat dan kuota dilepas. Jika intent sudah ada, pengiriman berstatus sesuai bukti. Approval kedaluwarsa berhenti sebelum intent. |
| UAT-51 | Agent merujuk ID fakta yang ada tetapi menaikkan lama pengalaman atau mengubah angka. | Klaim masuk review dan memblokir kesiapan materi sampai dikoreksi. Referensi ID yang valid saja tidak meloloskan klaim. |
| UAT-52 | Gunakan fixture zona IANA dengan jam berulang dan jam yang tidak ada. | Jam berulang memakai kejadian pertama. Jam yang tidak ada dilewati. Slot lokal tidak membuat run kedua. |
| UAT-53 | Uji koneksi provider yang dipilih dengan stub sukses, kredensial salah dan model tidak didukung. | UI menunjukkan provider/model yang dipakai dan status yang tepat. Respons serta log menampilkan nilai aman. |
| UAT-54 | Telusuri satu pencarian dan attempt dummy melalui request ID, task dan audit. Sertakan input sensitif fiktif. | Status dan penyebab dapat ditelusuri. CV, cookie, token, isi jawaban dan prompt tidak masuk log. |

## 4. Test tambahan kritis

- **Idempotency:** key sama + body sama mengembalikan operasi yang sama; key sama + body berbeda `409`; key paralel tidak membuat dua operasi.
- **Snapshot:** posting berubah material antara review dan dispatch → approval invalid; perubahan nonmaterial ditentukan dan diuji berdasarkan kebijakan versi yang disetujui.
- **Batas timezone:** uji peralihan hari `Asia/Jakarta`, UTC dan zona yang memiliki DST; perubahan timezone tidak mereset bucket kuota secara tidak sah.
- **Penyimpanan:** database gagal setelah upload atau sebaliknya → file yatim dibersihkan sesuai prosedur; pemulihan tidak menghapus data yang masih direferensikan.
- **Audit:** event actor/waktu/state ada; log, trace dan error tidak mengandung secret, CV, cookie, jawaban sensitif atau isi email.
- **AI:** input hidden/invisible, instruksi palsu dalam posting, jawaban JSON rusak dan fact ID tidak ada → tidak terjadi aksi eksternal dan hasil gagal validasi atau butuh review.
- **UI:** keyboard, fokus, label, kontras, skala 200%, layar kecil, partial failure dan indikator status tidak hanya memakai warna.

## 5. Aturan live UAT dan acceptance

1. Pilih secara eksplisit sumber, akun, rentang waktu, data fiktif/nyata yang boleh dipakai, dan siapa yang memeriksa hasil.
2. Awali search dan dry-run; simpan bukti yang disanitasi. Jangan melewati CAPTCHA, OTP, rate limit, atau pembatasan akses.
3. Submit live hanya setelah owner menyetujui lowongan spesifik dan isi yang akan dikirim. Rekonsiliasi dengan riwayat portal.
4. Gagal satu invariant integritas/akses/privasi = blokir pilot fitur terkait. Gagal fitur P1/P2 tidak otomatis memblokir P0 jika benar-benar terisolasi dan dinonaktifkan.
5. Hasil review dan issue dicatat; tidak menandai rilis siap hanya karena semua unit test hijau.
