# Business Spec Document — AI Job Search Assistant

**Versi:** 0.2 · **Status:** aturan usulan untuk divalidasi pemilik produk  
**Terkait:** [PRD](01-PRD.md) · [App Flow](03-AFD-App-Flow.md) · [API](06-BSD-Backend-Schema.md)

## 1. Model layanan dan istilah

Produk membantu satu kandidat mencari pekerjaan dan mengelola proses aplikasi menggunakan sumber eksternal yang dipilih. Perusahaan/portal dan penyedia AI/notifikasi adalah pihak terpisah. Sistem tidak menjanjikan akses portal, keamanan akun dari pembatasan, peluang diterima, atau ketepatan otomatis seratus persen.

- **Job:** representasi pekerjaan setelah identitasnya ditentukan; **listing:** tampilan dari suatu sumber. Satu job dapat memiliki beberapa listing setelah identitasnya dikonfirmasi.
- **Application:** rekam kandidat terhadap satu job; **attempt:** satu upaya teknis. **Recruitment stage** adalah perkembangan dari perusahaan, terpisah dari status submit.
- **Verified fact:** fakta yang pemilik konfirmasi dan memiliki provenance; bukan klaim bahwa sistem telah memverifikasi ke pihak ketiga.
- **Approval:** persetujuan sekali pakai atas snapshot formulir dan tujuan pengiriman yang ditampilkan kepada pemilik.
- **Catatan manual:** pengakuan pemilik bahwa ia sudah mengirim lamaran di luar aplikasi. Sistem menyimpan waktu dan sumber catatan tersebut.

## 2. Aturan bisnis

