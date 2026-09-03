const { modelFlows: ctrl } = require("../controllers");
const { adminOnly } = require("../middlewares");

const express = require("express");
const router = express.Router();

router.get("/get-model-flows", ctrl.getModelFlows); //Google Login / Register
router.post("/add-new-model", adminOnly, ctrl.addNewModel);
router.patch("/update-model-flows/:id", adminOnly, ctrl.editModelFlows);
router.delete("/delete-model-flow/:id", adminOnly, ctrl.deleteModelFlows);

module.exports = router;
