// BigQuery AI Query Optimizer — Content Script
// Reads the query from the BigQuery editor, sends it to your Cloud Function,
// and renders the results. All AI + metadata logic lives server-side.
//
// There is nothing to edit in this file. The Cloud Function URL is configured
// from the extension's options page and read from chrome.storage.sync.

// ── Configuration (from options page) ───────────────────────────
const DEFAULT_CONFIG = {
  cloudFunctionUrl: '',
  debugLogging: false
};

let config = { ...DEFAULT_CONFIG };

async function loadConfig() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULT_CONFIG);
    config = { ...DEFAULT_CONFIG, ...stored };
  } catch (e) {
    // Storage unavailable (e.g. extension was just reloaded) — keep defaults.
  }
  return config;
}

loadConfig();

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      config[key] = newValue;
    }
  });
} catch (e) { /* ignore */ }

// Debug logging is opt-in from the options page, so a normal install keeps
// the browser console clean.
function log(...args) { if (config.debugLogging) console.log('[BQ-Opt]', ...args); }
function warn(...args) { if (config.debugLogging) console.warn('[BQ-Opt]', ...args); }

// Chrome blocks web pages from navigating to chrome-extension:// URLs, and
// content scripts cannot call openOptionsPage() directly — so ask the service
// worker to do it.
function openOptions() {
  try {
    chrome.runtime.sendMessage({ type: 'open-options' });
  } catch (e) {
    warn('Could not open the options page:', e);
    alert('Open chrome://extensions, find "BigQuery AI Query Optimizer", '
      + 'then Details → Extension options.');
  }
}

let panel = null;
let injected = false;
let lastOptimizedQuery = '';
let preCheckInProgress = false;

// ── Query Extraction ────────────────────────────────────────────

async function getQueryFromEditor() {
  // Strategy 1: DOM bridge → page-script.js (MAIN world) probes the editor API.
  try {
    const result = await getQueryViaBridge();
    if (result && result.trim().length > 0) {
      log(`Got query via page-script bridge (${result.length} chars)`);
      return result.trim();
    }
  } catch (e) {
    warn('Bridge approach failed:', e);
  }

  // Strategy 2: Clipboard — simulate Select All + Copy.
  // Most reliable when the Monaco API is not reachable.
  try {
    const result = await getQueryViaClipboard();
    if (result && result.trim().length > 0) {
      log(`Got query via clipboard (${result.length} chars)`);
      return result.trim();
    }
  } catch (e) {
    warn('Clipboard approach failed:', e);
  }

  // Strategy 3: Monaco's hidden accessibility textarea.
  try {
    const result = getQueryFromHiddenTextarea();
    if (result && result.trim().length > 0) {
      log(`Got query via hidden textarea (${result.length} chars)`);
      return result.trim();
    }
  } catch (e) {
    warn('Hidden textarea failed:', e);
  }

  // Strategy 4: Visible DOM lines — only what is on screen, so last resort.
  const editorEl = document.querySelector('.monaco-editor');
  if (editorEl) {
    const lines = editorEl.querySelectorAll('.view-line');
    if (lines.length > 0) {
      warn(`Fell back to visible DOM lines (${lines.length} lines — may be incomplete)`);
      return Array.from(lines).map(l => l.textContent).join('\n').trim();
    }
  }

  return '';
}

// Sentinel the page script sends when it probed but found no editor, so we can
// move on immediately instead of waiting out the timeout.
const BRIDGE_EMPTY = '__BQ_OPT_EMPTY__';

// Strategy 1: DOM bridge to the MAIN-world page script.
function getQueryViaBridge() {
  return new Promise((resolve) => {
    const bridge = document.getElementById('bq-opt-bridge');
    if (!bridge) {
      warn('Bridge element not found');
      resolve('');
      return;
    }

    let resolved = false;

    const onMutation = () => {
      if (resolved) return;
      const resp = bridge.dataset.response;
      if (resp !== undefined && resp !== '') {
        resolved = true;
        obs.disconnect();
        bridge.dataset.response = ''; // reset
        resolve(resp === BRIDGE_EMPTY ? '' : resp);
      }
    };

    const obs = new MutationObserver(onMutation);
    obs.observe(bridge, { attributes: true, attributeFilter: ['data-response'] });

    bridge.dataset.response = '';
    bridge.dataset.request = 'get-query';

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        obs.disconnect();
        // Expected on many BigQuery builds — the next strategy takes over.
        warn('Bridge timed out after 2000ms, falling through');
        resolve('');
      }
    }, 2000);
  });
}

