#!/usr/bin/env python3
"""Collaudo UI GT-Graphic: desktop, iPhone, gesture touch, file senza estensione."""
import os
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = os.environ.get("GT_URL", "http://127.0.0.1:8000/")
SHOTS = os.path.join(ROOT, "docs")
os.makedirs(SHOTS, exist_ok=True)

failures = []
console_errors = []


def check(cond, label, detail=""):
    if cond:
        print("  OK   " + label + ((" -> " + str(detail)) if detail else ""))
    else:
        failures.append(label)
        print("  FAIL " + label + ((" -> " + str(detail)) if detail else ""))


def attach(page, tag):
    page.on("console", lambda msg: console_errors.append(tag + " console." + msg.type + ": " + msg.text)
            if msg.type == "error" else None)
    page.on("pageerror", lambda err: console_errors.append(tag + " pageerror: " + str(err)))


def wait_ready(page):
    page.wait_for_selector("#canvas")
    page.wait_for_function("typeof GTViewer !== 'undefined' && typeof GTParser !== 'undefined'")
    page.wait_for_timeout(250)


def click_world(page, x, y, z):
    box = page.locator("#canvas").bounding_box()
    pt = page.evaluate("([x,y,z]) => GTViewer.worldToScreen(x,y,z)", [x, y, z])
    page.mouse.click(box["x"] + pt["x"], box["y"] + pt["y"])
    return box, pt


