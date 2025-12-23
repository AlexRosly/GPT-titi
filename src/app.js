const express = require("express");
const cookieParser = require("cookie-parser");
const pinoHttp = require("pino-http");
const logger = require("./utils/logger");
const { errorMiddleware } = require("./middlewares");

const authRoutes = require("./routes/user");
const billingRoutes = require("./routes/billing");

const app = express();

app.use(pinoHttp({ logger }));

app.use("/api/webhook", express.raw({ type: "application/json" }));

app.use(express.json());
app.use(cookieParser());

app.use("/users", authRoutes);
app.use("/billing", billingRoutes);

app.use(errorMiddleware);

module.exports = app;
