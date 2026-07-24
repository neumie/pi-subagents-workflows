import assert from "node:assert/strict";
import { test } from "node:test";

import { parseWorkflowDefinition } from "../../src/index.ts";
import { parseWorkflowDefinition as parseWorkflowDefinitionFromIr } from "../../src/ir/index.ts";

function leaf(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    agent: "reviewer",
    prompt: { template: "Literal prompt", values: {} },
    output: { mode: "text" },
    limits: { timeoutMs: 120_000, maxTurns: 8, maxToolCalls: 20 },
    ...overrides,
  };
}

function validDefinition(): Record<string, unknown> {
  return {
    version: 1,
    id: "review-targets",
    args: {
      topic: { type: "string", minLength: 1, maxLength: 200 },
      targets: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 200 },
        minItems: 1,
        maxItems: 4,
      },
    },
    limits: { concurrency: 2, maxCalls: 20, maxItems: 4 },
    steps: [
      {
        type: "agent",
        ...leaf("brief", {
          agent: "researcher",
          prompt: {
            template: "Research this topic: {{topic}}",
            values: { topic: { ref: "arg", name: "topic" } },
          },
          meta: { phase: "Research", log: "Preparing a shared brief" },
        }),
      },
      {
        type: "parallel",
        id: "checks",
        meta: { phase: "Review" },
        tasks: [
          leaf("accuracy", {
            prompt: {
              template: "Check accuracy:\n{{brief}}",
              values: { brief: { ref: "step", stepId: "brief" } },
            },
            output: {
              mode: "structured",
              schema: {
                type: "object",
                properties: {
                  verdict: { type: "string", enum: ["pass", "fail"] },
                },
                required: ["verdict"],
                additionalProperties: false,
              },
            },
          }),
          leaf("clarity", {
            prompt: {
              template: "Check clarity:\n{{brief}}",
              values: { brief: { ref: "step", stepId: "brief" } },
            },
          }),
        ],
      },
      {
        type: "pipeline",
        id: "target-lanes",
        items: { ref: "arg", name: "targets" },
        stages: [
          leaf("inspect", {
            agent: "researcher",
            prompt: {
              template: "Inspect {{index}}: {{item}} with {{checks}}",
              values: {
                index: { ref: "index" },
                item: { ref: "item" },
                checks: { ref: "step", stepId: "checks" },
              },
            },
          }),
          leaf("verify", {
            prompt: {
              template: "Verify {{item}}: {{previous}}",
              values: {
                item: { ref: "item" },
                previous: { ref: "previous" },
              },
            },
          }),
        ],
        onFailure: "stop-item",
        meta: { phase: "Targets", log: "Reviewing each target" },
      },
      {
        type: "agent",
        ...leaf("summary", {
          agent: "writer",
          prompt: {
            template: "Summarize {{accuracy}} and {{lanes}}",
            values: {
              accuracy: { ref: "task", stepId: "checks", taskId: "accuracy" },
              lanes: { ref: "step", stepId: "target-lanes" },
            },
          },
        }),
      },
    ],
    result: { ref: "step", stepId: "summary" },
  };
}

test("parses a complete agent, parallel, and pipeline workflow", () => {
  const input = validDefinition();
  const parsed = parseWorkflowDefinition(input);

  assert.equal(parsed.version, 1);
  assert.equal(parsed.steps[0]?.type, "agent");
  assert.equal(parsed.steps[1]?.type, "parallel");
  assert.equal(parsed.steps[2]?.type, "pipeline");
  assert.deepEqual(parsed, input);
  assert.deepEqual(parseWorkflowDefinitionFromIr(validDefinition()), input);
});

function assertInvalid(input: unknown, expected: RegExp): void {
  assert.throws(() => parseWorkflowDefinition(input), expected);
}

function minimalDefinition(): Record<string, unknown> {
  return {
    version: 1,
    id: "minimal",
    args: {},
    limits: { concurrency: 1, maxCalls: 1, maxItems: 1 },
    steps: [{ type: "agent", ...leaf("only") }],
    result: { ref: "step", stepId: "only" },
  };
}

