import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function context() {
  const tasks = [];
  return { tasks, waitUntil(promise) { tasks.push(Promise.resolve(promise)); } };
}

test("root endpoint responds with product metadata", async () => {
  const response = await worker.fetch(new Request("https://example.test/"), {}, context());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.name, "DevPulse Infra Radar");
  assert.equal(body.status, "ok");
});

test("health endpoint reveals configuration booleans only", async () => {
  const response = await worker.fetch(new Request("https://example.test/health"), {
    TELEGRAM_BOT_TOKEN: "not-returned",
    TELEGRAM_WEBHOOK_SECRET: "not-returned-either",
    TELEGRAM_OWNER_ID: "123",
    GITHUB_TOKEN: "gh_secret_value",
    GITHUB_USERNAME: "mehrdadmb2",
    CLOUDFLARE_API_TOKEN: "cf_secret_value",
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    DB: {},
  }, context());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.configured, { telegram: true, github: true, cloudflare: true, d1: true });
  assert.equal(JSON.stringify(body).includes("gh_secret_value"), false);
  assert.equal(JSON.stringify(body).includes("cf_secret_value"), false);
});

test("unknown route returns 404", async () => {
  const response = await worker.fetch(new Request("https://example.test/private-data"), {}, context());
  assert.equal(response.status, 404);
});

test("webhook rejects wrong Telegram secret header", async () => {
  const response = await worker.fetch(new Request("https://example.test/tg/secret123", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "wrong" },
    body: JSON.stringify({ update_id: 1 }),
  }), { TELEGRAM_WEBHOOK_SECRET: "secret123" }, context());
  assert.equal(response.status, 403);
});

test("webhook rejects malformed JSON before scheduling update handler", async () => {
  const ctx = context();
  const response = await worker.fetch(new Request("https://example.test/tg/secret123", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret123" },
    body: "not-json",
  }), { TELEGRAM_WEBHOOK_SECRET: "secret123" }, ctx);
  assert.equal(response.status, 400);
  assert.equal(ctx.tasks.length, 0);
});
