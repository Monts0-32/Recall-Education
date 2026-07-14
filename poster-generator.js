/* ============================================================================
 * poster-generator.js
 * Build printable posters (PPTX + PDF) for school invite codes. Two
 * functions on window.PosterGenerator:
 *   - buildPptx({ schoolName, code, expiresAt, maxUses, usesCount,
 *                 allowedEmailDomain })
 *       returns a Blob of the .pptx.
 *   - buildPdf({ same args })
 *       returns a Blob of the PDF.
 *
 * Caller pipes the Blob through URL.createObjectURL to download. The
 * CDN libs are loaded once on the organiser dashboard before this
 * file. If a lib is missing, buildPptx / buildPdf throws with a clear
 * message — the UI surfaces a toast.
 *
 * Layout: single PPTX slide (16:9) or single A4 portrait PDF. Recall
 * brand colours, the school name, the code in a big monospaced pill,
 * the signup URL, and an optional rules footer.
 * ========================================================================= */
(function () {
  'use strict';

  const BRAND       = '#58A6FF';   // --blue
  const BRAND_DARK  = '#1F6FEB';   // --blue-2
  const BG          = '#0D1117';   // --bg
  const BG_2        = '#161B22';   // --bg-2
  const TEXT        = '#F0F6FC';   // --text
  const TEXT_2      = '#C9D1D9';   // --text-2
  const TEXT_3      = '#8B949E';   // --text-3
  const LINE        = '#21262D';   // --line
  const YELLOW      = '#E3B341';
  const MONO        = "'JetBrains Mono', 'Consolas', 'Menlo', monospace";
  const SIGNUP_URL  = 'recalleducation.co.uk/signup.html';

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // Build the rule footer lines. Each line is "Label: value". Returns
  // an array of strings (empty if no rules).
  function buildRules(opts) {
    const lines = [];
    if (opts.expiresAt) {
      lines.push('Expires ' + fmtDate(opts.expiresAt));
    }
    if (opts.maxUses) {
      const remaining = Math.max((opts.maxUses | 0) - ((opts.usesCount | 0)), 0);
      lines.push((opts.usesCount | 0) + ' of ' + opts.maxUses + ' used  ·  ' + remaining + ' remaining');
    }
    if (opts.allowedEmailDomain) {
      lines.push('Email must end in @' + opts.allowedEmailDomain);
    }
    return lines;
  }

  /* ---------- PPTX -------------------------------------------------------- */
  async function buildPptx(opts) {
    if (typeof PptxGenJS === 'undefined') {
      throw new Error('PptxGenJS library not loaded.');
    }
    const pres = new PptxGenJS();
    pres.layout = 'LAYOUT_WIDE';   // 13.33 x 7.5 inches, 16:9
    pres.title  = 'Recall sign-up code — ' + (opts.schoolName || 'School');
    pres.author = 'Recall Education';

    const slide = pres.addSlide();
    slide.background = { color: BG };

    // Brand strip on the left.
    slide.addShape('rect', { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: BRAND }, line: { color: BRAND } });

    // RECALL wordmark.
    slide.addText('RECALL', {
      x: 0.6, y: 0.45, w: 4, h: 0.45,
      fontFace: 'Inter', fontSize: 18, bold: true, color: BRAND, charSpacing: 4,
    });

    // Headline.
    slide.addText('Join us at', {
      x: 0.6, y: 1.4, w: 12, h: 0.5,
      fontFace: 'Inter', fontSize: 22, color: TEXT_3,
    });
    slide.addText((opts.schoolName || 'School').toUpperCase(), {
      x: 0.6, y: 1.9, w: 12, h: 1.0,
      fontFace: 'Inter', fontSize: 40, bold: true, color: TEXT, charSpacing: 1,
    });

    // Code label.
    slide.addText('School sign-up code', {
      x: 0.6, y: 3.4, w: 6, h: 0.4,
      fontFace: 'Inter', fontSize: 16, color: TEXT_3,
    });

    // Code pill — filled rectangle with the code inside.
    slide.addShape('roundRect', {
      x: 0.6, y: 3.9, w: 6.0, h: 1.5,
      fill: { color: BG_2 }, line: { color: BRAND, width: 2 }, rectRadius: 0.1,
    });
    slide.addText(opts.code || '', {
      x: 0.6, y: 3.9, w: 6.0, h: 1.5,
      fontFace: 'Courier New', fontSize: 54, bold: true, color: BRAND,
      align: 'center', valign: 'middle', charSpacing: 4,
    });

    // URL.
    slide.addText('Sign up at ' + SIGNUP_URL, {
      x: 0.6, y: 5.6, w: 8, h: 0.4,
      fontFace: 'Inter', fontSize: 18, color: TEXT_2,
    });

    // Rules footer.
    const rules = buildRules(opts);
    if (rules.length) {
      slide.addText(rules.map(l => '• ' + l).join('\n'), {
        x: 0.6, y: 6.2, w: 12, h: 1.0,
        fontFace: 'Inter', fontSize: 14, color: YELLOW, lineSpacingMultiple: 1.3,
      });
    }

    // Brand line at the bottom.
    slide.addText('recalleducation.co.uk', {
      x: 0.6, y: 7.05, w: 12, h: 0.3,
      fontFace: 'Inter', fontSize: 10, color: TEXT_3,
    });

    const blob = await pres.write({ outputType: 'blob' });
    return blob;
  }

  /* ---------- PDF --------------------------------------------------------- */
  function buildPdf(opts) {
    if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) {
      throw new Error('jsPDF library not loaded.');
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const pageW = doc.internal.pageSize.getWidth();    // 210
    const pageH = doc.internal.pageSize.getHeight();   // 297

    // Background.
    doc.setFillColor(BG);
    doc.rect(0, 0, pageW, pageH, 'F');

    // Brand strip on the left.
    doc.setFillColor(BRAND);
    doc.rect(0, 0, 6, pageH, 'F');

    // RECALL wordmark.
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(BRAND);
    doc.text('RECALL', 16, 22, { charSpace: 2 });

    // Headline.
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(18);
    doc.setTextColor(TEXT_3);
    doc.text('Join us at', 16, 60);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(34);
    doc.setTextColor(TEXT);
    doc.text((opts.schoolName || 'School').toUpperCase(), 16, 78, { charSpace: 1 });

    // Code label.
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(14);
    doc.setTextColor(TEXT_3);
    doc.text('School sign-up code', 16, 110);

    // Code pill.
    const pillX = 16, pillY = 118, pillW = 130, pillH = 32;
    doc.setFillColor(BG_2);
    doc.setDrawColor(BRAND);
    doc.setLineWidth(1.2);
    doc.roundedRect(pillX, pillY, pillW, pillH, 3, 3, 'FD');
    doc.setFont('courier', 'bold');
    doc.setFontSize(34);
    doc.setTextColor(BRAND);
    doc.text(opts.code || '', pillX + pillW / 2, pillY + 21, {
      align: 'center', charSpace: 2,
    });

    // URL.
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(14);
    doc.setTextColor(TEXT_2);
    doc.text('Sign up at ' + SIGNUP_URL, 16, 170);

    // Rules footer.
    const rules = buildRules(opts);
    if (rules.length) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(YELLOW);
      const ruleText = rules.map(l => '• ' + l).join('\n');
      doc.text(ruleText, 16, 185);
    }

    // Brand line at the bottom.
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(TEXT_3);
    doc.text('recalleducation.co.uk', 16, pageH - 10);

    const blob = doc.output('blob');
    return blob;
  }

  /* ---------- download helper -------------------------------------------- */
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function fileBase(opts) {
    return 'Recall-Code-' + (opts.code || 'CODE');
  }

  window.PosterGenerator = {
    buildPptx,
    buildPdf,
    downloadPptx(opts) {
      return buildPptx(opts).then(blob => download(blob, fileBase(opts) + '.pptx'));
    },
    downloadPdf(opts) {
      return buildPdf(opts).then(blob => download(blob, fileBase(opts) + '.pdf'));
    },
  };
})();
