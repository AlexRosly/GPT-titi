const { trackProviderStream } = require('./providerStream');
const crypto = require("crypto");
const OpenAI = require("openai");
const mongoose = require("mongoose");
const {
  ChatTurn,
  ChatModels,
  ChatMessage,
  ChatConversation,
} = require("../../models");
const { estimateTokens } = require("../../utils");
const { finalizeChargeInTransaction } = require("../finalizeCharge");
const { errorFor } = require("./protocol");
const { release } = require("./reservations");
const { createScheduler } = require("./scheduler");
const { messageDto } = require("./snapshot");
const runtime = require('./runtime');
const earlyCancellation = require('./earlyCancellation');

// Handoff transfers ownership to the document queue. A stale recovery scan or
// caller must not fail, complete, charge or reclaim that turn until publication.
const noActiveDocumentJob = { 'computeState.documentJob.active': { $ne: true } };
const recoveryGuard = turn => ({
  _id: turn._id, attempt: turn.attempt, status: 'processing',
  leaseToken: turn.leaseToken, leaseUntil: { $lte: new Date() },
  ...noActiveDocumentJob,
});

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 0,
});
const LEASE_MS = Number(process.env.CHAT_V2_LEASE_MS || 30_000);
const HEARTBEAT_MS = Math.max(1_000, Math.floor(LEASE_MS / 3));
const BATCH_MS = Number(process.env.CHAT_V2_BATCH_MS || 80);

let ioRef = null;
const activeControllers = new Map();
const abortTurn = turnId => activeControllers.get(turnId)?.abort(Object.assign(new Error('User cancelled'), { protocolError: errorFor('USER_CANCELLED') }));

const setIo = (io) => {
  ioRef = io;
};
const room = (userId) => userId.toString();
const emit = (userId, event, envelope) =>
  ioRef?.to(room(userId)).emit(event, envelope);

const safeProviderError = (error) => {
  const status = error?.status;
  if (status === 404 || status === 403) return errorFor('MODEL_NOT_AVAILABLE');
  if (status === 400 || status === 422) return errorFor('PROVIDER_REQUEST_REJECTED');
  const code =
    status === 429 || status >= 500 ? "PROVIDER_UNAVAILABLE" : "INTERNAL_ERROR";
  return errorFor(code);
};

const claimTurn = async (turnId) => {
  const leaseToken = crypto.randomUUID();
  const now = new Date();
  const turn = await ChatTurn.findOneAndUpdate(
    {
      turnId,
      status: "queued",
      ...noActiveDocumentJob,
    },
    {
      $set: {
        status: "processing",
        processingStartedAt: now,
        failureDiagnostic: null,
        workerRuntime: runtime,
        leaseToken,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
      },
    },
    { new: true },
  );
  return turn ? { turn, leaseToken } : null;
};

const claimNextQueued = async () => {
  const leaseToken = crypto.randomUUID();
  const now = new Date();
  const turn = await ChatTurn.findOneAndUpdate(
    { status: "queued", ...noActiveDocumentJob },
    {
      $set: {
        status: "processing",
        processingStartedAt: now,
        failureDiagnostic: null,
        workerRuntime: runtime,
        leaseToken,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
      },
    },
    { new: true, sort: { createdAt: 1 } },
  );
  return turn ? { turn, leaseToken } : null;
};

const heartbeat = async (turn, leaseToken) => {
  const result = await ChatTurn.updateOne(
    {
      _id: turn._id,
      turnId: turn.turnId,
      attempt: turn.attempt,
      status: "processing",
      leaseToken,
      leaseUntil: { $gt: new Date() },
      cancelRequestedAt: null,
    },
    { $set: { leaseUntil: new Date(Date.now() + LEASE_MS) } },
  );
  return result.modifiedCount === 1;
};

const updatePartial = async (turn, leaseToken, partialContent, seq) => {
  const result = await ChatTurn.updateOne(
    {
      _id: turn._id,
      turnId: turn.turnId,
      attempt: turn.attempt,
      status: "processing",
      leaseToken,
      leaseUntil: { $gt: new Date() },
      cancelRequestedAt: null,
      lastSeq: seq - 1,
    },
    { $set: { partialContent, lastSeq: seq } },
  );
  return result.modifiedCount === 1;
};

const emitFailure = (turn, error) =>
  emit(turn.user, "chat:error", {
    protocolVersion: 2,
    event: "chat:error",
    type: "failed",
    turnId: turn.turnId,
    clientMessageId: turn.clientMessageId,
    conversationId: turn.conversation.toString(),
    attempt: turn.attempt,
    payload: { error },
  });

