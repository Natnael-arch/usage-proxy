// DeepSeek client: forwards an OpenAI-compatible chat completions request to
// DeepSeek's real API and returns its response unchanged. Uses the centralized
// DEEPSEEK_API_KEY from the environment; the key is never sent to the client.
//
// Two code paths:
//   - Non-streaming (body.stream !== true): returns the parsed JSON response.
//   - Streaming (body.stream === true): returns the raw upstream fetch
//     Response so the route can re-stream the SSE chunks to the caller. The
//     proxy will never try to JSON.parse an SSE body.
const DEEPSEEK_BASE_URL =
  process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_CHAT_COMPLETIONS_PATH = '/chat/completions';
const DEEPSEEK_TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS) || 60000;

function makeUpstreamRequest(body) {
  return fetch(`${DEEPSEEK_BASE_URL}${DEEPSEEK_CHAT_COMPLETIONS_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
  });
}

function wrapNetworkError(err) {
  const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
  const wrapped = new Error(
    isTimeout
      ? `DeepSeek request timed out after ${DEEPSEEK_TIMEOUT_MS}ms`
      : `DeepSeek request failed: ${err.message}`
  );
  wrapped.status = 502;
  wrapped.code = isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_NETWORK';
  throw wrapped;
}

async function chatCompletions(body) {
  if (!DEEPSEEK_API_KEY) {
    const err = new Error('DEEPSEEK_API_KEY is not configured on the server');
    err.status = 500;
    throw err;
  }

  let res;
  try {
    res = await makeUpstreamRequest(body);
  } catch (err) {
    wrapNetworkError(err);
  }

  if (body.stream === true) {
    // Streaming request: don't touch the body. Return the raw upstream
    // Response so the route can pipe SSE chunks to the client. On non-2xx the
    // body is small JSON that the error path below can still parse.
    if (res.ok) {
      return { streaming: true, response: res };
    }
  }

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!res.ok) {
    const upstreamMsg =
      data && (data.error?.message || data.message)
        ? data.error?.message || data.message
        : text || res.statusText;
    const err = new Error(`DeepSeek API error: ${upstreamMsg}`);
    err.status = res.status;
    throw err;
  }

  if (!data) {
    const err = new Error(`DeepSeek API returned invalid JSON (HTTP ${res.status}): ${text.substring(0, 200)}`);
    err.status = 502;
    throw err;
  }

  if (data.error) {
    const err = new Error(`DeepSeek API error: ${data.error.message || JSON.stringify(data.error)}`);
    err.status = 502;
    throw err;
  }

  return { streaming: false, data };
}

module.exports = { chatCompletions };