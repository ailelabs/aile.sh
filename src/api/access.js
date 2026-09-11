/**
 * Reaching a relay that sits behind Cloudflare Access.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT. Some relays — a private deployment, a
 * staging box, this project's own during a migration — put Cloudflare Access in
 * front of the API. Access answers an unauthenticated request with a 302 to a
 * sign-in portal, which no CLI can complete: the browser flow is for a human, and
 * there is no human in the middle of `aile start`. The way through is the service
 * token Cloudflare issues for exactly this case.
 *
 * **The public aile.sh relay must never require one.** If you find you need this to
 * use the hosted service, that is a misconfiguration on our side, not yours.
 *
 * FROM THE ENVIRONMENT, NEVER FROM THE SOURCE OR THE CONFIG FILE. This client is
 * open source and published to a public registry, so a credential compiled into it
 * would be readable by everyone who installs it — and one written to
 * `~/.aile/config.json` long outlives the afternoon it was needed. The token belongs
 * to whoever runs the relay; it stays in their shell.
 *
 * ITS OWN MODULE, not a corner of api/client.js, because `relay/enroll.js` needs it
 * too and enrolment has no business importing the HTTP client to borrow two headers.
 *
 * Names match Cloudflare's own, so an operator can paste the pair straight out of
 * the Zero Trust dashboard.
 *
 * A caller that sends these MUST NOT follow redirects. `fetch` re-sends custom
 * headers to whatever a 3xx points at — verified — so following one hands the
 * operator's service token to whichever host answered. Every caller here passes
 * `redirect: "manual"`.
 */

export function accessHeaders(env = process.env) {
  const id = String(env.CF_ACCESS_CLIENT_ID || "").trim();
  const secret = String(env.CF_ACCESS_CLIENT_SECRET || "").trim();
  if (!id || !secret) return {};
  return { "cf-access-client-id": id, "cf-access-client-secret": secret };
}