// Strategy 2: Clipboard (Select All + Copy via simulated keyboard events).
async function getQueryViaClipboard() {
  let savedClipboard = '';
  try {
    savedClipboard = await navigator.clipboard.readText();
  } catch (e) { /* may fail if the clipboard is empty */ }

  const editorContainer = document.querySelector('.monaco-editor');
  if (!editorContainer) return '';

  // Monaco routes keyboard input through this textarea.
  const textarea = editorContainer.querySelector('textarea.inputarea')
    || editorContainer.querySelector('.overflow-guard textarea')
    || editorContainer.querySelector('textarea');
  if (!textarea) return '';

  textarea.focus();
  textarea.click();
  await sleep(100);

  dispatchKeyCombo(textarea, 'a', 'KeyA', true);  // Select All
  await sleep(100);
  dispatchKeyCombo(textarea, 'c', 'KeyC', true);  // Copy
  await sleep(200);

  let query = '';
  try {
    query = await navigator.clipboard.readText();
  } catch (e) {
    warn('Clipboard read failed:', e);
    return '';
  }

  // Deselect: End moves the cursor without changing content.
  dispatchKeyCombo(textarea, 'End', 'End', false);

  if (query === savedClipboard) {
    warn('Clipboard unchanged, falling through to next strategy');
    return '';
  }

  return query;
}

// Dispatch a full keydown + keypress + keyup sequence.
// macOS uses metaKey (Cmd); Windows/Linux use ctrlKey (Ctrl).
const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
  || navigator.userAgent.includes('Mac');

