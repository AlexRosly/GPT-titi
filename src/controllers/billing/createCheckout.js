const { User } = require("../../models");

const createCheckout = async (req, res) => {
  try {
    const { priceId } = req.body;
    const userId = req.user.id; // из access token

    if (!priceId) {
      return res.status(400).json({ error: "Missing priceId" });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      customer_email: user.email,

      metadata: {
        userId: user._id.toString(),
      },

      success_url: `${process.env.CLIENT_URL}/billing/success`,
      cancel_url: `${process.env.CLIENT_URL}/billing/cancel`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Error in createCheckout:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = createCheckout;
