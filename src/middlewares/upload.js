// const multer = require("multer");
// const path = require("path");
// const fs = require("fs");

// // const uploadDir = path.join(process.cwd(), "uploads");
// const uploadDir = path.join(__dirname, "../../uploads");

// if (!fs.existsSync(uploadDir)) {
//   fs.mkdirSync(uploadDir, { recursive: true });
// }

// const storage = multer.diskStorage({
//   destination: (_, __, cb) => {
//     cb(null, uploadDir);
//   },

//   filename: (_, file, cb) => {
//     const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);

//     cb(null, unique + path.extname(file.originalname));
//   },
// });

// const fileFilter = (_, file, cb) => {
//   cb(null, true);
// };

// const upload = multer({
//   storage,
//   fileFilter,

//   limits: {
//     fileSize: 20 * 1024 * 1024, // 20MB
//   },
// });

// module.exports = upload;
// const multer = require("multer");
// const path = require("path");
// const fs = require("fs");

// const uploadDir = path.join(__dirname, "../../uploads");

// if (!fs.existsSync(uploadDir)) {
//   fs.mkdirSync(uploadDir, { recursive: true });
// }

// const storage = multer.diskStorage({
//   destination: (req, file, cb) => {
//     cb(null, uploadDir);
//   },

//   filename: (req, file, cb) => {
//     const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);

//     cb(null, unique + path.extname(file.originalname));
//   },
// });

// const upload = multer({
//   storage,
//   limits: {
//     fileSize: 25 * 1024 * 1024,
//   },
// });

// module.exports = upload;
const multer = require("multer");

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

module.exports = upload;