const failTurn = async (
  turn,
  leaseToken,
  errorObject,
  { knownNoCharge = false, expiredOnly = false } = {},
) => {
  const session = await mongoose.startSession();
  let updated;
  try {
    await session.withTransaction(async () => {
      updated = undefined;
      const current = await ChatTurn.findOne({
        _id: turn._id,
        attempt: turn.attempt,
        status: "processing",
        leaseToken,
        ...noActiveDocumentJob,
        ...(expiredOnly ? { leaseUntil: { $lte: new Date() } } : {}),
      }).session(session);
      if (!current || current.providerResult) return;
      let uncertain = Boolean(current.providerStartedAt) && !knownNoCharge;
      const cancelled = Boolean(current.cancelRequestedAt);
      const settlement = cancelled && uncertain
        ? await earlyCancellation.settleInitialCancellation(current, session) : null;
      if (settlement) uncertain = false;
      const terminalError = cancelled ? earlyCancellation.cancellationError(uncertain) : uncertain
        ? errorFor(
            "PROCESS_INTERRUPTED",
            "Generation was interrupted. Its token charge is being reconciled.",
            false,
          )
        : errorObject;
      if (!uncertain && !settlement) await release(current, session);
      updated = await ChatTurn.findOneAndUpdate(
        { _id: current._id, leaseToken, attempt: current.attempt, status: 'processing',
          providerResult: null, ...noActiveDocumentJob,
          ...(expiredOnly ? { leaseUntil: { $lte: new Date() } } : {}) },
        {
          $set: {
            status: "failed",
            error: terminalError,
            needsReconciliation: uncertain,
            ...(settlement || {}),
            failureDiagnostic: {
              ...current.failureDiagnostic,
              terminal: { source: 'worker.failTurn', code: cancelled ? 'USER_CANCELLED' : errorObject.code, recovery: expiredOnly, runtime },
            },
            leaseToken: null,
            leaseUntil: null,
          },
        },
        { new: true, session },
      );
    });
  } finally {
    await session.endSession();
  }
  if (updated) {
    console.warn('CHAT_V2_TERMINAL_FAILURE', { turnId: updated.turnId, attempt: updated.attempt,
      ...updated.failureDiagnostic.terminal, errorCode: updated.error?.code });
    if (updated.webPlan) console.info("WEB_V2_RESULT", {
      turnId: updated.turnId, attempt: updated.attempt, modelId: updated.modelId,
      status: updated.status, error: updated.error?.code,
      reservationState: updated.reservationState, needsReconciliation: updated.needsReconciliation,
    });
    require("../tokenLedger").notifyCommitted();
    emitFailure(updated, updated.error);
  }
  return updated;
};

const completionCancellationGuard = { ...noActiveDocumentJob,
  $or: [{cancelRequestedAt:null}, {'computeState.documentJob.active':false,'computeState.pending':false,'providerResult.computation.reason':'USER_CANCELLED'}] };

