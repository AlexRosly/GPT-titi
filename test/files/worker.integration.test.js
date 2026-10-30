process.env.OCR_ENABLED = "false"; // Compatibility path; OCR is covered separately.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const uri = process.env.FILES_TEST_MONGO_URI;
// No real provider request is made by these tests.
process.env.OPENAI_API_KEY ||= "test-placeholder-not-a-real-key";
const models = require("../../src/models");
const File = require("../../src/models/managedFile");
const Chunk = require("../../src/models/fileChunk");
const Quota = require("../../src/models/fileQuota");
const worker = require("../../src/services/chatDeliveryV2/worker");
const accept = require("../../src/services/chatDeliveryV2/acceptTurn");
const store = require("../../src/services/files/store");
const { snapshot } = require("../../src/services/chatDeliveryV2/snapshot");
let user, conversation, modelId;
test.before(async () => {
  if (!uri) return;
  if (!/\/gptiti_files_test_[a-zA-Z0-9_-]+(?:\?|$)/.test(uri))
    throw new Error("Isolated test DB required");
  await mongoose.connect(
    uri.replace("gptiti_files_test_local", "gptiti_files_test_worker"),
  );
  for (const m of [...Object.values(models), File, Chunk, Quota])
    await m.createIndexes();
  process.env.PRIVATE_FILES_ENABLED = "true";
  modelId = "files-test-model";
  process.env.FILE_OUTPUT_MODELS = "unrelated-legacy-model";
  delete process.env.FILE_OUTPUT_AUTO_ENABLED;
  user = await models.User.create({
    email: "worker-files@example.test",
    name: "Files",
    status: "active",
    appTokens: 100000,
  });
  await models.ChatModels.create({
    modelId,
    enabled: true,
    inputPerM: 1,
    outputPerM: 2,
  });
  conversation = await models.ChatConversation.create({
    user: user._id,
    modelId,
  });
});
test.after(async () => {
  if (uri) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
const fixture = async (content, filename = "result.txt") => {
  const accepted = await accept({
    userId: user._id,
    payload: {
      clientMessageId: crypto.randomUUID(),
      conversationId: conversation.id,
      modelId,
      message: "Create a file",
      files: [],
      outputFile: { filename },
    },
  });
  const claim = await worker.claimTurn(accepted.turn.turnId);
  const usage = { promptTokens: 20, completionTokens: 20, totalTokens: 40 };
  await models.ChatTurn.updateOne(
    { turnId: claim.turn.turnId },
    {
      providerResult: {
        assistantText: "Done",
        usage,
        artifact: { content, summary: "Result" },
      },
    },
  );
  return { ...claim, usage };
};
test(
  "completion commits real file and V2 references, recovery never duplicates file or charge",
  { skip: !uri },
  async () => {
    const { turn, leaseToken, usage } = await fixture("hello");
    const completion = await worker.commitCompletion(
      turn,
      leaseToken,
      "Done",
      usage,
    );
    const id = completion.assistant.attachments[0].fileId;
    assert.equal((await store.read(user._id, id)).buffer.toString(), "hello");
    const recovered = await snapshot(
      await models.ChatTurn.findOne({ turnId: turn.turnId }),
    );
    assert.equal(recovered.assistantMessage.attachments[0].fileId, id);
    await worker.recoverExpired();
    assert.equal(
      await File.countDocuments({ resultKey: `${turn.turnId}:1:0` }),
      1,
    );
    assert.equal(
      await models.ChatBillingLedger.countDocuments({ turnId: turn.turnId }),
      1,
    );
    await store.remove(user._id, id);
    const deleted = await snapshot(
      await models.ChatTurn.findOne({ turnId: turn.turnId }),
    );
    assert.equal(deleted.assistantMessage.fileResult.status, "deleted");
  },
);
test(
  "invalid model output completes billing once and returns explicit file failure",
  { skip: !uri },
  async () => {
    const { turn, leaseToken, usage } = await fixture(
      "{not json}",
      "result.json",
    );
    const result = await worker.commitCompletion(
      turn,
      leaseToken,
      "Done",
      usage,
    );
    assert.equal(result.assistant.fileResult.status, "failed");
    assert.equal(result.assistant.fileResult.error, "INVALID_JSON");
    assert.equal(result.assistant.attachments.length, 0);
    assert.equal(
      await File.countDocuments({ resultKey: `${turn.turnId}:1:0` }),
      0,
    );
    assert.equal(
      await models.ChatBillingLedger.countDocuments({ turnId: turn.turnId }),
      1,
    );
  },
);
test(
  "expired worker result is finalized from saved output without another provider request",
  { skip: !uri },
  async () => {
    const { turn } = await fixture("recovered content");
    await models.ChatTurn.updateOne(
      { turnId: turn.turnId },
      { leaseUntil: new Date(0) },
    );
    await worker.recoverExpired();
    const completed = await models.ChatTurn.findOne({ turnId: turn.turnId });
    assert.equal(completed.status, "completed");
    assert.equal(
      await File.countDocuments({ resultKey: `${turn.turnId}:1:0` }),
      1,
    );
  },
);

test(
  "automatic file completion recovers without outputFile and charges once",
  { skip: !uri },
  async () => {
    const accepted = await accept({
      userId: user._id,
      payload: {
        clientMessageId: crypto.randomUUID(),
        conversationId: conversation.id,
        modelId,
        message: "Створи котика у SVG",
        files: [],
      },
    });
    const { turn } = await worker.claimTurn(accepted.turn.turnId);
    const usage = { promptTokens: 20, completionTokens: 20, totalTokens: 40 };
    await models.ChatTurn.updateOne(
      { turnId: turn.turnId },
      {
        leaseUntil: new Date(0),
        providerResult: {
          assistantText: "Cat",
          usage,
          artifact: {
            filename: "cat.svg",
            content:
              '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#none" d="M0 0 L1 1"/></svg>',
            summary: "Cat",
          },
        },
      },
    );
    await worker.recoverExpired();
    await worker.recoverExpired();
    const completed = await models.ChatTurn.findOne({ turnId: turn.turnId });
    const state = await snapshot(completed);
    assert.equal(completed.status, "completed");
    assert.equal(completed.outputFile, null);
    assert.equal(state.assistantMessage.fileResult.status, "ready");
    const file = await store.read(
      user._id,
      state.assistantMessage.attachments[0].fileId,
    );
    assert.match(file.buffer.toString(), /fill="none"/);
    assert.equal(
      await File.countDocuments({ resultKey: `${turn.turnId}:1:0` }),
      1,
    );
    assert.equal(
      await models.ChatBillingLedger.countDocuments({ turnId: turn.turnId }),
      1,
    );
  },
);
test(
  "worker automatically offers files but preserves plain-text streaming",
  { skip: !uri },
  async (t) => {
    await models.ChatModels.updateOne(
      { modelId },
      { $unset: { fileOutputEnabled: 1 } },
    ); // Existing record with no new field.
    const { Completions } = require("openai/resources/chat/completions");
    let calls = 0,
      fileMode = false;
    t.mock.method(Completions.prototype, "create", async function* (request) {
      calls++;
      assert.equal(request.tool_choice, "auto");
      assert.match(request.messages[0].content, /use that tool/);
      if (fileMode) {
        const args = JSON.stringify({
          filename: "natural.txt",
          content: "hello from file",
          summary: "Ready",
        });
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { name: "create_file", arguments: args },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        };
      } else
        yield {
          choices: [
            { delta: { content: "Hello from chat" }, finish_reason: "stop" },
          ],
        };
      yield {
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
      };
    });
    for (const useFile of [false, true]) {
      fileMode = useFile;
      const accepted = await accept({
        userId: user._id,
        payload: {
          clientMessageId: crypto.randomUUID(),
          conversationId: conversation.id,
          modelId,
          message: useFile ? "Збережи привітання у TXT" : "Привіт",
          files: [],
        },
      });
      await worker.processTurn(await worker.claimTurn(accepted.turn.turnId));
      const state = await snapshot(
        await models.ChatTurn.findOne({ turnId: accepted.turn.turnId }),
      );
      if (useFile) {
        assert.equal(state.assistantMessage.fileResult.status, "ready");
        assert.equal(
          (
            await store.read(
              user._id,
              state.assistantMessage.attachments[0].fileId,
            )
          ).buffer.toString(),
          "hello from file",
        );
      } else {
        assert.equal(state.assistantMessage.content, "Hello from chat");
        assert.equal(state.assistantMessage.attachments.length, 0);
      }
      assert.equal(
        await models.ChatBillingLedger.countDocuments({
          turnId: accepted.turn.turnId,
        }),
        1,
      );
    }
    assert.equal(calls, 2);
  },
);
test(
  "Office result recovery persists one binary file, preview and charge",
  { skip: !uri },
  async () => {
    const content = JSON.stringify({
      sheets: [
        {
          name: "Дані",
          rows: [
            ["Товар", "Сума"],
            ["Яблука", 42],
          ],
        },
      ],
    });
    const { turn } = await fixture(content, "report.xlsx");
    await models.ChatTurn.updateOne(
      { turnId: turn.turnId },
      { leaseUntil: new Date(0) },
    );
    await worker.recoverExpired();
    await worker.recoverExpired();
    const completed = await models.ChatTurn.findOne({ turnId: turn.turnId });
    assert.equal(completed.status, "completed");
    const state = await snapshot(completed),
      id = state.assistantMessage.attachments[0].fileId;
    const result = await store.read(user._id, id);
    assert.equal(result.buffer.subarray(0, 2).toString(), "PK");
    assert.equal(result.file.generatedPreview.kind, "workbook");
    assert.equal(
      await File.countDocuments({ resultKey: `${turn.turnId}:1:0` }),
      1,
    );
    assert.equal(
      await models.ChatBillingLedger.countDocuments({ turnId: turn.turnId }),
      1,
    );
  },
);
test(
  "invalid document manifest fails explicitly and settles billing once",
  { skip: !uri },
  async () => {
    const { turn, leaseToken, usage } = await fixture(
      "not a document manifest",
      "report.pdf",
    );
    const result = await worker.commitCompletion(
      turn,
      leaseToken,
      "Done",
      usage,
    );
    assert.equal(result.assistant.fileResult.status, "failed");
    assert.equal(result.assistant.fileResult.error, "INVALID_DOCUMENT_JSON");
    assert.equal(
      await File.countDocuments({ resultKey: `${turn.turnId}:1:0` }),
      0,
    );
    assert.equal(
      await models.ChatBillingLedger.countDocuments({ turnId: turn.turnId }),
      1,
    );
  },
);

test(
  "file output opt-out blocks create_file while preserving optional Python calculations",
  { skip: !uri },
  async (t) => {
    const { Completions } = require("openai/resources/chat/completions");
    await models.ChatModels.updateOne(
      { modelId },
      { $set: { fileOutputEnabled: false } },
    );
    try {
      const payload = {
        clientMessageId: crypto.randomUUID(),
        conversationId: conversation.id,
        modelId,
        message: "Hello",
        files: [],
      };
      await assert.rejects(
        accept({
          userId: user._id,
          payload: { ...payload, outputFile: { filename: "blocked.txt" } },
        }),
        (e) => e.protocolError?.code === "MODEL_NOT_AVAILABLE",
      );
      let calls = 0;
      t.mock.method(Completions.prototype, "create", async function* (request) {
        calls++;
        const toolNames = (request.tools || []).map(tool => tool.function.name);
        const computeEnabled = process.env.COMPUTE_V2_ENABLED === "true";
        assert.deepEqual(toolNames, computeEnabled ? ["run_python"] : []);
        if (computeEnabled) {
          assert.match(request.messages[0].content, /File exports are disabled for this model/);
          assert.match(request.messages[0].content, /exports: \[\]/);
        }
        yield {
          choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }],
        };
        yield {
          choices: [],
          usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
        };
      });
      const accepted = await accept({ userId: user._id, payload });
      await worker.processTurn(await worker.claimTurn(accepted.turn.turnId));
      assert.equal(calls, 1);
      assert.equal(
        (await models.ChatTurn.findOne({ turnId: accepted.turn.turnId }))
          .status,
        "completed",
      );
    } finally {
      await models.ChatModels.updateOne(
        { modelId },
        { $unset: { fileOutputEnabled: 1 } },
      );
    }
  },
);

