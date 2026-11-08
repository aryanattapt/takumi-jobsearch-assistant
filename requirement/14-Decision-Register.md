# Decision Register — AI Job Search Assistant

**Versi:** 0.2 · **Status:** seluruh keputusan di bawah masih terbuka kecuali kemudian disahkan pemilik  
**Terkait:** [PRD](01-PRD.md) · [Implementation Plan](08-IPD-Implementation-Plan.md)

Nilai pada kolom usulan dipakai untuk membuat rancangan konkret, bukan dianggap sudah disetujui. Catat keputusan akhir beserta tanggal dan alasan sebelum pekerjaan terkait dilakukan.

| ID | Pertanyaan | Usulan awal | Dampak bila berbeda |
|---|---|---|---|
| DEC-01 | Satu pengguna atau multi-user? | Single owner self-hosted, schema memiliki owner ID. | Multi-user butuh provisioning, isolasi, recovery dan threat model tambahan. |
| DEC-02 | Stack dan deployment? | Next.js/TypeScript + Node LTS, worker, PostgreSQL, Docker Compose pada Linux/homelab. | Bun/Elysia atau stack lain mengubah integrasi source dan toolchain. |
| DEC-03 | Repo dan lokasi implementasi? | Repository baru yang terpisah dari FarmaGO; visibility dipilih pemilik. | Repo existing memerlukan nama/path dan review dampak; tidak menulis ke FarmaGO hanya karena dijadikan referensi. |
| DEC-04 | Sumber awal dan akses yang diizinkan? | Pilih satu sumber untuk spike, lalu target JobStreet, Glints, Indeed dan LinkedIn sesuai izin dan UAT. | Beberapa portal mungkin memerlukan jalur manual atau tidak dapat diotomasi. |
| DEC-05 | Berapa lama approval snapshot berlaku? | Usulan 30 menit, sekali pakai dan dibatasi validitas snapshot. Perubahan material membatalkan approval. | Masa berlaku memengaruhi frekuensi review ulang dan risiko perubahan form. |
| DEC-06 | Bobot scoring dan perlakuan data unknown? | Awal 30/25/15/30. Skor total null jika salah satu dimensi kurang bukti. Filter wajib unknown masuk review. | Hasil ranking dan cara menampilkan kandidat berubah jika aturan skor parsial dipilih. |
| DEC-07 | Kuota, mode submit dan jadwal? | P0 kirim manual. P1 approval per form. Jadwal dan submit browser dimulai nonaktif. Limit harian global dan per portal memakai tanggal intent. Usulan toleransi jadwal 15 menit. | Tetapkan batas dan timezone sebelum mengaktifkan browser. Autopilot memerlukan mandat dan UAT tambahan. |
| DEC-08 | Retensi dan backup data? | Usulan ekspor 24 jam, backup bergulir 30 hari, dan restore terisolasi. Reset data workspace mempertahankan akun login lokal. | Menentukan cakupan purge, penyimpanan audit minimum, dan waktu expiry backup yang terlihat. |
| DEC-09 | Provider/model, budget dan fallback? | Minimal satu adapter diuji; dukung OpenAI-compatible, Gemini, Anthropic secara bertahap; fallback lintas provider off. | Memengaruhi biaya, data yang dikirim, kualitas dan format output. |
| DEC-10 | Apakah boleh reapply/withdraw otomatis? | Tidak otomatis; ditinjau owner dan diatur berdasarkan portal. | Membutuhkan model izin, histori dan kebijakan baru. |
| DEC-11 | Apakah pakai ekstensi sinkronisasi cookie? | Tidak untuk P0; pertimbangkan setelah security review. | Mempermudah sesi, tetapi menambah permukaan risiko dan izin browser. |
| DEC-12 | Notifikasi dan integrasi tambahan? | Jadwal/notifikasi P1; Telegram opsional, Gmail/Notion P2. | Memerlukan kredensial, izin, jaringan, dan kebijakan data. |
| DEC-13 | Bukti apa yang didukung tiap portal? | Bukti positif cocok dengan target dan akun. Setelah intent, hasil negatif perlu bukti otoritatif dan penutupan sesi lama. Tanpa bukti yang cukup, pertahankan unknown. | Definisikan per adapter indikator resmi, referensi, dan metode pencocokan yang dapat diuji. |
| DEC-14 | Haruskah dokumen CV selalu dua halaman dan cover satu halaman? | Panjang template dapat dikonfigurasi; validasi layout dan text layer. | Perubahan toolchain dan aturan per template. |
| DEC-15 | Data pribadi apa yang boleh dikirim ke AI? | Hanya input minimum dari fakta yang dipilih, per provider dengan disclosure. | Data minim mungkin menurunkan kualitas; data lebih lengkap menambah risiko privasi/biaya. |
| DEC-16 | Apa kemampuan adapter submit pertama yang harus dibuktikan? | Akun dan target stabil, preflight form akhir tanpa data kandidat, daftar transfer yang diketahui, serta bukti hasil yang dapat dipetakan. | Bila kemampuan ini belum terbukti, gunakan jalur kirim manual. |

## Format pengesahan

Saat diputuskan, catat `ID`, pilihan final, alasan, tanggal, pemilik, dan dokumen yang perlu diubah. Keputusan produk tidak menggantikan persetujuan tindakan spesifik seperti submit lamaran atau otorisasi akun/provider.
