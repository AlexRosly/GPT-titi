const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const transcribeAudio = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Audio file is required (field: file)" });

  const baseURL = process.env.WHISPER_BASE_URL || "https://api.openai.com/v1";
  const apiKey = process.env.WHISPER_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.WHISPER_MODEL || (process.env.WHISPER_BASE_URL
    ? "Systran/faster-whisper-large-v3-turbo"
    : "whisper-1");

  if (!apiKey && !process.env.WHISPER_BASE_URL) {
    return res.status(503).json({ error: "Speech-to-text is not configured" });
  }

  try {
    const client = new OpenAI({
      apiKey: apiKey || "speaches-local",
      baseURL,
      timeout: Number(process.env.WHISPER_TIMEOUT_MS || 120000),
      maxRetries: 1,
    });

    const audio = fs.createReadStream(req.file.path);
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
    await fs.promises.unlink(req.file.path).catch(() => {});
  }
};

module.exports = transcribeAudio;