test(
  "text attachment reaches provider, survives retry/history, generates a file and is billed once per attempt",
  { skip: !uri },
  async (t) => {
    const { Completions } = require("openai/resources/chat/completions");
    const retry = require("../../src/services/chatDeliveryV2/retryTurn");
    const chat = await models.ChatConversation.create({
      user: user._id,
      modelId,
    });
    const input = await store.create({
      user: user._id,
      name: "дані.csv",
      mimetype: "text/plain",
      buffer: Buffer.from("Товар,Кількість\nЯблука,42\nГруші,7"),
    });
    const payload = {
      clientMessageId: crypto.randomUUID(),
      conversationId: chat.id,
      modelId,
      message: "Підсумуй файл",
      files: [
        {
          fileId: String(input._id),
          storage: "private",
          originalName: "forged",
          url: "https://evil.test",
        },
      ],
    };
    const accepted = await accept({ userId: user._id, payload });
    const baseline = await require("../../src/utils/estimateCost")(
      modelId,
      require("../../src/utils/tokenEstimate")(payload.message),
    );
    assert.ok(accepted.turn.reservedAppTokens > baseline.appTokens);
    assert.equal((await File.findById(input._id)).expiresAt, null);
    assert.equal(
      (await accept({ userId: user._id, payload })).disposition,
      "duplicate",
    );
    let rejectOnce = true,
      deleted = false,
      calls = 0;
    t.mock.method(Completions.prototype, "create", async function* (request) {
      calls++;
      const parts = request.messages
        .filter((m) => m.role === "user")
        .flatMap((m) => m.content);
      if (deleted) {
        assert.ok(parts.some((p) => p.text?.includes("no longer available")));
        assert.equal(
          parts.some((p) => p.text?.includes("Яблука")),
          false,
        );
      } else {
        assert.ok(
          request.messages[0].content.includes(
            require("../../src/services/files/textInput").instructions,
          ),
          "Provider request must include the full attachment instructions",
        );

        assert.ok(
          parts.some(
            (p) => p.text?.includes("Яблука") && p.text.includes("дані.csv"),
          ),
        );
        assert.doesNotMatch(JSON.stringify(parts), /forged|evil\.test/);
      }
      if (rejectOnce) {
        rejectOnce = false;
        throw Object.assign(new Error("rate limit"), { status: 429 });
      }
      const args = JSON.stringify({
        filename: "summary.txt",
        content: "Яблука 42, груші 7",
        summary: "Готово",
      });
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: "create_file", arguments: args },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
      yield {
        choices: [],
        usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
      };
    });
    await worker.processTurn(await worker.claimTurn(accepted.turn.turnId));
    const failed = await models.ChatTurn.findOne({
      turnId: accepted.turn.turnId,
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.reservationState, "released");
    const retried = await retry({
      userId: user._id,
      turnId: accepted.turn.turnId,
    });
    assert.equal(retried.reservedAppTokens, accepted.turn.reservedAppTokens);
    await worker.processTurn(await worker.claimTurn(accepted.turn.turnId));
    const completed = await models.ChatTurn.findOne({
      turnId: accepted.turn.turnId,
    });
    assert.equal(completed.status, "completed");
    assert.equal(
      await models.ChatBillingLedger.countDocuments({
        turnId: completed.turnId,
      }),
      1,
    );
    const restored = await snapshot(completed);
    assert.equal(
      (
        await store.read(
          user._id,
          restored.assistantMessage.attachments[0].fileId,
        )
      ).buffer.toString(),
      "Яблука 42, груші 7",
    );
    const follow = await accept({
      userId: user._id,
      payload: {
        ...payload,
        clientMessageId: crypto.randomUUID(),
        files: [],
        message: "Нагадай дані",
      },
    });
    assert.ok(follow.turn.reservedAppTokens > baseline.appTokens);
    await worker.processTurn(await worker.claimTurn(follow.turn.turnId));
    assert.equal(
      (await models.ChatTurn.findOne({ turnId: follow.turn.turnId })).status,
      "completed",
    );
    await store.remove(user._id, String(input._id));
    deleted = true;
    const last = await accept({
      userId: user._id,
      payload: { ...payload, clientMessageId: crypto.randomUUID(), files: [] },
    });
    await worker.processTurn(await worker.claimTurn(last.turn.turnId));
    assert.equal(
      (await models.ChatTurn.findOne({ turnId: last.turn.turnId })).status,
      "completed",
    );
    assert.equal(calls, 4);
  },
);