function dispatchKeyCombo(target, key, code, withModifier) {
  const opts = {
    key: key,
    code: code,
    keyCode: key === 'a' ? 65 : key === 'c' ? 67 : 0,
    which: key === 'a' ? 65 : key === 'c' ? 67 : 0,
    ctrlKey: withModifier && !isMac,
    metaKey: withModifier && isMac,
    bubbles: true,
    cancelable: true,
    composed: true
  };

  target.dispatchEvent(new KeyboardEvent('keydown', opts));
  target.dispatchEvent(new KeyboardEvent('keypress', opts));
  target.dispatchEvent(new KeyboardEvent('keyup', opts));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Strategy 3: Monaco hidden textarea (accessibility input).
function getQueryFromHiddenTextarea() {
  const textarea = document.querySelector('.monaco-editor textarea.inputarea')
    || document.querySelector('.monaco-editor textarea.monaco-mouse-cursor-text')
    || document.querySelector('.monaco-editor textarea');
  if (textarea && textarea.value && textarea.value.trim().length > 0) {
    return textarea.value;
  }
  return '';
}

// ── UI: Panel ──────────────────────────────────────────────────

function createPanel() {
  const div = document.createElement('div');
  div.id = 'bq-ai-optimizer-panel';
  div.innerHTML = `
    <div class="bq-opt-header">
      <span class="bq-opt-logo">◆</span>
      <span class="bq-opt-title">AI Query Optimizer</span>
      <div class="bq-opt-actions">
        <button id="bq-opt-settings" title="Settings">⚙</button>
        <button id="bq-opt-minimize" title="Minimize">−</button>
        <button id="bq-opt-close" title="Close">✕</button>
      </div>
    </div>
    <div class="bq-opt-body" id="bq-opt-body">
      <div class="bq-opt-idle" id="bq-opt-idle">
        <div id="bq-opt-precheck" style="display:none"></div>
        <p class="bq-opt-hint">Click <strong>Analyze Query</strong> to get AI-powered optimization suggestions.</p>
        <button id="bq-opt-analyze" class="bq-opt-btn-primary">⚡ Analyze Query</button>
      </div>
      <div class="bq-opt-loading" id="bq-opt-loading" style="display:none">
        <div class="bq-opt-spinner"></div>
        <p>Analyzing your query...</p>
      </div>
      <div class="bq-opt-result" id="bq-opt-result" style="display:none">
        <div class="bq-opt-score-row" id="bq-opt-score-row"></div>
        <div class="bq-opt-tabs">
          <button class="bq-opt-tab active" data-tab="issues">Issues</button>
          <button class="bq-opt-tab" data-tab="optimized">Optimized Query</button>
          <button class="bq-opt-tab" data-tab="explanation">Explanation</button>
        </div>
        <div class="bq-opt-tab-content" id="bq-opt-issues"></div>
        <div class="bq-opt-tab-content" id="bq-opt-optimized" style="display:none"></div>
        <div class="bq-opt-tab-content" id="bq-opt-explanation" style="display:none"></div>
        <div class="bq-opt-footer-btns">
          <button id="bq-opt-apply" class="bq-opt-btn-primary">Apply Optimized Query</button>
          <button id="bq-opt-reanalyze" class="bq-opt-btn-secondary">Re-analyze</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(div);

  makeDraggable(div);

  div.querySelector('#bq-opt-close').addEventListener('click', () => div.style.display = 'none');
  div.querySelector('#bq-opt-settings').addEventListener('click', openOptions);
  div.querySelector('#bq-opt-minimize').addEventListener('click', () => {
    const body = div.querySelector('#bq-opt-body');
    const isMin = body.style.display === 'none';
    body.style.display = isMin ? 'flex' : 'none';
    div.querySelector('#bq-opt-minimize').textContent = isMin ? '−' : '+';
  });
  div.querySelector('#bq-opt-analyze').addEventListener('click', analyzeQuery);
  div.querySelector('#bq-opt-reanalyze').addEventListener('click', analyzeQuery);
  div.querySelectorAll('.bq-opt-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      div.querySelectorAll('.bq-opt-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      div.querySelectorAll('.bq-opt-tab-content').forEach(c => c.style.display = 'none');
      div.querySelector(`#bq-opt-${tab.dataset.tab}`).style.display = 'block';
    });
  });
  div.querySelector('#bq-opt-apply').addEventListener('click', applyOptimizedQuery);

  // Delegated handler for "settings" links inserted later via innerHTML.
  div.addEventListener('click', (e) => {
    if (e.target.closest('.bq-opt-open-settings')) {
      e.preventDefault();
      openOptions();
    }
  });

  return div;
}

function makeDraggable(el) {
  const header = el.querySelector('.bq-opt-header');
  let dragging = false, startX, startY, origX, origY;
  header.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON') return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    const rect = el.getBoundingClientRect();
    origX = rect.left; origY = rect.top;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', () => {
      dragging = false;
      document.removeEventListener('mousemove', onMove);
    });
  });
  function onMove(e) {
    if (!dragging) return;
    el.style.left = (origX + e.clientX - startX) + 'px';
    el.style.top = (origY + e.clientY - startY) + 'px';
    el.style.right = 'auto';
  }
}

// ── Quick query read (for the pre-check: no clipboard, no long timeouts) ──

function getQueryQuick() {
  const editorEl = document.querySelector('.monaco-editor');
  if (editorEl) {
    const lines = editorEl.querySelectorAll('.view-line');
    if (lines.length > 0) {
      const text = Array.from(lines).map(l => l.textContent).join('\n').trim();
      if (text.length > 4) return text;
    }
  }

  const textarea = document.querySelector('.monaco-editor textarea.inputarea')
    || document.querySelector('.monaco-editor textarea.monaco-mouse-cursor-text')
    || document.querySelector('.monaco-editor textarea');
  if (textarea && textarea.value && textarea.value.trim().length > 4) {
    return textarea.value.trim();
  }

  return '';
}

// ── Banner helpers ─────────────────────────────────────────────

function banner(borderColor, textColor, html) {
  return `<div style="background:#1a2733;border:1px solid ${borderColor};border-radius:6px;`
    + `padding:10px 12px;margin-bottom:10px;font-size:12px;color:${textColor};">${html}</div>`;
}

