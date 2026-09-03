const mongoose = require("mongoose");
const { User, Payment, Price } = require("../../models");
const stripe = require("../../services/stripe");

const MIN_APP_TOKENS = -1000;

const stripeWebhook = async (req, res) => {
  const signature = req.headers["stripe-signature"];

  if (!signature) {
    return res.status(400).send("Webhook Error: Missing stripe-signature");
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET is not configured");
    return res.status(500).json({
      status: 500,
      message: "Stripe webhook is not configured",
    });
  }

  let event;

  try {
    // req.body must be the raw Buffer. The route is mounted before express.json().
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (error) {
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      await handleCheckoutCompleted(event);
    } else if (event.type === "charge.refunded") {
      await handleChargeRefunded(event);
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error(`Error processing Stripe event ${event.id}:`, error);

    // Return 500 so Stripe retries the webhook instead of considering it handled.
    return res.status(500).json({
      status: 500,
      message: "Webhook processing failed",
    });
  }
};

const handleCheckoutCompleted = async (event) => {
  const session = event.data.object;

  if (session.payment_status !== "paid") {
    console.warn(
      `Stripe checkout session ${session.id} is completed but not paid yet: ${session.payment_status}`,
    );
    return;
  }

  const userId = session.metadata?.userId;
  const metadataPriceId = session.metadata?.priceId;

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new Error(`Invalid userId in Stripe session metadata: ${userId}`);
  }

  // The priceId is stored in metadata when checkout is created, so we do not
  // need another Stripe API call just to identify the purchased package.
  const priceId = metadataPriceId;

  if (!priceId) {
    throw new Error(`Missing priceId in Stripe session metadata: ${session.id}`);
  }

  const price = await Price.findOne({
    stripePriceId: priceId,
    enabled: true,
  }).lean();

  if (!price) {
    throw new Error(`Unknown or disabled priceId: ${priceId}`);
  }

  // Fast path for normal Stripe retries. The unique index is the final
  // concurrency guard for two deliveries arriving at the same time.
  const alreadyProcessed = await Payment.exists({
    stripeSessionId: session.id,
  });

  if (alreadyProcessed) {
    return;
  }

  const dbSession = await mongoose.startSession();

  try {
    await dbSession.withTransaction(async () => {
      await Payment.create(
        [
          {
            user: userId,
            stripeSessionId: session.id,
            stripePaymentIntentId: session.payment_intent || null,
            stripeCustomerId: session.customer || null,
            priceId,
            amount: session.amount_total ?? price.amount ?? null,
            currency: session.currency || price.currency,
            appTokensAdded: price.appTokens,
            status: "paid",
            rawEvent: event,
          },
        ],
        { session: dbSession },
      );

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        {
          $inc: {
            appTokens: price.appTokens,
            totalSpentUsd:
              price.currency?.toLowerCase() === "usd"
                ? (session.amount_total || 0) / 100
                : 0,
          },
        },
        { new: true, session: dbSession },
      );

      if (!updatedUser) {
        throw new Error(`User not found: ${userId}`);
      }
    });
  } catch (error) {
    // A concurrent/delivered-again event can lose the race on the unique
    // stripeSessionId index. If the payment now exists, the other webhook
    // already owns the token allocation, so this delivery is safely ignored.
    if (error?.code === 11000) {
      const payment = await Payment.findOne({
        stripeSessionId: session.id,
      }).select("_id");

      if (payment) {
        return;
      }
    }

    throw error;
  } finally {
    await dbSession.endSession();
  }

  console.log(
    `💳 Payment ${session.id} processed: user=${userId}, tokens=${price.appTokens}`,
  );
};

const handleChargeRefunded = async (event) => {
  const charge = event.data.object;

  // We only reverse the token package when the entire charge was refunded.
  // Partial refunds require separate accounting and must not remove the full
  // token package.
  if (!charge.refunded) {
    console.log(
      `↩️ Partial refund ignored for charge=${charge.id}; amount_refunded=${charge.amount_refunded}`,
    );
    return;
  }

  if (!charge.payment_intent) {
    console.warn(`Refund event ${event.id} has no payment_intent`);
    return;
  }

  const dbSession = await mongoose.startSession();

  try {
    await dbSession.withTransaction(async () => {
      // Atomic status transition makes duplicate webhook delivery safe.
      const payment = await Payment.findOneAndUpdate(
        {
          stripePaymentIntentId: charge.payment_intent,
          status: "paid",
        },
        {
          $set: { status: "refunded" },
        },
        {
          new: true,
          session: dbSession,
        },
      );

      if (!payment) {
        return;
      }

      const user = await User.findById(payment.user).session(dbSession);

      if (!user) {
        throw new Error(`User not found for payment ${payment._id}`);
      }

      user.appTokens = Math.max(
        user.appTokens - payment.appTokensAdded,
        MIN_APP_TOKENS,
      );

      if (payment.currency?.toLowerCase() === "usd") {
        user.totalSpentUsd = Math.max(
          0,
          user.totalSpentUsd - (payment.amount || 0) / 100,
        );
      }

      await user.save({ session: dbSession });
    });
  } finally {
    await dbSession.endSession();
  }

  console.log(
    `↩️ Refund processed: paymentIntent=${charge.payment_intent}, charge=${charge.id}`,
  );
};

module.exports = stripeWebhook;
