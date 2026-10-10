/* theme + effects bootstrap: runs before the first paint so there is no flash. Preference: "dark" (default), "light" or "system". */
(function () {
  var d = document.documentElement, pref = "dark", lite = "";
  try { pref = localStorage.getItem("ps.theme") || "dark"; lite = localStorage.getItem("ps.lite") || ""; } catch (e) {}
  var mq = window.matchMedia && matchMedia("(prefers-color-scheme: light)");
  var theme = pref === "system" ? (mq && mq.matches ? "light" : "dark") : pref === "light" ? "light" : "dark";
  d.setAttribute("data-theme", theme); d.setAttribute("data-theme-pref", pref);
  var weak = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) || (navigator.deviceMemory && navigator.deviceMemory <= 2) || (window.matchMedia && matchMedia("(prefers-reduced-transparency: reduce)").matches);
  d._lite = lite === "1" || (lite !== "0" && !!weak);
})();
