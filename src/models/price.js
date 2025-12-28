const { Schema, model } = require("mongoose");

const PriceSchema = Schema(
  {
    stripePriceId: { type: String, required: true, unique: true },

    label: { type: String }, // "1000 tokens", "Starter pack"
    appTokens: { type: Number, required: true },

    amount: { type: Number }, // в центах (необязательно, для UI)
    currency: { type: String, default: "usd" },

    enabled: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false }
);

const Price = model("price", PriceSchema);
module.exports = Price;
