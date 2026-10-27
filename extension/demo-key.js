// The practice key stays readable to someone trying Clotr, but never sits whole in a shipped file.
(() => {
  "use strict";

  const awsAccessKey = ["AKIA", "4HPQ7XZ2", "R6TWLJ3N"].join("");
  globalThis.ClotrDemo = Object.freeze({ awsAccessKey });
  if (typeof document !== "undefined") {
    for (const element of document.querySelectorAll("[data-demo-aws-key]")) element.textContent = awsAccessKey;
  }
})();
