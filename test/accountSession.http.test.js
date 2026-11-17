const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const test = require("node:test");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

// Inert credentials: no provider or live database is contacted by this suite.
process.env.JWT_SECRET = randomUUID();
process.env.JWT_REFRESH_SECRET = randomUUID();
process.env.OPENAI_API_KEY = "test-unused";
process.env.STRIPE_SECRET_KEY = "sk_test_unused";
const { User } = require("../src/models");
const services = require("../src/services");
const { signRefreshToken } = require("../src/utils/auth");
const { hashRefreshToken, matchesRefreshToken, legacySessionId } = require("../src/utils/refreshSession");
const ID = "507f1f77bcf86cd799439011";
const ROUTE = "/api/users";

const gate = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
  if (key === "$or") return value.some((part) => matches(row, part));
  if (value && typeof value === "object" && "$exists" in value) return (row[key] !== undefined) === value.$exists;
  return row[key] === value || (value === null && row[key] === undefined);
});

test("account login, refresh and logout HTTP contract", { timeout: 45000 }, async (t) => {
  let row;
  let beforeUpdate = async () => {};
  let databaseError = false;
  const document = () => row ? { ...row, save: async function () {
    const { save, ...data } = this;
    row = data;
  } } : null;
  t.mock.method(User, "findById", async () => {
    if (databaseError) throw new Error("Test database unavailable");
    return document();
  });
  t.mock.method(User, "findOne", async () => document());
  t.mock.method(User, "updateOne", async (filter, update) => {
    await beforeUpdate(filter, update);
    if (!row || !matches(row, filter)) return { matchedCount: 0 };
    Object.assign(row, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete row[key];
    return { matchedCount: 1 };
  });
  t.mock.method(services, "verifyGoogleToken", async () => ({ email: "account@example.test", name: "Test account", sub: "google-test" }));
  const app = express();
  app.use(express.json(), cookieParser());
  // Use the real router, middleware, JWT, bcrypt and cookie serialization.
  app.use(ROUTE, require("../src/routes/user"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}${ROUTE}`;
  const request = async (path, token, method = "POST", body) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        ...(token ? { Cookie: `refreshToken=${encodeURIComponent(token)}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const tokenFrom = (result) => decodeURIComponent(result.headers.get("set-cookie").match(/^refreshToken=([^;]*)/)[1]);
  const session = async ({ legacy = false, expired = false } = {}) => {
    const sid = randomUUID();
    const token = legacy
      ? jwt.sign({ userId: ID }, process.env.JWT_REFRESH_SECRET, { expiresIn: expired ? -1 : "30d" })
      : jwt.sign({ userId: ID, sid }, process.env.JWT_REFRESH_SECRET, { expiresIn: expired ? -1 : "30d", jwtid: randomUUID() });
    row = { _id: ID, email: "account@example.test", role: "user", status: "active", appTokens: 1234,
      refreshToken: legacy ? await bcrypt.hash(token, 10) : await hashRefreshToken(token),
      ...(!legacy ? { refreshSessionId: sid } : {}),
    };
    return token;
  };
  const assertCleared = result => {
    assert.equal(result.status, 200);
    assert.equal(result.body.message, "Logged out");
    assert.equal(result.headers.get("cache-control"), "no-store");
    const cookie = result.headers.get("set-cookie");
    assert.match(cookie, /^refreshToken=;/);
    for (const attr of ["Path=/", "HttpOnly", "Secure", "SameSite=None", "Expires=Thu, 01 Jan 1970"]) assert.ok(cookie.includes(attr), attr);
  };

  await t.test("Google login issues a unique session and existing response shape", async () => {
    await session();
    const first = await request("/user", null, "POST", { idToken: "test-google" });
    assert.equal(first.status, 200);
    assert.equal(first.body.user.id, ID);
    assert.equal(first.body.user.appTokens, 1234);
    assert.equal(jwt.verify(first.body.accessToken, process.env.JWT_SECRET).userId, ID);
    const token = tokenFrom(first);
    assert.equal(jwt.verify(token, process.env.JWT_REFRESH_SECRET).sid, row.refreshSessionId);
    assert.ok(await matchesRefreshToken(token, row.refreshToken));
    const second = await request("/user", null, "POST", { idToken: "test-google" });
    assert.notEqual(tokenFrom(second), token);
    assert.equal(await matchesRefreshToken(token, row.refreshToken), false);
    assertCleared(await request("/logout", token));
    assert.ok(row.refreshToken, "an old login must not revoke a newer login");
  });
  await t.test("new hashes cover the whole JWT, not only bcrypt's first 72 bytes", async () => {
    const first = signRefreshToken({ userId: ID, sid: "same-family" });
    const second = signRefreshToken({ userId: ID, sid: "same-family" });
    assert.equal(first.slice(0, 72), second.slice(0, 72));
    assert.notEqual(first, second);
    const hash = await hashRefreshToken(first);
    assert.equal(await matchesRefreshToken(first, hash), true);
    assert.equal(await matchesRefreshToken(second, hash), false);
  });
  await t.test("POST logout revokes the stored session and is repeatable", async () => {
    const token = await session();
    assertCleared(await request("/logout", token));
    assert.equal(row.refreshToken, undefined);
    assert.equal((await request("/refresh", token)).status, 403);
    assertCleared(await request("/logout", token));
  });
  await t.test("legacy deployed GET logout and bcrypt session stay compatible", async () => {
    const token = await session({ legacy: true });
    assertCleared(await request("/logout", token, "GET"));
    assert.equal(row.refreshToken, undefined);
  });
  await t.test("refresh upgrades a legacy cookie without losing access", async () => {
    const token = await session({ legacy: true });
    const result = await request("/refresh", token);
    assert.equal(result.status, 200);
    assert.equal(row.refreshSessionId, legacySessionId(token));
    assert.ok(row.refreshToken.startsWith("sha256:"));
    assert.ok(await matchesRefreshToken(tokenFrom(result), row.refreshToken));
    assertCleared(await request("/logout", token));
    assert.equal(row.refreshToken, undefined, "original legacy cookie can revoke its upgraded family");
  });
  await t.test("rotation preserves the login family; a previous cookie can sign it out", async () => {
    const token = await session();
    const sid = row.refreshSessionId;
    const refreshed = await request("/refresh", token);
    assert.equal(refreshed.status, 200);
    assert.equal(row.refreshSessionId, sid);
    assert.notEqual(tokenFrom(refreshed), token);
    const overlap = await request("/refresh", token);
    assert.equal(overlap.status, 200, "another tab can finish refreshing during the short grace period");
    assert.equal(overlap.headers.get("set-cookie"), null, "overlap must not overwrite the winner's cookie");
    row.previousRefreshTokenExpiresAt = new Date(Date.now() - 1);
    assert.equal((await request("/refresh", token)).status, 403);
    assertCleared(await request("/logout", token));
    assert.equal((await request("/refresh", tokenFrom(refreshed))).status, 403);
  });
  await t.test("parallel tab refreshes both succeed without competing Set-Cookie responses", async () => {
    const token = await session();
    const bothEntered = gate(), release = gate();
    let calls = 0;
    beforeUpdate = async (_, update) => {
      if (update.$set?.refreshToken) {
        calls += 1;
        if (calls === 2) bothEntered.resolve();
        await release.promise;
      }
    };
    try {
      const first = request("/refresh", token), second = request("/refresh", token);
      await bothEntered.promise;
      release.resolve();
      const results = await Promise.all([first, second]);
      assert.deepEqual(results.map(result => result.status), [200, 200]);
      assert.equal(results.filter(result => result.headers.get("set-cookie")).length, 1);
      assert.ok(row.refreshToken);
    } finally { release.resolve(); beforeUpdate = async () => {}; }
  });
  for (const legacy of [false, true]) {
    await t.test(`logout wins concurrent refresh (${legacy ? "legacy" : "current"} session)`, async () => {
      const token = await session({ legacy });
      const entered = gate(), release = gate();
      beforeUpdate = async (_, update) => {
        if (update.$set?.refreshToken) { entered.resolve(); await release.promise; }
      };
      try {
        const refreshing = request("/refresh", token);
        await entered.promise;
        assertCleared(await request("/logout", token));
        release.resolve();
        const result = await refreshing;
        assert.equal(result.status, 403);
        assert.equal(result.headers.get("set-cookie"), null);
        assert.equal(row.refreshToken, undefined);
      } finally { release.resolve(); beforeUpdate = async () => {}; }
    });
  }
  await t.test("a new login winning the race is not revoked by old logout", async () => {
    const token = await session();
    const entered = gate(), release = gate();
    beforeUpdate = async (_, update) => { if (update.$unset) { entered.resolve(); await release.promise; } };
    try {
      const loggingOut = request("/logout", token);
      await entered.promise;
      const login = await request("/user", null, "POST", { idToken: "test-google" });
      const newHash = row.refreshToken;
      release.resolve();
      assertCleared(await loggingOut);
      assert.equal(row.refreshToken, newHash);
      assert.equal((await request("/refresh", tokenFrom(login))).status, 200);
    } finally { release.resolve(); beforeUpdate = async () => {}; }
  });
  await t.test("expired signed sessions can log out; missing and forged cookies are harmless", async () => {
    const token = await session({ expired: true });
    assertCleared(await request("/logout", token));
    assert.equal(row.refreshToken, undefined);
    await session();
    const hash = row.refreshToken;
    for (const value of [undefined, "invalid", jwt.sign({ userId: ID }, "wrong-secret")]) {
      assertCleared(await request("/logout", value));
      assert.equal(row.refreshToken, hash);
    }
  });
  await t.test("storage failure reports retryable failure and keeps the cookie", async () => {
    const token = await session();
    databaseError = true;
    try {
      const result = await request("/logout", token);
      assert.equal(result.status, 503);
      assert.equal(result.headers.get("set-cookie"), null);
      assert.ok(row.refreshToken);
    } finally { databaseError = false; }
    assertCleared(await request("/logout", token));
  });
  await t.test("blocked users cannot refresh and private endpoints still require auth", async () => {
    const token = await session();
    row.status = "blocked";
    assert.equal((await request("/refresh", token)).status, 403);
    for (const path of ["/balance", "/token-history", "/token-transfers/recipient?email=test@example.test"]) {
      assert.equal((await request(path, null, "GET")).status, 401);
    }
  });
});
