// Converts a model- or person-authored artifact's markdown into a real .docx file by walking
// marked's token tree into docx.js elements — shared by both apps' export endpoints.
const { marked } = require('marked');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, BorderStyle, ExternalHyperlink, ShadingType,
} = require('docx');

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
];

// Walks marked's inline token array (text/strong/em/codespan/link/del) into docx runs.
function inlineToRuns(tokens, baseOpts = {}) {
  const runs = [];
  for (const t of tokens || []) {
    if (t.type === 'text' || t.type === 'escape') {
      runs.push(new TextRun({ text: t.text, ...baseOpts }));
    } else if (t.type === 'strong') {
      runs.push(...inlineToRuns(t.tokens, { ...baseOpts, bold: true }));
    } else if (t.type === 'em') {
      runs.push(...inlineToRuns(t.tokens, { ...baseOpts, italics: true }));
    } else if (t.type === 'del') {
      runs.push(...inlineToRuns(t.tokens, { ...baseOpts, strike: true }));
    } else if (t.type === 'codespan') {
      runs.push(new TextRun({ text: t.text, font: 'Courier New', ...baseOpts }));
    } else if (t.type === 'link') {
      runs.push(new ExternalHyperlink({
        link: t.href,
        children: [new TextRun({ text: t.text, style: 'Hyperlink', ...baseOpts })],
      }));
    } else if (t.type === 'br') {
      runs.push(new TextRun({ text: '', break: 1 }));
    } else if (t.tokens) {
      runs.push(...inlineToRuns(t.tokens, baseOpts));
    } else if (t.text) {
      runs.push(new TextRun({ text: t.text, ...baseOpts }));
    }
  }
  return runs;
}

function listItemsToParagraphs(items, ordered, depth) {
  const out = [];
  let n = 1;
  for (const item of items) {
    const itemTokens = item.tokens.filter(t => t.type !== 'list');
    const runs = [];
    if (item.task) {
      runs.push(new TextRun({ text: item.checked ? '☑ ' : '☐ ' }));
    } else {
      runs.push(new TextRun({ text: ordered ? `${n}. ` : '• ' }));
    }
    for (const tk of itemTokens) {
      if (tk.type === 'text' && tk.tokens) runs.push(...inlineToRuns(tk.tokens));
      else if (tk.type === 'text') runs.push(new TextRun({ text: tk.text }));
    }
    out.push(new Paragraph({ children: runs, indent: { left: 360 + depth * 360 }, spacing: { after: 80 } }));
    const nested = item.tokens.find(t => t.type === 'list');
    if (nested) out.push(...listItemsToParagraphs(nested.items, nested.ordered, depth + 1));
    n++;
  }
  return out;
}

const cellBorder = { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC' };
const cellBorders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

function tableToDocx(token) {
  const colCount = token.header.length;
  const colWidth = Math.floor(9360 / colCount);
  const headerRow = new TableRow({
    children: token.header.map(cell => new TableCell({
      width: { size: colWidth, type: WidthType.DXA },
      borders: cellBorders,
      shading: { fill: 'F0F0F0', type: ShadingType.CLEAR },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ children: inlineToRuns(cell.tokens, { bold: true }) })],
    })),
  });
  const bodyRows = token.rows.map(row => new TableRow({
    children: row.map(cell => new TableCell({
      width: { size: colWidth, type: WidthType.DXA },
      borders: cellBorders,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ children: inlineToRuns(cell.tokens) })],
    })),
  }));
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: Array(colCount).fill(colWidth),
    rows: [headerRow, ...bodyRows],
  });
}

function tokensToElements(tokens) {
  const els = [];
  for (const t of tokens) {
    if (t.type === 'heading') {
      els.push(new Paragraph({
        heading: HEADING_LEVELS[Math.min(t.depth, 6) - 1],
        children: inlineToRuns(t.tokens),
        spacing: { before: 240, after: 120 },
      }));
    } else if (t.type === 'paragraph') {
      els.push(new Paragraph({ children: inlineToRuns(t.tokens), spacing: { after: 160 } }));
    } else if (t.type === 'list') {
      els.push(...listItemsToParagraphs(t.items, t.ordered, 0));
    } else if (t.type === 'table') {
      els.push(tableToDocx(t));
      els.push(new Paragraph({ text: '', spacing: { after: 120 } }));
    } else if (t.type === 'blockquote') {
      const inner = tokensToElements(t.tokens);
      for (const p of inner) {
        if (p instanceof Paragraph) els.push(p);
      }
    } else if (t.type === 'hr') {
      els.push(new Paragraph({
        text: '',
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 4 } },
        spacing: { after: 200 },
      }));
    } else if (t.type === 'code') {
      els.push(new Paragraph({
        children: [new TextRun({ text: t.text, font: 'Courier New', size: 20 })],
        spacing: { after: 160 },
      }));
    } else if (t.type === 'space') {
      // skip
    } else if (t.tokens) {
      els.push(...tokensToElements(t.tokens));
    }
  }
  return els;
}

async function markdownToDocxBuffer(title, markdown) {
  const tokens = marked.lexer(markdown || '');
  const body = tokensToElements(tokens);
  const doc = new Document({
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } } },
    },
    sections: [{
      properties: {
        page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
      },
      children: [
        new Paragraph({ text: title || '', heading: HeadingLevel.TITLE, spacing: { after: 240 } }),
        ...body,
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { markdownToDocxBuffer };
