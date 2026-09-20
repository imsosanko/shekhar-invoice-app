#!/usr/bin/env python3
"""
Generates an invoice PDF for Shekhar Compute Tech Services.

Invoked by the Node/Express backend (server/routes/invoices.routes.js) via
child_process.spawn: JSON describing {invoice, customer, settings, format,
template} is piped in on stdin, and the finished PDF bytes are written to
stdout. Nothing else must ever be printed to stdout — diagnostics go to
stderr — or the PDF stream gets corrupted.

- payload.format:   'a4' (default) or 'thermal' (4x6 inch, for label/receipt printers)
- payload.template: 'modern' | 'minimal' | 'classic' | 'bold' | 'compact'
                     (falls back to settings.template, then 'modern')
                     Ignored for the thermal format, which always uses one
                     compact layout — there isn't room on a 4x6 label for
                     five different designs.
"""
import sys
import json
import base64
import io
import os

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm, inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_RIGHT, TA_CENTER
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image, HRFlowable
)
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

FONT_DIR = os.path.join(os.path.dirname(__file__), 'fonts')
pdfmetrics.registerFont(TTFont('DejaVu', os.path.join(FONT_DIR, 'DejaVuSans.ttf')))
pdfmetrics.registerFont(TTFont('DejaVu-Bold', os.path.join(FONT_DIR, 'DejaVuSans-Bold.ttf')))
pdfmetrics.registerFont(TTFont('DejaVu-Oblique', os.path.join(FONT_DIR, 'DejaVuSans-Oblique.ttf')))
pdfmetrics.registerFontFamily('DejaVu', normal='DejaVu', bold='DejaVu-Bold',
                               italic='DejaVu-Oblique', boldItalic='DejaVu-Bold')
FONT = 'DejaVu'
FONT_BOLD = 'DejaVu-Bold'
FONT_OBLIQUE = 'DejaVu-Oblique'

VALID_TEMPLATES = {'modern', 'minimal', 'classic', 'bold', 'compact', 'taxinvoice'}

CURRENCY_META = {
    'INR': {'symbol': '₹', 'major': 'Rupees', 'minor': 'Paise'},
    'USD': {'symbol': '$', 'major': 'US Dollars', 'minor': 'Cents'},
}

ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
        "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
        "Eighteen", "Nineteen"]
TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def two_digits(n):
    if n < 20:
        return ONES[n]
    return TENS[n // 10] + (" " + ONES[n % 10] if n % 10 else "")


def three_digits(n):
    s = ""
    if n >= 100:
        s += ONES[n // 100] + " Hundred "
        n %= 100
    s += two_digits(n)
    return s.strip()


def num_to_words_indian(num):
    num = round(num)
    if num == 0:
        return "Zero"
    parts = []
    crore, num = divmod(num, 10000000)
    lakh, num = divmod(num, 100000)
    thousand, rest = divmod(num, 1000)
    if crore:
        parts.append(three_digits(crore) + " Crore")
    if lakh:
        parts.append(three_digits(lakh) + " Lakh")
    if thousand:
        parts.append(three_digits(thousand) + " Thousand")
    if rest:
        parts.append(three_digits(rest))
    return " ".join(parts).strip()


def amount_in_words(n, currency):
    meta = CURRENCY_META.get(currency, CURRENCY_META['INR'])
    whole = int(n)
    minor = round((n - whole) * 100)
    s = f"{meta['major']} {num_to_words_indian(whole)} Only"
    if minor > 0:
        s = f"{meta['major']} {num_to_words_indian(whole)} and {num_to_words_indian(minor)} {meta['minor']} Only"
    return s


def fmt(n, currency):
    meta = CURRENCY_META.get(currency, CURRENCY_META['INR'])
    return f"{meta['symbol']}{n:,.2f}"


def decode_data_url(data_url):
    try:
        header, b64 = data_url.split(',', 1)
        return io.BytesIO(base64.b64decode(b64))
    except Exception:
        return None


def normalize_image(data_url):
    """
    Decodes a data: URL and re-encodes it as a clean PNG via PIL before handing
    it to ReportLab. This fixes real-world uploads that otherwise fail to
    render (silently, since logo/QR embedding catches exceptions and falls
    back) — e.g. images with an alpha channel, CMYK JPEGs, or odd color
    modes. Returns a BytesIO of PNG bytes, or None if the image is unreadable.
    """
    buf = decode_data_url(data_url)
    if not buf:
        return None
    try:
        from PIL import Image as PILImage
        img = PILImage.open(buf)
        img.load()
        if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
            bg = PILImage.new('RGB', img.size, (255, 255, 255))
            bg.paste(img.convert('RGBA'), mask=img.convert('RGBA').split()[-1])
            img = bg
        elif img.mode != 'RGB':
            img = img.convert('RGB')
        out = io.BytesIO()
        img.save(out, format='PNG')
        out.seek(0)
        return out
    except Exception as e:
        print(f"normalize_image: could not decode/re-encode image: {e}", file=sys.stderr)
        return None


def escape_html(text):
    return (text or '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def nl2br(text):
    """Converts plain multi-line text (e.g. from a <textarea>, with real \\n
    characters) into ReportLab Paragraph-safe markup: HTML-escaped first (so
    a stray '&' or '<' in someone's terms text can't break the PDF), then
    newlines converted to <br/>."""
    return escape_html(text).replace('\r\n', '\n').replace('\n', '<br/>')


def line_amount(it):
    gross = it['qty'] * it['rate']
    discount = it.get('discount', 0) or 0
    disc = min(discount, gross) if it.get('discountType') == 'flat' else gross * discount / 100
    return gross - disc


def build_context(payload):
    invoice = payload['invoice']
    customer = payload.get('customer') or {}
    settings = payload['settings']
    currency = settings.get('currency', 'INR')
    brand_hex = settings.get('primaryColor') or '#1E3A8A'
    gst_enabled = invoice.get('gstEnabled', True)

    total_rows = [['Subtotal', fmt(invoice['subtotal'], currency)]]
    if invoice.get('itemDiscountTotal', 0) > 0:
        total_rows.append(['Item Discounts', f"-{fmt(invoice['itemDiscountTotal'], currency)}"])
    if invoice.get('additionalDiscountAmt', 0) > 0:
        ad_label = 'Additional Discount'
        if invoice.get('additionalDiscountType') == 'percent' and invoice.get('additionalDiscount'):
            ad_label += f" ({invoice['additionalDiscount']}%)"
        total_rows.append([ad_label, f"-{fmt(invoice['additionalDiscountAmt'], currency)}"])
    if not gst_enabled:
        total_rows.append(['Tax', 'Not applicable (Non-GST)'])
    elif invoice.get('sameState', True):
        total_rows.append(['CGST', fmt(invoice['cgst'], currency)])
        total_rows.append(['SGST', fmt(invoice['sgst'], currency)])
    else:
        total_rows.append(['IGST', fmt(invoice['igst'], currency)])
    total_rows.append(['Grand Total', fmt(invoice['grandTotal'], currency)])

    from_html = f"{escape_html(settings.get('businessName',''))}<br/>{escape_html(settings.get('address',''))}<br/>Mobile: {escape_html(settings.get('mobile',''))}"
    if settings.get('showEmail', True) and settings.get('email'):
        from_html += f"<br/>Email: {escape_html(settings.get('email',''))}"
    if settings.get('showUdyam'):
        from_html += f"<br/>{escape_html(settings.get('udyam',''))}"

    bill_html = f"{escape_html(customer.get('name','—'))}<br/>{escape_html(customer.get('address',''))}<br/>Mobile: {escape_html(customer.get('mobile',''))}"
    if customer.get('gstin'):
        bill_html += f"<br/>GSTIN: {escape_html(customer['gstin'])}"

    meta_html = (f"No: {escape_html(invoice.get('number',''))}<br/>Date: {invoice.get('date','')}<br/>"
                 f"Due: {invoice.get('dueDate','')}")

    left_html = (f"<b>Payment Terms</b><br/>{nl2br(invoice.get('paymentTerms','-'))}<br/><br/>"
                 f"<b>Notes</b><br/>{nl2br(invoice.get('notes','-'))}")

    bank_html = None
    if settings.get('showBank'):
        bank_html = (f"<b>Bank Details</b><br/>Bank: {escape_html(settings.get('bankName',''))}<br/>"
                     f"A/C No.: {escape_html(settings.get('bankAccount',''))}<br/>IFSC: {escape_html(settings.get('bankIfsc',''))}")
    terms_html = f"<b>Terms &amp; Conditions</b><br/>{nl2br(invoice.get('terms','-'))}"

    return {
        'invoice': invoice, 'customer': customer, 'settings': settings, 'currency': currency,
        'brand_hex': brand_hex, 'brand': HexColor(brand_hex), 'gst_enabled': gst_enabled,
        'total_rows': total_rows, 'from_html': from_html, 'bill_html': bill_html,
        'meta_html': meta_html, 'left_html': left_html, 'bank_html': bank_html, 'terms_html': terms_html,
        'received_amount': payload.get('receivedAmount', 0), 'balance_amount': payload.get('balanceAmount', invoice.get('grandTotal', 0)),
        'you_saved': payload.get('youSaved', 0), 'customer_balance': payload.get('customerBalance', 0),
    }


def logo_flowable(ctx, size_mm=13):
    logo_url = ctx['settings'].get('logoDataUrl')
    if logo_url:
        img_buf = normalize_image(logo_url)
        if img_buf:
            try:
                return Image(img_buf, width=size_mm * mm, height=size_mm * mm)
            except Exception as e:
                print(f"logo_flowable: {e}", file=sys.stderr)
    return None


def upi_qr_section(ctx, styles, img_size_mm=24, text_style=None):
    """Returns a flowable for the UPI/QR block — the actual scannable QR
    CODE IMAGE next to the UPI ID, not just the ID as text — or None if UPI
    payment isn't enabled/configured. Used by every design's bottom section."""
    settings = ctx['settings']
    if not (settings.get('showUpiQr') and settings.get('upiId')):
        return None
    qr_url = settings.get('qrCodeDataUrl')
    qr_img = None
    if qr_url:
        img_buf = normalize_image(qr_url)
        if img_buf:
            try:
                qr_img = Image(img_buf, width=img_size_mm * mm, height=img_size_mm * mm)
            except Exception as e:
                print(f"upi_qr_section: {e}", file=sys.stderr)
    text = Paragraph(f"<b>Scan &amp; Pay (UPI)</b><br/>UPI ID: {escape_html(settings.get('upiId',''))}", text_style or styles['small'])
    if qr_img:
        t = Table([[qr_img, text]], colWidths=[img_size_mm * mm + 4, 55 * mm])
        t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 0)]))
        return t
    return text  # no QR image uploaded yet — at least show the UPI ID


