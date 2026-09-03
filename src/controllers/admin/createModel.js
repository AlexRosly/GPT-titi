// controllers/admin/createModel.js
const { ChatModels } = require("../../models");

const createModel = async (req, res) => {
  try {
    const model = await ChatModels.create(req.body);
    res.status(201).json(model);
  } catch (error) {
    console.error("Error in controller createModel:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = createModel;
