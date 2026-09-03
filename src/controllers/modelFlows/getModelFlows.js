const { ModelFlows } = require("../../models");

const getModelFlows = async (req, res) => {
  try {
    const models = await ModelFlows.find().lean();

    if (!models) return res.status(400).json({ error: "models not found" });

    res.status(201).json({
      status: true,
      models,
    });
  } catch (error) {
    console.error("Error in controller getModelFlows:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = getModelFlows;