| ID | Aturan | Dampak operasional |
|---|---|---|
| BR-01 | Instalasi pertama hanya memiliki satu owner. Buat akun lewat CLI lokal dengan akses operator. | Provisioning atomik pada satu baris singleton. Dashboard meminta login sejak tersedia dan setiap resource tetap terikat owner. |
| BR-02 | Preferensi dan fakta kandidat dapat diedit; fakta hasil ekstraksi default `unverified`. | Klaim final yang tidak didukung fakta verified harus dihapus atau diminta konfirmasi. |
| BR-03 | Sumber hanya dapat digunakan sesuai kemampuan, konfigurasi, dan kebijakan yang sudah ditinjau. | Source yang belum diizinkan/diuji berstatus disabled atau experimental. |
| BR-04 | Deduplikasi listing memakai identitas stabil dari sumber. Pengiriman memakai identitas target akhir yang diverifikasi oleh adapter. | Tampilkan dugaan kemiripan lintas portal untuk review. Dua listing yang terbukti menuju requisition yang sama berbagi pengaman submit untuk owner yang sama. |
| BR-05 | Filter eksplisit bersifat `pass`, `fail`, atau `unknown`. | Unknown tidak disamakan dengan fail dan tidak boleh dilengkapi dengan fakta hasil tebakan. Kebijakan penanganan unknown harus tampak di UI. |
| BR-06 | Skor adalah ukuran kecocokan terhadap rubric pengguna, bukan peluang diterima. | Tampilkan bobot, alasan, gap, sumber, dan versi evaluasi; data tidak cukup → score `null`. |
| BR-07 | Klaim riset perusahaan menyimpan sumber, tanggal akses, dan konteks perusahaan atau peran yang dirujuk. | Jika bukti kurang atau sumber yang relevan bertentangan, pertahankan `unknown` dan tampilkan sumber terkait untuk diperiksa pemilik. |
| BR-08 | Materi lamaran mengutamakan fakta verified dan dapat diedit pemilik. | AI tidak menciptakan lama pengalaman, nilai, jabatan, sertifikasi, bahasa, atau angka pencapaian. |
| BR-09 | Pertanyaan tanpa jawaban tepercaya, data sensitif, persetujuan hukum, atau nilai yang membutuhkan keputusan pemilik memerlukan input eksplisit. | Form berhenti pada `needs_user_input`; bank jawaban tidak menimpa keputusan baru tanpa review. |
| BR-10 | Pengiriman browser P1 memakai `review_before_submit`. Simulasi `dry_run` memakai fixture atau form lokal. | Simulasi tidak mengirim data kandidat, menekan submit live, atau menghitung lamaran dan kuota. |
| BR-11 | Approval mengikat snapshot immutable yang memuat listing, revisi posting, akun portal, target akhir, fingerprint formulir, jawaban, consent, lampiran, dan transfer sebelum submit yang akan terjadi. | Setelah reservasi, approval hanya berlaku pada attempt tersebut. Worker memeriksa akun, tujuan, form, isi, masa berlaku dan pencabutan sebelum setiap transfer yang disetujui dan sebelum submit. Perubahan material meminta review dan approval baru. |
| BR-12 | Status `submitted_confirmed` memerlukan bukti penerimaan untuk target dan akun yang benar, atau catatan manual pemilik sesuai §5 dan §7. | Catat waktu dan sumber `portal` atau `manual`. Label UI membedakan bukti portal dan laporan pemilik. |
| BR-13 | Dispatch yang mungkin terjadi dengan hasil belum terbukti menjadi `submit_unknown`. | Attempt dan identitas target tetap dikunci untuk pengiriman berikutnya sampai hasil direkonsiliasi. |
| BR-14 | `not_submitted` berarti tidak ada intent atau ada bukti negatif otoritatif sesuai §7. | Setelah intent, hentikan proses lama dan verifikasi hasil portal sebelum membuka retry. Pemilik membuat review serta approval baru untuk setiap attempt berikutnya. |
| BR-15 | Batas pengiriman browser berlaku lintas run dan mengikuti tanggal lokal ketika intent dicatat. | Reservasi berpindah tanggal jika perlu. Konsumsi saat intent tetap tercatat meski hasil gagal atau belum diketahui. Lepas reservasi yang batal sebelum intent. |
| BR-16 | Browser login, OTP, CAPTCHA, dan checkpoint keamanan dikerjakan pemilik. | Adapter berhenti dengan `needs_user_action` dan tidak mencoba melewati proteksi. |
| BR-17 | Scheduler pencarian hanya berjalan jika diaktifkan dan hanya membuat search run. | Deduplikasi menurut jadwal dan slot waktu lokal. Usulan awal melewatkan slot yang lebih lama dari toleransi keterlambatan yang dikonfigurasi. |
| BR-18 | Integrasi Gmail/Notion/Telegram opsional dan hanya aktif setelah konfigurasi dan otorisasi. | Gmail memberi usulan perubahan status dengan sumber; pesan follow-up tidak dikirim tanpa instruksi. |
| BR-19 | Ekspor dan penghapusan data kandidat tersedia untuk owner dengan sesi sah. | Ekspor mengeluarkan data pengguna yang ditetapkan pada API. Penghapusan segera menutup akses, membatalkan draft/approval terdampak, dan membersihkan salinan aktif. Backup mengikuti retensi yang dikonfigurasi. |
| BR-20 | Perubahan status dan tindakan penting harus bisa diaudit. | Log berisi actor, waktu, resource ID, asal dan hasil; tidak menyimpan isi CV/secret. |
| BR-21 | P0 mendukung impor lowongan manual dan pencatatan lamaran yang dikirim sendiri. | Tempel detail lowongan bila adapter tidak tersedia. Catat target, waktu, sumber manual, dan versi dokumen yang diketahui. Pencatatan tidak memakai worker submit maupun kuota. |
| BR-22 | Setelah restore, pengiriman browser tetap ditahan sampai riwayat yang berpotensi hilang diperiksa. | Cakupan penahanan mengikuti akun/target yang terdampak. Jika cakupannya belum diketahui, tahan seluruh pengiriman browser. |

## 3. Filter dan prioritas pekerjaan

Pengguna dapat mendefinisikan posisi, keyword/skill, lokasi, radius bila didukung, work mode, senioritas, jenis kontrak, periode gaji dan mata uang, daftar perusahaan/industri, serta kata negatif. Filter spesifik sumber hanya dikirim bila adapter mendukungnya; filter lain dapat diterapkan lokal jika data tersedia. UI membedakan filter `exclude`, `prefer`, dan `informational`.

Contoh: aturan `industri bank = exclude` + data industri `unknown` menghasilkan **butuh pemeriksaan**, bukan otomatis menerima atau mengecualikan berdasarkan nama yang mirip. Blacklist berdasarkan substring harus menampilkan match dan menyediakan koreksi untuk false positive.

## 4. Skor kecocokan usulan

