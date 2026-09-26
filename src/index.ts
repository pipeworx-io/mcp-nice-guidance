interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * NICE guidance MCP — the National Institute for Health and Care Excellence's
 * published guidance for England: technology appraisals (does the NHS fund this
 * medicine), clinical and NICE guidelines, diagnostics, interventional
 * procedures and quality standards.
 *
 * Auth: none. NICE's own Syndication API (api.nice.org.uk) is key-gated behind an
 * application form and a licence agreement — `/services` answers 401 — so this
 * pack reads the same content from the public pages instead.
 *
 * Source shape (measured 2026-08-25, and the surprising part is the blocking):
 *  - `/search?q=...` is the searchable surface and it accepts filters and paging:
 *    `q` (may be empty), `s=Date` to sort newest first, `ndt` document type,
 *    `ngt` guidance type, `pa` page, `ps` page size. Server-rendered HTML.
 *  - `/guidance/<id>` and `/guidance/<id>/chapter/<slug>` are server-rendered.
 *  - **A query string on `/guidance/published` or on a topic `/products` page is
 *    refused** — HTTP 403 with a "Temporary Service Interruption" page, from any
 *    client, including one carrying a browser User-Agent and the site's cookies.
 *    The same paths WITHOUT a query string answer 200 with the full list. So the
 *    filtered/paginated topic surfaces are unreachable and the unfiltered ones
 *    are complete; this pack only ever requests the query-free form of those.
 *  - robots.txt allows everything with a 1s crawl delay.
 *
 * The status trap, which is why every tool here returns `status` and
 * `superseded_by`: withdrawn, terminated and replaced guidance stays published at
 * its original URL. TA762 still resolves and still reads like a recommendation;
 * the only thing marking it dead is a sentence in the body naming TA1040 as its
 * replacement. Answering from it without that sentence is a confidently wrong
 * clinical answer.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'NICE guidance');
}

const BASE = 'https://www.nice.org.uk';
const SOURCE = 'National Institute for Health and Care Excellence (NICE) — published guidance';
const UA = 'pipeworx-mcp-nice-guidance/1.0 (+https://pipeworx.io)';

/** Guidance-type filter values, exactly as NICE's own search form spells them. */
const GUIDANCE_TYPES = [
  'Antimicrobial prescribing guidelines',
  'Antimicrobial resistance guidance',
  'Cancer service guidelines',
  'Clinical guidelines',
  'COVID-19 rapid guidelines',
  'Diagnostics guidance',
  'Early value assessment',
  'Health technology evaluations',
  'HealthTech guidance',
  'Highly specialised technologies guidance',
  'Interventional procedures guidance',
  'Late stage assessment',
  'Medical technologies guidance',
  'NICE guidelines',
  'Public health guidelines',
  'Safe staffing guidelines',
  'Social care guidelines',
  'Technology appraisal guidance',
];

type Json = Record<string, any>;

async function getHtml(path: string): Promise<{ status: number; html: string; url: string }> {
  const url = `${BASE}${path}`;
  const res = await pwFetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  });
  const html = await res.text();
  return { status: res.status, html, url: res.url || url };
}

function stripTags(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
    ge: '≥', le: '≤', pound: '£', deg: '°', times: '×', reg: '®', trade: '™', copy: '©',
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

/** Reference numbers are TA1040 / NG101 / CG81 / QS12 / IPG123 / DG55 / HST20. */
function normaliseId(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '');
}

function guidanceProgramme(id: string): string | null {
  const prefix = id.replace(/\d+$/, '').toUpperCase();
  return (
    {
      TA: 'Technology appraisal guidance',
      NG: 'NICE guideline',
      CG: 'Clinical guideline',
      QS: 'Quality standard',
      DG: 'Diagnostics guidance',
      IPG: 'Interventional procedures guidance',
      MTG: 'Medical technologies guidance',
      HST: 'Highly specialised technologies guidance',
      HTE: 'Health technology evaluation',
      HTG: 'HealthTech guidance',
      PH: 'Public health guideline',
      ES: 'Evidence summary',
      MIB: 'Medtech innovation briefing',
      SC: 'Social care guideline',
      SG: 'Safe staffing guideline',
    }[prefix] ?? null
  );
}

