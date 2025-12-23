const { Schema, model } = require("mongoose");

const PaymentSchema = Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: true,
      index: true,
    },

    // Stripe
    stripeSessionId: { type: String, unique: true },
    stripePaymentIntentId: { type: String },
    stripeCustomerId: { type: String },

    // Product info
    priceId: { type: String },
    amount: { type: Number }, // в центах
    currency: { type: String },

    // App logic
    appTokensAdded: { type: Number },
    status: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded"],
      default: "paid",
    },

    rawEvent: { type: Object }, // optional (debug / audit)
  },
  { timestamps: true, versionKey: false }
);

const Paymen = model("payment", PaymentSchema);

module.exports = Paymen;
