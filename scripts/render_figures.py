"""Renders the report diagrams and the terminal output to PNG.
Usage: python render_figures.py <seed.log> <server.log>"""
import html, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent.parent / "screenshots"
OUT.mkdir(exist_ok=True)
seed_log, server_log = (Path(a).read_text(encoding="utf-8") for a in sys.argv[1:3])

CSS = """
body{margin:0;background:#fff;font-family:Calibri,Carlito,'Segoe UI',sans-serif;color:#000}
.fig{width:1000px;padding:20px;box-sizing:border-box}
.frame{border:2px solid #000;border-radius:18px;padding:22px 26px 26px;position:relative}
.title{text-align:center;font-weight:700;font-size:21px;margin-bottom:22px}
.box{border:1.5px solid #000;background:#fff;text-align:center;padding:9px 8px;font-size:14px;position:absolute;box-sizing:border-box}
.box b{display:block;font-size:16px}
.shade{background:#f0f0f0}
.ln{position:absolute;background:#000}
.lbl{position:absolute;font-size:13px}
.arrow{position:absolute;width:0;height:0;border-top:7px solid transparent;border-bottom:7px solid transparent;border-left:12px solid #000}
"""

def box(x, y, w, h, title, sub, shade=False):
    return f'<div class="box{" shade" if shade else ""}" style="left:{x}px;top:{y}px;width:{w}px;height:{h}px"><b>{title}</b>{sub}</div>'

def hline(x, y, w): return f'<div class="ln" style="left:{x}px;top:{y}px;width:{w}px;height:1.5px"></div>'
def vline(x, y, h): return f'<div class="ln" style="left:{x}px;top:{y}px;width:1.5px;height:{h}px"></div>'

# Figure 1: network architecture (same visual language as the reference figure)
arch = f"""<div class="fig" id="arch"><div class="frame" style="height:470px">
<div class="title">LIFECHAIN PERMISSIONED BLOCKCHAIN NETWORK</div>
{box(305, 70, 350, 54, 'Client Application / Gateway', 'Web app + REST API (identity-signed requests)')}
{vline(480, 124, 36)}
{hline(100, 160, 760)}
""" + "".join(vline(x, 160, 30) + vline(x, 254, 31) for x in (100, 290, 480, 670, 860)) + f"""
{box(25, 190, 150, 64, 'Blood Bank Peer', 'Chaincode + Ledger')}
{box(215, 190, 150, 64, 'Testing Lab Peer', 'Chaincode + Ledger')}
{box(405, 190, 150, 64, 'CityCare Peer', 'Chaincode + Ledger')}
{box(595, 190, 150, 64, 'Green Valley Peer', 'Chaincode + Ledger')}
{box(785, 190, 150, 64, 'Regulator Peer', 'Endorser + Auditor')}
{hline(100, 285, 760)}
{vline(480, 285, 30)}
{box(25, 315, 190, 64, 'CA / MSP', 'Identity &amp; trust (5 orgs)', True)}
{hline(215, 347, 115)}
<div class="lbl" style="left:222px;top:325px">identity policies</div>
{box(330, 315, 300, 64, 'Ordering Service', 'Orders endorsed transactions into blocks', True)}
{vline(480, 379, 31)}
{box(235, 410, 490, 60, 'Blockchain Ledger + World State', 'Blood-unit event history and current status of every unit')}
</div></div>"""

# Figure 2: product movement (like the reference's producer -> retailer figure)
stages = [("Donor", "Donates blood"), ("Blood Bank", "Collect / register"), ("Testing Lab", "Screen 5 tests"),
          ("Blood Bank", "Store / issue"), ("Hospital", "Receive / transfuse"), ("Patient", "Pseudonymous ref.")]
flow = ""
for i, (t, s) in enumerate(stages):
    x = i * 160
    flow += box(x, 0, 130, 66, t, s, shade=i in (0, 5))
    if i:
        flow += hline(x - 30, 33, 20) + f'<div class="arrow" style="left:{x - 12}px;top:26px"></div>'
movement = f"""<div class="fig" id="flow" style="width:1000px"><div style="position:relative;height:66px;margin:10px 20px">{flow}</div>
<div style="font-size:14px;margin:18px 20px 0">Authorized regulator queries the ledger to trace any unit from donor to patient (recall, audit, adverse-reaction investigation).</div></div>"""

terminal = f"""<!doctype html><html><head><meta charset="utf-8"><style>
body{{margin:0;background:#fff}} .win{{width:1000px;margin:20px;border-radius:8px;overflow:hidden;box-shadow:0 2px 10px #0003;font-family:Consolas,monospace}}
.bar{{background:#2d2d2d;color:#ccc;padding:8px 14px;font:13px 'Segoe UI'}} pre{{margin:0;background:#0c0c0c;color:#d4d4d4;padding:16px 18px;font-size:14px;line-height:1.45}}
.p{{color:#6fc36f}}</style></head><body><div class="win" id="term"><div class="bar">Windows PowerShell — LifeChain-BloodBank-MiniProject</div><pre>
<span class="p">PS C:\\Users\\Vishal\\Documents\\LifeChain-BloodBank-MiniProject&gt;</span> npm run seed
{html.escape(seed_log.strip())}

<span class="p">PS C:\\Users\\Vishal\\Documents\\LifeChain-BloodBank-MiniProject&gt;</span> npm start
{html.escape(server_log.strip())}
</pre></div></body></html>"""

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    page = browser.new_page(viewport={"width": 1100, "height": 900}, device_scale_factor=2)
    page.set_content(f"<!doctype html><html><head><meta charset='utf-8'><style>{CSS}</style></head><body>{arch}{movement}</body></html>")
    page.locator("#arch").screenshot(path=str(OUT / "fig1_architecture.png"))
    page.locator("#flow").screenshot(path=str(OUT / "fig2_unit_movement.png"))
    page.set_content(terminal)
    page.locator("#term").screenshot(path=str(OUT / "00_terminal.png"))
    browser.close()
print("figures rendered")
