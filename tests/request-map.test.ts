import { describe, it, expect, beforeEach } from "vitest";
import {
  registerRequest,
  unregisterRequest,
  unregisterByJobId,
  getJobByRequestId,
  clearMap,
} from "../src/request-map.js";

beforeEach(() => clearMap());

describe("request-map", () => {
  it("registerRequest + getJobByRequestId round-trips", () => {
    registerRequest("req-1", "job-a");
    expect(getJobByRequestId("req-1")).toBe("job-a");
  });

  it("unregisterRequest removes the entry", () => {
    registerRequest("req-1", "job-a");
    unregisterRequest("req-1");
    expect(getJobByRequestId("req-1")).toBeUndefined();
  });

  it("getJobByRequestId returns undefined for unknown requestId", () => {
    expect(getJobByRequestId("nope")).toBeUndefined();
  });

  it("unregisterByJobId removes all entries for that jobId", () => {
    registerRequest("req-1", "job-a");
    registerRequest("req-2", "job-a");
    registerRequest("req-3", "job-b");
    unregisterByJobId("job-a");
    expect(getJobByRequestId("req-1")).toBeUndefined();
    expect(getJobByRequestId("req-2")).toBeUndefined();
    expect(getJobByRequestId("req-3")).toBe("job-b");
  });

  it("unregisterByJobId is a no-op when jobId is not registered", () => {
    registerRequest("req-1", "job-a");
    unregisterByJobId("ghost-job");
    expect(getJobByRequestId("req-1")).toBe("job-a");
  });

  it("normalises numeric and string requestId keys - 42 and '42' map to same entry", () => {
    registerRequest(42, "job-n");
    expect(getJobByRequestId("42")).toBe("job-n");
    unregisterRequest("42");
    expect(getJobByRequestId(42)).toBeUndefined();
  });

  it("registerRequest silently overwrites an existing entry", () => {
    registerRequest("req-1", "job-a");
    registerRequest("req-1", "job-b");
    expect(getJobByRequestId("req-1")).toBe("job-b");
  });

  it("clearMap removes all entries", () => {
    registerRequest("req-1", "job-a");
    registerRequest("req-2", "job-b");
    clearMap();
    expect(getJobByRequestId("req-1")).toBeUndefined();
    expect(getJobByRequestId("req-2")).toBeUndefined();
  });
});
