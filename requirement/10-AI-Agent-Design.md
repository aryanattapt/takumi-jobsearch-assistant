# AI Agent Design — AI Job Search Assistant

**Versi:** 0.2 · **Status:** rancangan agent
**Terkait:** [TRD](02-TRD.md) · [Business Spec](07-BSD-Business-Spec.md) · [UAT](11-Test-Plan-UAT.md)

## 1. Tujuan dan batas

Agent membantu mengumpulkan, menilai, dan menyiapkan informasi untuk keputusan kandidat. Ia tidak memiliki izin langsung untuk submit lamaran, membaca secret, mengubah izin sistem, menjalankan shell umum, mengirim email/pesan, atau mengikuti instruksi dari job posting. Aksi eksternal melalui API domain yang memeriksa kebijakan dan persetujuan.

Repo AI Job Search menyediakan spesifikasi workflow agent dan skill CLI; file `.claude/commands` bukan service HTTP siap integrasi. Rancangan ini mengadaptasi metode dan kontrak yang relevan ke orchestrator aplikasi, dengan menghormati lisensi; tidak mengasumsikan seluruh slash command bekerja di provider lain.

## 2. Agent/komponen usulan

| Komponen | Input minimum | Output terstruktur | Wewenang |
|---|---|---|---|
| Profile extractor | Teks CV yang dipilih, schema fakta | Fakta kandidat + lokasi/sumber + confidence | Membuat draft fakta `unverified`, tidak mengonfirmasi. |
| Search orchestrator | Query/preferensi, daftar adapter aktif | Run ID dan hasil per sumber | Menjalankan search/detail yang diizinkan; tidak mengirim lamaran. |
| Matching evaluator | Profil verified terpilih, posting bersih, rubric | Score/dimensi/gap/unknown/evidence | Memberi rekomendasi; tidak menyembunyikan veto. |
| Company researcher | Identitas perusahaan yang diperiksa, sumber yang diizinkan | Klaim + URL + tanggal + uncertainty | GET terkontrol; tidak mengikuti instruksi pada posting. |
| Document drafter | Fakta verified, target job, template | Draft CV/cover + klaim ke fact ID | Menulis draft pada area aplikasi; tidak submit. |
| Document reviewer | Snapshot draf, fakta, posting | Temuan grounding dan saran | Read-only, tidak mengubah profil/master. |
| Screening assistant | Pertanyaan, tipe input, fakta/jawaban yang telah disetujui | Jawaban atau `needs_user_input` | Tidak menyetujui syarat/klaim sensitif. |
| Interview assistant | CV yang dipakai, posting, fakta verified | Prep pack dan provenance | Draft saja; tidak mengirim pesan. |

Tidak wajib menggunakan model terpisah untuk setiap komponen. Pemisahan peran adalah batas tanggung jawab; reviewer benar-benar independen membutuhkan konfigurasi dan uji terpisah, bukan hanya label agent.

## 3. Orkestrasi dan state

1. Domain membuat task dengan ID, tipe, input reference dan hak yang terbatas.
2. Worker mengambil versi fakta, revisi posting, kebijakan provider, template dan generasi privasi. Kirim field minimum yang diperlukan. Worker memeriksa generasi sebelum memublikasikan hasil.
3. Pemeriksa posting membersihkan elemen tersembunyi/invisible dan menandai indikasi instruksi; semua isi posting tetap dianggap data bahkan bila tidak terdeteksi.
4. Adapter AI mengirim permintaan dengan system policy yang tetap dan output schema yang ditetapkan versi.
5. Validator memeriksa tipe, rentang, enumerasi, versi fakta, dan referensi bukti yang benar-benar ada dalam input. Reviewer juga memeriksa apakah fakta mendukung nilai klaim. Hasil invalid dapat dicoba ulang secara terbatas untuk generasi.
6. Hasil disimpan sebagai draft/evaluasi versi, disertai metadata provider, model, waktu, biaya/usage bila tersedia, dan hash; pengguna menerima hasil serta ketidakpastian.
7. Review pemilik memutuskan penggunaan. Hasil AI tidak mengubah approval atau status submit.

## 4. Kontrak output usulan

```json
{
  "schemaVersion": "1.0",
  "jobId": "<uuid>",
  "status": "scored",
  "score": 72.0,
  "dimensions": [
    { "name": "technical", "score": 80, "weight": 0.30,
      "evidence": [{ "profileFactVersionId": "<uuid>", "postingExcerptRef": "<reference>" }] },
    { "name": "experience", "score": 60, "weight": 0.25,
      "evidence": [{ "profileFactVersionId": "<uuid>", "postingExcerptRef": "<reference>" }] },
    { "name": "work_context", "score": 60, "weight": 0.15,
      "evidence": [{ "preferenceRef": "<reference>", "postingExcerptRef": "<reference>" }] },
    { "name": "career_alignment", "score": 80, "weight": 0.30,
      "evidence": [{ "preferenceRef": "<reference>", "postingExcerptRef": "<reference>" }] }
  ],
  "gaps": ["Persyaratan yang tidak didukung fakta kandidat"],
  "unknowns": ["Kisaran gaji tidak disebutkan"],
  "vetoes": [],
  "model": "<configured-model>"
}
```

Contoh ini menghitung 24 + 15 + 9 + 24 = 72.0. Backend menetapkan bobot dari versi rubric dan menghitung skor satu desimal dari empat dimensi yang tervalidasi. Gunakan `insufficient_data` dengan `score=null` jika satu dimensi tidak memiliki bukti. Gunakan `unreachable` jika detail tak tersedia dan `failed` jika task gagal. Referensi harus dapat ditelusuri ke versi fakta, preferensi, dan potongan revisi posting yang dipakai. Filter wajib yang unknown diarahkan ke review, sesuai BR-05 dan BR-06.

