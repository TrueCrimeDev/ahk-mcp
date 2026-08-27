export const STUDIO_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AHK Macro Studio</title>
  <link rel="stylesheet" href="/studio/styles.css">
  <script src="/studio/app.js" defer></script>
  <script src="/studio/webmcp.js" defer></script>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Local automation</p>
      <h1>AHK Macro Studio</h1>
      <p>Preview and stage a trusted macro before approving native execution.</p>
    </header>
    <section aria-labelledby="macro-heading">
      <h2 id="macro-heading">1. Choose a macro</h2>
      <div id="macro-list" class="macro-list" aria-live="polite"></div>
      <p id="selected-macro">Loading macros…</p>
    </section>
    <section aria-labelledby="preview-heading">
      <h2 id="preview-heading">2. Preview</h2>
      <label for="message">Desktop message</label>
      <input id="message" name="message" maxlength="120" required value="Hello from AHK Macro Studio">
      <button id="preview-button" type="button" disabled>Create preview</button>
      <pre id="preview-panel" aria-live="polite">No preview yet.</pre>
    </section>
    <section aria-labelledby="run-heading">
      <h2 id="run-heading">3. Stage and review</h2>
      <div class="actions">
        <button id="stage-button" type="button" disabled>Stage run</button>
        <button id="status-button" type="button" disabled>Refresh status</button>
        <button id="approve-button" class="approve" type="button" disabled>Approve on this computer</button>
      </div>
      <pre id="run-panel" aria-live="polite">No run staged.</pre>
    </section>
    <p id="studio-error" class="error" role="alert"></p>
  </main>
