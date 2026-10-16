import { expect, test } from "bun:test";
import { decodeScreen, QUESTIONS, screenPrompt } from "./classifier.ts";
import { decision, gatedBuilder, terminal, typedDecision } from "./operations.ts";

const response = (injection = 0, extraction = 0) => ({ model: "jev-test", answers: {
  injection: { type: "noul", noul: injection }, extraction: { type: "noul", noul: extraction },
} });
test("threshold is inclusive for either independent question", () => {
  for (const [a,b,action] of [[0.9499,0.9499,"allow"],[0.95,0,"ban"],[0,0.95,"ban"],[1,1,"ban"],[0,0,"allow"]] as const) {
    const result = decodeScreen(response(a,b));
    expect(result.action).toBe(action);
    expect(decision({screen:result}).builderAllowed).toBe(action === "allow");
  }
});
test("managed typed inference produces the same inclusive decision and retryable errors",()=>{
  for(const [a,b,action] of [[0.9499,0.9499,"allow"],[0.95,0,"ban"],[0,0.95,"ban"]] as const) {
    const d=typedDecision({screen:response(a,b)});
    expect(d.action).toBe(action);expect(d.builderAllowed).toBe(action==="allow");
    expect(terminal({screen:d.screen,requestId:"request",projectId:"project"}).action).toBe(action==="allow"?"build_failed":"ban");
  }
  for(const code of ["service","timeout","malformed","configuration"])
    expect(typedDecision({screen:{classifierError:{code,retryable:true}}})).toMatchObject({action:"classifier_error",banRequired:false,builderAllowed:false});
});
test("all invalid probabilities and types fail without banning", () => {
  for (const value of [NaN, Infinity, -0.001, 1.001, "0.99", null, undefined]) {
    for (const question of ["injection","extraction"] as const) {
      const payload: any = response(0.99,0.99); payload.answers[question].noul = value;
      expect(decodeScreen(payload)).toMatchObject({action:"classifier_error",banRequired:false,builderAllowed:false,retryable:true});
    }
  }
  expect(decodeScreen({})).toMatchObject({action:"classifier_error"});
  const payload = response(); payload.answers.injection.type = "score";
  expect(decodeScreen(payload)).toMatchObject({action:"classifier_error"});
});
test("one call contains exactly two Noul questions and explicit false criteria", async () => {
  let calls = 0;
  const result = await screenPrompt("Make the button green", {apiKey:"synthetic", fetch: (async (url,options) => {
    calls++; expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    const request = JSON.parse(options!.body as string);
    expect(request.questions).toEqual(QUESTIONS);
    expect(Object.keys(request.questions)).toHaveLength(2);
    for (const question of Object.values(QUESTIONS)) {
      expect(question.type).toBe("noul"); expect(question.criteria.false).toContain("Normal");
      expect(question.criteria.false).toMatch(/teach|educational/i);
    }
    return Response.json(response());
  }) as typeof fetch});
  expect(calls).toBe(1); expect(result.action).toBe("allow");
});
test("service, malformed JSON, timeout and missing configuration never ban", async () => {
  for (const fake of [async()=>new Response("unavailable",{status:529}), async()=>new Response("invalid"), async()=>{throw new Error("offline") }]) {
    expect(await screenPrompt("edit",{apiKey:"synthetic",fetch:fake as unknown as typeof fetch})).toMatchObject({action:"classifier_error",retryable:true,banRequired:false});
  }
  const timeoutFetch = ((_url: unknown, options: RequestInit) => new Promise<Response>((_, reject) => {
    options.signal!.addEventListener("abort",()=>reject(new Error("abort")),{once:true});
  })) as typeof fetch;
  expect(await screenPrompt("edit",{apiKey:"synthetic",timeoutMs:5,fetch:timeoutFetch})).toMatchObject({code:"timeout",banRequired:false});
  expect(await screenPrompt("edit")).toMatchObject({code:"configuration",banRequired:false});
});
test("ban and errors terminate without builder; allowed branch remains honestly gated", () => {
  for (const screen of [decodeScreen(response(0.95,0)),decodeScreen({})]) {
    expect(decision({screen}).builderAllowed).toBe(false);
    expect(terminal({screen,requestId:"request",projectId:"project"}).action).toBe(screen.action);
  }
  const builder = gatedBuilder({requestId:"request",projectId:"project"});
  expect(terminal({screen:decodeScreen(response()),builder,requestId:"request",projectId:"project"})).toMatchObject({action:"build_failed",code:"builder_dependencies_unavailable",banRequired:false});
});
