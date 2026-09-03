const { ModelFlows } = require("../../models");

const editModelFlows = async (req, res) => {
  try {
    const { id } = req.params;
    const models = await ModelFlows.findOneAndUpdate(
      { _id: id },
      { ...req.body },
      { new: true },
    );
    if (!models) {
      return res.status(404).json({ error: "modelFlows not found" });
    }

    res.status(201).json({ success: true, models });
  } catch (error) {
    console.error("Error in controller editModelFlows:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = editModelFlows;
