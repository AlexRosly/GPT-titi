const { Server } = require("socket.io");
const { logger } = require("./utils");
let io; 

function initWsServer(server) {
  io = new Server(server, {
    cors: {
      origin: process.env.SOCKET_CORS_ORIGINS
        ? process.env.SOCKET_CORS_ORIGINS.split(",").map((s) => s.trim())
        : [
            "http://localhost:3000",
            "https://www.gptiti.com",
            "http://localhost:5500",
            "http://127.0.0.1:5500",
            "https://ypbooking.chost.com.ua",
          ],
      credentials: process.env.SOCKET_CREDENTIALS === "false" ? false : true,
    },
  });

  io.on("connection", (socket) => {
    logger.info("Socket connected: " + socket.id);
    // Приклад обробки повідомлення від клієнта через WebSocket
      socket.on("ws:message", (msg) => {
        // msg.event, msg.type, msg.requestId, msg.payload
        if (msg.event === "test-ws-front") {
          setTimeout(() => {
            const response = {
              event: "test-ws-back",
              type: "test-reply",
              requestId: msg.requestId,
              payload: { message: "Ответ с сервера через 3 секунды", echo: msg },
            };
            socket.emit("ws:message", response);
          }, 3000);
        }
      });
// Кінець прикладу обробки повідомлення від клієнта через WebSocket
      socket.on("disconnect", () => {
        logger.info("Socket disconnected: " + socket.id);
      });
  });
}

module.exports = { initWsServer, getIo: () => io };