| Dimensi | Bobot awal usulan | Contoh bukti |
|---|---:|---|
| Keahlian teknis | 30% | Skill yang disebut pada posting dan profil verified. |
| Pengalaman | 25% | Lingkup pekerjaan, senioritas, dan pengalaman aktual. |
| Preferensi/konteks kerja | 15% | Pola kerja yang dinyatakan serta preferensi kandidat. |
| Arah karier | 30% | Kesesuaian terhadap target yang dinyatakan pemilik. |

Bobot mengikuti rubric awal dari AI Job Search. Untuk P0, gunakan aturan usulan pada `DEC-06`. Jika empat dimensi punya skor dan bukti, backend menjumlahkan setiap skor dikali bobot lalu membulatkan ke satu desimal. Jika satu dimensi tidak punya bukti cukup, tampilkan dimensi yang tersedia, `score = null`, dan label **Butuh pemeriksaan**. Hanya hasil yang lolos filter wajib dan memiliki skor lengkap masuk urutan shortlist. Filter wajib dengan hasil `unknown` masuk antrean review. Veto lokasi/bahasa berlaku pada preferensi eksplisit dengan bukti. Skor menyatakan kecocokan menurut rubric kandidat.

## 5. State dan transisi aplikasi

| Dari | Ke | Pemicu dan syarat |
|---|---|---|
| `draft` | `ready_for_review` | Materi minimum tersedia; belum ada submit. |
| `draft` / `ready_for_review` / `not_submitted` | `submitted_confirmed` | P0. Owner mencatat pengiriman manual, dengan waktu dan referensi dokumen yang diketahui. Periksa konflik dengan attempt aktif, unknown, atau target yang sudah tercatat. |
| `ready_for_review` | `approved` | P1. Owner menyetujui snapshot formulir final yang valid. |
| `approved` | `ready_for_review` | Snapshot berubah, approval expired, atau approval dicabut. |
| `approved` | `submitting` | Attempt diterima dan kuota direservasi; approval dikonsumsi sesuai kontrak. |
| `submitting` | `submitted_confirmed` | Bukti portal valid tersedia. |
| `submitting` | `submit_unknown` | Dispatch mungkin terjadi tetapi hasil tidak dapat dipastikan. |
| `submitting` | `not_submitted` | Attempt gagal sebelum intent, atau bukti negatif memenuhi §7 setelah intent. Simpan alasan. |
| `submit_unknown` | `submitted_confirmed` / `not_submitted` | Rekonsiliasi berdasarkan §7. Jika bukti belum cukup, pertahankan `submit_unknown`. |
| `not_submitted` | `ready_for_review` | Pemilik meminta review ulang. Gunakan preflight terbaru dan buat snapshot/approval baru. |
| `draft` / `ready_for_review` / `approved` / `not_submitted` | `cancelled` | Pemilik membatalkan. Cabut approval terkait. |
| `submitting` | `cancelled` | Pembatalan dan pemeriksaan bahwa intent belum ada dilakukan dalam transaksi yang sama. Lepas reservasi dan cabut izin attempt. |
| `cancelled` | `draft` | Pemilik membuka kembali rekam yang sama jika tidak ada pengiriman terkonfirmasi atau belum pasti pada target tersebut. |

`submitted_confirmed` tidak boleh diubah menjadi draft secara diam-diam. Kebutuhan reapply/withdraw mengikuti proses eksplisit yang belum diputuskan (`DEC-10`). Stage rekrutmen disimpan terpisah dan dapat diubah pengguna dengan bukti/catatan.

Setiap transisi yang bisa beradu dengan worker memeriksa versi dan state di bawah lock. Tombol stop menghentikan langkah berikutnya yang masih bisa dicegah. Transfer ke portal yang sudah dilakukan tetap dicatat. Hasil submit setelah intent bergantung pada bukti portal.

## 6. Aturan kalender dan kuota

