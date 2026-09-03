const cloudinary = require("../config/cloudinary");

const { ChatMessage } = require("../models");

const getCloudinaryResourceType = require("../utils/getCloudinaryResourceType");

const cleanupExpiredUploads = async () => {
  const now = new Date();

  const messages = await ChatMessage.find({
    "attachments.expiresAt": {
      $lt: now,
    },
  });

  for (const msg of messages) {
    for (const file of msg.attachments) {
      if (file.deletedAt || !file.publicId) {
        continue;
      }

      try {
        await cloudinary.uploader.destroy(file.publicId, {
          resource_type: getCloudinaryResourceType(file.mimetype),
        });

        file.deletedAt = new Date();
      } catch (err) {
        console.error(err);
      }
    }

    await msg.save();
  }
};

module.exports = cleanupExpiredUploads;
