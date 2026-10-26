(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var chatsEl = $('chats'), empty = $('empty'), conv = $('conv'), msgs = $('msgs'), layout = $('layout');
  var current = null, lastId = 0;

  function get(url) { return fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  function fmt(iso) { try { return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

  function loadList() {
    return get('/api/admin/chats').then(function (j) {
      chatsEl.textContent = '';
      empty.hidden = j.chats.length > 0;
      j.chats.forEach(function (c) {
        var li = document.createElement('li'), b = document.createElement('button');
        b.type = 'button'; if (c.id === current) b.className = 'on';
        var r1 = document.createElement('div'); r1.className = 'row';
        var n = document.createElement('strong'); n.textContent = c.name; r1.appendChild(n);
        if (c.unread) { var d = document.createElement('span'); d.className = 'dot'; d.textContent = c.unread; r1.appendChild(d); }
        var r2 = document.createElement('div'); r2.className = 'sub'; r2.textContent = (c.last_text || '') ;
        var r3 = document.createElement('div'); r3.className = 'sub'; r3.textContent = fmt(c.last_at) + (c.phone ? ' · ' + c.phone : '');
        b.appendChild(r1); b.appendChild(r2); b.appendChild(r3);
        b.addEventListener('click', function () { openChat(c.id); });
        li.appendChild(b); chatsEl.appendChild(li);
      });
    }).catch(function () {});
  }

  function addMsg(m) {
    var d = document.createElement('div'); d.className = 'm m--' + m.sender;
    d.textContent = m.text;
    var s = document.createElement('small'); s.textContent = fmt(m.created_at); d.appendChild(s);
    msgs.appendChild(d);
  }

  function loadMsgs(reset) {
    if (!current) return Promise.resolve();
    var id = current;
    return get('/api/admin/chats/' + id + '/messages?after=' + (reset ? 0 : lastId)).then(function (j) {
      if (id !== current) return;
      if (reset) { msgs.textContent = ''; lastId = 0; $('c-name').textContent = j.chat.name; $('c-phone').textContent = j.chat.phone; }
      j.messages.forEach(function (m) { lastId = Math.max(lastId, m.id); addMsg(m); });
      if (j.messages.length) msgs.scrollTop = msgs.scrollHeight;
    }).catch(function () {});
  }

  function openChat(id) {
    current = id; conv.hidden = false; layout.classList.add('open');
    loadMsgs(true).then(loadList);
  }
  $('back').addEventListener('click', function () { layout.classList.remove('open'); current = null; loadList(); });

  $('reply').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('text'), text = input.value.trim();
    if (!text || !current) return;
    input.value = '';
    fetch('/api/admin/chats/' + current + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text }) })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (j) { lastId = Math.max(lastId, j.message.id); addMsg(j.message); msgs.scrollTop = msgs.scrollHeight; loadList(); })
      .catch(function () { input.value = text; });
  });

  loadList();
  setInterval(function () { loadList(); loadMsgs(false); }, 3000);
})();
