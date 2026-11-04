// Copy buttons for the prompts on guide and comparison pages: <button data-copy-from="id">.
(function () {
  var buttons = document.querySelectorAll("[data-copy-from]");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].hidden = false;
    buttons[i].addEventListener("click", function (e) {
      var btn = e.currentTarget;
      var el = document.getElementById(btn.getAttribute("data-copy-from"));
      if (!el || !navigator.clipboard) return;
      var label = btn.textContent;
      navigator.clipboard.writeText(el.textContent.trim()).then(function () {
        btn.textContent = "Copied";
        btn.classList.add("is-copied");
        // copy_prompt is sent by our tag container's click trigger on [data-copy-from].
        setTimeout(function () {
          btn.textContent = label;
          btn.classList.remove("is-copied");
        }, 1800);
      });
    });
  }
})();
