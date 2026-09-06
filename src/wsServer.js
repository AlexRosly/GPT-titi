const { Server } = require("socket.io");
const { logger } = require("./utils");
const { authSocketMiddleware } = require("./middlewares");
const { runChat } = require("./services");
const registerChatDeliveryV2 = require("./controllers/ws/handlers/chatDeliveryV2");

let io;

function initWsServer(server, options = {}) {
  const runChatImpl = options.runChat || runChat;
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

  io.use(authSocketMiddleware);
  registerChatDeliveryV2(io);

  io.on("connection", (socket) => {
    logger.info({ protocolVersion: 1, socketId: socket.id, userId: socket.user._id }, "Socket connected");

    socket.emit("socket:connected", {
      event: "socket:connected",
      type: "response",
      payload: {
        message: "Connection established",
        socketId: socket.id,
        userId: socket.user._id,
      },
    });

    // Legacy v1 path. Kept for compatibility until frontend v2 is fully deployed.
    socket.on("chat:send", async ({ payload, event, type }) => {
      if (type === "request" && event === "chat:send" && payload?.clientMessageId) return;

      const { conversationId, modelId, message, files } = payload || {};
      try {
        const result = await runChatImpl({
          userId: socket.user._id,
          conversationId,
          modelId,
          message,
          files,
          onChunk: (chunk) => {
            socket.emit("chat:stream", {
              event: "chat:stream",
              type: "response",
              chunk,
            });
          },
        });

        socket.emit("chat:end", {
          event: "chat:end",
          type: "response",
          messages: "chat ended",
          payload: result.billing,
        });
      } catch (err) {
        console.error("SOCKET CHAT ERROR:", err);
        socket.emit("chat:error", { message: "Chat request failed." });
        if (err.status === 503) {
          socket.emit("chat_error", {
            message: "Сервис ИИ временно недоступен. Попробуйте повторить запрос через пару секунд.",
          });
        } else {
          socket.emit("chat_error", { message: "Произошла ошибка при обработке запроса." });
        }
      }
    });

    socket.on("disconnect", () => {
      logger.info({ protocolVersion: 1, socketId: socket.id, userId: socket.user._id }, "Socket disconnected");
    });
  });
}

module.exports = { initWsServer, getIo: () => io };
