const mongoose = require("mongoose");
const { User, TokenTransfer } = require("../models");
const tokenLedger = require("./tokenLedger");

class TokenTransferError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const normalizeEmail = (value) => {
  if (typeof value !== "string") {
    throw new TokenTransferError(400, "INVALID_EMAIL", "Enter a valid recipient email.");
  }
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TokenTransferError(400, "INVALID_EMAIL", "Enter a valid recipient email.");
  }
  return email;
};

const assertSender = (sender) => {
  if (!sender || sender.status !== "active") {
    throw new TokenTransferError(403, "SENDER_NOT_ALLOWED", "Only active users can send tokens.");
  }
};

const findRecipient = async ({ userId, email, session = null }) => {
  // Existing accounts may contain mixed-case emails. Collation keeps the lookup
  // literal (including '+' and other email characters), without a regex query.
  const matches = await User.find({ email })
    .collation({ locale: "en", strength: 2 })
    .select("_id email status")
    .limit(2)
    .session(session)
    .lean();

  if (!matches.length) {
    throw new TokenTransferError(404, "RECIPIENT_NOT_FOUND", "No account found for this email.");
  }
  if (matches.length !== 1) {
    throw new TokenTransferError(409, "RECIPIENT_UNAVAILABLE", "This account cannot receive tokens.");
  }
  const recipient = matches[0];
  if (recipient.status === "deleted") {
    throw new TokenTransferError(
      409,
      "RECIPIENT_DELETED",
      "Transfer is not possible: this user has deleted their account.",
    );
  }
  if (recipient._id.toString() === userId.toString()) {
    throw new TokenTransferError(400, "SELF_TRANSFER", "You cannot transfer tokens to yourself.");
  }
  if (!["active", "blocked"].includes(recipient.status)) {
    throw new TokenTransferError(409, "RECIPIENT_UNAVAILABLE", "This account cannot receive tokens.");
  }
  return recipient;
};

const checkRecipient = async ({ userId, email: inputEmail }) => {
  const email = normalizeEmail(inputEmail);
  const sender = await User.findById(userId).select("status appTokens balanceVersion").lean();
  assertSender(sender);
  const recipient = await findRecipient({ userId, email });
  return {
    success: true,
    canTransfer: true,
    recipient: { email, status: recipient.status },
    appTokens: sender.appTokens,
    userId: String(userId), balanceVersion: sender.balanceVersion || 0,
  };
};

const transferResult = async (transfer, alreadyApplied, session = null) => {
  const operation = transfer.operation
    ? await tokenLedger.getOperation(transfer.sender, transfer.operation, { session })
    : null;
  return {
    success: true,
    transfer: {
      id: String(transfer._id), clientTransferId: transfer.clientTransferId,
      email: transfer.recipientEmail, amount: transfer.amount, createdAt: transfer.createdAt,
    },
    appTokens: transfer.senderBalance,
    userId: String(transfer.sender), balanceVersion: transfer.senderBalanceVersion,
    operation: operation ? {
      id: operation.id, kind: operation.kind, status: operation.status,
      source: operation.source, transactionHash: operation.transactionHash,
    } : null,
    alreadyApplied,
  };
};

const replayTransfer = (transfer, email, amount, session = null) => {
  if (transfer.recipientEmail !== email || transfer.amount !== amount) {
    throw new TokenTransferError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "This clientTransferId was already used for another transfer.",
    );
  }
  return transferResult(transfer, true, session);
};

const transferTokens = async ({ userId, email: inputEmail, amount, clientTransferId }) => {
  const email = normalizeEmail(inputEmail);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new TokenTransferError(400, "INVALID_AMOUNT", "Amount must be a positive safe integer.");
  }
  if (
    typeof clientTransferId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientTransferId)
  ) {
    throw new TokenTransferError(400, "INVALID_CLIENT_TRANSFER_ID", "clientTransferId must be a UUID v4.");
  }
  clientTransferId = clientTransferId.toLowerCase();

  const key = { sender: userId, clientTransferId };
  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(async () => {
      const sender = await User.findById(userId).select("status appTokens balanceVersion").session(session).lean();
      assertSender(sender);

      const existing = await TokenTransfer.findOne(key).session(session).lean();
      if (existing) return replayTransfer(existing, email, amount, session);

      const recipient = await findRecipient({ userId, email, session });
      let balances;
      try {
        balances = await tokenLedger.transfer({
          senderId: userId, recipientId: recipient._id, amount,
          key: `transfer:${userId}:${clientTransferId}`, session,
        });
      } catch (error) {
        if (error.code !== "INSUFFICIENT_BALANCE") throw error;
        throw new TokenTransferError(409, "INSUFFICIENT_BALANCE",
          "Insufficient balance. You can only send tokens from your available balance.",
          { appTokens: sender.appTokens, userId: String(userId), balanceVersion: sender.balanceVersion || 0 });
      }

      const [transfer] = await TokenTransfer.create(
        [{
          ...key,
          recipient: recipient._id,
          recipientEmail: email,
          amount,
          senderBalance: balances.sender.appTokens,
          senderBalanceVersion: balances.sender.balanceVersion,
          operation: balances.operation.id,
        }],
        { session },
      );
      return transferResult(transfer, false, session);
    }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary",
    });
    tokenLedger.notifyCommitted();
    return result;
  } catch (error) {
    // A concurrent retry may win the unique sender/clientTransferId index.
    // The aborted transaction rolls back both balances before replaying it.
    if (error?.code === 11000) {
      const existing = await TokenTransfer.findOne(key).lean();
      if (existing) return replayTransfer(existing, email, amount);
    }
    if (error instanceof tokenLedger.LedgerError) {
      throw new TokenTransferError(error.status, error.code, error.message, error.details);
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

module.exports = { checkRecipient, transferTokens, TokenTransferError };