test(
  "invalid, oversized, foreign and disabled text inputs create no turn or reservation",
  { skip: !uri },
  async () => {
    const chat = await models.ChatConversation.create({
      user: user._id,
      modelId,
    });
    const before = await models.User.findById(user._id);
    for (const [name, buffer, expected] of [
      ["large.txt", Buffer.alloc(65537, 65), "TEXT_ATTACHMENT_TOO_LARGE"],
      ["bad.txt", Buffer.from([255]), "INVALID_UTF8"],
      ["binary.txt", Buffer.from("a\0b"), "INVALID_TEXT"],
    ]) {
      const file = await store.create({
        user: user._id,
        name,
        mimetype: "text/plain",
        buffer,
      });
      const payload = {
        clientMessageId: crypto.randomUUID(),
        conversationId: chat.id,
        modelId,
        message: "Read",
        files: [{ fileId: String(file._id), storage: "private" }],
      };
      await assert.rejects(
        accept({ userId: user._id, payload }),
        (e) => e.fileError === expected,
      );
      assert.equal(
        await models.ChatTurn.countDocuments({
          clientMessageId: payload.clientMessageId,
        }),
        0,
      );
      assert.notEqual((await File.findById(file._id)).expiresAt, null);
      await store.remove(user._id, String(file._id));
    }
    const foreign = await store.create({
      user: new mongoose.Types.ObjectId(),
      name: "private.txt",
      mimetype: "text/plain",
      buffer: Buffer.from("secret"),
    });
    await assert.rejects(
      accept({
        userId: user._id,
        payload: {
          clientMessageId: crypto.randomUUID(),
          conversationId: chat.id,
          modelId,
          message: "Read",
          files: [{ fileId: String(foreign._id), storage: "private" }],
        },
      }),
      (e) => e.fileError === "FILE_NOT_FOUND",
    );
    const own = await store.create({
      user: user._id,
      name: "own.txt",
      mimetype: "text/plain",
      buffer: Buffer.from("hello"),
    });
    await models.ChatModels.updateOne(
      { modelId },
      { $set: { textInputEnabled: false } },
    );
    try {
      await assert.rejects(
        accept({
          userId: user._id,
          payload: {
            clientMessageId: crypto.randomUUID(),
            conversationId: chat.id,
            modelId,
            message: "Read",
            files: [{ fileId: String(own._id), storage: "private" }],
          },
        }),
        (e) => e.fileError === "TEXT_INPUT_DISABLED",
      );
    } finally {
      await models.ChatModels.updateOne(
        { modelId },
        { $unset: { textInputEnabled: 1 } },
      );
    }
    const after = await models.User.findById(user._id);
    assert.equal(after.reservedAppTokens, before.reservedAppTokens);
    assert.equal(after.appTokens, before.appTokens);
  },
);