1. Untuk submit browser, buat reservasi kuota global dan per portal dalam satu transaksi. Kunci kedua bucket sesuai urutan tetap. Bucket diidentifikasi oleh owner, scope, scope key dan tanggal lokal. Versi kebijakan adalah metadata bucket.
2. Tepat sebelum intent, hitung kembali tanggal lokal dari waktu server. Jika tanggal berubah, pindahkan reservasi ke kedua bucket tanggal baru secara atomik. Jika kuota hari baru habis, lepas reservasi lama dan catat `not_submitted` tanpa intent.
3. Saat intent tercatat, ubah kedua reservasi menjadi konsumsi. Pembatalan sebelum intent melepas reservasi. Hasil unknown atau penolakan setelah intent tetap terhitung karena aksi kirim mungkin sudah dilakukan.
4. Perubahan limit berlaku pada pemeriksaan reservasi dan intent berikutnya dengan counter yang sama. Jika limit baru lebih rendah dari total yang sudah dipakai dan dipesan, hentikan attempt yang gagal pemeriksaan sebelum intent dan lepas reservasinya. Riwayat konsumsi tetap ada.
5. Timezone kuota terkunci selama submit aktif. Perubahan memerlukan jeda sampai akhir hari lokal yang sedang berjalan di zona lama dan baru serta pemeriksaan reservasi tertunda. Catat zona saat reservasi dan saat intent. Timezone jadwal pencarian dapat diatur terpisah.

## 7. Bukti dan rekonsiliasi

| Hasil | Bukti minimum | Tindakan |
|---|---|---|
| `confirmed_sent` untuk attempt browser | Receipt resmi atau entri riwayat yang cocok dengan akun portal, requisition dan attempt. Jika pemilik memeriksa sendiri, simpan sumber dan referensi bukti sebagai manual. | Catat waktu dan sumber, lalu ubah ke `submitted_confirmed`. |
| `confirmed_not_sent` setelah intent | Proses/sesi browser lama dihentikan atau aksesnya dicabut. Respons/status otoritatif portal menunjukkan request terkait ditolak sebelum membuat lamaran, atau konfirmasi resmi bahwa request tidak diterima dan tidak tertunda. | Validasi bukti sesuai kemampuan adapter. Setelah valid, ubah ke `not_submitted`. Konfirmasi berdasarkan riwayat kosong atau timeout tetap `unknown`. |
| `unknown` | Portal belum memberi hasil yang cocok atau bukti bertentangan. | Pertahankan pengunci target dan blokir submit berikutnya. Pemeriksaan ulang portal bisa dilakukan jika akses diizinkan. |
| Catatan pengiriman manual P0 | Pernyataan eksplisit pemilik dengan tanggal kirim dan target. Referensi portal atau lampiran dapat ditambahkan. | Buat attempt terminal `manual` dan audit sumber. Jika sudah ada attempt `submit_unknown`, pakai jalur rekonsiliasi. |

Keputusan rekrutmen seperti ditolak setelah lamaran diterima tetap dicatat pada tahap rekrutmen. Jika adapter tidak punya cara memastikan hasil negatif setelah intent, opsi membuka retry tidak tersedia. Kriteria dan referensi bukti per adapter dicatat sebelum live UAT pada `DEC-13`.

Untuk rekonsiliasi recovery tanpa adapter bukti yang qualified, dashboard menerima
laporan manual pemilik dan menampilkannya sebagai manual; aplikasi tidak membuka
atau memvalidasi halaman portal. Hasil `confirmed_sent` memerlukan kecocokan
target/akun dan waktu pengiriman yang dicatat. Hasil `confirmed_not_sent`
memerlukan sesi lama dihentikan serta bukti penolakan otoritatif dan tidak ada
request tertunda. Hasil `unknown` tetap menahan hold dan pengunci target. Pelepasan
hold menyimpan cakupan yang ditinjau, referensi bukti, catatan, pemeriksa, dan
audit. Kuota setelah intent tetap terpakai; pelepasan hold tidak mengaktifkan
browser submission.

## 8. SOP operasional

| Kejadian | Tindakan |
|---|---|
| Status unknown | Hentikan sesi lama jika masih hidup, cek sumber bukti sesuai §7, lalu catat hasil. |
| Kunci AI bocor/diduga bocor | Nonaktifkan provider, rotasi key pada penyedia, periksa audit dan backup, lalu perbarui key. |
| Sesi portal diblokir atau challenge | Hentikan adapter, login manual bila diizinkan; jangan mengakali pembatasan. |
| Profil/CV salah | Koreksi dan verifikasi fakta; invalidasi draft/approval terkait dan lakukan review ulang. |
| Hasil sumber berubah | Simpan source dan waktu, bandingkan snapshot sebelum submit; jika material berubah minta review baru. |
| Restore backup | Tahan submit browser, pulihkan histori bila tersedia, lalu rekonsiliasi tindakan pada rentang data yang mungkin hilang sebelum membuka kembali cakupan terkait. |
