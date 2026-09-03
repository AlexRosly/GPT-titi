const { ChatModels } = require("../../models");

const getChatModels = async (req, res) => {
  try {
    const models = await ChatModels.find(
      { enabled: true },
      {
        // modelId: 1,
        // label: 1,
        // category: 1,
        // default: 1,
        // supportsVision: 1,
        inputPerM: 0,
        outputPerM: 0,
        pricePerImage: 0,
        pricePerMinute: 0,
        pricePer1MChars: 0,
      },
    ).lean();

    res.status(200).json({
      success: true,
      chatModels: models,
    });
  } catch (error) {
    console.error("Error in controller getChatModels:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = getChatModels;
