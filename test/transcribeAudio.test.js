const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Transcriptions } = require("openai/resources/audio/transcriptions");
const transcribeAudio = require("../src/controllers/upload/transcribeAudio");

const configure = (t) => {
  const keys = ["WHISPER_BASE_URL", "WHISPER_API_KEY", "WHISPER_MODEL", "OPENAI_API_KEY", "TRANSCRIPTION_MAX_CONCURRENT"];
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) delete process.env[key];
  process.env.WHISPER_BASE_URL = "http://127.0.0.1:8000/v1";
  process.env.WHISPER_API_KEY = "test-placeholder";
  t.after(() => keys.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key];
    else process.env[key] = previous[i];
  }));
};

const request = async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gptiti-transcription-test-"));
  const filename = path.join(directory, "speech.wav");
  await fs.writeFile(filename, "audio fixture");
  t.after(async () => {
    await fs.unlink(filename).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await fs.rmdir(directory);
  });
  return { file: { path: filename, originalname: "speech.wav", mimetype: "audio/wav" }, body: {} };
};

const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const consume = async (file) => {
  const chunks = [];
  for await (const chunk of file) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "audio fixture");
};

test("local transcription uses base, forwards audio and options, and deletes the upload", async (t) => {
  configure(t);
  const req = await request(t);
  req.body = { language: "ru", prompt: "GPTiti" };
  t.mock.method(Transcriptions.prototype, "create", async (params) => {
    assert.equal(params.model, "Systran/faster-whisper-base");
    assert.equal(params.language, "ru");
    assert.equal(params.prompt, "GPTiti");
    await consume(params.file);
    return { text: "Привет" };
  });
  const res = response();
  await transcribeAudio(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.text, "Привет");
  await assert.rejects(fs.stat(req.file.path), { code: "ENOENT" });
});

test("a busy instance rejects a second transcription without invoking the provider", async (t) => {
  configure(t);
  const first = await request(t);
  const second = await request(t);
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  t.mock.method(Transcriptions.prototype, "create", async (params) => {
    calls += 1;
    await consume(params.file);
    enter();
    await waiting;
    return { text: "Done" };
  });
  const pending = transcribeAudio(first, response());
  try {
    await entered;
    const res = response();
    await transcribeAudio(second, res);
    assert.equal(res.statusCode, 429);
    assert.equal(calls, 1);
    await assert.rejects(fs.stat(second.file.path), { code: "ENOENT" });
  } finally {
    release();
    await pending;
  }
});

test("provider failure cleans up and frees the slot for another transcription", async (t) => {
  configure(t);
  let calls = 0;
  t.mock.method(console, "error", () => {});
  t.mock.method(Transcriptions.prototype, "create", async (params) => {
    await consume(params.file);
    if (++calls === 1) throw new Error("Provider unavailable");
    return { text: "Recovered" };
  });
  const first = await request(t);
  const failed = response();
  await transcribeAudio(first, failed);
  assert.equal(failed.statusCode, 502);
  await assert.rejects(fs.stat(first.file.path), { code: "ENOENT" });
  const recovered = response();
  await transcribeAudio(await request(t), recovered);
  assert.equal(recovered.statusCode, 200);
  assert.equal(calls, 2);
});

test("missing provider configuration returns 503 and deletes the upload", async (t) => {
  configure(t);
  delete process.env.WHISPER_BASE_URL;
  delete process.env.WHISPER_API_KEY;
  const req = await request(t);
  const res = response();
  await transcribeAudio(req, res);
  assert.equal(res.statusCode, 503);
  await assert.rejects(fs.stat(req.file.path), { code: "ENOENT" });
});

test("explicit model selection is preserved", async (t) => {
  configure(t);
  process.env.WHISPER_MODEL = "Systran/faster-whisper-tiny";
  t.mock.method(Transcriptions.prototype, "create", async (params) => {
    assert.equal(params.model, process.env.WHISPER_MODEL);
    await consume(params.file);
    return { text: "Done" };
  });
  const res = response();
  await transcribeAudio(await request(t), res);
  assert.equal(res.body.model, process.env.WHISPER_MODEL);
});