def desktop(p):
    print("\n=== DESKTOP 1440x900 ===")
    browser = p.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    page = ctx.new_page()
    attach(page, "desktop")
    page.goto(URL, wait_until="networkidle")
    wait_ready(page)

    check(page.locator("#emptyState").is_visible(), "Empty state visibile all'avvio")
    check(page.locator("#canvas").bounding_box()["height"] > 400, "Canvas dimensionato")
    page.screenshot(path=os.path.join(SHOTS, "desktop-empty.png"))

    page.click("#btnEmptyDemo")
    page.wait_for_selector(".file-row")
    page.wait_for_timeout(400)
    segs_txt = page.locator("#stSegs").inner_text()
    check(int(segs_txt.split()[0]) > 70, "Demo: segmenti caricati", segs_txt)
    check(page.locator(".file-name").first.inner_text() == "DEMO_PART.nc", "Demo: nome file corretto")
    check(not page.locator("#emptyState").is_visible(), "Empty state nascosto dopo il caricamento")
    page.screenshot(path=os.path.join(SHOTS, "desktop-xy.png"))

    # Viste ortogonali
    page.click('.view-btn[data-view="xz"]')
    page.wait_for_timeout(350)
    check(page.locator("#badgeView").inner_text() == "X-Z", "Vista X-Z attiva", page.locator("#badgeView").inner_text())
    check(page.locator("#droLabel1").inner_text() == "X" and page.locator("#droLabel2").inner_text() == "Z", "DRO X-Z")
    page.screenshot(path=os.path.join(SHOTS, "desktop-xz.png"))
    page.click('.view-btn[data-view="yz"]')
    page.wait_for_timeout(300)
    check(page.locator("#badgeView").inner_text() == "Y-Z", "Vista Y-Z attiva")
    page.click('.view-btn[data-view="xy"]')
    page.wait_for_timeout(300)

    # Zoom pulsanti
    s0 = page.evaluate("GTViewer.getScale()")
    page.click("#btnZoomIn")
    page.wait_for_timeout(150)
    s1 = page.evaluate("GTViewer.getScale()")
    check(s1 > s0 * 1.2, "Zoom + aumenta la scala", round(s1 / s0, 3))
    page.click("#btnZoomOut")
    page.wait_for_timeout(150)
    s2 = page.evaluate("GTViewer.getScale()")
    check(abs(s2 - s0) < 1e-6, "Zoom - ripristina la scala", round(s2, 3))

    # Zoom finestra
    page.click("#btnZoomWin")
    check(page.locator("#badgeMode").inner_text() == "ZOOM FINESTRA", "Modalita zoom finestra")
    box = page.locator("#canvas").bounding_box()
    x0, y0 = box["x"] + 380, box["y"] + 220
    x1, y1 = box["x"] + 720, box["y"] + 480
    page.mouse.move(x0, y0)
    page.mouse.down()
    page.mouse.move(x1, y1, steps=10)
    page.mouse.up()
    page.wait_for_timeout(300)
    s3 = page.evaluate("GTViewer.getScale()")
    check(s3 > s2, "Zoom finestra applicato", round(s3, 3))
    check(page.locator("#badgeMode").inner_text() == "PAN", "Ritorno a PAN dopo zoom finestra")
    page.click("#btnFit")
    page.wait_for_timeout(200)

    # Interroga punti su vertice noto (12, 0, -8)
    page.click("#btnInspect")
    check(page.locator("#badgeMode").inner_text() == "INTERROGA", "Modalita interroga attiva")
    box_h = page.locator("#canvas").bounding_box()
    pt_h = page.evaluate("GTViewer.worldToScreen(12,0,-8)")
    page.mouse.move(box_h["x"] + pt_h["x"], box_h["y"] + pt_h["y"])
    page.wait_for_timeout(300)
    coords_hover = page.locator(".insp-coord output").all_text_contents()
    check(coords_hover == ["12.000", "0.000", "-8.000"], "Inspector: aggiornato al passaggio del mouse", coords_hover)
    click_world(page, 12, 0, -8)
    page.wait_for_timeout(300)
    coords = page.locator(".insp-coord output").all_text_contents()
    check(len(coords) == 3 and coords[0] == "12.000" and coords[1] == "0.000" and coords[2] == "-8.000",
          "Inspector: coordinate esatte", coords)
    block = page.locator(".insp-block").inner_text()
    check("G01" in block or "G02" in block, "Inspector: blocco originale", block[:40])
    check(page.locator(".insp-kind").inner_text() in ("G01", "G02"), "Inspector: tipo movimento",
          page.locator(".insp-kind").inner_text())
    page.screenshot(path=os.path.join(SHOTS, "desktop-inspect.png"))

    # Origine manuale
    page.click('.tab[data-tab="origin"]')
    page.fill("#orgInputX", "12")
    page.fill("#orgInputY", "0")
    page.fill("#orgInputZ", "-8")
    page.click("#btnApplyOrigin")
    page.wait_for_timeout(250)
    check(page.locator("#orgX").inner_text() == "12.000", "Origine: readout X", page.locator("#orgX").inner_text())
    page.click('.tab[data-tab="inspect"]')
    coords2 = page.locator(".insp-coord output").all_text_contents()
    check(coords2 == ["0.000", "0.000", "0.000"], "Origine: quote ricalcolate a zero", coords2)

    # Ripristino origine
    page.click('.tab[data-tab="origin"]')
    page.click("#btnResetOrigin")
    page.wait_for_timeout(250)
    check(page.locator("#orgX").inner_text() == "0.000", "Origine ripristinata")

    # Pick origine da punto grafico
    page.click("#btnPickOrigin")
    check(page.locator("#badgeMode").inner_text() == "ORIGINE", "Modalita pick origine")
    click_world(page, 12, 0, -8)
    page.wait_for_timeout(300)
    check(page.locator("#orgX").inner_text() == "12.000" and page.locator("#orgZ").inner_text() == "-8.000",
          "Pick origine su vertice", [page.locator("#orgX").inner_text(), page.locator("#orgZ").inner_text()])
    page.click("#btnResetOrigin")
    page.wait_for_timeout(150)

    # Dimensione pulsanti principali
    ids = ["btnOpen", "btnImport", "btnClose", "btnExit", "btnZoomIn", "btnZoomOut", "btnZoomWin",
           "btnFit", "btnPan", "btnInspect", "btnOrigin", "btnPanel", "btnApplyOrigin",
           "btnPickOrigin", "btnResetOrigin"]
    small = []
    for bid in ids:
        bb = page.locator("#" + bid).bounding_box()
        if not bb or bb["width"] < 43.5 or bb["height"] < 43.5:
            small.append((bid, bb))
    check(not small, "Pulsanti principali >= 44x44 px", small)

    # Apertura file senza estensione tramite file chooser
    with page.expect_file_chooser() as fc:
        page.click("#btnOpen")
    fc.value.set_files(os.path.join(ROOT, "samples", "SG1-1"))
    page.wait_for_function("document.querySelectorAll('.file-row').length === 1")
    page.wait_for_timeout(400)
    check(page.locator(".file-name").first.inner_text() == "SG1-1", "Apertura file senza estensione",
          page.locator(".file-name").first.inner_text())
    check("53" in page.locator("#stSegs").inner_text(), "SG1-1: 53 segmenti", page.locator("#stSegs").inner_text())

    # Import multi-file
    with page.expect_file_chooser() as fc2:
        page.click("#btnImport")
    fc2.value.set_files(os.path.join(ROOT, "samples", "FT1-2"))
    page.wait_for_function("document.querySelectorAll('.file-row').length === 2")
    page.wait_for_timeout(400)
    check(page.locator(".file-name").nth(1).inner_text() == "FT1-2", "Import secondo file")
    check("active" in (page.locator('#colorMode button[data-mode="file"]').get_attribute("class") or ""),
          "Multi-file: colore per file attivo")
    page.screenshot(path=os.path.join(SHOTS, "desktop-multifile.png"))

    page.click('.tab[data-tab="files"]')
    page.wait_for_timeout(150)

    # Toggle visibilita
    page.locator(".file-row").first.locator(".file-eye").click()
    page.wait_for_timeout(150)
    check("is-hidden" in (page.locator(".file-row").first.get_attribute("class") or ""), "Toggle visibilita file")
    page.locator(".file-row").first.locator(".file-eye").click()

    # Rimozione
    page.locator(".file-row").nth(1).locator(".file-del").click()
    page.wait_for_timeout(200)
    check(page.locator(".file-row").count() == 1, "Rimozione file")

    # Chiudi
    page.click("#btnClose")
    page.wait_for_timeout(250)
    check(page.locator("#emptyState").is_visible(), "Chiudi: area grafica svuotata")
    check(page.locator("#sumFiles").inner_text() == "0", "Chiudi: contatori azzerati")

    # Esci / riavvia
    page.click("#btnExit")
    page.wait_for_timeout(200)
    check(page.locator("#exitScreen").is_visible(), "Esci: schermata di chiusura")
    page.click("#btnRestart")
    page.wait_for_timeout(250)
    check(not page.locator("#exitScreen").is_visible(), "Riavvio sessione")

    check(not console_errors, "Nessun errore console desktop", console_errors[:5])
    browser.close()


