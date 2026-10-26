(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var fab = $('chat-fab'), panel = $('chat-panel'), close = $('chat-close'), badge = $('chat-badge');
  var startForm = $('chat-start'), body = $('chat-body'), list = $('chat-list'), err = $('chat-err');
  var form = $('chat-form'), input = $('chat-text'), tow = $('tow-btn');
  if (!fab || !panel) return;

  var KEY_TOKEN = 'chat_token', KEY_SEEN = 'chat_seen';
  var token = null, lastId = 0, timer = null, isOpen = false, busy = false, unread = 0, pending = '';
  try { token = localStorage.getItem(KEY_TOKEN); } catch (e) {}
  function seen() { try { return +localStorage.getItem(KEY_SEEN) || 0; } catch (e) { return 0; } }
  function setSeen(v) { try { localStorage.setItem(KEY_SEEN, String(v)); } catch (e) {} }

  function showErr(t) { err.hidden = !t; err.textContent = t || ''; }
  function api(method, url, data) {
    return fetch(url, {
      method: method, headers: data ? { 'Content-Type': 'application/json' } : undefined,
      body: data ? JSON.stringify(data) : undefined, cache: 'no-store'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || 'Ошибка'); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  function add(m) {
    var d = document.createElement('div');
    d.className = 'msg msg--' + (m.sender === 'client' ? 'client' : 'staff');
    d.textContent = m.text;
    list.appendChild(d);
  }
  function scroll() { list.scrollTop = list.scrollHeight; }

  function poll() {
    if (!token || busy) return Promise.resolve();
    return api('GET', '/api/chat/messages?token=' + encodeURIComponent(token) + '&after=' + lastId).then(function (j) {
      var fresh = j.messages || [], staffNew = 0;
      fresh.forEach(function (m) {
        lastId = Math.max(lastId, m.id);
        if (isOpen) add(m); else if (m.sender === 'staff' && m.id > seen()) staffNew++;
      });
      if (isOpen) { if (fresh.length) { scroll(); setSeen(lastId); } unread = 0; badge.hidden = true; }
      else if (staffNew) { unread += staffNew; badge.hidden = false; badge.textContent = String(unread); }
      showErr('');
    }).catch(function (e) {
      if (e.status === 404) { token = null; lastId = 0; try { localStorage.removeItem(KEY_TOKEN); } catch (x) {} if (isOpen) render(); }
      else if (isOpen) showErr(e.message === 'Failed to fetch' ? 'Нет связи с сервером' : e.message);
    });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () { poll().then(schedule); }, isOpen ? 3000 : 20000);
  }

  function render() {
    startForm.hidden = !!token; body.hidden = !token;
    list.textContent = ''; lastId = 0;
    if (token) {
      poll().then(function () { setSeen(lastId); unread = 0; badge.hidden = true; scroll(); if (pending && !input.value) { input.value = pending; pending = ''; } input.focus(); });
    }
  }

  function open(prefill) {
    isOpen = true; panel.hidden = false;
    fab.setAttribute('aria-expanded', 'true'); fab.setAttribute('aria-label', 'Закрыть чат');
    render(); schedule();
    if (prefill) pending = prefill;
    if (!token) $('chat-name').focus();
  }
  function shut() {
    isOpen = false; panel.hidden = true;
    fab.setAttribute('aria-expanded', 'false'); fab.setAttribute('aria-label', 'Открыть чат');
    schedule();
  }

  fab.addEventListener('click', function () { isOpen ? shut() : open(); });
  close.addEventListener('click', function () { shut(); fab.focus(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen) { shut(); fab.focus(); } });

  startForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = startForm.querySelector('button'); btn.disabled = true;
    api('POST', '/api/chat/start', { name: $('chat-name').value, phone: $('chat-phone').value }).then(function (j) {
      token = j.token; try { localStorage.setItem(KEY_TOKEN, token); } catch (x) {}
      showErr(''); render();
    }).catch(function (x) { showErr(x.message); startForm.hidden = false; })
      .then(function () { btn.disabled = false; });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || !token) return;
    busy = true; input.value = '';
    api('POST', '/api/chat/messages?token=' + encodeURIComponent(token), { text: text }).then(function (j) {
      showErr('');
      if (j.message.id > lastId) { lastId = j.message.id; add(j.message); scroll(); setSeen(lastId); }
    }).catch(function (x) { input.value = text; showErr(x.message); })
      .then(function () { busy = false; });
  });

  // Кнопка «Заказать эвакуатор» только открывает чат.
  // Сообщение о заказе клиент пишет самостоятельно.
  if (tow) tow.addEventListener('click', function () {
    open();
    if (token) setTimeout(function () { input.focus(); }, 0);
  });

  if (token) { poll().then(schedule); } else { schedule(); }
})();
