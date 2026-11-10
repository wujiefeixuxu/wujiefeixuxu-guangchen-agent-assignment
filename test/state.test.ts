import assert from "node:assert/strict";
import test from "node:test";
import { AgentStatus, createState, transitionState } from "../src/state.ts";

test("任务从待运行进入运行中，再进入完成，历史快照保持不变", () => {
  const pending = createState("计算 1 + 2");
  const running = transitionState(pending, AgentStatus.RUNNING);
  const completed = transitionState(running, AgentStatus.COMPLETED);
  assert.equal(pending.status, "pending");
  assert.equal(running.status, "running");
  assert.equal(completed.status, "completed");
  assert.equal(completed.error, null);
  assert.equal(pending.messages[1]?.content, "计算 1 + 2");
});

test("失败时保存原因，原状态保持运行中", () => {
  const running = transitionState(createState("测试失败"), AgentStatus.RUNNING);
  const failed = transitionState(running, AgentStatus.FAILED, new Error("连接中断"));
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "连接中断");
  assert.equal(running.status, "running");
  assert.equal(running.error, null);
});

test("不能跳过运行、退回待运行或重复切换运行中", () => {
  const pending = createState("测试流转");
  const running = transitionState(pending, AgentStatus.RUNNING);
  assert.throws(() => transitionState(pending, AgentStatus.COMPLETED), /不允许状态流转/);
  assert.throws(() => transitionState(pending, AgentStatus.FAILED), /不允许状态流转/);
  assert.throws(() => transitionState(running, AgentStatus.PENDING), /不允许状态流转/);
  assert.throws(() => transitionState(running, AgentStatus.RUNNING), /不允许状态流转/);
  assert.throws(() => transitionState(running, AgentStatus.COMPLETED, "错误"), /只有失败状态/);
});

test("完成和失败都是终态", () => {
  const running = transitionState(createState("测试终态"), AgentStatus.RUNNING);
  for (const terminal of [AgentStatus.COMPLETED, AgentStatus.FAILED]) {
    const state = transitionState(running, terminal);
    for (const nextStatus of Object.values(AgentStatus)) {
      assert.throws(() => transitionState(state, nextStatus), /不允许状态流转/);
    }
  }
});

test("拒绝空任务，每个任务使用独立的消息数组", () => {
  assert.throws(() => createState("  \n"), /不能为空/);
  const a = createState("A");
  const b = createState("B");
  assert.notEqual(a.messages, b.messages);
  assert.equal(a.messages[1]?.content, "A");
  assert.equal(b.messages[1]?.content, "B");
});
