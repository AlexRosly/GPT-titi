// Offline plan simulation, never a provider request or a production charge.
// Unlike the old comparison, spent grows after EACH simulated paid step.
const fs = require('node:fs/promises');
const {measure} = require('./checkDocxContinuation');

function simulate(measurement, completionTokens = 1024) {
  if (!Number.isSafeInteger(completionTokens) || completionTokens < 1 || completionTokens > 2048) throw Error('Output scenario must be 1..2048 tokens');
  let spentUsd = 0;
  const steps = [];
  for (const step of measurement.steps) {
    const estimate = step.after;
    const projectedUsd = spentUsd + estimate.usd;
    const allowed = projectedUsd <= measurement.limitUsd;
    const simulatedUsd = allowed ? (estimate.promptTokens * measurement.pricing.inputPerM + completionTokens * measurement.pricing.outputPerM) / 1e6 : 0;
    steps.push({afterInspection:step.target,offset:step.offset,displayed:step.inspectionItems,nextOffset:step.nextOffset,
      spentBeforeUsd:spentUsd,estimatedNextUsd:estimate.usd,projectedUsd,allowed,
      simulatedPromptTokens:allowed?estimate.promptTokens:0,simulatedCompletionTokens:allowed?completionTokens:0,simulatedUsd});
    if (!allowed) break;
    spentUsd += simulatedUsd;
  }
  return {offlineOnly:true,assumedOutputTokensPerCall:completionTokens,limitUsd:measurement.limitUsd,
    note:'Conservative input estimates and assumed output, including any reasoning. Not production usage. Initial provider request is outside the existing additional-call cap. The final edit is assumed complete=true and verified, so final narration costs zero. Model choice of targets is not tested by this simulation.',
    steps,allPlannedProviderStepsAllowed:steps.length===measurement.steps.length&&steps.every(s=>s.allowed),simulatedAdditionalUsd:spentUsd};
}
if (require.main === module) (async()=>{
  const [path,...targets]=process.argv.slice(2);
  if(!path||!targets.length)throw Error('Usage: node scripts/checkDocxWorkflowBudget.js FILE.docx tables table0[,table1,...]');
  const pricing={inputPerM:Number(process.env.DOCX_BENCH_INPUT_PER_M??5),outputPerM:Number(process.env.DOCX_BENCH_OUTPUT_PER_M??30),tokenValueUsd:0.00001};
  const measurement=await measure(await fs.readFile(path),targets,pricing,0);
  console.log(JSON.stringify(simulate(measurement,Number(process.env.DOCX_BENCH_OUTPUT_TOKENS??1024)),null,2));
})().catch(e=>{console.error(e.fileError||e.message);process.exitCode=1;});
module.exports={simulate};
