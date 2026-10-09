// Applies the stored theme before first paint (loaded synchronously from app.html; the CSP forbids inline scripts).
// Keep the storage key and values in sync with src/lib/client/theme.ts.
(function () {
	try {
		var t = localStorage.getItem('stichpunkt.theme');
		if (t === 'light' || t === 'dark') {
			document.documentElement.dataset.theme = t;
			document.querySelectorAll('meta[name="theme-color"]').forEach(function (old) { old.remove(); });
			var m = document.createElement('meta');
			m.name = 'theme-color';
			m.content = t === 'dark' ? '#0e1116' : '#f6f3ec';
			document.head.appendChild(m);
		}
	} catch (e) {}
})();
