// controllers/admin/getModels.js
const { ChatModel } = require("../../models");

const getModels = async (req, res) => {
  const models = await ChatModel.find().lean();
  res.json(models);
};

module.exports = getModels;
