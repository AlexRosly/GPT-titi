const { Server } = require("socket.io");
const { logger } = require("./utils");
const { authSocketMiddleware } = require("./middlewares");
const { runChat } = require("./services");
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

  io.use(authSocketMiddleware);

  // io.on("connection", (socket) => {
  //   console.log("🟢 Socket connected:", socket.user._id);

  //   socket.on("disconnect", () => {
  //     console.log("🔴 Socket disconnected:", socket.user._id);
  //   });
  // });

  io.on("connection", (socket) => {
    logger.info("Socket connected: " + socket.id);
    socket.emit("socket:connected", {
      event: "socket-connected",
      type: "response",
      payload: {
        message: "Connection established",
        socketId: socket.id,
        userId: socket.user._id,
      },
    });
    // Приклад обробки повідомлення від клієнта через WebSocket
    // socket.on("wrs:message", (msg) => {
    //   // msg.event, msg.type, msg.requestId, msg.payload
    //   if (msg.event === "test-ws-front") {
    //     console.log({ msg });
    //     setTimeout(() => {
    // const response = {
    //   event: "test-ws-back",
    //   type: "test-reply",
    //   requestId: msg.requestId,
    //   payload: { message: "Ответ с сервера через 3 секунды", echo: msg },
    // };
    //       socket.emit("ws:message", response);
    //     }, 3000);
    //   }
    // });
    socket.on("chat:send", async ({ payload, event, type }) => {
      const { conversationId, modelId, message, files } = payload;

      try {
        const result = await runChat({
          userId: socket.user._id,
          conversationId,
          modelId,
          message,
          files,
          onChunk: (chunk) => {
            socket.emit("chat:stream", {
              event: "chat-stream",
              type: "response",
              chunk,
            });
          },
        });
        socket.emit("chat:end", {
          event: "chat-end",
          type: "response",
          messages: "chat ended",
          // payload: {
          //   usage: result.usage,
          payload: result.billing,
          // },
        });
      } catch (err) {
        console.error("SOCKET CHAT ERROR:", err);
        socket.emit("chat:error", { message: err.message });
        if (err.status === 503) {
          socket.emit("chat_error", {
            message:
              "Сервис ИИ временно недоступен. Попробуйте повторить запрос через пару секунд.",
          });
        } else {
          socket.emit("chat_error", {
            message: "Произошла ошибка при обработке запроса.",
          });
        }
      }
    });
    // Кінець прикладу обробки повідомлення від клієнта через WebSocket
    socket.on("disconnect", () => {
      logger.info("Socket disconnected: " + socket.id);
    });
  });
}

module.exports = { initWsServer, getIo: () => io };
