// routes/debug.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const ChatConversation = require("../models/chatConversation");

router.post("/driver-set-project", async (req, res) => {
  try {
    const id = new mongoose.Types.ObjectId("69fdee01dc1da69237d96523");
    const projectId = new mongoose.Types.ObjectId("6a43e858e7fbfa0862977dc7");

    const before = await ChatConversation.findById(id).lean();
    console.log("DRIVER BEFORE:", before);

    const result = await mongoose.connection.db
      .collection("chatconversations")
      .updateOne({ _id: id }, { $set: { project: projectId } });
    console.log("DRIVER updateOne result:", result);

    const after = await ChatConversation.findById(id).lean();
    console.log("DRIVER AFTER:", after);

    return res.json({ before, result, after });
  } catch (e) {
    console.error("DRIVER ERROR:", e);
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
