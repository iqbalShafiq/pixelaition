# Rencana final: perbaikan pipeline gambar (asset-draw)

Sumber: temuan trace sesi "my fan" ([2026-10-17-fan-session-trace-review.md](./2026-10-17-fan-session-trace-review.md)).
Prinsip: **tidak ada logika keputusan artistik di kode task.** Task mengatur alur dan memvalidasi data; agent tetap yang memutuskan. Determinisme hanya dipakai untuk hal yang memang bukan keputusan seni dan bukan batas "panjang pikiran" (siapa boleh menulis apa, konversi hex→index, validasi schema).

## Prinsip konteks (tanpa cap panjang yang sewenang-wenang)

Riset: _context engineering_ (Anthropic, "Effective context engineering for AI agents", 2025) — context adalah resource terbatas, tapi yang menentukan kualitas adalah **pemilihan token yang tepat**, bukan batas panjang per-field. Tiga teknik baku untuk horizon panjang: **compaction** (ringkas riwayat saat mendekati context window, dihitung model), **structured note-taking**, dan **multi-agent** dengan hasil terdistilasi. Justru "hardcoding complex, brittle logic in your prompts" ditandai sebagai anti-pattern. Di sisi data, structured output divalidasi **schema bentuk**, bukan panjang teks.

Maka di proyek ini:

