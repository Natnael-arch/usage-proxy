// Addis AI client: forwards a translation request to Addis AI's real API and
// returns its response unchanged. Uses the centralized ADDIS_API_KEY from the
// environment; the key is never sent to the client.
const ADDIS_BASE_URL =
  process.env.ADDIS_BASE_URL || 'https://api.addisassistant.com';
const ADDIS_API_KEY = process.env.ADDIS_API_KEY;
const ADDIS_TRANSLATE_PATH = '/api/v1/translate';
const ADDIS_TIMEOUT_MS = Number(process.env.ADDIS_TIMEOUT_MS) || 60000;

async function translate(body) {
  if (!ADDIS_API_KEY) {
    const err = new Error('ADDIS_API_KEY is not configured on the server');
    err.status = 500;
    throw err;
  }

  let res;
  try {
    res = await fetch(`${ADDIS_BASE_URL}${ADDIS_TRANSLATE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ADDIS_API_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ADDIS_TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    const wrapped = new Error(
      isTimeout
        ? `Addis AI request timed out after ${ADDIS_TIMEOUT_MS}ms`
        : `Addis AI request failed: ${err.message}`
    );
    wrapped.status = 502;
    wrapped.code = isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_NETWORK';
    throw wrapped;
  }

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!res.ok) {
    console.error(
      '[addisai] translate_out failed | status=' + res.status +
        ' | source_language=' + JSON.stringify(body.source_language) +
        ' | target_language=' + JSON.stringify(body.target_language)
    );

    const upstreamMsg =
      data && (data.error?.message || data.message || data.detail)
        ? data.error?.message || data.message || data.detail
        : text || res.statusText;
    const err = new Error(`Addis AI API error: ${upstreamMsg}`);
    err.status = res.status;
    throw err;
  }

  return data;
}

module.exports = { translate };