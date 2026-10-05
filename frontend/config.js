(function () {
  "use strict";

  var DEFAULT_BASE = "";
  var STORAGE_KEY = "transit.apiBase";

  var STALE_AFTER = 60;
  var UNAVAILABLE_AFTER = 300;

  var LIVE_REFRESH_MS = 20000;

  function normalize(url) {
    if (!url) return "";
    var trimmed = String(url).trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    if (!/^https?:\/\//i.test(trimmed)) trimmed = "http://" + trimmed;
    try {

      new URL(trimmed);
      return trimmed;
    } catch (e) {
      return "";
    }
  }

  function fromQuery() {
    try {
      var p = new URLSearchParams(window.location.search).get("api");
      return normalize(p);
    } catch (e) { return ""; }
  }

  function fromStorage() {
    try { return normalize(window.localStorage.getItem(STORAGE_KEY)); }
    catch (e) { return ""; }
  }

  // An explicit override (?api= or the saved API bar value) talks to a
  // backend root (e.g. uvicorn on :8000). With no override the page calls its
  // own origin under /api (Vercel serverless function); on file:// or when
  // that fails, the in-browser demo engine takes over.
  function overrideBase() {
    return fromQuery() || fromStorage() || "";
  }

  function resolveBase() {
    return overrideBase() || DEFAULT_BASE;
  }

  function apiPrefix() {
    return overrideBase() ? "" : "/api";
  }

  function saveBase(url) {
    var norm = normalize(url);
    if (!norm) return "";
    try { window.localStorage.setItem(STORAGE_KEY, norm); } catch (e) {  }
    return norm;
  }

  window.TransitConfig = {
    DEFAULT_BASE: DEFAULT_BASE,
    STALE_AFTER: STALE_AFTER,
    UNAVAILABLE_AFTER: UNAVAILABLE_AFTER,
    LIVE_REFRESH_MS: LIVE_REFRESH_MS,
    normalize: normalize,
    resolveBase: resolveBase,
    overrideBase: overrideBase,
    apiPrefix: apiPrefix,
    saveBase: saveBase
  };
})();