1. **Tidak ada `.max()` pada teks bebas** (intent, note, summary, label, references note). Field yang dibatasi hanya yang memang punya domain terbatas dan jawabannya adalah mengganti nama/ukuran: nama frame/layer (konsistensi referensi antar tool), ukuran (8–128), jumlah pekerja (1–4), palette (≤256 entri), jumlah fix per order — dan **bukan** panjang prosa.
2. **Batas konteks ditegakkan oleh model, bukan oleh slice di kode.** Riwayat percakapan panjang diatur oleh `@anvia/durable` compaction (`trigger.afterTokens` dari `context_window` model + `createSummaryMemoryCompactor`) yang membaca `contextUsage` respons. Ringkasan dibuat model dari transkrip penuh; tidak ada `slice(0, 4000)`.
3. **Payload data piksel tidak pernah masuk prompt utuh.** `read_frame`/`read_region`/``copy_region` mengembalikan RLE ringkas dan model memilih region — "just in time" retrieval. Copas wilayah dilakukan **kode**, jadi agent tidak perlu membawa piksel di konteks.
4. **Just-in-time untuk data besar**: prompt memuat _referensi_ (nama frame, angka ringkas), bukan isi. Agent memanggil tool untuk detail.
5. **Telemetri menyimpan penuh.** Batas ukuran payload trace adalah batas transport, bukan batas semantik: dipotong di **display/transport** dengan penanda eksplisit `…(truncated at N chars)`; prompt yang memengaruhi keputusan selalu didapat ulang dari sesi durable (canonical), bukan dari trace.

Dependency: hanya Anvia (`@anvia/core`, `@anvia/durable`) + Zod yang sudah dipakai. Tanpa LangChain/LangGraph.

## 0. Keputusan desain yang berubah dari draft awal

| Draft awal                                                           | Keputusan final                                                                                                                                                                                                                                                                                       | Alasan                                                                                                                                                                  |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sisa keputusan review (accept/more-fixes) dihitung kode              | **Round cap dihapus**; reviewer memutuskan `done` atau `fix` tanpa batas ronde, dengan budget _natural language_ di prompt ("when frames are converging, stop; order more only if a new attempt can plausibly land").                                                                                 | Kata kerjamu: wujudkan yang tidak konvergen lewat **semantik**, bukan denyut deterministik.                                                                             |
| Fix child dipaksa 1 frame deterministik, langkah akhir deterministik | **Structured payload frame→{frames, layers} (Zod) yang ditulis literals**: `paste_region`/`use_frame` hanya untuk frame yang ada di payload review, dan tool call ke frame lain ditolak dengan pesan yang menyebut cara yang benar (copy/paste/mirror). Refusal adalah pesan, bukan pembatalan ronde. | Structured output sebagai jalur; penolakan pintu adalah konvensi agentic, bukan pengganti pemikiran agent.                                                              |
| Cap context statis (intent dipotong 41 char, 4000 char di metadata)  | **Tidak ada cap panjang teks sama sekali**: `intent`, `note`, `summary`, `label` jadi `z.string().min(1)` tanpa `.max`. Prompt fix menampilkan note & intent utuh; plan JSON utuh. Riwayat panjang ditangani **compaction Anvia**, bukan slice.                                                       | Kamu eksplisit: "nggak perlu lah, nanti malah kepotong lagi". Riset: batas panjang per-field adalah anti-pattern; yang dipakai adalah schema bentuk + compaction model. |
| "Reviewer tidak tahu history"                                        | **Dua jalur**: (a) reviewer/fix memakai `continueFrom` ke sesi supervisor → seluruh percakapan plan+review sebelumnya sudah ada; (b) blok `Work log` (fix yang dikirim, hasilnya, delta check_animation) masuk ke prompt supaya jelas.                                                                | Riwayat ada tanpa bergantung pada prompt saja.                                                                                                                          |

## 1. Tujuan

1. Fix/reviewer punya konteks penuh: catatan review apa adanya, kerja sebelumnya, angka animasi, palette, frame tetangga.
2. Agent bisa memindahkan gaya antar frame/asset tanpa menggambar ulang manual (copy/paste wilayah, mirror, salin layer).
3. Semua role membaca seluruh project (baca saja) dan tidak pernah ditawari tool yang bukan haknya.
4. Alur "review → fix → review" konvergen secara semantik; berhenti karena reviewer yakin, bukan karena hitungan task, dan kegagalan sistem tetap terpisah dari keputusan reviewer.
5. Trace bisa mengaudit keputusan dan konteks (payload tool berisi JSON sungguhan, prompt di metadata tidak terpotong).

## 2. Workstream dan task

Urutan commit disarankan mengikuti urutan task. Tiap task punya test sendiri dan harus lulus `pnpm typecheck && pnpm test` (+ `pnpm eval` untuk task yang menyentuh prompt/gate).

### T1 — Tidak ada cap panjang teks; prompt utuh; compaction untuk riwayat

- `packages/agent/src/tasks/plan.ts`: `intent` → `z.string().min(1)`; `planReferenceSchema.note` → `z.string()` (boleh kosong); `summary` present_plan tanpa `.max`; `steps`/`label` prosa tanpa `.max`.
- `packages/agent/src/runs.ts`: `planFrameSchema.description` (di staged override) tanpa `.max`.
- `packages/agent/src/tasks/asset-draw.ts`: hapus `.slice(0, 4000)` di `userRequestFromPrompt` (prosa disimpan utuh).
- `apps/worker/src/tasks.ts` `loadReviewContext`: plan utuh + palette + style.
- Prompt fix: note & intent utuh.
- `apps/worker/src/index.ts`: `bindTaskChild` menyimpan prompt spawn penuh di metadata trace (batas hanya di `LangfuseTelemetry.frameText` yang menandai pemotongan secara eksplisit, dan tidak lagi dipakai untuk prompt).
- **Compaction durable**: daftarkan `compaction` untuk agent (semua model) dengan `trigger: { afterTokens: round(0.8 × context_window) }`, `retention: { recentTurns: 2, recentToolTurns: 2 }`, `compactor: createSummaryMemoryCompactor({ model })` — riwayat sesi yang panjang (review ronde ke-10 dst.) diringkas model, bukan dipotong kode. Model tanpa `context_window` tidak mendapat compaction (tetap andal: `contextUsage` tidak dilaporkan; tidak boleh menebak).
- `apps/worker/src/prior-context.ts`: `TEXT_CAP` hanya bisa memotong _langkah_ (steps), sudah ada penanda `(N earlier steps omitted)`; ubah agar **tidak pernah memotong request/follow-up user** (di dokumentasikan dan dijaga).
- Test: `plan.test.ts` intent 900 char lolos; note review 600 char utuh di prompt fix & review; `prior-context.test.ts` request panjang utuh.

### T2 — Tool baca lintas frame dan lintas asset (read-only, satu project)

Tujuan: semua role bisa melihat semua frame di semua asset project yang sama — termasuk palette, style, summary — tanpa bisa mengubah.

**Model (runs.ts)**

```ts
type ProjectSnapshot = {
  projectId: string;
  projectName: string;
  style: StyleGuide;
  palette: string[]; // palette acuan = asset run yang dimiliki
  assets: Array<{
    id: string;
    name: string;
    width: number;
    height: number;
    summary: string;
    palette: string[];
    frames: Array<{
      id: string;
      name: string;
      index: number;
      summary: string;
      buffer: FrameBuffer;
    }>;
  }>;
};
```

- `RunBinding.project?: ProjectSnapshot` diisi saat bind (worker `loadAsset` sudah memuat project; muat semua asset project itu dengan frame decode, hanya saat ada role yang butuh — lazy per asset saat tool dipanggil).
- `RunBinding.onLoadProjectAsset?: (assetId) => Promise<LoadedAsset>` untuk muat satu asset di luar project? **Tidak**: cross-asset dibatasi satu project (keputusan user: "di project yang sama").

**Tools baru (`tools.ts`)**

- `list_project_frames()` → semua asset + frame di project yang sama: `{asset, width, height, frames:[{name, summary, index}], palette}`.
- `read_frame` / `read_region` / `preview_frame`: tambah parameter opsional `assetId`; resolusi `resolveFrameRef(run, {assetId?, frameId})` → `{buffer, frameName, assetId}`; error yang menyebut asset mana yang tidak punya frame itu.
- `read_palette(assetId?)` → daftar hex + index; untuk asset lain, index palette **berbeda** → hasil juga `mapping` ke palette run (Warna sama? Tidak ada index yang cocok → catat `missing`).
- Semua tool ini ditambahkan ke `WORKER_TOOL_NAMES`, `REVIEW_TOOL_NAMES` dan plan (plan = semua). Bukan tool write.

**Test**: `tools.test.ts` — read_frame asset lain ok; asset di project lain → error; asset lain tidak bisa di-write lewat tool apa pun.

### T3 — Copy / paste / mirror wilayah (semua role, termasuk worker)

- `copy_region({ from: { assetId?, frameId, layerId? | view: "composite" }, x, y, width, height })` → `{ source: {...}, width, height, rows: RLE, colors: [...], indices: [...] }`. Tool ini **baca-saja**; hasil dikembalikan ke model sebagai payload ringkas (RLE) — sama dengan `read_region` tetapi terikat ke sumber lain.
- `paste_region({ assetId?, frameId, layerId, x, y, width, height, rows: RLE, map: [{from,name?,to:{assetId,index}|null}] })`:
  - Hanya menulis ke frame yang dimiliki role itu (`assertOwnedFrame`); `assetId` default = asset run.
  - Menggunakan `applyCommand` (bukan menyentuh buffer langsung) dengan perintah baru `{type: "pasteRows"}` di `@pixelaition/pixel` — buat command + test di package pixel. Command mengembalikan error yang jelas untuk RLE rusak.
  - `map` menyelesaikan perbedaan index palette antar asset: model boleh menentukan tujuan; validator memastikan index tujuan ada di palette; warna palette sama (css hex) dipetakan oleh **kode** hanya untuk asset yang **warna palettenya identik** (pemetaan kanonik tanpa keputusan seni), selain itu wajib `map` eksplisit.
- `mirror_region({ assetId?, frameId, layerId, x, y, width, height, axis: "horizontal"|"vertical" })` — membalik region di tempat (command `mirrorRegion`), tanpa menyentuh di luar region.
- `copy_layer({ from: {assetId?, frameId, layerId}, to: {assetId?, frameId, ...}, name? })` — menyalin satu layer utuh ke frame milik role itu; index dipetakan selaras (palette asset lain yang identik) atau ditolak dengan pesan `map` walau untuk layer belum ada `map` opsional; v1 bisa memakai `paste_region` per layer. **(Disarankan ditunda ke iterasi 2.)**
- `use_frame` untuk worker/fix tidak dipakai untuk lintas asset; dibatasi ke frame miliknya (lihat T4).

**Test**: unit di `packages/pixel` untuk command; integrasi di `tools.test.ts` — paste antar frame; mirror; paste lintas asset dengan palette berbeda (index tidak ada → error menyebut `map`).

### T4 — Katalog tool per role (bukan ditolak di runtime)

- `roles.ts` jadi satu-satunya sumber katalog: `toolsForRole(role, tools)` menghasilkan daftar tool yang **memang** dimiliki role — worker/fix **tanpa** `use_asset`, `list_projects`, `create_asset`, `set_palette`, `resize_canvas`, `add_frame`, `delete_frame`, `move_frame`, `rename_frame`, `present_plan`, `critique_frame`, `check_animation`, `critique`, `plan`. Worker/fix **dapat** `preview_frame`, `read_frame/read_region` lintas asset, `read_palette`, `copy_region`, `paste_region`, `mirror_region`, `use_frame` (lihat batas), `ask_user`, `web_search`, `view_image`, semua tool gambar/layer.
- Worker run memakai agent per role (tool list per role) **atau** run binding menyembunyikan tool sesuai role; karena Anvia "an agent carries a fixed tool list" dan arsitektur saat ini memakai satu agent + `continueFrom`, minim: **dua agent per model/effort** (painter: worker+fix; reader: review; supervisor: plan+review+fix? — `continueFrom` hanya untuk sesame agent).
  - Konkret: `agentPrefix:supervisor:<model>:<effort>` (plan, review, fix) dan `agentPrefix:painter:<model>:<effort>` (worker). Fix memakai supervisor karena fix melanjutkan konteks review (T6), tapi tool list supervisor **tanpa** `present_plan`? — `present_plan` tetap dijaga `planApproved` (sudah ada).
- `assertRoleAllowsTool` tetap sebagai pengaman (defense in depth), tetapi pesannya tidak boleh muncul di jalur normal (jika muncul, artinya katalog salah).
- `apps/worker/src/index.ts`: daftarkan agent per role; `workerAttemptTask` memakai agent painter; fix/review terus memakai supervisor.
- Test `roles.test.ts`: katalog worker tidak memuat tool struktural; memuat painting penuh + preview + read lintas asset. Test `gate.test.ts` tetap.

### T5 — Visi: semua role bisa melihat hasilnya

- `preview_frame` untuk worker/fix (T4). Tambah `mode: "side_by_side"` (frame + satu frame pembanding) agar fix bisa membandingkan tanpa menebak.
- Perbaiki prompt: role worker/fix wajib `preview_frame` sebelum selesai; reviewer wajib `preview_frame` (strip) sebelum verdict.
- Model tanpa visi: `preview_frame` tidak ada di katalog untuk model `vision:false` (sudah ada pola `spec.vision`); prompt menyebut bahwa role tidak bisa melihat. (Tidak boleh mengklaim melihat.)

### T6 — Riwayat lintas ronde: konteks fix & review

**a. Fix child**

- Prompt fix (dibangun `loadFixContext`):
  - `Frame <name>` (owned set), `Intent (full)`, `Plan (full JSON)`, `Palette`, `Style`,
  - `Review round <n>`: verdict utuh `{ok, fixes:[{frame, note}]}` (semua, bukan hanya yang di-order → dua fix per order? Lihat `order` di bawah),
  - `Work log since last review`: per fix child sebelumnya: frame target, note target, tool calls ringkas (nama tool + argumen ringkas), hasil `check_animation` setelahnya (centroid, silhouette, flags),
  - `Reference frames`: nama + `read_frame`/`read_region`/`copy_region` tersedia lintas asset.
- Fixer **memakai `continueFrom: reviewKey`** (sudah) **dan** prompt di atas (tanpa `continueFrom` prompt hilang konteks plan).
- `assertFixWrite`: `write_frame`/`paste_region`/`use_frame` hanya untuk frame di payload review (T0) → tool call ke frame lain mengembalikan pesan.
- Fix child boleh memanggil `preview_frame`, `check_animation` (read-only) untuk verifikasi sebelum selesai? — _reviewer pemilik verdict_; check_animation untuk fixer hanya untuk memantau angka, tidak memutuskan. Tambahkan ke katalog painter/supervisor-fix.

**b. Reviewer**

- Prompt review (dibangun `loadReviewContext`) sekarang termasuk:
  - plan utuh, palette, style,
  - `Previous reviews` (verdict ronde sebelumnya) dan `Fixes since last review` (child fix + hasil),
  - `check_animation` terakhir (angka sebelum review dimulai),
  - `Open concerns` (note review lama yang belum ditutup).
- Karena reviewer memakai `continueFrom` ke plan, seluruh percakapan supervisor (plan → review → fix → review) sudah ada di context model; blok di atas membuatnya eksplisit dan dapat diaudit dari trace.

**c. Struktur verdict review (structured output)**

- `reviewVerdictSchema` (Zod, di `packages/agent/src/tasks/plan.ts` atau baru `verdict.ts`):

```ts
{ verdict: "done" | "fix",
  fixes: [{ frame: string, frames_layer: string[] /* layers to touch */,
            note: string /* full */, reference_frame?: string, region?: {x,y,width,height} }],
  summary: string }