/**
 * Withdrawn, terminated and replaced guidance stays online at its original URL,
 * so status is derived from the title suffix and the replacement notice rather
 * than assumed from the fact the page loaded.
 */
function readStatus(title: string, html: string): { status: string; superseded_by: string | null; notice: string | null } {
  const noticeMatch = html.match(
    /<p>\s*(This guidance (?:has been|is)[^<]*(?:<a[^>]*>[^<]*<\/a>)?[^<]*)\.?\s*<\/p>/i,
  );
  const notice = noticeMatch ? stripTags(noticeMatch[1]) : null;
  const replacement = html.match(
    /This guidance has been (?:updated and )?replaced by\s*<a[^>]*href="[^"]*\/guidance\/([A-Za-z]+\d+)"/i,
  );
  const lower = `${title} ${notice ?? ''}`.toLowerCase();
  let status = 'published';
  if (lower.includes('withdrawn')) status = 'withdrawn';
  else if (lower.includes('terminated')) status = 'terminated';
  else if (lower.includes('replaced') || lower.includes('updated and replaced')) status = 'replaced';
  else if (lower.includes('static list')) status = 'published (static list)';
  return { status, superseded_by: replacement ? replacement[1].toUpperCase() : null, notice };
}

/** A listing row carries its own death notice in the title suffix. */
function listingStatus(title: string | null): string {
  const t = (title ?? '').toLowerCase();
  if (t.includes('withdrawn')) return 'withdrawn';
  if (t.includes('terminated')) return 'terminated';
  if (t.includes('replaced')) return 'replaced';
  return 'published';
}

const MONTHS = 'january february march april may june july august september october november december'.split(' ');

/** NICE prints "7 February 2024"; callers want to compare dates. */
function isoDate(v: string | null): string | null {
  if (!v) return null;
  const m = v.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return v.match(/^\d{4}-\d{2}-\d{2}/) ? v.slice(0, 10) : null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** Search result cards: <div class="card" ... headinglink="/guidance/ta1040"> */
function parseSearchCards(html: string, limit: number): Json[] {
  const out: Json[] = [];
  const cardRe = /<div class="card[^"]*"[^>]*headinglink="([^"]+)"[\s\S]*?<\/dl>/g;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) && out.length < limit) {
    const block = m[0];
    const link = m[1];
    const heading = block.match(/<a[^>]*href="[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const title = heading ? stripTags(heading[1]) : null;
    const summary = block.match(/class="card__summary"[^>]*>([\s\S]*?)<\/p>/);
    const meta = [...block.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)].map((x) => [
      stripTags(x[1]).replace(/\s*:\s*$/, ''),
      stripTags(x[2]),
    ]);
    const metaOf = (label: string) => meta.find(([k]) => k.toLowerCase() === label)?.[1] ?? null;
    const idMatch = link.match(/\/guidance\/([A-Za-z]+\d+)/);
    const refInTitle = title?.match(/\(([A-Z]+\d+)\)\s*$/);
    const summaryText = summary ? stripTags(summary[1]) : null;
    // Guidance still being written is listed alongside published guidance, under
    // /guidance/indevelopment/gid-ta11340 with its reference only in the summary.
    // Returning it as if it were published would be a recommendation that does
    // not exist yet, so it is labelled and its expected date is carried.
    const inDevelopment = /\/guidance\/indevelopment\//i.test(link);
    const gid = summaryText?.match(/Reference number:\s*(GID-[A-Z0-9]+)/i)?.[1] ?? null;
    const id = (idMatch?.[1] ?? refInTitle?.[1] ?? gid ?? '').toUpperCase();
    out.push({
      id: id || null,
      title: title ? title.replace(/\s*\(([A-Z]+\d+)\)\s*$/, '') : null,
      guidance_type: metaOf('result type') ?? guidanceProgramme(id),
      status: inDevelopment ? 'in development' : listingStatus(title),
      expected_publication: inDevelopment
        ? isoDate(summaryText?.match(/Expected publication date:\s*([\d]{1,2} \w+ \d{4})/i)?.[1] ?? null)
        : null,
      published: isoDate(metaOf('published')),
      last_updated: isoDate(metaOf('last updated')),
      summary: summaryText,
      status_note: /terminated|withdrawn|replaced/i.test(title ?? '') ? stripTags(title ?? '') : null,
      url: link.startsWith('http') ? link : `${BASE}${link}`,
    });
  }
  return out;
}