test("returns a detached deeply immutable definition", () => {
  const input = validDefinition();
  const parsed = parseWorkflowDefinition(input);
  const inputSteps = input.steps as Array<Record<string, unknown>>;
  input.id = "changed";
  (inputSteps[0]?.prompt as Record<string, unknown>).template = "changed";

  const first = parsed.steps[0];
  assert.ok(first?.type === "agent");
  assert.equal(parsed.id, "review-targets");
  assert.equal(first.prompt.template, "Research this topic: {{topic}}");
  assert.notEqual(parsed, input);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.steps));
  assert.ok(Object.isFrozen(first.prompt.values));
  assert.throws(() => {
    (parsed as { id: string }).id = "mutated";
  }, TypeError);
});

test("rejects unknown fields at nested closed objects with a useful path", () => {
  const cases: Array<[string, (definition: Record<string, unknown>) => void]> = [
    ["$.extra", (definition) => { definition.extra = true; }],
    ["$.limits.extra", (definition) => { (definition.limits as Record<string, unknown>).extra = true; }],
    ["$.steps[0].extra", (definition) => { ((definition.steps as Record<string, unknown>[])[0] as Record<string, unknown>).extra = true; }],
    ["$.steps[0].prompt.extra", (definition) => { ((((definition.steps as Record<string, unknown>[])[0] as Record<string, unknown>).prompt) as Record<string, unknown>).extra = true; }],
    ["$.steps[0].output.extra", (definition) => { ((((definition.steps as Record<string, unknown>[])[0] as Record<string, unknown>).output) as Record<string, unknown>).extra = true; }],
    ["$.steps[0].limits.extra", (definition) => { ((((definition.steps as Record<string, unknown>[])[0] as Record<string, unknown>).limits) as Record<string, unknown>).extra = true; }],
  ];

  for (const [path, mutate] of cases) {
    const definition = minimalDefinition();
    mutate(definition);
    assertInvalid(definition, new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*unknown field`));
  }
});

test("rejects unsafe non-JSON inputs without leaking accidental errors", () => {
  const unsafe: Array<[unknown, RegExp]> = [];

  const accessor = minimalDefinition();
  Object.defineProperty(accessor, "evil", { enumerable: true, get: () => 1 });
  unsafe.push([accessor, /\$\.evil: object properties must be enumerable data properties/]);

  const symbol = minimalDefinition();
  Object.defineProperty(symbol, Symbol("evil"), { value: 1, enumerable: true });
  unsafe.push([symbol, /\$: symbol properties are not allowed/]);

  const cycle = minimalDefinition();
  cycle.loop = cycle;
  unsafe.push([cycle, /\$\.loop: cyclic values are not allowed/]);

  const sparse = minimalDefinition();
  sparse.steps = new Array(1);
  unsafe.push([sparse, /\$\.steps\[0\]: sparse arrays are not allowed/]);

  const hostileLength = minimalDefinition();
  hostileLength.steps = new Proxy(hostileLength.steps as unknown[], {
    getOwnPropertyDescriptor(target, property) {
      if (property === "length") throw new Error("hostile length descriptor");
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  unsafe.push([hostileLength, /\$\.steps: array length cannot be safely inspected/]);

  for (const value of [undefined, 1n, () => undefined]) {
    const definition = minimalDefinition();
    definition.bad = value;
    unsafe.push([definition, /\$\.bad: (?:undefined|bigint|function) is not a JSON value/]);
  }

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const definition = minimalDefinition();
    definition.bad = value;
    unsafe.push([definition, /\$\.bad: number must be finite/]);
  }

  const nonPlain = minimalDefinition();
  nonPlain.bad = new Date(0);
  unsafe.push([nonPlain, /\$\.bad: object must be plain or have a null prototype/]);

  const throwingProxy = new Proxy(minimalDefinition(), {
    ownKeys() { throw new Error("secret proxy failure"); },
  });
  unsafe.push([throwingProxy, /\$: object cannot be safely inspected/]);

  for (const [input, expected] of unsafe) assertInvalid(input, expected);
});

test("does not invoke an array proxy get trap for length during safe inspection", () => {
  const definition = minimalDefinition();
  let lengthGets = 0;
  definition.steps = new Proxy(definition.steps as unknown[], {
    get(target, property, receiver) {
      if (property === "length") lengthGets += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  assert.doesNotThrow(() => parseWorkflowDefinition(definition));
  assert.equal(lengthGets, 0);
});

test("accepts plain null-prototype data and normalizes negative zero", () => {
  const definition = Object.assign(Object.create(null) as Record<string, unknown>, minimalDefinition());
  definition.args = { score: { type: "number", minimum: -0 } };
  const parsed = parseWorkflowDefinition(definition);
  assert.equal(parsed.version, 1);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  const score = parsed.args.score;
  assert.equal(score?.type, "number");
  assert.equal(score.minimum, 0);
  assert.equal(Object.is(score.minimum, -0), false);
});

test("rejects duplicate IDs across every node kind", () => {
  const definition = validDefinition();
  const pipeline = (definition.steps as Record<string, unknown>[])[2] as Record<string, unknown>;
  const stages = pipeline.stages as Record<string, unknown>[];
  (stages[0] as Record<string, unknown>).id = "accuracy";
  assertInvalid(definition, /\$\.steps\[2\]\.stages\[0\]\.id: duplicate ID accuracy/);
});

test("enforces reference declarations, ordering, parent matching, and local scope", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [];

  const missingArg = minimalDefinition();
  const only = (missingArg.steps as Record<string, unknown>[])[0] as Record<string, unknown>;
  only.prompt = { template: "{{x}}", values: { x: { ref: "arg", name: "missing" } } };
  cases.push([missingArg, /argument reference is not declared/]);

  const forward = validDefinition();
  const brief = (forward.steps as Record<string, unknown>[])[0] as Record<string, unknown>;
  brief.prompt = { template: "{{x}}", values: { x: { ref: "step", stepId: "summary" } } };
  cases.push([forward, /step reference must name a prior top-level step/]);

  const sibling = validDefinition();
  const checks = (sibling.steps as Record<string, unknown>[])[1] as Record<string, unknown>;
  const accuracy = (checks.tasks as Record<string, unknown>[])[0] as Record<string, unknown>;
  accuracy.prompt = { template: "{{x}}", values: { x: { ref: "task", stepId: "checks", taskId: "clarity" } } };
  cases.push([sibling, /task reference must match a task in a prior parallel step/]);

  const wrongParent = validDefinition();
  const summary = (wrongParent.steps as Record<string, unknown>[])[3] as Record<string, unknown>;
  summary.prompt = { template: "{{x}}", values: { x: { ref: "task", stepId: "brief", taskId: "accuracy" } } };
  cases.push([wrongParent, /task reference must match a task in a prior parallel step/]);

  const itemOutside = minimalDefinition();
  ((itemOutside.steps as Record<string, unknown>[])[0] as Record<string, unknown>).prompt = {
    template: "{{x}}", values: { x: { ref: "item" } },
  };
  cases.push([itemOutside, /item reference is only valid in a pipeline stage/]);

  const firstPrevious = validDefinition();
  const lanes = (firstPrevious.steps as Record<string, unknown>[])[2] as Record<string, unknown>;
  ((lanes.stages as Record<string, unknown>[])[0] as Record<string, unknown>).prompt = {
    template: "{{x}}", values: { x: { ref: "previous" } },
  };
  cases.push([firstPrevious, /previous reference is only valid after the first pipeline stage/]);

  const pipelineSelf = validDefinition();
  const selfLanes = (pipelineSelf.steps as Record<string, unknown>[])[2] as Record<string, unknown>;
  ((selfLanes.stages as Record<string, unknown>[])[0] as Record<string, unknown>).prompt = {
    template: "{{x}}", values: { x: { ref: "step", stepId: "target-lanes" } },
  };
  cases.push([pipelineSelf, /step reference must name a prior top-level step/]);

  for (const [definition, expected] of cases) assertInvalid(definition, expected);
});

test("requires pipeline items to name an array argument and final refs to resolve", () => {
  const wrongItems = validDefinition();
  const pipeline = (wrongItems.steps as Record<string, unknown>[])[2] as Record<string, unknown>;
  pipeline.items = { ref: "arg", name: "topic" };
  assertInvalid(wrongItems, /pipeline items argument must have an array schema/);

  const badFinal = minimalDefinition();
  badFinal.result = { ref: "task", stepId: "only", taskId: "missing" };
  assertInvalid(badFinal, /final task reference does not match a parallel task/);

  const localFinal = minimalDefinition();
  localFinal.result = { ref: "item" };
  assertInvalid(localFinal, /final reference must be a step or task reference/);

  const taskFinal = validDefinition();
  taskFinal.result = { ref: "task", stepId: "checks", taskId: "accuracy" };
  assert.doesNotThrow(() => parseWorkflowDefinition(taskFinal));
});

test("requires exact template tokens and an equal binding set", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["missing", { template: "{{x}}", values: {} }, /missing binding for placeholder x/],
    ["unused", { template: "literal", values: { x: { ref: "arg", name: "x" } } }, /binding is not used/],
    ["whitespace", { template: "{{ x }}", values: {} }, /malformed placeholder/],
    ["unmatched-open", { template: "start {{x", values: {} }, /unmatched '\{\{'/],
    ["unmatched-close", { template: "end }}", values: {} }, /unmatched '}}'/],
    ["triple", { template: "{{{x}}}", values: {} }, /malformed placeholder/],
  ];
  for (const [name, prompt, expected] of cases) {
    const definition = minimalDefinition();
    if (name === "unused") definition.args = { x: { type: "string" } };
    ((definition.steps as Record<string, unknown>[])[0] as Record<string, unknown>).prompt = prompt;
    assertInvalid(definition, expected);
  }

  const duplicateToken = minimalDefinition();
  duplicateToken.args = { x: { type: "string" } };
  ((duplicateToken.steps as Record<string, unknown>[])[0] as Record<string, unknown>).prompt = {
    template: "{{x}} and {{x}}",
    values: { x: { ref: "arg", name: "x" } },
  };
  assert.doesNotThrow(() => parseWorkflowDefinition(duplicateToken));

  const literal = minimalDefinition();
  ((literal.steps as Record<string, unknown>[])[0] as Record<string, unknown>).prompt = {
    template: "$brief is literal", values: {},
  };
  assert.doesNotThrow(() => parseWorkflowDefinition(literal));
});

test("validates the closed embedded schema dialect and semantics", () => {
  const invalidSchemas: Array<[unknown, RegExp]> = [
    [{ type: "string", pattern: ".*" }, /unknown field/],
    [{ type: "number", minimum: 2, maximum: 1 }, /minimum must not exceed maximum/],
    [{ type: "integer", enum: [1, 1] }, /enum values must be unique/],
    [{ type: "array", items: { type: "string" }, minItems: 2, maxItems: 1 }, /minItems must not exceed maxItems/],
    [{ type: "object", properties: {}, required: [], additionalProperties: true }, /additionalProperties: must be false/],
    [{ type: "object", properties: {}, required: ["x"], additionalProperties: false }, /required name is not declared/],
    [{ type: "object", properties: { x: { type: "string" } }, required: ["x", "x"], additionalProperties: false }, /required names must be unique/],
    [{ type: "object", properties: { constructor: { type: "string" } }, required: [], additionalProperties: false }, /property name is forbidden/],
  ];
  for (const [schema, expected] of invalidSchemas) {
    const definition = minimalDefinition();
    definition.args = { value: schema };
    assertInvalid(definition, expected);
  }

  const everyRoot = minimalDefinition();
  everyRoot.args = {
    text: { type: "string" },
    number: { type: "number", minimum: 0, maximum: 1, enum: [0, 1] },
    integer: { type: "integer", minimum: 0, maximum: 1, enum: [0, 1] },
    flag: { type: "boolean" },
    nothing: { type: "null" },
    list: { type: "array", items: { type: "boolean" }, minItems: 0, maxItems: 2 },
    record: { type: "object", properties: {}, required: [], additionalProperties: false },
  };
  assert.doesNotThrow(() => parseWorkflowDefinition(everyRoot));

  const stringBounds = minimalDefinition();
  stringBounds.args = { text: { type: "string", minLength: 65_536, maxLength: 65_536 } };
  assert.doesNotThrow(() => parseWorkflowDefinition(stringBounds));
  stringBounds.args = { text: { type: "string", maxLength: 65_537 } };
  assertInvalid(stringBounds, /maxLength: must be between 0 and 65536/);

  const enumBoundary = minimalDefinition();
  enumBoundary.args = { value: { type: "integer", enum: Array.from({ length: 256 }, (_, index) => index) } };
  assert.doesNotThrow(() => parseWorkflowDefinition(enumBoundary));
  enumBoundary.args = { value: { type: "integer", enum: Array.from({ length: 257 }, (_, index) => index) } };
  assertInvalid(enumBoundary, /enum must contain 1 to 256 values/);

  const structuredArray = minimalDefinition();
  ((structuredArray.steps as Record<string, unknown>[])[0] as Record<string, unknown>).output = {
    mode: "structured",
    schema: { type: "array", items: { type: "string" }, maxItems: 1 },
  };
  assertInvalid(structuredArray, /structured output schema root must be object/);
});

test("rejects unsupported discriminants and failure policies", () => {
  const badStep = minimalDefinition();
  ((badStep.steps as Record<string, unknown>[])[0] as Record<string, unknown>).type = "nested";
  assertInvalid(badStep, /unsupported step discriminant/);

  const badOutput = minimalDefinition();
  ((badOutput.steps as Record<string, unknown>[])[0] as Record<string, unknown>).output = { mode: "json" };
  assertInvalid(badOutput, /unsupported output mode/);

  const badPolicy = validDefinition();
  ((badPolicy.steps as Record<string, unknown>[])[2] as Record<string, unknown>).onFailure = "continue";
  assertInvalid(badPolicy, /only 'stop-item' is supported/);
});

test("rejects statically guaranteed leaf slots beyond maxCalls", () => {
  const exact = minimalDefinition();
  assert.doesNotThrow(() => parseWorkflowDefinition(exact));

  const over = minimalDefinition();
  over.steps = [
    { type: "agent", ...leaf("one") },
    { type: "agent", ...leaf("two") },
  ];
  over.result = { ref: "step", stepId: "two" };
  assertInvalid(over, /\$\.limits\.maxCalls: static leaf slots exceed maxCalls/);
});

test("enforces exact numeric range endpoints", () => {
  const workflowCases: Array<[string, number, number, number, number]> = [
    ["concurrency", 1, 64, 0, 65],
    ["maxCalls", 1, 1_000, 0, 1_001],
    ["maxItems", 1, 4_096, 0, 4_097],
  ];
  for (const [field, lower, upper, below, above] of workflowCases) {
    for (const accepted of [lower, upper]) {
      const definition = minimalDefinition();
      (definition.limits as Record<string, unknown>)[field] = accepted;
      assert.doesNotThrow(() => parseWorkflowDefinition(definition));
    }
    for (const rejected of [below, above]) {
      const definition = minimalDefinition();
      (definition.limits as Record<string, unknown>)[field] = rejected;
      assertInvalid(definition, /must be between/);
    }
  }

  const leafCases: Array<[string, number, number, number, number]> = [
    ["timeoutMs", 1_000, 3_600_000, 999, 3_600_001],
    ["maxTurns", 1, 100, 0, 101],
    ["maxToolCalls", 0, 1_000, -1, 1_001],
  ];
  for (const [field, lower, upper, below, above] of leafCases) {
    for (const accepted of [lower, upper]) {
      const definition = minimalDefinition();
      const limits = ((definition.steps as Record<string, unknown>[])[0] as Record<string, unknown>).limits as Record<string, unknown>;
      limits[field] = accepted;
      assert.doesNotThrow(() => parseWorkflowDefinition(definition));
    }
    for (const rejected of [below, above]) {
      const definition = minimalDefinition();
      const limits = ((definition.steps as Record<string, unknown>[])[0] as Record<string, unknown>).limits as Record<string, unknown>;
      limits[field] = rejected;
      assertInvalid(definition, /must be between/);
    }
  }
});

test("enforces identifier, agent, display, and template UTF-8 boundaries", () => {
  const identifierBoundary = minimalDefinition();
  identifierBoundary.id = `a${"x".repeat(63)}`;
  assert.doesNotThrow(() => parseWorkflowDefinition(identifierBoundary));
  identifierBoundary.id = `a${"x".repeat(64)}`;
  assertInvalid(identifierBoundary, /must be a safe identifier/);

  const agentBoundary = minimalDefinition();
  const agentStep = (agentBoundary.steps as Record<string, unknown>[])[0] as Record<string, unknown>;
  agentStep.agent = "x".repeat(128);
  assert.doesNotThrow(() => parseWorkflowDefinition(agentBoundary));
  agentStep.agent = "x".repeat(129);
  assertInvalid(agentBoundary, /agent: UTF-8 length exceeds 128 bytes/);

  const displayBoundary = minimalDefinition();
  const displayStep = (displayBoundary.steps as Record<string, unknown>[])[0] as Record<string, unknown>;
  displayStep.meta = { phase: "x".repeat(256), log: "line one\n\tline two" };
  assert.doesNotThrow(() => parseWorkflowDefinition(displayBoundary));
  displayStep.meta = { phase: "x".repeat(257) };
  assertInvalid(displayBoundary, /phase: UTF-8 length exceeds 256 bytes/);

  const templateBoundary = minimalDefinition();
  const templateStep = (templateBoundary.steps as Record<string, unknown>[])[0] as Record<string, unknown>;
  templateStep.prompt = { template: "x".repeat(65_536), values: {} };
  assert.doesNotThrow(() => parseWorkflowDefinition(templateBoundary));
  templateStep.prompt = { template: "x".repeat(65_537), values: {} };
  assertInvalid(templateBoundary, /template: UTF-8 length exceeds 65536 bytes/);
});

test("rejects prohibited controls, bidi controls, forbidden names, and unpaired surrogates", () => {
  const control = minimalDefinition();
  ((control.steps as Record<string, unknown>[])[0] as Record<string, unknown>).agent = "bad\nagent";
  assertInvalid(control, /agent: contains a prohibited control character/);

  const carriageReturn = minimalDefinition();
  ((carriageReturn.steps as Record<string, unknown>[])[0] as Record<string, unknown>).prompt = { template: "bad\rprompt", values: {} };
  assertInvalid(carriageReturn, /template: contains a prohibited control character/);

  const bidi = minimalDefinition();
  ((bidi.steps as Record<string, unknown>[])[0] as Record<string, unknown>).agent = "bad\u202eagent";
  assertInvalid(bidi, /agent: contains a prohibited bidi control/);

  const surrogate = minimalDefinition();
  surrogate.id = "bad\ud800";
  assertInvalid(surrogate, /\$\.id: string contains an unpaired surrogate/);

  const surrogateKey = minimalDefinition();
  surrogateKey.args = {
    value: {
      type: "object",
      properties: { ["bad\ud800"]: { type: "string" } },
      required: [],
      additionalProperties: false,
    },
  };
  assertInvalid(surrogateKey, /string contains an unpaired surrogate/);

  const forbidden = minimalDefinition();
  forbidden.args = { constructor: { type: "string" } };
  assertInvalid(forbidden, /args\.constructor: must be a safe identifier/);
});

test("accepts collection caps and rejects cap plus one", () => {
  const stepsBoundary = minimalDefinition();
  stepsBoundary.limits = { concurrency: 1, maxCalls: 1_000, maxItems: 1 };
  stepsBoundary.steps = Array.from({ length: 256 }, (_, index) => ({ type: "agent", ...leaf(`s${index}`) }));
  stepsBoundary.result = { ref: "step", stepId: "s255" };
  assert.doesNotThrow(() => parseWorkflowDefinition(stepsBoundary));
  (stepsBoundary.steps as unknown[]).push({ type: "agent", ...leaf("overflow") });
  assertInvalid(stepsBoundary, /steps must contain 1 to 256 entries/);

  const tasksBoundary = minimalDefinition();
  tasksBoundary.limits = { concurrency: 1, maxCalls: 1_000, maxItems: 1 };
  tasksBoundary.steps = [{ type: "parallel", id: "group", tasks: Array.from({ length: 256 }, (_, index) => leaf(`t${index}`)) }];
  tasksBoundary.result = { ref: "step", stepId: "group" };
  assert.doesNotThrow(() => parseWorkflowDefinition(tasksBoundary));
  (((tasksBoundary.steps as Record<string, unknown>[])[0] as Record<string, unknown>).tasks as unknown[]).push(leaf("overflow"));
  assertInvalid(tasksBoundary, /tasks must contain 1 to 256 entries/);

  const stagesBoundary = minimalDefinition();
  stagesBoundary.args = { items: { type: "array", items: { type: "string" }, maxItems: 1 } };
  stagesBoundary.steps = [{
    type: "pipeline", id: "pipe", items: { ref: "arg", name: "items" },
    stages: Array.from({ length: 32 }, (_, index) => leaf(`g${index}`)), onFailure: "stop-item",
  }];
  stagesBoundary.result = { ref: "step", stepId: "pipe" };
  assert.doesNotThrow(() => parseWorkflowDefinition(stagesBoundary));
  (((stagesBoundary.steps as Record<string, unknown>[])[0] as Record<string, unknown>).stages as unknown[]).push(leaf("overflow"));
  assertInvalid(stagesBoundary, /stages must contain 1 to 32 entries/);
});

function definitionAtGlobalDepth(depth: 32 | 33): Record<string, unknown> {
  const definition = minimalDefinition();
  let nested: unknown = "deepest";
  // The definition root is depth 1, so this property contributes depths 2 through the requested leaf depth.
  for (let currentDepth = depth - 1; currentDepth >= 2; currentDepth -= 1) nested = [nested];
  definition.padding = nested;
  return definition;
}

test("counts the definition root as depth 1, allowing depth 32 and rejecting depth 33", () => {
  let boundaryError: unknown;
  try {
    parseWorkflowDefinition(definitionAtGlobalDepth(32));
  } catch (error) {
    boundaryError = error;
  }
  assert.ok(boundaryError instanceof Error);
  assert.doesNotMatch(boundaryError.message, /definition nesting depth/);
  assert.match(boundaryError.message, /\$\.padding: unknown field/);

  assertInvalid(definitionAtGlobalDepth(33), /definition nesting depth exceeds 32/);
});

function nestedArraySchema(arrayCount: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: "string" };
  for (let index = 0; index < arrayCount; index += 1) schema = { type: "array", items: schema, maxItems: 1 };
  return schema;
}

test("accepts schema depth 16 and rejects depth 17", () => {
  const boundary = minimalDefinition();
  boundary.args = { nested: nestedArraySchema(15) };
  assert.doesNotThrow(() => parseWorkflowDefinition(boundary));

  const over = minimalDefinition();
  over.args = { nested: nestedArraySchema(16) };
  assertInvalid(over, /schema depth exceeds 16/);
});

function objectSchemaAtBytes(bytes: number): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: "object",
    properties: { value: { type: "string", enum: [""] } },
    required: ["value"],
    additionalProperties: false,
  };
  const encoded = Buffer.byteLength(JSON.stringify(schema));
  (((schema.properties as Record<string, unknown>).value as Record<string, unknown>).enum as string[])[0] = "x".repeat(bytes - encoded);
  assert.equal(Buffer.byteLength(JSON.stringify(schema)), bytes);
  return schema;
}

test("accepts a 64 KiB schema and rejects one byte more", () => {
  const boundary = minimalDefinition();
  ((boundary.steps as Record<string, unknown>[])[0] as Record<string, unknown>).output = {
    mode: "structured", schema: objectSchemaAtBytes(64 * 1024),
  };
  assert.doesNotThrow(() => parseWorkflowDefinition(boundary));

  const over = minimalDefinition();
  ((over.steps as Record<string, unknown>[])[0] as Record<string, unknown>).output = {
    mode: "structured", schema: objectSchemaAtBytes(64 * 1024 + 1),
  };
  assertInvalid(over, /canonical schema size exceeds 64 KiB/);
});

function definitionAtBytes(bytes: number): Record<string, unknown> {
  const definition = minimalDefinition();
  const args: Record<string, unknown> = {};
  definition.args = args;
  for (let index = 0; index < 4; index += 1) {
    args[`pad${index}`] = { type: "string", enum: ["x".repeat(55_000)] };
  }
  const before = Buffer.byteLength(JSON.stringify(definition));
  args.padlast = { type: "string", enum: [""] };
  const overhead = Buffer.byteLength(JSON.stringify(definition)) - before;
  ((args.padlast as Record<string, unknown>).enum as string[])[0] = "x".repeat(bytes - before - overhead);
  assert.equal(Buffer.byteLength(JSON.stringify(definition)), bytes);
  return definition;
}

test("accepts a 256 KiB canonical definition and rejects one byte more", () => {
  assert.doesNotThrow(() => parseWorkflowDefinition(definitionAtBytes(256 * 1024)));
  assertInvalid(definitionAtBytes(256 * 1024 + 1), /canonical definition size exceeds 256 KiB/);
});

test("stops cloning shared large strings as soon as the definition size cap is exceeded", () => {
  const definition = minimalDefinition();
  const shared = "x".repeat(64 * 1024);
  let inspectedEntries = 0;
  definition.padding = new Proxy(Array.from({ length: 1_000 }, () => shared), {
    getOwnPropertyDescriptor(target, property) {
      if (typeof property === "string" && /^(?:0|[1-9][0-9]*)$/.test(property)) inspectedEntries += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });

  assertInvalid(definition, /canonical definition size exceeds 256 KiB/);
  assert.ok(inspectedEntries <= 4, `inspected ${inspectedEntries} shared string occurrences`);
});

function countEntries(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.length + value.reduce((total, item) => total + countEntries(item), 0);
  return Object.keys(value).length + Object.values(value).reduce((total, item) => total + countEntries(item), 0);
}

function definitionAtEntries(entries: number): Record<string, unknown> {
  const definition = minimalDefinition();
  const args: Record<string, unknown> = {};
  definition.args = args;
  let remaining = entries - countEntries(definition);
  const contributions: number[] = [];
  while (remaining > 259) {
    contributions.push(259);
    remaining -= 259;
  }
  if (remaining === 1 || remaining === 3) {
    const adjustment = remaining === 1 ? 3 : 1;
    const last = contributions.length - 1;
    contributions[last] = (contributions[last] as number) - adjustment;
    remaining += adjustment;
  }
  if (remaining > 0) contributions.push(remaining);
  for (let index = 0; index < contributions.length; index += 1) {
    const contribution = contributions[index] as number;
    args[`fill${index}`] = contribution === 2
      ? { type: "string" }
      : { type: "string", enum: Array.from({ length: contribution - 3 }, (_, enumIndex) => String(enumIndex)) };
  }
  assert.equal(countEntries(definition), entries);
  return definition;
}

test("accepts 20,000 entries and rejects entry 20,001", () => {
  const boundary = definitionAtEntries(20_000);
  assert.doesNotThrow(() => parseWorkflowDefinition(boundary));
  boundary.extra = true;
  assertInvalid(boundary, /definition entries exceed 20000/);
});

function definitionWithIds(idCount: number): Record<string, unknown> {
  const definition = minimalDefinition();
  definition.limits = { concurrency: 1, maxCalls: 1_000, maxItems: 1 };
  let remainingTasks = idCount - 1;
  const steps: Record<string, unknown>[] = [];
  let taskNumber = 0;
  let groupNumber = 0;
  while (remainingTasks > 1) {
    const taskCount = Math.min(256, remainingTasks - 1);
    const groupId = `group${groupNumber++}`;
    const tasks = Array.from({ length: taskCount }, () => leaf(`node${taskNumber++}`));
    steps.push({ type: "parallel", id: groupId, tasks });
    remainingTasks -= taskCount + 1;
  }
  if (remainingTasks === 1) steps.push({ type: "agent", ...leaf(`node${taskNumber++}`) });
  definition.steps = steps;
  definition.result = { ref: "step", stepId: (steps.at(-1) as Record<string, unknown>).id };
  return definition;
}

test("accepts 1,000 IDs and rejects ID 1,001", () => {
  assert.doesNotThrow(() => parseWorkflowDefinition(definitionWithIds(1_000)));
  assertInvalid(definitionWithIds(1_001), /definition IDs exceed 1000/);
});