```

- Verdict dipakai task untuk membuat vertex order; `fixes` (0..4) **semua** dikirim (hapus `.slice(0, 2)`) — batas jumlah fixes pindah ke instruksi reviewer (semantik), bukan kode.
- `verdict === "done"` → task selesai `completed`.
- `verdict === "fix"` → spawn fix children dari `fixes` (paralel), lanjut review berikutnya. **Tanpa cap ronde**: penghentian adalah `done`. Jika reviewer terus `fix` tanpa perubahan, itu **perilaku** yang harus ditangai: log/notice di console ("reviewer keeps asking for fixes — the agent is not converging") + telemetri; bukan budget kode diam-diam.
- Kegagalan sistem tetap: child review crash → retry bounded; fix crash → retry bounded; _bukan_ ditutupi jadi `completed`.

**d. `check_animation`**

- Perbaiki metrik: drift siluet hanya membandingkan piksel **identik** (mask tetap) atau `check_animation` melaporkan `staticDrift` terpisah dari `movingDrift`; flag loop hanya jika ada frame yang bergeser >2px; flag "loop jumps" hanya untuk perbedaan di area yang genuinely berubah. Untuk sprite yang berputar, drift statis (bahu/stand identik) tidak boleh jadi flag.
- Opsi `regions` (mis. `rows`/mask) agar reviewer bisa mengecek "hanya baling-baling berubah" alih-alih seluruh frame.
- Test di `packages/pixel` untuk metrik (spinning sprite: stand identik di 4 frame → 0 flag).

### T7 — Pengalaman user: verdict reviewer terlihat

- `run_tasks.plan/result`: simpan verdict review terakhir (`reviewVerdict`) dan `rounds`.
- Output task: `{ assetId, frames, rounds, workers, review: { ok: boolean, summary, openFixes } }` — `ok:false` tetap `completed`.
- Web: console menampilkan "Reviewer: done" atau "Reviewer: 2 catatan tersisa" (kartu kecil) + toast terpisah: "Karya selesai. Reviewer masih mencatat 2 hal." — **bukan** "did not save".
- Toast frame-save 409 `RUN_IN_PROGRESS` ditekan saat transisi run (suppress saat `task.data.task.status` masih live dan setelah selesai tunggu 1 tick).

### T8 — Trace & audit

- Pastikan TOOL observation membawa `input`/`output` JSON penuh (bukan `"..."`): konfigurasi exporter/langfuse untuk menyertakan payload; cek `tools/trace-check.mjs` membaca payload dan memverifikasi (prompt per role non-truncated, prompt fix memuat note penuh, payload review memuat plan).
- Prompt spawn anak di metadata trace: string penuh (T1), bukan slice.
- Tambah score trace: `review_rounds`, `review_done` (1/0), `fix_tool_failures` (jumlah), `silhouette_drift_final`. `trace-check.mjs` memeriksa: tidak ada tool call role terlarang, tidak ada tool call gagal, prompt fix memuat ≥ semua karakter note.
- `AGENTS.md` diperbarui: round cap dihapus, copy/paste/mirror, lintas asset read-only, katalog per role, verdict reviewer, work log.

## 3. Detail alur (sesudah perubahan)

```
home → Jev (shape: workers 1..4, review) → plan card (user approves)
plan (supervisor): read_project / list_project_frames / read_palette /
                   web_search / view_image
  → plan JSON {frames:{name,intent,layers}, palette, references, workers}
  → add_frame + set_palette
