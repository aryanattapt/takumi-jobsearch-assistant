# Catatan Review — Paket Dokumentasi AI Job Search Assistant

**Versi:** 0.2 · **Tanggal:** 8 November 2026 · **Status:** review revisi spesifikasi  
**Cakupan:** dokumen kebutuhan, alur, desain data/API, aturan bisnis, agent, implementasi, operasi, dan pengujian.

## 1. Kesimpulan

Spesifikasi P0 mencakup alur dari provisioning lokal, pencarian atau impor lowongan, penyiapan materi, pencatatan lamaran manual, hingga pengelolaan data. Submit browser P1 memiliki gerbang tersendiri untuk kemampuan adapter, bukti pengiriman, dan pemulihan. Status aplikasi dan UAT dicatat pada [progres](progres.md).

## 2. Temuan dan respons dalam rancangan

| ID | Gerbang | Temuan/risiko | Respons dalam v0.2 | Verifikasi rencana |
|---|---|---|---|---|
| R-01 | Submit P1 | Dry-run upstream ikut dianggap lamaran. | Simulasi lokal terpisah dari pengiriman, data kandidat, dan kuota. | UAT-16, BR-10. |
| R-02 | Submit P1 | Klik submit atau receipt yang salah dapat menghasilkan status palsu. | Konfirmasi mencocokkan bukti ke target dan akun. Hasil tanpa bukti tetap unknown. | UAT-20, UAT-22. |
| R-03 | Submit P1 | Dua worker atau dua listing dapat mengarah ke target yang sama. | Lock application, pengunci target, approval sekali pakai, dan dispatch intent. | UAT-19, UAT-49, UAT-50. |
| R-04 | Submit P1 | Browser lama dapat hidup setelah lease habis. | Worker recovery tidak menerima izin dispatch. Bukti negatif setelah intent juga memerlukan penutupan sesi lama. | UAT-30, UAT-43, UAT-44. |
| R-05 | Submit P1 | Batas per sesi, pergantian hari, dan perubahan policy dapat mengurangi hitungan. | Bucket stabil per tanggal dan scope. Periksa ulang tanggal dan limit pada intent. | UAT-28, UAT-29, UAT-45, UAT-46. |
| R-06 | Pilot P0 dan P1 | Rahasia dan data pribadi dapat muncul lewat API, ekspor, provider, atau log. | Owner scope, key write-only, storage privat, redaksi, pembatasan provider dan ekspor. | UAT-02, UAT-24, UAT-25, UAT-27, UAT-35, UAT-39, UAT-54. |
| R-07 | Pilot P0 | Agent dapat mengikuti instruksi posting atau merujuk fakta yang tidak mendukung klaimnya. | Sumber tidak tepercaya, izin minimum, cek nilai klaim dengan fakta terversi dan review pengguna. | UAT-11–UAT-15, UAT-31, UAT-51. |
| R-08 | Pilot P0 | Informasi lowongan tidak lengkap dan listing mirip dapat salah digabung. | Filter tiga nilai, identitas sumber, dan review konflik sebelum merge. | UAT-07–UAT-11. |
| R-09 | Discovery | Workflow CLI repo kedua membutuhkan adaptasi sebelum dipakai di web. | Port kontrak dan guardrail secara bertahap. Uji provider dan adapter dari fixture. | E00, E07, UAT-53. |
| R-10 | Submit P1 | Kemampuan dan hasil tiap portal dapat berbeda. | Validasi kapabilitas form dan bukti per adapter. Jalur manual tersedia untuk portal yang belum lolos. | UAT-17, UAT-42, DEC-16. |
| R-11 | Pilot P0 | Setup owner pertama terbuka sebelum owner ada. | Provisioning CLI lokal dengan transaksi singleton. | UAT-01, PR-01. |
| R-12 | Pilot P0 | Tracker manual belum mempunyai aksi untuk mencatat pengiriman eksternal. | Tambahkan catatan manual dengan listing, waktu dan versi dokumen yang diketahui. Tambahkan impor lowongan untuk sumber tanpa adapter. | UAT-37, UAT-38. |
| R-13 | Pilot P0 | Penghapusan dokumen dapat meninggalkan ekspor atau approval yang masih aktif. | Tarik akses dan generasi privasi, batalkan approval terkait, dan pisahkan purge aktif dari expiry backup. | UAT-39–UAT-41. |
| R-14 | Submit P1 | Form, akun atau tujuan dapat berubah setelah approval. | Preflight menyimpan snapshot formulir. Validasi ulang sebelum transfer dan intent. | UAT-18, UAT-42. |
| R-15 | Submit P1 | Riwayat portal kosong dapat salah dianggap bukti belum terkirim. | Perlu bukti otoritatif setelah intent. Review baru dibuka setelah hasil negatif terbukti. | UAT-43, UAT-44. |
| R-16 | Submit P1 | Restore dapat mengembalikan aplikasi yang sudah dikirim ke status draft. | Penahanan submit selama histori sejak checkpoint dipulihkan atau direkonsiliasi. | UAT-47. |
| R-17 | Riset P1 | Hasil riset bisa menyimpulkan jenis perusahaan dari bukti yang bertentangan. | Pertahankan unknown dengan sumber dan tanggal untuk entitas yang sama. | UAT-48, PR-06. |
| R-18 | Jadwal P1 | Waktu lokal berulang bisa membuat dua occurrence. | Slot lokal unik dengan aturan jam berulang dan jam yang tidak ada. | UAT-33, UAT-34, UAT-52. |

## 3. Keputusan terbuka

Keputusan berikutnya mencakup repo dan visibility, cakupan P0, sumber serta provider pertama, retensi, dan kapabilitas submit tiap portal. Nilai approval 30 menit, TTL ekspor 24 jam, backup 30 hari, dan toleransi jadwal 15 menit masih usulan. Estimasi 252–504 jam perlu diperbarui setelah spike sumber dan provider. Lihat [Decision Register](14-Decision-Register.md) dan [Implementation Plan](08-IPD-Implementation-Plan.md).

## 4. Pemeriksaan dokumen

- Review lintas dokumen mencocokkan transisi, kondisi bukti, field snapshot, kuota, penghapusan dan restore dengan kontrak API, schema data, alur UI dan skenario uji.
- Rencana implementasi menautkan 16 kebutuhan produk ke epic dan UAT. Paket memuat 22 aturan bisnis, 54 skenario UAT, dan 16 keputusan yang perlu ditetapkan.
- Pemeriksaan paket memverifikasi versi file, tautan dan anchor internal, ID referensi, contoh skor, jumlah estimasi, serta kesesuaian isi ZIP dengan Markdown.
- Seluruh pengujian di Test Plan masih berstatus rencana. Validasi live dilakukan per portal, akun, dan versi adapter pada fase yang tercantum.
