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
      cardVel = null, cardVbus = null, cardIq = null, cardErr = null,
      cardBody = null, cardChev = null;

  var svgFlash = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" style="vertical-align:middle;margin-right:8px;"><path d="M7,2V13H10V22L17,10H13L17,2H7Z"/></svg>';
  var svgChevron = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="currentColor" style="transition:transform .2s;"><path d="M7.41,15.41L12,10.83L16.59,15.41L18,14L12,8L6,14L7.41,15.41Z"/></svg>';
  var svgOpen = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.89 3,5V19C3,20.1 3.89,21 5,21H19C20.1,21 21,20.1 21,19V12H19V19Z"/></svg>';

  function buildCard() {
    var wrap = cardEl('div', 'col col-12 col-sm-6 col-md-4 od-card-col');
    var card = cardEl('div', 'v-card v-sheet theme--dark collapsable-card');

    // header, mirroring fluidd's CollapsableCard.vue
    var title = cardEl('div', 'v-card__title collapsable-card-title card-heading py-2 px-4');
    var hrow = cardEl('div', 'row no-gutters flex-nowrap');
    var colL = cardEl('div', 'col align-self-center text-no-wrap');
    var iconSpan = cardEl('span');
    iconSpan.style.cssText = 'display:inline-flex;vertical-align:middle;opacity:.85;margin-right:8px;';
    iconSpan.innerHTML = svgFlash;
    colL.appendChild(iconSpan);
    colL.appendChild(cardEl('span', 'font-weight-light', 'ODrive'));
    var colR = cardEl('div', 'col col-auto align-self-center d-flex align-center');
    var openBtn = cardEl('button', 'v-btn v-btn--icon v-btn--round v-size--default theme--dark mr-1');
    openBtn.title = 'open ODrive GUI';
    openBtn.style.cssText = 'width:28px;height:28px;';
    var openC = cardEl('span', 'v-btn__content');
    openC.innerHTML = svgOpen;
    openBtn.appendChild(openC);
    openBtn.addEventListener('click', function () { setPanel(true); });
    var dotWrap = cardEl('span', 'mr-2 d-inline-flex align-center');
    cardDot = cardEl('span');
    cardDot.style.cssText = 'width:10px;height:10px;border-radius:50%;display:inline-block;background:#888;margin-right:4px;';
    var stLbl = cardEl('span', 'caption', 'offline');
    cardDot._st = stLbl;
    dotWrap.appendChild(cardDot); dotWrap.appendChild(stLbl);
    var btn = cardEl('button', 'v-btn v-btn--icon v-btn--round v-size--default theme--dark');
    btn.style.cssText = 'width:32px;height:32px;';
    var btnC = cardEl('span', 'v-btn__content');
    cardChev = cardEl('span');
    cardChev.style.cssText = 'display:inline-flex;';
    cardChev.innerHTML = svgChevron;
    btnC.appendChild(cardChev); btn.appendChild(btnC);
    colR.appendChild(openBtn); colR.appendChild(dotWrap); colR.appendChild(btn);
    hrow.appendChild(colL); hrow.appendChild(colR);
    title.appendChild(hrow); card.appendChild(title);

    cardBody = cardEl('div', 'v-card__text py-2 px-4 overflow-hidden');
    var body = cardEl('div');
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
    card.appendChild(cardBody); cardBody.appendChild(body);

    btn.addEventListener('click', function () {
      var collapsed = cardBody.style.display === 'none';
      cardBody.style.display = collapsed ? '' : 'none';
      cardChev.style.transform = collapsed ? '' : 'rotate(180deg)';
      card.classList.toggle('collapsed', !collapsed);
      try { localStorage.setItem('odriveCardCollapsed', collapsed ? '0' : '1'); } catch (e) {}
    });
    var collapsed0 = '0';
    try { collapsed0 = localStorage.getItem('odriveCardCollapsed') || '0'; } catch (e) {}
    if (collapsed0 === '1') {
      cardBody.style.display = 'none';
      cardChev.style.transform = 'rotate(180deg)';
      card.classList.add('collapsed');
    }

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
    // preferred spot: right below the temperature panel
    var cards = main.querySelectorAll('.v-card');
    var temp = null;
    for (var i = 0; i < cards.length; i++) {
      var h = cards[i].querySelector('.card-heading');
      if (h && /温度|temperature/i.test(h.textContent)) { temp = cards[i]; break; }
    }
    if (temp) {
      if (!cardWrap) cardWrap = buildCard();
      cardWrap.className = 'od-card-col';
      cardWrap.style.width = '100%';
      temp.insertAdjacentElement('afterend', cardWrap);
      return;
    }
    // fallback: top of the dashboard grid
    var row = main.querySelector('.row');
    if (!row) return;
    if (!cardWrap) cardWrap = buildCard();
    cardWrap.className = 'col col-12 col-sm-6 col-md-4';
    cardWrap.style.width = '';
    row.insertBefore(cardWrap, row.firstChild);
  }

  setInterval(tryMountCard, 1500);
  setInterval(pollCard, 700);
})();
