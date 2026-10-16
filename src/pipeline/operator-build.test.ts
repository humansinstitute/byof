import { test, expect } from "bun:test";
import { prepareOperatorBuild, operatorDecision, operatorCandidate } from "./operator-build.ts";
import { validateGeneratedHtml } from "./artifact.ts";

test("operator execution preserves exact instruction and rejects changed approval", () => {
  const input = { requestId: "saved", approvedRequestId: "saved", projectId: "project", approvedProjectId: "project", prompt: "  game\n", approvedPrompt: "  game\n", source: "<html></html>" };
  const prepared = prepareOperatorBuild(input);
  expect(prepared.prompt).toContain(JSON.stringify({ instruction: input.prompt, currentSource: input.source }));
  expect(() => prepareOperatorBuild({ ...input, prompt: "game" })).toThrow();
  expect(() => prepareOperatorBuild({ ...input, requestId: "other" })).toThrow();
  expect(operatorDecision({ screen: { shadowStatus: "error" } }).builderAllowed).toBe(false);
});
test("candidate needs completed correlated native receipt and bounded self-contained HTML", () => {
  const turn = { status: "completed", requestId: "request", projectId: "project", invocationRunId: "run", receiptId: "receipt", sessionId: "session", nativeSessionId: "native", sequence: 1, reply: JSON.stringify({ source: "<html><body>Generated</body></html>" }) };
  const input = { turn, requestId: "request", projectId: "project" };
  expect(operatorCandidate(input).nativeReceipt.nativeSessionId).toBe("native");
  expect(() => operatorCandidate({ ...input, turn: { ...turn, status: "sending" } })).toThrow();
  expect(() => operatorCandidate({ ...input, projectId: "foreign" })).toThrow();
  expect(validateGeneratedHtml(operatorCandidate(input).source)).toContain("Generated");
  expect(() => validateGeneratedHtml("<html><iframe></iframe></html>")).toThrow();
  expect(() => validateGeneratedHtml('<html><script src="https://remote.test/a.js"></script></html>')).toThrow();
});
