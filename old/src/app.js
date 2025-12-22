// const express = require("express");
// const logger = require("morgan");
// // const cors = require("cors");
// const mongoose = require("mongoose");
// const dotenv = require("dotenv");
// dotenv.config();

// // Connection URL
// // const url = 'mongodb://localhost:27017';
// // const client = new MongoClient(url);
// // Database Name
// // const dbName = "Blog-YourPriceBooking";
// // DB_SERVER = mongodb://127.0.0.1:27017/Blog-YourPriceBooking

// // const swaggerUi = require("swagger-ui-express");
// // const swaggerDocument = require("./swagger.json");
// const { DB_HOST, DB_SERVER, APP_PORT = 7000 } = process.env;

// // const postRouter = require("./routes/post");
// // const authorRouter = require("./routes/author");
// // const countryRouter = require("./routes/country");

// const app = express();
// const formatsLogger = app.get("env") === "development" ? "dev" : "short";

// app.use(logger(formatsLogger));
// // app
// //   .use
// //   cors({
// //     origin: [
// //       "https://admin2-alpha.vercel.app",
// //       "http://localhost:3000",
// //       "https://www.thewandered.com",
// //     ],
// //     credentials: true,
// //   })
// //   ();
// app.use(express.json());

// // app.use("/blog/api/post", postRouter);
// // app.use("/blog/api/author", authorRouter);
// // app.use("/blog/api/country", countryRouter);

// // app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// app.use((req, res) => {
//   res.status(404).json({ message: "Not found" });
// });

// app.use((err, req, res, next) => {
//   const { status = 500, message = "Server error" } = err;
//   res.status(status).json({ message: err.message });
// });

// mongoose.set("strictQuery", false);

// mongoose
//   .connect(DB_HOST)
//   //.connect(DB_SERVER)
//   .then(() =>
//     app.listen(APP_PORT, () => {
//       console.log(
//         `server is running in port ${APP_PORT} and Database connection successful`
//       );
//     })
//   )
//   .catch((error) => {
//     console.log(error.message);
//     console.log("DB don't connect");
//     process.exit(1);
//   });

const express = require("express");
// const cookieParser = require("cookie-parser");
// const authRoutes = require("./routes/auth.routes");
// const userRoutes = require("./routes/user.routes");
const errorMiddleware = require("./middlewares/error.middleware");
require("./config/db"); // init DB

const app = express();

app.use(express.json());
// app.use(cookieParser());

// routes
// app.use("/auth", authRoutes);
// app.use("/users", userRoutes);

// error handler
app.use(errorMiddleware);

module.exports = app;