def items_table_rows(ctx):
    invoice = ctx['invoice']
    currency = ctx['currency']
    gst_enabled = ctx['gst_enabled']
    head = ['#', 'Description', 'HSN/SAC', 'Qty', 'Rate'] + (['GST'] if gst_enabled else []) + ['Amount']
    rows = [head]
    for i, it in enumerate(invoice.get('items', []), start=1):
        row = [str(i), it.get('desc', ''), it.get('hsn', '-') or '-', str(it['qty']), fmt(it['rate'], currency)]
        if gst_enabled:
            row.append(f"{it.get('gst', 0)}%")
        row.append(fmt(line_amount(it), currency))
        rows.append(row)
    col_widths = [8 * mm, 62 * mm, 22 * mm, 14 * mm, 24 * mm] + ([14 * mm] if gst_enabled else []) + [28 * mm]
    return rows, col_widths


def shared_meta_table(ctx, styles):
    meta_table = Table([
        [Paragraph("FROM", styles['label']), Paragraph("BILL TO", styles['label']), Paragraph("INVOICE DETAILS", styles['label'])],
        [Paragraph(ctx['from_html'], styles['small']), Paragraph(ctx['bill_html'], styles['small']), Paragraph(ctx['meta_html'], styles['small'])],
    ], colWidths=[60 * mm, 60 * mm, 52 * mm])
    meta_table.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP')]))
    return meta_table


def shared_bottom(ctx, styles):
    flowables = []
    right_cell = []
    if ctx['bank_html']:
        right_cell.append(Paragraph(ctx['bank_html'], styles['small']))
        right_cell.append(Spacer(1, 8))
    qr_section = upi_qr_section(ctx, styles)
    if qr_section:
        right_cell.append(qr_section)
        right_cell.append(Spacer(1, 8))
    right_cell.append(Paragraph(ctx['terms_html'], styles['small']))

    bottom_table = Table([[Paragraph(ctx['left_html'], styles['small']), right_cell]],
                          colWidths=[90 * mm, 82 * mm])
    bottom_table.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP')]))
    flowables.append(bottom_table)
    flowables.append(Spacer(1, 14))
    flowables.append(HRFlowable(width=55 * mm, thickness=0.75, color=colors.HexColor('#B8BECC'), hAlign='RIGHT'))
    flowables.append(Paragraph('<para alignment="right">Authorized Signature</para>', styles['small']))
    return flowables


