require("dotenv").config();
const app = require("./src/app");
const { logger } = require("./src/utils");
const connectDB = require("./src/config/db");
const http = require("http");
const { getIo, initWsServer } = require("./src/wsServer");

const PORT = process.env.PORT || 7000;
const server = http.createServer(app);

connectDB()
  .then(() => {
    initWsServer(server);
    server.listen(PORT, () => {
      logger.info("Server started on port " + PORT);
    });

    // Приклад періодичної відправки повідомлення всім клієнтам через WebSocket
    setInterval(() => {
      getIo().emit("ws:message", {
        event: "test-ws-back",
        type: "notify",
        requestId: "system-" + Date.now(),
        payload: { message: "Важное уведомление для всех клиентов!" }
      });
    }, 5000);

    // кінець прикладу перідичної відправки повідомлення через вебсокет
    // Приклад відправки повідомлення всім клієнтам через WebSocket при старті сервера
    getIo().emit("ws:message", {
        event: "test-ws-back",
        type: "notify",
        requestId: "system-" + Date.now(),
        payload: { message: "Важное уведомление для всех клиентов!" }
    });
    // кінець прикладу відправки повідомлення через вебсокет при старті сервера
  })
  .catch((err) => {
    logger.error("Failed to start", err);
    process.exit(1);
  });