test(
  "aggregate text budget and attachment reserve reject before admission without retaining uploads",
  { skip: !uri },
  async () => {
    const poor = await models.User.create({
      email: "text-budget@example.test",
      name: "Budget",
      status: "active",
      appTokens: 0,
    });
    const chat = await models.ChatConversation.create({
      user: poor._id,
      modelId,
    });
    const input = await store.create({
      user: poor._id,
      name: "large.txt",
      mimetype: "text/plain",
      buffer: Buffer.alloc(65536, 65),
    });
    const payload = {
      clientMessageId: crypto.randomUUID(),
      conversationId: chat.id,
      modelId,
      message: "Read",
      files: [{ storage: "private", fileId: String(input._id) }],
    };
    await assert.rejects(
      accept({
        userId: poor._id,
        payload: { ...payload, files: Array(3).fill(payload.files[0]) },
      }),
      (e) => e.fileError === "TEXT_ATTACHMENTS_CONTEXT_TOO_LARGE",
    );
    await assert.rejects(
      accept({ userId: poor._id, payload }),
      (e) => e.protocolError?.code === "INSUFFICIENT_BALANCE",
    );
    assert.equal(await models.ChatTurn.countDocuments({ user: poor._id }), 0);
    assert.notEqual((await File.findById(input._id)).expiresAt, null);
    assert.equal(
      (await models.User.findById(poor._id)).reservedAppTokens || 0,
      0,
    );
  },
);

test(
  "DOCX/XLSX private input reaches provider, retries once, restores history and bills once",
  { skip: !uri },
  async (t) => {
    const fixtures = require("./fixtures/officeInput");
    const { Completions } = require("openai/resources/chat/completions");
    const retry = require("../../src/services/chatDeliveryV2/retryTurn");
    const chat = await models.ChatConversation.create({
      user: user._id,
      modelId,
    });
    const inputs = [];
    for (const ext of ["docx", "xlsx"])
      inputs.push(
        await store.create({
          user: user._id,
          name: `дані.${ext}`,
          mimetype: "application/octet-stream",
          buffer: await fixtures[ext](),
        }),
      );
    const payload = {
      clientMessageId: crypto.randomUUID(),
      conversationId: chat.id,
      modelId,
      message: "Порівняй документи",
      files: inputs.map((f) => ({
        fileId: String(f._id),
        storage: "private",
        url: "https://forged.test",
      })),
    };
    const accepted = await accept({ userId: user._id, payload });
    assert.equal(
      (await accept({ userId: user._id, payload })).disposition,
      "duplicate",
    );
    const baseline = await require("../../src/utils/estimateCost")(
      modelId,
      require("../../src/utils/tokenEstimate")(payload.message),
    );
    assert.ok(accepted.turn.reservedAppTokens > baseline.appTokens);
    let calls = 0;
    t.mock.method(Completions.prototype, "create", async function* (request) {
      calls++;
      const parts = request.messages
        .filter((m) => m.role === "user")
        .flatMap((m) => m.content);
      const text = JSON.stringify(parts);
      assert.match(text, /дані.docx/);
      assert.match(text, /дані.xlsx/);
      assert.match(text, /Україна/);
      assert.match(text, /SUM/);
      assert.match(text, /not recalculated/);
      assert.doesNotMatch(text, /forged\.test/);
      if (calls === 1)
        throw Object.assign(new Error("rate limited"), { status: 429 });
      yield {
        choices: [{ delta: { content: "Яблука: 42" }, finish_reason: "stop" }],
      };
      yield {
        choices: [],
        usage: { prompt_tokens: 150, completion_tokens: 20, total_tokens: 170 },
      };
    });
    await worker.processTurn(await worker.claimTurn(accepted.turn.turnId));
    assert.equal(
      (await models.ChatTurn.findOne({ turnId: accepted.turn.turnId }))
        .reservationState,
      "released",
    );
    const retried = await retry({
      userId: user._id,
      turnId: accepted.turn.turnId,
    });
    assert.equal(retried.reservedAppTokens, accepted.turn.reservedAppTokens);
    await worker.processTurn(await worker.claimTurn(accepted.turn.turnId));
    const completed = await models.ChatTurn.findOne({
      turnId: accepted.turn.turnId,
    });
    assert.equal(completed.status, "completed");
    assert.equal(
      await models.ChatBillingLedger.countDocuments({
        turnId: completed.turnId,
      }),
      1,
    );
    const message = await models.ChatMessage.findById(completed.userMessage);
    assert.equal(message.attachments.length, 2);
    const follow = await accept({
      userId: user._id,
      payload: {
        ...payload,
        clientMessageId: crypto.randomUUID(),
        files: [],
        message: "Нагадай значення",
      },
    });
    await worker.processTurn(await worker.claimTurn(follow.turn.turnId));
    assert.equal(
      (await models.ChatTurn.findOne({ turnId: follow.turn.turnId })).status,
      "completed",
    );
    assert.equal(calls, 3);
    for (const file of inputs)
      assert.equal((await File.findById(file._id)).expiresAt, null);
  },
);

