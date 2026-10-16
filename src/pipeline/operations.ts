import { classifierError, decodeScreen, screenPrompt, type ScreenResult } from "./classifier.ts";

export async function screen(input: Record<string, unknown>) {
  return screenPrompt(input.prompt as string, { apiKey: process.env.FREEDOMTOOLS_TYPESAFE_API_KEY });
}

export function decision(input: Record<string, unknown>) {
  const result = input.screen as ScreenResult;
  return { banRequired: result?.action === "ban" && result.banRequired === true,
    builderAllowed: result?.action === "allow" && result.builderAllowed === true,
    action: result?.action ?? "classifier_error" };
}

export function typedDecision(input: Record<string, unknown>) {
  const raw=input.screen as {classifierError?:{code?:string}} | undefined;
  const result=raw?.classifierError ? classifierError(
    ["configuration","timeout","service","malformed"].includes(String(raw.classifierError.code))
      ? raw.classifierError.code as "configuration"|"timeout"|"service"|"malformed" : "malformed") : decodeScreen(raw);
  return {...decision({screen:result}),screen:result};
}

export function gatedBuilder(input: Record<string, unknown>) {
  return { action: "build_failed", banRequired: false, retryable: true,
    requestId: input.requestId, projectId: input.projectId,
    code: "builder_dependencies_unavailable",
    reply: "Generation is unavailable while persistent execution and enforced isolation are being verified." };
}

export function terminal(input: Record<string, unknown>): Record<string, unknown> {
  const result = input.screen as ScreenResult;
  const correlation = { requestId: input.requestId, projectId: input.projectId };
  if (!result || result.action === "classifier_error") return {
    ...correlation, action: "classifier_error", banRequired: false, retryable: true,
    code: result?.action === "classifier_error" ? result.code : "malformed",
  };
  if (result.action === "ban") return { ...correlation, action: "ban", banRequired: true, policyEvidence: result };
  return { ...correlation, ...(input.builder as Record<string, unknown> ?? {
    action: "build_failed", banRequired: false, retryable: true, code: "builder_dependencies_unavailable",
  }) };
}
