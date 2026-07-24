export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface StringSchemaV1 {
  readonly type: "string";
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly enum?: readonly string[];
}

export interface NumberSchemaV1 {
  readonly type: "number";
  readonly minimum?: number;
  readonly maximum?: number;
  readonly enum?: readonly number[];
}

export interface IntegerSchemaV1 {
  readonly type: "integer";
  readonly minimum?: number;
  readonly maximum?: number;
  readonly enum?: readonly number[];
}

export interface BooleanSchemaV1 {
  readonly type: "boolean";
}

export interface NullSchemaV1 {
  readonly type: "null";
}

export interface ArraySchemaV1 {
  readonly type: "array";
  readonly items: SchemaV1;
  readonly minItems?: number;
  readonly maxItems: number;
}

export interface ObjectSchemaV1 {
  readonly type: "object";
  readonly properties: Readonly<Record<string, SchemaV1>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export type SchemaV1 =
  | StringSchemaV1
  | NumberSchemaV1
  | IntegerSchemaV1
  | BooleanSchemaV1
  | NullSchemaV1
  | ArraySchemaV1
  | ObjectSchemaV1;

export interface WorkflowLimitsV1 {
  readonly concurrency: number;
  readonly maxCalls: number;
  readonly maxItems: number;
}

export interface LeafLimitsV1 {
  readonly timeoutMs: number;
  readonly maxTurns: number;
  readonly maxToolCalls: number;
}

export interface MetaV1 {
  readonly phase?: string;
  readonly log?: string;
}

export interface ArgRefV1 {
  readonly ref: "arg";
  readonly name: string;
}
export interface StepRefV1 {
  readonly ref: "step";
  readonly stepId: string;
}
export interface TaskRefV1 {
  readonly ref: "task";
  readonly stepId: string;
  readonly taskId: string;
}
export interface ItemRefV1 {
  readonly ref: "item";
}
export interface IndexRefV1 {
  readonly ref: "index";
}
export interface PreviousRefV1 {
  readonly ref: "previous";
}

export type RefV1 =
  | ArgRefV1
  | StepRefV1
  | TaskRefV1
  | ItemRefV1
  | IndexRefV1
  | PreviousRefV1;
export type FinalRefV1 = StepRefV1 | TaskRefV1;

export interface TemplateV1 {
  readonly template: string;
  readonly values: Readonly<Record<string, RefV1>>;
}

export type OutputV1 =
  | { readonly mode: "text" }
  | { readonly mode: "structured"; readonly schema: ObjectSchemaV1 };

export interface AgentStepV1 {
  readonly type: "agent";
  readonly id: string;
  readonly agent: string;
  readonly prompt: TemplateV1;
  readonly output: OutputV1;
  readonly limits: LeafLimitsV1;
  readonly meta?: MetaV1;
}

export interface ParallelTaskV1 {
  readonly id: string;
  readonly agent: string;
  readonly prompt: TemplateV1;
  readonly output: OutputV1;
  readonly limits: LeafLimitsV1;
  readonly meta?: MetaV1;
}

export interface ParallelStepV1 {
  readonly type: "parallel";
  readonly id: string;
  readonly tasks: readonly ParallelTaskV1[];
  readonly meta?: MetaV1;
}

export interface PipelineStageV1 {
  readonly id: string;
  readonly agent: string;
  readonly prompt: TemplateV1;
  readonly output: OutputV1;
  readonly limits: LeafLimitsV1;
  readonly meta?: MetaV1;
}

export interface PipelineStepV1 {
  readonly type: "pipeline";
  readonly id: string;
  readonly items: ArgRefV1;
  readonly stages: readonly PipelineStageV1[];
  readonly onFailure: "stop-item";
  readonly meta?: MetaV1;
}

export type StepV1 = AgentStepV1 | ParallelStepV1 | PipelineStepV1;

export interface WorkflowDefinitionV1 {
  readonly version: 1;
  readonly id: string;
  readonly args: Readonly<Record<string, SchemaV1>>;
  readonly limits: WorkflowLimitsV1;
  readonly steps: readonly StepV1[];
  readonly result: FinalRefV1;
}
