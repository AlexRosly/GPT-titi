const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const pinoHttp = require("pino-http");
const logger = require("./utils/logger");
const { errorMiddleware } = require("./middlewares");

const authRoutes = require("./routes/user");
const billingRoutes = require("./routes/billing");
const adminRoutes = require("./routes/admin");
const chatRoutes = require("./routes/chat");
const conversationsRoutes = require("./routes/chatConversations");

const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");

const swaggerDocument = YAML.load("./swagger.yaml");

const app = express();

app.use(pinoHttp({ logger }));
app.use("/webhook", express.raw({ type: "application/json" }));

app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://www.gptiti.com",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "https://ypbooking.chost.com.ua",
    ],
    credentials: true,
  })
);

app.use("/gpt-titi/api/users", authRoutes);
app.use("/gpt-titi/api/billing", billingRoutes);
app.use("/gpt-titi/api/admin", adminRoutes);
app.use("/gpt-titi/api/chat", chatRoutes);
app.use("/gpt-titi/api/conversations", conversationsRoutes);

app.use(
  "/gpt-titi/api/docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerDocument)
);

app.use(errorMiddleware);

module.exports = app;
