const { Schema, model } = require("mongoose");

const FileSchema = Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: true,
      index: true,
    },

    originalName: {
      type: String,
      required: true,
    },

    filename: {
      type: String,
      required: true,
    },

    mimeType: {
      type: String,
      required: true,
    },

    size: {
      type: Number,
      required: true,
    },

    path: {
      type: String,
      required: true,
    },

    url: {
      type: String,
      required: true,
    },

    type: {
      type: String,
      enum: ["image", "audio", "video", "document", "other"],
      default: "other",
    },
  },
  { versionKey: false, timestamps: true },
);

const FileModels = model("FileModels", FileSchema);

module.exports = FileModels;