const commitCompletion = async (turn, leaseToken, assistantText, usage) => {
  // Render outside the transaction; Office/PDF work runs in a bounded worker thread.
  // Recovery repeats only local rendering from the saved provider result, never the model call.
  const savedTurn = await ChatTurn.findOne({
    _id: turn._id,
    attempt: turn.attempt,
    status: "processing",
    leaseToken,
    leaseUntil: { $gt: new Date() },
    ...completionCancellationGuard,
  }).lean();
  if (!savedTurn) throw Object.assign(new Error(), { staleLease: true });
  let preparedFile, renderError;
  if (
    !savedTurn.pdfCellPlan && !savedTurn.docxQualityPlan && (savedTurn.outputFile ||
    savedTurn.providerResult?.artifact ||
    savedTurn.providerResult?.artifactError)
  ) {
    try {
      const data = savedTurn.providerResult;
      if (data?.artifactError || !data?.artifact)
        throw require("../files/validation").fail(
          data?.artifactError || "INVALID_FILE_OUTPUT",
        );
      preparedFile = await require("../files/artifacts").renderOutput(
        savedTurn.outputFile || { filename: data.artifact.filename },
        data.artifact.content,
      );
    } catch (error) {
      if (!error.fileError) throw error;
      renderError = error;
    }
  }
  const providerAssistantText = assistantText;
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      // Mongo may retry the callback: never append the source footer twice.
      assistantText = providerAssistantText;
      const current = await ChatTurn.findOne({
        _id: turn._id,
        turnId: turn.turnId,
        attempt: turn.attempt,
        status: "processing",
        leaseToken,
        leaseUntil: { $gt: new Date() },
        ...completionCancellationGuard,
      }).session(session);
      if (!current) throw Object.assign(new Error(), { staleLease: true });

      const quality = require('../pdfCell').publication(current) || require('../docx/signatureQuality').publication(current);
      let computationResult = quality?.computation || current.providerResult?.computation;
      if (quality) assistantText = quality.assistantText;
      let attachments = [],
        fileResult = null;
      if (
        !quality && (current.outputFile ||
        current.providerResult?.artifact ||
        current.providerResult?.artifactError)
      ) {
        try {
          const data = current.providerResult;
          if (renderError) throw renderError;
          const f = await require("../files/store").create({
            ...preparedFile,
            user: turn.user,
            source: "generated",
            resultKey: `${turn.turnId}:${turn.attempt}:0`,
            session,
          });
          attachments = [
            { ...require("../files/store").dto(f), storage: "private" },
          ];
          fileResult = {
            status: f.status,
            filename: f.originalName,
            fileId: String(f._id),
            error: null,
          };
          assistantText = data.artifact.summary || "File result attached.";
        } catch (error) {
          if (!error.fileError) throw error;
          fileResult = {
            status: "failed",
            filename: current.outputFile?.filename || "requested-file",
            error: error.fileError,
          };
          assistantText =
            "The file could not be created. See the file result for details.";
        }
      }

      if (computationResult) {
        for (const ref of computationResult.files || []) {
          const file = await require('../files/store').owned(turn.user, ref.fileId, {session, includeDeleted:true});
          if (!file.resultKey?.startsWith(`${turn.turnId}:${turn.attempt}:compute:`)) throw new Error('Invalid computation result reference');
          const ready = file.status === 'ready' && (!file.expiresAt || file.expiresAt > new Date());
          if (current.pdfCellPlan && (!ready || !require('../pdfCell').matchesFile(current, file))) {
            computationResult = {...quality.computation, status:'partial', reason:'PDF_CELL_UNVERIFIED', files:[]};
            assistantText = 'The verified PDF copy is unavailable.';
            break;
          }
          if (current.docxQualityPlan && (!ready || file.documentEdit?.sourceFileId !== current.docxQualityPlan.sourceFileId ||
              file.documentEdit?.visualVerification !== true ||
              (current.docxQualityPlan.profile === require('../docx/tableText').profile &&
               !require('../docx/tableText').matchesCheckpoint(file.documentEdit?.tableTextQuality, current.computeState.docxCompletion.quality)))) {
            computationResult = {...quality.computation, status:'partial', reason:'DOCX_QUALITY_UNVERIFIED', files:[]};
            assistantText = 'The verified DOCX copy is unavailable.';
            break;
          }
          if (ready) {
            await require('../../models/managedFile').updateOne({_id:file._id,user:turn.user,status:'ready'},{$set:{expiresAt:null,retention:'library'}},{session});
            file.expiresAt = null;
            file.retention = 'library';
          }
          attachments.push({...require('../files/store').dto(file),storage:'private'});
        }
      }
      assistantText += require("../web/context").footer(current);

      const cost = await finalizeChargeInTransaction({
        session,
        turnId: turn.turnId,
        userId: turn.user,
        modelId: turn.modelId,
        conversationId: turn.conversation,
        pricing: current.pricing,
        usage: {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
        },
      });

      await release(current, session, "settled");

      let assistant = current.assistantMessage
        ? await ChatMessage.findById(current.assistantMessage).session(session)
        : null;

      if (!assistant) {
        [assistant] = await ChatMessage.create(
          [
            {
              user: turn.user,
              conversation: turn.conversation,
              role: "assistant",
              content: assistantText,
              attachments,
              fileResult,
              computation: require("../computation/status").result(computationResult),
              webSources: require("../web/context").sources(current),
              modelId: turn.modelId,
              tokens: usage.completionTokens,
              turnId: turn.turnId,
              attempt: turn.attempt,
              meta: { appTokens: cost.appTokens, costUsd: cost.usd },
            },
          ],
          { session },
        );
      }

      const billing = {
        appTokensSpent: cost.appTokens,
        totalTokens: usage.totalTokens,
        balance: cost.balance,
      };

      const completedAt = new Date();
      const completionUpdate = await ChatTurn.updateOne(
        {
          _id: current._id,
          turnId: turn.turnId,
          attempt: turn.attempt,
          status: "processing",
          leaseToken,
          leaseUntil: { $gt: completedAt },
          ...completionCancellationGuard,
        },
        {
          $set: {
            assistantMessage: assistant._id,
            usage,
            billing,
            billingAppliedAt: completedAt,
            needsReconciliation: false,
            providerResult: null,
            responseState: null,
            status: "completed",
            completedAt,
            leaseToken: null,
            leaseUntil: null,
            partialContent: assistantText,
          },
        },
        { session },
      );

      if (completionUpdate.modifiedCount !== 1) {
        throw Object.assign(new Error("Stale worker lease"), {
          staleLease: true,
        });
      }

      await ChatConversation.updateOne(
        { _id: turn.conversation, user: turn.user },
        { $set: { lastMessageAt: new Date() } },
        { session },
      );

      result = { assistant: assistant.toObject(), billing };
    });
    require("../tokenLedger").notifyCommitted();
  } finally {
    await session.endSession();
  }
  return result;
};

