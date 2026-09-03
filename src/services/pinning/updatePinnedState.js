const mongoose = require("mongoose");
const { buildPinnedAtExpression } = require("./pinningRules");

const updatePinnedState = async ({
  Model,
  resourceId,
  userId,
  pinned,
  extraFilter = {},
}) => {
  if (!mongoose.Types.ObjectId.isValid(resourceId)) {
    const error = new Error("INVALID_RESOURCE_ID");
    error.code = "INVALID_RESOURCE_ID";
    throw error;
  }

  if (typeof pinned !== "boolean") {
    const error = new Error("INVALID_PINNED_VALUE");
    error.code = "INVALID_PINNED_VALUE";
    throw error;
  }

  return Model.findOneAndUpdate(
    {
      _id: resourceId,
      user: userId,
      ...extraFilter,
    },
    [
      {
        $set: {
          pinnedAt: buildPinnedAtExpression(pinned),
        },
      },
    ],
    {
      new: true,
    },
  );
};

module.exports = updatePinnedState;
