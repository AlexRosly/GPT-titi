const { Server } = require("socket.io");
const { logger } = require("./utils");
const { authSocketMiddleware } = require("./middlewares");
const registerChatDeliveryV2 = require("./controllers/ws/handlers/chatDeliveryV2");

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
  registerChatDeliveryV2(io);

  io.on("connection", (socket) => {
    logger.info({ protocolVersion: 2, socketId: socket.id, userId: socket.user._id }, "Socket connected");

    socket.emit("socket:connected", {
      event: "socket:connected",
      type: "response",
      payload: {
        message: "Connection established",
        socketId: socket.id,
        userId: socket.user._id,
      },
    });

    socket.on("disconnect", () => {
      logger.info({ protocolVersion: 2, socketId: socket.id, userId: socket.user._id }, "Socket disconnected");
    });
  });
}

module.exports = { initWsServer, getIo: () => io };