const processTurn = async (claimed) => {
  const { turn, leaseToken } = claimed;
  let heartbeatTimer;
  let providerTimer;
  let resultStored = false;
  const providerProgress = { rejectedBeforeOutput: false };
  const controller = new AbortController();
  activeControllers.set(turn.turnId, controller);
  try {
    if (turn.reservationState !== "held") {
      await failTurn(
        turn,
        leaseToken,
        errorFor(
          "PROCESS_INTERRUPTED",
          "Please retry this request after the billing upgrade.",
          true,
        ),
      );
      return;
    }
    heartbeatTimer = setInterval(() => {
      heartbeat(turn, leaseToken)
        .then((owned) => {
          if (!owned) controller.abort();
        })
        .catch(() => controller.abort());
    }, HEARTBEAT_MS);

    const web = require("../web/context");
    const fileModel = await ChatModels.findOne({ modelId: turn.modelId, enabled: true })
      .select("apiMode reasoningEffort computationEnabled zipInputEnabled zipOutputEnabled browserInputEnabled browserVisionEnabled webInputEnabled fileOutputEnabled textInputEnabled officeInputEnabled pdfInputEnabled ocrInputEnabled limits").lean();
    if (!fileModel) {
      await failTurn(turn, leaseToken, errorFor('MODEL_NOT_AVAILABLE'), { knownNoCharge: true });
      return;
    }
    const providerConfig = require('./responsesProvider').configuration({ modelId: turn.modelId, ...(turn.providerConfig || fileModel) });
    const responseModel = { ...fileModel, ...providerConfig, modelId: turn.modelId };
    const providerGuard = () => ({ _id: turn._id, attempt: turn.attempt, status: 'processing', leaseToken,
      leaseUntil: { $gt: new Date() }, reservationState: 'held', cancelRequestedAt: null });
    const saveResponse = async values => {
      const updated = await ChatTurn.updateOne(providerGuard(), { $set: values });
      if (!updated.matchedCount) throw Object.assign(new Error('Stale lease'), { staleLease: true });
      Object.assign(turn, values);
    };
    const onResponseId = async id => {
      const updated = await ChatTurn.updateOne(providerGuard(), { $addToSet: { providerResponseIds: id } });
      if (!updated.matchedCount) throw Object.assign(new Error('Stale lease'), { staleLease: true });
    };
    const history = await require("../files/textContext").forTurn(turn);
    const textInput = require("../files/textInput");
    const textBudget = textInput.budget();
    const messages = [{ role: "system", content: "You are a helpful assistant." }];
    // Sequential construction keeps the shared context byte budget deterministic.
    for (const m of history) messages.push({ role: m.role, content: m.role === "user"
      ? await require("../files/messages").providerContent(turn.user, m.content, m.attachments, { model: fileModel, state: textBudget })
      : m.content });
    if (textBudget.promptBytes) messages[0].content += " " + textInput.instructions;

    let assistantText = turn.partialContent || "";
    let seq = turn.lastSeq || 0;
    const artifacts = require("../files/artifacts");
    if (turn.outputFile && (!artifacts.outputEnabled(fileModel) || (/\.zip$/i.test(turn.outputFile.filename) && !require("../files/zipOutput").enabled(fileModel)))) {
      await failTurn(turn, leaseToken, errorFor("MODEL_NOT_AVAILABLE"), {
        knownNoCharge: true,
      });
      return;
    }
    const automaticFiles = !turn.outputFile && artifacts.autoEnabled(fileModel);
    if (automaticFiles)
      messages[0].content += " " + artifacts.fileSystemInstructions;
    const fileTools = turn.outputFile
      ? artifacts.toolOptions(turn.outputFile)
      : automaticFiles
        ? artifacts.autoToolOptions(fileModel)
        : {};
    const computation = require('../computation/policy');
    const computeAvailability = computation.availability(fileModel, turn);
    const computeEnabled = computeAvailability === 'AVAILABLE';
    const computeFiles = computeEnabled ? await require('../computation/files').candidates(turn, fileModel) : [];
    const computeCollector = computeEnabled ? computation.collector() : null;
    if (computeEnabled) {
      fileTools.tools = [...(fileTools.tools || []), ...computation.toolsFor(fileModel)];
      fileTools.tool_choice = 'auto'; fileTools.parallel_tool_calls = false;
      messages[0].content += ' ' + computation.instructions(fileModel) + ' Office exports follow: ' + require('../files/office').instructions;
      messages[0].content += '\nCOMPUTATION_FILES: ' + JSON.stringify(computeFiles);
      if (!turn.pdfCellPlan && require('../pdfCell').enabled(fileModel) && computeFiles.some(f => /\.pdf$/i.test(f.name))) {
        messages[0].content += ' A create_file manifest makes a new PDF. For edits to an existing PDF, only claim an edited copy if a source-edit tool produced one. For prose, ask for the exact old and new text and, if needed, the page, named section or party. Example: У розділі «Умови оплати» заміни «10 днів» на «15 днів». A filename is optional for text edits. For table cells ask for a physical page, row key, column, exact old and new value. For a numeric cell the supported Ukrainian pilot request is: У PDF на сторінці 2 у рядку «QA-202» у колонці «Дата» заміни «13.11.2026» на «07.11.2026». Поверни копію з назвою result.pdf. For several edits repeat the sentence starting with На сторінці for each target, then request one named copy.';
      }
      if (require('../docxBatch/policy').enabled(fileModel)) messages[0].content += ' ' + require('../docxBatch/policy').instructions;
      if (require('../xlsx/policy').enabled(fileModel)) messages[0].content += ' ' + require('../xlsx/policy').instructions;
      if (require('../docx/policy').enabled(fileModel)) messages[0].content += ' ' + require('../docx/policy').instructions;
    }
    const exact = require("../files/exactTranscription");
    const exactFiles = turn.pdfCellPlan || turn.docxQualityPlan || turn.outputFile || turn.webPlan?.mode === "browser" ? [] : await exact.candidates(turn.user, history, fileModel);
    const exactCollector = exactFiles.length ? exact.collector() : null;
    if (exactCollector) {
      const option = exact.options(exactFiles);
      messages[0].content += " " + option.instruction;
      fileTools.tools = [...(fileTools.tools || []), option.tool];
      fileTools.tool_choice = "auto";
      fileTools.parallel_tool_calls = false;
    }
    if (turn.pdfCellPlan) {
      const pdf = require('../pdfCell');
      if (!computeEnabled || !pdf.enabled(fileModel)) throw require('../files/validation').fail('PDF_CELL_UNAVAILABLE');
      const selectedTool = pdf.toolFor(turn.pdfCellPlan);
      fileTools.tools = [selectedTool];
      fileTools.tool_choice = {type:'function',function:{name:selectedTool.function.name}};
      fileTools.parallel_tool_calls = false;
      messages[0].content += ' Use the selected PDF editing tool once. The server obtains every target and replacement from the user request and verifies the complete copy.';
    } else if (turn.docxQualityPlan) {
      fileTools.tools = require('../docx/policy').tools;
      fileTools.parallel_tool_calls = false;
      messages[0].content += ' Inspect the attached source then use edit_docx alone with complete=true. The server verifies the requested edit against the original before delivery.';
    }
    if (turn.webPlan?.mode === "browser") {
      // Browser loop owns every provider boundary and accumulates actual usage.
      // Exact-transcription tools remain on their existing non-browser path.
      const browserTools = turn.outputFile ? artifacts.toolOptions(turn.outputFile)
        : automaticFiles ? artifacts.autoToolOptions(fileModel) : {};
      const browserClient = providerConfig.apiMode === 'responses'
        ? new (require('./responsesProvider').ResponsesSession)(client, responseModel, { onResponseId }).asChatClient() : client;
      const data = await require("../browser/agent").run(turn, leaseToken, fileModel,
        messages, browserTools, browserClient, controller.signal);
      const saved = await ChatTurn.updateOne(require("../browser/accounting").guard(turn,leaseToken),
        { $set: { providerResult: data } });
      if (!saved.matchedCount) return;
      resultStored = true;
      const completion = await commitCompletion(turn,leaseToken,data.assistantText,data.usage);
      emit(turn.user, "chat:end", {protocolVersion:2,event:"chat:end",type:"completed",
        turnId:turn.turnId,clientMessageId:turn.clientMessageId,conversationId:turn.conversation.toString(),
        attempt:turn.attempt,payload:{assistantMessage:messageDto(completion.assistant),billing:completion.billing}});
      return;
    }
    const webContent = await web.prepare(turn, leaseToken, fileModel, controller.signal);
    let webBudget;
    if (webContent) {
      messages[0].content += " " + web.instructions;
      // Source data precedes the current user request, so the request remains last.
      messages.splice(Math.max(1, messages.length - 1), 0, webContent);
      if (controller.signal.aborted) throw controller.signal.reason;
      webBudget = await require("../web/reservation").startProvider(turn, leaseToken, messages, fileTools.tools);
    }
    const started = webBudget ? { matchedCount: 1 } : await ChatTurn.updateOne(
      {
        _id: turn._id,
        attempt: turn.attempt,
        leaseToken,
        status: "processing",
        leaseUntil: { $gt: new Date() },
        reservationState: "held",
        cancelRequestedAt: null,
      },
      { $set: { providerStartedAt: new Date() } },
    );
    if (!started.matchedCount) {
      controller.signal.throwIfAborted();
      return;
    }
    if (providerConfig.apiMode === 'responses') {
      let pendingText = '', lastFlush = Date.now();
      const flush = async () => {
        if (!pendingText) return;
        const chunk = pendingText;
        assistantText += chunk;
        pendingText = '';
        seq += 1;
        if (!await updatePartial(turn, leaseToken, assistantText, seq)) {
          controller.abort();
          throw Object.assign(new Error('Stale lease'), { staleLease: true });
        }
        emit(turn.user, 'chat:stream', { protocolVersion: 2, event: 'chat:stream', type: 'delta',
          turnId: turn.turnId, clientMessageId: turn.clientMessageId, conversationId: turn.conversation.toString(),
          attempt: turn.attempt, payload: { seq, chunk } });
        lastFlush = Date.now();
      };
      const data = await require('./responsesTurn').run({ turn, token: leaseToken, model: responseModel,
        messages, fileTools, computeFiles, exactFiles, client, signal: controller.signal, providerProgress,
        save: saveResponse, onResponseId, maxOutputTokens: webBudget?.outputTokens,
        onText: async delta => {
          if (turn.pdfCellPlan || turn.docxQualityPlan) return;
          pendingText += delta;
          if (pendingText.length >= 256 || Date.now() - lastFlush >= BATCH_MS) await flush();
        } });
      if (data.deferred) return;
      await flush();
      await saveResponse({ providerResult: data });
      resultStored = true;
      const completion = await commitCompletion(turn, leaseToken, data.assistantText, data.usage);
      emit(turn.user, 'chat:end', { protocolVersion: 2, event: 'chat:end', type: 'completed',
        turnId: turn.turnId, clientMessageId: turn.clientMessageId, conversationId: turn.conversation.toString(),
        attempt: turn.attempt, payload: { assistantMessage: messageDto(completion.assistant), billing: completion.billing } });
      return;
    }
    console.info("FILE_TOOL_DIAGNOSTIC", {
      modelId: turn.modelId,
      turnId: turn.turnId,
      computeV2Enabled: process.env.COMPUTE_V2_ENABLED === 'true',
      modelComputationEnabled: fileModel?.computationEnabled !== false,
      computeEnabled,
      computeAvailability,
      privateFilesEnabled: process.env.PRIVATE_FILES_ENABLED,
      autoFilesEnabled: process.env.FILE_OUTPUT_AUTO_ENABLED,
      modelFound: Boolean(fileModel),
      modelFileOutputEnabled: fileModel?.fileOutputEnabled,
      automaticFiles,
      tools: fileTools.tools?.map((t) => t.function?.name),
      toolChoice: fileTools.tool_choice,
    });
    if (webBudget) providerTimer = setTimeout(() => controller.abort(new Error("Provider deadline exceeded")), 120000);
    const stream = trackProviderStream(() => client.chat.completions.create(
      {
        model: turn.modelId,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...fileTools,
        ...(webBudget ? { max_completion_tokens: webBudget.outputTokens } : {}),
      },
      { signal: controller.signal, ...(webBudget ? { timeout: 120000 } : {}) },
    ), providerProgress);

    const fileCollector =
      turn.outputFile || automaticFiles
        ? artifacts.collector({ optional: automaticFiles, model: fileModel })
        : null;
    let usage;
    let finishReason;
    let pending = "";
    let lastFlush = Date.now();

    let emittedSince = 0;
    for await (const chunk of stream) {
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      fileCollector?.add(chunk);
      exactCollector?.add(chunk);
      computeCollector?.add(chunk);
      const delta = turn.outputFile ? null : chunk.choices?.[0]?.delta?.content;
      if (chunk.usage) {
        usage = earlyCancellation.readInitialUsage(chunk.usage);
        if (usage) {
          // Persist the final usage before any cancellable flush/tool boundary.
          // Cancellation may already be requested; it must not erase billing evidence.
          const saved = await ChatTurn.updateOne({ _id: turn._id, attempt: turn.attempt,
            status: 'processing', leaseToken, leaseUntil: { $gt: new Date() },
            reservationState: 'held', ...noActiveDocumentJob },
          { $set: { initialProviderUsage: usage } });
          if (!saved.matchedCount) throw Object.assign(new Error('Stale usage owner'), { staleLease: true });
        }
      }
      if (!delta) continue;
      pending += delta;
      emittedSince += delta.length;
      if (!turn.pdfCellPlan && !turn.docxQualityPlan && !exactCollector && (Date.now() - lastFlush >= BATCH_MS || emittedSince >= 256)) {
        const chunkText = pending;
        assistantText += chunkText;
        pending = "";
        seq += 1;
        const ok = await updatePartial(turn, leaseToken, assistantText, seq);
        if (!ok) {
          controller.abort();
          return;
        }
        emit(turn.user, "chat:stream", {
          protocolVersion: 2,
          event: "chat:stream",
          type: "delta",
          turnId: turn.turnId,
          clientMessageId: turn.clientMessageId,
          conversationId: turn.conversation.toString(),
          attempt: turn.attempt,
          payload: { seq, chunk: chunkText },
        });
        emittedSince = 0;
        lastFlush = Date.now();
      }
    }

    controller.signal.throwIfAborted();

    if (pending && !turn.pdfCellPlan && !turn.docxQualityPlan && !exactCollector) {
      const chunkText = pending;
      assistantText += chunkText;
      pending = "";
      seq += 1;
      const ok = await updatePartial(turn, leaseToken, assistantText, seq);
      if (!ok) {
        controller.abort();
        return;
      }
      emit(turn.user, "chat:stream", {
        protocolVersion: 2,
        event: "chat:stream",
        type: "delta",
        turnId: turn.turnId,
        clientMessageId: turn.clientMessageId,
        conversationId: turn.conversation.toString(),
        attempt: turn.attempt,
        payload: { seq, chunk: chunkText },
      });
    }

    let computeCall;
    try { computeCall = computeCollector?.finish(); }
    catch (error) {
      if (error.fileError !== 'COMPUTE_INVALID_ACTION') throw error;
      computation.diagnose(error, turn, 'initial_stream');
      // Account for a completed but malformed tool response without executing it.
      computeCall = {id:'invalid',type:'function',function:{name:'run_python',arguments:''}};
    }
    if (computeCall) {
      // A completed usage record is mandatory before executing any code.
      const data = await require('../computation/agent').run(turn, leaseToken, fileModel, messages, computeCall, usage, computeFiles, client, controller.signal);
      if (data.deferred) return;
      const saved = await ChatTurn.updateOne(require('../computation/accounting').guard(turn, leaseToken), { $set: { providerResult: data } });
      if (!saved.matchedCount) return;
      resultStored = true;
      const completion = await commitCompletion(turn, leaseToken, data.assistantText, data.usage);
      emit(turn.user, 'chat:end', {protocolVersion:2,event:'chat:end',type:'completed',turnId:turn.turnId,clientMessageId:turn.clientMessageId,conversationId:turn.conversation.toString(),attempt:turn.attempt,payload:{assistantMessage:messageDto(completion.assistant),billing:completion.billing}});
      return;
    }
    const streamedTextTokens = estimateTokens(assistantText + pending);
    const exactSelection = exactCollector?.finish();
    const fileOutput = exactSelection ? {} : (fileCollector ? fileCollector.finish() : {});
    if (exactSelection) assistantText = await exact.render(turn.user, exactSelection, exactFiles);
    else if (exactCollector) assistantText += pending;
    if (fileOutput.artifact || fileOutput.artifactError)
      assistantText =
        fileOutput.artifact?.summary || "File generation finished.";

    if (!usage) {
      // Include tool definitions and mixed text/tool output in fallback accounting.
      const promptTokens = estimateTokens(
        JSON.stringify({ messages, ...fileTools }),
      );
      const completionTokens =
        streamedTextTokens + Math.ceil((exactSelection?.argumentChars || fileOutput.argumentChars || 0) / 4);
      usage = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
    }

    if (webBudget && finishReason === "length")
      assistantText += "\n\n[Response reached the output limit and may be incomplete.]";

    // Persist the completed provider result before billing. Recovery can finish
    // this exact charge without making another provider request.
    const saved = await ChatTurn.updateOne(
      {
        _id: turn._id,
        attempt: turn.attempt,
        leaseToken,
        status: "processing",
        leaseUntil: { $gt: new Date() },
        cancelRequestedAt: null,
      },
      { $set: { providerResult: { assistantText, usage, ...fileOutput } } },
    );
    if (!saved.matchedCount) return;
    resultStored = true;
    const completion = await commitCompletion(
      turn,
      leaseToken,
      assistantText,
      usage,
    );
    emit(turn.user, "chat:end", {
      protocolVersion: 2,
      event: "chat:end",
      type: "completed",
      turnId: turn.turnId,
      clientMessageId: turn.clientMessageId,
      conversationId: turn.conversation.toString(),
      attempt: turn.attempt,
      payload: {
        assistantMessage: messageDto(completion.assistant),
        billing: completion.billing,
      },
    });
  } catch (error) {
    if (resultStored || error?.staleLease && controller.signal.reason?.protocolError?.code !== 'USER_CANCELLED') return;
    if (controller.signal.reason?.protocolError?.code === 'USER_CANCELLED') error = controller.signal.reason;
    const protocol =
      error?.code === "INSUFFICIENT_BALANCE"
        ? errorFor("INSUFFICIENT_BALANCE")
        : error?.protocolError || (error?.fileError ? errorFor(error.fileError) : safeProviderError(error));
    const failure = require('./failureRecovery');
    const failureDiagnostic = failure.diagnostic({ ...error, protocolError: protocol }, turn);
    // Persist bounded codes and phase metadata, never prompts, file bytes,
    // provider payloads, credentials or raw exception messages.
    await ChatTurn.updateOne({ _id: turn._id, attempt: turn.attempt, status: 'processing', leaseToken,
      providerResult: null, 'computeState.documentJob.active': { $ne: true } }, { $set: { failureDiagnostic } });
    try { console.warn('CHAT_V2_FAILURE', { turnId: turn.turnId, attempt: turn.attempt, ...failureDiagnostic }); } catch {}
    if (!controller.signal.aborted) {
      const current = await ChatTurn.findOne({ _id: turn._id, attempt: turn.attempt, status: 'processing', leaseToken,
        leaseUntil: { $gt: new Date() }, reservationState: 'held', cancelRequestedAt: null }).lean();
      const data = current && failure.partialResult(current, protocol.code);
      if (data) {
        const saved = await ChatTurn.updateOne({ _id: turn._id, attempt: turn.attempt, status: 'processing', leaseToken,
          leaseUntil: { $gt: new Date() }, cancelRequestedAt: null, providerResult: null,
          'computeState.documentJob.active': { $ne: true } }, { $set: { providerResult: data } });
        if (!saved.matchedCount) return;
        resultStored = true;
        const completion = await commitCompletion(turn, leaseToken, data.assistantText, data.usage);
        emit(turn.user, 'chat:end', { protocolVersion: 2, event: 'chat:end', type: 'completed', turnId: turn.turnId,
          clientMessageId: turn.clientMessageId, conversationId: turn.conversation.toString(), attempt: turn.attempt,
          payload: { assistantMessage: messageDto(completion.assistant), billing: completion.billing } });
        return;
      }
    }
    await failTurn(turn, leaseToken, protocol, {
      knownNoCharge: providerProgress.rejectedBeforeOutput && !turn.computeState && turn.webPlan?.mode !== "browser" && [400, 401, 403, 404, 422, 429].includes(error?.status),
    });
  } finally {
    clearInterval(heartbeatTimer);
    clearTimeout(providerTimer);
    controller.abort();
    if (activeControllers.get(turn.turnId) === controller) activeControllers.delete(turn.turnId);
  }
};

