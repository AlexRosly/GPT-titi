// Track failures at the provider boundary, including lazy async iterators.
// Local processing errors must never be mistaken for a free HTTP rejection.
async function* trackProviderStream(create, progress) {
  progress.rejectedBeforeOutput = false;
  let started = false;
  try {
    const stream = await create();
    for await (const chunk of stream) {
      started = true;
      yield chunk;
    }
  } catch (error) {
    progress.rejectedBeforeOutput = !started;
    throw error;
  }
}
module.exports = { trackProviderStream };
