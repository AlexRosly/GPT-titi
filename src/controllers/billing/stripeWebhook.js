const { User, Payment, Price } = require("../../models");
const stripe = require("../../services");

const MIN_APP_TOKENS = -1000;

const stripeWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    // защита от повторной обработки
    const exists = await Payment.findOne({
      stripeSessionId: session.id,
    });
    if (exists) {
      return res.json({ received: true });
    }

    const userId = session.metadata.userId;
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id);

    const priceId = lineItems.data[0].price.id;

    const price = await Price.findOne({
      stripePriceId: priceId,
      enabled: true,
    });

    if (!price) {
      console.error("Unknown priceId:", priceId);
      return res.json({ received: true });
    }

    // 1️⃣ начисляем токены
    await User.findByIdAndUpdate(userId, {
      $inc: { appTokens: price.appTokens },
    });

    // 2️⃣ сохраняем платёж
    await Payment.create({
      user: userId,
      stripeSessionId: session.id,
      stripePaymentIntentId: session.payment_intent,
      stripeCustomerId: session.customer,
      priceId,
      amount: session.amount_total,
      currency: session.currency,
      appTokensAdded: price.appTokens,
      status: "paid",
      rawEvent: event, // можно убрать в проде
    });

    console.log(`💳 Payment saved & ${tokensToAdd} tokens added`);
  }
  // 🔁 Refund (оставляем как есть, но без хардкода)
  if (event.type === "charge.refunded") {
    const charge = event.data.object;

    const payment = await Payment.findOne({
      stripePaymentIntentId: charge.payment_intent,
    });

    // защита от дублей
    if (!payment || payment.status === "refunded") {
      return res.json({ received: true });
    }

    const user = await User.findById(payment.user);
    if (!user) return res.json({ received: true });

    // 🔴 считаем новый баланс
    const newBalance = user.appTokens - payment.appTokensAdded;

    // ⛔ лимит минуса
    user.appTokens = Math.max(newBalance, MIN_APP_TOKENS);

    await user.save();

    // обновляем платёж
    payment.status = "refunded";
    await payment.save();

    console.log(`↩️ Refund: user=${user._id}, tokens=${user.appTokens}`);
  }

  res.json({ received: true });
};

module.exports = stripeWebhook;
