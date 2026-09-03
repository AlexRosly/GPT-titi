const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const pinoHttp = require("pino-http");
const logger = require("./utils/logger");
const { errorMiddleware } = require("./middlewares");
const path = require("path");
const cron = require("node-cron");
const cleanupExpiredUploads = require("./services/cleanupExpiredUploads");

const authRoutes = require("./routes/user");
const billingRoutes = require("./routes/billing");
const adminRoutes = require("./routes/admin");
const chatRoutes = require("./routes/chat");
const conversationsRoutes = require("./routes/chatConversations");
const uploadRoutes = require("./routes/upload");
const modelFlowsRoutes = require("./routes/modelFlows");
const projectRoutes = require("./routes/project");
const debugRoutes = require("./routes/debug");

const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");

const swaggerDocument = YAML.load("./swagger.yaml");

const app = express();
cron.schedule("0 * * * *", async () => {
  console.log("Running uploads cleanup...");

  await cleanupExpiredUploads();
});

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
      "https://gp-titi-test.vercel.app",
    ],
    credentials: true,
  }),
);

app.use("/gpt-titi/api/users", authRoutes);
app.use("/gpt-titi/api/billing", billingRoutes);
app.use("/gpt-titi/api/admin", adminRoutes);
app.use("/gpt-titi/api/chat", chatRoutes);
app.use("/gpt-titi/api/conversations", conversationsRoutes);
app.use("/gpt-titi/api/upload", uploadRoutes);
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));
app.use("/gpt-titi/api/model-flows", modelFlowsRoutes);
app.use("/gpt-titi/api/project", projectRoutes);
app.use("/gpt-titi/api/debug", debugRoutes);

app.use(
  "/gpt-titi/api/gpt-titi/api/docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerDocument),
);

app.use(errorMiddleware);

module.exports = app;
