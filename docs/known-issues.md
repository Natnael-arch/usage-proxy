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