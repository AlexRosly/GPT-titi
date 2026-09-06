const { ChatTurn, ChatConversation } = require("../../../models");
const acceptTurn = require("../../../services/chatDeliveryV2/acceptTurn");
const retryTurn = require("../../../services/chatDeliveryV2/retryTurn");
const worker = require("../../../services/chatDeliveryV2/worker");
const { snapshot } = require("../../../services/chatDeliveryV2/snapshot");
const {
  validateChatSend,
  validateTurnRequest,
  errorFor,
} = require("../../../services/chatDeliveryV2/protocol");

const ackError = (ack, error) => {
  ack?.({
    ok: false,
    protocolVersion: 2,
    error: error?.protocolError || errorFor("INTERNAL_ERROR"),
  });
};

const registerChatDeliveryV2 = (io) => {
  worker.setIo(io);
  worker.startWorker().catch((error) => console.error("chat v2 worker startup error", error));

  io.on("connection", (socket) => {
    socket.on("chat:send", async (envelope, ack) => {
      try {
        const payload = validateChatSend(envelope);
        const result = await acceptTurn({ userId: socket.user._id, payload });
        ack?.({
          ok: true,
          protocolVersion: 2,
          disposition: result.disposition,
          turn: await snapshot(result.turn),
        });
        if (result.disposition === "accepted") {
          setImmediate(() => worker.claimTurn(result.turn.turnId).then((claimed) => {
            if (claimed) return worker.processTurn(claimed);
          }).catch((error) => console.error("chat v2 turn start error", error)));
        }
      } catch (error) {
        ackError(ack, error);
      }
    });

    socket.on("chat:status", async (envelope, ack) => {
      try {
        const { turnId } = validateTurnRequest(envelope, "chat:status");
        const turn = await ChatTurn.findOne({ turnId, user: socket.user._id }).lean();
        if (!turn) {
          return ack?.({ ok: false, protocolVersion: 2, error: errorFor("TURN_NOT_FOUND") });
        }
        ack?.({ ok: true, protocolVersion: 2, turn: await snapshot(turn) });
      } catch (error) {
        ackError(ack, error);
      }
    });

    socket.on("chat:retry", async (envelope, ack) => {
      try {
        const { turnId } = validateTurnRequest(envelope, "chat:retry");
        const updated = await retryTurn({
          turnId,
          userId: socket.user._id,
        });

        // The original user message remains the same. Its attempt is intentionally not rewritten.
        ack?.({ ok: true, protocolVersion: 2, turn: await snapshot(updated) });
        setImmediate(() => worker.claimTurn(updated.turnId).then((claimed) => {
          if (claimed) return worker.processTurn(claimed);
        }).catch((error) => console.error("chat v2 retry start error", error)));
      } catch (error) {
        ackError(ack, error);
      }
    });
  });
};

module.exports = registerChatDeliveryV2;
