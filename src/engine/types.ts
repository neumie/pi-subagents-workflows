import type {
	FinalRefV1,
	JsonValue,
	LeafLimitsV1,
	OutputV1,
	RefV1,
} from "../ir/index.ts";

export interface WorkflowUsageV1 {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost: number;
	readonly turns: number;
	readonly toolCalls: number;
	readonly durationMs: number;
}

export interface LeafIdentityV1 {
	readonly runId: string;
	readonly nodeId: string;
	readonly stepId: string;
	readonly slot?: number;
	readonly taskId?: string;
	readonly itemIndex?: number;
	readonly stageIndex?: number;
	readonly stageId?: string;
}

export type LeafResultV1 =
	| { readonly mode: "text"; readonly text: string }
	| {
			readonly mode: "structured";
			readonly value: Readonly<Record<string, JsonValue>>;
	  };

export interface LeafErrorV1 {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
}

export type LeafRunnerStatusV1 =
	| "completed"
	| "failed"
	| "timed_out"
	| "cancelled"
	| "interrupted"
	| "turn_budget_exhausted"
	| "tool_budget_exhausted"
	| "duplicate_node"
	| "invalid_request"
	| "unavailable_context";

interface LeafRunnerTerminalBaseV1 {
	readonly usage: WorkflowUsageV1;
	readonly model?: string;
	readonly thinking?: string;
}

export interface CompletedLeafRunnerTerminalV1
	extends LeafRunnerTerminalBaseV1 {
	readonly status: "completed";
	readonly result: LeafResultV1;
}

export interface FailedLeafRunnerTerminalV1 extends LeafRunnerTerminalBaseV1 {
	readonly status: "failed";
	readonly error: LeafErrorV1;
}

export interface NonCompletedLeafRunnerTerminalV1
	extends LeafRunnerTerminalBaseV1 {
	readonly status:
		| "timed_out"
		| "cancelled"
		| "interrupted"
		| "turn_budget_exhausted"
		| "tool_budget_exhausted"
		| "duplicate_node"
		| "invalid_request"
		| "unavailable_context";
	readonly error?: LeafErrorV1;
}

export type LeafRunnerTerminalV1 =
	| CompletedLeafRunnerTerminalV1
	| FailedLeafRunnerTerminalV1
	| NonCompletedLeafRunnerTerminalV1;

export interface LeafProgressUpdateV1 {
	readonly message: string;
	readonly payload?: JsonValue;
}

export interface LeafRunnerRequestV1 {
	readonly identity: LeafIdentityV1;
	readonly agent: string;
	readonly prompt: string;
	readonly output: OutputV1;
	readonly limits: LeafLimitsV1;
	readonly signal: AbortSignal;
	readonly progress: (update: LeafProgressUpdateV1) => Promise<void>;
}

export type LeafRunner = (
	request: LeafRunnerRequestV1,
) => Promise<LeafRunnerTerminalV1>;

interface TerminalLeafOutcomeBaseV1 {
	readonly identity: LeafIdentityV1;
	readonly usage: WorkflowUsageV1;
	readonly model?: string;
	readonly thinking?: string;
}

export interface SucceededLeafOutcomeV1 extends TerminalLeafOutcomeBaseV1 {
	readonly status: "succeeded";
	readonly result: LeafResultV1;
}

export interface FailedLeafOutcomeV1 extends TerminalLeafOutcomeBaseV1 {
	readonly status: "failed";
	readonly error: LeafErrorV1;
}

export interface DistinctTerminalLeafOutcomeV1
	extends TerminalLeafOutcomeBaseV1 {
	readonly status:
		| "timed_out"
		| "cancelled"
		| "interrupted"
		| "turn_budget_exhausted"
		| "tool_budget_exhausted"
		| "duplicate_node"
		| "invalid_request"
		| "unavailable_context";
	readonly error?: LeafErrorV1;
}

export type LeafSkipReasonV1 =
	| "upstream_failed"
	| "unavailable_reference"
	| "not_admitted"
	| "prompt_too_large"
	| "cancelled";

