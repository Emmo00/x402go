import { chainByKey, type ChainKey } from '../config';
import { FacilitatorError } from '../exceptions/FacilitatorError';

/**
 * The only module in x402Go that talks to the Celo facilitator.
 *
 * Everything above this file deals in x402's own vocabulary — a payment
 * payload, payment requirements, a settlement result — and knows nothing about
 * HTTP, headers, or how long a request may take. Everything below it is a
 * single `fetch`. Keeping the boundary here means the proxy's behaviour can be
 * tested against a scripted facilitator without a network, and means there is
 * exactly one place where the facilitator's credential is read.
 *
 * ## The credential
 *
 * `CELO_FACILITATOR_API_KEY` is sent as `X-API-Key`, which is what the hosted
 * facilitator requires on `/supported`, `/verify` and `/settle` alike. It is
 * read at call time rather than captured at import, so a test can set it and a
 * rotated value takes effect without a restart.
 *
 * It is never returned, never logged, and never put into an error's `details`.
 * The one function that reads it (`facilitatorKey`) is deliberately the only
 * place `process.env.CELO_FACILITATOR_API_KEY` appears in the backend. This is
 * a *facilitator* credential and is not the merchant's x402Go API key: the
 * caller's key authenticates the caller to x402Go and stops at the controller.
 *
 * ## Failures are classified, not flattened
 *
 * The distinction between "we never sent it", "we sent it and it said no", and
 * "we sent it and we do not know" is the difference between three different
 * outcomes at the settlement boundary, so this service reports which one
 * happened via the error `code` rather than reducing them all to "it failed":
 *
 *   facilitator-key-unusable  no key configured — nothing was sent
 *   facilitator-unreachable   the connection failed — probably nothing was sent
 *   facilitator-timeout       sent, no answer — the outcome is unknown
 *   facilitator-rejected      answered, unusably — the outcome is unknown
 *   (a parsed response)       answered, with a result — use it
 *
 * A response that parses is returned whether its HTTP status was a success or
 * not, because a facilitator reporting an invalid payment is entitled to use
 * 400 to do it and that is a *result*, not a transport failure.
 */

/**
 * The bit of `fetch` this service uses.
 *
 * Narrowed deliberately rather than typed as `typeof fetch`: the global in a
 * Bun project also carries `preconnect` and other statics that a test double
 * has no reason to implement, so requiring the whole global would make the
 * injection point awkward to use and would tie this service's signature to the
 * runtime's ambient types.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Reads the ambient `fetch` at call time, so a test that replaces it is honoured. */
const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

/** How long a facilitator call may take before it is treated as unknown. */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** How long a `/supported` response is reused. It changes when Celo changes it. */
export const SUPPORTED_CACHE_MS = 60_000;

/** The header the facilitator authenticates on. */
const API_KEY_HEADER = 'X-API-Key';

/** The shape of a `GET /supported` response, as far as this proxy relies on it. */
export interface FacilitatorSupported {
  readonly kinds: readonly unknown[];
  readonly extensions?: readonly string[];
  readonly signers?: Readonly<Record<string, readonly string[]>>;
  readonly [key: string]: unknown;
}

/** The `POST /verify` response. `isValid` is the only field this proxy requires. */
export interface FacilitatorVerification {
  readonly isValid: boolean;
  readonly invalidReason?: string;
  readonly invalidMessage?: string;
  readonly payer?: string;
  readonly [key: string]: unknown;
}

/**
 * The `POST /settle` response.
 *
 * `transaction` and `network` are required by the specification even when
 * settlement fails, with an empty hash — so their presence is not evidence of
 * success. `success` is the only field that says whether anything moved.
 */
export interface FacilitatorSettlement {
  readonly success: boolean;
  readonly errorReason?: string;
  readonly errorMessage?: string;
  readonly payer?: string;
  readonly transaction: string;
  readonly network: string;
  readonly amount?: string;
  readonly [key: string]: unknown;
}

/** The request body both `/verify` and `/settle` take. Forwarded, never rewritten. */
export interface FacilitatorRequest {
  readonly x402Version: number;
  readonly paymentPayload: unknown;
  readonly paymentRequirements: unknown;
}

/**
 * Reads the facilitator credential.
 *
 * The absence of a key is reported as its own code rather than as a generic
 * failure, because it is the one facilitator error that proves nothing was
 * sent — which is what lets the settlement path mark a payment failed with
 * confidence instead of leaving it ambiguous forever.
 */
function facilitatorKey(): string {
  const key = process.env.CELO_FACILITATOR_API_KEY;

  if (!key || key.trim().length === 0) {
    throw new FacilitatorError('facilitator-key-unusable', {
      details: { reason: 'CELO_FACILITATOR_API_KEY is not set' },
    });
  }

  return key.trim();
}