/** Topic /products pages use <article class="card"> with a <data value="TA1040"> */
function parseTopicCards(html: string, limit: number): Json[] {
  const out: Json[] = [];
  const cardRe = /<article class="card"[\s\S]*?<\/article>/g;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) && out.length < limit) {
    const block = m[0];
    const link = block.match(/href="(\/guidance\/[^"]+)"/);
    const data = block.match(/<data value="([^"]+)">([\s\S]*?)<\/data>/);
    if (!link || !data) continue;
    const meta = [...block.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)].map((x) => [
      stripTags(x[1]).replace(/\s*:\s*$/, ''),
      stripTags(x[2]),
    ]);
    const metaOf = (label: string) => meta.find(([k]) => k.toLowerCase() === label)?.[1] ?? null;
    const title = stripTags(data[2]).replace(/\s*\(([A-Z]+\d+)\)\s*$/, '');
    out.push({
      id: data[1].toUpperCase(),
      title,
      product_type: metaOf('product type'),
      guidance_type: metaOf('programme') ?? guidanceProgramme(data[1]),
      published: isoDate(metaOf('published')),
      last_updated: isoDate(metaOf('last updated')),
      status: listingStatus(title),
      status_note: /terminated|withdrawn|replaced/i.test(title) ? title : null,
      url: `${BASE}${link[1]}`,
    });
  }
  return out;
}

function parseTopicLinks(html: string): { topic: string; path: string }[] {
  const seen = new Set<string>();
  const out: { topic: string; path: string }[] = [];
  for (const m of html.matchAll(/href="(\/guidance\/conditions-and-diseases\/[^"?]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const path = m[1];
    const label = stripTags(m[2]);
    if (!label || seen.has(path)) continue;
    seen.add(path);
    out.push({ topic: label, path });
  }
  return out;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'nice_search_guidance',
    description:
      'Search NICE guidance for England by drug, device, procedure or condition — technology appraisals, NICE and clinical guidelines, diagnostics guidance, interventional procedures and quality standards. Returns the reference number (TA1040, NG101), title, guidance type, publication date and summary. Answers whether NICE has assessed a treatment and which document says so, which is the first step to whether the NHS in England funds it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Drug, device, procedure or condition, e.g. "olaparib" or "atrial fibrillation"' },
        guidance_type: {
          type: 'string',
          description: `Restrict to one NICE programme, spelled as NICE spells it: ${GUIDANCE_TYPES.join(', ')}`,
        },
        sort: { type: 'string', description: '"date" for newest first, or "relevance" (default)' },
        page: { type: 'number', description: 'Result page, 1-based' },
        limit: { type: 'number', description: 'Results to return, 1-50 (default 15)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'nice_guidance',
    description:
      'The published record for one piece of NICE guidance by reference number (TA1040, NG101, CG81, QS12, IPG123, DG55, HST20): title, programme, publication and last-review dates, overview, the chapters it contains, the condition area it sits under, and — the part that matters clinically — whether it is still current or has been withdrawn, terminated or replaced, naming the guidance that replaced it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'NICE reference number, e.g. "TA1040"' },
      },
      required: ['id'],
    },
  },
  {
    name: 'nice_recommendations',
    description:
      'The recommendations chapter of a piece of NICE guidance, in full text — the numbered paragraphs stating what NICE recommends and under what conditions, including whether a medicine is recommended only within its marketing authorisation or only under a commercial arrangement. Answers "did NICE recommend this treatment, and for whom", with the wording that decides NHS funding in England.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'NICE reference number, e.g. "TA1040"' },
      },
      required: ['id'],
    },
  },
  {
    name: 'nice_guidance_by_topic',
    description:
      'Every piece of NICE guidance filed under a condition area — e.g. all breast cancer guidance, or all guidance on type 2 diabetes — with reference numbers, titles, programme and dates. This is the complete curated list for the topic rather than a relevance-ranked search, so it is the right tool for "what has NICE published on X". Call with no topic to list the condition areas that can be asked for.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'Condition area, e.g. "breast cancer", "diabetes"' },
        limit: { type: 'number', description: 'Items to return, 1-200 (default 60)' },
      },
    },
  },
  {
    name: 'nice_recent_guidance',
    description:
      'NICE guidance published or updated most recently, newest first, optionally restricted to one programme such as technology appraisals. Answers "what has NICE published this month" and shows which treatments have just been appraised for NHS use in England.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guidance_type: { type: 'string', description: `Restrict to one NICE programme, e.g. "Technology appraisal guidance"` },
        limit: { type: 'number', description: 'Items to return, 1-50 (default 20)' },
      },
    },
  },
];

