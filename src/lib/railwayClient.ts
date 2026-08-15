/**
 * Thin GraphQL client for Railway's Public API.
 *
 * VERIFIED vs UNVERIFIED — read before trusting this against a real account:
 * The mutation/field shapes used by RailwayProvider (serviceCreate,
 * serviceInstanceDeployV2, serviceDomainCreate, serviceDelete) are
 * corroborated by Railway's own published docs
 * (docs.railway.com/guides/api-cookbook, docs.railway.com/guides/manage-services)
 * and independent third-party examples. They are NOT verified by live
 * introspection — this environment's network egress does not reach
 * backboard.railway.com, so no request built by this client has ever
 * actually been sent to Railway. Before relying on this in production: run
 * `railway api schema` (Railway CLI) or open railway.com/graphiql and
 * confirm these shapes against the live schema.
 */

const RAILWAY_API_URL = "https://backboard.railway.com/graphql/v2";

export class RailwayApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly graphqlErrors: unknown
  ) {
    super(message);
    this.name = "RailwayApiError";
  }
}

export type FetchLike = typeof fetch;

/**
 * @param fetchImpl Injectable for testing — defaults to global fetch.
 *   Tests pass a mock here instead of hitting the network, so the request
 *   *shape* (query + variables + headers) is verified without needing
 *   live Railway access.
 */
export async function railwayGraphQL<T>(params: {
  token: string;
  query: string;
  variables?: unknown;
  fetchImpl?: FetchLike;
}): Promise<T> {
  const { token, query, variables, fetchImpl = fetch } = params;

  if (!token) {
    throw new RailwayApiError("Railway API token is missing", 0, null);
  }

  let res: Response;
  try {
    res = await fetchImpl(RAILWAY_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new RailwayApiError(
      `Network error calling Railway API: ${(err as Error).message}`,
      0,
      null
    );
  }

  let json: { data?: T; errors?: unknown };
  try {
    json = (await res.json()) as { data?: T; errors?: unknown };
  } catch {
    throw new RailwayApiError(
      `Railway API returned a non-JSON response (HTTP ${res.status})`,
      res.status,
      null
    );
  }

  if (!res.ok) {
    throw new RailwayApiError(
      `Railway API request failed (HTTP ${res.status})`,
      res.status,
      json.errors
    );
  }

  if (json.errors) {
    const message =
      Array.isArray(json.errors) && json.errors[0] && typeof json.errors[0] === "object"
        ? String((json.errors[0] as { message?: string }).message ?? "Unknown GraphQL error")
        : "Railway API returned GraphQL errors";
    throw new RailwayApiError(message, res.status, json.errors);
  }

  if (json.data === undefined) {
    throw new RailwayApiError("Railway API response missing 'data' field", res.status, null);
  }

  return json.data;
}
