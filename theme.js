/* Runs before the page draws, so it opens in the chosen theme with no flash of the other one.
 * Light unless this device has saved "dark". A signed-in account's choice is applied by app.js once
 * the account loads, and saved here too, so the next visit opens right straight away. */
(function () {
  var theme = 'light';
  try {
    if (window.localStorage.getItem('startsit.theme') === 'dark') theme = 'dark';
  } catch (err) { /* storage blocked: light */ }
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
})();
