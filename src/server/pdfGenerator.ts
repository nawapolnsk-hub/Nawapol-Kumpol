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
        margins: { top: 40, bottom: 40, left: 40, right: 40 },
        bufferPages: true,
        info: {
          Title: `RHP Calculation Form - ${payload.transaction.rhpContractId}`,
          Author: payload.companyName || 'Risk Control Department',
          Subject: 'แบบสรุปการคำนวณปรับโครงสร้างสัญญาเช่าซื้อ',
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
        doc.font('LatinBold').fontSize(64).fillColor('#b45309');
        doc.text('DRAFT', pageWidth / 2 - 120, pageHeight / 2 - 45, { lineBreak: false });
        doc.font('ThaiBold').fontSize(22).fillColor('#b45309');
        doc.text('ร่างเอกสาร - ยังไม่ได้รับอนุมัติ', pageWidth / 2 - 150, pageHeight / 2 + 25, {
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
              doc.image(logoBuffer, marginL, 38, { fit: [44, 44] });
              headerTextX = marginL + 54;
            } catch {
              headerTextX = marginL;
            }
          }

          drawMixedText(doc, payload.companyName || 'บริษัท ลีสซิ่ง เครื่องจักร จำกัด', headerTextX, 38, {
            fontSize: 13,
            bold: true,
            color: '#0f2942',
          });

          if (payload.companyAddress) {
            drawMixedText(doc, payload.companyAddress, headerTextX, 55, {
              fontSize: 8.5,
              color: '#475569',
            });
          }

          drawMixedText(doc, 'แบบสรุปการคำนวณปรับโครงสร้างสัญญาเช่าซื้อ', headerTextX, 68, {
            fontSize: 11,
            bold: true,
            color: '#1e3a5f',
          });

          // Right metadata box
          const boxW = 195;
          const boxX = pageWidth - marginR - boxW;
          doc
            .roundedRect(boxX, 36, boxW, 52, 4)
            .fillAndStroke(isDraft ? '#fffbeb' : '#ecfdf5', isDraft ? '#f59e0b' : '#10b981');

          drawMixedText(doc, `เลขที่สัญญา: ${tx.rhpContractId}`, boxX + 8, 41, {
            fontSize: 9.5,
            bold: true,
            color: '#0f172a',
          });
          drawMixedText(doc, `วันที่จัดทำ: ${tx.transactionDate}`, boxX + 8, 55, {
            fontSize: 8.5,
            color: '#334155',
          });
          drawMixedText(
            doc,
            isDraft ? 'สถานะ: DRAFT (ยังไม่ได้รับอนุมัติ)' : 'สถานะ: APPROVED (อนุมัติแล้ว)',
            boxX + 8,
            69,
            {
              fontSize: 8.5,
              bold: true,
              color: isDraft ? '#b45309' : '#047857',
            }
          );

          doc
            .moveTo(marginL, 96)
            .lineTo(pageWidth - marginR, 96)
            .lineWidth(1.2)
            .strokeColor('#0f2942')
            .stroke();
        } else {
          // Continuation page header with RHP Contract ID
          doc
            .rect(marginL, 34, contentWidth, 26)
            .fillAndStroke('#f8fafc', '#cbd5e1');
          drawMixedText(
            doc,
            `${payload.companyName || 'RHP Management System'}  |  เลขที่สัญญา: ${tx.rhpContractId}`,
            marginL + 8,
            42,
            { fontSize: 9, bold: true, color: '#0f2942' }
          );
          drawMixedText(
            doc,
            isDraft ? 'สถานะ: DRAFT' : 'สถานะ: APPROVED',
            pageWidth - marginR - 140,
            42,
            {
              fontSize: 8.5,
              bold: true,
              color: isDraft ? '#b45309' : '#047857',
              width: 130,
              align: 'right',
            }
          );
        }
      };

      // Page 1
      drawWatermarkIfDraft();
      drawTopContractBanner(true);

      let y = 106;

      // Section 1: Customer Information
      doc.rect(marginL, y, contentWidth, 20).fill('#0f2942');
      drawMixedText(doc, 'ส่วนที่ 1: ข้อมูลพื้นฐานลูกค้าและสัญญาเดิม (Customer Information)', marginL + 8, y + 5, {
        fontSize: 9.5,
        bold: true,
        color: '#ffffff',
      });
      y += 22;

      const infoRows: Array<[string, string, string, string]> = [
        ['รหัสลูกค้า (Customer ID)', tx.customerId, 'เลขที่สัญญา RHP ใหม่', tx.rhpContractId],
        ['ชื่อผู้เช่าซื้อ (Customer Name)', tx.customerName, 'เลขที่สัญญาเดิม', tx.originalContractNumber],
        ['Serial Number เครื่องจักร', tx.machineSerialNumber, 'วันที่ทำรายการ', tx.transactionDate],
      ];

      for (const [l1, v1, l2, v2] of infoRows) {
        doc.rect(marginL, y, contentWidth, 22).fillAndStroke('#ffffff', '#e2e8f0');
        doc
          .moveTo(marginL + contentWidth / 2, y)
          .lineTo(marginL + contentWidth / 2, y + 22)
          .strokeColor('#e2e8f0')
          .stroke();

        drawMixedText(doc, `${l1}:`, marginL + 6, y + 6, { fontSize: 8.5, bold: true, color: '#475569' });
        drawMixedText(doc, v1, marginL + 118, y + 6, { fontSize: 9, bold: true, color: '#0f172a' });

        drawMixedText(doc, `${l2}:`, marginL + contentWidth / 2 + 6, y + 6, {
          fontSize: 8.5,
          bold: true,
          color: '#475569',
        });
        drawMixedText(doc, v2, marginL + contentWidth / 2 + 106, y + 6, {
          fontSize: 9,
          bold: true,
          color: '#0f172a',
        });
        y += 22;
      }

      y += 10;

      // Section 2: Financial Details (AR & Monthly Installment emphasized)
      doc.rect(marginL, y, contentWidth, 20).fill('#0f2942');
      drawMixedText(doc, 'ส่วนที่ 2: รายละเอียดทางการเงิน (Financial Summary)', marginL + 8, y + 5, {
        fontSize: 9.5,
        bold: true,
        color: '#ffffff',
      });
      y += 24;

      // Highlight Boxes for AR and Monthly Installment
      const cardGap = 12;
      const cardW = (contentWidth - cardGap) / 2;

      doc.roundedRect(marginL, y, cardW, 48, 4).fillAndStroke('#eff6ff', '#1e3a5f');
      drawMixedText(doc, 'ยอด AR รวม (Accounts Receivable)', marginL + 10, y + 7, {
        fontSize: 8.5,
        bold: true,
        color: '#1e3a5f',
      });
      drawMixedText(doc, `${formatTHB(tx.ar)} THB`, marginL + 10, y + 21, {
        fontSize: 15,
        bold: true,
        color: '#0f2942',
      });

      const rightCardX = marginL + cardW + cardGap;
      doc.roundedRect(rightCardX, y, cardW, 48, 4).fillAndStroke('#ecfdf5', '#059669');
      drawMixedText(doc, 'ค่างวดต่อเดือน (Monthly Installment)', rightCardX + 10, y + 7, {
        fontSize: 8.5,
        bold: true,
        color: '#047857',
      });
      drawMixedText(doc, `${formatTHB(tx.monthlyInstallment)} THB`, rightCardX + 10, y + 21, {
        fontSize: 15,
        bold: true,
        color: '#065f46',
      });

      y += 56;

      const finPairs: Array<[string, string, string, string]> = [
        [
          'ราคาต้นทุนเครื่องจักร',
          `${formatTHB(tx.machineCost)} THB`,
          'วิธีคำนวณดอกเบี้ย',
          tx.interestMethod,
        ],
        [
          'ค่าดำเนินการเพิ่มเติม',
          `${formatTHB(tx.processingFee)} THB`,
          'อัตราดอกเบี้ยต่อปี',
          formatPercent(tx.interestRate, 2),
        ],
        [
          'เงินดาวน์ (%)',
          formatPercent(tx.downPaymentPercentage, 2),
          'ระยะเวลาผ่อนชำระ',
          `${tx.installmentPeriod} เดือน`,
        ],
        [
          'จำนวนเงินดาวน์',
          `${formatTHB(tx.downPaymentAmount)} THB`,
          'ดอกเบี้ยรวมตลอดสัญญา',
          `${formatTHB(tx.totalInterest)} THB`,
        ],
        [
          'ยอดเงินต้นที่จัดไฟแนนซ์',
          `${formatTHB(tx.financedPrincipal)} THB`,
          'ยอดชำระรวมทั้งหมด',
          `${formatTHB(tx.totalRepayment)} THB`,
        ],
      ];

      for (const [l1, v1, l2, v2] of finPairs) {
        doc.rect(marginL, y, contentWidth, 20).fillAndStroke('#ffffff', '#e2e8f0');
        doc
          .moveTo(marginL + contentWidth / 2, y)
          .lineTo(marginL + contentWidth / 2, y + 20)
          .strokeColor('#e2e8f0')
          .stroke();

        drawMixedText(doc, l1, marginL + 6, y + 5, { fontSize: 8.5, color: '#475569' });
        drawMixedText(doc, v1, marginL + 115, y + 5, {
          fontSize: 9,
          bold: true,
          color: '#0f172a',
          width: contentWidth / 2 - 122,
          align: 'right',
        });

        drawMixedText(doc, l2, marginL + contentWidth / 2 + 6, y + 5, {
          fontSize: 8.5,
          color: '#475569',
        });
        drawMixedText(doc, v2, marginL + contentWidth / 2 + 115, y + 5, {
          fontSize: 9,
          bold: true,
          color: '#0f172a',
          width: contentWidth / 2 - 122,
          align: 'right',
        });
        y += 20;
      }

      y += 12;

      // Section 3: Amortization Schedule Table
      const colWidths = [42, 95, 90, 90, 98, 100.28]; // Sum = 515.28
      const headers = [
        'งวดที่',
        'เงินต้นก่อนชำระ',
        'เงินต้นที่ชำระ',
        'ดอกเบี้ยประจำงวด',
        'ยอดชำระต่องวด',
        'เงินต้นคงเหลือ',
      ];

      const drawScheduleSectionBanner = (topY: number) => {
        doc.rect(marginL, topY, contentWidth, 20).fill('#0f2942');
        drawMixedText(
          doc,
          `ส่วนที่ 3: ตารางแสดงรายละเอียดการผ่อนชำระ (${payload.schedule.length} งวด)`,
          marginL + 8,
          topY + 5,
          { fontSize: 9.5, bold: true, color: '#ffffff' }
        );
        return topY + 22;
      };

      const drawTableHeader = (topY: number) => {
        doc.rect(marginL, topY, contentWidth, 20).fillAndStroke('#e2e8f0', '#cbd5e1');
        let colX = marginL;
        for (let i = 0; i < headers.length; i++) {
          drawMixedText(doc, headers[i], colX + 4, topY + 5, {
            fontSize: 8,
            bold: true,
            color: '#0f2942',
            width: colWidths[i] - 8,
            align: i === 0 ? 'center' : 'right',
          });
          colX += colWidths[i];
        }
        return topY + 20;
      };

      y = drawScheduleSectionBanner(y);
      y = drawTableHeader(y);

      const bottomLimit = pageHeight - 62;
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
          y = 68;
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
        y = 68;
      }
      doc.rect(marginL, y, contentWidth, 20).fillAndStroke('#eff6ff', '#1e3a5f');
      let totX = marginL;
      const totalCells = [
        'รวม',
        '-',
        formatTHB(totalPrincipalPaid),
        formatTHB(totalInterestPaid),
        formatTHB(totalMonthlyPayment),
        '0.00',
      ];
      for (let c = 0; c < totalCells.length; c++) {
        drawMixedText(doc, totalCells[c], totX + 4, y + 5, {
          fontSize: 8.5,
          bold: true,
          color: '#0f2942',
          width: colWidths[c] - 8,
          align: c === 0 || c === 1 ? 'center' : 'right',
        });
        totX += colWidths[c];
      }
      y += 28;

      // Section 4: Signature Block (keep together on page)
      if (y + 135 > pageHeight - 48) {
        doc.addPage();
        drawWatermarkIfDraft();
        drawTopContractBanner(false);
        y = 74;
      }

      doc.rect(marginL, y, contentWidth, 20).fill('#0f2942');
      drawMixedText(doc, 'ส่วนที่ 4: การตรวจสอบและลงนามอนุมัติ (Authorization & Signatures)', marginL + 8, y + 5, {
        fontSize: 9.5,
        bold: true,
        color: '#ffffff',
      });
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
          date: sig.approvedDate || (tx.transactionStatus === 'Approved' ? tx.lastUpdated.slice(0, 10) : ''),
        },
      ];

      const sigGap = 10;
      const sigW = (contentWidth - sigGap * 2) / 3;
      const sigH = 100;

      for (let i = 0; i < sigCols.length; i++) {
        const sx = marginL + i * (sigW + sigGap);
        const col = sigCols[i];
        doc.roundedRect(sx, y, sigW, sigH, 3).fillAndStroke('#ffffff', '#cbd5e1');
        drawMixedText(doc, col.title, sx + 6, y + 8, {
          fontSize: 8.5,
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

        drawMixedText(
          doc,
          `ชื่อ-นามสกุล: ${col.name || '................................'}`,
          sx + 8,
          y + 56,
          { fontSize: 8, color: '#334155' }
        );
        drawMixedText(
          doc,
          `ตำแหน่ง: ${col.position || '................................'}`,
          sx + 8,
          y + 70,
          { fontSize: 8, color: '#334155' }
        );
        drawMixedText(
          doc,
          `วันที่: ${col.date || '......./......./.............'}`,
          sx + 8,
          y + 84,
          { fontSize: 8, color: '#334155' }
        );
      }

      // Stamp footer with Page X / Y and RHP Contract ID on EVERY page
      const pageRange = doc.bufferedPageRange();
      for (let p = 0; p < pageRange.count; p++) {
        doc.switchToPage(pageRange.start + p);
        const footerY = pageHeight - 30;
        doc
          .moveTo(marginL, footerY - 5)
          .lineTo(pageWidth - marginR, footerY - 5)
          .lineWidth(0.5)
          .strokeColor('#cbd5e1')
          .stroke();

        drawMixedText(
          doc,
          `เลขที่สัญญา: ${tx.rhpContractId}  |  สร้างเอกสารเมื่อ: ${payload.generatedAt} (Asia/Bangkok)`,
          marginL,
          footerY,
          { fontSize: 7.5, color: '#64748b' }
        );
        drawMixedText(
          doc,
          `หน้า ${p + 1} / ${pageRange.count}`,
          pageWidth - marginR - 80,
          footerY,
          { fontSize: 7.5, bold: true, color: '#334155', width: 80, align: 'right' }
        );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