test(
  "Office rejection rolls back retention, turn and reservation; opt-out and owner checks apply",
  { skip: !uri },
  async () => {
    const fixtures = require("./fixtures/officeInput");
    const chat = await models.ChatConversation.create({
      user: user._id,
      modelId,
    });
    const before = await models.User.findById(user._id);
    const valid = await store.create({
      user: user._id,
      name: "valid.docx",
      mimetype: "application/octet-stream",
      buffer: await fixtures.docx(),
    });
    const invalid = await store.create({
      user: user._id,
      name: "bad.xlsx",
      mimetype: "application/octet-stream",
      buffer: Buffer.from("PK invalid"),
    });
    const send = async (files, expected) => {
      const payload = {
        clientMessageId: crypto.randomUUID(),
        conversationId: chat.id,
        modelId,
        message: "Read",
        files: files.map((f) => ({
          fileId: String(f._id),
          storage: "private",
        })),
      };
      await assert.rejects(
        accept({ userId: user._id, payload }),
        (e) => e.fileError === expected,
      );
      assert.equal(
        await models.ChatTurn.countDocuments({
          clientMessageId: payload.clientMessageId,
        }),
        0,
      );
    };
    await send([valid, invalid], "INVALID_OFFICE_DOCUMENT");
    assert.notEqual((await File.findById(valid._id)).expiresAt, null);
    const foreign = await store.create({
      user: new mongoose.Types.ObjectId(),
      name: "foreign.docx",
      mimetype: "application/octet-stream",
      buffer: await fixtures.docx(),
    });
    await send([foreign], "FILE_NOT_FOUND");
    await models.ChatModels.updateOne(
      { modelId },
      { $set: { officeInputEnabled: false } },
    );
    try {
      await send([valid], "OFFICE_INPUT_DISABLED");
    } finally {
      await models.ChatModels.updateOne(
        { modelId },
        { $unset: { officeInputEnabled: 1 } },
      );
    }
    const large = await store.create({
      user: user._id,
      name: "large.docx",
      mimetype: "application/octet-stream",
      buffer: await fixtures.docx("A".repeat(60000)),
    });
    await send([large, large, large], "TEXT_ATTACHMENTS_CONTEXT_TOO_LARGE");
    const after = await models.User.findById(user._id);
    assert.equal(after.reservedAppTokens, before.reservedAppTokens);
    assert.equal(after.appTokens, before.appTokens);
  },
);

test(
  "PDF private input reaches provider with page markers, retries and restores history with one debit",
  { skip: !uri },
  async (t) => {
    const { makePdf } = require("./fixtures/pdfInput");
    const { Completions } = require("openai/resources/chat/completions");
    const retry = require("../../src/services/chatDeliveryV2/retryTurn");
    const chat = await models.ChatConversation.create({
      user: user._id,
      modelId,
    });
    const input = await store.create({
      user: user._id,
      name: "звіт.pdf",
      mimetype: "application/pdf",
      buffer: await makePdf(),
    });
    const payload = {
      clientMessageId: crypto.randomUUID(),
      conversationId: chat.id,
      modelId,
      message: "Підсумуй сторінки",
      files: [
        {
          fileId: String(input._id),
          storage: "private",
          url: "https://forged.test",
        },
      ],
    };
    const accepted = await accept({ userId: user._id, payload });
    assert.equal(
      (await accept({ userId: user._id, payload })).disposition,
      "duplicate",
    );
    const baseline = await require("../../src/utils/estimateCost")(
      modelId,
      require("../../src/utils/tokenEstimate")(payload.message),
    );
    assert.ok(accepted.turn.reservedAppTokens > baseline.appTokens);
    let calls = 0,
      deleted = false;
    t.mock.method(Completions.prototype, "create", async function* (request) {
      calls++;
      const parts = JSON.stringify(
        request.messages.filter((m) => m.role === "user"),
      );
      if (deleted) {
        assert.match(parts, /no longer available/);
        assert.doesNotMatch(parts, /Україна/);
      } else {
        assert.match(parts, /звіт.pdf/);
        assert.match(parts, /Україна/);
        assert.match(parts, /PDF PAGE 2 OF 2/);
        assert.match(parts, /731/);
      }
      assert.doesNotMatch(parts, /forged.test/);
      if (calls === 1)
        throw Object.assign(new Error("rate limited"), { status: 429 });
      yield {
        choices: [
          { delta: { content: "Сторінка 2: 731" }, finish_reason: "stop" },
        ],
      };
      yield {
        choices: [],
        usage: { prompt_tokens: 150, completion_tokens: 20, total_tokens: 170 },
      };
    });
    await worker.processTurn(await worker.claimTurn(accepted.turn.turnId));
    assert.equal(
      (await models.ChatTurn.findOne({ turnId: accepted.turn.turnId }))
        .reservationState,
      "released",
    );
    const retried = await retry({
      userId: user._id,
      turnId: accepted.turn.turnId,
    });
    assert.equal(retried.reservedAppTokens, accepted.turn.reservedAppTokens);
    await worker.processTurn(await worker.claimTurn(accepted.turn.turnId));
    const completed = await models.ChatTurn.findOne({
      turnId: accepted.turn.turnId,
    });
    assert.equal(completed.status, "completed");
    assert.equal(
      await models.ChatBillingLedger.countDocuments({
        turnId: completed.turnId,
      }),
      1,
    );
    assert.equal(
      (await models.ChatMessage.findById(completed.userMessage)).attachments[0]
        .originalName,
      "звіт.pdf",
    );
    assert.equal((await File.findById(input._id)).expiresAt, null);
    const follow = await accept({
      userId: user._id,
      payload: {
        ...payload,
        clientMessageId: crypto.randomUUID(),
        files: [],
        message: "Нагадай число",
      },
    });
    await worker.processTurn(await worker.claimTurn(follow.turn.turnId));
    assert.equal(
      (await models.ChatTurn.findOne({ turnId: follow.turn.turnId })).status,
      "completed",
    );
    await store.remove(user._id, String(input._id));
    deleted = true;
    const last = await accept({
      userId: user._id,
      payload: { ...payload, clientMessageId: crypto.randomUUID(), files: [] },
    });
    await worker.processTurn(await worker.claimTurn(last.turn.turnId));
    assert.equal(
      (await models.ChatTurn.findOne({ turnId: last.turn.turnId })).status,
      "completed",
    );
    assert.equal(calls, 4);
  },
);

