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

  // ---- dashboard status card (injected into the Fluidd dashboard) --------

  var CARD_PATHS = [
    'axis0.current_state',
    'axis0.encoder.pos_estimate',
    'axis0.encoder.vel_estimate',
    'vbus_voltage',
    'axis0.motor.current_control.Iq_measured',
    'axis0.error'
  ];
  var STATE_NAMES = {
    0: 'UNDEFINED', 1: 'IDLE', 2: 'STARTUP', 3: 'FULL CALIB', 4: 'MOTOR CAL',
    5: 'SENSORLESS', 6: 'INDEX SEARCH', 7: 'ENC OFFSET CAL', 8: 'CLOSED LOOP',
    9: 'LOCKIN', 10: 'DIR FIND', 11: 'HOMING'
  };

  function cardEl(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  var cardWrap = null, cardDot = null, cardState = null, cardPos = null,
      cardVel = null, cardVbus = null, cardIq = null, cardErr = null;

  function buildCard() {
    var wrap = cardEl('div', 'col col-12 col-sm-6 col-md-4 od-card-col');
    var card = cardEl('div', 'v-card v-sheet theme--dark');
    card.style.minHeight = '140px';
    var head = cardEl('div', 'd-flex align-center justify-space-between px-4 pt-3');
    var t = cardEl('span', 'title', 'ODrive');
    var dotWrap = cardEl('div', 'd-flex align-center');
    cardDot = cardEl('span');
    cardDot.style.cssText = 'width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:6px;background:#888;';
    var st = cardEl('span', 'caption', 'offline');
    cardDot._st = st;
    dotWrap.appendChild(cardDot); dotWrap.appendChild(st);
    head.appendChild(t); head.appendChild(dotWrap);
    card.appendChild(head);

    var body = cardEl('div', 'px-4 py-2');
    function row(label) {
      var r = cardEl('div', 'd-flex justify-space-between py-1');
      r.style.borderBottom = '1px solid rgba(128,128,128,.15)';
      var l = cardEl('span', 'caption', label);
      l.style.opacity = '.7';
      var v = cardEl('span', 'body-2', '--');
      r.appendChild(l); r.appendChild(v);
      body.appendChild(r);
      return v;
    }
    cardState = row('State');
    cardPos = row('Position');
    cardVel = row('Velocity');
    cardVbus = row('Vbus');
    cardIq = row('Iq');
    cardErr = row('Error');
    card.appendChild(body);
    wrap.appendChild(card);
    return wrap;
  }

  function fmt(v, unit, digits) {
    return (typeof v === 'number' ? v.toFixed(digits) : '--') + (unit ? ' ' + unit : '');
  }

  function pollCard() {
    fetch(PANEL_URL + 'api/devices', { mode: 'cors' })
      .then(function (r) { return r.json(); })
      .then(function (devs) {
        if (!devs || !devs.length) throw new Error('no device');
        var ser = devs[0].serial_number || devs[0].serial;
        return fetch(PANEL_URL + 'api/devices/' + ser + '/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: CARD_PATHS })
        }).then(function (r) { return r.json(); });
      })
      .then(function (res) {
        if (cardDot) {
          cardDot.style.background = '#4caf50';
          if (cardDot._st) cardDot._st.textContent = 'connected';
        }
        var v = function (p) { return res && res[p] && typeof res[p] === 'object' ? undefined : res[p]; };
        var st = v('axis0.current_state');
        if (cardState) cardState.textContent = STATE_NAMES[st] !== undefined ? STATE_NAMES[st] : String(st);
        if (cardPos) cardPos.textContent = fmt(v('axis0.encoder.pos_estimate'), '', 3);
        if (cardVel) cardVel.textContent = fmt(v('axis0.encoder.vel_estimate'), '/s', 2);
        if (cardVbus) cardVbus.textContent = fmt(v('vbus_voltage'), 'V', 1);
        if (cardIq) cardIq.textContent = fmt(v('axis0.motor.current_control.Iq_measured'), 'A', 2);
        var err = v('axis0.error');
        if (cardErr) {
          cardErr.textContent = err ? '0x' + (err >>> 0).toString(16) : 'none';
          cardErr.style.color = err ? '#ff5252' : '';
        }
      })
      .catch(function () {
        if (cardDot) {
          cardDot.style.background = '#888';
          if (cardDot._st) cardDot._st.textContent = 'offline';
        }
        if (cardState) cardState.textContent = '--';
      });
  }

  function tryMountCard() {
    if (cardWrap && cardWrap.isConnected) return;
    var main = document.querySelector('.v-main .container');
    if (!main) return;
    var row = main.querySelector('.row');
    if (!row) return;
    if (!cardWrap) cardWrap = buildCard();
    row.insertBefore(cardWrap, row.firstChild);
  }

  setInterval(tryMountCard, 1500);
  setInterval(pollCard, 700);
})();
