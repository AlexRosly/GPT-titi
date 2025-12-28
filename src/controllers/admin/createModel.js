// controllers/admin/createModel.js
const { ChatModel } = require("../../models");

const createModel = async (req, res) => {
  const model = await ChatModel.create(req.body);
  res.status(201).json(model);
};

module.exports = createModel;
