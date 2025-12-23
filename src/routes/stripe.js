const { billing: ctrl } = require("../controllers");
// const { ctrlWrapper, authHotelier } = require("../../middlewares");
// const { joiSchema } = require("../../models/paymentMethod");

const express = require("express");
const router = express.Router();

router.post("/webhook", ctrlWrapper(ctrl.stripeWebhook));

module.exports = router;