test(
  "PDF scans, corruption, size, opt-out and foreign files reject without turn, retention or reserve",
  { skip: !uri },
  async () => {
    const { makePdf } = require("./fixtures/pdfInput");
    const chat = await models.ChatConversation.create({
      user: user._id,
      modelId,
    });
    const before = await models.User.findById(user._id);
    const valid = await store.create({
      user: user._id,
      name: "valid.pdf",
      mimetype: "application/pdf",
      buffer: await makePdf(),
    });
    const send = async (files, expected) => {
      const payload = {
        clientMessageId: crypto.randomUUID(),
        conversationId: chat.id,
        modelId,
        message: "Read",
        files: files.map((f) => ({
          fileId: String(f._id),
          storage: "private",
        })),
      };
      await assert.rejects(
        accept({ userId: user._id, payload }),
        (e) => e.fileError === expected,
      );
      assert.equal(
        await models.ChatTurn.countDocuments({
          clientMessageId: payload.clientMessageId,
        }),
        0,
      );
      assert.notEqual((await File.findById(valid._id)).expiresAt, null);
    };
    for (const [buffer, expected] of [
      [await makePdf([""]), "PDF_OCR_REQUIRED"],
      [Buffer.from("%PDF-1.7\ninvalid"), "INVALID_PDF_DOCUMENT"],
      [Buffer.alloc(5 * 1024 * 1024 + 1), "PDF_ATTACHMENT_TOO_LARGE"],
      [
        await makePdf(["secret"], { userPassword: "secret" }),
        "PDF_PASSWORD_PROTECTED",
      ],
    ]) {
      const file = await store.create({
        user: user._id,
        name: "bad.pdf",
        mimetype: "application/pdf",
        buffer,
      });
      await send([valid, file], expected);
    }
    const foreign = await store.create({
      user: new mongoose.Types.ObjectId(),
      name: "foreign.pdf",
      mimetype: "application/pdf",
      buffer: await makePdf(),
    });
    await send([foreign], "FILE_NOT_FOUND");
    await models.ChatModels.updateOne(
      { modelId },
      { $set: { pdfInputEnabled: false } },
    );
    try {
      await send([valid], "PDF_INPUT_DISABLED");
    } finally {
      await models.ChatModels.updateOne(
        { modelId },
        { $unset: { pdfInputEnabled: 1 } },
      );
    }
    const text = await store.create({
      user: user._id,
      name: "full.txt",
      mimetype: "text/plain",
      buffer: Buffer.alloc(65536, 65),
    });
    await send([valid, text, text], "TEXT_ATTACHMENTS_CONTEXT_TOO_LARGE");
    const after = await models.User.findById(user._id);
    assert.equal(after.reservedAppTokens, before.reservedAppTokens);
    assert.equal(after.appTokens, before.appTokens);
  },
);

