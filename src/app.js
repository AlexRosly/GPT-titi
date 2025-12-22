const express = require("express");
const cookieParser = require("cookie-parser");
const pinoHttp = require("pino-http");
const logger = require("./utils/logger");
// const authRoutes = require("./routes/auth.routes");
// const userRoutes = require("./routes/user.routes");
const { errorMiddleware } = require("./middlewares");

const authRoutes = require("./routes/user");

const app = express();

app.use(pinoHttp({ logger }));
app.use(express.json());
app.use(cookieParser());

// app.use("/auth", authRoutes);
app.use("/users", authRoutes);

app.use(errorMiddleware);

module.exports = app;
