# Data owner terenkripsi + saran deterministik

Pola untuk menyimpan data pribadi yang tidak boleh terbaca dari database/audit
(mis. bank jawaban screening) lalu menyarankannya hanya jika tepercaya. Contoh
implementasi: `src/lib/answers/service.ts`, `src/lib/answers/normalize.ts`, dan
`tests/integration/answer-bank.test.ts`.

## Skema dan enkripsi

- Kolom ciphertext: `bytea` (mis. `answer_bank.answer_ciphertext`).
- Tambah `question_text text` untuk tampilan manusia dan `version integer` untuk
  optimistic locking; isi `question_text` lama lewat `UPDATE` di migration.
- Enkripsi/dekripsi memakai `encryptSecret`/`decryptSecret` dari
  `src/lib/crypto/secrets.ts` (AES-256-GCM, `MASTER_KEY` dari env).
- Service mengembalikan plaintext hanya ke owner yang terautentikasi; API tidak
  pernah mengembalikan ciphertext dan audit tidak pernah memuat plaintext.
- `recordAudit` cukup mencatat `sourceFactCount` dan `verificationStatus`.

## Aturan status

- `unverified` → default setelah create/edit; boleh ditampilkan untuk review.
- `verified` → satu-satunya status yang boleh menghasilkan `suggested`.
- `retracted` → tidak boleh disarankan.
- Edit nilai yang sedang `verified` harus mengembalikan status ke `unverified`
  kecuali pemilik secara eksplisit mengirim `verificationStatus: 'verified'`.

## Klasifikasi pertanyaan sensitif

- Simpan denylist regex di modul pure (`normalize.ts`), bukan di route.
- Cakup: gaji, disabilitas/kesehatan, pidana, agama, etnis/ras, gender,
  tanggal lahir/umur, status pernikahan, NIK/SSN/paspor, rekening bank,
  consent/tanda tangan, visa/sponsorship, kewarganegaraan.
- Cek sensitif **sebelum** matching; pertanyaan sensitif selalu
  `needs_user_input` tanpa mengembalikan jawaban, walaupun ada jawaban verified.
- Taruh `\b` hanya di awal alternatif prefix: `\b(disabilit|health|medical)`
  cocok untuk `disability`; `\b(disabilit)\b` tidak.

## Matching dan hasil saran

- Normalisasi pertanyaan: lowercase, NFKD, buang aksen/tanda baca, collapse spasi.
- Exact normalized key diutamakan.
- Fallback kemiripan: `max(jaccard, containment * 0.9)` dengan ambang `0.85`;
  Jaccard murni gagal saat pertanyaan pendek diberi kata tambahan.
- Hasil:
  - `suggested` + `reason: verified_answer` → jawaban verified.
  - `needs_review` + `reason: unverified_answer` → tampilkan jawaban + sumber.
  - `needs_user_input` + `sensitive_question` / `no_trusted_answer` /
    `retracted_answer` → `answer: null`.

## Sumber fakta

- `source_fact_ids` divalidasi dengan `profile_facts WHERE owner_id = $1 AND id = ANY($2::uuid[])`;
  jumlah harus sama, jika tidak → `apiErrors.validation`.
- Muat ringkasan fakta (`id`, `type`, `value`, `verificationStatus`) dengan satu
  query `LEFT JOIN profile_fact_versions ON v.id = f.current_version_id`, lalu
  map di memori. Jangan query per jawaban.

## Test yang membuktikan

- `readRawAnswerCiphertext` lalu assert plaintext tidak ada di buffer.
- Assert `audit_events.details::text` tidak memuat plaintext.
- Uji tiap frase sensitif; pastikan `answer` bernilai `null`.
- Uji `verified` → `suggested`, `unverified` → `needs_review`,
  `retracted`/unknown → `needs_user_input`.
- Uji owner lain: list kosong, get/update `NOT_FOUND`, suggest tanpa jawaban.
- Uji edit jawaban verified menaikkan `version` dan menurunkan status.

## UI

- Multi-select fakta memakai
  `Array.from(event.target.selectedOptions, (option) => option.value)`.
- Setelah create/patch, refetch daftar (`GET /api/v1/answer-bank`); jangan
  mengandalkan `router.refresh()` saja.
- Tampilkan status, versi, jumlah sumber, dan teks sumber di kartu jawaban.
