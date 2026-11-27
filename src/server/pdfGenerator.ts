import path from 'path';
import PDFDocument from 'pdfkit';
import type { AmortizationRow, RhpTransaction, SignatureNames } from '../types/rhp.ts';
import { formatTHB, formatPercent } from '../utils/rhpCalculator.ts';

interface PdfPayload {
  transaction: RhpTransaction;
  schedule: AmortizationRow[];
  companyName: string;
  companyAddress?: string;
  companyLogoDataUrl?: string | null;
  signatures?: Partial<SignatureNames>;
  generatedAt: string;
}

const FONTS_DIR = path.resolve(process.cwd(), 'fonts');
const THAI_REGULAR = path.join(FONTS_DIR, 'NotoLoopedThai-Regular.ttf');
const THAI_BOLD = path.join(FONTS_DIR, 'NotoLoopedThai-Bold.ttf');
const LATIN_REGULAR = path.join(FONTS_DIR, 'NotoSans-Regular.ttf');
const LATIN_BOLD = path.join(FONTS_DIR, 'NotoSans-Bold.ttf');

interface TextSegment {
  text: string;
  isThai: boolean;
}

function splitMixedText(input: string): TextSegment[] {
  const safe = String(input ?? '');
  if (!safe) return [];
  const segments: TextSegment[] = [];
  const regex = /([\u0E00-\u0E7F]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(safe)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: safe.slice(lastIndex, match.index), isThai: false });
    }
    segments.push({ text: match[0], isThai: true });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < safe.length) {
    segments.push({ text: safe.slice(lastIndex), isThai: false });
  }
  return segments;
}

function measureMixedWidth(
  doc: PDFKit.PDFDocument,
  text: string,
  fontSize: number,
  bold: boolean
): number {
  const segments = splitMixedText(text);
  let total = 0;
  doc.fontSize(fontSize);
  for (const seg of segments) {
    doc.font(seg.isThai ? (bold ? 'ThaiBold' : 'ThaiRegular') : bold ? 'LatinBold' : 'LatinRegular');
    total += doc.widthOfString(seg.text);
  }
  return total;
}

function drawMixedText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  options: {
    fontSize?: number;
    bold?: boolean;
    color?: string;
    width?: number;
    align?: 'left' | 'center' | 'right';
  } = {}
): void {
  const fontSize = options.fontSize ?? 10;
  const bold = options.bold ?? false;
  const color = options.color ?? '#0f172a';
  const align = options.align ?? 'left';

  const segments = splitMixedText(text);
  if (segments.length === 0) return;

  let startX = x;
  if (options.width && (align === 'right' || align === 'center')) {
    const measured = measureMixedWidth(doc, text, fontSize, bold);
    if (align === 'right') {
      startX = x + Math.max(0, options.width - measured);
    } else if (align === 'center') {
      startX = x + Math.max(0, (options.width - measured) / 2);
    }
  }

  doc.fillColor(color).fontSize(fontSize);
  let cursorX = startX;
  for (const seg of segments) {
    doc.font(seg.isThai ? (bold ? 'ThaiBold' : 'ThaiRegular') : bold ? 'LatinBold' : 'LatinRegular');
    doc.text(seg.text, cursorX, y, { lineBreak: false });
    cursorX += doc.widthOfString(seg.text);
  }
}