// Rendered inside innerHTML, so it is picked up by the delegated click handler
// registered on the panel in createPanel().
const SETTINGS_LINK =
  '<span class="bq-opt-open-settings" style="color:#4fc3f7;cursor:pointer;'
  + 'text-decoration:underline;">settings</span>';

function showNotConfigured(el) {
  el.style.display = 'block';
  el.innerHTML = banner('#f9a825', '#f9a825',
    `⚙️ <strong>Not configured yet.</strong><br>
     <span style="color:#b0bec5;font-size:11px;margin-top:4px;display:inline-block;">
       Set your Cloud Function URL in the extension ${SETTINGS_LINK}, then reopen this panel.
     </span>`);
}

// ── Pre-check: free dry-run estimate ───────────────────────────

async function runPreCheck() {
  if (preCheckInProgress) return;
  preCheckInProgress = true;

  const precheckEl = document.getElementById('bq-opt-precheck');
  if (!precheckEl) { preCheckInProgress = false; return; }

  await loadConfig();

  if (!config.cloudFunctionUrl) {
    showNotConfigured(precheckEl);
    preCheckInProgress = false;
    return;
  }

  precheckEl.style.display = 'block';
  precheckEl.innerHTML = banner('#455a64', '#90a4ae',
    '<span class="bq-opt-mini-spinner"></span> Estimating query cost...');

  // Quick DOM read first — no clipboard or bridge needed for the pre-check.
  let query = getQueryQuick();

  if (!query || query.length < 5) {
    try {
      query = await getQueryFromEditor();
    } catch (e) {
      precheckEl.style.display = 'none';
      preCheckInProgress = false;
      return;
    }
  }

  if (!query || query.length < 5) {
    precheckEl.innerHTML = banner('#455a64', '#90a4ae',
      'ℹ️ No query detected in the editor. Write a SQL query and click <strong>Analyze Query</strong>.');
    preCheckInProgress = false;
    return;
  }

  try {
    const response = await fetch(config.cloudFunctionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, dry_run_only: true })
    });

    const data = await response.json();

    if (data.error) {
      precheckEl.innerHTML = banner('#e53935', '#e53935',
        `❌ Dry run failed: ${escapeHtml(data.error).substring(0, 160)}`);
      preCheckInProgress = false;
      return;
    }

    const gb = data._estimated_gb;
    const thresholdGb = data._threshold_gb;
    const belowThreshold = data._below_threshold;

    if (gb === null || gb === undefined) {
      precheckEl.innerHTML = banner('#455a64', '#90a4ae',
        'ℹ️ Could not estimate query cost. Click <strong>Analyze Query</strong> to proceed.');
    } else if (belowThreshold) {
      precheckEl.innerHTML = banner('#f9a825', '#f9a825',
        `⚠️ <strong>Estimated scan: ${gb} GB</strong> (below the ${thresholdGb} GB threshold)<br>
         <span style="color:#b0bec5;font-size:11px;margin-top:4px;display:inline-block;">
           This is a small query — AI optimization may not be worth the cost. You can still analyze it.
         </span>`);
    } else {
      const extra = gb >= 500
        ? '<span style="color:#e53935;"> — 🔥 Large query! AI optimization recommended.</span>'
        : ' — AI optimization recommended.';
      precheckEl.innerHTML = banner('#43a047', '#43a047',
        `📊 <strong>Estimated scan: ${gb} GB</strong>${extra}`);
    }

  } catch (err) {
    warn('Pre-check failed:', err);
    precheckEl.innerHTML = banner('#455a64', '#90a4ae',
      `ℹ️ Could not reach the optimizer service. Check the URL in ${SETTINGS_LINK},
       or click <strong>Analyze Query</strong> to retry.`);
  }

  preCheckInProgress = false;
}

// ── Core: analyze query ────────────────────────────────────────

