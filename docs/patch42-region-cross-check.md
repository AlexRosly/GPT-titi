# Patch 42: bounded cross-checks of weak-script regional readings

The synthetic international PDF revealed a confident error: PSM7 accepted
发票写码 at confidence 90.08 on server Tesseract 4.1.1; PSM13 read 发票号码
at 92.24 on the same pixels/models. Confidence alone cannot select a winner.

After an accepted regional reading with `detectionUncertain=true` (OSD <3),
compare PSM13 on the same crop/models. Use the unchanged quality gates
(70 general, 85 and primary+5 for weak OSD), script agreement, and single-line
bounds. The cross-check is script-independent, not a Chinese spelling rule.
Strong-OSD accepted readings keep their existing path. Patch41's low-confidence
fallback remains for rejected readings.

## Resource and failure behavior

Cross-checks and patch41 fallbacks SHARE the two-attempt worker-job cap.
There is still at most one extra recognition per eligible region, at most
2 seconds each, subject to the existing 8-second regional / 55-second job
budget and page reserves. The budget is re-evaluated after PSM7. A paged PDF
uses separate worker jobs per page; this is not a two-retry cap for the entire
100-page preparation queue.

Already accepted PSM7 output survives a timeout, process error, low-quality
PSM13 result or exhausted budget/cap. It receives an explicit cross-check
status. Original primary text is never replaced. Extra work may mean later
regions cannot be checked; that is disclosed, not silently called success.

## Saved extraction contract

`alternative` retains the exact accepted PSM7 reading regardless of scores.
`crossCheck` contains:

- `status: agreement|conflict` and two `readings` with psm, exact text,
  confidence, numericAgreement against primary, edgeCoverage, recognitionIncomplete.
- `status: budget|limit|failed|rejected` when comparison cannot complete.
- `status: omitted, reason: output_limit` if comparison detail would overflow
  the existing note/document allowance. Keep the accepted reading when it fits.

Comparison is exact after the existing OCR trim; no space, punctuation, script,
identifier, date or amount normalization is applied. Even agreement is not
proof of correctness. On conflict both readings must be reported; never pick
by confidence. The notes explicitly explain these semantics.

Page diagnostics add `crossChecks` (attempted) and `crossCheckConflicts`.
`layoutRetries` still counts all extra PSM13 calls; `layoutRecovered` counts
successful low-confidence fallbacks only. Conflict/skips/errors mark the
regional check incomplete with an explicit reason. Geometry flags do not
claim that the text is correct.

Cache/checkpoint profile becomes `regions-4`. Existing saved extraction remains
readable; fresh preparation upgrades the profile. Old checkpoints are not mixed
with the new profile. F5/history reads do not rewrite saved text.

## Deployment and checks

Apply only after patch41; no dependency, schema or frontend changes.
Keep OCR_LANGUAGES=auto and OCR_REGIONS_ENABLED=true.

```bash
git apply --check /path/to/patch42.patch
git apply /path/to/patch42.patch
npm run test:files
npm run test:ocr:regions
```

Also run `npm run test:files:integration` with FILES_TEST_MONGO_URI pointing
ONLY to a disposable replica-set test DB named gptiti_files_test_*; it deletes
that DB. Then use the existing PM2 deployment/restart procedure.

Upload the supplied original international PDF again and inspect Saved
extraction, not just the model reply. Han should include both 发票写码731 and
发票号码731 in crossCheck.readings with status=conflict on the diagnosed
engine/models. Primary OCR remains intact. Verify persistence after F5.
Other engines/model versions can agree; that is not guaranteed correctness.