const recoverExpired = async () => {
  const expired = await ChatTurn.find({
    status: "processing",
    ...noActiveDocumentJob,
    leaseUntil: { $lte: new Date() },
  });
  for (const turn of expired) {
    if (turn.cancelRequestedAt && !turn.providerResult) {
      await failTurn(turn, turn.leaseToken, errorFor('USER_CANCELLED'), { expiredOnly: true });
      continue;
    }
    const completedDocument = !turn.providerResult && (require('../pdfCell').completion(turn) || require('../docx/continuation').completion(turn));
    if (completedDocument) {
      const saved = await ChatTurn.updateOne({ ...recoveryGuard(turn), providerResult: null, cancelRequestedAt: null },
      { $set: { providerResult: completedDocument } });
      if (!saved.matchedCount) continue;
      turn.providerResult = completedDocument;
    }
    if (!turn.providerResult && turn.responseState && !turn.responseState.pending) {
      const state = turn.responseState;
      const data = { ...state.partialData, assistantText: (state.partialData?.assistantText || '') + '\n\n[Generation interrupted; only completed work is available.]',
        usage: state.usage, ...(turn.computeState ? { computation: { status: 'partial', kind: turn.computeState.kind, reason: 'PROCESS_INTERRUPTED',
          files: turn.computeState.files, runs: turn.computeState.runs, executionMs: turn.computeState.executionMs } } : {}) };
      const saved = await ChatTurn.updateOne({ ...recoveryGuard(turn), providerResult: null }, { $set: { providerResult: data } });
      if (!saved.matchedCount) continue;
      turn.providerResult = data;
    }
    if (!turn.providerResult && turn.computeState && !turn.computeState.pending) {
      const data = require('../computation/agent').partial(turn, 'PROCESS_INTERRUPTED');
      const saved = await ChatTurn.updateOne({...recoveryGuard(turn),providerResult:null},{$set:{providerResult:data}});
      if (!saved.matchedCount) continue;
      turn.providerResult = data;
    }
    if (turn.webPlan?.mode === "browser" && !turn.providerResult && turn.browserState && !turn.browserState.pending && turn.providerStartedAt) {
      // Completed calls are accounted for. Do not replay browser actions after a crash.
      const data = require("../browser/agent").partial(turn, "PROCESS_INTERRUPTED");
      const saved = await ChatTurn.updateOne({...recoveryGuard(turn),providerResult:null},{$set:{providerResult:data}});
      if (!saved.matchedCount) continue;
      turn.providerResult = data;
    }
    if (turn.providerResult) {
      const leaseToken = crypto.randomUUID();
      const current = await ChatTurn.findOneAndUpdate(
        recoveryGuard(turn),
        { $set: { leaseToken, leaseUntil: new Date(Date.now() + LEASE_MS), workerRuntime: runtime } },
        { new: true },
      );
      if (!current) continue;
      const recoveryHeartbeat = setInterval(() => { heartbeat(current, leaseToken).catch(() => {}); }, HEARTBEAT_MS);
      try {
        const completion = await commitCompletion(
          current,
          leaseToken,
          current.providerResult.assistantText,
          current.providerResult.usage,
        );
        emit(current.user, "chat:end", {
          protocolVersion: 2,
          event: "chat:end",
          type: "completed",
          turnId: current.turnId,
          clientMessageId: current.clientMessageId,
          conversationId: current.conversation.toString(),
          attempt: current.attempt,
          payload: {
            assistantMessage: messageDto(completion.assistant),
            billing: completion.billing,
          },
        });
      } catch (error) {
        console.error(
          "chat v2 completion recovery failed",
          current.turnId,
          error.message,
        );
      } finally {
        clearInterval(recoveryHeartbeat);
      }
    } else if (turn.webPlan && turn.webPlan.mode !== "browser" && !turn.providerStartedAt) {
      // No model call was started: keep completed page reads and let the normal
      // scheduler reclaim the job within its concurrency limit.
      await ChatTurn.updateOne({ ...recoveryGuard(turn), providerStartedAt: null },
        { $set: { status: "queued", leaseToken: null, leaseUntil: null } });
    } else {
      await failTurn(turn, turn.leaseToken, errorFor("PROCESS_INTERRUPTED"), {
        expiredOnly: true,
      });
    }
  }
};

let scheduler = null;
const wake = () => scheduler?.wake();
const startWorker = async () => {
  if (scheduler) return () => scheduler?.stop();
  console.info('CHAT_V2_WORKER_READY', { ...runtime,
    flags: Object.fromEntries(['DOCUMENT_JOBS_ENABLED','XLSX_EDIT_ENABLED','COMPUTE_V2_ENABLED','PRIVATE_FILES_ENABLED']
      .map(key => [key, process.env[key] === undefined ? 'unset' : process.env[key] === 'true'])) });
  scheduler = createScheduler({
    claim: claimNextQueued,
    process: processTurn,
    recover: recoverExpired,
    concurrency: Number(process.env.CHAT_V2_WORKERS || 4),
  });
  scheduler.wake();
  return () => {
    scheduler.stop();
    scheduler = null;
  };
};

module.exports = {
  abortTurn,
  setIo,
  wake,
  failTurn,
  claimTurn,
  heartbeat,
  updatePartial,
  commitCompletion,
  processTurn,
  startWorker,
  recoverExpired,
};
