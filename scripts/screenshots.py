"""Captures report screenshots of the running LifeChain app (server must be on :3000, freshly seeded)."""
import sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
OUT = Path(__file__).resolve().parent.parent / "screenshots"
OUT.mkdir(exist_ok=True)
UNIT = "BU-2026-0113"

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    page = browser.new_page(viewport={"width": 1400, "height": 860}, device_scale_factor=1.5)

    def shot(name, full=False):
        page.wait_for_timeout(600)
        page.screenshot(path=str(OUT / f"{name}.png"), full_page=full)
        print("saved", name)

    def go(route, org=None):
        page.goto(f"{BASE}/?t={time.time()}#/{route}")
        page.wait_for_selector(".page-head")
        if org and page.input_value("#org-select") != org:
            page.select_option("#org-select", org)
            page.wait_for_timeout(300)
            page.wait_for_selector(".page-head")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

    go("dashboard", "BloodBankOrg"); shot("01_dashboard")

    # Blood bank registers a donation
    go("collect", "BloodBankOrg")
    page.fill("input[name=unitId]", UNIT)
    page.fill("input[name=donorId]", "DNR-48301")
    page.select_option("select[name=bloodGroup]", "B+")
    page.select_option("select[name=component]", "Whole Blood")
    shot("02_collect_form")
    page.click("#collect-form button")
    page.wait_for_selector("#result .banner")
    shot("03_collect_committed")

    # A hospital tries to register a donation -> rejected by access control
    go("collect", "CityCareOrg")
    page.fill("input[name=unitId]", "BU-2026-0999")
    page.fill("input[name=donorId]", "DNR-99999")
    page.click("#collect-form button")
    page.wait_for_selector("#result .banner")
    shot("04_access_denied")

    # Laboratory screening
    go("testing", "LabOrg")
    page.select_option("select[name=unitId]", UNIT)
    page.click("#test-form button")
    page.wait_for_selector("#result .banner")
    shot("05_lab_test_recorded")

    # Blood bank issues the unit to CityCare
    go("distribution", "BloodBankOrg")
    page.select_option(f"[data-dest='{UNIT}']", "CityCareOrg")
    page.click(f"[data-transfer='{UNIT}']")
    page.wait_for_selector("#result .banner")
    page.evaluate("window.scrollTo(0,0)")
    shot("06_distribution_issued")

    # Hospital receives the unit
    go("hospital", "CityCareOrg")
    page.click(f"[data-receive='{UNIT}']")
    page.wait_for_selector("#result .banner")
    shot("07_hospital_received")

    # Incompatible transfusion is blocked, compatible one succeeds
    go("hospital", "CityCareOrg")
    page.select_option("#transfuse-form select[name=unitId]", UNIT)
    page.fill("#transfuse-form input[name=patientId]", "PAT-CC-8120")
    page.select_option("#transfuse-form select[name=patientBloodGroup]", "A+")
    page.click("#transfuse-form button")
    page.wait_for_selector("#result .banner")
    shot("08_incompatible_blocked")
    page.select_option("#transfuse-form select[name=patientBloodGroup]", "B+")
    page.click("#transfuse-form button")
    page.wait_for_selector("#result .banner.ok")
    shot("09_transfusion_recorded")

    go("inventory", "RegulatorOrg"); shot("10_inventory")
    go(f"trace/{UNIT}", "RegulatorOrg"); page.wait_for_selector(".timeline"); shot("11_trace_timeline", full=True)
    go("explorer", "RegulatorOrg"); shot("12_block_explorer")
    go("network", "RegulatorOrg"); shot("13_network")

    # Double allocation -> MVCC conflict
    go("security", "BloodBankOrg")
    page.select_option("#d-unit", "BU-2026-0106")
    page.click("#double-btn")
    page.wait_for_selector("#double-result table")
    shot("14_double_allocation")

    # Tamper detection
    go("security", "BloodBankOrg")
    page.select_option("#t-block", "1")
    page.select_option("#t-group", "O-")
    page.click("#tamper-btn")
    page.wait_for_timeout(1200)
    shot("15_tamper_detected")
    page.click("#restore-btn")
    page.wait_for_timeout(1000)
    browser.close()