async function analyzeQuery() {
  await loadConfig();

  if (!config.cloudFunctionUrl) {
    const precheckEl = document.getElementById('bq-opt-precheck');
    if (precheckEl) showNotConfigured(precheckEl);
    openOptions();
    return;
  }

  let query;
  try {
    query = await getQueryFromEditor();
  } catch (e) {
    console.error('[BQ-Opt] Query extraction error:', e);
    alert('Error reading query: ' + e.message);
    return;
  }

  if (!query || query.length < 5) {
    alert('No query found in the editor. Please write a SQL query first.');
    return;
  }

  showSection('loading');

  const loadingEl = document.getElementById('bq-opt-loading');
  const timerEl = loadingEl ? loadingEl.querySelector('p') : null;
  const startTime = Date.now();
  const timerInterval = setInterval(() => {
    const s = Math.round((Date.now() - startTime) / 1000);
    if (timerEl) timerEl.textContent = `Analyzing your query... (${s}s)`;
  }, 1000);

  try {
    log(`Sending query to Cloud Function (${query.length} chars)`);

    const response = await fetch(config.cloudFunctionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });

    const data = await response.json();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (data.error) {
      console.error('[BQ-Opt] Cloud Function error:', data.error);
      clearInterval(timerInterval);
      showSection('idle');
      alert(`Analysis failed (${elapsed}s): ${data.error}`);
      return;
    }

    log(`Response in ${elapsed}s (server: ${data._elapsed_seconds}s) — `
      + `model: ${data._model}, score: ${data.score}, issues: ${data.issues?.length}`);

    lastOptimizedQuery = data.optimized_query || '';
    clearInterval(timerInterval);
    renderResult(data, query);
    showSection('result');

  } catch (err) {
    clearInterval(timerInterval);
    console.error('[BQ-Opt] Request failed:', err);
    showSection('idle');
    alert('Error: ' + err.message
      + '\n\nCheck that the Cloud Function URL in the extension settings is correct.');
  }
}

// ── Render results ─────────────────────────────────────────────

function renderResult(result, originalQuery) {
  const p = document.getElementById('bq-ai-optimizer-panel');

  const gradeColors = {
    critical: '#e53935', poor: '#fb8c00', fair: '#f9a825',
    good: '#43a047', excellent: '#00897b'
  };
  const color = gradeColors[result.grade] || '#888';

  // Caution banner when the query is below the byte threshold.
  let cautionHtml = '';
  if (result._below_threshold && result._estimated_gb !== null) {
    cautionHtml = banner('#f9a825', '#f9a825',
      `⚠️ <strong>Caution:</strong> this query processes only
       <strong>${result._estimated_gb} GB</strong> (below the ${result._threshold_gb} GB threshold).
       AI optimization may not be worth the cost for small queries.`);
  }

  const estInfo = result._estimated_gb !== null && result._estimated_gb !== undefined
    ? ` · Est: ${result._estimated_gb} GB` : '';

  p.querySelector('#bq-opt-score-row').innerHTML = cautionHtml + `
    <div class="bq-opt-score-badge" style="border-color:${color};color:${color}">
      <span class="bq-opt-score-num">${result.score}</span>
      <span class="bq-opt-score-label">/100</span>
    </div>
    <div>
      <div class="bq-opt-grade" style="color:${color}">${(result.grade || '').toUpperCase()}</div>
      <div class="bq-opt-issues-count">${result.issues?.length || 0} issue${result.issues?.length !== 1 ? 's' : ''} found</div>
      <div class="bq-opt-meta" style="font-size:11px;color:#888;margin-top:2px">Model: ${result._model || '?'} · ${result._elapsed_seconds || '?'}s${estInfo}</div>
    </div>
  `;

  // Issues
  const issuesEl = p.querySelector('#bq-opt-issues');
  if (!result.issues || result.issues.length === 0) {
    issuesEl.innerHTML = '<p class="bq-opt-noissues">✓ No issues found. Query follows best practices!</p>';
  } else {
    issuesEl.innerHTML = result.issues.map(issue => {
      const icons = { critical: '🔴', warning: '🟡', info: '🔵' };
      return `<div class="bq-opt-issue bq-opt-issue-${issue.severity}">
        <div class="bq-opt-issue-title">${icons[issue.severity] || '•'} ${escapeHtml(issue.title)}</div>
        <div class="bq-opt-issue-desc">${escapeHtml(issue.description)}</div>
      </div>`;
    }).join('');
  }

  // Optimized query
  const isSame = normalizeQuery(result.optimized_query) === normalizeQuery(originalQuery);
  const hasIssues = result.issues && result.issues.length > 0;
  let optimizedHtml;
  if (isSame && !hasIssues) {
    optimizedHtml = '<p class="bq-opt-noissues">✓ Query is already well-optimized. No changes needed.</p>';
  } else if (isSame && hasIssues) {
    optimizedHtml = '<p class="bq-opt-noissues" style="color:#f9a825">⚠ Query returned unchanged (complex query — manual review recommended).</p>'
      + '<p style="color:#aaa;font-size:12px;margin-top:8px;">The model kept the original query to preserve correctness. Apply the suggestions from the <strong>Issues</strong> tab manually.</p>';
  } else {
    optimizedHtml = `<div class="bq-opt-query-block"><pre>${escapeHtml(result.optimized_query)}</pre></div>`;
  }
  p.querySelector('#bq-opt-optimized').innerHTML = optimizedHtml;

  // Explanation
  p.querySelector('#bq-opt-explanation').innerHTML =
    `<p class="bq-opt-explain-text">${escapeHtml(result.explanation || '')}</p>`;

  p.querySelector('#bq-opt-apply').style.display = isSame ? 'none' : 'inline-block';
}

