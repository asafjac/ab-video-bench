(function () {
    "use strict";
    var variant = window.__abVariant || null;
    ABMark.mark("appStart");
    var label = document.getElementById("variant");
    if (label) label.textContent = variant ? "variant: " + variant : "variant: none";

    function getJson(url) {
        return fetch(url, {cache: "no-store"}).then(function (r) { return r.json(); });
    }

    // baseline waits for the config before asking for the items; candidate asks for both at once.
    function loadData() {
        ABMark.mark("dataRequested", {strategy: variant === "candidate" ? "parallel" : "sequential"});
        if (variant === "candidate") return Promise.all([getJson("/api/config"), getJson("/api/items")]);
        return getJson("/api/config").then(function (config) {
            return getJson("/api/items").then(function (items) { return [config, items]; });
        });
    }

    function render(target, config, items) {
        target.style.gridTemplateColumns = "repeat(" + config.columns + ", 1fr)";
        target.innerHTML = items.map(function (it) {
            return '<div class="tile ready" style="border-color:' + config.accent + '"><b>' + it.name + '</b><span>' + it.value + '%</span>' +
                '<i style="width:' + it.value + '%"></i></div>';
        }).join("");
        requestAnimationFrame(function () { ABMark.mark("firstRender", {tiles: items.length}); });
    }

    function skeleton(target) {
        var html = "";
        for (var i = 0; i < 12; i++) html += '<div class="tile skeleton"></div>';
        target.innerHTML = html;
    }

    function run(target) {
        skeleton(target);
        loadData().then(function (r) { ABMark.mark("dataReceived"); render(target, r[0], r[1]); });
    }

    var grid = document.getElementById("grid");
    if (grid && grid.getAttribute("data-autoload")) run(grid);
    var open = document.getElementById("open");
    var panel = document.getElementById("panel");
    if (open && panel) open.addEventListener("click", function () { open.disabled = true; run(panel); });
})();
