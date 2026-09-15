# Known Issues

## Local dev: `fetch` to `api.addisassistant.com` fails with empty `TypeError: fetch failed`

**Symptom.** When running the proxy (or gateway) locally on this machine,
node's global `fetch` (undici) intermittently fails to reach
`api.addisassistant.com` (or the DeepSeek API) with a bare
`TypeError: fetch failed` and an empty `cause`. `curl` to the same host works
fine.

**Root cause.** Broken IPv6 on the local network. The host resolves a Cloudflare
`AAAA` record (`2606:4700:...`) and node/undici tries IPv6 first, which never
connects; it does not reliably fall back to IPv4. This is a local-network
problem, not a code problem.

**Fix (dev only).** Force IPv4 DNS resolution for the process:

```bash
NODE_OPTIONS="--dns-result-order=ipv4first" node server.js
```

Set it in the shell or in your local start script / `.env` (`NODE_OPTIONS`).

**Railway / production is unaffected.** Railway's egress network resolves and
reaches the same hosts without issue; no change is needed in production. This
worked around a network quirk, not the app.

**Verified.** `curl -v https://api.addisassistant.com/api/v1/translate` succeeds
while node `fetch` failed; adding `--dns-result-order=ipv4first` made node
`fetch` succeed as well.

## Known limitation: DeepSeek pricing is flattened (no peak/cache-tier accuracy)

DeepSeek's real pricing for `deepseek-flash` varies along two dimensions we do not
currently account for:

1. **Cache-hit vs. cache-miss input tokens** — DeepSeek charges significantly less
   for input tokens that hit their cache (repeated prompts/context) vs. genuinely new
   tokens. Our `pricing_rates` schema only stores one input rate.
2. **Peak vs. off-peak time-of-day pricing** — DeepSeek charges roughly double during
   peak hours (01:00-04:00 and 06:00-10:00 UTC, Mon-Fri) vs. off-peak.

We currently seed a single flat rate using the off-peak, cache-miss baseline
($0.15/1M input, $0.60/1M output as of Sept 2026). This means:

- Off-peak, cache-miss requests: billed accurately.
- Cache-hit requests: we overcharge relative to our real DeepSeek cost (safe for
  margin, but not accurate).
- Peak-hour requests: we UNDERCHARGE relative to our real DeepSeek cost — DeepSeek
  bills us double, but we bill the customer the flat rate. This is a real margin risk
  at scale, not just an accuracy nitpick.

**This is acceptable for internal testing / pre-revenue use, but must be fixed before
any real customer billing.** Proper fix requires either:
- Extending `pricing_rates` to store peak/off-peak and cache-hit/cache-miss rates
  separately, and reading DeepSeek's actual reported cache-hit/cache-miss token split
  (from their API response usage data) plus the request timestamp at calculation
  time, or
- A simpler interim approach: apply a peak-hour multiplier to the flat rate based on
  request timestamp, even without full cache-tier accuracy.

Revisit before onboarding the first real paying customer.