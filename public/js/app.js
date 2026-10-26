(function () {
  'use strict';
  var WORK = { open: 8 * 60 + 30, close: 17 * 60 + 30 };

  // Индикатор «открыто / закрыто» по московскому времени
  try {
    var box = document.getElementById('status'), text = document.getElementById('status-text');
    if (box && text) {
      var parts = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
      var h = +parts.find(function (p) { return p.type === 'hour'; }).value % 24;
      var m = +parts.find(function (p) { return p.type === 'minute'; }).value;
      var now = h * 60 + m, open = now >= WORK.open && now < WORK.close;
      box.hidden = false;
      box.classList.toggle('is-open', open);
      text.textContent = open ? 'Сейчас открыто' : 'Сейчас закрыто';
    }
  } catch (e) { if (window.console) console.error(e); }


  // Открытие адреса: сначала приложение Яндекс Карт, затем 2ГИС,
  // если приложений нет — веб-версия Яндекс Карт.
  (function setupMapFallback() {
    var button = document.getElementById('map-button');
    if (!button) return;

    // Точная точка автосервиса по предоставленной ссылке Яндекс Карт.
    // Начальную точку посетителя не фиксируем: маршрут строится от его местоположения.
    var latitude = '55.540540';
    var longitude = '36.008811';
    var route = '~' + latitude + '%2C' + longitude;
    var webUrl = 'https://yandex.ru/maps/?rtext=' + route + '&rtt=auto';
    var yandexUrl = 'yandexmaps://maps.yandex.ru/?rtext=' + route + '&rtt=auto';
    var gisUrl = 'dgis://2gis.ru/geo/' + longitude + ',' + latitude;
    var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    button.addEventListener('click', function (event) {
      if (!isMobile) {
        // На компьютере используем привычную веб-версию карт.
        return;
      }
      event.preventDefault();

      var leftPage = false;
      var finished = false;
      var timers = [];
      function markLeftPage() { leftPage = true; }
      document.addEventListener('visibilitychange', function onVisibility() {
        if (document.hidden) markLeftPage();
      }, { once: true });
      window.addEventListener('pagehide', markLeftPage, { once: true });

      function tryApp(url, next) {
        if (finished || leftPage) return;
        var before = leftPage;
        window.location.href = url;
        timers.push(window.setTimeout(function () {
          if (finished || leftPage || before !== leftPage) return;
          next();
        }, 1100));
      }

      tryApp(yandexUrl, function () {
        tryApp(gisUrl, function () {
          if (!finished && !leftPage) {
            finished = true;
            window.location.href = webUrl;
          }
        });
      });
    });
  })();

})();