function normalizeQuery(q) { return (q || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Apply optimized query ──────────────────────────────────────

function applyOptimizedQuery() {
  if (!lastOptimizedQuery) return;
  const combo = isMac ? 'Cmd+A then Cmd+V' : 'Ctrl+A then Ctrl+V';
  navigator.clipboard.writeText(lastOptimizedQuery).then(() => {
    showToast(`Copied to clipboard! Paste into the editor (${combo}).`);
  }).catch(() => {
    showToast('Could not copy automatically — select the query text and copy it manually.');
  });
}

// ── Helpers ────────────────────────────────────────────────────

function showSection(section) {
  ['idle', 'loading', 'result'].forEach(s => {
    const el = document.getElementById(`bq-opt-${s}`);
    if (el) el.style.display = s === section ? (s === 'result' ? 'flex' : 'block') : 'none';
  });
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'bq-opt-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ── Inject trigger button ──────────────────────────────────────

// Keep the button scoped to BigQuery — without this it would appear on every
// Cloud Console page (Cloud Storage, IAM, and so on).
function isBigQueryPage() {
  return window.location.href.includes('/bigquery')
    || (window.location.href.includes('ws=') && document.querySelector('.monaco-editor'));
}

function injectButton() {
  if (document.getElementById('bq-ai-trigger-btn')) return;
  if (!isBigQueryPage()) return;

  const targets = [
    '.bqui-run-query-button',
    '[data-testid="run-query-button"]',
    '.run-query',
    '.query-run-button'
  ];
  let toolbar = null;
  for (const sel of targets) {
    toolbar = document.querySelector(sel)?.parentElement;
    if (toolbar) break;
  }

  const btn = document.createElement('button');
  btn.id = 'bq-ai-trigger-btn';
  btn.innerHTML = '◆ AI Optimize';

  if (toolbar) {
    btn.className = 'bq-ai-toolbar-btn';
    toolbar.appendChild(btn);
  } else {
    btn.className = 'bq-ai-float-trigger';
    document.body.appendChild(btn);
  }

  btn.addEventListener('click', () => {
    if (!panel) panel = createPanel();
    const wasHidden = panel.style.display === 'none' || panel.style.display === '';
    panel.style.display = wasHidden ? 'flex' : 'none';
    if (wasHidden) runPreCheck();
  });
}

// ── Init ───────────────────────────────────────────────────────

const observer = new MutationObserver(() => {
  if (!injected && isBigQueryPage()) {
    injectButton();
    if (document.getElementById('bq-ai-trigger-btn')) injected = true;
  }
  // Remove the button when the user navigates away from BigQuery.
  if (injected && !isBigQueryPage()) {
    const btn = document.getElementById('bq-ai-trigger-btn');
    if (btn) btn.remove();
    if (panel) panel.style.display = 'none';
    injected = false;
  }
});
observer.observe(document.body, { childList: true, subtree: true });
setTimeout(injectButton, 2000);
setTimeout(injectButton, 5000);
