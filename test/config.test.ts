import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.ts";

test("从环境变量读取密钥，默认使用 DeepSeek 官方地址", () => {
  const config = readConfig({ DEEPSEEK_API_KEY: "test-token" });
  assert.equal(config.model.apiKey, "test-token");
  assert.equal(config.model.baseUrl, "https://api.deepseek.com");
  assert.equal(config.model.model, "deepseek-flash");
  assert.equal(config.runtime.maxSteps, 40);
  assert.equal(config.runtime.maxModelCalls, 20);
  assert.equal(config.runtime.context?.maxTokens, 100000);
  assert.equal(config.model.maxOutputTokens, 131072);
  assert.equal(config.model.thinkingMode, "enabled");
  assert.equal(config.model.reasoningEffort, "max");
  assert.equal(config.model.timeoutMs, 120000);
  assert.equal(config.runtime.timeoutMs, 300000);
  assert.equal(readConfig({ DEEPSEEK_API_KEY: "test-token", AGENT_CONTEXT_UNIT: "characters" }).runtime.context?.maxChars, 48000);
});

test("思考开关、最高档位及输出预算可以配置，非法值明确报错", () => {
  const config = readConfig({ DEEPSEEK_API_KEY: "test-token", DEEPSEEK_THINKING: "disabled", DEEPSEEK_REASONING_EFFORT: "high", DEEPSEEK_MAX_OUTPUT_TOKENS: "16384" });
  assert.equal(config.model.thinkingMode, "disabled"); assert.equal(config.model.reasoningEffort, "high"); assert.equal(config.model.maxOutputTokens, 16384);
  assert.throws(() => readConfig({ DEEPSEEK_API_KEY: "test-token", DEEPSEEK_THINKING: "yes" }), /DEEPSEEK_THINKING/);
  assert.throws(() => readConfig({ DEEPSEEK_API_KEY: "test-token", DEEPSEEK_REASONING_EFFORT: "ultra" }), /DEEPSEEK_REASONING_EFFORT/);
  assert.throws(() => readConfig({ DEEPSEEK_API_KEY: "test-token", DEEPSEEK_MAX_OUTPUT_TOKENS: "393217" }), /DEEPSEEK_MAX_OUTPUT_TOKENS/);
});

test("缺失密钥或非法执行限制会提前报错", () => {
  assert.throws(() => readConfig({}), /DEEPSEEK_API_KEY/);
  for (const raw of ["0", "-1", "1.5", "NaN", "", "2147483648"]) {
    assert.throws(() => readConfig({ DEEPSEEK_API_KEY: "test-token", AGENT_MAX_STEPS: raw }), /AGENT_MAX_STEPS/);
  }
});
