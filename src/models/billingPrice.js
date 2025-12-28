// models/BillingPrice.js
const { Schema, model } = require("mongoose");

const BillingPriceSchema = Schema(
  {
    stripePriceId: String,
    label: String,
    appTokens: Number,
    amount: Number,
    currency: String,
    enabled: Boolean,
  },
  { timestamps: true }
);

const BillingPrice = model("billingPrice", BillingPriceSchema);

module.exports = BillingPrice;