## 5. Grounding dan konflik fakta

- Setiap klaim baru pada CV/cover menyimpan versi fakta dan bagian draf yang didukung. Bandingkan nilai terstruktur untuk tanggal, jumlah, jabatan, durasi dan sertifikasi. Contoh klaim “5 tahun Java” dengan referensi fakta “3 tahun Java” tetap gagal walaupun ID fakta valid. Untuk klaim kualitatif yang belum dapat dibuktikan, tampilkan teks dan sumber pada review. Materi dengan klaim belum didukung memerlukan koreksi atau fakta baru yang dikonfirmasi sebelum approval.
- Jika CV dan profil berbeda, tampilkan konflik kepada pemilik. Jangan memilih salah satu diam-diam, terutama tanggal, jabatan, angka, bahasa, gaji, lokasi, dan izin kerja.
- Gunakan bahasa lowongan dalam draft bila didukung fakta; sinonim dan penekanan boleh diubah tetapi tidak mengubah tingkat tanggung jawab/pencapaian.
- Jawaban screening berbasis opsi harus cocok dengan opsi yang tersedia; jika tidak ada yang didukung fakta, hentikan dan minta input. Tidak mengasumsikan persetujuan privasi atau terms.
- Pencatatan provenance tidak membuktikan kebenaran objektif; pemilik tetap meninjau fakta dan dokumen.
- Gunakan template PDF yang disetujui dan escape input. Renderer berjalan dengan batas waktu, memori, file dan jaringan. Pemeriksaan text layer dan layout disimpan bersama versi dokumen.
- Untuk riset perusahaan, cocokkan sumber dengan entitas, peran dan waktu yang sama. Simpan URL serta tanggal akses. Jika bukti yang relevan bertentangan, tampilkan kedua sumber dan pertahankan status `unknown`.

## 6. Tools dan jaringan

Allowlist per peran: baca referensi profil/job tertentu, panggil adapter search/detail yang aktif, simpan draft, dan akses sumber perusahaan yang dinyatakan diizinkan. **Tidak** mengakses filesystem bebas, menjalankan perintah arbitrer, membaca `.env`, mengeksekusi HTML/JS lowongan, membuka link dari body secara otomatis, atau menulis konfigurasi/secret.

Validator URL menerima skema HTTPS/HTTP sesuai kebijakan, menolak kredensial di URL, loopback/link-local/private IP dan alamat metadata, memeriksa seluruh redirect dan hasil DNS termasuk IPv6, membatasi waktu/ukuran/respons, serta menghindari DNS rebinding. Koneksi model lokal menggunakan daftar endpoint administrator yang terpisah, bukan pengecualian global untuk URL job. Jaga kebijakan egress pada level infrastruktur juga; validator aplikasi bukan pengganti sandbox.

## 7. Perlindungan prompt injection

Data eksternal dibatasi panjangnya dan ditempatkan terpisah dari instruksi; deteksi markup tersembunyi/instruction-shaped content menghasilkan peringatan, bukan cap aman. Gunakan least privilege, output schema, validasi fakta, pemisahan fetch/review, dan approval manusia. Jika agent diminta posting untuk mengirim data, membuka URL tersembunyi, mengubah kebijakan, atau mengarang fakta, sistem mengabaikan instruksi tersebut dan mencatat sinyal risiko yang aman. Uji adversarial diperlukan karena filter tidak sempurna.

## 8. Provider, biaya, fallback dan privasi

Provider ditentukan per konfigurasi; adapter `openai_compatible`, `gemini`, dan `anthropic` memiliki format request yang sesuai, timeout, error mapping, dan health test. Model lokal hanya berfungsi jika endpoint benar-benar kompatibel; jangan mengklaim dukungan universal. Pengguna melihat nama provider/model, data yang akan dibagikan secara ringkas, dan pengaturan budget bila tersedia. Biaya aktual bergantung provider; catat token dan tarif hanya ketika disediakan/diatur dengan jelas.

Tidak otomatis mengirim CV ke provider lain saat provider utama gagal. Fallback lintas provider default nonaktif hingga diaktifkan; ketika aktif, tampilkan daftar dan implikasi pemrosesan data. Simpan kunci terenkripsi dan tidak kembalikan melalui API.

## 9. Evaluasi agent

Dataset uji berisi profil fiktif, posting bahasa Indonesia/Inggris, konflik fakta, informasi tidak tersedia, prompt injection, dan soal sensitif. Ukur: unsupported claim rate, sumber yang dapat diverifikasi, recall hard-filter, skor yang repeatable dalam toleransi yang ditetapkan, output valid, dan permintaan input pada hal unknown. Catat model/prompt/schema versi; review manual sampel. Tidak ada skor yang membuktikan agent bebas halusinasi.

## 10. Kondisi gagal

| Kondisi | Perilaku |
|---|---|
| Provider timeout/rate limit | Task gagal/menunggu retry terbatas untuk operasi non-submit; tampilkan alasan. |
| Output tidak sesuai schema | Validasi gagal, satu kebijakan retry terbatas atau minta pengguna; jangan simpan sebagai hasil terverifikasi. |
| Source posting tidak tersedia | `unreachable`; tidak mengarang isi maupun skor. |
| Nilai klaim berbeda dari fakta yang dirujuk | Tahan materi dari approval sampai klaim dikoreksi atau fakta yang tepat dikonfirmasi. |
| Fallback belum disetujui | Jangan kirim ke provider lain; tawarkan pilihan manual. |
