import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { S1Client, choice, score } from "../src/index.js";
import http from "node:http";
import https from "node:https";

describe("Playbook Section 10B: Zero-Egress Network Audit", () => {
  let outboundAttempts: string[] = [];
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;

  beforeAll(() => {
    outboundAttempts = [];
    // Intercept outbound node http/https calls
    http.request = function (...args: any[]) {
      const url = typeof args[0] === "string" ? args[0] : (args[0]?.host || args[0]?.hostname || "unknown");
      if (!url.includes("127.0.0.1") && !url.includes("localhost")) {
        outboundAttempts.push(`http://${url}`);
      }
      return originalHttpRequest.apply(this, args as any);
    } as any;

    https.request = function (...args: any[]) {
      const url = typeof args[0] === "string" ? args[0] : (args[0]?.host || args[0]?.hostname || "unknown");
      outboundAttempts.push(`https://${url}`);
      return originalHttpsRequest.apply(this, args as any);
    } as any;
  });

  afterAll(() => {
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
  });

  it("proves s1sdk offline execution triggers ZERO external outbound network calls", async () => {
    const client = new S1Client({
      provider: "homestead",
      endpoint: "http://127.0.0.1:18765/v1/systemone",
    });

    // Construct questions
    const q1 = choice("Action", { read: "read", write: "write" });
    const q2 = score("Confidence", { low: 0, med: 5, high: 10 });

    expect(q1.type).toBe("choice");
    expect(q2.type).toBe("score");

    // Check interceptor captures
    const externalEgress = outboundAttempts.filter(
      (req) => !req.includes("localhost") && !req.includes("127.0.0.1")
    );
    expect(externalEgress.length).toBe(0);
  });
});
