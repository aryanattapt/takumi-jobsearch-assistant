# Source Integration Map — AI Job Search Assistant

**Versi:** 0.2 · **Tanggal:** 8 November 2026 · **Status:** analisis statis awal, belum ada source yang digabung atau diuji live  
**Terkait:** [TRD](02-TRD.md) · [Implementation Plan](08-IPD-Implementation-Plan.md) · [Review](09-Review-Report.md)

## 1. Sumber dan lisensi

| ID | Source | Snapshot yang diperiksa | Lisensi |
|---|---|---|---|
| SRC-01 | [itzluthfi/Bot-Lempar-Jaring-Loker](https://github.com/itzluthfi/Bot-Lempar-Jaring-Loker/tree/9fcd9ccd3206acb1a7dc783521ce958765e30738) | `9fcd9ccd3206acb1a7dc783521ce958765e30738` | [MIT](https://github.com/itzluthfi/Bot-Lempar-Jaring-Loker/blob/9fcd9ccd3206acb1a7dc783521ce958765e30738/LICENSE), copyright 2026 lemparjaring Contributors. |
| SRC-02 | [ai-job-search-dev/ai-job-search](https://github.com/ai-job-search-dev/ai-job-search/tree/4db9ed7308fd22b6198f03a83b31be7b211a787c) | `4db9ed7308fd22b6198f03a83b31be7b211a787c` | [MIT](https://github.com/ai-job-search-dev/ai-job-search/blob/4db9ed7308fd22b6198f03a83b31be7b211a787c/LICENSE), copyright 2026 Mads Lorentzen. |

Jika memakai kode atau bagian substansial, distribusi perlu mempertahankan kedua pemberitahuan copyright dan teks izin MIT yang relevan, misalnya `THIRD_PARTY_NOTICES/`. Periksa ulang lisensi dependensi, font, aset, dan aturan situs yang dipakai; lisensi repo tidak otomatis melisensikan situs/layanan pihak ketiga.

## 2. Peta pemanfaatan

| Area | Referensi | Yang dipelajari/dapat diadaptasi | Pekerjaan integrasi |
|---|---|---|---|
| Dashboard | SRC-01 `src/app/page.tsx`, `src/components/` | Konfigurasi, panel bot, riwayat dan onboarding. | Pecah komponen besar, buang pengembalian secret, tambahkan auth/API domain dan layar baru. |
| Portal | SRC-01 `src/lib/bots/{glints,jobstreet,indeed,linkedin}.ts` | Selector, alur browser, login, pengisian dan dry-run per platform. | Audit setiap adapter, kebijakan sumber, isolated worker, fixture dan UAT; tidak mengasumsikan selector masih valid. |
| Browser | SRC-01 `src/lib/browserHelper.ts`, `extension/` | Profil sesi, pilihan browser, ide asistensi melalui ekstensi. | Pilih runtime, amankan profil/debugging, review akses ekstensi, intervensi login/OTP/CAPTCHA. |
| Filter | SRC-01 `src/lib/jobMatcher.ts` | Contoh scoring keyword/blacklist. | Pisahkan deterministik/AI, tri-state unknown, jelaskan confidence dan false positive. |
| AI gateway | SRC-01 `src/lib/aiGateway.ts` | Abstraksi Gemini dan OpenAI-compatible serta fallback. | Tambah adapter native Anthropic, write-only secret, kebijakan privasi/fallback dan budget. |
| Q&A | SRC-01 `src/lib/questionAnswer.ts`, `public/imploye-question.csv` | Pola heuristik jawaban dan lookup pertanyaan. | Review dataset/lisensinya, provenance, data sensitif dan unknown; jangan menjawab otomatis tanpa fakta. |
| Portal search | SRC-02 `.agents/skills/*-search/` | Kontrak `search/detail`, contoh CLI, output JSON, fixture. | Bungkus sebagai adapter/worker atau port logikanya; periksa izin masing-masing sumber. |
| Profil, evaluasi, dokumen | SRC-02 `.claude/skills/job-application-assistant/`, `.claude/commands/apply.md`, `rank.md` | Rubric, prosedur grounding, review, CV/cover dan penilaian. | Adaptasi ke orchestrator/API provider-neutral; command Claude bukan endpoint API siap pakai. |
| Interview/tracker | SRC-02 `.claude/commands/interview.md`, `outcome.md`, `gmail-sync.md` | Prep pack, pencatatan hasil, usulan status dari email. | Modelkan data DB, periksa izin konektor, usulan perlu approval. |
| Proteksi input | SRC-02 `tools/posting_guard.py`, `SECURITY.md`, `.claude/settings.json` | Pola cek markup/instruksi dan penjelasan batas keamanan. | Audit porting dan test; ketergantungan pada konfigurasi Claude tidak otomatis berlaku pada app baru. |

## 3. Perilaku upstream yang perlu diperbaiki sebelum reuse

| ID | Observasi snapshot | Risiko dan tindakan pada proyek baru |
|---|---|---|
| SRC-R01 | [Storage](https://github.com/itzluthfi/Bot-Lempar-Jaring-Loker/blob/9fcd9ccd3206acb1a7dc783521ce958765e30738/src/lib/storage.ts#L250-L281) memeriksa URL tanpa filter status, sedangkan bot mencatat `Dry-run Sim`. | Simulasi dapat membuat lowongan dianggap pernah dilamar. Pisahkan mode/event dry-run dan cek hanya status submit nyata yang sesuai. |
| SRC-R02 | [JobStreet bot](https://github.com/itzluthfi/Bot-Lempar-Jaring-Loker/blob/9fcd9ccd3206acb1a7dc783521ce958765e30738/src/lib/bots/jobstreet.ts#L799-L865) mencatat `Applied` pada akhir alur tanpa bukti konfirmasi yang memadai di bagian tersebut. | Bisa terjadi false positive. Tambahkan evidence dan state unknown; cek semua adapter, bukan hanya JobStreet. |
| SRC-R03 | [Automation](https://github.com/itzluthfi/Bot-Lempar-Jaring-Loker/blob/9fcd9ccd3206acb1a7dc783521ce958765e30738/src/lib/automation.ts#L62-L116) memulai hitungan keberhasilan dari nol per sesi. | `limitPerDay` tidak boleh diasumsikan dibatasi lintas run; implementasi baru memakai reservation permanen berdasarkan tanggal dan timezone. |
| SRC-R04 | [Route config](https://github.com/itzluthfi/Bot-Lempar-Jaring-Loker/blob/9fcd9ccd3206acb1a7dc783521ce958765e30738/src/app/api/config/route.ts) mengembalikan config, dan [next.config](https://github.com/itzluthfi/Bot-Lempar-Jaring-Loker/blob/9fcd9ccd3206acb1a7dc783521ce958765e30738/next.config.ts) mengatur wildcard CORS pada API. | Pisahkan secret write-only, autentikasi/otorisasi, CSRF dan origin yang spesifik sebelum remote deployment. |
| SRC-R05 | [Gateway](https://github.com/itzluthfi/Bot-Lempar-Jaring-Loker/blob/9fcd9ccd3206acb1a7dc783521ce958765e30738/src/lib/aiGateway.ts) yang diperiksa mengimplementasikan Gemini dan OpenAI-compatible; README menyebut Claude. | Jangan menjanjikan Anthropic native sebelum adapter dan tes tersedia; fallback tidak diam-diam memindahkan data. |
| SRC-R06 | SRC-02 workflow utama dan permissions didesain untuk Claude Code; ada skill CLI portable dan petunjuk agent lain. | Port peran/kontrak dan guardrail ke sistem baru, bukan menyatakan semua slash command berjalan di semua provider. |

Ini temuan pembacaan kode yang terbatas, bukan laporan pentest atau bukti seluruh aplikasi rusak. Uji runtime dan versi terbaru sebelum membuat keputusan implementasi.

## 4. Strategi integrasi berurutan

1. Bekukan snapshot source dan inventaris dependensi/lisensi; jangan langsung menyalin semua file, hook, pengaturan izin agent, ekstensi, atau asset.
2. Bentuk domain schema, API, auth, dan test harness baru sebagai sumber kebenaran; pilih pendekatan adaptasi per modul setelah spike.
3. Mulai dari impor lowongan dan pencatatan lamaran manual. Adaptasi dashboard dan satu adapter search dengan fixture sesuai kelayakan. Pisahkan kontrak search dari submit.
4. Implementasikan profile, scoring, document generation dan provenance berdasarkan workflow kedua; tetapkan peran agent dan provider adapter sendiri.
5. Adaptasi satu portal submit setelah spike memverifikasi inspeksi form, identitas akun/target dan bukti yang tersedia. Implementasikan snapshot approval, intent, kuota dan recovery hold bersama fixture sebelum UAT live.
6. Lakukan audit source/ketentuan portal dan live UAT yang disetujui per adapter. Fitur tidak lolos tetap disabled dengan fallback manual.

## 5. Batas klaim

- Source sudah tersedia sebagai referensi; paket dokumen ini tidak menyatakan fitur upstream teruji, kompatibel, aman, atau telah terintegrasi.
- Source scraping dan workflow agent dapat berubah; periksa commit dan kebijakan terbaru ketika implementasi dimulai.
- Pekerjaan baru mencakup queue PostgreSQL, snapshot formulir, kuota lintas run, rekonsiliasi unknown, ekspor dan purge, scheduler, serta penahanan submit setelah restore.