def mobile(p):
    print("\n=== iPHONE 390x844 (touch) ===")
    browser = p.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=3,
        is_mobile=True,
        has_touch=True,
        user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
                   "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    )
    page = ctx.new_page()
    attach(page, "mobile")
    page.goto(URL, wait_until="networkidle")
    wait_ready(page)

    check(page.evaluate("window.innerWidth") == 390, "Viewport iPhone 390 px")
    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),
          "Nessun overflow orizzontale")
    page.screenshot(path=os.path.join(SHOTS, "mobile-empty.png"))

    page.tap("#btnEmptyDemo")
    page.wait_for_selector(".file-row")
    page.wait_for_timeout(500)
    check(int(page.locator("#stSegs").inner_text().split()[0]) > 70, "Mobile: demo caricata")
    page.screenshot(path=os.path.join(SHOTS, "mobile-view.png"))

    # Pan con un dito (modalita PAN di default)
    pt_before = page.evaluate("GTViewer.worldToScreen(70,45,0)")
    box = page.locator("#canvas").bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    client = ctx.new_cdp_session(page)
    client.send("Input.dispatchTouchEvent", {
        "type": "touchStart",
        "touchPoints": [{"x": cx, "y": cy, "id": 1, "radiusX": 8, "radiusY": 8, "force": 1}]
    })
    for k in range(1, 7):
        client.send("Input.dispatchTouchEvent", {
            "type": "touchMove",
            "touchPoints": [{"x": cx + 15 * k, "y": cy + 8 * k, "id": 1, "radiusX": 8, "radiusY": 8, "force": 1}]
        })
    client.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(250)
    pt_after = page.evaluate("GTViewer.worldToScreen(70,45,0)")
    check(abs((pt_after["x"] - pt_before["x"]) - 90) < 12 and abs((pt_after["y"] - pt_before["y"]) - 48) < 12,
          "Pan touch con un dito", [round(pt_after["x"] - pt_before["x"], 1), round(pt_after["y"] - pt_before["y"], 1)])
    page.click("#btnFit")
    page.wait_for_timeout(200)

    # Pinch zoom
    s_before = page.evaluate("GTViewer.getScale()")
    client.send("Input.dispatchTouchEvent", {
        "type": "touchStart",
        "touchPoints": [
            {"x": cx - 60, "y": cy, "id": 1, "radiusX": 8, "radiusY": 8, "force": 1},
            {"x": cx + 60, "y": cy, "id": 2, "radiusX": 8, "radiusY": 8, "force": 1}
        ]
    })
    for k in range(1, 7):
        client.send("Input.dispatchTouchEvent", {
            "type": "touchMove",
            "touchPoints": [
                {"x": cx - 60 - 10 * k, "y": cy, "id": 1, "radiusX": 8, "radiusY": 8, "force": 1},
                {"x": cx + 60 + 10 * k, "y": cy, "id": 2, "radiusX": 8, "radiusY": 8, "force": 1}
            ]
        })
    client.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(300)
    s_after = page.evaluate("GTViewer.getScale()")
    check(s_after > s_before * 1.5, "Pinch-to-zoom", [round(s_before, 3), round(s_after, 3)])
    page.click("#btnFit")
    page.wait_for_timeout(200)

    # Interroga punti con tap
    page.tap("#btnInspect")
    pt = page.evaluate("GTViewer.worldToScreen(12,0,-8)")
    box = page.locator("#canvas").bounding_box()
    page.touchscreen.tap(box["x"] + pt["x"], box["y"] + pt["y"])
    page.wait_for_timeout(400)
    check(not page.locator("#selChip").is_hidden(), "Mobile: chip selezione visibile")
    check("12.000" in page.locator("#chipCoords").inner_text(), "Mobile: coordinate chip",
          page.locator("#chipCoords").inner_text())
    page.screenshot(path=os.path.join(SHOTS, "mobile-inspect.png"))

    # Pannello a scomparsa
    page.tap("#btnPanel")
    page.wait_for_timeout(400)
    panel = page.locator("#sidePanel").bounding_box()
    check(panel and panel["y"] < 844, "Mobile: pannello aperto", panel)
    page.screenshot(path=os.path.join(SHOTS, "mobile-panel.png"))
    page.tap('.tab[data-tab="origin"]')
    page.wait_for_timeout(200)
    check(page.locator("#page-origin").is_visible(), "Mobile: tab origine")
    page.tap("#btnPanelClose")
    page.wait_for_timeout(350)
    panel2 = page.locator("#sidePanel").bounding_box()
    check(panel2 is None or panel2["y"] >= 840, "Mobile: pannello chiuso", panel2)

    check(not console_errors, "Nessun errore console mobile", console_errors[:5])
    browser.close()


def file_protocol(p):
    print("\n=== FILE:// (doppio clic locale) ===")
    browser = p.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    attach(page, "file")
    page.goto("file://" + os.path.join(ROOT, "index.html"))
    wait_ready(page)
    page.click("#btnEmptyDemo")
    page.wait_for_selector(".file-row")
    page.wait_for_timeout(300)
    check(int(page.locator("#stSegs").inner_text().split()[0]) > 70, "file:// demo funzionante")
    check(not console_errors, "Nessun errore console file://", console_errors[:5])
    browser.close()


with sync_playwright() as p:
    desktop(p)
    mobile(p)
    file_protocol(p)

print("\n=========================================")
if console_errors:
    print("Errori console:")
    for e in console_errors:
        print(" -", e)
if failures:
    print("TEST FALLITI:", len(failures))
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("TUTTI I TEST UI SUPERATI")
