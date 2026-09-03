const { User, Message } = require("../../../models");
// const openai = require("../../services/openai");

const registerChatHandlers = (io) => {
  io.on("connection", (socket) => {
    // 💬 SEND MESSAGE
    socket.on("chat:send", async ({ message, conversationId }) => {
      try {
        const user = socket.user;
        console.log({ user });

        if (!message) {
          return socket.emit("chat:error", {
            event: "error",
            type: "response",
            message: "Empty message",
            payload: { result: "ok" },
          });
        }

        const dbUser = await User.findById(user._id);

        if (!dbUser || dbUser.appTokens <= 0) {
          return socket.emit("chat:error", {
            event: "error",
            type: "response",
            message: "Not enough tokens",
            payload: { result: "ok" },
          });
        }

        // 💾 сохраняем сообщение пользователя
        const userMessage = await Message.create({
          conversationId,
          role: "user",
          content: message,
          userId: user._id,
        });

        socket.emit("chat:message", {
          event: "success",
          type: "response",
          payload: { result: "ok", message: userMessage },
        });

        // 📚 история
        const messages = await Message.find({ conversationId }).sort({
          createdAt: 1,
        });

        const formattedMessages = messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        // 🤖 STREAM
        const stream = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: formattedMessages,
          stream: true,
        });

        let fullText = "";

        for await (const chunk of stream) {
          const text = chunk.choices?.[0]?.delta?.content || "";

          if (text) {
            fullText += text;

            socket.emit("chat:stream", {
              event: "success",
              type: "response",
              payload: { result: "ok", chunk: text },
            });
          }
        }

        // 💾 сохраняем ответ
        const aiMessage = await Message.create({
          conversationId,
          role: "assistant",
          content: fullText,
          userId: user._id,
        });

        // 💰 списание токенов
        dbUser.appTokens -= Math.ceil(fullText.length / 4);
        await dbUser.save();

        socket.emit("chat:end", {
          event: "success",
          type: "response",
          payload: { result: "ok", message: aiMessage },
        });
      } catch (err) {
        console.error("chat:send error:", {
          event: "error",
          type: "response",
          payload: { result: "ok", message: err },
        });

        socket.emit("chat:error", {
          event: "error",
          type: "response",
          payload: { result: "ok", message: "Internal server error" },
        });
      }
    });
  });
};

module.exports = registerChatHandlers;