const enableOcr = (t) => {
  process.env.OCR_ENABLED = "true";
  process.env.OCR_LANGUAGES = "eng";
  t.after(() => {
    process.env.OCR_ENABLED = "false";
  });
};
test(
  "OCR scan cache survives reread, preserves reserve/retry/history and commits one debit",
  { skip: !uri },
  async (t) => {
    enableOcr(t);
    const { makeScan } = require("./fixtures/ocr");
    const { Completions } = require("openai/resources/chat/completions");
    const processOcr = require("../../src/services/files/ocrProcess");
    const realExtract = processOcr.extract;
    let extractions = 0;
    t.mock.method(processOcr, "extract", (...args) => {
      extractions++;
      return realExtract(...args);
    });
    const chat = await models.ChatConversation.create({
      user: user._id,
      modelId,
    });
    const input = await store.create({
      user: user._id,
      name: "private-scan.pdf",
      mimetype: "application/pdf",
      buffer: await makeScan(),
    });
    const payload = {
      clientMessageId: crypto.randomUUID(),
      conversationId: chat.id,
      modelId,
      message: "Read scanned invoice",
      files: [
        { fileId: input.id, storage: "private", url: "https://forged.test" },
      ],
    };
    const accepted = await accept({ userId: user._id, payload });
    assert.equal(
      (await accept({ userId: user._id, payload })).disposition,
      "duplicate",
    );
    const persisted = await File.findById(input._id).lean();
    assert.match(persisted.ocrCache.text, /731/);
    assert.ok(persisted.derivedBytes > 0);
    const baseline = await require("../../src/utils/estimateCost")(
      modelId,
      require("../../src/utils/tokenEstimate")(payload.message),
    );
    const state =
      await require("../../src/services/files/textContext").estimate(
        user._id,
        [{ role: "user", attachments: accepted.turn.files }],
        {},
        null,
      );
    assert.equal(
      accepted.turn.reservedAppTokens,
      baseline.appTokens +
        require("../../src/services/files/textInput").reserveAmount(
          state.promptBytes + require("../../src/services/files/exactTranscription").reserveBytes,
          1,
          require("../../src/config/billing").APP_TOKEN_VALUE_USD,
        ),
    );
    let calls = 0;
    t.mock.method(Completions.prototype, "create", async function* (request) {
      calls++;
      const content = JSON.stringify(request.messages);
      assert.match(content, /731/);
      assert.match(content, /PDF PAGE 1 OF 1/);
      assert.doesNotMatch(content, /forged.test/);
      if (calls === 1)
        throw Object.assign(new Error("rate limited"), { status: 429 });
      yield {
        choices: [{ delta: { content: "Invoice 731" }, finish_reason: "stop" }],
      };
      yield {
        choices: [],
        usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 },
      };
    });
    await worker.processTurn(await worker.claimTurn(accepted.turn.turnId));
    const retried =
      await require("../../src/services/chatDeliveryV2/retryTurn")({
        userId: user._id,
        turnId: accepted.turn.turnId,
      });
    assert.equal(retried.reservedAppTokens, accepted.turn.reservedAppTokens);
    await worker.processTurn(await worker.claimTurn(accepted.turn.turnId));
    assert.equal(
      (await models.ChatTurn.findOne({ turnId: accepted.turn.turnId })).status,
      "completed",
    );
    assert.equal(
      await models.ChatBillingLedger.countDocuments({
        turnId: accepted.turn.turnId,
      }),
      1,
    );
    const follow = await accept({
      userId: user._id,
      payload: {
        ...payload,
        clientMessageId: crypto.randomUUID(),
        files: [],
        message: "Recall invoice",
      },
    });
    await worker.processTurn(await worker.claimTurn(follow.turn.turnId));
    assert.equal(extractions, 1);
    assert.equal(calls, 3);
  },
);
test(
  "OCR concurrent preparation claims derived quota once; delete and expiry clear it",
  { skip: !uri },
  async (t) => {
    enableOcr(t);
    const ocr = require("../../src/services/files/ocrInput");
    const { makeImage } = require("./fixtures/ocr");
    const before = await Quota.findById(user._id).lean();
    const input = await store.create({
      user: user._id,
      name: "scan.png",
      mimetype: "image/png",
      buffer: makeImage(),
    });
    await Promise.all([
      ocr.prepare(user._id, input.id, {}),
      ocr.prepare(user._id, input.id, {}),
    ]);
    const cached = await File.findById(input._id).lean();
    assert.equal(
      (await Quota.findById(user._id)).bytes,
      before.bytes + input.size + cached.derivedBytes,
    );
    await store.remove(user._id, input.id);
    await store.remove(user._id, input.id);
    assert.equal((await Quota.findById(user._id)).bytes, before.bytes);
    assert.equal((await File.findById(input._id)).ocrCache, null);
    const expired = await store.create({
      user: user._id,
      name: "expiry.png",
      mimetype: "image/png",
      buffer: makeImage(),
    });
    await ocr.prepare(user._id, expired.id, {});
    await File.updateOne({ _id: expired._id }, { expiresAt: new Date(0) });
    await store.cleanup();
    assert.equal((await File.findById(expired._id)).ocrCache, null);
    assert.equal((await Quota.findById(user._id)).bytes, before.bytes);
  },
);
test(
  "OCR rejection creates no turn or reservation and foreign/disabled files are not processed",
  { skip: !uri },
  async (t) => {
    enableOcr(t);
    const { makeScan } = require("./fixtures/ocr");
    const chat = await models.ChatConversation.create({
      user: user._id,
      modelId,
    });
    const before = await models.User.findById(user._id);
    for (const [buffer, expected] of [
      [await makeScan([""]), "OCR_NO_TEXT"],
      [
        await makeScan(["secret"], { userPassword: "secret" }),
        "PDF_PASSWORD_PROTECTED",
      ],
      [Buffer.alloc(5 * 1024 * 1024 + 1), "OCR_FILE_TOO_LARGE"],
    ]) {
      const file = await store.create({
        user: user._id,
        name: "scan.pdf",
        mimetype: "application/pdf",
        buffer,
      });
      const payload = {
        clientMessageId: crypto.randomUUID(),
        conversationId: chat.id,
        modelId,
        message: "Read",
        files: [{ fileId: file.id, storage: "private" }],
      };
      await assert.rejects(accept({ userId: user._id, payload }), {
        fileError: expected,
      });
      assert.equal(
        await models.ChatTurn.countDocuments({
          clientMessageId: payload.clientMessageId,
        }),
        0,
      );
      const record = await File.findById(file._id);
      assert.notEqual(record.expiresAt, null);
      assert.equal(record.ocrCache, null);
    }
    const foreign = await store.create({
      user: new mongoose.Types.ObjectId(),
      name: "foreign.pdf",
      mimetype: "application/pdf",
      buffer: await makeScan(),
    });
    await assert.rejects(
      require("../../src/services/files/ocrInput").prepare(
        user._id,
        foreign.id,
        {},
      ),
      { fileError: "FILE_NOT_FOUND" },
    );
    const disabled = await store.create({
      user: user._id,
      name: "disabled.pdf",
      mimetype: "application/pdf",
      buffer: await makeScan(),
    });
    await require("../../src/services/files/ocrInput").prepare(
      user._id,
      disabled.id,
      { ocrInputEnabled: false },
    );
    assert.equal((await File.findById(disabled._id)).ocrCache, null);
    const after = await models.User.findById(user._id);
    assert.equal(after.appTokens, before.appTokens);
    assert.equal(after.reservedAppTokens, before.reservedAppTokens);
  },
);
test(
  "OCR context overflow and insufficient reserve never admit or bill a turn",
  { skip: !uri },
  async (t) => {
    enableOcr(t);
    const { makeScan } = require("./fixtures/ocr");
    const chat = await models.ChatConversation.create({
      user: user._id,
      modelId,
    });
    const input = await store.create({
      user: user._id,
      name: "invoice.pdf",
      mimetype: "application/pdf",
      buffer: await makeScan(),
    });
    const full = await store.create({
      user: user._id,
      name: "full.txt",
      mimetype: "text/plain",
      buffer: Buffer.alloc(65536, 65),
    });
    const payload = {
      clientMessageId: crypto.randomUUID(),
      conversationId: chat.id,
      modelId,
      message: "Read",
      files: [input, full, full].map((f) => ({
        fileId: f.id,
        storage: "private",
      })),
    };
    const before = await models.User.findById(user._id).lean();
    await assert.rejects(accept({ userId: user._id, payload }), {
      fileError: "TEXT_ATTACHMENTS_CONTEXT_TOO_LARGE",
    });
    assert.equal(
      await models.ChatTurn.countDocuments({
        clientMessageId: payload.clientMessageId,
      }),
      0,
    );
    assert.notEqual((await File.findById(input._id)).expiresAt, null);
    const after = await models.User.findById(user._id).lean();
    assert.equal(after.appTokens, before.appTokens);
    assert.equal(after.reservedAppTokens, before.reservedAppTokens);
    const poor = await models.User.create({
      email: "ocr-poor@example.test",
      name: "Poor",
      status: "active",
      appTokens: 0,
    });
    const poorChat = await models.ChatConversation.create({
      user: poor._id,
      modelId,
    });
    const poorFile = await store.create({
      user: poor._id,
      name: "scan.pdf",
      mimetype: "application/pdf",
      buffer: await makeScan(),
    });
    const request = {
      ...payload,
      clientMessageId: crypto.randomUUID(),
      conversationId: poorChat.id,
      files: [{ fileId: poorFile.id, storage: "private" }],
    };
    await assert.rejects(
      accept({ userId: poor._id, payload: request }),
      (e) => e.protocolError?.code === "INSUFFICIENT_BALANCE",
    );
    assert.equal(
      await models.ChatTurn.countDocuments({
        clientMessageId: request.clientMessageId,
      }),
      0,
    );
    assert.equal(
      await models.ChatBillingLedger.countDocuments({ user: poor._id }),
      0,
    );
    assert.notEqual((await File.findById(poorFile._id)).expiresAt, null);
  },
);
test(
  "international OCR policy and per-page choices persist privately and are reused",
  { skip: !uri },
  async (t) => {
    enableOcr(t);
    process.env.OCR_LANGUAGES = "auto";
    t.after(() => {
      process.env.OCR_LANGUAGES = "eng";
    });
    const bytes = require("node:fs").readFileSync(
      require("node:path").join(
        __dirname,
        "fixtures/international/cyrillic.png",
      ),
    );
    const file = await store.create({
      user: user._id,
      name: "international.png",
      mimetype: "image/png",
      buffer: bytes,
    });
    const ocr = require("../../src/services/files/ocrInput");
    await ocr.prepare(user._id, file.id, {});
    const saved = await File.findById(file._id).lean();
    assert.equal(saved.ocrCache.version, 3);
    assert.equal(saved.ocrCache.languages, "auto");
    assert.equal(saved.ocrCache.detections[0].script, "Cyrillic");
    assert.match(saved.ocrCache.text, /Україна/);
    assert.ok(saved.derivedBytes > Buffer.byteLength(saved.ocrCache.text));
    t.mock.method(
      require("../../src/services/files/ocrProcess"),
      "extract",
      () => {
        throw new Error("must reuse existing cache");
      },
    );
    await ocr.prepare(user._id, file.id, {});
    assert.deepEqual(
      (await File.findById(file._id).lean()).ocrCache,
      saved.ocrCache,
    );
    assert.equal("ocrCache" in store.dto(saved), false);
    await store.remove(user._id, file.id);
  },
);

