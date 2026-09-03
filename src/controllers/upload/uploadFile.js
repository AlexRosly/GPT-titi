// // const path = require("path");
// // const { File } = require("../../models");

// // const getFileType = (mime) => {
// //   if (mime.startsWith("image/")) return "image";
// //   if (mime.startsWith("audio/")) return "audio";
// //   if (mime.startsWith("video/")) return "video";

// //   if (
// //     mime.includes("pdf") ||
// //     mime.includes("document") ||
// //     mime.includes("text")
// //   ) {
// //     return "document";
// //   }

// //   return "other";
// // };

// // const uploadFile = async (req, res) => {
// //   try {
// //     if (!req.file) {
// //       return res.status(400).json({
// //         error: "No file uploaded",
// //       });
// //     }

// //     const file = req.file;

// //     const savedFile = await File.create({
// //       user: req.user._id,

// //       originalName: file.originalname,
// //       filename: file.filename,

// //       mimeType: file.mimetype,
// //       size: file.size,

// //       path: file.path,

// //       url: `/uploads/${file.filename}`,

// //       type: getFileType(file.mimetype),
// //     });

// //     res.json({
// //       success: true,
// //       file: savedFile,
// //     });
// //   } catch (err) {
// //     console.error("UPLOAD ERROR:", err);

// //     res.status(500).json({
// //       error: "Upload failed",
// //     });
// //   }
// // };

// // module.exports = uploadFile;

// const path = require("path");

// const uploadFile = async (req, res) => {
//   try {
//     console.log("FILE:", req.file);

//     if (!req.file) {
//       return res.status(400).json({
//         error: "File not provided",
//       });
//     }

//     return res.json({
//       success: true,

//       file: {
//         filename: req.file.filename,
//         originalName: req.file.originalname,
//         mimetype: req.file.mimetype,
//         size: req.file.size,

//         url: "/uploads/" + req.file.filename,
//       },
//     });
//   } catch (err) {
//     console.error("UPLOAD ERROR:", err);

//     return res.status(500).json({
//       error: "Upload failed",
//     });
//   }
// };

// module.exports = uploadFile;
// const { File } = require("../../models");
const cloudinary = require("../../config/cloudinary");
const streamifier = require("streamifier");
const { getCloudinaryResourceType } = require("../../utils");

const uploadFile = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "No file",
      });
    }

    const fileType = getCloudinaryResourceType(req.file.mimetype);

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "gpt-titi",
          resource_type: fileType || "auto",
        },
        (err, result) => {
          if (err) reject(err);
          else resolve(result);
        },
      );

      streamifier.createReadStream(req.file.buffer).pipe(stream);
    });

    return res.json({
      success: true,

      file: {
        url: result.secure_url,
        publicId: result.public_id,
        mimetype: req.file.mimetype,
        size: req.file.size,
        originalName: req.file.originalname,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      error: "Upload failed",
    });
  }
};

module.exports = uploadFile;
