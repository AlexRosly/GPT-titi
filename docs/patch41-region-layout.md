# Patch 41 — bounded regional PSM 13 fallback

## Problem and behavior

Patch 40 correctly rejected the server's Han reading: weak OSD (1.24),
PSM 7 confidence 79.56, below the unchanged 85 threshold. The same pixels
and HanS+HanT models produced the correct line with PSM 13 at 91.8.
This patch retries a plausible, single-line, script-consistent reading once
with PSM 13 when confidence is the reason for rejection. It does not replace
primary OCR or use language-specific corrections, word lists or an LLM.

- Same crop and models; no extra scaling or DPI changes.
- Existing 70 threshold, weak-OSD 85 threshold and five-point gain stay intact.
- Retry output must also agree with the selected script.
- At most two layout retries per worker job, one per eligible region.
- Recheck the remaining 8-second regional / 55-second job budget after PSM 7;
  reserve for remaining pages stays intact. Each retry gets at most 2 seconds
  and is skipped when less than 500 ms remains.
- Accepted alternatives include `psm:13` and `layoutFallback:true`.
  `edgeCoverage`, `recognitionIncomplete` and `numericAgreement` keep their
  existing meaning. Confidence and matching numbers do not prove correctness.
- Page diagnostics add `layoutRetries` and `layoutRecovered`; skipped retries
  disclose `layoutRetryBudget` / `layoutRetryLimit`. Process failures keep
  primary OCR and report `verificationFailed` / incomplete verification.
- Cache/checkpoint profile is `regions-3`. Old saved extraction remains readable;
  new preparation refreshes an old profile. Merely viewing history does not
  re-OCR it. A checkpoint from regions-2 is not mixed with regions-3 results.
- Existing opt-in and manual-language behavior stay unchanged.

## Deployment

Apply after patch 40. No package, schema, frontend or new environment variable.
Keep `OCR_LANGUAGES=auto` and `OCR_REGIONS_ENABLED=true`.

From the backend checkout, with the ZIP extracted and patch path adjusted:

```bash
git apply --check /path/to/patch41.patch
git apply /path/to/patch41.patch
npm run test:files
npm run test:ocr:regions
```

Run file integration tests only against a dedicated replica-set test database
named `gptiti_files_test_*`; the suite deletes that test database:

```bash
FILES_TEST_MONGO_URI='mongodb://127.0.0.1:27017/gptiti_files_test_patch41?replicaSet=rs0' npm run test:files:integration
```

After tests pass, use the existing deployment process, or for the existing PM2
process: `pm2 restart gpt-titi-back --update-env`.
Do not reapply patch40, force a rejected patch, or delete existing files to make
it apply. A check failure means the checkout differs and needs comparison.

## Acceptance

1. Native `Devanagari and weak-OSD...` test passes with a labelled Han reading.
2. The exact original server crop (SHA256
   `d822722a688bca6a5712362e69883562606100902f844dd99cc05d1751bd12cc`)
   yields `这是中文测试文件，请阅读订单内容和发票号码731。`.
   Test comparison ignores OCR spaces only; production strings are unchanged.
3. The forced-low-confidence native worker test proves PSM 13 is used even on
   engines whose initial PSM 7 already passes, and checks primary byte identity.
   Its optional subprocess failure case preserves primary OCR and warns.
4. Upload/prepare the international PDF again. Inspect Saved extraction:
   primary remains visible, Han alternative is labelled. On a fallback,
   `psm:13` / `layoutFallback:true` appear. Save, F5, compare saved extraction.
5. If the server still fails, retain the full native test log and artifacts:

```bash
OCR_TEST_ARTIFACT_DIR=/tmp/ocr41-results npm run test:ocr:regions
```

The PNG fixture is synthetic test content supplied from server diagnostics,
not personal data. A correct result for this fixture is a regression check,
not a guarantee for arbitrary Chinese text or every script.
