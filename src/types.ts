export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type MailActionParams = { [key: string]: JsonValue };

export interface AgentMailClient {
  query(action: string, params: MailActionParams): Promise<JsonValue>;
  execute(action: string, params: MailActionParams): Promise<JsonValue>;
}

export type AgentMailErrorCode =
  | "AUTH_REQUIRED"
  | "CLI_UNAVAILABLE"
  | "CLI_TIMEOUT"
  | "INVALID_RESPONSE"
  | "UPSTREAM_FAILURE";

export class AgentMailError extends Error {
  constructor(
    readonly code: AgentMailErrorCode,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = "AgentMailError";
  }
}
