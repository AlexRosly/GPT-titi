// Defaults remain unchanged. Operators opt into larger test budgets through
// explicit environment values; these absolute ceilings also bound ledger IDs
// and historical status DTOs after the configured limits are lowered again.
const ceilings = Object.freeze({ usd: 5, runs: 24, calls: 32, totalMs: 600000 });
const fail = () => Object.assign(new Error('COMPUTE_CONFIGURATION_ERROR'), {fileError:'COMPUTE_CONFIGURATION_ERROR',status:422});
function number(name, fallback, min, max, integer = true) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max || integer && !Number.isSafeInteger(n)) throw fail();
  return n;
}
function limits() { return {
  runMs:number('COMPUTE_RUN_MS',60000,1000,60000), totalMs:number('COMPUTE_TOTAL_MS',180000,1000,ceilings.totalMs),
  runs:number('COMPUTE_MAX_RUNS',5,1,ceilings.runs), calls:number('COMPUTE_MAX_CALLS',6,1,ceilings.calls),
  memoryMiB:number('COMPUTE_MEMORY_MIB',512,256,1024), slots:number('COMPUTE_SERVER_SLOTS',2,1,2),
  usd:number('COMPUTE_MAX_USD',0.20,0.001,ceilings.usd,false), outputTokens:2048,
  inputBytes:25*1024**2, outputBytes:25*1024**2, files:10, codeBytes:32768, textBytes:16384,
  durationMs:600000, tmpMiB:256,
}; }
module.exports = { limits, ceilings };
