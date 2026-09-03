const { Project } = require("../../models");

const getProjects = async (req, res) => {
  try {
    const projects = await Project.aggregate([
      {
        $match: {
          user: req.user._id,
          deleted: null,
        },
      },
      {
        $lookup: {
          from: "chatconversations",
          let: { projectId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ["$project", "$$projectId"],
                },
              },
            },
            {
              $group: {
                _id: null,
                conversationCount: { $sum: 1 },
                lastMessageAt: { $max: "$lastMessageAt" },
              },
            },
          ],
          as: "stats",
        },
      },
      {
        $addFields: {
          pinnedAt: {
            $ifNull: ["$pinnedAt", null],
          },
          conversationCount: {
            $ifNull: [
              {
                $arrayElemAt: ["$stats.conversationCount", 0],
              },
              0,
            ],
          },
          lastMessageAt: {
            $arrayElemAt: ["$stats.lastMessageAt", 0],
          },
        },
      },
      {
        $project: {
          stats: 0,
        },
      },
      {
        $sort: {
          pinnedAt: -1,
          lastMessageAt: -1,
          updatedAt: -1,
          _id: -1,
        },
      },
    ]);

    res.json(projects);
  } catch (err) {
    console.error("Error in controller getProjects:", err);

    res.status(500).json({
      message: "Cannot get projects",
    });
  }
};

module.exports = getProjects;