def make_styles(brand):
    styles = getSampleStyleSheet()
    return {
        'small': ParagraphStyle('small', parent=styles['Normal'], fontSize=9, leading=13, fontName=FONT),
        'label': ParagraphStyle('label', parent=styles['Normal'], fontSize=7.5, textColor=colors.HexColor('#8A93A6'),
                                 leading=10, spaceAfter=2, fontName=FONT),
        'italic_small': ParagraphStyle('italic_small', parent=styles['Normal'], fontSize=9, leading=13,
                                        fontName=FONT_OBLIQUE, textColor=colors.HexColor('#4C5468')),
        'base': styles,
    }


def design_modern(ctx):
    brand = ctx['brand']
    styles = make_styles(brand)
    story = []

    logo = logo_flowable(ctx) or Paragraph('<para alignment="center"><font color="white" size="16"><b>S</b></font></para>', styles['small'])
    co_name_style = ParagraphStyle('co_name', fontSize=13, leading=15, fontName=FONT_BOLD, textColor=brand)
    co_tag_style = ParagraphStyle('co_tag', fontSize=7.5, fontName=FONT, textColor=colors.HexColor('#6B7385'))
    invoice_title = ParagraphStyle('invoice_title', fontSize=22, fontName=FONT_BOLD, textColor=brand, alignment=TA_RIGHT)

    co_block = Table([[logo, Paragraph(f"<b>{ctx['settings'].get('businessName','').upper()}</b>", co_name_style)]], colWidths=[16 * mm, 90 * mm])
    co_block.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE')]))
    header_table = Table([[co_block, Paragraph("INVOICE", invoice_title)]], colWidths=[110 * mm, 62 * mm])
    header_table.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP')]))
    story += [header_table, Paragraph(ctx['settings'].get('tagline', ''), co_tag_style), Spacer(1, 4),
              HRFlowable(width="100%", thickness=1.4, color=brand), Spacer(1, 10)]

    story += [shared_meta_table(ctx, styles), Spacer(1, 14)]

    rows, col_widths = items_table_rows(ctx)
    items_table = Table(rows, colWidths=col_widths, repeatRows=1)
    items_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), brand), ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTSIZE', (0, 0), (-1, -1), 8.5), ('FONTNAME', (0, 0), (-1, -1), FONT), ('FONTNAME', (0, 0), (-1, 0), FONT_BOLD),
        ('ALIGN', (-1, 0), (-1, -1), 'RIGHT'), ('ALIGN', (3, 0), (3, -1), 'CENTER'), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6), ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('LINEBELOW', (0, 0), (-1, -2), 0.5, colors.HexColor('#EDEFF4')),
    ]))
    story += [items_table, Spacer(1, 12)]

    totals_table = Table(ctx['total_rows'], colWidths=[40 * mm, 42 * mm], hAlign='RIGHT')
    totals_table.setStyle(TableStyle([
        ('FONTSIZE', (0, 0), (-1, -1), 9.5), ('FONTNAME', (0, 0), (-1, -1), FONT), ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
        ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ('BACKGROUND', (0, -1), (-1, -1), brand), ('TEXTCOLOR', (0, -1), (-1, -1), colors.white),
        ('FONTNAME', (0, -1), (-1, -1), FONT_BOLD), ('FONTSIZE', (0, -1), (-1, -1), 11),
        ('TOPPADDING', (0, -1), (-1, -1), 8), ('BOTTOMPADDING', (0, -1), (-1, -1), 8),
        ('LEFTPADDING', (0, -1), (-1, -1), 8), ('RIGHTPADDING', (0, -1), (-1, -1), 8),
    ]))
    story += [totals_table, Spacer(1, 10), Paragraph(f"Amount in Words: {amount_in_words(ctx['invoice']['grandTotal'], ctx['currency'])}", styles['italic_small']), Spacer(1, 14)]
    story += shared_bottom(ctx, styles)
    story += [Spacer(1, 10), HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#EDEFF4')), Spacer(1, 6),
              Paragraph("Thank you for your business!", ParagraphStyle('footer', alignment=TA_CENTER, textColor=brand, fontName=FONT_BOLD, fontSize=10))]
    return story


def design_minimal(ctx):
    brand = ctx['brand']
    styles = make_styles(brand)
    story = []

    co_name_style = ParagraphStyle('co_name', fontSize=14, leading=17, fontName=FONT_BOLD, textColor=colors.HexColor('#151B2C'))
    co_tag_style = ParagraphStyle('co_tag', fontSize=7.5, fontName=FONT, textColor=colors.HexColor('#8A93A6'))
    invoice_title = ParagraphStyle('invoice_title', fontSize=16, fontName=FONT, textColor=colors.HexColor('#8A93A6'), alignment=TA_RIGHT)

    logo = logo_flowable(ctx, size_mm=11)
    name_cell = Paragraph(f"{ctx['settings'].get('businessName','').upper()}", co_name_style)
    if logo:
        name_block = Table([[logo, name_cell]], colWidths=[13 * mm, 97 * mm])
        name_block.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 0)]))
    else:
        name_block = name_cell

    header_table = Table([[name_block, Paragraph("I N V O I C E", invoice_title)]], colWidths=[110 * mm, 62 * mm])
    header_table.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'BOTTOM')]))
    story += [header_table, Paragraph(ctx['settings'].get('tagline', ''), co_tag_style), Spacer(1, 8),
              HRFlowable(width="100%", thickness=0.75, color=colors.HexColor('#D8DCE5')), Spacer(1, 12)]

    story += [shared_meta_table(ctx, styles), Spacer(1, 14)]

    rows, col_widths = items_table_rows(ctx)
    items_table = Table(rows, colWidths=col_widths, repeatRows=1)
    items_table.setStyle(TableStyle([
        ('LINEBELOW', (0, 0), (-1, 0), 1, colors.HexColor('#151B2C')),
        ('FONTSIZE', (0, 0), (-1, -1), 8.5), ('FONTNAME', (0, 0), (-1, -1), FONT), ('FONTNAME', (0, 0), (-1, 0), FONT_BOLD),
        ('ALIGN', (-1, 0), (-1, -1), 'RIGHT'), ('ALIGN', (3, 0), (3, -1), 'CENTER'), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 7), ('TOPPADDING', (0, 0), (-1, -1), 7),
        ('LINEBELOW', (0, 1), (-1, -1), 0.4, colors.HexColor('#EDEFF4')),
    ]))
    story += [items_table, Spacer(1, 12)]

    totals_table = Table(ctx['total_rows'], colWidths=[40 * mm, 42 * mm], hAlign='RIGHT')
    totals_table.setStyle(TableStyle([
        ('FONTSIZE', (0, 0), (-1, -1), 9.5), ('FONTNAME', (0, 0), (-1, -1), FONT), ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
        ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ('LINEABOVE', (0, -1), (-1, -1), 1.2, colors.HexColor('#151B2C')),
        ('TEXTCOLOR', (0, -1), (-1, -1), colors.HexColor('#151B2C')),
        ('FONTNAME', (0, -1), (-1, -1), FONT_BOLD), ('FONTSIZE', (0, -1), (-1, -1), 12),
        ('TOPPADDING', (0, -1), (-1, -1), 8),
    ]))
    story += [totals_table, Spacer(1, 10), Paragraph(f"Amount in Words: {amount_in_words(ctx['invoice']['grandTotal'], ctx['currency'])}", styles['italic_small']), Spacer(1, 14)]
    story += shared_bottom(ctx, styles)
    story += [Spacer(1, 10), HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#EDEFF4')), Spacer(1, 6),
              Paragraph("Thank you for your business!", ParagraphStyle('footer', alignment=TA_CENTER, textColor=colors.HexColor('#151B2C'), fontName=FONT, fontSize=9.5))]
    return story


