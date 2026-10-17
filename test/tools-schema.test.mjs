/**
 * 工具 schema 的离线预检：确保 `ctx.tools.register()` 真的会接受我们的定义。
 *
 * 背景：Harness 的 `dsh-tools` 对 `output.schema` 做严格 JSON Schema 子集校验，
 * 不支持 type 数组等写法；注册时抛错会连带让整个工具注册 effect 回滚 ——
 * 表现是「路由正常、工具却不在工具表里」。这个用例把该故障挡在本地。
 *
 * 运行：node test/tools-schema.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkSchema } from './schema-subset.mjs';
import { createTools } from '../lib/tools.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-raindrop-schema-'));
const store = {
  config: { scanPages: 8, cacheTtlSeconds: 300, enableTools: true },
  file: path.join(dir, 'config.json'),
  readToken: () => null,
};

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL - ${name}\n${error?.stack ?? error}`);
    process.exitCode = 1;
  }
}

const tools = createTools(store);

test('createTools 返回 2 个工具，名称正确', () => {
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map((tool) => tool.name), ['raindrop_overview', 'raindrop_search']);
});

for (const tool of tools) {
  test(`${tool.name}：output.schema 属于 Harness JSON Schema 子集`, () => {
    const violations = checkSchema(tool.output.schema, 'schema');
    assert.deepEqual(violations, [], violations.join('; '));
  });

  test(`${tool.name}：parameters 是合法 JSON Schema 子集`, () => {
    const violations = checkSchema(tool.parameters, 'parameters');
    assert.deepEqual(violations, [], violations.join('; '));
    assert.equal(tool.parameters.type, 'object', 'parameters 必须是 object 根');
  });

  test(`${tool.name}：output.render 是函数，timeoutMs 合法`, () => {
    assert.equal(typeof tool.output.render, 'function');
    assert.ok(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0);
  });
}

test('回归：type 数组（旧写法）必须被本地校验判为非法', () => {
  const violations = checkSchema({ type: 'object', properties: { excerpt: { type: ['string', 'null'] } } });
  assert.ok(violations.some((message) => message.includes('single type string')), violations.join('; '));
});

test('回归：oneOf 旁带 required 必须被判为非法', () => {
  const violations = checkSchema({ oneOf: [{ type: 'string' }, { type: 'null' }], required: ['x'] });
  assert.ok(violations.some((message) => message.includes('beside oneOf')), violations.join('; '));
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} 项全部通过`);