</body>
</html>`;

export const STUDIO_CSS = `
:root {
  color-scheme: light dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  background: #10141b;
  color: #f5f7fa;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #253044, #10141b 55%); }
main { width: min(760px, calc(100% - 2rem)); margin: 0 auto; padding: 3rem 0 5rem; }
header, section { background: rgba(20, 26, 36, .94); border: 1px solid #354257; border-radius: 16px; padding: 1.25rem; margin-bottom: 1rem; box-shadow: 0 14px 36px rgba(0,0,0,.22); }
h1, h2, p { margin-top: 0; }
h1 { margin-bottom: .5rem; font-size: clamp(2rem, 7vw, 3.4rem); }
h2 { font-size: 1.1rem; }
.eyebrow { color: #82d7ff; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
label { display: block; margin-bottom: .4rem; font-weight: 650; }
input { width: 100%; border: 1px solid #596b85; border-radius: 9px; padding: .8rem; margin-bottom: .8rem; font: inherit; background: #111722; color: inherit; }
button { border: 0; border-radius: 9px; padding: .72rem 1rem; font: inherit; font-weight: 700; color: #06111a; background: #82d7ff; cursor: pointer; }
button:hover:not(:disabled) { filter: brightness(1.08); }
button:focus-visible, input:focus-visible { outline: 3px solid #ffd36a; outline-offset: 3px; }
button:disabled { cursor: not-allowed; opacity: .42; }
.approve { background: #ffd36a; }
.actions, .macro-list { display: flex; flex-wrap: wrap; gap: .65rem; margin-bottom: .9rem; }
.macro-list button[aria-pressed="true"] { background: #c5f59c; }
pre { margin: 0; border-radius: 9px; padding: 1rem; background: #090d13; color: #d9e7f5; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.error { min-height: 1.5rem; color: #ffaaa3; font-weight: 700; }
@media (max-width: 520px) { main { padding-top: 1rem; } header, section { border-radius: 12px; } button { width: 100%; } }
`;

export const STUDIO_APP_JS = `(function () {
  'use strict';

  var state = { macroId: null, preview: null, run: null };
  var macroList = document.getElementById('macro-list');
  var selectedMacro = document.getElementById('selected-macro');
  var messageInput = document.getElementById('message');
  var previewButton = document.getElementById('preview-button');
  var stageButton = document.getElementById('stage-button');
  var statusButton = document.getElementById('status-button');
  var approveButton = document.getElementById('approve-button');
  var previewPanel = document.getElementById('preview-panel');
  var runPanel = document.getElementById('run-panel');
  var errorPanel = document.getElementById('studio-error');

  function showJson(panel, value) {
    panel.textContent = JSON.stringify(value, null, 2);
  }

  function showError(error) {
    errorPanel.textContent = error && error.message ? error.message : 'Studio request failed.';
  }

  async function requestJson(path, options) {
    errorPanel.textContent = '';
    var response = await fetch(path, options);
    var body = await response.json();
    if (!response.ok) throw new Error(body.message || 'Studio request failed.');
    return body;
  }

  function selectMacro(macro) {
    state.macroId = macro.id;
    selectedMacro.textContent = macro.title + ' — ' + macro.effect;
    previewButton.disabled = false;
    var choices = macroList.querySelectorAll('button');
    choices.forEach(function (choice) {
      choice.setAttribute('aria-pressed', choice.dataset.macroId === macro.id ? 'true' : 'false');
    });
  }

  function renderMacros(result) {
    macroList.replaceChildren();
    result.macros.forEach(function (macro) {
      var choice = document.createElement('button');
      choice.type = 'button';
      choice.dataset.macroId = macro.id;
      choice.textContent = macro.title;
      choice.setAttribute('aria-pressed', 'false');
      choice.addEventListener('click', function () { selectMacro(macro); });
      macroList.appendChild(choice);
    });
    if (result.macros.length > 0) selectMacro(result.macros[0]);
    else selectedMacro.textContent = 'No trusted macros are available.';
  }

  function acceptPreview(result) {
    state.preview = result;
    state.run = null;
    showJson(previewPanel, result);
    runPanel.textContent = 'No run staged.';
    stageButton.disabled = false;
    statusButton.disabled = true;
    approveButton.disabled = true;
  }

  function acceptRun(result) {
    state.run = result;
    showJson(runPanel, result);
    statusButton.disabled = false;
    approveButton.disabled = result.state !== 'pending_approval';
  }

  previewButton.addEventListener('click', async function () {
    try {
      var result = await requestJson('/studio/api/previews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ macroId: state.macroId, parameters: { message: messageInput.value } })
      });
      acceptPreview(result);
    } catch (error) { showError(error); }
  });

  stageButton.addEventListener('click', async function () {
    if (!state.preview) return;
    try {
      var result = await requestJson('/studio/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ previewId: state.preview.previewId })
      });
      acceptRun(result);
      stageButton.disabled = true;
    } catch (error) { showError(error); }
  });

  statusButton.addEventListener('click', async function () {
    if (!state.run) return;
    try {
      acceptRun(await requestJson('/studio/api/runs/' + encodeURIComponent(state.run.runId)));
    } catch (error) { showError(error); }
  });

  approveButton.addEventListener('click', async function () {
    if (!state.run || state.run.state !== 'pending_approval') return;
    approveButton.disabled = true;
    try {
      acceptRun(await requestJson('/studio/api/runs/' + encodeURIComponent(state.run.runId) + '/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      }));
    } catch (error) { showError(error); }
  });

  document.addEventListener('ahk-studio-tool-result', function (event) {
    var detail = event.detail || {};
    if (detail.tool === 'list_ahk_macros') renderMacros(detail.result);
    if (detail.tool === 'preview_ahk_macro') acceptPreview(detail.result);
    if (detail.tool === 'request_ahk_macro_run' || detail.tool === 'get_ahk_run_status') acceptRun(detail.result);
  });

  requestJson('/studio/api/macros').then(renderMacros).catch(showError);
}());`;

export const STUDIO_WEBMCP_JS = `(function () {
  'use strict';

  async function requestJson(path, options) {
    var response = await fetch(path, options);
    var result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Studio request failed.');
    return result;
  }

  function publish(tool, result) {
    document.dispatchEvent(new CustomEvent('ahk-studio-tool-result', {
      detail: { tool: tool, result: result }
    }));
    return result;
  }

  var emptyInput = {
    type: 'object',
    properties: {},
    additionalProperties: false
  };
  var previewInput = {
    type: 'object',
    properties: {
      macroId: { type: 'string', enum: ['show_desktop_message'] },
      parameters: {
        type: 'object',
        properties: { message: { type: 'string', minLength: 1, maxLength: 120 } },
        required: ['message'],
        additionalProperties: false
      }
    },
    required: ['macroId', 'parameters'],
    additionalProperties: false
  };
  var runRequestInput = {
    type: 'object',
    properties: { previewId: { type: 'string', format: 'uuid' } },
    required: ['previewId'],
    additionalProperties: false
  };
  var runStatusInput = {
    type: 'object',
    properties: { runId: { type: 'string', format: 'uuid' } },
    required: ['runId'],
    additionalProperties: false
  };

  globalThis.__ahkStudioWebMcpReady = (async function () {
    if (!document.modelContext || typeof document.modelContext.registerTool !== 'function') return;
    var modelContext = document.modelContext;

    await modelContext.registerTool({
      name: 'list_ahk_macros',
      description: 'List the trusted local AutoHotkey macros available in the Studio.',
      annotations: { readOnlyHint: true },
      inputSchema: emptyInput,
      async execute() {
        return publish('list_ahk_macros', await requestJson('/studio/api/macros'));
      }
    });
    await modelContext.registerTool({
      name: 'preview_ahk_macro',
      description: 'Create a non-executing preview of a trusted AutoHotkey macro.',
      annotations: { readOnlyHint: true },
      inputSchema: previewInput,
      async execute(input) {
        return publish('preview_ahk_macro', await requestJson('/studio/api/previews', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input)
        }));
      }
    });
    await modelContext.registerTool({
      name: 'request_ahk_macro_run',
      description: 'Stage a previewed macro for a separate human approval step.',
      annotations: { readOnlyHint: false },
      inputSchema: runRequestInput,
      async execute(input) {
        return publish('request_ahk_macro_run', await requestJson('/studio/api/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input)
        }));
      }
    });
    await modelContext.registerTool({
      name: 'get_ahk_run_status',
      description: 'Read the current status of a staged AutoHotkey macro run.',
      annotations: { readOnlyHint: true },
      inputSchema: runStatusInput,
      async execute(input) {
        return publish('get_ahk_run_status', await requestJson('/studio/api/runs/' + encodeURIComponent(input.runId)));
      }
    });
  }());
}());`;
