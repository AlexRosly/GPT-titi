const { User, Price } = require("../../models");
const stripe = require("../../services/stripe");

const createCheckout = async (req, res) => {
  try {
    const { priceId } = req.body || {};
    const userId = req.user?._id;

    if (typeof priceId !== "string" || !priceId.trim()) {
      return res.status(400).json({ error: "Missing priceId" });
    }

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!process.env.CLIENT_URL) {
      console.error("CLIENT_URL is not configured");
      return res.status(500).json({
        status: 500,
        message: "Billing is not configured",
      });
    }

    const user = await User.findById(userId).select("email");
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Never trust a priceId supplied by the frontend unless it is enabled
    // in our own billing catalog.
    const price = await Price.findOne({
      stripePriceId: priceId.trim(),
      enabled: true,
    }).lean();

    if (!price) {
      return res.status(400).json({ error: "Invalid or disabled priceId" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price: price.stripePriceId,
          quantity: 1,
        },
      ],
      customer_email: user.email,
      client_reference_id: user._id.toString(),
      metadata: {
        userId: user._id.toString(),
        priceId: price.stripePriceId,
      },
      success_url: `${process.env.CLIENT_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/billing/cancel`,
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("Error in controller createCheckout:", error);
    return res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = createCheckout;
