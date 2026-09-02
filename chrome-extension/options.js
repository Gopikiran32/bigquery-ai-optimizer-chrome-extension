// Options page — stores the Cloud Function URL in chrome.storage.sync.

const DEFAULTS = {
  cloudFunctionUrl: '',
  debugLogging: false
};

const urlInput = document.getElementById('url');
const debugInput = document.getElementById('debug');
const statusEl = document.getElementById('status');

function setStatus(msg, cls = '') {
  statusEl.textContent = msg;
  statusEl.className = cls;
}

// ── Load current settings ──────────────────────────────────────
chrome.storage.sync.get(DEFAULTS, (stored) => {
  urlInput.value = stored.cloudFunctionUrl || '';
  debugInput.checked = !!stored.debugLogging;
});

// ── Validation ─────────────────────────────────────────────────
function parseUrl(raw) {
  const value = (raw || '').trim();
  if (!value) return { error: 'Enter your Cloud Function URL first.' };

  let parsed;
  try {
    parsed = new URL(value);
  } catch (e) {
    return { error: 'That is not a valid URL.' };
  }

  if (parsed.protocol !== 'https:') {
    return { error: 'The URL must use https.' };
  }

  return { url: parsed.origin + parsed.pathname.replace(/\/+$/, ''), origin: parsed.origin + '/*' };
}

// Cloud Functions and Cloud Run hosts are already declared in the manifest.
// Anything else (a custom domain, an API gateway) needs a runtime grant.
async function ensureHostPermission(origin) {
  try {
    const already = await chrome.permissions.contains({ origins: [origin] });
    if (already) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (e) {
    // If the permissions API is unavailable, let the fetch itself fail later.
    return true;
  }
}

// ── Save ───────────────────────────────────────────────────────
document.getElementById('save').addEventListener('click', async () => {
  const { url, origin, error } = parseUrl(urlInput.value);
  if (error) {
    setStatus(error, 'err');
    return;
  }

  const granted = await ensureHostPermission(origin);
  if (!granted) {
    setStatus('Permission for that host was declined — the extension cannot call it.', 'err');
    return;
  }

  chrome.storage.sync.set(
    { cloudFunctionUrl: url, debugLogging: debugInput.checked },
    () => {
      urlInput.value = url;
      setStatus('Saved. Reload your BigQuery tab to pick up the change.', 'ok');
      setTimeout(() => setStatus(''), 6000);
    }
  );
});

// ── Test connection ────────────────────────────────────────────
// Sends a trivial query in dry_run_only mode: no Vertex AI call, no cost.
document.getElementById('test').addEventListener('click', async () => {
  const { url, origin, error } = parseUrl(urlInput.value);
  if (error) {
    setStatus(error, 'err');
    return;
  }

  const granted = await ensureHostPermission(origin);
  if (!granted) {
    setStatus('Permission for that host was declined.', 'err');
    return;
  }

  setStatus('Testing…', 'warn');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT 1', dry_run_only: true })
    });

    if (response.status === 401 || response.status === 403) {
      setStatus(
        `${response.status} — the function rejected the call. Deploy it with `
        + `--allow-unauthenticated, or put an authenticating proxy in front of it.`,
        'err'
      );
      return;
    }

    if (!response.ok) {
      setStatus(`HTTP ${response.status} from the function. Check its logs in Cloud Logging.`, 'err');
      return;
    }

    const data = await response.json();

    if (data.error) {
      setStatus(`Reached the function, but it returned: ${String(data.error).slice(0, 120)}`, 'warn');
      return;
    }

    if (data.dry_run_only) {
      setStatus('Connected. The backend is responding correctly.', 'ok');
    } else {
      setStatus('Got a response, but not the expected shape — is this the right URL?', 'warn');
    }
  } catch (err) {
    setStatus(
      `Could not reach the function (${err.message}). Check the URL, and that the `
      + `function allows CORS and unauthenticated invocation.`,
      'err'
    );
  }
});