function fitText(
  doc: PDFKit.PDFDocument,
  text: string,
  maxWidth: number,
  fontSize: number,
  bold: boolean
): string {
  if (measureMixedWidth(doc, text, fontSize, bold) <= maxWidth) return text;
  let trimmed = text;
  while (trimmed.length > 1 && measureMixedWidth(doc, `${trimmed}...`, fontSize, bold) > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}...`;
}

function decodeLogoBuffer(dataUrl?: string | null): Buffer | null {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!match) return null;
  try {
    return Buffer.from(match[2], 'base64');
  } catch {
    return null;
  }
}

export async function generateRhpPdfBuffer(payload: PdfPayload): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        layout: 'portrait',
        margins: { top: 36, bottom: 36, left: 40, right: 40 },
        bufferPages: true,
        info: {
          Title: `MAX SANY RHP PORTAL - ${payload.transaction.rhpContractId}`,
          Author: payload.companyName || 'Risk Control Department',
          Subject:
            'ระบบคำนวณและบริหารจัดการสัญญาปรับโครงสร้างหนี้ (Restructuring Hire Purchase Calculation & Contract Management System)',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      doc.registerFont('ThaiRegular', THAI_REGULAR);
      doc.registerFont('ThaiBold', THAI_BOLD);
      doc.registerFont('LatinRegular', LATIN_REGULAR);
      doc.registerFont('LatinBold', LATIN_BOLD);

      const pageWidth = doc.page.width; // 595.28
      const pageHeight = doc.page.height; // 841.89
      const marginL = 40;
      const marginR = 40;
      const contentWidth = pageWidth - marginL - marginR; // 515.28

      const tx = payload.transaction;
      const isDraft = tx.transactionStatus !== 'Approved';
      const logoBuffer = decodeLogoBuffer(payload.companyLogoDataUrl);

      const drawWatermarkIfDraft = () => {
        if (!isDraft) return;
        doc.save();
        doc.rotate(-35, { origin: [pageWidth / 2, pageHeight / 2] });
        doc.opacity(0.08);
        doc.font('LatinBold').fontSize(62).fillColor('#b45309');
        doc.text('DRAFT', pageWidth / 2 - 115, pageHeight / 2 - 50, { lineBreak: false });
        doc.font('ThaiBold').fontSize(20).fillColor('#b45309');
        doc.text('ร่างเอกสาร - ยังไม่ได้รับอนุมัติ (Not Approved)', pageWidth / 2 - 185, pageHeight / 2 + 20, {
          lineBreak: false,
        });
        doc.restore();
        doc.opacity(1);
      };

      const drawTopContractBanner = (isFirstPage: boolean) => {
        if (isFirstPage) {
          let headerTextX = marginL;
          if (logoBuffer) {
            try {
              doc.image(logoBuffer, marginL, 30, { fit: [48, 48] });
              headerTextX = marginL + 56;
            } catch {
              headerTextX = marginL;
            }
          }

          const boxW = 205;
          const leftHeaderMaxW = pageWidth - marginR - boxW - headerTextX - 10;

          drawMixedText(doc, 'MAX SANY RHP PORTAL', headerTextX, 27, {
            fontSize: 12.5,
            bold: true,
            color: '#0f2942',
          });

          drawMixedText(
            doc,
            fitText(
              doc,
              'ระบบคำนวณและบริหารจัดการสัญญาปรับโครงสร้างหนี้',
              leftHeaderMaxW,
              9.5,
              true
            ),
            headerTextX,
            43,
            { fontSize: 9.5, bold: true, color: '#1e3a5f' }
          );

          drawMixedText(
            doc,
            fitText(
              doc,
              'Restructuring Hire Purchase Calculation & Contract Management System',
              leftHeaderMaxW,
              7.2,
              false
            ),
            headerTextX,
            56,
            { fontSize: 7.2, color: '#334155' }
          );

          drawMixedText(doc, 'By Risk Control Department', headerTextX, 67, {
            fontSize: 7.8,
            bold: true,
            color: '#0f2942',
          });

          if (payload.companyName) {
            drawMixedText(
              doc,
              fitText(doc, payload.companyName, leftHeaderMaxW, 7, false),
              headerTextX,
              78,
              { fontSize: 7, color: '#475569' }
            );
          }

          // Right metadata box
          const boxX = pageWidth - marginR - boxW;
          doc
            .roundedRect(boxX, 28, boxW, 60, 4)
            .fillAndStroke(isDraft ? '#fffbeb' : '#ecfdf5', isDraft ? '#f59e0b' : '#10b981');

          drawMixedText(doc, 'เลขที่สัญญา (RHP Contract ID):', boxX + 8, 33, {
            fontSize: 7.2,
            color: '#475569',
          });
          drawMixedText(doc, tx.rhpContractId, boxX + 8, 43, {
            fontSize: 9.8,
            bold: true,
            color: '#0f172a',
          });
          drawMixedText(doc, `วันที่จัดทำ (Date): ${tx.transactionDate}`, boxX + 8, 57, {
            fontSize: 7.8,
            color: '#334155',
          });
          drawMixedText(
            doc,
            isDraft
              ? 'สถานะ (Status): DRAFT (ยังไม่ได้รับอนุมัติ)'
              : 'สถานะ (Status): APPROVED (อนุมัติแล้ว)',
            boxX + 8,
            70,
            {
              fontSize: 7.8,
              bold: true,
              color: isDraft ? '#b45309' : '#047857',
            }
          );

          doc
            .moveTo(marginL, 95)
            .lineTo(pageWidth - marginR, 95)
            .lineWidth(1.2)
            .strokeColor('#0f2942')
            .stroke();
        } else {
          // Continuation page header with MAX SANY RHP PORTAL & RHP Contract ID on every page
          doc.rect(marginL, 32, contentWidth, 28).fillAndStroke('#f8fafc', '#cbd5e1');
          drawMixedText(
            doc,
            `MAX SANY RHP PORTAL · By Risk Control Department  |  RHP Contract ID: ${tx.rhpContractId}`,
            marginL + 8,
            40,
            { fontSize: 8.2, bold: true, color: '#0f2942' }
          );
          drawMixedText(
            doc,
            isDraft ? 'สถานะ (Status): DRAFT' : 'สถานะ (Status): APPROVED',
            pageWidth - marginR - 140,
            40,
            {
              fontSize: 8,
              bold: true,
              color: isDraft ? '#b45309' : '#047857',
              width: 132,
              align: 'right',
            }
          );
        }
      };

      // Page 1
      drawWatermarkIfDraft();
      drawTopContractBanner(true);

      let y = 104;

      // Section 1: Customer & Contract Information (Bilingual)
      doc.rect(marginL, y, contentWidth, 20).fill('#0f2942');
      drawMixedText(
        doc,
        'ส่วนที่ 1: ข้อมูลลูกค้าและรายละเอียดสัญญา (Customer & Contract Information)',
        marginL + 8,
        y + 5,
        { fontSize: 9, bold: true, color: '#ffffff' }
      );
      y += 22;

      const infoRows: Array<[string, string, string, string]> = [
        [
          'รหัสลูกค้า (Customer ID)',
          tx.customerId,
          'เลขที่สัญญาปรับโครงสร้างใหม่ (New RHP Contract Number)',
          tx.rhpContractId,
        ],
        [
          'ชื่อผู้เช่าซื้อ (Hire Purchase Customer Name)',
          tx.customerName,
          'เลขที่สัญญาเดิม (Original Contract Number)',
          tx.originalContractNumber,
        ],
        [
          'หมายเลขประจำเครื่องจักร (Machine Serial Number)',
          tx.machineSerialNumber,
          'วันที่ทำรายการ (Transaction Date)',
          tx.transactionDate,
        ],
      ];

      const halfW = contentWidth / 2;
      const infoRowH = 30;
      for (const [l1, v1, l2, v2] of infoRows) {
        doc.rect(marginL, y, contentWidth, infoRowH).fillAndStroke('#ffffff', '#e2e8f0');
        doc
          .moveTo(marginL + halfW, y)
          .lineTo(marginL + halfW, y + infoRowH)
          .strokeColor('#e2e8f0')
          .stroke();

        drawMixedText(doc, l1, marginL + 8, y + 4, { fontSize: 7.5, color: '#475569' });
        drawMixedText(doc, fitText(doc, v1, halfW - 16, 9, true), marginL + 8, y + 15, {
          fontSize: 9,
          bold: true,
          color: '#0f172a',
        });

        drawMixedText(doc, l2, marginL + halfW + 8, y + 4, { fontSize: 7.5, color: '#475569' });
        drawMixedText(doc, fitText(doc, v2, halfW - 16, 9, true), marginL + halfW + 8, y + 15, {
          fontSize: 9,
          bold: true,
          color: '#0f172a',
        });
        y += infoRowH;
      }

      y += 10;

      // Section 2: Financial Information (Bilingual)
      doc.rect(marginL, y, contentWidth, 20).fill('#0f2942');
      drawMixedText(doc, 'ส่วนที่ 2: รายละเอียดทางการเงิน (Financial Information)', marginL + 8, y + 5, {
        fontSize: 9,
        bold: true,
        color: '#ffffff',
      });
      y += 24;

      // Highlight Boxes for AR & Monthly Installment
      const cardGap = 12;
      const cardW = (contentWidth - cardGap) / 2;

      doc.roundedRect(marginL, y, cardW, 50, 4).fillAndStroke('#eff6ff', '#1e3a5f');
      drawMixedText(doc, 'ยอดลูกหนี้รวม (Total Amount Receivable: AR)', marginL + 10, y + 7, {
        fontSize: 8,
        bold: true,
        color: '#1e3a5f',
      });
      drawMixedText(doc, `${formatTHB(tx.ar)} THB`, marginL + 10, y + 22, {
        fontSize: 15,
        bold: true,
        color: '#0f2942',
      });

      const rightCardX = marginL + cardW + cardGap;
      doc.roundedRect(rightCardX, y, cardW, 50, 4).fillAndStroke('#ecfdf5', '#059669');
      drawMixedText(doc, 'ค่างวดต่อเดือน (Monthly Installment)', rightCardX + 10, y + 7, {
        fontSize: 8,
        bold: true,
        color: '#047857',
      });
      drawMixedText(doc, `${formatTHB(tx.monthlyInstallment)} THB`, rightCardX + 10, y + 22, {
        fontSize: 15,
        bold: true,
        color: '#065f46',
      });

      y += 58;

      const finPairs: Array<[string, string, string, string]> = [
        [
          'ราคาต้นทุนเครื่องจักร (Machine Cost)',
          `${formatTHB(tx.machineCost)} THB`,
          'วิธีคำนวณดอกเบี้ย (Interest Calculation Method)',
          tx.interestMethod,
        ],
        [
          'ค่าดำเนินการเพิ่มเติม (Additional Processing Fee)',
          `${formatTHB(tx.processingFee)} THB`,
          'อัตราดอกเบี้ยต่อปี (Annual Interest Rate)',
          formatPercent(tx.interestRate, 2),
        ],
        [
          'เงินดาวน์ (Down Payment %)',
          formatPercent(tx.downPaymentPercentage, 2),
          'ระยะเวลาการผ่อนชำระ (Installment Period)',
          `${tx.installmentPeriod} เดือน (Months)`,
        ],
        [
          'จำนวนเงินดาวน์ (Down Payment Amount)',
          `${formatTHB(tx.downPaymentAmount)} THB`,
          'ดอกเบี้ยรวม (Total Interest)',
          `${formatTHB(tx.totalInterest)} THB`,
        ],
        [
          'ยอดเงินต้นที่จัดไฟแนนซ์ (Financed Principal)',
          `${formatTHB(tx.financedPrincipal)} THB`,
          'ยอดชำระรวม (Total Repayment)',
          `${formatTHB(tx.totalRepayment)} THB`,
        ],
      ];

      const finRowH = 28;
      for (const [l1, v1, l2, v2] of finPairs) {
        doc.rect(marginL, y, contentWidth, finRowH).fillAndStroke('#ffffff', '#e2e8f0');
        doc
          .moveTo(marginL + halfW, y)
          .lineTo(marginL + halfW, y + finRowH)
          .strokeColor('#e2e8f0')
          .stroke();

        drawMixedText(doc, l1, marginL + 8, y + 4, { fontSize: 7.5, color: '#475569' });
        drawMixedText(doc, v1, marginL + 8, y + 14.5, {
          fontSize: 9,
          bold: true,
          color: '#0f172a',
          width: halfW - 16,
          align: 'right',
        });

        drawMixedText(doc, l2, marginL + halfW + 8, y + 4, { fontSize: 7.5, color: '#475569' });
        drawMixedText(doc, v2, marginL + halfW + 8, y + 14.5, {
          fontSize: 9,
          bold: true,
          color: '#0f172a',
          width: halfW - 16,
          align: 'right',
        });
        y += finRowH;
      }

      y += 12;

      // Section 3: Bilingual Amortization Schedule Table
      const colWidths = [58, 95, 85, 85, 96, 96.28]; // Sum = 515.28
      const headers: Array<{ th: string; en: string }> = [
        { th: 'งวดที่', en: '(Installment No.)' },
        { th: 'เงินต้นคงเหลือก่อนชำระ', en: '(Opening Principal Balance)' },
        { th: 'เงินต้นที่ชำระ', en: '(Principal Payment)' },
        { th: 'ดอกเบี้ยประจำงวด', en: '(Interest Payment)' },
        { th: 'ยอดชำระประจำงวด', en: '(Monthly Installment)' },
        { th: 'เงินต้นคงเหลือหลังชำระ', en: '(Closing Principal Balance)' },
      ];

      const drawScheduleSectionBanner = (topY: number) => {
        doc.rect(marginL, topY, contentWidth, 20).fill('#0f2942');
        drawMixedText(
          doc,
          `ส่วนที่ 3: ตารางการผ่อนชำระ (Amortization Schedule — ${payload.schedule.length} งวด / Installments)`,
          marginL + 8,
          topY + 5,
          { fontSize: 9, bold: true, color: '#ffffff' }
        );
        return topY + 22;
      };

      const drawTableHeader = (topY: number) => {
        const hdrH = 26;
        doc.rect(marginL, topY, contentWidth, hdrH).fillAndStroke('#e2e8f0', '#cbd5e1');
        let colX = marginL;
        for (let i = 0; i < headers.length; i++) {
          const align = i === 0 ? 'center' : 'right';
          drawMixedText(doc, headers[i].th, colX + 3, topY + 3.5, {
            fontSize: 7.5,
            bold: true,
            color: '#0f2942',
            width: colWidths[i] - 6,
            align,
          });
          drawMixedText(doc, headers[i].en, colX + 3, topY + 14.5, {
            fontSize: 6.2,
            bold: false,
            color: '#334155',
            width: colWidths[i] - 6,
            align,
          });
          colX += colWidths[i];
        }
        return topY + hdrH;
      };

      y = drawScheduleSectionBanner(y);
      y = drawTableHeader(y);

      const bottomLimit = pageHeight - 56;
      const rowHeight = 16;

      let totalPrincipalPaid = 0;
      let totalInterestPaid = 0;
      let totalMonthlyPayment = 0;

      for (let idx = 0; idx < payload.schedule.length; idx++) {
        const row = payload.schedule[idx];
        totalPrincipalPaid += row.principalPaid;
        totalInterestPaid += row.interestPaid;
        totalMonthlyPayment += row.monthlyPayment;

        if (y + rowHeight > bottomLimit) {
          doc.addPage();
          drawWatermarkIfDraft();
          drawTopContractBanner(false);
          y = 66;
          y = drawTableHeader(y);
        }

        const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
        doc.rect(marginL, y, contentWidth, rowHeight).fillAndStroke(bgColor, '#e2e8f0');

        const cells = [
          String(row.installmentNo),
          formatTHB(row.beginningPrincipal),
          formatTHB(row.principalPaid),
          formatTHB(row.interestPaid),
          formatTHB(row.monthlyPayment),
          formatTHB(row.endingPrincipal),
        ];

        let colX = marginL;
        for (let c = 0; c < cells.length; c++) {
          drawMixedText(doc, cells[c], colX + 4, y + 3.5, {
            fontSize: 8,
            bold: c === 0 || c === 4,
            color: '#1e293b',
            width: colWidths[c] - 8,
            align: c === 0 ? 'center' : 'right',
          });
          colX += colWidths[c];
        }
        y += rowHeight;
      }

      // Totals Row
      if (y + 20 > bottomLimit) {
        doc.addPage();
        drawWatermarkIfDraft();
        drawTopContractBanner(false);
        y = 66;
      }
      doc.rect(marginL, y, contentWidth, 20).fillAndStroke('#eff6ff', '#1e3a5f');
      let totX = marginL;
      const totalCells = [
        'รวม (Total)',
        '-',
        formatTHB(totalPrincipalPaid),
        formatTHB(totalInterestPaid),
        formatTHB(totalMonthlyPayment),
        '0.00',
      ];
      for (let c = 0; c < totalCells.length; c++) {
        drawMixedText(doc, totalCells[c], totX + 3, y + 5, {
          fontSize: c === 0 ? 7.2 : 8.2,
          bold: true,
          color: '#0f2942',
          width: colWidths[c] - 6,
          align: c === 0 || c === 1 ? 'center' : 'right',
        });
        totX += colWidths[c];
      }
      y += 28;

      // Section 4: Approval and Authorization (Bilingual Signature Block)
      if (y + 145 > pageHeight - 46) {
        doc.addPage();
        drawWatermarkIfDraft();
        drawTopContractBanner(false);
        y = 70;
      }

      doc.rect(marginL, y, contentWidth, 20).fill('#0f2942');
      drawMixedText(
        doc,
        'ส่วนที่ 4: การตรวจสอบและลงนามอนุมัติ (Approval and Authorization)',
        marginL + 8,
        y + 5,
        { fontSize: 9, bold: true, color: '#ffffff' }
      );
      y += 24;

      const sig = payload.signatures || {};
      const sigCols = [
        {
          title: 'ผู้จัดทำรายการ (Prepared By)',
          name: sig.preparedByName || tx.createdBy || '',
          position: sig.preparedByPosition || 'Risk Control Officer',
          date: sig.preparedDate || tx.transactionDate,
        },
        {
          title: 'ผู้ตรวจสอบ (Reviewed By)',
          name: sig.reviewedByName || '',
          position: sig.reviewedByPosition || 'Risk Control Supervisor',
          date: sig.reviewedDate || '',
        },
        {
          title: 'ผู้อนุมัติ (Approved By)',
          name: sig.approvedByName || (tx.transactionStatus === 'Approved' ? tx.approvedBy : ''),
          position: sig.approvedByPosition || 'Risk Management Approver',
          date:
            sig.approvedDate ||
            (tx.transactionStatus === 'Approved' ? tx.lastUpdated.slice(0, 10) : ''),
        },
      ];

      const sigGap = 10;
      const sigW = (contentWidth - sigGap * 2) / 3;
      const sigH = 112;

      for (let i = 0; i < sigCols.length; i++) {
        const sx = marginL + i * (sigW + sigGap);
        const col = sigCols[i];
        doc.roundedRect(sx, y, sigW, sigH, 3).fillAndStroke('#ffffff', '#cbd5e1');
        drawMixedText(doc, col.title, sx + 6, y + 8, {
          fontSize: 8.2,
          bold: true,
          color: '#0f2942',
          width: sigW - 12,
          align: 'center',
        });

        doc
          .moveTo(sx + 18, y + 48)
          .lineTo(sx + sigW - 18, y + 48)
          .lineWidth(0.75)
          .strokeColor('#64748b')
          .stroke();

        drawMixedText(doc, 'ชื่อ-นามสกุล (Full Name):', sx + 8, y + 54, {
          fontSize: 7,
          color: '#64748b',
        });
        drawMixedText(
          doc,
          fitText(doc, col.name || '................................', sigW - 16, 7.8, true),
          sx + 8,
          y + 63,
          { fontSize: 7.8, bold: Boolean(col.name), color: '#0f172a' }
        );

        drawMixedText(doc, 'ตำแหน่ง (Position):', sx + 8, y + 75, {
          fontSize: 7,
          color: '#64748b',
        });
        drawMixedText(
          doc,
          fitText(doc, col.position || '................................', sigW - 16, 7.8, false),
          sx + 8,
          y + 84,
          { fontSize: 7.8, color: '#334155' }
        );

        drawMixedText(
          doc,
          `วันที่ (Date): ${col.date || '......./......./.............'}`,
          sx + 8,
          y + 98,
          { fontSize: 7.5, color: '#334155' }
        );
      }

      // Stamp footer with Page X / Y and RHP Contract ID on EVERY page
      const pageRange = doc.bufferedPageRange();
      for (let p = 0; p < pageRange.count; p++) {
        doc.switchToPage(pageRange.start + p);
        const footerY = pageHeight - 28;
        doc
          .moveTo(marginL, footerY - 5)
          .lineTo(pageWidth - marginR, footerY - 5)
          .lineWidth(0.5)
          .strokeColor('#cbd5e1')
          .stroke();

        drawMixedText(
          doc,
          `เลขที่สัญญา (RHP Contract ID): ${tx.rhpContractId}  |  วันที่สร้างเอกสาร (Generated): ${payload.generatedAt} (Asia/Bangkok)`,
          marginL,
          footerY,
          { fontSize: 7.2, color: '#64748b' }
        );
        drawMixedText(
          doc,
          `หน้า (Page) ${p + 1} / ${pageRange.count}`,
          pageWidth - marginR - 95,
          footerY,
          { fontSize: 7.2, bold: true, color: '#334155', width: 95, align: 'right' }
        );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
