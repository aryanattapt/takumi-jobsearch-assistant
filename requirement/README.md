# Dokumentasi — AI Job Search Assistant

**Versi paket:** 0.2 · **Tanggal:** 8 November 2026 · **Status:** rancangan hasil review

Paket ini menjelaskan sistem pencarian kerja yang menggabungkan gagasan dashboard/otomasi portal dari Lempar Jaring dengan pencarian, evaluasi lowongan, pembuatan dokumen, dan persiapan interview dari AI Job Search. Nama produk **AI Job Search Assistant (AJSA)** hanya nama kerja.

P0 memakai provisioning lokal, pencarian atau impor lowongan, persiapan materi, pencatatan lamaran manual, dan pengelolaan data. P1 menambahkan pengiriman browser dengan approval formulir, pemeriksaan kuota, bukti hasil dan penahanan setelah restore. Catatan perubahan dan 54 skenario uji rencana tersedia pada [Review Report](09-Review-Report.md) dan [Test Plan](11-Test-Plan-UAT.md).

## Daftar dokumen

| No. | Dokumen | Pertanyaan yang dijawab |
|---|---|---|
| 01 | [Product Requirements](01-PRD.md) | Masalah, target pengguna, cakupan fitur, prioritas, dan kriteria penerimaan apa? |
| 02 | [Technical Requirements](02-TRD.md) | Apa arsitektur, komponen, konsistensi, serta kebutuhan nonfungsionalnya? |
| 03 | [App Flow](03-AFD-App-Flow.md) | Bagaimana alur pencarian, review, lamaran, rekonsiliasi, dan tracking? |
| 04 | [Design Brief](04-DBD-Design-Brief.md) | Apa saja layar, interaksi, empty state, dan aksesibilitas yang dibutuhkan? |
| 05 | [Database Design](05-DBD-Database-Design.md) | Apa entitas, relasi, indeks, constraint, dan cara menyimpan bukti? |
| 06 | [Backend Schema](06-BSD-Backend-Schema.md) | Apa bentuk kontrak API, otorisasi, contoh payload, dan kesalahannya? |
| 07 | [Business Spec](07-BSD-Business-Spec.md) | Apa kebijakan kandidat, scoring, persetujuan, kuota, dan status? |
| 08 | [Implementation Plan](08-IPD-Implementation-Plan.md) | Bagaimana backlog, dependensi, urutan implementasi, dan estimasi upaya? |
| 09 | [Review Report](09-Review-Report.md) | Apa risiko utama, keputusan yang belum final, dan batas review ini? |
| 10 | [AI Agent Design](10-AI-Agent-Design.md) | Bagaimana agent memakai sumber data, model, tools, guardrail, dan evaluasi? |
| 11 | [Test Plan & UAT](11-Test-Plan-UAT.md) | Bagaimana menguji alur normal, race condition, kegagalan, dan portal? |
| 12 | [Deployment, Security & Operations](12-Deployment-Security-Operations.md) | Bagaimana menjalankan, mengamankan, memantau, backup, dan memulihkan sistem? |
| 13 | [Source Integration Map](13-Source-Integration-Map.md) | Bagian mana yang dapat diadaptasi dari dua repo dan apa yang harus dibangun? |
| 14 | [Decision Register](14-Decision-Register.md) | Mana keputusan sementara dan mana yang perlu dikonfirmasi pemilik? |
| — | [Progres](progres.md) | Apa yang sudah dan belum dikerjakan? |

## Cara membaca

1. Mulai dari PRD dan Business Spec untuk memahami perilaku produk.
2. Pakai App Flow dan Design Brief untuk melihat interaksi pengguna.
3. Pakai TRD, Database Design, Backend Schema, dan AI Agent Design sebagai rancangan implementasi.
4. Gunakan Implementation Plan dan Test Plan sebagai backlog dan gerbang verifikasi.
5. Keputusan dengan label **usulan** dapat diubah; [Decision Register](14-Decision-Register.md) adalah daftar pertanyaan terbuka yang menjadi sumber keputusan.

## Konvensi

- ID `PR-xx` = kebutuhan produk; `BR-xx` = aturan bisnis; `AC-xx` = penerimaan; `UAT-xx` = skenario uji; `DEC-xx` = keputusan yang belum final.
- `P0` = cakupan minimum untuk pilot terbatas; `P1` = perluasan utama; `P2` = lanjutan. Urutan ini **usulan**, bukan pengurangan kebutuhan akhir tanpa persetujuan.
- Waktu disimpan dalam UTC; preferensi jadwal memakai zona IANA. Contoh awal `Asia/Jakarta`, dapat diubah.
- `submitted_confirmed` memiliki bukti penerimaan portal atau sumber catatan manual. `submit_unknown` menahan pengiriman berikutnya sampai bukti yang cukup tersedia.
- Tautan antardokumen bersifat relatif agar paket tetap dapat digunakan ketika disimpan dalam satu folder repository.

## Referensi source dan lisensi

- [Bot Lempar Jaring Loker](https://github.com/itzluthfi/Bot-Lempar-Jaring-Loker/tree/9fcd9ccd3206acb1a7dc783521ce958765e30738) — snapshot diperiksa pada 8 November 2026; lisensi MIT, copyright lemparjaring Contributors.
- [AI Job Search](https://github.com/ai-job-search-dev/ai-job-search/tree/4db9ed7308fd22b6198f03a83b31be7b211a787c) — snapshot diperiksa pada 8 November 2026; lisensi MIT, copyright Mads Lorentzen.
- [Struktur dokumentasi FarmaGO](https://github.com/aryanattapt/farmago/tree/d859da27b6fbedffc60a785d0bb84d4bbb04dfb4/requirement) — acuan gaya dan pemisahan dokumen, bukan source kebutuhan produk pencarian kerja.

Jika kode atau bagian substansial dari masing-masing repo digunakan, sertakan salinan lisensi dan pemberitahuan hak cipta yang relevan pada distribusi. Lisensi kode tidak menggantikan izin penggunaan layanan pihak ketiga. Lihat [pemetaan integrasi](13-Source-Integration-Map.md).
