const { ModelFlows } = require("../../models");

const deleteModelFlows = async (req, res) => {
  try {
    const { id } = req.params;

    const models = await ModelFlows.findOneAndUpdate(
      { _id: id },
      { archived: true },
      { new: true },
    );

    if (!models) {
      return res.status(400).json({ error: "modelFlows not found" });
    }

    res.status(201).json({ success: true });
  } catch (error) {
    console.error("Error in controller deleteModelFlows:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = deleteModelFlows;
