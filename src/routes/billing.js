const { billing: ctrl } = require("../controllers");
const { auth } = require("../middlewares");

const express = require("express");
const router = express.Router();

router.post("/checkout", auth, ctrl.createCheckout);
router.get("/payments", auth, ctrl.getPaymentsHistory);
router.get("/prices", auth, ctrl.getBillingPrices);

module.exports = router;
