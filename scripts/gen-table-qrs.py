"""Generate a PDF of 48 table QR codes for HOD.
   One QR per table, 4 per A4 page, 3 cm × 3 cm each with table ID label.
   QRs point to: https://hodclub.in/table.html?id=<TABLE_ID>
"""
import qrcode
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from io import BytesIO

TABLES = (
    # Ground
    ["C1","C2","C3","C4","CVIP1","CVIP2"]
    # Dining (FD1-FD18)
    + [f"FD{i}" for i in range(1, 19)]
    # Smoking
    + [f"SMK{i}" for i in range(1, 9)]
    # Rooftop
    + [f"T{i}" for i in range(1, 12)] + [f"TVIP{i}" for i in range(1, 6)]
)
assert len(TABLES) == 48, f"Expected 48 tables, got {len(TABLES)}"

OUT_PDF = "deploy-bundles/v3138-table-qr/HOD-TABLE-QRs-v3.138-2026-05-28.pdf"
URL_TPL = "https://hodclub.in/table.html?id={tid}"

def make_qr_img(url):
    qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M,
                       box_size=10, border=2)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return ImageReader(buf)

def main():
    c = canvas.Canvas(OUT_PDF, pagesize=A4)
    page_w, page_h = A4
    # 2-column × 3-row grid per page → 6 per page → 8 pages for 48 tables.
    cols, rows = 2, 3
    cell_w = page_w / cols
    cell_h = page_h / rows
    qr_size = 6.5 * cm
    for i, tid in enumerate(TABLES):
        slot = i % (cols * rows)
        if slot == 0 and i > 0:
            c.showPage()
        col = slot % cols
        row = slot // cols
        x0 = col * cell_w
        y0 = page_h - (row + 1) * cell_h
        # Cell border (light)
        c.setStrokeColorRGB(0.85, 0.85, 0.85)
        c.setLineWidth(0.5)
        c.rect(x0 + 0.3*cm, y0 + 0.3*cm, cell_w - 0.6*cm, cell_h - 0.6*cm, stroke=1, fill=0)
        # Brand header
        c.setFillColorRGB(0.79, 0.66, 0.30)  # gold
        c.setFont("Helvetica-Bold", 14)
        c.drawCentredString(x0 + cell_w/2, y0 + cell_h - 1.1*cm, "HOD · HOUSE OF DOPAMINE")
        # Sub-instruction
        c.setFillColorRGB(0.2, 0.2, 0.2)
        c.setFont("Helvetica", 9)
        c.drawCentredString(x0 + cell_w/2, y0 + cell_h - 1.6*cm, "Scan to order from your table")
        # QR centered horizontally, vertically a bit above center
        qr_x = x0 + (cell_w - qr_size) / 2
        qr_y = y0 + cell_h - 1.9*cm - qr_size
        c.drawImage(make_qr_img(URL_TPL.format(tid=tid)), qr_x, qr_y, qr_size, qr_size, mask='auto')
        # Table label (big, below QR)
        c.setFillColorRGB(0, 0, 0)
        c.setFont("Helvetica-Bold", 28)
        c.drawCentredString(x0 + cell_w/2, qr_y - 1.1*cm, f"TABLE {tid}")
        # URL fine print
        c.setFont("Helvetica", 7)
        c.setFillColorRGB(0.5, 0.5, 0.5)
        c.drawCentredString(x0 + cell_w/2, qr_y - 1.6*cm, URL_TPL.format(tid=tid))
    c.save()
    print(f"✅ {OUT_PDF} — {len(TABLES)} tables on {(len(TABLES)+5)//6} pages")

if __name__ == "__main__":
    main()
