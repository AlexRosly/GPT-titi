const crypto = require("crypto");
const mongoose = require("mongoose");

const CODES = {
  BROWSER_MODEL_UNSUPPORTED: ["This model rejected the browser tool request. Select a model that supports function calling.", false],
  BROWSER_DISABLED: ["Browser navigation is disabled for this model or server.", false],
  BROWSER_NAVIGATION_FAILED: ["The browser could not open or read this page. Previously read pages may still be available.", true],
  BROWSER_UNAVAILABLE: ["The isolated browser is unavailable. Please try again or contact support.", true],
  BROWSER_BUSY: ["Browser capacity is busy. Please try again shortly.", true],
  BROWSER_TIMEOUT: ["Browser navigation reached its time limit.", true],
  BROWSER_LIMIT: ["Browser navigation reached its action or download limit.", false],
  BROWSER_ACTION_BLOCKED: ["This action is outside public read-only navigation.", false],
  BROWSER_INVALID_ACTION: ["The model returned an unsupported browser action.", false],
  WEB_TOO_MANY_URLS: ["Use at most three web URLs in one request.", false],
  WEB_INVALID_URL: ["Use a valid public HTTP or HTTPS URL without credentials or a custom port.", false],
  WEB_BLOCKED_ADDRESS: ["This address cannot be accessed by the web reader.", false],
  WEB_INPUT_DISABLED: ["Web reading is disabled for this model or server.", false],
  WEB_CONTEXT_TOO_LARGE: ["This request exceeds the web-reading context budget. Shorten the conversation or attachments.", false],
  WEB_CONFIGURATION_ERROR: ["Web reading pricing is not configured. Contact support.", false],
  WEB_TIMEOUT: ["The website did not respond within 15 seconds.", true],
  WEB_REDIRECT_LIMIT: ["The website redirected too many times or returned an invalid redirect.", false],
  WEB_UNAVAILABLE: ["The web page could not be retrieved.", true],
  WEB_ACCESS_DENIED: ["The website requires access, login, CAPTCHA, or is limiting requests.", false],
  WEB_UNSUPPORTED_TYPE: ["This link does not return an HTML web page. Upload documents using Add files.", false],
  WEB_UNSUPPORTED_ENCODING: ["The website uses an unsupported encoding.", false],
  WEB_PAGE_TOO_LARGE: ["The web page exceeds the 2 MiB download or parsing limit.", false],
  WEB_JAVASCRIPT_REQUIRED: ["This page requires JavaScript rendering, which is not supported yet.", false],
  WEB_NO_READABLE_TEXT: ["No readable text was found on this page.", false],
  FILE_QUOTA_EXCEEDED: ["Private file storage is full, including extracted text. Delete unused files and try again.", false],
  OCR_INPUT_DISABLED: ["OCR is disabled for this model or server.", false],
  OCR_UNAVAILABLE: ["OCR is not ready on the server. Please contact support or upload a text-layer PDF or text file.", false],
  OCR_FILE_TOO_LARGE: ["Files for OCR must be nonempty and no larger than 5 MiB. Split or resize the file.", false],
  OCR_PAGE_LIMIT: ["A PDF can contain at most 10 pages that need OCR. Split the document.", false],
  OCR_IMAGE_LIMIT: ["The image exceeds the OCR limit of 16 megapixels or 10,000 pixels per side. Resize the image.", false],
  OCR_TEXT_TOO_LARGE: ["Extracted document text exceeds 64 KiB. Split the document.", false],
  OCR_NO_TEXT: ["OCR could not recognize text in this PDF. Try a clearer, upright scan or upload a text copy.", false],
  OCR_INVALID_IMAGE: ["This image cannot be read by OCR. Use a valid, static PNG, JPG or WEBP image.", false],
  OCR_FAILED: ["OCR could not process this file. Try a clearer or smaller copy.", false],
  OCR_PROCESSING_TIMEOUT: ["OCR exceeded the processing time limit. Split the document or use a smaller image.", false],
  OCR_PROCESSING_BUSY: ["OCR processing is busy. Please try again shortly.", true],
  OCR_NOT_READY: ["Attachment processing changed while sending. Please try again.", true],
  PDF_INPUT_DISABLED: ["Reading PDF attachments is disabled for this model or server.", false],
  PDF_ATTACHMENT_TOO_LARGE: ["PDF attachments must be nonempty and no larger than 5 MiB.", false],
  PDF_PAGE_LIMIT: ["The PDF exceeds 50 pages. Split it into smaller documents.", false],
  PDF_EXTRACTED_TEXT_TOO_LARGE: ["The PDF exceeds 64 KiB of extracted text. Split it into smaller documents.", false],
  PDF_OCR_REQUIRED: ["No readable text layer was found. Scanned PDF pages need OCR, which is not available yet. Upload a PDF with selectable text or a text file.", false],
  PDF_PASSWORD_PROTECTED: ["Encrypted or password-protected PDFs cannot be read. Upload an unencrypted copy you are authorized to use.", false],
  INVALID_PDF_DOCUMENT: ["The PDF is damaged or its text cannot be read. Export a new copy with a text layer.", false],
  PDF_PROCESSING_TIMEOUT: ["PDF processing exceeded the time limit. Use a smaller document.", false],
  PDF_PROCESSING_BUSY: ["PDF processing is busy. Please try again shortly.", true],
  OFFICE_INPUT_DISABLED: ["Reading DOCX/XLSX is disabled for this model or server.", false],
  OFFICE_ATTACHMENT_TOO_LARGE: ["Office attachments must be nonempty and no larger than 5 MiB.", false],
  OFFICE_EXTRACTED_TEXT_TOO_LARGE: ["The document contains more than 64 KiB of extracted text. Split it into smaller documents.", false],
  OFFICE_DOCUMENT_LIMIT: ["The document exceeds safe parsing limits. Split it into smaller documents.", false],
  OFFICE_DOCUMENT_UNSUPPORTED: ["This document uses unsupported protection, embedded objects, external data or macros. Save a plain DOCX/XLSX copy.", false],
  INVALID_OFFICE_DOCUMENT: ["The DOCX/XLSX is invalid, damaged or unsupported. Save a new unencrypted copy.", false],
  OFFICE_DOCUMENT_EMPTY: ["No readable document text or spreadsheet cells were found. Images are not read at this stage.", false],
  OFFICE_PROCESSING_TIMEOUT: ["Document processing exceeded the time limit. Use a smaller document.", false],
  OFFICE_PROCESSING_BUSY: ["Document processing is busy. Please try again shortly.", true],
  TEXT_ATTACHMENT_TOO_LARGE: ["A text attachment exceeds 64 KiB. Split it into smaller files.", false],
  TEXT_ATTACHMENTS_CONTEXT_TOO_LARGE: ["Extracted attachment text in this conversation window exceed 128 KiB. Start a new chat or use smaller files.", false],
  TEXT_INPUT_DISABLED: ["Reading text attachments is disabled for this model or server.", false],
  INVALID_UTF8: ["Save the attachment as UTF-8 text and upload it again.", false],
  INVALID_TEXT: ["The attachment contains unsupported binary or control characters.", false],
  DOCUMENT_PROCESSING_NOT_ENABLED: ["This document format cannot be read yet. Use a supported text file.", false],
  INVALID_ENVELOPE: ["Invalid request envelope.", false],
  INVALID_CLIENT_MESSAGE_ID: ["Invalid client message id.", false],
  INVALID_CONVERSATION_ID: ["Invalid conversation id.", false],
  CONVERSATION_NOT_FOUND: ["Conversation not found.", false],
  MODEL_NOT_AVAILABLE: ["Model not available.", false],
  BALANCE_LIMIT_EXCEEDED: ["Your balance is below −1,000 TITI. Top up to continue.", false],
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
  const p = validateEnvelope(envelope, "chat:send", ["clientMessageId", "conversationId", "modelId", "message", "files", "outputFile"]);
  if (!isUuidV4(p.clientMessageId)) throw Object.assign(new Error(), { protocolError: errorFor("INVALID_CLIENT_MESSAGE_ID") });
  if (!mongoose.isValidObjectId(p.conversationId)) throw Object.assign(new Error(), { protocolError: errorFor("INVALID_CONVERSATION_ID") });
  if (typeof p.modelId !== "string" || !p.modelId || p.modelId.length > 200) throw Object.assign(new Error(), { protocolError: errorFor("INVALID_ENVELOPE") });
  if (typeof p.message !== "string" || !p.message || p.message.length > 100000) throw Object.assign(new Error(), { protocolError: errorFor("INVALID_ENVELOPE") });
  if (p.files !== undefined && (!Array.isArray(p.files) || p.files.length > 10 || p.files.some(f => !assertPlainObject(f)))) throw Object.assign(new Error(), { protocolError: errorFor("INVALID_ENVELOPE") });
  if (p.outputFile !== undefined) {
    if (!require("../files/config").enabled()) throw Object.assign(new Error(), { protocolError: errorFor("INVALID_ENVELOPE") });
    require("../files/artifacts").outputSpec(p.outputFile);
  }
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

const buildRequestHash = ({ userId, conversationId, modelId, message, files = [], outputFile }) => {
  const value = canonicalize({
    userId: userId.toString(),
    conversationId: conversationId.toString(),
    modelId,
    message,
    files: files.map(stableFileIdentifier),
    ...(outputFile ? { outputFile } : {}),
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
