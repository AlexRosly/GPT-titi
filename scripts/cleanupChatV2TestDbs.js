require("dotenv").config();

const { MongoClient } = require("mongodb");

const TEST_MONGO_URI = process.env.CHAT_V2_TEST_MONGO_URI;

if (!TEST_MONGO_URI) {
  console.error(
    "CHAT_V2_TEST_MONGO_URI is required to clean Chat Delivery v2 test databases.",
  );
  process.exit(1);
}

const SAFE_PREFIXES = ["gpt_titi_test_", "gpt_titi_chat_v2_test_"];

const isChatV2TestDb = (name) =>
  SAFE_PREFIXES.some((prefix) => name.startsWith(prefix));

const main = async () => {
  const client = new MongoClient(TEST_MONGO_URI);

  try {
    await client.connect();

    const { databases } = await client.db().admin().listDatabases();

    const testDatabases = databases.map((db) => db.name).filter(isChatV2TestDb);

    if (testDatabases.length === 0) {
      console.log("No Chat Delivery v2 test databases found.");
      return;
    }

    console.log(
      `Found ${testDatabases.length} Chat Delivery v2 test databases.`,
    );

    for (const dbName of testDatabases) {
      console.log(`Dropping: ${dbName}`);
      await client.db(dbName).dropDatabase();
    }

    console.log(
      `Removed ${testDatabases.length} Chat Delivery v2 test databases.`,
    );
  } finally {
    await client.close();
  }
};

main().catch((error) => {
  console.error("Failed to clean Chat Delivery v2 test databases:", error);

  process.exitCode = 1;
});