def design_classic(ctx):
    brand = ctx['brand']
    styles = make_styles(brand)
    story = []

    co_name_style = ParagraphStyle('co_name', fontSize=15, leading=18, fontName=FONT_BOLD, textColor=colors.HexColor('#151B2C'), alignment=TA_CENTER)
    co_tag_style = ParagraphStyle('co_tag', fontSize=7.5, fontName=FONT, textColor=colors.HexColor('#6B7385'), alignment=TA_CENTER)
    invoice_title = ParagraphStyle('invoice_title', fontSize=13, fontName=FONT_BOLD, textColor=brand, alignment=TA_CENTER)

    logo = logo_flowable(ctx, size_mm=12)
    if logo:
        logo.hAlign = 'CENTER'
        story.append(logo)
        story.append(Spacer(1, 4))
    story += [Paragraph(ctx['settings'].get('businessName', '').upper(), co_name_style),
              Paragraph(ctx['settings'].get('tagline', ''), co_tag_style), Spacer(1, 6),
              HRFlowable(width="100%", thickness=1.4, color=colors.HexColor('#151B2C')),
              Spacer(1, 1.5),
              HRFlowable(width="100%", thickness=0.6, color=colors.HexColor('#151B2C')),
              Spacer(1, 6),
              Paragraph("I N V O I C E", invoice_title), Spacer(1, 8)]

    meta_table = shared_meta_table(ctx, styles)
    meta_table.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('BOX', (0, 0), (-1, -1), 0.5, colors.HexColor('#B8BECC')),
                                     ('INNERGRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#B8BECC')),
                                     ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
                                     ('LEFTPADDING', (0, 0), (-1, -1), 8)]))
    story += [meta_table, Spacer(1, 14)]

    rows, col_widths = items_table_rows(ctx)
    items_table = Table(rows, colWidths=col_widths, repeatRows=1)
    items_table.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 0.75, colors.HexColor('#151B2C')),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#B8BECC')),
        ('LINEBELOW', (0, 0), (-1, 0), 1, colors.HexColor('#151B2C')),
        ('FONTSIZE', (0, 0), (-1, -1), 8.5), ('FONTNAME', (0, 0), (-1, -1), FONT), ('FONTNAME', (0, 0), (-1, 0), FONT_BOLD),
        ('ALIGN', (-1, 0), (-1, -1), 'RIGHT'), ('ALIGN', (3, 0), (3, -1), 'CENTER'), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6), ('TOPPADDING', (0, 0), (-1, -1), 6),
    ]))
    story += [items_table, Spacer(1, 12)]

    totals_table = Table(ctx['total_rows'], colWidths=[40 * mm, 42 * mm], hAlign='RIGHT')
    totals_table.setStyle(TableStyle([
        ('FONTSIZE', (0, 0), (-1, -1), 9.5), ('FONTNAME', (0, 0), (-1, -1), FONT), ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
        ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ('BOX', (0, -1), (-1, -1), 1, colors.HexColor('#151B2C')),
        ('FONTNAME', (0, -1), (-1, -1), FONT_BOLD), ('FONTSIZE', (0, -1), (-1, -1), 11),
        ('TOPPADDING', (0, -1), (-1, -1), 7), ('BOTTOMPADDING', (0, -1), (-1, -1), 7),
        ('LEFTPADDING', (0, -1), (-1, -1), 8), ('RIGHTPADDING', (0, -1), (-1, -1), 8),
    ]))
    story += [totals_table, Spacer(1, 10), Paragraph(f"Amount in Words: {amount_in_words(ctx['invoice']['grandTotal'], ctx['currency'])}", styles['italic_small']), Spacer(1, 14)]
    story += shared_bottom(ctx, styles)
    story += [Spacer(1, 10), HRFlowable(width="100%", thickness=0.6, color=colors.HexColor('#151B2C')), Spacer(1, 6),
              Paragraph("Thank you for your business!", ParagraphStyle('footer', alignment=TA_CENTER, textColor=colors.HexColor('#151B2C'), fontName=FONT_BOLD, fontSize=10))]
    return story


def design_bold(ctx):
    brand = ctx['brand']
    styles = make_styles(brand)
    story = []

    logo = logo_flowable(ctx, size_mm=14)
    name_style = ParagraphStyle('name', fontSize=17, fontName=FONT_BOLD, textColor=colors.white, leading=19)
    tag_style = ParagraphStyle('tag', fontSize=8, fontName=FONT, textColor=colors.white)
    inv_style = ParagraphStyle('inv', fontSize=20, fontName=FONT_BOLD, textColor=colors.white, alignment=TA_RIGHT)

    left_cell = [Paragraph(f"<b>{ctx['settings'].get('businessName','').upper()}</b>", name_style),
                 Paragraph(ctx['settings'].get('tagline', ''), tag_style)]
    if logo:
        head = Table([[logo, left_cell]], colWidths=[16 * mm, 104 * mm])
        head.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE')]))
    else:
        head = Table([left_cell])

    band = Table([[head, Paragraph("INVOICE", inv_style)]], colWidths=[120 * mm, 58 * mm])
    band.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), brand), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 10), ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
        ('LEFTPADDING', (0, 0), (0, 0), 10), ('RIGHTPADDING', (-1, 0), (-1, 0), 10),
    ]))
    story += [band, Spacer(1, 14)]

    story += [shared_meta_table(ctx, styles), Spacer(1, 14)]

    rows, col_widths = items_table_rows(ctx)
    items_table = Table(rows, colWidths=col_widths, repeatRows=1)
    items_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#151B2C')), ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTSIZE', (0, 0), (-1, -1), 8.5), ('FONTNAME', (0, 0), (-1, -1), FONT), ('FONTNAME', (0, 0), (-1, 0), FONT_BOLD),
        ('ALIGN', (-1, 0), (-1, -1), 'RIGHT'), ('ALIGN', (3, 0), (3, -1), 'CENTER'), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 7), ('TOPPADDING', (0, 0), (-1, -1), 7),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F5F7FB')]),
    ]))
    story += [items_table, Spacer(1, 12)]

    totals_table = Table(ctx['total_rows'], colWidths=[40 * mm, 42 * mm], hAlign='RIGHT')
    totals_table.setStyle(TableStyle([
        ('FONTSIZE', (0, 0), (-1, -1), 9.5), ('FONTNAME', (0, 0), (-1, -1), FONT), ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
        ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ('BACKGROUND', (0, -1), (-1, -1), colors.HexColor('#151B2C')), ('TEXTCOLOR', (0, -1), (-1, -1), colors.white),
        ('FONTNAME', (0, -1), (-1, -1), FONT_BOLD), ('FONTSIZE', (0, -1), (-1, -1), 12),
        ('TOPPADDING', (0, -1), (-1, -1), 9), ('BOTTOMPADDING', (0, -1), (-1, -1), 9),
        ('LEFTPADDING', (0, -1), (-1, -1), 8), ('RIGHTPADDING', (0, -1), (-1, -1), 8),
    ]))
    story += [totals_table, Spacer(1, 10), Paragraph(f"Amount in Words: {amount_in_words(ctx['invoice']['grandTotal'], ctx['currency'])}", styles['italic_small']), Spacer(1, 14)]
    story += shared_bottom(ctx, styles)
    story += [Spacer(1, 10), HRFlowable(width="100%", thickness=3, color=brand), Spacer(1, 6),
              Paragraph("Thank you for your business!", ParagraphStyle('footer', alignment=TA_CENTER, textColor=brand, fontName=FONT_BOLD, fontSize=10))]
    return story


