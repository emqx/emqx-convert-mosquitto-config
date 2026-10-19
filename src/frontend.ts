import { examples } from './examples.js';

export function frontend(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mosquitto → EMQX · Configuration converter</title>
  <style>
    :root{color-scheme:light;--ink:#163a35;--muted:#5b716c;--green:#007969;--line:#d3e0da;--paper:#f5f8f4}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 system-ui,-apple-system,sans-serif}
    header,main,footer{max-width:1380px;margin:auto;padding:28px 40px}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line)}
    .brand{font-weight:750;letter-spacing:.06em}.tag,.eyebrow{font:11px/1.5 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.12em}.tag{border:1px solid var(--line);border-radius:20px;padding:6px 12px}
    h1{font-size:clamp(30px,4vw,48px);line-height:1.15;letter-spacing:-.04em;margin:12px 0 16px}h1 span{color:var(--green)}h2{font-size:16px;margin:0}.intro{max-width:760px;color:var(--muted);margin-bottom:28px}
    .examples{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}.examples span{align-self:center;margin-right:8px;font-size:12px;color:var(--muted)}
    button,.file-label{font:inherit;font-size:13px;border:1px solid var(--line);background:white;border-radius:7px;padding:9px 14px;cursor:pointer;color:var(--ink)}button:hover,.file-label:hover{border-color:var(--green);background:#eaf5ee}button:disabled{opacity:.45;cursor:default}
    .primary{background:var(--green);color:white;border-color:var(--green);font-weight:650;padding:12px 20px}.primary:hover{background:#006252;color:white}button:focus-visible,textarea:focus-visible,.file-label:focus-within{outline:3px solid #62bdad;outline-offset:3px}
    .editors{display:grid;grid-template-columns:1fr 1fr;gap:20px}.panel{min-width:0;border:1px solid var(--line);border-radius:12px;background:white;overflow:hidden}.panel-head{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px}.panel-head span{font-size:12px;color:var(--muted)}
    textarea{display:block;width:100%;height:430px;resize:vertical;border:0;padding:20px;background:#fff;color:#23423b;font:13px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:2;white-space:pre;overflow:auto}.output textarea{background:#112e2b;color:#c8ece0}.panel-foot{padding:12px 20px;border-top:1px solid var(--line);display:flex;gap:8px;align-items:center;min-height:64px}.panel-foot small{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .actions{margin:20px 0;display:flex;gap:14px;align-items:center;flex-wrap:wrap}.actions small{color:var(--muted)}#status{font-size:13px;min-height:24px}#status.error{color:#a42c22}
    #review{border:1px solid #e4c78b;background:#fff9ed;padding:20px;border-radius:12px;margin-top:12px}#review ul{padding-left:20px;margin-bottom:0}#review li{margin:8px 0;font-size:13px;overflow-wrap:anywhere}.count{font-size:12px;color:#845c13;font-weight:500;margin-left:8px}
    .notes{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;margin-top:36px;border-top:1px solid var(--line);padding-top:24px}.notes h3{font-size:13px;margin:0 0 8px}.notes p,footer{font-size:12px;color:var(--muted)}.notes p{margin:0}footer{border-top:1px solid var(--line);margin-top:20px}a{color:var(--green)}
    .sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}[hidden]{display:none!important}
    @media(max-width:800px){header,main,footer{padding:20px}.editors,.notes{grid-template-columns:1fr}textarea{height:330px}.tag{font-size:9px}}
  </style>
</head>
<body>
  <header><div class="brand">EMQX <span style="font-weight:400;color:var(--muted)">/ migration tools</span></div><span class="tag">Mosquitto 2.0.x → EMQX 6.3.2</span></header>
  <main>
    <div class="eyebrow">Configuration converter</div>
    <h1>From Mosquitto <span>to EMQX.</span></h1>
    <p class="intro">Bring your broker configuration with you. Convert listeners, TLS, MQTT limits and persistence to HOCON, with clear guidance for settings that need your attention.</p>
    <div class="examples"><span>Try an example</span>${Object.entries(examples)
      .map(
        ([key, ex]) =>
          `<button type="button" data-example="${key}">${ex.label}</button>`
      )
      .join('')}</div>
    <form id="converter">
      <div class="editors">
        <section class="panel">
          <div class="panel-head"><h2><label for="input">Mosquitto configuration</label></h2><span>mosquitto.conf</span></div>
          <textarea id="input" spellcheck="false" placeholder="# Paste your mosquitto.conf here&#10;listener 1883 127.0.0.1&#10;allow_anonymous true"></textarea>
          <div class="panel-foot"><label class="file-label">Upload .conf<input class="sr-only" type="file" id="file" accept=".conf,.cfg,.txt,text/plain"></label><small id="filename">or paste your configuration above</small><button type="button" id="clear">Clear</button></div>
        </section>
        <section class="panel output">
          <div class="panel-head"><h2><label for="output">EMQX configuration</label></h2><span>emqx.hocon</span></div>
          <textarea id="output" spellcheck="false" readonly placeholder="# Your converted HOCON will appear here"></textarea>
          <div class="panel-foot"><button type="button" id="copy" disabled>Copy HOCON</button><button type="button" id="download" disabled>Download .hocon</button></div>
        </section>
      </div>
      <div class="actions"><button class="primary" id="convert" type="submit">Convert configuration →</button><small>Runs locally. Your configuration stays on this machine.</small></div>
      <p id="status" role="status" aria-live="polite"></p>
    </form>
    <section id="review" hidden aria-labelledby="review-title"><h2 id="review-title">Migration notes <span class="count" id="count"></span></h2><ul id="warnings"></ul></section>
    <div class="notes">
      <div><h3>Review before applying</h3><p>Output targets a fresh EMQX 6.3.2 instance. Built-in MQTT listeners are disabled. Existing cluster overrides and dashboard settings need separate review.</p></div>
      <div><h3>Access controls need care</h3><p>Password files, ACLs and authentication plugins need manual migration. Affected listeners stay disabled until their policies are configured.</p></div>
      <div><h3>Keep local files local</h3><p>Certificate and credential files are never fetched. For include_dir, use the CLI locally or inline your configuration. Use the CLI to resolve local include directories.</p></div>
    </div>
  </main>
  <footer>Based on the <a href="https://mosquitto.org/man/mosquitto-conf-5.html" target="_blank" rel="noreferrer">Mosquitto configuration reference</a> and the <a href="https://docs.emqx.com/en/emqx/v6.3.2/hocon/" target="_blank" rel="noreferrer">EMQX HOCON schema</a>.</footer>
  <script>
    const examples = ${JSON.stringify(examples).replace(/</g, '\\u003c')};
    const $ = (id) => document.getElementById(id);
    let revision = 0;
    let pending;
    function status(message, error = false) { $('status').textContent = message; $('status').className = error ? 'error' : ''; }
    function invalidate() {
      revision++; if (pending) pending.abort();
      $('convert').disabled = false; $('convert').textContent = 'Convert configuration →';
      $('output').value = ''; $('copy').disabled = true; $('download').disabled = true; $('review').hidden = true; status('');
    }
    $('input').addEventListener('input', invalidate);
    $('clear').addEventListener('click', () => { $('input').value = ''; $('file').value = ''; $('filename').textContent = 'or paste your configuration above'; invalidate(); $('input').focus(); });
    document.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', () => {
      invalidate(); $('input').value = examples[button.dataset.example].content; $('filename').textContent = examples[button.dataset.example].label; $('file').value = '';
    }));
    $('file').addEventListener('change', async () => {
      const file = $('file').files[0]; if (!file) return;
      invalidate(); const current = revision;
      if (file.size > 1024 * 1024) { status('Choose a configuration file smaller than 1 MiB.', true); return; }
      try { const content = await file.text(); if (revision !== current) return; $('input').value = content; $('filename').textContent = file.name; }
      catch { status('Could not read this file.', true); }
    });
    $('converter').addEventListener('submit', async event => {
      event.preventDefault(); invalidate();
      const current = revision; const controller = new AbortController(); pending = controller;
      $('convert').disabled = true; $('convert').textContent = 'Converting…'; status('Converting configuration…');
      try {
        const response = await fetch('/convert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: $('input').value }), signal: controller.signal });
        const result = await response.json(); if (revision !== current) return;
        if (!response.ok || result.error) throw new Error(result.error || 'Conversion failed.');
        $('output').value = result.hocon; $('copy').disabled = false; $('download').disabled = false;
        $('warnings').replaceChildren();
        for (const warning of result.warnings) { const li = document.createElement('li'); li.textContent = (warning.line ? 'Line ' + warning.line + ': ' : '') + warning.message; $('warnings').append(li); }
        $('count').textContent = result.warnings.length + ' to review'; $('review').hidden = result.warnings.length === 0;
        status(result.disabledListeners.length ? 'Converted. ' + result.disabledListeners.length + ' listener(s) require manual migration before enabling.' : 'Converted. Review the migration notes before applying.');
      } catch (error) { if (error.name !== 'AbortError' && revision === current) status(error.message, true); }
      finally { if (revision === current) { $('convert').disabled = false; $('convert').textContent = 'Convert configuration →'; pending = undefined; } }
    });
    $('copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('output').value); status('HOCON copied to clipboard.'); }
      catch { $('output').focus(); $('output').select(); status('Clipboard unavailable. The output is selected; copy it with your keyboard.'); }
    });
    $('download').addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([$('output').value], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a'); a.href = url; a.download = 'emqx.hocon'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  </script>
</body>
</html>`;
}
