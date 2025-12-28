const { billing: ctrl } = require("../controllers");
const { auth } = require("../middlewares");

const express = require("express");
const router = express.Router();

router.get("/prices", ctrl.getPrices); // without auth
router.post("/checkout", auth, ctrl.createCheckout);
router.post("/webhook", ctrlWrapper(ctrl.stripeWebhook)); // without auth

module.exports = router;