async function searchGuidance(args: {
  query: string;
  guidance_type?: string;
  sort?: string;
  page?: number;
  limit?: number;
}) {
  const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);
  const params = new URLSearchParams();
  params.set('q', args.query ?? '');
  params.set('ndt', 'Guidance');
  if (args.guidance_type) params.set('ngt', args.guidance_type);
  if ((args.sort ?? '').toLowerCase().startsWith('date')) params.set('s', 'Date');
  params.set('ps', String(Math.max(limit, 10)));
  if (args.page && Number(args.page) > 1) params.set('pa', String(Number(args.page)));
  const { status, html } = await getHtml(`/search?${params.toString()}`);
  if (status !== 200) throw new Error(`NICE search returned HTTP ${status}`);
  const totalMatch = stripTags(html).match(/([\d,]+)\s+results?/i);
  return {
    total: totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null,
    results: parseSearchCards(html, limit),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'nice_search_guidance': {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('query is required');
      const type = args.guidance_type ? String(args.guidance_type) : undefined;
      if (type && !GUIDANCE_TYPES.includes(type)) {
        return {
          found: false,
          reason: 'unknown_guidance_type',
          hint: `guidance_type must be one of: ${GUIDANCE_TYPES.join(', ')}`,
          source: SOURCE,
        };
      }
      const { total, results } = await searchGuidance({
        query,
        guidance_type: type,
        sort: args.sort as string,
        page: args.page as number,
        limit: args.limit as number,
      });
      if (!results.length) {
        return {
          found: false,
          reason: 'no_guidance_match',
          query,
          hint: 'NICE indexes by the generic drug name and by condition — try "olaparib" rather than "Lynparza", or the condition on its own. nice_guidance_by_topic lists everything filed under a condition area.',
          source: SOURCE,
        };
      }
      return { found: true, query, total_matches: total, returned: results.length, results, source: SOURCE };
    }

    case 'nice_guidance': {
      const id = normaliseId(String(args.id ?? ''));
      if (!id) throw new Error('id is required');
      const { status, html, url } = await getHtml(`/guidance/${encodeURIComponent(id)}`);
      if (status !== 200 || !/page-header__heading/.test(html)) {
        return {
          found: false,
          reason: 'guidance_not_found',
          id: id.toUpperCase(),
          hint: 'Reference numbers look like TA1040, NG101, CG81, QS12, IPG123, DG55 or HST20. Use nice_search_guidance to find the number.',
          source: SOURCE,
        };
      }
      const title = stripTags(html.match(/class="page-header__heading"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '');
      const metaBlock = html.match(/class="page-header__metadata"[\s\S]*?<\/ul>/)?.[0] ?? '';
      const items = [...metaBlock.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => stripTags(m[1]));
      // The header separates the label from the <time> with &nbsp; and newlines,
      // so \s alone does not bridge it and the date silently reads as null.
      const published = metaBlock.match(/Published:(?:&nbsp;|\s)*<time[^>]*datetime="([^"]+)"/i)?.[1] ?? null;
      const updated = metaBlock.match(/Last updated:(?:&nbsp;|\s)*<time[^>]*datetime="([^"]+)"/i)?.[1] ?? null;
      const description = html.match(/<meta content="([^"]*)" name="Description"/i)?.[1] ?? null;
      const state = readStatus(title, html);
      const chapters = [
        ...new Map(
          [...html.matchAll(/href="(\/guidance\/[A-Za-z0-9]+\/chapter\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [
            m[1],
            {
              // The pager reuses the chapter link, so its label arrives as
              // "Next page 1 Recommendations".
              title: stripTags(m[2]).replace(/^(?:Next|Previous) page\s*/i, ''),
              url: `${BASE}${m[1]}`,
            },
          ]),
        ).values(),
      ];
      const breadcrumbs = [...html.matchAll(/<span itemprop="name">\s*([\s\S]*?)\s*<\/span>/g)]
        .map((m) => stripTags(m[1]))
        .filter((b) => b && !/^Home$/i.test(b));
      const lastReviewed = stripTags(html).match(/Last reviewed:\s*(\d{1,2} \w+ \d{4})/)?.[1] ?? null;
      return {
        found: true,
        id: id.toUpperCase(),
        title: title.replace(/\s*\((terminated|withdrawn)[^)]*\)\s*$/i, '').trim(),
        full_title: title,
        guidance_type: items.find((i) => /guidance|guideline|standard|appraisal|assessment/i.test(i)) ?? guidanceProgramme(id),
        status: state.status,
        superseded_by: state.superseded_by,
        status_notice: state.notice,
        published: published ? published.slice(0, 10) : null,
        last_updated: updated ? updated.slice(0, 10) : null,
        last_reviewed: isoDate(lastReviewed),
        overview: description ? decodeEntities(description) : null,
        topic_path: breadcrumbs,
        chapters,
        url,
        source: SOURCE,
      };
    }

    case 'nice_recommendations': {
      const id = normaliseId(String(args.id ?? ''));
      if (!id) throw new Error('id is required');
      const page = await getHtml(`/guidance/${encodeURIComponent(id)}`);
      if (page.status !== 200 || !/page-header__heading/.test(page.html)) {
        return {
          found: false,
          reason: 'guidance_not_found',
          id: id.toUpperCase(),
          hint: 'Use nice_search_guidance to find the reference number first.',
          source: SOURCE,
        };
      }
      const title = stripTags(page.html.match(/class="page-header__heading"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '');
      const state = readStatus(title, page.html);
      const chapterHref = [...page.html.matchAll(/href="(\/guidance\/[A-Za-z0-9]+\/chapter\/[^"]*recommendation[^"]*)"/gi)][0]?.[1];
      if (!chapterHref) {
        return {
          found: false,
          reason: 'no_recommendations_chapter',
          id: id.toUpperCase(),
          title,
          status: state.status,
          superseded_by: state.superseded_by,
          hint:
            state.status === 'published'
              ? 'This document has no recommendations chapter — quality standards carry statements and terminated appraisals carry none. Use nice_guidance to see the chapters it does have.'
              : `This guidance is ${state.status}${state.superseded_by ? ` and was replaced by ${state.superseded_by}` : ''}, so it carries no current recommendations.`,
          source: SOURCE,
        };
      }
      const chapter = await getHtml(chapterHref);
      const body = chapter.html.match(/<div class="chapter[^"]*"[\s\S]*?(?=<footer|<div class="page-actions)/)?.[0] ?? chapter.html;
      // Recommendations are <article class="numbered-paragraph"> blocks with the
      // number in its own heading, so a plain <p> sweep loses "1.1" and reads the
      // rationale prose as if it were a recommendation.
      const numbered = [
        ...body.matchAll(
          /<article[^>]*class="[^"]*numbered-paragraph[^"]*"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)<\/article>/g,
        ),
      ]
        .map((m) => `${stripTags(m[1])} ${stripTags(m[2])}`.trim())
        .filter((t) => t.length > 10);
      const paragraphs = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
        .map((m) => stripTags(m[1]))
        .filter((t) => t.length > 30);
      return {
        found: true,
        id: id.toUpperCase(),
        title,
        status: state.status,
        superseded_by: state.superseded_by,
        status_notice: state.notice,
        recommendations: numbered.length ? numbered : paragraphs.slice(0, 25),
        chapter_url: `${BASE}${chapterHref}`,
        source: SOURCE,
      };
    }

    case 'nice_guidance_by_topic': {
      const limit = Math.min(Math.max(Number(args.limit) || 60, 1), 200);
      const topic = String(args.topic ?? '').trim().toLowerCase();
      const root = await getHtml('/guidance/conditions-and-diseases');
      const areas = parseTopicLinks(root.html).filter((t) => t.path.split('/').length > 3);
      if (!topic) {
        return {
          found: true,
          topics: areas.map((t) => t.topic),
          hint: 'Pass one of these as `topic`. Sub-topics are discovered automatically.',
          source: SOURCE,
        };
      }
      let match = areas.find((t) => t.topic.toLowerCase() === topic);
      if (!match) {
        // Second level: open each matching area and look for the sub-topic inside it.
        const parent = areas.find((t) => topic.includes(t.topic.toLowerCase()) || t.topic.toLowerCase().includes(topic));
        if (parent) {
          const sub = await getHtml(parent.path);
          const subs = parseTopicLinks(sub.html).filter((t) => t.path.startsWith(parent.path + '/'));
          match =
            subs.find((t) => t.topic.toLowerCase() === topic) ??
            subs.find((t) => t.topic.toLowerCase().includes(topic)) ??
            (parent.topic.toLowerCase() === topic ? parent : undefined);
          if (!match) {
            return {
              found: false,
              reason: 'topic_not_found',
              hint: `No condition area called "${args.topic}". Under "${parent.topic}" NICE files: ${subs.map((s) => s.topic).slice(0, 40).join(', ')}.`,
              source: SOURCE,
            };
          }
        } else {
          return {
            found: false,
            reason: 'topic_not_found',
            hint: `No condition area matched "${args.topic}". Top-level areas: ${areas.map((a) => a.topic).join(', ')}. Call this tool with no topic to list them, or use nice_search_guidance for free text.`,
            source: SOURCE,
          };
        }
      }
      // Query strings are refused on this path, so only the complete list is requestable.
      const products = await getHtml(`${match.path}/products`);
      if (products.status !== 200) throw new Error(`NICE topic page returned HTTP ${products.status}`);
      const items = parseTopicCards(products.html, limit);
      if (!items.length) {
        return {
          found: false,
          reason: 'no_guidance_for_topic',
          topic: match.topic,
          hint: 'This condition area exists but lists no published products. Try its parent area or nice_search_guidance.',
          source: SOURCE,
        };
      }
      return {
        found: true,
        topic: match.topic,
        returned: items.length,
        guidance: items,
        url: `${BASE}${match.path}/products`,
        source: SOURCE,
      };
    }

    case 'nice_recent_guidance': {
      const type = args.guidance_type ? String(args.guidance_type) : undefined;
      if (type && !GUIDANCE_TYPES.includes(type)) {
        return {
          found: false,
          reason: 'unknown_guidance_type',
          hint: `guidance_type must be one of: ${GUIDANCE_TYPES.join(', ')}`,
          source: SOURCE,
        };
      }
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const { results } = await searchGuidance({ query: '', guidance_type: type, sort: 'date', limit });
      if (!results.length) {
        return {
          found: false,
          reason: 'no_recent_guidance',
          hint: 'Retry without guidance_type — the newest-first listing is unfiltered by default.',
          source: SOURCE,
        };
      }
      return { found: true, guidance_type: type ?? 'all', returned: results.length, guidance: results, source: SOURCE };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