export interface SkippedLeafOutcomeV1 {
	readonly status: "skipped";
	readonly identity: LeafIdentityV1;
	readonly usage: WorkflowUsageV1;
	readonly reason: LeafSkipReasonV1;
	readonly reference?: RefV1;
}

export type LeafOutcomeV1 =
	| SucceededLeafOutcomeV1
	| FailedLeafOutcomeV1
	| DistinctTerminalLeafOutcomeV1
	| SkippedLeafOutcomeV1;

export interface AgentStepOutcomeV1 {
	readonly type: "agent";
	readonly stepId: string;
	readonly leaf: LeafOutcomeV1;
}

export interface ParallelStepOutcomeV1 {
	readonly type: "parallel";
	readonly stepId: string;
	readonly slots: readonly LeafOutcomeV1[];
}

export type PipelineItemStatusV1 = LeafOutcomeV1["status"];

export interface PipelineItemOutcomeV1 {
	readonly index: number;
	readonly status: PipelineItemStatusV1;
	readonly stages: readonly LeafOutcomeV1[];
}

export interface PipelineStepOutcomeV1 {
	readonly type: "pipeline";
	readonly stepId: string;
	readonly items: readonly PipelineItemOutcomeV1[];
	readonly error?: WorkflowErrorV1;
}

export type StepOutcomeV1 =
	| AgentStepOutcomeV1
	| ParallelStepOutcomeV1
	| PipelineStepOutcomeV1;

export interface WorkflowErrorV1 {
	readonly code: string;
	readonly message: string;
}

export interface WorkflowCountersV1 {
	readonly reservedCallSlots: number;
	readonly actualLeafCalls: number;
	readonly admittedItems: number;
}

export interface WorkflowOutcomeV1 {
	readonly version: 1;
	readonly runId: string;
	readonly workflowId: string;
	readonly status: "succeeded" | "failed" | "cancelled";
	readonly steps: readonly StepOutcomeV1[];
	readonly result: {
		readonly ref: FinalRefV1;
		readonly outcome: LeafOutcomeV1 | StepOutcomeV1;
	} | null;
	readonly usage: WorkflowUsageV1;
	readonly counters: WorkflowCountersV1;
	readonly error?: WorkflowErrorV1;
}

interface WorkflowEventBaseV1 {
	readonly runId: string;
	readonly sequence: number;
}

export type WorkflowEventV1 =
	| (WorkflowEventBaseV1 & {
			readonly type: "workflow_started";
			readonly workflowId: string;
	  })
	| (WorkflowEventBaseV1 & {
			readonly type: "workflow_terminal";
			readonly status: WorkflowOutcomeV1["status"];
			readonly error?: WorkflowErrorV1;
	  })
	| (WorkflowEventBaseV1 & {
			readonly type: "phase";
			readonly stepId: string;
			readonly taskId?: string;
			readonly slot?: number;
			readonly itemIndex?: number;
			readonly stageIndex?: number;
			readonly stageId?: string;
			readonly phase: string;
	  })
	| (WorkflowEventBaseV1 & {
			readonly type: "log";
			readonly stepId: string;
			readonly taskId?: string;
			readonly slot?: number;
			readonly itemIndex?: number;
			readonly stageIndex?: number;
			readonly stageId?: string;
			readonly message: string;
	  })
	| (WorkflowEventBaseV1 & {
			readonly type: "leaf_started";
			readonly identity: LeafIdentityV1;
			readonly agent: string;
	  })
	| (WorkflowEventBaseV1 & {
			readonly type: "leaf_progress";
			readonly identity: LeafIdentityV1;
			readonly message: string;
			readonly payload?: JsonValue;
	  })
	| (WorkflowEventBaseV1 & {
			readonly type: "leaf_terminal";
			readonly outcome: LeafOutcomeV1;
	  });

export interface WorkflowHooksV1 {
	readonly signal?: AbortSignal;
	readonly onEvent?: (event: WorkflowEventV1) => void | Promise<void>;
}
