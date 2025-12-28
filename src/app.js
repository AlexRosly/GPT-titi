const express = require("express");
const cookieParser = require("cookie-parser");
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

app.use("/users", authRoutes);
app.use("/billing", billingRoutes);
app.use("/admin", adminRoutes);
app.use("/chat", chatRoutes);
app.use("/conversations", conversationsRoutes);

app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.use(errorMiddleware);

module.exports = app;
