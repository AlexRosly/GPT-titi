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

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 0,
});
const LEASE_MS = Number(process.env.CHAT_V2_LEASE_MS || 30_000);
const HEARTBEAT_MS = Math.max(1_000, Math.floor(LEASE_MS / 3));
const BATCH_MS = Number(process.env.CHAT_V2_BATCH_MS || 80);

let ioRef = null;

const setIo = (io) => {
  ioRef = io;
};
const room = (userId) => userId.toString();
const emit = (userId, event, envelope) =>
  ioRef?.to(room(userId)).emit(event, envelope);

const safeProviderError = (error) => {
  const status = error?.status;
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
    },
    {
      $set: {
        status: "processing",
        processingStartedAt: now,
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
    { status: "queued" },
    {
      $set: {
        status: "processing",
        processingStartedAt: now,
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
        ...(expiredOnly ? { leaseUntil: { $lte: new Date() } } : {}),
      }).session(session);
      if (!current || current.providerResult) return;
      const uncertain = Boolean(current.providerStartedAt) && !knownNoCharge;
      const terminalError = uncertain
        ? errorFor(
            "PROCESS_INTERRUPTED",
            "Generation was interrupted. Its token charge is being reconciled.",
            false,
          )
        : errorObject;
      if (!uncertain) await release(current, session);
      updated = await ChatTurn.findOneAndUpdate(
        { _id: current._id, leaseToken, attempt: current.attempt },
        {
          $set: {
            status: "failed",
            error: terminalError,
            needsReconciliation: uncertain,
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

const commitCompletion = async (turn, leaseToken, assistantText, usage) => {
  // Render outside the transaction; Office/PDF work runs in a bounded worker thread.
  // Recovery repeats only local rendering from the saved provider result, never the model call.
  const savedTurn = await ChatTurn.findOne({
    _id: turn._id,
    attempt: turn.attempt,
    status: "processing",
    leaseToken,
    leaseUntil: { $gt: new Date() },
  }).lean();
  if (!savedTurn) throw Object.assign(new Error(), { staleLease: true });
  let preparedFile, renderError;
  if (
    savedTurn.outputFile ||
    savedTurn.providerResult?.artifact ||
    savedTurn.providerResult?.artifactError
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
      }).session(session);
      if (!current) throw Object.assign(new Error(), { staleLease: true });

      let attachments = [],
        fileResult = null;
      if (
        current.outputFile ||
        current.providerResult?.artifact ||
        current.providerResult?.artifactError
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
        },
        {
          $set: {
            assistantMessage: assistant._id,
            usage,
            billing,
            billingAppliedAt: completedAt,
            needsReconciliation: false,
            providerResult: null,
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
  const controller = new AbortController();
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
      .select("browserInputEnabled browserVisionEnabled webInputEnabled fileOutputEnabled textInputEnabled officeInputEnabled pdfInputEnabled ocrInputEnabled limits").lean();
    if (turn.webPlan && !fileModel) throw require("../web/policy").fail("WEB_INPUT_DISABLED");
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
    if (turn.outputFile && !artifacts.outputEnabled(fileModel)) {
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
        ? artifacts.autoToolOptions()
        : {};
    const exact = require("../files/exactTranscription");
    const exactFiles = turn.outputFile || turn.webPlan?.mode === "browser" ? [] : await exact.candidates(turn.user, history, fileModel);
    const exactCollector = exactFiles.length ? exact.collector() : null;
    if (exactCollector) {
      const option = exact.options(exactFiles);
      messages[0].content += " " + option.instruction;
      fileTools.tools = [...(fileTools.tools || []), option.tool];
      fileTools.tool_choice = "auto";
      fileTools.parallel_tool_calls = false;
    }
    if (turn.webPlan?.mode === "browser") {
      // Browser loop owns every provider boundary and accumulates actual usage.
      // Exact-transcription tools remain on their existing non-browser path.
      const browserTools = turn.outputFile ? artifacts.toolOptions(turn.outputFile)
        : automaticFiles ? artifacts.autoToolOptions() : {};
      const data = await require("../browser/agent").run(turn, leaseToken, fileModel,
        messages, browserTools, client, controller.signal);
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
      },
      { $set: { providerStartedAt: new Date() } },
    );
    if (!started.matchedCount) return;
    console.info("FILE_TOOL_DIAGNOSTIC", {
      modelId: turn.modelId,
      privateFilesEnabled: process.env.PRIVATE_FILES_ENABLED,
      autoFilesEnabled: process.env.FILE_OUTPUT_AUTO_ENABLED,
      modelFound: Boolean(fileModel),
      modelFileOutputEnabled: fileModel?.fileOutputEnabled,
      automaticFiles,
      tools: fileTools.tools?.map((t) => t.function?.name),
      toolChoice: fileTools.tool_choice,
    });
    if (webBudget) providerTimer = setTimeout(() => controller.abort(new Error("Provider deadline exceeded")), 120000);
    const stream = await client.chat.completions.create(
      {
        model: turn.modelId,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...fileTools,
        ...(webBudget ? { max_completion_tokens: webBudget.outputTokens } : {}),
      },
      { signal: controller.signal, ...(webBudget ? { timeout: 120000 } : {}) },
    );

    const fileCollector =
      turn.outputFile || automaticFiles
        ? artifacts.collector({ optional: automaticFiles })
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
      const delta = turn.outputFile ? null : chunk.choices?.[0]?.delta?.content;
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens || 0,
          completionTokens: chunk.usage.completion_tokens || 0,
          totalTokens: chunk.usage.total_tokens || 0,
        };
      }
      if (!delta) continue;
      pending += delta;
      emittedSince += delta.length;
      if (!exactCollector && (Date.now() - lastFlush >= BATCH_MS || emittedSince >= 256)) {
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

    if (pending && !exactCollector) {
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
    if (error?.staleLease || resultStored) return;
    const protocol =
      error?.code === "INSUFFICIENT_BALANCE"
        ? errorFor("INSUFFICIENT_BALANCE")
        : error?.protocolError || (error?.fileError ? errorFor(error.fileError) : safeProviderError(error));
    await failTurn(turn, leaseToken, protocol, {
      knownNoCharge: turn.webPlan?.mode !== "browser" && [400, 401, 403, 404, 422, 429].includes(error?.status),
    });
  } finally {
    clearInterval(heartbeatTimer);
    clearTimeout(providerTimer);
    controller.abort();
  }
};

const recoverExpired = async () => {
  const expired = await ChatTurn.find({
    status: "processing",
    leaseUntil: { $lte: new Date() },
  });
  for (const turn of expired) {
    if (turn.webPlan?.mode === "browser" && !turn.providerResult && turn.browserState && !turn.browserState.pending && turn.providerStartedAt) {
      // Completed calls are accounted for. Do not replay browser actions after a crash.
      const data = require("../browser/agent").partial(turn, "PROCESS_INTERRUPTED");
      const saved = await ChatTurn.updateOne({_id:turn._id,status:"processing",attempt:turn.attempt,
        leaseToken:turn.leaseToken,leaseUntil:{$lte:new Date()},providerResult:null},{$set:{providerResult:data}});
      if (!saved.matchedCount) continue;
      turn.providerResult = data;
    }
    if (turn.providerResult) {
      const leaseToken = crypto.randomUUID();
      const current = await ChatTurn.findOneAndUpdate(
        {
          _id: turn._id,
          status: "processing",
          leaseToken: turn.leaseToken,
          leaseUntil: { $lte: new Date() },
        },
        { $set: { leaseToken, leaseUntil: new Date(Date.now() + LEASE_MS) } },
        { new: true },
      );
      if (!current) continue;
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
      }
    } else if (turn.webPlan && turn.webPlan.mode !== "browser" && !turn.providerStartedAt) {
      // No model call was started: keep completed page reads and let the normal
      // scheduler reclaim the job within its concurrency limit.
      await ChatTurn.updateOne({ _id: turn._id, status: "processing", attempt: turn.attempt,
        leaseToken: turn.leaseToken, leaseUntil: { $lte: new Date() }, providerStartedAt: null },
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