for (const oldVersion of [2, 3]) test(
  `v${oldVersion} OCR cache upgrades quality once with an atomic quota delta and normal deletion`,
  { skip: !uri },
  async (t) => {
    enableOcr(t);
    const { makeImage } = require("./fixtures/ocr");
    const ocr = require("../../src/services/files/ocrInput");
    let calls = 0;
    t.mock.method(
      require("../../src/services/files/ocrProcess"),
      "extract",
      async () => ({
        text:
          ++calls === 1
            ? "old text"
            : "new longer text with original numbers 15.40.2026",
        pages: 1,
        languages: "eng",
        detections: [],
      }),
    );
    const before = (await Quota.findById(user._id)).bytes;
    const file = await store.create({
      user: user._id,
      name: "upgrade.png",
      mimetype: "image/png",
      buffer: makeImage(),
    });
    await ocr.prepare(user._id, file.id, {});
    await File.updateOne(
      { _id: file._id },
      { $set: { "ocrCache.version": oldVersion }, $unset: { "ocrCache.qualityRevision": 1 } },
    );
    const old = await File.findById(file._id).lean(),
      oldQuota = (await Quota.findById(user._id)).bytes;
    await Promise.all([
      ocr.prepare(user._id, file.id, {}),
      ocr.prepare(user._id, file.id, {}),
    ]);
    const current = await File.findById(file._id).lean();
    assert.equal(calls, 2);
    assert.equal(current.ocrCache.version, 3);
    assert.equal(current.ocrCache.qualityRevision, 1);
    assert.match(current.ocrCache.text, /15\.40\.2026/);
    assert.equal(
      (await Quota.findById(user._id)).bytes - oldQuota,
      current.derivedBytes - old.derivedBytes,
    );
    await ocr.prepare(user._id, file.id, {});
    assert.equal(calls, 2);
    await store.remove(user._id, file.id);
    assert.equal((await Quota.findById(user._id)).bytes, before);
  },
);

test('exact transcription uses cached bytes, multilingual intent tool, recovery and provider-only billing', { skip: !uri }, async t => {
  process.env.OCR_ENABLED = 'true';
  t.after(() => { process.env.OCR_ENABLED = 'false'; });
  const Completions = require('openai/resources/chat/completions').Completions;
  const exact = require('../../src/services/files/exactTranscription');
  const input = await store.create({ user: user._id, name: 'scan.png', mimetype: 'image/png', buffer: require('./fixtures/ocr').makeImage() });
  const text = '[PDF PAGE 1 OF 1 — OCR]\n4 462,64\n123\n3 501,601\n```\n<script>x</script>\nשלום';
  await File.updateOne({ _id: input._id }, { $set: { ocrCache: { version: 3, qualityRevision: 1, checksum: input.checksum, text, pages: 1, detections: [] } } });
  let calls = 0;
  t.mock.method(Completions.prototype, 'create', async function* (request) {
    calls++;
    assert.ok(request.tools.some(tool => tool.function.name === exact.NAME));
    assert.equal(request.parallel_tool_calls, false);
    // Even unwanted prose emitted before the tool must never enter the final transcription.
    yield { choices: [{ delta: { content: 'Wrong: 4 462,68' } }] };
    yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: exact.NAME, arguments: JSON.stringify({ fileIds: [input.id] }) } }] }, finish_reason: 'tool_calls' }] };
    yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 } };
  });
  const payload = { clientMessageId: crypto.randomUUID(), conversationId: conversation.id, modelId, message: '全文をそのまま表示してください', files: [{ fileId: input.id, storage: 'private' }] };
  const accepted = await accept({ userId: user._id, payload });
  await worker.processTurn(await worker.claimTurn(accepted.turn.turnId));
  const done = await models.ChatTurn.findOne({ turnId: accepted.turn.turnId }).lean();
  assert.equal(done.status, 'completed');
  const answer = await models.ChatMessage.findById(done.assistantMessage).lean();
  assert.ok(answer.content.includes('````text\n' + text + '\n````'));
  assert.ok(!answer.content.includes('Wrong:'));
  assert.equal(answer.tokens, 12);
  assert.equal(await models.ChatBillingLedger.countDocuments({ turnId: done.turnId }), 1);
  assert.equal((await accept({ userId: user._id, payload })).disposition, 'duplicate');
  assert.equal(calls, 1);
  // A saved result after a crash is finalized locally, including exact content and usage.
  const next = await accept({ userId: user._id, payload: { ...payload, clientMessageId: crypto.randomUUID(), message: 'Copy the full text' } });
  const claim = await worker.claimTurn(next.turn.turnId);
  await models.ChatTurn.updateOne({ _id: claim.turn._id }, { $set: { providerStartedAt: new Date(), leaseUntil: new Date(0), providerResult: { assistantText: answer.content, usage: { promptTokens: 100, completionTokens: 12, totalTokens: 112 } } } });
  await worker.recoverExpired();
  const recovered = await models.ChatTurn.findOne({ turnId: next.turn.turnId }).lean();
  assert.equal(recovered.status, 'completed');
  assert.equal((await models.ChatMessage.findById(recovered.assistantMessage)).content, answer.content);
  assert.equal(await models.ChatBillingLedger.countDocuments({ turnId: recovered.turnId }), 1);
  assert.equal(calls, 1);
});
