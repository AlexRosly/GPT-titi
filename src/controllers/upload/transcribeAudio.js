const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const { finished } = require("stream/promises");

let activeTranscriptions = 0;

const transcribeAudio = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Audio file is required (field: file)" });

  const baseURL = process.env.WHISPER_BASE_URL || "https://api.openai.com/v1";
  const apiKey = process.env.WHISPER_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.WHISPER_MODEL || (process.env.WHISPER_BASE_URL
    ? "Systran/faster-whisper-base"
    : "whisper-1");

  let acquired = false;
  let audio;
  try {
    if (!apiKey && !process.env.WHISPER_BASE_URL) {
      return res.status(503).json({ error: "Speech-to-text is not configured" });
    }

    const limit = Number(process.env.TRANSCRIPTION_MAX_CONCURRENT || 1);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      return res.status(503).json({ error: "Invalid transcription concurrency configuration" });
    }
    if (activeTranscriptions >= limit) {
      return res.status(429).json({ error: "Transcription is busy. Try again later." });
    }
    activeTranscriptions += 1;
    acquired = true;

    const client = new OpenAI({
      apiKey: apiKey || "speaches-local",
      baseURL,
      timeout: Number(process.env.WHISPER_TIMEOUT_MS || 300000),
      maxRetries: 0,
    });

    audio = fs.createReadStream(req.file.path);
    audio.name = path.basename(req.file.originalname || "audio");
    audio.type = req.file.mimetype || "application/octet-stream";
    const result = await client.audio.transcriptions.create({
      file: audio,
      model,
      ...(req.body.language ? { language: req.body.language } : {}),
      ...(req.body.prompt ? { prompt: req.body.prompt } : {}),
      response_format: "json",
    });

    return res.json({ text: result.text, model });
  } catch (err) {
    console.error("Audio transcription failed:", err.message);
    const status = err.status >= 400 && err.status < 500 ? err.status : 502;
    return res.status(status).json({ error: "Audio transcription failed" });
  } finally {
    if (audio) {
      audio.destroy();
      await finished(audio).catch(() => {});
    }
    await fs.promises.unlink(req.file.path).catch(() => {});
    if (acquired) activeTranscriptions -= 1;
  }
};

module.exports = transcribeAudio;
