const { ModelFlows } = require("../../models");

const addNewModel = async (req, res) => {
  try {
    const createModel = await ModelFlows.create(req.body);

    if (!createModel) return res.status(400).json({ error: "model not added" });

    res.status(200).json({
      status: true,
      createModel,
    });
  } catch (error) {
    console.error("Error in controller addNewModel:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = addNewModel;
