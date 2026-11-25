module.exports = async function* sourceSelectionStream(urls, usage) {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'select1', type: 'function',
    function: { name: 'read_supplied_pages', arguments: JSON.stringify({ urls }) } }] }, finish_reason: 'tool_calls' }] };
  yield { choices: [], usage };
};
