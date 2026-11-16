const { ChatTurn } = require("../../../models");
const acceptTurn = require("../../../services/chatDeliveryV2/acceptTurn");
const retryTurn = require("../../../services/chatDeliveryV2/retryTurn");
const worker = require("../../../services/chatDeliveryV2/worker");
const { snapshot } = require("../../../services/chatDeliveryV2/snapshot");
const {
  validateChatSend,
  validateTurnRequest,
  errorFor,
} = require("../../../services/chatDeliveryV2/protocol");

const acknowledge = (ack, value) => { if (typeof ack === 'function') ack(value); };
const ackError = (ack, error, event) => {
  if (!error?.protocolError && !error?.fileError) {
    const safe = value => typeof value === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(value) ? value : null;
    console.error('CHAT_V2_REQUEST_ERROR', { event, name: safe(error?.name),
      code: Number.isSafeInteger(error?.code) ? error.code : safe(error?.code), codeName: safe(error?.codeName) });
  }
  acknowledge(ack, {
    ok: false,
    protocolVersion: 2,
    error:
      error?.protocolError ||
      (error?.fileError
        ? errorFor(error.fileError)
        : errorFor("INTERNAL_ERROR")),
  });
};

const registerChatDeliveryV2 = (io) => {
  worker.setIo(io);
  worker
    .startWorker()
    .catch((error) => console.error("chat v2 worker startup error", error));

  io.on("connection", (socket) => {
    socket.on('chat:cancel', async (envelope, ack) => {
      try {
        const { turnId } = validateTurnRequest(envelope, 'chat:cancel');
        const turn = await require('../../../services/chatDeliveryV2/cancelTurn')({ turnId, userId: socket.user._id });
        if (typeof ack === 'function') ack({ ok: true, protocolVersion: 2, turn: await snapshot(turn) });
      } catch (error) { ackError(ack, error, 'chat:cancel'); }
    });
    socket.on("chat:send", async (envelope, ack) => {
      try {
        const payload = validateChatSend(envelope);
        const result = await acceptTurn({ userId: socket.user._id, payload });
        acknowledge(ack, {
          ok: true,
          protocolVersion: 2,
          disposition: result.disposition,
          turn: await snapshot(result.turn),
        });
        if (result.disposition === "accepted") worker.wake();
      } catch (error) {
        ackError(ack, error, 'chat:send');
      }
    });

    socket.on("chat:status", async (envelope, ack) => {
      try {
        const { turnId } = validateTurnRequest(envelope, "chat:status");
        const turn = await ChatTurn.findOne({
          turnId,
          user: socket.user._id,
        }).lean();
        if (!turn) {
          return acknowledge(ack, {
            ok: false,
            protocolVersion: 2,
            error: errorFor("TURN_NOT_FOUND"),
          });
        }
        acknowledge(ack, { ok: true, protocolVersion: 2, turn: await snapshot(turn) });
      } catch (error) {
        ackError(ack, error, 'chat:status');
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
        acknowledge(ack, { ok: true, protocolVersion: 2, turn: await snapshot(updated) });
        worker.wake();
      } catch (error) {
        ackError(ack, error, 'chat:retry');
      }
    });
  });
};

module.exports = registerChatDeliveryV2;
