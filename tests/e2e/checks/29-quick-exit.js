// E2E checks: QE. Quick exit, the first Privacy Check-up piece that has a visible button: one press in the popup
// closes every open Clotr page, popup included. Standalone from Keep nothing, which isn't built yet: it only
// closes tabs, never claims to clear anything. Run in order by ../run.js with one shared env (helpers from
// ../lib.js).
"use strict";

module.exports = async function (env) {
  const { check, ctx, EXT, expect, fs, launch, openExtPage, openPopup, sleep, waitFor } = env;

  await check(
    "QE1",
    "Quick exit: pressing it in the popup closes every open Clotr page, including itself",
    async () => {
      const popup = await openPopup(ctx);
      const vault = await openExtPage(ctx, "vault.html");
      const helper = await openExtPage(ctx, "helper.html");

      // The button closes this very page, so the CDP connection to it can die mid dispatch: race the click
      // against a short wait instead of awaiting it to completion (it may never settle once the tab is gone).
      const pressed = popup.evaluate(() => document.getElementById("quick-exit").click()).catch(() => {});
      await Promise.race([pressed, sleep(500)]);

      const allClosed = await waitFor(() => popup.isClosed() && vault.isClosed() && helper.isClosed(), 3000);
      expect(
        allClosed,
        `not all closed: popup=${popup.isClosed()} vault=${vault.isClosed()} helper=${helper.isClosed()}`,
      );
    },
  );

  await check("QE2", "Quick exit: the button's label and hint translate to Spanish", async () => {
    const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
    try {
      const popup = await openPopup(es);
      const state = await popup.$eval("#quick-exit", (n) => ({
        text: n.textContent.trim(),
        title: n.getAttribute("title"),
        ariaLabel: n.getAttribute("aria-label"),
      }));
      expect(state.text === "Salida rápida", `button text: ${state.text}`);
      expect(state.title === "Cierra todas las páginas de Clotr abiertas, incluida esta", `title: ${state.title}`);
      expect(
        state.ariaLabel === "Salida rápida: cierra todas las páginas de Clotr abiertas",
        `aria-label: ${state.ariaLabel}`,
      );
      await popup.close();
    } finally {
      await es.browser.close();
      fs.rmSync(es.profile, { recursive: true, force: true });
    }
  });
};
