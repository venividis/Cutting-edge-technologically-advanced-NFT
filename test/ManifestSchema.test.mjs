import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schema = JSON.parse(await readFile(new URL("../schemas/anima-agent-manifest-v1.schema.json", import.meta.url)));
const example = JSON.parse(await readFile(new URL("../examples/manifests/base-sepolia-example.json", import.meta.url)));

test("the checked-in agent manifest satisfies the published schema", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate(example), true, JSON.stringify(validate.errors, null, 2));
});

test("the schema rejects unknown fields and malformed on-chain identities", () => {
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate({ ...example, anima: { ...example.anima, agentId: "02" } }), false);
  assert.equal(validate({ ...example, executableCode: "do-not-run-me" }), false);
});
