// models/Project.js

const { Schema, model } = require("mongoose");

const ProjectSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: true,
      index: true,
    },

    title: {
      type: String,
      required: true,
      default: "New project",
      trim: true,
      maxlength: 120,
    },

    description: {
      type: String,
      default: "",
      maxlength: 1000,
    },

    icon: {
      type: String,
      default: "folder",
    },

    color: {
      type: String,
      default: "#3B82F6",
    },

    defaultModel: {
      type: String,
      default: "gpt-5.5",
    },

    systemPrompt: {
      type: String,
      default: "",
      maxlength: 15000,
    },

    archived: {
      type: Boolean,
      default: false,
      index: true,
    },

    pinnedAt: {
      type: Date,
      default: null,
      index: true,
    },

    deleted: {
      type: Date,
      default: null,
      index: true,
    },

    lastActivityAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

ProjectSchema.index({
  user: 1,
  deleted: 1,
  archived: 1,
});

ProjectSchema.index({
  user: 1,
  deleted: 1,
  pinnedAt: -1,
  lastActivityAt: -1,
  _id: -1,
});

module.exports = model("project", ProjectSchema);