def design_compact(ctx):
    brand = ctx['brand']
    styles = make_styles(brand)
    small_tight = ParagraphStyle('small_tight', parent=styles['small'], fontSize=7.8, leading=10.5)
    story = []

    co_name_style = ParagraphStyle('co_name', fontSize=11, leading=13, fontName=FONT_BOLD, textColor=brand)
    tag_style = ParagraphStyle('tag', fontSize=6.8, fontName=FONT, textColor=colors.HexColor('#8A93A6'))
    inv_style = ParagraphStyle('inv', fontSize=14, fontName=FONT_BOLD, textColor=brand, alignment=TA_RIGHT)

    logo = logo_flowable(ctx, size_mm=9)
    name_cell = Paragraph(f"<b>{ctx['settings'].get('businessName','').upper()}</b>", co_name_style)
    if logo:
        name_block = Table([[logo, name_cell]], colWidths=[10.5 * mm, 99.5 * mm])
        name_block.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 0)]))
    else:
        name_block = name_cell

    header_table = Table([[name_block, Paragraph("INVOICE", inv_style)]],
                          colWidths=[110 * mm, 62 * mm])
    story += [header_table, Paragraph(ctx['settings'].get('tagline', ''), tag_style), Spacer(1, 3),
              HRFlowable(width="100%", thickness=1, color=brand), Spacer(1, 6)]

    meta_table = Table([
        [Paragraph("FROM", styles['label']), Paragraph("BILL TO", styles['label']), Paragraph("INVOICE DETAILS", styles['label'])],
        [Paragraph(ctx['from_html'], small_tight), Paragraph(ctx['bill_html'], small_tight), Paragraph(ctx['meta_html'], small_tight)],
    ], colWidths=[60 * mm, 60 * mm, 52 * mm])
    story += [meta_table, Spacer(1, 8)]

    rows, col_widths = items_table_rows(ctx)
    items_table = Table(rows, colWidths=col_widths, repeatRows=1)
    items_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), brand), ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTSIZE', (0, 0), (-1, -1), 7.5), ('FONTNAME', (0, 0), (-1, -1), FONT), ('FONTNAME', (0, 0), (-1, 0), FONT_BOLD),
        ('ALIGN', (-1, 0), (-1, -1), 'RIGHT'), ('ALIGN', (3, 0), (3, -1), 'CENTER'), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3), ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('LINEBELOW', (0, 0), (-1, -2), 0.4, colors.HexColor('#EDEFF4')),
    ]))
    story += [items_table, Spacer(1, 8)]

    totals_table = Table(ctx['total_rows'], colWidths=[36 * mm, 38 * mm], hAlign='RIGHT')
    totals_table.setStyle(TableStyle([
        ('FONTSIZE', (0, 0), (-1, -1), 8), ('FONTNAME', (0, 0), (-1, -1), FONT), ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
        ('TOPPADDING', (0, 0), (-1, -1), 2), ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('BACKGROUND', (0, -1), (-1, -1), brand), ('TEXTCOLOR', (0, -1), (-1, -1), colors.white),
        ('FONTNAME', (0, -1), (-1, -1), FONT_BOLD), ('FONTSIZE', (0, -1), (-1, -1), 9.5),
        ('TOPPADDING', (0, -1), (-1, -1), 5), ('BOTTOMPADDING', (0, -1), (-1, -1), 5),
        ('LEFTPADDING', (0, -1), (-1, -1), 6), ('RIGHTPADDING', (0, -1), (-1, -1), 6),
    ]))
    story += [totals_table, Spacer(1, 6), Paragraph(f"Amount in Words: {amount_in_words(ctx['invoice']['grandTotal'], ctx['currency'])}", ParagraphStyle('iw', parent=small_tight, fontName=FONT_OBLIQUE)), Spacer(1, 8)]

    right_cell_compact = []
    if ctx['bank_html']:
        right_cell_compact.append(Paragraph(ctx['bank_html'], small_tight))
        right_cell_compact.append(Spacer(1, 5))
    qr_section_compact = upi_qr_section(ctx, styles, img_size_mm=16, text_style=small_tight)
    if qr_section_compact:
        right_cell_compact.append(qr_section_compact)
        right_cell_compact.append(Spacer(1, 5))
    right_cell_compact.append(Paragraph(ctx['terms_html'], small_tight))

    bottom_table = Table([[Paragraph(ctx['left_html'], small_tight), right_cell_compact]], colWidths=[90 * mm, 82 * mm])
    bottom_table.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP')]))
    story += [bottom_table, Spacer(1, 16),
              HRFlowable(width=45 * mm, thickness=0.75, color=colors.HexColor('#B8BECC'), hAlign='RIGHT'),
              Paragraph('<para alignment="right">Authorized Signature</para>', small_tight),
              Spacer(1, 10), HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#EDEFF4')), Spacer(1, 6),
              Paragraph("Thank you for your business!", ParagraphStyle('footer', alignment=TA_CENTER, textColor=brand, fontName=FONT_BOLD, fontSize=8.5))]
    return story


def item_discount_amount_and_pct(it):
    gross = it['qty'] * it['rate']
    discount = it.get('discount', 0) or 0
    if it.get('discountType') == 'flat':
        amt = min(discount, gross)
        pct = (amt / gross * 100) if gross else 0
    else:
        pct = discount
        amt = gross * discount / 100
    return amt, pct


