const { spawnSync } = require('node:child_process');
const uri = process.env.FILES_TEST_MONGO_URI;
if (!uri || !/\/gptiti_files_test_[a-zA-Z0-9_-]+(?:\?|$)/.test(uri)) {
  console.error('Set FILES_TEST_MONGO_URI to a dedicated replica-set database named gptiti_files_test_*. Tests delete that database. Never use production.');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1',
  'test/files/storage.integration.test.js', 'test/files/http.integration.test.js', 'test/files/worker.integration.test.js'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
