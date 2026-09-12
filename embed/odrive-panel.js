// Floating ODrive panel for Fluidd.
// Injected into Fluidd's index.html by install.sh. Adds a small "OD" toggle
// button in the bottom-right corner that opens the ODrive Web UI (served on
// port 3000 of the same host) inside an embedded iframe panel.
(function () {
  if (window.__odrivePanelLoaded) return;
  window.__odrivePanelLoaded = true;

  var PANEL_URL = 'http://' + (location.hostname || 'localhost') + ':3000/';
  var STORAGE_KEY = 'odrivePanelOpen';

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text) e.textContent = text;
    return e;
  }

  var css = el('style');
  css.textContent = [
    '#odrive-panel-toggle{position:fixed;right:16px;bottom:16px;z-index:9998;',
      'width:52px;height:52px;border-radius:50%;border:1px solid rgba(128,128,128,.5);',
      'background:#1976d2;color:#fff;font-weight:700;font-size:15px;cursor:pointer;',
      'box-shadow:0 2px 8px rgba(0,0,0,.4);}',
    '#odrive-panel{position:fixed;right:16px;bottom:78px;z-index:9999;width:760px;height:600px;',
      'max-width:calc(100vw - 32px);max-height:calc(100vh - 110px);display:none;flex-direction:column;',
      'background:var(--v-anchor-base,#1e1e1e);border:1px solid rgba(128,128,128,.5);',
      'border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,.5);overflow:hidden;}',
    '#odrive-panel.open{display:flex;}',
    '#odrive-panel-header{display:flex;align-items:center;justify-content:space-between;',
      'padding:4px 8px;background:rgba(128,128,128,.15);font-size:13px;}',
    '#odrive-panel iframe{flex:1;border:0;width:100%;}'
  ].join('');
  document.head.appendChild(css);

  var toggle = el('button', { id: 'odrive-panel-toggle', title: 'ODrive panel' }, 'OD');
  toggle.addEventListener('click', function () { setPanel(!panel.classList.contains('open')); });

  var panel = el('div', { id: 'odrive-panel' });
  var header = el('div', { id: 'odrive-panel-header' });
  var title = el('span', null, 'ODrive');
  var right = el('div');
  var pop = el('a', { href: PANEL_URL, target: '_blank', style: 'color:inherit;margin-right:10px;text-decoration:none;' }, 'open in tab');
  var close = el('a', { href: '#', style: 'color:inherit;text-decoration:none;' }, '[x]');
  close.addEventListener('click', function (ev) { ev.preventDefault(); setPanel(false); });
  right.appendChild(pop); right.appendChild(close);
  header.appendChild(title); header.appendChild(right);

  var frame = el('iframe', { src: PANEL_URL, allow: 'clipboard-read; clipboard-write' });
  panel.appendChild(header); panel.appendChild(frame);

  function setPanel(open) {
    panel.classList.toggle('open', open);
    try { localStorage.setItem(STORAGE_KEY, open ? '1' : '0'); } catch (e) {}
  }

  function mount() {
    document.body.appendChild(panel);
    document.body.appendChild(toggle);
    var saved = '0';
    try { saved = localStorage.getItem(STORAGE_KEY) || '0'; } catch (e) {}
    if (saved === '1') setPanel(true);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
