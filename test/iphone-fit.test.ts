import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canvasDpr, isFastIPhone } from "../src/input/touch.ts";

test("iPhone viewport and PWA metadata support both full-screen orientations", async () => {
  const [html, manifest] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8").then(JSON.parse),
  ]);
  assert.match(html, /name="viewport" content="[^"]*width=device-width[^"]*initial-scale=1[^"]*viewport-fit=cover[^"]*interactive-widget=resizes-content/);
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  assert.equal(manifest.orientation, "any");
  assert.ok(manifest.display === "fullscreen" || manifest.display === "standalone");
  assert.match(html, /height: 100svh; height: 100dvh/);
  assert.doesNotMatch(html, /100vh/);
});

test("high-end iPhone hints enable High quality at a capped 1.5 DPR", () => {
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const oldDpr = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "iPhone", hardwareConcurrency: 6 } });
    Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: 3 });
    assert.equal(isFastIPhone(), true);
    assert.deepEqual(canvasDpr(true), [1, 1.5]);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "iPhone", hardwareConcurrency: 2 } });
    assert.equal(isFastIPhone(), false);
  } finally {
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
    if (oldDpr) Object.defineProperty(globalThis, "devicePixelRatio", oldDpr);
  }
});
