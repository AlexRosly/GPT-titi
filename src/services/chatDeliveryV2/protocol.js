const crypto = require("crypto");
const mongoose = require("mongoose");

const CODES = {
  INVALID_ENVELOPE: ["Invalid request envelope.", false],
  INVALID_CLIENT_MESSAGE_ID: ["Invalid client message id.", false],
  INVALID_CONVERSATION_ID: ["Invalid conversation id.", false],
  CONVERSATION_NOT_FOUND: ["Conversation not found.", false],
  MODEL_NOT_AVAILABLE: ["Model not available.", false],
  INSUFFICIENT_BALANCE: ["Insufficient balance.", false],
  IDEMPOTENCY_CONFLICT: ["The client message id was already used for another request.", false],
  TURN_NOT_FOUND: ["Turn not found.", false],
  TURN_NOT_RETRYABLE: ["Turn is not retryable.", false],
  TURN_ALREADY_PROCESSING: ["Turn is already processing.", true],
  PROVIDER_UNAVAILABLE: ["AI service is temporarily unavailable.", true],
  PROCESS_INTERRUPTED: ["Generation was interrupted and can be retried.", true],
  INTERNAL_ERROR: ["Internal server error.", false],
};

const errorFor = (code, message, retryable) => ({
  code,
  message: message || CODES[code]?.[0] || "Request failed.",
  retryable: retryable ?? CODES[code]?.[1] ?? false,
});

const isUuidV4 = (value) => {
  if (typeof value !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
};

const assertPlainObject = (value) => value && typeof value === "object" && !Array.isArray(value);

const assertKeys = (object, allowed) =>
  Object.keys(object).every((key) => allowed.includes(key));

const validateEnvelope = (envelope, event, payloadKeys) => {
  if (!assertPlainObject(envelope) || envelope.protocolVersion !== 2 || envelope.event !== event || envelope.type !== "request" || !assertPlainObject(envelope.payload)) {
    throw Object.assign(new Error(), { protocolError: errorFor("INVALID_ENVELOPE") });
  }
  if (!assertKeys(envelope, ["protocolVersion", "event", "type", "payload"]) || !assertKeys(envelope.payload, payloadKeys)) {
    throw Object.assign(new Error(), { protocolError: errorFor("INVALID_ENVELOPE") });
  }
  return envelope.payload;
};

const validateChatSend = (envelope) => {
  const p = validateEnvelope(envelope, "chat:send", ["clientMessageId", "conversationId", "modelId", "message", "files"]);
  if (!isUuidV4(p.clientMessageId)) throw Object.assign(new Error(), { protocolError: errorFor("INVALID_CLIENT_MESSAGE_ID") });
  if (!mongoose.isValidObjectId(p.conversationId)) throw Object.assign(new Error(), { protocolError: errorFor("INVALID_CONVERSATION_ID") });
  if (typeof p.modelId !== "string" || !p.modelId || p.modelId.length > 200) throw Object.assign(new Error(), { protocolError: errorFor("INVALID_ENVELOPE") });
  if (typeof p.message !== "string" || !p.message || p.message.length > 100000) throw Object.assign(new Error(), { protocolError: errorFor("INVALID_ENVELOPE") });
  if (p.files !== undefined && !Array.isArray(p.files)) throw Object.assign(new Error(), { protocolError: errorFor("INVALID_ENVELOPE") });
  return p;
};

const validateTurnRequest = (envelope, event) => {
  const p = validateEnvelope(envelope, event, ["turnId"]);
  if (typeof p.turnId !== "string" || !isUuidV4(p.turnId)) throw Object.assign(new Error(), { protocolError: errorFor("INVALID_ENVELOPE") });
  return p;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalize(value[key]);
      return out;
    }, {});
  }
  return value;
};

const stableFileIdentifier = (file) => {
  if (!file || typeof file !== "object") return file;
  return file.id || file._id || file.fileId || file.publicId || file.filename || file.url || null;
};

const buildRequestHash = ({ userId, conversationId, modelId, message, files = [] }) => {
  const value = canonicalize({
    userId: userId.toString(),
    conversationId: conversationId.toString(),
    modelId,
    message,
    files: files.map(stableFileIdentifier),
  });
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
};

module.exports = {
  CODES,
  errorFor,
  isUuidV4,
  validateChatSend,
  validateTurnRequest,
  buildRequestHash,
};
