const dotenvResult = require("dotenv").config();
const app = require("./src/app");
const { logger } = require("./src/utils");
const connectDB = require("./src/config/db");
const http = require("http");
const { getIo, initWsServer } = require("./src/wsServer");
const { startBalanceSync } = require("./src/services/balanceOutbox");
// const registerChatHandlers = require("./src/controllers/ws/handlers/chatSocket");

const PORT = process.env.PORT || 7000;
const server = http.createServer(app);

// Report the running process's configuration without printing credentials.
const whisperEnvKeys = [
  "WHISPER_BASE_URL",
  "WHISPER_MODEL",
  "WHISPER_TIMEOUT_MS",
  "TRANSCRIPTION_MAX_CONCURRENT",
  "TRANSCRIPTION_MAX_FILE_SIZE",
];
let whisperEndpoint = null;
if (process.env.WHISPER_BASE_URL) {
  try {
    const url = new URL(process.env.WHISPER_BASE_URL);
    whisperEndpoint = url.origin + url.pathname;
  } catch {
    whisperEndpoint = "INVALID_URL";
  }
}
logger.info({
  cwd: process.cwd(),
  envFileLoaded: !dotenvResult.error,
  whisper: {
    baseURL: whisperEndpoint,
    model: process.env.WHISPER_MODEL || null,
    timeoutMs: process.env.WHISPER_TIMEOUT_MS || null,
    maxConcurrent: process.env.TRANSCRIPTION_MAX_CONCURRENT || null,
    maxFileSize: process.env.TRANSCRIPTION_MAX_FILE_SIZE || null,
    apiKeyConfigured: Boolean(process.env.WHISPER_API_KEY),
  },
  differentFromDotEnv: whisperEnvKeys.filter((key) =>
    dotenvResult.parsed?.[key] !== undefined &&
    process.env[key] !== dotenvResult.parsed[key]),
}, "Whisper environment at startup");

connectDB()
  .then(async () => {
    require('./src/services/files/preparationQueue').start();
    initWsServer(server);
    await startBalanceSync(getIo());
    server.listen(PORT, () => {
      logger.info("Server started on port " + PORT);
    });

    // Приклад періодичної відправки повідомлення всім клієнтам через WebSocket
    setInterval(() => {
      getIo().emit("ws:message", {
        event: "test-ws-back",
        type: "notify",
        requestId: "system-" + Date.now(),
        payload: { message: "Важное уведомление для всех клиентов!" },
      });
    }, 25000);

    // const io = getIo();
    // registerChatHandlers(io);

    // кінець прикладу перідичної відправки повідомлення через вебсокет
    // Приклад відправки повідомлення всім клієнтам через WebSocket при старті сервера
    // getIo().emit("ws:message", {
    //   event: "test-ws-back",
    //   type: "notify",
    //   requestId: "system-" + Date.now(),
    //   payload: { message: "Важное уведомление для всех клиентов7777!" },
    // });
    // кінець прикладу відправки повідомлення через вебсокет при старті сервера
  })
  .catch((err) => {
    logger.error("Failed to start", err);
    process.exit(1);
  });
