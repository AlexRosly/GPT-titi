const { billing: ctrl } = require("../controllers");
const auth = require("../middlewares/auth");

const express = require("express");
const router = express.Router();

router.post("/checkout", auth, ctrl.createCheckout);
router.get("/payments", auth, ctrl.getPaymentsHistory);

module.exports = router;
