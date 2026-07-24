import {
  canonicalJson,
  cloneSafeJson,
  deepFreeze,
  isForbiddenName,
  JsonBoundaryError,
  utf8Bytes,
} from "./json.ts";
import type {
  FinalRefV1,
  JsonValue,
  RefV1,
  SchemaV1,
  WorkflowDefinitionV1,
} from "./types.ts";

const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const bidiPattern = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const allControlsPattern = /[\u0000-\u001f\u007f-\u009f]/u;
const templateControlsPattern = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
const parsedDefinitions = new WeakSet<WorkflowDefinitionV1>();

type JsonObject = { [key: string]: JsonValue };

function fail(path: string, reason: string): never {
  throw new JsonBoundaryError(path, reason);
}

function propertyPath(path: string, key: string): string {
  return idPattern.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function objectAt(value: JsonValue, path: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(path, "expected an object");
  }
  return value;
}

function arrayAt(value: JsonValue, path: string): JsonValue[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function closedObject(
  value: JsonValue,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonObject {
  const object = objectAt(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(propertyPath(path, key), "unknown field");
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) fail(propertyPath(path, key), "required field is missing");
  }
  return object;
}

function integerIn(value: JsonValue, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number") {
    fail(path, "expected a safe integer");
  }
  if (value < minimum || value > maximum) {
    fail(path, `must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function numberAt(value: JsonValue, path: string): number {
  if (typeof value !== "number") fail(path, "expected a number");
  return value;
}

function identifier(value: JsonValue, path: string): string {
  if (typeof value !== "string" || !idPattern.test(value) || isForbiddenName(value)) {
    fail(path, "must be a safe identifier of 1 to 64 ASCII characters");
  }
  return value;
}

function boundedString(
  value: JsonValue,
  path: string,
  maximumBytes: number,
  controls: RegExp,
): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
  if (utf8Bytes(value) > maximumBytes) fail(path, `UTF-8 length exceeds ${maximumBytes} bytes`);
  if (controls.test(value)) fail(path, "contains a prohibited control character");
  if (bidiPattern.test(value)) fail(path, "contains a prohibited bidi control");
  return value;
}

function parseMeta(value: JsonValue, path: string): void {
  const meta = closedObject(value, path, [], ["phase", "log"]);
  if (Object.keys(meta).length === 0) fail(path, "meta must contain phase or log");
  if (meta.phase !== undefined) boundedString(meta.phase, `${path}.phase`, 256, allControlsPattern);
  if (meta.log !== undefined) boundedString(meta.log, `${path}.log`, 256, templateControlsPattern);
}

function parseLeafLimits(value: JsonValue, path: string): void {
  const limits = closedObject(value, path, ["timeoutMs", "maxTurns", "maxToolCalls"]);
  integerIn(limits.timeoutMs as JsonValue, `${path}.timeoutMs`, 1_000, 3_600_000);
  integerIn(limits.maxTurns as JsonValue, `${path}.maxTurns`, 1, 100);
  integerIn(limits.maxToolCalls as JsonValue, `${path}.maxToolCalls`, 0, 1_000);
}

function parseWorkflowLimits(value: JsonValue, path: string): { maxCalls: number } {
  const limits = closedObject(value, path, ["concurrency", "maxCalls", "maxItems"]);
  integerIn(limits.concurrency as JsonValue, `${path}.concurrency`, 1, 64);
  const maxCalls = integerIn(limits.maxCalls as JsonValue, `${path}.maxCalls`, 1, 1_000);
  integerIn(limits.maxItems as JsonValue, `${path}.maxItems`, 1, 4_096);
  return { maxCalls };
}

function parseEnum(
  value: JsonValue,
  path: string,
  type: "string" | "number" | "integer",
  minimum: number | undefined,
  maximum: number | undefined,
): void {
  const values = arrayAt(value, path);
  if (values.length < 1 || values.length > 256) fail(path, "enum must contain 1 to 256 values");
  const seen = new Set<string | number>();
  for (let index = 0; index < values.length; index += 1) {
    const entry = values[index];
    const entryPath = `${path}[${index}]`;
    if (type === "string") {
      if (typeof entry !== "string") fail(entryPath, "enum value must match string schema type");
    } else if (typeof entry !== "number" || (type === "integer" && !Number.isSafeInteger(entry))) {
      fail(entryPath, `enum value must match ${type} schema type`);
    }
    const scalar = entry as string | number;
    if (seen.has(scalar)) fail(entryPath, "enum values must be unique");
    seen.add(scalar);
    if (typeof scalar === "string") {
      const length = Array.from(scalar).length;
      if (minimum !== undefined && length < minimum) fail(entryPath, "enum value is shorter than minLength");
      if (maximum !== undefined && length > maximum) fail(entryPath, "enum value is longer than maxLength");
    } else {
      if (minimum !== undefined && scalar < minimum) fail(entryPath, "enum value is below minimum");
      if (maximum !== undefined && scalar > maximum) fail(entryPath, "enum value is above maximum");
    }
  }
}

function parseSchemaNode(value: JsonValue, path: string, depth: number): SchemaV1 {
  if (depth > 16) fail(path, "schema depth exceeds 16");
  const object = objectAt(value, path);
  if (typeof object.type !== "string") fail(`${path}.type`, "schema type is required");

  switch (object.type) {
    case "string": {
      const schema = closedObject(value, path, ["type"], ["minLength", "maxLength", "enum"]);
      const minimum = schema.minLength === undefined ? undefined : integerIn(schema.minLength, `${path}.minLength`, 0, 65_536);
      const maximum = schema.maxLength === undefined ? undefined : integerIn(schema.maxLength, `${path}.maxLength`, 0, 65_536);
      if (minimum !== undefined && maximum !== undefined && minimum > maximum) fail(path, "minLength must not exceed maxLength");
      if (schema.enum !== undefined) parseEnum(schema.enum, `${path}.enum`, "string", minimum, maximum);
      return schema as unknown as SchemaV1;
    }
    case "number":
    case "integer": {
      const type = object.type;
      const schema = closedObject(value, path, ["type"], ["minimum", "maximum", "enum"]);
      const minimum = schema.minimum === undefined ? undefined : numberAt(schema.minimum, `${path}.minimum`);
      const maximum = schema.maximum === undefined ? undefined : numberAt(schema.maximum, `${path}.maximum`);
      if (type === "integer") {
        if (minimum !== undefined && !Number.isSafeInteger(minimum)) fail(`${path}.minimum`, "integer bound must be a safe integer");
        if (maximum !== undefined && !Number.isSafeInteger(maximum)) fail(`${path}.maximum`, "integer bound must be a safe integer");
      }
      if (minimum !== undefined && maximum !== undefined && minimum > maximum) fail(path, "minimum must not exceed maximum");
      if (schema.enum !== undefined) parseEnum(schema.enum, `${path}.enum`, type, minimum, maximum);
      return schema as unknown as SchemaV1;
    }
    case "boolean":
    case "null":
      return closedObject(value, path, ["type"]) as unknown as SchemaV1;
    case "array": {
      const schema = closedObject(value, path, ["type", "items", "maxItems"], ["minItems"]);
      const minimum = schema.minItems === undefined ? undefined : integerIn(schema.minItems, `${path}.minItems`, 0, 4_096);
      const maximum = integerIn(schema.maxItems as JsonValue, `${path}.maxItems`, 0, 4_096);
      if (minimum !== undefined && minimum > maximum) fail(path, "minItems must not exceed maxItems");
      parseSchemaNode(schema.items as JsonValue, `${path}.items`, depth + 1);
      return schema as unknown as SchemaV1;
    }
    case "object": {
      const schema = closedObject(value, path, ["type", "properties", "required", "additionalProperties"]);
      if (schema.additionalProperties !== false) fail(`${path}.additionalProperties`, "must be false");
      const properties = objectAt(schema.properties as JsonValue, `${path}.properties`);
      for (const [name, propertySchema] of Object.entries(properties)) {
        if (isForbiddenName(name)) fail(propertyPath(`${path}.properties`, name), "property name is forbidden");
        parseSchemaNode(propertySchema, propertyPath(`${path}.properties`, name), depth + 1);
      }
      const required = arrayAt(schema.required as JsonValue, `${path}.required`);
      const seen = new Set<string>();
      for (let index = 0; index < required.length; index += 1) {
        const name = required[index];
        if (typeof name !== "string" || isForbiddenName(name)) fail(`${path}.required[${index}]`, "required name is invalid");
        if (seen.has(name)) fail(`${path}.required[${index}]`, "required names must be unique");
        seen.add(name);
        if (!Object.hasOwn(properties, name)) fail(`${path}.required[${index}]`, "required name is not declared in properties");
      }
      return schema as unknown as SchemaV1;
    }
    default:
      fail(`${path}.type`, `unsupported schema type ${JSON.stringify(object.type)}`);
  }
}

function parseSchema(value: JsonValue, path: string, objectRoot: boolean): SchemaV1 {
  const schema = parseSchemaNode(value, path, 1);
  if (objectRoot && schema.type !== "object") fail(path, "structured output schema root must be object");
  if (utf8Bytes(canonicalJson(value)) > 64 * 1024) fail(path, "canonical schema size exceeds 64 KiB");
  return schema;
}

interface Scope {
  readonly args: ReadonlyMap<string, SchemaV1>;
  readonly priorSteps: ReadonlySet<string>;
  readonly priorTasks: ReadonlyMap<string, ReadonlySet<string>>;
  readonly pipelineStage?: number;
}

function parseRef(value: JsonValue, path: string, scope: Scope): RefV1 {
  const candidate = objectAt(value, path);
  switch (candidate.ref) {
    case "arg": {
      const ref = closedObject(value, path, ["ref", "name"]);
      const name = identifier(ref.name as JsonValue, `${path}.name`);
      if (!scope.args.has(name)) fail(`${path}.name`, "argument reference is not declared");
      return ref as unknown as RefV1;
    }
    case "step": {
      const ref = closedObject(value, path, ["ref", "stepId"]);
      const stepId = identifier(ref.stepId as JsonValue, `${path}.stepId`);
      if (!scope.priorSteps.has(stepId)) fail(`${path}.stepId`, "step reference must name a prior top-level step");
      return ref as unknown as RefV1;
    }
    case "task": {
      const ref = closedObject(value, path, ["ref", "stepId", "taskId"]);
      const stepId = identifier(ref.stepId as JsonValue, `${path}.stepId`);
      const taskId = identifier(ref.taskId as JsonValue, `${path}.taskId`);
      const tasks = scope.priorTasks.get(stepId);
      if (tasks === undefined || !tasks.has(taskId)) fail(path, "task reference must match a task in a prior parallel step");
      return ref as unknown as RefV1;
    }
    case "item":
    case "index": {
      const ref = closedObject(value, path, ["ref"]);
      if (scope.pipelineStage === undefined) fail(path, `${candidate.ref} reference is only valid in a pipeline stage`);
      return ref as unknown as RefV1;
    }
    case "previous": {
      const ref = closedObject(value, path, ["ref"]);
      if (scope.pipelineStage === undefined || scope.pipelineStage < 1) {
        fail(path, "previous reference is only valid after the first pipeline stage");
      }
      return ref as unknown as RefV1;
    }
    default:
      fail(`${path}.ref`, "unsupported reference discriminant");
  }
}

function templateTokens(template: string, path: string): Set<string> {
  const tokens = new Set<string>();
  for (let index = 0; index < template.length; index += 1) {
    if (template.startsWith("{{", index)) {
      const end = template.indexOf("}}", index + 2);
      if (end < 0) fail(path, "template contains an unmatched '{{'");
      const name = template.slice(index + 2, end);
      if (!idPattern.test(name) || isForbiddenName(name)) fail(path, "template contains a malformed placeholder");
      tokens.add(name);
      index = end + 1;
    } else if (template.startsWith("}}", index)) {
      fail(path, "template contains an unmatched '}}'");
    }
  }
  return tokens;
}

function parseTemplate(value: JsonValue, path: string, scope: Scope): void {
  const prompt = closedObject(value, path, ["template", "values"]);
  const template = boundedString(prompt.template as JsonValue, `${path}.template`, 65_536, templateControlsPattern);
  const tokens = templateTokens(template, `${path}.template`);
  const values = objectAt(prompt.values as JsonValue, `${path}.values`);
  const bindings = new Set<string>();
  for (const [name, reference] of Object.entries(values)) {
    identifier(name, propertyPath(`${path}.values`, name));
    bindings.add(name);
    parseRef(reference, propertyPath(`${path}.values`, name), scope);
  }
  for (const token of tokens) if (!bindings.has(token)) fail(`${path}.values`, `missing binding for placeholder ${token}`);
  for (const binding of bindings) if (!tokens.has(binding)) fail(propertyPath(`${path}.values`, binding), "binding is not used by the template");
}

function parseOutput(value: JsonValue, path: string): void {
  const candidate = objectAt(value, path);
  if (candidate.mode === "text") {
    closedObject(value, path, ["mode"]);
  } else if (candidate.mode === "structured") {
    const output = closedObject(value, path, ["mode", "schema"]);
    parseSchema(output.schema as JsonValue, `${path}.schema`, true);
  } else {
    fail(`${path}.mode`, "unsupported output mode");
  }
}

function parseLeaf(value: JsonValue, path: string, scope: Scope, withType: boolean): string {
  const required = withType
    ? ["type", "id", "agent", "prompt", "output", "limits"]
    : ["id", "agent", "prompt", "output", "limits"];
  const leaf = closedObject(value, path, required, ["meta"]);
  if (withType && leaf.type !== "agent") fail(`${path}.type`, "agent step type must be 'agent'");
  const id = identifier(leaf.id as JsonValue, `${path}.id`);
  boundedString(leaf.agent as JsonValue, `${path}.agent`, 128, allControlsPattern);
  parseTemplate(leaf.prompt as JsonValue, `${path}.prompt`, scope);
  parseOutput(leaf.output as JsonValue, `${path}.output`);
  parseLeafLimits(leaf.limits as JsonValue, `${path}.limits`);
  if (leaf.meta !== undefined) parseMeta(leaf.meta, `${path}.meta`);
  return id;
}

function parseFinalRef(
  value: JsonValue,
  path: string,
  allSteps: ReadonlySet<string>,
  allTasks: ReadonlyMap<string, ReadonlySet<string>>,
): FinalRefV1 {
  const candidate = objectAt(value, path);
  if (candidate.ref === "step") {
    const ref = closedObject(value, path, ["ref", "stepId"]);
    const stepId = identifier(ref.stepId as JsonValue, `${path}.stepId`);
    if (!allSteps.has(stepId)) fail(`${path}.stepId`, "final step reference does not exist");
    return ref as unknown as FinalRefV1;
  }
  if (candidate.ref === "task") {
    const ref = closedObject(value, path, ["ref", "stepId", "taskId"]);
    const stepId = identifier(ref.stepId as JsonValue, `${path}.stepId`);
    const taskId = identifier(ref.taskId as JsonValue, `${path}.taskId`);
    if (!allTasks.get(stepId)?.has(taskId)) fail(path, "final task reference does not match a parallel task");
    return ref as unknown as FinalRefV1;
  }
  fail(`${path}.ref`, "final reference must be a step or task reference");
}

export function parseWorkflowDefinition(input: unknown): WorkflowDefinitionV1 {
  const cloned = cloneSafeJson(input);
  const root = closedObject(cloned, "$", ["version", "id", "args", "limits", "steps", "result"]);
  if (root.version !== 1) fail("$.version", "version must be exactly 1");

  const ids = new Set<string>();
  const registerId = (id: string, path: string): void => {
    if (ids.has(id)) fail(path, `duplicate ID ${id}`);
    ids.add(id);
    if (ids.size > 1_000) fail(path, "definition IDs exceed 1000");
  };
  registerId(identifier(root.id as JsonValue, "$.id"), "$.id");

  const argsObject = objectAt(root.args as JsonValue, "$.args");
  const args = new Map<string, SchemaV1>();
  for (const [name, schemaValue] of Object.entries(argsObject)) {
    identifier(name, propertyPath("$.args", name));
    args.set(name, parseSchema(schemaValue, propertyPath("$.args", name), false));
  }
  const { maxCalls } = parseWorkflowLimits(root.limits as JsonValue, "$.limits");
  const steps = arrayAt(root.steps as JsonValue, "$.steps");
  if (steps.length < 1 || steps.length > 256) fail("$.steps", "steps must contain 1 to 256 entries");

  const priorSteps = new Set<string>();
  const priorTasks = new Map<string, Set<string>>();
  const allSteps = new Set<string>();
  const allTasks = new Map<string, Set<string>>();
  let staticLeafSlots = 0;

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    const path = `$.steps[${stepIndex}]`;
    const step = objectAt(steps[stepIndex] as JsonValue, path);
    const scope: Scope = { args, priorSteps, priorTasks };
    if (step.type === "agent") {
      const id = parseLeaf(steps[stepIndex] as JsonValue, path, scope, true);
      registerId(id, `${path}.id`);
      allSteps.add(id);
      staticLeafSlots += 1;
    } else if (step.type === "parallel") {
      const parallel = closedObject(steps[stepIndex] as JsonValue, path, ["type", "id", "tasks"], ["meta"]);
      const id = identifier(parallel.id as JsonValue, `${path}.id`);
      registerId(id, `${path}.id`);
      if (parallel.meta !== undefined) parseMeta(parallel.meta, `${path}.meta`);
      const tasks = arrayAt(parallel.tasks as JsonValue, `${path}.tasks`);
      if (tasks.length < 1 || tasks.length > 256) fail(`${path}.tasks`, "tasks must contain 1 to 256 entries");
      const taskIds = new Set<string>();
      for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
        const taskPath = `${path}.tasks[${taskIndex}]`;
        const taskId = parseLeaf(tasks[taskIndex] as JsonValue, taskPath, scope, false);
        registerId(taskId, `${taskPath}.id`);
        taskIds.add(taskId);
      }
      allSteps.add(id);
      allTasks.set(id, taskIds);
      staticLeafSlots += tasks.length;
    } else if (step.type === "pipeline") {
      const pipeline = closedObject(steps[stepIndex] as JsonValue, path, ["type", "id", "items", "stages", "onFailure"], ["meta"]);
      const id = identifier(pipeline.id as JsonValue, `${path}.id`);
      registerId(id, `${path}.id`);
      if (pipeline.onFailure !== "stop-item") fail(`${path}.onFailure`, "only 'stop-item' is supported");
      if (pipeline.meta !== undefined) parseMeta(pipeline.meta, `${path}.meta`);
      const items = parseRef(pipeline.items as JsonValue, `${path}.items`, scope);
      if (items.ref !== "arg") fail(`${path}.items`, "pipeline items must be an argument reference");
      if (args.get(items.name)?.type !== "array") fail(`${path}.items.name`, "pipeline items argument must have an array schema");
      const stages = arrayAt(pipeline.stages as JsonValue, `${path}.stages`);
      if (stages.length < 1 || stages.length > 32) fail(`${path}.stages`, "stages must contain 1 to 32 entries");
      for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
        const stagePath = `${path}.stages[${stageIndex}]`;
        const stageId = parseLeaf(stages[stageIndex] as JsonValue, stagePath, { ...scope, pipelineStage: stageIndex }, false);
        registerId(stageId, `${stagePath}.id`);
      }
      allSteps.add(id);
    } else {
      fail(`${path}.type`, "unsupported step discriminant");
    }

    const currentId = identifier(step.id as JsonValue, `${path}.id`);
    priorSteps.add(currentId);
    const tasksForStep = allTasks.get(currentId);
    if (tasksForStep !== undefined) priorTasks.set(currentId, tasksForStep);
  }

  if (staticLeafSlots > maxCalls) fail("$.limits.maxCalls", "static leaf slots exceed maxCalls");
  parseFinalRef(root.result as JsonValue, "$.result", allSteps, allTasks);

  const definition = deepFreeze(cloned) as unknown as WorkflowDefinitionV1;
  parsedDefinitions.add(definition);
  return definition;
}

export function isParsedWorkflowDefinition(value: unknown): value is WorkflowDefinitionV1 {
  return typeof value === "object" && value !== null && parsedDefinitions.has(value as WorkflowDefinitionV1);
}
