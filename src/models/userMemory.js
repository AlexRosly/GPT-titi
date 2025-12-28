const { Schema, model } = require("mongoose");

const UserMemorySchema = Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "user",
      index: true,
      unique: true,
    },

    summary: {
      type: String,
      default: "",
    },

    facts: [
      {
        key: String,
        value: String,
      },
    ],
  },
  { timestamps: true, versionKey: false }
);

const UserMemory = model("userMemory", UserMemorySchema);

module.exports = UserMemory;
