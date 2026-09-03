const express = require("express");
const { billing: ctrl } = require("../controllers");

const router = express.Router();

// Stripe sends the request body as a signed raw payload.
// This route must be mounted under /webhook/stripe before express.json().
router.post("/", ctrl.stripeWebhook);

module.exports = router;