def design_taxinvoice(ctx):
    """Bordered 'Tax Invoice' layout — Bill To / Ship To, per-item discount
    and GST columns, a tax-rate breakdown table, and Received/Balance/
    Customer Balance/You Saved figures, matching a common Indian billing-app
    invoice layout (in the business's own brand color rather than copying
    anyone else's color scheme or logo)."""
    brand = ctx['brand']
    styles = make_styles(brand)
    invoice, settings, customer, currency = ctx['invoice'], ctx['settings'], ctx['customer'], ctx['currency']
    line_color = colors.HexColor('#B8BECC')
    box = lambda extra=None: TableStyle([('BOX', (0, 0), (-1, -1), 0.75, colors.HexColor('#151B2C')),
                                          ('INNERGRID', (0, 0), (-1, -1), 0.5, line_color),
                                          ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                                          ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
                                          ('LEFTPADDING', (0, 0), (-1, -1), 8), ('RIGHTPADDING', (0, 0), (-1, -1), 8)] + (extra or []))
    label = ParagraphStyle('tl', fontSize=8, fontName=FONT_BOLD, textColor=colors.HexColor('#4C5468'), spaceAfter=2)
    val_style = styles['small']
    total_w = 178 * mm

    story = []

    # Title bar
    title_t = Table([[Paragraph('<para alignment="center"><b>TAX INVOICE</b></para>', ParagraphStyle('title', fontSize=12, fontName=FONT_BOLD, textColor=colors.HexColor('#151B2C')))]], colWidths=[total_w])
    title_t.setStyle(box([('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#F4F6FB'))]))
    story.append(title_t)

    # Business info | invoice meta
    logo = logo_flowable(ctx, size_mm=13)
    biz_lines = [Paragraph(f"<b>{escape_html(settings.get('businessName',''))}</b>", ParagraphStyle('bn', fontSize=11.5, fontName=FONT_BOLD, textColor=brand))]
    if logo:
        biz_head = Table([[logo, biz_lines[0]]], colWidths=[15 * mm, 74 * mm])
        biz_head.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0)]))
    else:
        biz_head = biz_lines[0]
    biz_extra = f"{escape_html(settings.get('address',''))}"
    if settings.get('showEmail', True) and settings.get('email'):
        biz_extra += f"<br/>Email: {escape_html(settings.get('email',''))} &nbsp; Mobile: {escape_html(settings.get('mobile',''))}"
    else:
        biz_extra += f"<br/>Mobile: {escape_html(settings.get('mobile',''))}"
    if settings.get('showUdyam'):
        biz_extra += f"<br/>{escape_html(settings.get('udyam',''))}"
    biz_extra += f"<br/>State: {escape_html(settings.get('businessState',''))}"
    biz_cell = [biz_head, Spacer(1, 3), Paragraph(biz_extra, val_style)]

    meta_cell = [Paragraph(f"<b>Invoice No.:</b> {escape_html(invoice.get('number',''))}", val_style),
                 Paragraph(f"<b>Date:</b> {invoice.get('date','')}", val_style),
                 Paragraph(f"<b>Due Date:</b> {invoice.get('dueDate','')}", val_style)]

    head_t = Table([[biz_cell, meta_cell]], colWidths=[110 * mm, 68 * mm])
    head_t.setStyle(box())
    story.append(head_t)

    # Bill To | Ship To
    ship_addr = invoice.get('shippingAddress') or ''
    bill_cell = [Paragraph('BILL TO', label), Paragraph(ctx['bill_html'], val_style)]
    ship_cell = [Paragraph('SHIP TO', label),
                 Paragraph(escape_html(ship_addr).replace('\n', '<br/>') if ship_addr else 'Same as billing address', val_style)]
    bs_t = Table([[bill_cell, ship_cell]], colWidths=[89 * mm, 89 * mm])
    bs_t.setStyle(box())
    story.append(bs_t)

    # Items table with Discount column
    gst_enabled = ctx['gst_enabled']
    head = ['#', 'Item Name', 'HSN/SAC', 'Qty', 'Price/Unit'] + (['Discount'] if True else []) + (['GST'] if gst_enabled else []) + ['Amount']
    rows = [head]
    tot_qty = 0
    tot_disc = 0
    tot_gst_amt = 0
    tot_amt = 0
    for i, it in enumerate(invoice.get('items', []), start=1):
        disc_amt, disc_pct = item_discount_amount_and_pct(it)
        amt = line_amount(it)
        item_tax = (amt * (it.get('gst', 0) or 0) / 100) if gst_enabled else 0
        row = [str(i), it.get('desc', ''), it.get('hsn', '-') or '-', str(it['qty']), fmt(it['rate'], currency),
               f"{fmt(disc_amt, currency)} ({disc_pct:.0f}%)"]
        if gst_enabled:
            row.append(f"{fmt(item_tax, currency)} ({it.get('gst',0)}%)")
        row.append(fmt(amt, currency))
        rows.append(row)
        tot_qty += it['qty']; tot_disc += disc_amt; tot_gst_amt += item_tax; tot_amt += amt
    total_row = ['', '', '', str(tot_qty), '', fmt(tot_disc, currency)] + ([fmt(tot_gst_amt, currency)] if gst_enabled else []) + [fmt(tot_amt, currency)]
    rows.append(total_row)

    col_widths = [7 * mm, 46 * mm, 18 * mm, 11 * mm, 21 * mm, 24 * mm] + ([21 * mm] if gst_enabled else []) + [total_w - (7 + 46 + 18 + 11 + 21 + 24 + (21 if gst_enabled else 0)) * mm]
    items_t = Table(rows, colWidths=col_widths, repeatRows=1)
    items_t.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 0.75, colors.HexColor('#151B2C')), ('INNERGRID', (0, 0), (-1, -1), 0.5, line_color),
        ('BACKGROUND', (0, 0), (-1, 0), brand), ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, 0), FONT_BOLD), ('FONTNAME', (0, 1), (-1, -1), FONT),
        ('FONTNAME', (0, -1), (-1, -1), FONT_BOLD),
        ('FONTSIZE', (0, 0), (-1, -1), 8), ('ALIGN', (-1, 0), (-1, -1), 'RIGHT'), ('ALIGN', (3, 0), (3, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ]))
    story.append(items_t)

    # Sub Total / Discount / Tax / Total
    sub_cells = [
        [Paragraph('Sub Total', label), Paragraph(fmt(invoice['subtotal'], currency), val_style)],
        [Paragraph('Discount', label), Paragraph(fmt(invoice.get('discountTotal', 0), currency), val_style)],
        [Paragraph('Tax', label), Paragraph(fmt(invoice.get('totalTax', 0), currency) if gst_enabled else 'N/A', val_style)],
        [Paragraph('Total', label), Paragraph(f"<b>{fmt(invoice['grandTotal'], currency)}</b>", ParagraphStyle('tot', parent=val_style, fontName=FONT_BOLD))],
    ]
    st_t = Table([sub_cells], colWidths=[total_w / 4] * 4)
    st_t.setStyle(box([('INNERGRID', (0, 0), (-1, -1), 0.5, line_color)]))
    story.append(st_t)

    # Received / Balance / Customer Balance / You Saved
    pay_cells = [
        [Paragraph('Received', label), Paragraph(fmt(ctx['received_amount'], currency), val_style)],
        [Paragraph('Balance', label), Paragraph(fmt(ctx['balance_amount'], currency), val_style)],
        [Paragraph('Customer Balance', label), Paragraph(fmt(ctx['customer_balance'], currency), val_style)],
        [Paragraph('You Saved', label), Paragraph(fmt(ctx['you_saved'], currency), ParagraphStyle('saved', parent=val_style, textColor=colors.HexColor('#12805C')))],
    ]
    pay_t = Table([pay_cells], colWidths=[total_w / 4] * 4)
    pay_t.setStyle(box([('INNERGRID', (0, 0), (-1, -1), 0.5, line_color)]))
    story.append(pay_t)

    # Tax rate breakdown | QR + Bank details
    tax_rows = [['Rate', 'Taxable Amt', 'CGST', 'SGST', 'Total Tax']] if invoice.get('sameState', True) else [['Rate', 'Taxable Amt', 'IGST', '', 'Total Tax']]
    if gst_enabled:
        by_rate = {}
        for it in invoice.get('items', []):
            amt = line_amount(it)
            rate = it.get('gst', 0) or 0
            by_rate.setdefault(rate, 0)
            by_rate[rate] += amt
        for rate, taxable in sorted(by_rate.items()):
            tax = taxable * rate / 100
            if invoice.get('sameState', True):
                tax_rows.append([f"{rate}%", fmt(taxable, currency), fmt(tax / 2, currency), fmt(tax / 2, currency), fmt(tax, currency)])
            else:
                tax_rows.append([f"{rate}%", fmt(taxable, currency), fmt(tax, currency), '', fmt(tax, currency)])
        tax_table = Table(tax_rows, colWidths=[16 * mm, 26 * mm, 20 * mm, 20 * mm, 24 * mm])
        tax_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#EEF1F6')), ('FONTNAME', (0, 0), (-1, 0), FONT_BOLD),
            ('FONTNAME', (0, 1), (-1, -1), FONT),
            ('FONTSIZE', (0, 0), (-1, -1), 7.5), ('GRID', (0, 0), (-1, -1), 0.5, line_color),
            ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4), ('ALIGN', (1, 0), (-1, -1), 'RIGHT'),
        ]))
        tax_cell = [Paragraph('TAX BREAKDOWN', label), tax_table]
    else:
        tax_cell = [Paragraph('TAX', label), Paragraph('Not applicable (Non-GST invoice)', val_style)]

    qr_bank_cell = []
    if ctx['bank_html']:
        qr_bank_cell += [Paragraph(ctx['bank_html'], val_style), Spacer(1, 6)]
    qr_section = upi_qr_section(ctx, styles, img_size_mm=20)
    if qr_section:
        qr_bank_cell.append(qr_section)
    if not qr_bank_cell:
        qr_bank_cell = [Paragraph('—', val_style)]

    tb_t = Table([[tax_cell, qr_bank_cell]], colWidths=[106 * mm, 72 * mm])
    tb_t.setStyle(box())
    story.append(tb_t)

    # Description | Terms & Conditions | For: Company + Signature
    desc_cell = [Paragraph('DESCRIPTION', label), Paragraph(nl2br(invoice.get('notes', '-')), val_style)]
    terms_cell = [Paragraph('TERMS &amp; CONDITIONS', label), Paragraph(nl2br(invoice.get('terms', '-')), val_style)]
    sign_cell = [Paragraph(f"For: {escape_html(settings.get('businessName',''))}", label), Spacer(1, 26),
                 Paragraph('<para alignment="center">Authorized Signatory</para>', val_style)]
    df_t = Table([[desc_cell, terms_cell, sign_cell]], colWidths=[60 * mm, 60 * mm, 58 * mm])
    df_t.setStyle(box())
    story.append(df_t)

    return story


