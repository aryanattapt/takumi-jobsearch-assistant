# Design Brief Document — AI Job Search Assistant

**Versi:** 0.2 · **Status:** arahan desain awal  
**Terkait:** [PRD](01-PRD.md) · [App Flow](03-AFD-App-Flow.md)

## 1. Tujuan dan pengguna

Membantu pencari kerja yang sibuk memahami tindakan paling penting hari ini: lowongan yang relevan, informasi yang perlu dilengkapi, draft yang menunggu review, dan pengiriman yang belum pasti. Desktop-first untuk membaca job description dan mengelola dokumen, dengan layout responsif untuk memantau dari ponsel. Ini usulan, bukan hasil riset pengguna.

## 2. Prinsip

1. **Kontrol terlihat:** bedakan `simulasi`, `review sebelum kirim`, dan `otomatis`; tampilkan tujuan dan materi sebelum aksi.
2. **Jujur tentang kepastian:** warna, teks, dan label membedakan konfirmasi portal, konfirmasi manual, gagal, dan tidak diketahui; jangan hanya mengandalkan warna.
3. **Fakta dapat ditelusuri:** skor menautkan alasan ke lowongan/profil; draft menunjukkan bagian yang belum didukung bukti.
4. **Privasi secara default:** API key hanya berupa placeholder termask; data pribadi dan sesi tidak muncul dalam banner/log.
5. **Progressive disclosure:** ringkasan singkat lebih dulu, rincian teknis/riwayat dapat dibuka bila dibutuhkan.

## 3. Arsitektur informasi

| Navigasi | Isi utama | Aksi utama |
|---|---|---|
| Dashboard | Ringkasan run terakhir, shortlist, approval tertunda, unknown, dan error. | Buka hasil atau lanjutkan tindakan. |
| Profil & CV | Profil terstruktur, sumber fakta, versi CV, preferensi, dan blacklist. | Review fakta atau unggah dokumen. |
| Lowongan | Pencarian, impor manual, filter, sumber, shortlist, dugaan duplikat, expired. | Cari, tambah manual, simpan, abaikan, nilai. |
| Detail lowongan | Deskripsi, sumber, skor, gap, riset perusahaan, riwayat. | Buat draft atau buka sumber. |
| Lamaran | Pipeline, catatan manual, dokumen, attempt, bukti, dan penahanan submit. | Catat lamaran terkirim, review, approve, atau rekonsiliasi. |
| Interview | Prep pack, catatan, pertanyaan, sumber fakta. | Generate/revisi; simpan hasil. |
| Aktivitas | Run, event, status portal, jadwal, error aman. | Lihat penyebab dan retry yang diizinkan. |
| Pengaturan | Portal/sesi, provider AI, jadwal, notifikasi, privasi, dan backup. | Uji koneksi, login, ekspor, atau hapus data. |

## 4. Layar prioritas dan isi minimum

| Layar | Elemen wajib | Kondisi khusus |
|---|---|---|
| Onboarding | Indikator tahap, isi manual, unggah CV, verifikasi fakta, langkah lewati. | Ekstraksi gagal; sumber belum dipilih; simpan draft. |
| Dashboard | Kartu ringkasan, jadwal berikutnya, approval/unknown, status worker. | Belum ada data; worker mati; sumber error. |
| Hasil pencarian | Filter yang aktif, sort, sumber/waktu, skor, alasan ringkas, tombol shortlist/abaikan. | Kosong, loading, hanya sebagian sumber sukses, duplikat yang perlu review. |
| Evaluasi | Dimensi skor, gap, sumber fakta, tanggal penilaian, warning. | Sumber tak dapat diakses; evaluasi kedaluwarsa; data tidak diketahui. |
| Review dokumen | Versi, preview teks/PDF, fakta yang dirujuk, edit, kebutuhan input. | PDF gagal, referensi fakta hilang, perubahan sesudah review. |
| Catat lamaran manual | Listing, tanggal kirim, versi CV atau penanda versi belum diketahui. | Ada attempt unknown atau pengiriman yang sudah dicatat. |
| Review submit | Listing, akun portal, tujuan akhir, jawaban, consent, lampiran, dan transfer sebelum submit. | Field atau opsi baru, akun berubah, sesi expired, kuota habis, approval tidak valid. |
| Rekonsiliasi | Waktu attempt, akun dan target, bukti, alasan penahanan, serta hasil yang dapat dipilih. | Opsi belum terkirim tersedia setelah bukti negatif dan penghentian sesi lama diverifikasi. |
| Privasi | Isi ekspor, waktu kedaluwarsa, dampak penghapusan, dan status purge. | Dokumen sedang dipakai, ekspor dicabut, atau backup masih dalam masa retensi. |
| Pengaturan AI | Jenis provider, base URL bila perlu, model, field secret write-only, uji koneksi. | Biaya tidak diketahui; provider error; fallback belum disetujui. |

## 5. Konten dan interaksi penting

- Gunakan label **Terkirim melalui portal**, **Dilaporkan terkirim oleh pemilik**, **Hasil belum pasti**, dan **Simulasi lokal**.
- Tampilkan perbedaan di preview saat dokumen, jawaban, formulir, akun, posting, atau tujuan berubah. Tampilkan persetujuan baru setelah perbedaan selesai ditinjau.
- Dialog submit menyebut perusahaan, jabatan, akun, tujuan, lampiran, serta data yang akan dikirim. Jika intent sudah dibuat, tombol stop mengarahkan ke pemantauan hasil.
- Sembunyikan data sensitif pada tampilan default dan tampilkan hanya ketika diperlukan; jangan menampilkan full API key setelah disimpan.
- Untuk skor gunakan label `skor kecocokan`, bukan `peluang diterima`. Ketika tidak cukup data tampilkan `belum dapat dinilai`.

## 6. Aksesibilitas dan validasi desain

Seluruh form memakai label, pesan error tekstual, urutan tab logis, focus terlihat, dan tombol yang dapat digunakan keyboard. Status tidak hanya dibedakan warna. Teks panjang dan tampilan 200% zoom tetap dapat digunakan; tabel menjadi kartu atau scroll yang dapat diakses di layar kecil. Sediakan loading, empty, partial failure, offline, error, dan confirmation state.

Validasi usulan: uji prototype desktop dan mobile dengan pemilik; lakukan tugas membuat profil, memilih lowongan, membedakan dry-run dan submit, serta menangani unknown. Catat waktu, kesalahan, dan perubahan desain; belum ada hasil validasi saat dokumen ditulis.