/** True for the objects a facilitator returns that are results rather than failures. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class FacilitatorService {
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  /** Cached `/supported`, per chain. See `supported`. */
  private readonly supportedCache = new Map<
    ChainKey,
    { readonly at: number; readonly value: FacilitatorSupported }
  >();

  /**
   * `fetchImpl` is injectable so a test can script the facilitator without a
   * network, and so the timeout can be exercised without waiting twenty
   * seconds. It defaults to the platform `fetch`, resolved at call time rather
   * than at import, so a test that replaces `globalThis.fetch` is honoured.
   */
  constructor(fetchImpl?: FetchLike, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.fetchImpl = fetchImpl ?? defaultFetch;
    this.timeoutMs = timeoutMs;
  }

  /**
   * `GET /supported` — what the facilitator will settle, straight from Celo.
   *
   * Cached briefly because it is a constant that changes when Celo changes it,
   * and because the endpoint is public: without a cache every anonymous caller
   * would spend one facilitator call, and the facilitator meters them.
   *
   * The cache is per chain and per process. It holds no credential — the body
   * is Celo's public capability list — so there is nothing here to leak.
   */
  public async supported(chain: ChainKey): Promise<FacilitatorSupported> {
    const cached = this.supportedCache.get(chain);

    if (cached && Date.now() - cached.at < SUPPORTED_CACHE_MS) {
      return cached.value;
    }

    const body = await this.request(chain, 'supported', 'GET');

    if (!isRecord(body) || !Array.isArray(body.kinds)) {
      throw new FacilitatorError('facilitator-rejected', {
        message: 'The payment facilitator returned an unexpected response.',
        details: { endpoint: 'supported', chain },
      });
    }

    const value = body as unknown as FacilitatorSupported;

    this.supportedCache.set(chain, { at: Date.now(), value });

    return value;
  }

  /**
   * `POST /verify` — asks the facilitator whether the payment is well-formed
   * and correctly signed. Moves nothing.
   *
   * A response without a boolean `isValid` is not a verification either way, so
   * it is reported as a facilitator failure rather than being read as `false`.
   */
  public async verify(
    chain: ChainKey,
    body: FacilitatorRequest,
  ): Promise<FacilitatorVerification> {
    const response = await this.request(chain, 'verify', 'POST', body);

    if (!isRecord(response) || typeof response.isValid !== 'boolean') {
      throw new FacilitatorError('facilitator-rejected', {
        details: { endpoint: 'verify', chain },
      });
    }

    return response as unknown as FacilitatorVerification;
  }

  /**
   * `POST /settle` — asks the facilitator to move the money.
   *
   * The request body is forwarded exactly as it arrived. In particular the
   * signed `paymentPayload` is not rebuilt, re-encoded, or "tidied": its bytes
   * are what the payer's signature covers, so any change to them invalidates
   * the payment. That is why this method takes the body as an opaque object and
   * never looks inside it.
   */
  public async settle(
    chain: ChainKey,
    body: FacilitatorRequest,
  ): Promise<FacilitatorSettlement> {
    const response = await this.request(chain, 'settle', 'POST', body);

    if (!isRecord(response) || typeof response.success !== 'boolean') {
      throw new FacilitatorError('facilitator-rejected', {
        details: { endpoint: 'settle', chain },
      });
    }

    return response as unknown as FacilitatorSettlement;
  }

  /** Drops the `/supported` cache, for a test that needs a fresh read. */
  public clearCache(): void {
    this.supportedCache.clear();
  }

  /**
   * The one place a request is made.
   *
   * Returns the parsed body whatever the HTTP status, so that a facilitator
   * which reports an invalid payment with a 400 is read as having answered. The
   * status only decides the outcome when the body is not usable, because at
   * that point there is no result to use and the transport is all that is left
   * to describe.
   */
  private async request(
    chain: ChainKey,
    endpoint: 'supported' | 'verify' | 'settle',
    method: 'GET' | 'POST',
    body?: FacilitatorRequest,
  ): Promise<unknown> {
    // Read before anything else, so a server with no facilitator key fails
    // without a network call and without ever having built a request.
    const key = facilitatorKey();
    const url = `${chainByKey(chain).facilitatorUrl}/${endpoint}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          [API_KEY_HEADER]: key,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      // The abort is this service's own deadline, and it is the one failure
      // here that says the request may already have been received and acted on.
      if (isAbortError(error)) {
        throw new FacilitatorError('facilitator-timeout', {
          details: { endpoint, chain },
          cause: error,
        });
      }

      throw new FacilitatorError('facilitator-unreachable', {
        details: { endpoint, chain },
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await this.readBody(response, chain, endpoint);

    if (text.trim().length === 0) {
      throw new FacilitatorError('facilitator-rejected', {
        details: { endpoint, chain, status: response.status, reason: 'empty body' },
      });
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      // An HTML error page from a proxy in front of the facilitator lands here.
      throw new FacilitatorError('facilitator-rejected', {
        details: { endpoint, chain, status: response.status, reason: 'body was not JSON' },
        cause: error,
      });
    }
  }

  /**
   * Reads the response body, turning a failure to read it into the same
   * "answered, unusably" outcome as an unparseable one. A truncated response is
   * not evidence about the payment, so it must not be reported as one.
   */
  private async readBody(
    response: Response,
    chain: ChainKey,
    endpoint: string,
  ): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      throw new FacilitatorError('facilitator-rejected', {
        details: { endpoint, chain, status: response.status, reason: 'body unreadable' },
        cause: error,
      });
    }
  }
}

/** `AbortController` surfaces a timeout as a DOMException named `AbortError`. */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

export default FacilitatorService;
