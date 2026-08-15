import { describe, it, expect, vi } from "vitest";
import { railwayGraphQL, RailwayApiError, FetchLike } from "./railwayClient.js";

function mockFetch(response: { status: number; body: unknown }): FetchLike {
  return vi.fn(async () =>
    new Response(JSON.stringify(response.body), { status: response.status })
  ) as unknown as FetchLike;
}

describe("railwayGraphQL", () => {
  it("sends the Authorization header and JSON body Railway's API requires", async () => {
    const fetchImpl = mockFetch({ status: 200, body: { data: { me: { id: "u_1" } } } });

    await railwayGraphQL({
      token: "test-token",
      query: "query { me { id } }",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://backboard.railway.com/graphql/v2",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        }),
      })
    );
  });

  it("returns parsed data on success", async () => {
    const fetchImpl = mockFetch({ status: 200, body: { data: { serviceCreate: { id: "svc_1" } } } });
    const result = await railwayGraphQL<{ serviceCreate: { id: string } }>({
      token: "t",
      query: "mutation {}",
      fetchImpl,
    });
    expect(result.serviceCreate.id).toBe("svc_1");
  });

  it("throws RailwayApiError on GraphQL-level errors even with HTTP 200", async () => {
    const fetchImpl = mockFetch({
      status: 200,
      body: { errors: [{ message: "Problem processing request" }] },
    });
    await expect(railwayGraphQL({ token: "t", query: "mutation {}", fetchImpl })).rejects.toThrow(
      RailwayApiError
    );
    await expect(railwayGraphQL({ token: "t", query: "mutation {}", fetchImpl })).rejects.toThrow(
      /Problem processing request/
    );
  });

  it("throws RailwayApiError on non-2xx HTTP responses", async () => {
    const fetchImpl = mockFetch({ status: 401, body: { errors: [{ message: "Unauthorized" }] } });
    await expect(railwayGraphQL({ token: "bad-token", query: "query {}", fetchImpl })).rejects.toThrow(
      RailwayApiError
    );
  });

  it("throws immediately if no token is provided, without making a network call", async () => {
    const fetchImpl = mockFetch({ status: 200, body: {} });
    await expect(railwayGraphQL({ token: "", query: "query {}", fetchImpl })).rejects.toThrow(
      RailwayApiError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces network failures (e.g. DNS/connection errors) as RailwayApiError, not a raw throw", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed: ENOTFOUND backboard.railway.com");
    }) as unknown as FetchLike;

    await expect(railwayGraphQL({ token: "t", query: "query {}", fetchImpl })).rejects.toThrow(
      RailwayApiError
    );
  });
});
