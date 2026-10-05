(function () {
  "use strict";
  var DISMISS_KEY = "transit.installHintDismissed";

  function $(s) { return document.querySelector(s); }
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }

  var standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true;
  var ua = navigator.userAgent || "";
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var isIOSSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);

  var deferred = null;
  var hint = null;

  function show(text, withButton) {
    if (standalone || safeGet(DISMISS_KEY) || !hint) return;
    $("#install-text").textContent = text;
    $("#install-btn").hidden = !withButton;
    hint.hidden = false;
  }

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    show("Installér som app på din telefon – virker også uden netværk (kun demo-data).", true);
  });
  window.addEventListener("appinstalled", function () { if (hint) hint.hidden = true; });

  document.addEventListener("DOMContentLoaded", function () {
    hint = $("#install-hint");
    if (!hint) return;
    $("#install-dismiss").addEventListener("click", function () {
      hint.hidden = true; safeSet(DISMISS_KEY, "1");
    });
    $("#install-btn").addEventListener("click", function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.then(function () { deferred = null; hint.hidden = true; });
    });
    if (isIOSSafari) {
      show("Installér på iPhone: tryk på Del-ikonet (firkant med pil) og vælg “Tilføj til hjemmeskærm”.", false);
    } else if (isIOS) {
      show("Åbn siden i Safari og vælg Del → “Tilføj til hjemmeskærm” for at installere.", false);
    }
  });
})();
