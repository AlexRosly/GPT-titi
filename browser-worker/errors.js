// Shared wire contract: only fixed categories cross the browser boundary.
const reasons = new Set(['ACTION_TIMEOUT','NAVIGATION_FAILED','PAGE_CLOSED','PAGE_CRASHED',
  'EXECUTION_CONTEXT_LOST','ACTION_BLOCKED','HTTP_ACCESS_DENIED','HTTP_ERROR',
  'RESOURCE_LIMIT','NETWORK_POLICY_BLOCKED','UNSUPPORTED_DOCUMENT','WORKER_FAILURE','SESSION_TIMEOUT','PROCESS_EXIT','SPAWN_FAILED','STDIN_ERROR',
  'PROTOCOL_ERROR','RESPONSE_INVALID','RESPONSE_TOO_LARGE','ABORTED']);
const stages = new Set(['launch','navigate','interact','observe','screenshot','session']);
function category(error) {
  if (reasons.has(error?.browserReason)) return error.browserReason;
  const message = String(error?.message || '');
  const network = {
    BROWSER_LIMIT:'RESOURCE_LIMIT', WEB_PAGE_TOO_LARGE:'RESOURCE_LIMIT',
    BROWSER_ACTION_BLOCKED:'NETWORK_POLICY_BLOCKED', WEB_BLOCKED_ADDRESS:'NETWORK_POLICY_BLOCKED',
    WEB_ACCESS_DENIED:'HTTP_ACCESS_DENIED', WEB_UNSUPPORTED_TYPE:'UNSUPPORTED_DOCUMENT',
    WEB_TIMEOUT:'ACTION_TIMEOUT', BROWSER_TIMEOUT:'ACTION_TIMEOUT'
  };
  if (Object.hasOwn(network,message)) return network[message];
  if (error?.name === 'TimeoutError' || /timeout/i.test(message)) return 'ACTION_TIMEOUT';
  if (/page crashed/i.test(message)) return 'PAGE_CRASHED';
  if (/closed|disconnected/i.test(message)) return 'PAGE_CLOSED';
  if (/Execution context was destroyed|Cannot find context/i.test(message)) return 'EXECUTION_CONTEXT_LOST';
  if (/net::ERR_|Navigation failed|Download is starting/i.test(message)) return 'NAVIGATION_FAILED';
  return 'WORKER_FAILURE';
}
function safe(value) {
  return { reason: reasons.has(value?.reason) ? value.reason : 'WORKER_FAILURE',
    stage: stages.has(value?.stage) ? value.stage : 'session' };
}
function code(reason) {
  if (['ACTION_TIMEOUT','SESSION_TIMEOUT'].includes(reason)) return 'BROWSER_TIMEOUT';
  if (reason === 'RESOURCE_LIMIT') return 'BROWSER_LIMIT';
  if (reason === 'NETWORK_POLICY_BLOCKED') return 'BROWSER_ACTION_BLOCKED';
  if (reason === 'UNSUPPORTED_DOCUMENT') return 'WEB_UNSUPPORTED_TYPE';
  if (['NAVIGATION_FAILED','HTTP_ERROR','HTTP_ACCESS_DENIED'].includes(reason)) return 'BROWSER_NAVIGATION_FAILED';
  return 'BROWSER_UNAVAILABLE';
}
module.exports = { category, safe, code };