execute: worker agents (painter) — katalog lengkap gambar & layer,
         read lintas asset, copy_region/paste_region/mirror_region,
         preview_frame(side_by_side), ask_user. Tulis hanya frame miliknya.
review loop (tanpa cap ronde):
  review (supervisor, continueFrom plan) → outputSchema ReviewVerdict
   ├─ "done" → completed (review.ok = true, reviewerMen nilai sendiri)
   └─ "fix"  → fix children (supervisor, continueFrom review)
               write hanya frame di payload; else pesan tool yang menunjuk
               copy/paste/mirror; work log + fix history di prompt
   fix crash → retry (bounded, hanya kegagalan sistem) → failed
```

## 4. Test matrix (ringkas)

| Area              | Test                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| tanpa cap teks    | plan.test (intent 900 char), note 600 char utuh, prior request utuh  |
| lintas asset read | tools.test (asset lain ok; project lain ditolak)                     |
| copy/paste/mirror | pixel command test + tools.test (palette berbeda → map)              |
| katalog role      | roles.test (painter tanpa struktur; memuat preview + lintas asset)   |
| verdict           | asset-draw.test (done/fix, tanpa cap, fixes 0..4, crash ≠ completed) |
| check_animation   | pixel test (spinning sprite 0 flag)                                  |
| trace             | trace-check manual atas sesi baru; tool start/end punya JSON         |
| eval              | `pnpm eval` dengan kasus kipas/berjalan                              |

## 5. Yang tetap deterministik (dan alasannya)

- Validasi schema plan/verdict (Zod) — keputusan tetap milik agent.
- Loop cap **dihapus**: tidak ada budget ronde di kode; bila model terus meminta fix, itu terlihat di console + telemetri.
- Batas tulis per role (ownership, lintas asset read-only) — _security invariant_, bukan keputusan seni.
- Hex/index conversion dan composite preview — operasi mekanis yang tidak boleh di-scramble LLM.
- Guard Jev untuk tool destruktif tetap.

## 6. Hasil eksekusi (verifikasi)

Lihat lampiran laporan trace. Yang terbukti selama eksekusi dan ikut diperbaiki di luar daftar awal:

1. `check_animation` diukur terhadap **frame referensi** (massa tak berubah), bukan hanya pasangan berurutan — flag menyebut nama frame.
2. Critique `STRAY_PIXEL` memakai konektivitas **8 arah** (wisp asap tipis tidak dihitung lepas).
3. Verdict review memakai `done` eksplisit + `summary`; tidak ada batas ronde, dan "temuan yang bertahan tiga kali" adalah keputusan reviewer.
4. `layers` pada order fix **mengikat** (`assertOwnedLayer`), bukan sekadar saran.
5. Console: pesan user 4 baris + scroll; model header mengikuti model percakapan; tool error membawa sebabnya.
6. `tools/trace-check.mjs --task <id>` memeriksa marker konteks per role dan semua panggilan yang ditolak.

## 7. Risiko & mitigasi

- **Reviewer looping tanpa cap** → instruksi konvergensi + telemetri `review_rounds` + console notice; bila terbukti looping di produksi, tambahkan budget _soft_ di prompt (bukan kode).
- **`continueFrom` + banyak anak**: setiap `continueFrom` menyalin riwayat plan+review; sesi panjang tertangani `compaction` (T1). Prompt review tetap memuat angka ringkas, bukan piksel — copy/paste dikerjakan kode.
- **Compaction mengubah perilaku** → ringkasan harus mempertahankan keputusan plan, catatan review terbuka, dan temuan frame; `retention` menjaga 2 putaran terakhir utuh. Diuji lewat sesi panjang (eval).
- **Cross-asset palette** → pemetaan warna identik deterministik; selain itu wajib `map`.
- **Agent per role** menambah register agent (model × effort × role). Worker retry logic harus memakai agent painter.
- **Perubahan schema intent** → melonggarkan `.max` tidak membatalkan plan lama yang tersimpan di checkpoint; plan lama tetap valid (`.min`, `.regex`, `url` untuk reference URL tetap).
- **Model tanpa `context_window`** → compaction tidak dipasang; context tetap dibatasi window provider, dan console menampilkan `0 / —` seperti sebelumnya (tidak menebak).
