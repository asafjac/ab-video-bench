(function () {
    "use strict";
    var variant = new URLSearchParams(location.search).get("variant");
    if (variant) ABMark.setVariant(variant);
    fetch("/api/status", {cache: "no-store"}).then(function (r) { return r.json(); }).then(function (s) {
        document.getElementById("badge").textContent = "status: " + s.status;
        document.getElementById("badge").className = "badge ok";
        ABMark.mark("frameReady");
    });
})();
