(function () {
  try {
    var first = location.pathname.split("/").filter(Boolean)[0];
    var tenantId = first && first !== "debug" ? decodeURIComponent(first) : "global";
    var key = "energy-monitor:" + tenantId + ":theme";
    var t = localStorage.getItem(key);
    if (t == null && tenantId === "5214") {
      t = localStorage.getItem("5214:theme");
      if (t != null) localStorage.setItem(key, t);
    }
    if (t === "light") document.documentElement.setAttribute("data-theme", "light");
  } catch (_) {}
})();