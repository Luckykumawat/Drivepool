import JSZip from 'jszip';
import { renderAsync } from 'docx-preview';
import { init } from 'pptx-preview';
import * as XLSX from 'xlsx';

const content = document.getElementById('office-content');
const status = document.getElementById('office-status');

async function checkArchive(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return;
  const archive = await JSZip.loadAsync(buffer);
  const entries = Object.values(archive.files);
  const expanded = entries.reduce((sum, file) => sum + (file._data?.uncompressedSize || 0), 0);
  if (entries.length > 10000 || expanded > 150 * 1024 * 1024) {
    throw new Error('This document is too complex for browser preview.');
  }
}

function showWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'array', sheetRows: 1001, cellHTML: false });
  const tabs = document.createElement('nav');
  tabs.className = 'sheet-tabs';
  tabs.setAttribute('aria-label', 'Workbook sheets');
  const tableWrap = document.createElement('div');
  tableWrap.className = 'sheet-table';
  const note = document.createElement('p');
  note.className = 'preview-note';
  note.textContent = 'Read-only preview · Up to 1,000 rows and 100 columns per sheet. Charts and macros are not rendered.';
  function selectSheet(name) {
    for (const button of tabs.children) button.setAttribute('aria-pressed', String(button.textContent === name));
    const sheet = workbook.Sheets[name];
    const table = document.createElement('table');
    if (sheet['!ref']) {
      const range = XLSX.utils.decode_range(sheet['!ref']);
      range.e.r = Math.min(range.e.r, range.s.r + 999);
      range.e.c = Math.min(range.e.c, range.s.c + 99);
      const head = table.createTHead().insertRow();
      const corner = document.createElement('th');
      corner.textContent = '#';
      head.append(corner);
      for (let col = range.s.c; col <= range.e.c; col++) {
        const label = document.createElement('th');
        label.textContent = XLSX.utils.encode_col(col);
        head.append(label);
      }
      const body = table.createTBody();
      for (let row = range.s.r; row <= range.e.r; row++) {
        const tr = body.insertRow();
        const label = document.createElement('th');
        label.textContent = String(row + 1);
        tr.append(label);
        for (let col = range.s.c; col <= range.e.c; col++) {
          const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
          tr.insertCell().textContent = cell ? XLSX.utils.format_cell(cell) : '';
        }
      }
    }
    tableWrap.replaceChildren(table);
  }
  for (const name of workbook.SheetNames.slice(0, 100)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.onclick = () => selectSheet(name);
    tabs.append(button);
  }
  content.replaceChildren(tabs, note, tableWrap);
  if (workbook.SheetNames.length) selectSheet(workbook.SheetNames[0]);
}

let started = false;
window.addEventListener('message', async event => {
  if (event.source !== parent || event.data?.type !== 'drivepool-office' || started) return;
  if (!(event.data.buffer instanceof ArrayBuffer)) return;
  started = true;
  try {
    const { buffer, format } = event.data;
    if (buffer.byteLength > 20 * 1024 * 1024) throw new Error('Office preview supports files up to 20 MB.');
    await checkArchive(buffer);
    if (format === 'docx') {
      await renderAsync(buffer, content, undefined, {
        useBase64URL: true, ignoreFonts: true, renderAltChunks: false,
        ignoreWidth: true, breakPages: true
      });
      status.textContent = 'Read-only Word preview · Complex formatting may differ.';
    } else if (['xlsx', 'xls', 'xlsm', 'ods'].includes(format)) {
      showWorkbook(buffer);
      status.textContent = '';
    } else if (format === 'pptx') {
      const width = Math.max(280, Math.min(960, window.innerWidth - 32));
      const viewer = init(content, { width, height: width * 9 / 16, mode: 'list' });
      await viewer.preview(buffer);
      status.textContent = 'Read-only slides · Animations, fonts and complex layouts may differ.';
    } else {
      throw new Error('Unsupported Office format.');
    }
    // Prevent document hyperlinks from navigating the preview.
    content.addEventListener('click', event => {
      if (event.target.closest('a')) event.preventDefault();
    });
  } catch (error) {
    content.replaceChildren();
    status.textContent = 'Could not preview this document. ' + error.message;
  }
});
