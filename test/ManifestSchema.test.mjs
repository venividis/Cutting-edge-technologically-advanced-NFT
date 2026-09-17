import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schema = JSON.parse(await readFile(new URL("../schemas/anima-agent-manifest-v1.schema.json", import.meta.url)));
const example = JSON.parse(await readFile(new URL("../examples/manifests/base-sepolia-example.json", import.meta.url)));
const directorySchema = JSON.parse(await readFile(new URL("../schemas/anima-directory-v1.schema.json", import.meta.url)));
const directory = JSON.parse(await readFile(new URL("../public/.well-known/anima.json", import.meta.url)));
const functionIndex = JSON.parse(await readFile(new URL("../public/anima-functions.json", import.meta.url)));

test("the checked-in agent manifest satisfies the published schema", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate(example), true, JSON.stringify(validate.errors, null, 2));
});

test("the generated function index is complete enough for machine discovery", () => {
  assert.equal(functionIndex.type, "anima-function-index/1");
  assert.equal(functionIndex.contractCount, functionIndex.contracts.length);
  assert.equal(functionIndex.functionCount, functionIndex.contracts.reduce((sum, contract) => sum + contract.functions.length, 0));
  const anima = functionIndex.contracts.find((contract) => contract.contract === "AnimaAgent");
  assert.ok(anima.functions.some((fn) => fn.name === "manifestOf"));
  assert.ok(anima.functions.some((fn) => fn.name === "accountOf"));
  assert.ok(anima.functions.some((fn) => fn.name === "getStateFingerprint"));
});

test("the well-known machine directory satisfies its published schema", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(directorySchema);
  assert.equal(validate(directory), true, JSON.stringify(validate.errors, null, 2));
  assert.equal(directory.identityRegistry.toLowerCase(), directory.contracts.anima.toLowerCase());
});

test("the schema rejects unknown fields and malformed on-chain identities", () => {
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate({ ...example, anima: { ...example.anima, agentId: "02" } }), false);
  assert.equal(validate({ ...example, executableCode: "do-not-run-me" }), false);
});