DESIGN_BUILDERS = {
    'modern': design_modern,
    'minimal': design_minimal,
    'classic': design_classic,
    'bold': design_bold,
    'compact': design_compact,
    'taxinvoice': design_taxinvoice,
}


def design_thermal(ctx):
    """Matches the narrow receipt-style layout: dashed separators, centered
    header, Bill To + Place of Supply, per-item Qty/Price/Amount with a
    discount sub-line, then Received/Balance at the bottom."""
    brand = ctx['brand']
    currency = ctx['currency']
    invoice = ctx['invoice']
    settings = ctx['settings']
    customer = ctx['customer']
    gst_enabled = ctx['gst_enabled']

    tiny = ParagraphStyle('tiny', fontSize=7, leading=9.5, fontName=FONT)
    tiny_b = ParagraphStyle('tiny_b', parent=tiny, fontName=FONT_BOLD)
    center_b = ParagraphStyle('center_b', parent=tiny_b, alignment=TA_CENTER, fontSize=9.5, textColor=brand)
    center = ParagraphStyle('center', parent=tiny, alignment=TA_CENTER, fontSize=6.5, textColor=colors.HexColor('#555'))
    center_title = ParagraphStyle('center_title', parent=tiny_b, alignment=TA_CENTER, fontSize=8)
    right = ParagraphStyle('right', parent=tiny, alignment=TA_RIGHT)
    sub = ParagraphStyle('sub', parent=tiny, fontSize=6.3, textColor=colors.HexColor('#777'))
    dash = HRFlowable(width="100%", thickness=0.75, color=colors.HexColor('#999'), dash=(2, 2))

    story = []
    logo = logo_flowable(ctx, size_mm=9)
    if logo:
        logo.hAlign = 'CENTER'
        story.append(logo)
        story.append(Spacer(1, 3))

    story += [Paragraph(settings.get('businessName', '').upper(), center_b),
              Paragraph(escape_html(settings.get('address', '')), center)]
    if settings.get('businessState'):
        story.append(Paragraph(f"State: {escape_html(settings.get('businessState',''))}", center))
    contact_bits = [settings.get('mobile', '')]
    if settings.get('showEmail', True) and settings.get('email'):
        contact_bits.append(settings.get('email', ''))
    if settings.get('showUdyam') and settings.get('udyam'):
        contact_bits.append(settings.get('udyam', ''))
    story.append(Paragraph(' · '.join(b for b in contact_bits if b), center))

    story += [Spacer(1, 4), dash, Spacer(1, 3), Paragraph('Tax Invoice' if gst_enabled else 'Invoice', center_title), Spacer(1, 3)]

    meta_row = Table([[Paragraph(f"Invoice No.: {escape_html(invoice.get('number',''))}", tiny), Paragraph(f"Date: {invoice.get('date','')}", right)]], colWidths=[58 * mm, 28 * mm])
    meta_row.setStyle(TableStyle([('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0), ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0)]))
    story += [meta_row, Spacer(1, 4), dash, Spacer(1, 3)]

    if customer:
        story.append(Paragraph(f"<b>{escape_html(customer.get('name',''))}</b>", ParagraphStyle('party', parent=tiny_b, alignment=TA_CENTER)))
        if customer.get('mobile'):
            story.append(Paragraph(f"Ph. No.: {escape_html(customer.get('mobile',''))}", center))
        story += [Spacer(1, 3), Paragraph('<b>Bill To:</b>', tiny)]
        if customer.get('address'):
            story.append(Paragraph(escape_html(customer.get('address', '')), tiny))
        if customer.get('state'):
            story += [Paragraph('<b>Place of Supply:</b>', tiny), Paragraph(escape_html(customer.get('state', '')), tiny)]

    story += [Spacer(1, 4), dash, Spacer(1, 3)]

    for i, it in enumerate(invoice.get('items', []), start=1):
        amt = line_amount(it)
        disc_amt, disc_pct = item_discount_amount_and_pct(it)
        name_line = f"{i}&nbsp;&nbsp;{escape_html(it.get('desc',''))}" + (f" ({escape_html(it.get('hsn',''))})" if it.get('hsn') else '')
        row = Table([[Paragraph(name_line, tiny), Paragraph(fmt(amt, currency), right)]], colWidths=[58 * mm, 28 * mm])
        row.setStyle(TableStyle([('TOPPADDING', (0, 0), (-1, -1), 1), ('BOTTOMPADDING', (0, 0), (-1, -1), 1),
                                  ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0)]))
        story.append(row)
        qty_line = f"&nbsp;&nbsp;&nbsp;&nbsp;Qty {it['qty']} x {fmt(it['rate'], currency)}"
        if gst_enabled:
            qty_line += f"  GST {it.get('gst',0)}%"
        story.append(Paragraph(qty_line, sub))
        if disc_amt:
            story.append(Paragraph(f"&nbsp;&nbsp;&nbsp;&nbsp;Disc. ({disc_pct:.0f}%): -{fmt(disc_amt, currency)}", sub))

    story += [Spacer(1, 4), dash, Spacer(1, 3)]

    summary_rows = [['Subtotal', fmt(invoice['subtotal'], currency)]]
    if invoice.get('discountTotal', 0) > 0:
        summary_rows.append(['Total Discount', f"-{fmt(invoice['discountTotal'], currency)}"])
    if gst_enabled:
        summary_rows.append(['Tax', fmt(invoice.get('totalTax', 0), currency)])
    for lbl, value in summary_rows:
        r = Table([[Paragraph(lbl, tiny), Paragraph(value, right)]], colWidths=[58 * mm, 28 * mm])
        r.setStyle(TableStyle([('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0), ('TOPPADDING', (0, 0), (-1, -1), 1), ('BOTTOMPADDING', (0, 0), (-1, -1), 1)]))
        story.append(r)

    grand_row = Table([[Paragraph('<b>TOTAL</b>', tiny_b), Paragraph(f"<b>{fmt(invoice['grandTotal'], currency)}</b>", ParagraphStyle('gr', parent=right, fontName=FONT_BOLD, fontSize=8.5))]],
                       colWidths=[58 * mm, 28 * mm])
    grand_row.setStyle(TableStyle([('LINEABOVE', (0, 0), (-1, 0), 1, brand), ('TOPPADDING', (0, 0), (-1, -1), 3),
                                    ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0)]))
    story += [grand_row]

    for lbl, value in [('Received', ctx['received_amount']), ('Balance', ctx['balance_amount'])]:
        r = Table([[Paragraph(lbl, tiny), Paragraph(fmt(value, currency), right)]], colWidths=[58 * mm, 28 * mm])
        r.setStyle(TableStyle([('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0), ('TOPPADDING', (0, 0), (-1, -1), 1), ('BOTTOMPADDING', (0, 0), (-1, -1), 1)]))
        story.append(r)

    story += [Spacer(1, 6), Paragraph(amount_in_words(invoice['grandTotal'], currency), ParagraphStyle('iw', parent=tiny, fontSize=6.3, fontName=FONT_OBLIQUE))]

    if settings.get('showUpiQr') and settings.get('upiId'):
        qr_section_thermal = upi_qr_section(ctx, None, img_size_mm=16, text_style=tiny)
        if qr_section_thermal:
            story += [Spacer(1, 5), dash, Spacer(1, 4), qr_section_thermal]
    if settings.get('showBank'):
        story += [Spacer(1, 5), Paragraph('<b>Bank Details</b>', tiny),
                  Paragraph(f"Bank: {escape_html(settings.get('bankName',''))}<br/>A/C: {escape_html(settings.get('bankAccount',''))}<br/>IFSC: {escape_html(settings.get('bankIfsc',''))}",
                            ParagraphStyle('bank', parent=tiny, fontSize=6.3))]

    story += [Spacer(1, 8), dash, Spacer(1, 4),
              Paragraph("Thank you for your business!", center_b)]
    return story


def build_pdf(payload):
    ctx = build_context(payload)
    fmt_choice = (payload.get('format') or 'a4').lower()

    if fmt_choice == 'thermal':
        buf = io.BytesIO()
        doc = SimpleDocTemplate(buf, pagesize=(4 * inch, 6 * inch),
                                 topMargin=6 * mm, bottomMargin=6 * mm, leftMargin=6 * mm, rightMargin=6 * mm,
                                 title=f"Invoice {ctx['invoice'].get('number','')}")
        doc.build(design_thermal(ctx))
        return buf.getvalue()

    template = (payload.get('template') or ctx['settings'].get('template') or 'modern').lower()
    if template not in VALID_TEMPLATES:
        template = 'modern'
    builder = DESIGN_BUILDERS[template]

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4,
                             topMargin=16 * mm, bottomMargin=16 * mm, leftMargin=16 * mm, rightMargin=16 * mm,
                             title=f"Invoice {ctx['invoice'].get('number','')}")
    doc.build(builder(ctx))
    return buf.getvalue()


def main():
    raw = sys.stdin.buffer.read()
    payload = json.loads(raw.decode('utf-8'))
    pdf_bytes = build_pdf(payload)
    sys.stdout.buffer.write(pdf_bytes)
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"generate_pdf.py error: {e}", file=sys.stderr)
        sys.exit(1)
