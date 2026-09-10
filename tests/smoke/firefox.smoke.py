"""Firefox smoke: install the firefox-smoke build as a temporary add-on in a headless Firefox, open
the Spanish fixture from a loopback server, drive the real popup, and check the page.

Playwright's Firefox cannot load extensions, so this uses Selenium with the system Firefox and the
geckodriver that Selenium Manager fetches. Run `npm run smoke:firefox` (builds first).
"""
from __future__ import annotations

import http.server
import json
import re
import sys
import threading
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
ADDON = ROOT / "dist" / "firefox-smoke.zip"
EXTENSION_ID = "glossa@sysadmindoc.github.io"
UUID = "1f1a0b6e-9b4a-4a4e-9c2e-2b0d0c1a5e77"


def fail(message: str) -> None:
    raise SystemExit(f"smoke(firefox): {message}")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FIXTURES), **kwargs)

    def log_message(self, *_args):  # quiet
        pass


def wait_for(driver, predicate, timeout: float, what: str):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate(driver)
        if value:
            return value
        time.sleep(0.5)
    fail(f"timed out waiting for {what}")


def main() -> None:
    if not ADDON.exists():
        fail(f"{ADDON} is missing; run `node tools/build.mjs --smoke` first")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    fixture_url = f"http://127.0.0.1:{port}/es.html"

    options = Options()
    options.add_argument("-headless")
    # Pin the extension's internal origin so the popup page can be opened by URL.
    options.set_preference("extensions.webextensions.uuids", json.dumps({EXTENSION_ID: UUID}))
    started = time.time()
    # The chrome-context script below needs system access, which geckodriver 0.36+ gates behind
    # this flag (it passes -remote-allow-system-access to Firefox).
    service = webdriver.FirefoxService(service_args=["--allow-system-access"])
    driver = webdriver.Firefox(options=options, service=service)
    try:
        driver.install_addon(str(ADDON), temporary=True)
        # Firefox treats MV3 host permissions as optional and grants none to a temporary add-on.
        # Grant the manifest's hosts the way the install prompt would, from the browser chrome.
        with driver.context(driver.CONTEXT_CHROME):
            granted = driver.execute_async_script(
                """
                const [id, origins, done] = arguments;
                (async () => {
                  const { ExtensionPermissions } = ChromeUtils.importESModule(
                    "resource://gre/modules/ExtensionPermissions.sys.mjs"
                  );
                  const { ExtensionParent } = ChromeUtils.importESModule(
                    "resource://gre/modules/ExtensionParent.sys.mjs"
                  );
                  const extension = ExtensionParent.GlobalManager.getExtension(id);
                  await ExtensionPermissions.add(id, { permissions: [], origins }, extension);
                  const policy = WebExtensionPolicy.getByID(id);
                  done(JSON.stringify(policy?.allowedOrigins?.patterns?.map((p) => p.pattern) ?? null));
                })().catch((error) => done("ERR " + error));
                """,
                EXTENSION_ID,
                [
                    "http://127.0.0.1/*",
                    "https://firefox.settings.services.mozilla.com/*",
                    "https://firefox-settings-attachments.cdn.mozilla.net/*",
                    "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/*",
                ],
            )
        print(f"smoke(firefox): granted hosts: {granted}")
        driver.get(fixture_url)
        page_handle = driver.current_window_handle
        # tabUrl is a match pattern; a port in the pattern would never match.
        popup_url = f"moz-extension://{UUID}/popup.html?tabUrl=http://127.0.0.1/*"
        # Marionette refuses to navigate content to a moz-extension: URL, so open the tab from the
        # browser chrome with the system principal instead.
        with driver.context(driver.CONTEXT_CHROME):
            driver.execute_script(
                """
                const url = arguments[0];
                const tab = gBrowser.addTab(url, {
                  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
                });
                gBrowser.selectedTab = tab;
                """,
                popup_url,
            )
        popup_handle = wait_for(
            driver,
            lambda d: next((h for h in d.window_handles if h != page_handle), None),
            30,
            "popup tab",
        )
        driver.switch_to.window(popup_handle)
        wait_for(driver, lambda d: d.current_url.startswith("moz-extension://"), 30, "popup url")
        try:
            wait_for(driver, lambda d: d.find_element(By.ID, "action").is_enabled(), 60, "popup to finish checking the page")
        except SystemExit:
            fail(
                "popup never enabled its button; status: "
                f"{driver.find_element(By.ID, 'status').text!r}, button: {driver.find_element(By.ID, 'action').text!r}"
            )
        detected = driver.find_element(By.ID, "source").get_attribute("value")
        if detected != "es":
            status = driver.find_element(By.ID, "status").text
            fail(f'expected detected language es, got "{detected}" (status: {status})')
        driver.execute_script(
            "const s = document.getElementById('target'); s.value = 'en'; s.dispatchEvent(new Event('change'));"
        )
        wait_for(
            driver,
            lambda d: re.search(r"Download|Translate page", d.find_element(By.ID, "action").text),
            60,
            "route status",
        )
        print(f'smoke(firefox): action button reads "{driver.find_element(By.ID, "action").text}"')
        driver.find_element(By.ID, "action").click()
        wait_for(
            driver,
            lambda d: d.find_element(By.ID, "action").text == "Show original"
            or "error" in d.find_element(By.ID, "status").get_attribute("class"),
            240,
            "translation to finish",
        )
        status = driver.find_element(By.ID, "status").text
        print(f'smoke(firefox): popup status "{status}"')
        if driver.find_element(By.ID, "action").text != "Show original":
            fail(f"translation did not complete: {status}")

        driver.switch_to.window(page_handle)
        intro = driver.execute_script(
            """
            const p = document.getElementById('intro');
            return {
              unit: p.getAttribute('data-glossa-unit'),
              original: p.childNodes[0].textContent,
              translation: p.querySelector('glossa-translation')?.textContent ?? '',
              link: Boolean(p.querySelector("glossa-translation a[href='#catalogo']"))
            };
            """
        )
        print(f"smoke(firefox): intro translation: {intro['translation'].strip()[:120]}")
        if intro["unit"] != "bilingual":
            fail(f"intro unit state was {intro['unit']}")
        if "biblioteca" not in intro["original"]:
            fail("original Spanish text was removed")
        if not re.search(r"library", intro["translation"], re.I):
            fail("intro translation does not mention the library")
        if not intro["link"]:
            fail("inline link was not preserved")
        code = driver.execute_script("return document.getElementById('code').textContent")
        if code != 'const saludo = "hola mundo";':
            fail("pre block was modified")
        brand = driver.execute_script("return document.querySelector(\"#brand span[translate='no']\").textContent")
        if brand != "Café Aurora":
            fail("translate=no span was modified")
        shadow = driver.execute_script(
            "const b = document.getElementById('host').shadowRoot.querySelector('glossa-translation');"
            "return b ? [b.textContent, getComputedStyle(b).display] : null"
        )
        if not shadow or not re.search(r"shadow", shadow[0], re.I) or shadow[1] != "block":
            fail(f"shadow root translation wrong: {shadow}")

        driver.execute_script(
            "const f = document.createElement('p'); f.id = 'dynamic';"
            "f.textContent = 'Este párrafo se añadió después de la traducción.';"
            "document.querySelector('main').append(f);"
        )
        dynamic = wait_for(
            driver,
            lambda d: d.execute_script("return document.querySelector('#dynamic glossa-translation')?.textContent ?? ''"),
            120,
            "dynamic paragraph translation",
        )
        print(f"smoke(firefox): dynamic paragraph: {dynamic}")

        driver.switch_to.window(popup_handle)
        driver.find_element(By.ID, "action").click()
        wait_for(driver, lambda d: d.find_element(By.ID, "action").text == "Translate page", 30, "restore")
        driver.switch_to.window(page_handle)
        leftovers = driver.execute_script(
            "return [document.querySelectorAll('glossa-translation').length, document.querySelectorAll('[data-glossa-unit]').length]"
        )
        if leftovers != [0, 0]:
            fail(f"restore left {leftovers[0]} blocks and {leftovers[1]} units")
        print(f"smoke(firefox): PASS in {time.time() - started:.1f}s (Firefox {driver.capabilities.get('browserVersion')})")
    finally:
        driver.quit()
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
