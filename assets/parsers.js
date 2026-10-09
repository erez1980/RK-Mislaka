/* ==========================================================================
   Mislaka (Israeli pension clearing house) file parsers.
   Pure data functions: no DOM rendering, no network.
   Exposes a single global: Mislaka
   ========================================================================== */
(function (global) {
  'use strict';

  // ---------- Product type catalogue ----------
  const TYPES = {
    pension:    { label: 'קרן פנסיה',    color: 'var(--t-pension)',    hex: '#7CC4FF' },
    hishtalmut: { label: 'קרן השתלמות',  color: 'var(--t-hishtalmut)', hex: '#F2C46D' },
    gemel:      { label: 'קופת גמל',      color: 'var(--t-gemel)',      hex: '#B5E07A' },
    life:       { label: 'ביטוח חיים וחיסכון', color: 'var(--t-life)',  hex: '#4FD1C5' },
    risk:       { label: 'ריסק וכיסויים', color: 'var(--t-risk)',       hex: '#B9A3FF' },
    other:      { label: 'אחר',           color: 'var(--t-other)',      hex: '#8FA3A8' }
  };

  function detectType(...parts) {
    const h = parts.filter(Boolean).join(' ');
    if (/השתלמ/.test(h)) return 'hishtalmut';
    if (/פנסי|מקיפה|כללית/.test(h)) return 'pension';
    if (/גמל|להשקעה|לחיסכון/.test(h)) return 'gemel';
    if (/ריסק|סיכון|אכ"ע|אובדן כושר|משכנתא/.test(h)) return 'risk';
    if (/ביטוח|מנהלים|חיים|משולב|פוליסה|פוליסת/.test(h)) return 'life';
    return 'other';
  }

  // ---------- Generic helpers ----------
  function n0(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const s = String(v).replace(/[₪,\s%]/g, '').replace(/[‎‏]/g, '');
    // Handle trailing minus (e.g. "123.4-") which appears in some Israeli reports
    const m = s.match(/^(-?)([\d.]+)(-?)$/);
    if (!m) { const f = parseFloat(s); return isFinite(f) ? f : 0; }
    const num = parseFloat(m[2]);
    return (m[1] || m[3]) ? -num : num;
  }

  function normPolicy(p) {
    return String(p || '').replace(/\D/g, '').replace(/^0+/, '');
  }

  function samePolicy(a, b) {
    const x = normPolicy(a), y = normPolicy(b);
    if (!x || !y) return false;
    if (x === y) return true;
    // Some sources prefix branch codes; accept suffix match for long numbers
    if (Math.min(x.length, y.length) >= 6) return x.endsWith(y) || y.endsWith(x);
    return false;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  // Returns { text: 'DD/MM/YYYY' | 'MM/YYYY', key: 'YYYY-MM-DD' | 'YYYY-MM' } or null
  function parseDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v)) {
      const y = v.getFullYear(), m = v.getMonth() + 1, d = v.getDate();
      return { text: `${pad(d)}/${pad(m)}/${y}`, key: `${y}-${pad(m)}-${pad(d)}`, month: `${y}-${pad(m)}` };
    }
    const s = String(v).trim();
    let m;
    if (/^\d{5}$/.test(s)) { // Excel serial
      const d = new Date(Math.round((+s - 25569) * 86400000));
      return parseDate(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})/))) return { text: `${m[3]}/${m[2]}/${m[1]}`, key: `${m[1]}-${m[2]}-${m[3]}`, month: `${m[1]}-${m[2]}` };
    if ((m = s.match(/^(\d{4})(\d{2})$/))) return { text: `${m[2]}/${m[1]}`, key: `${m[1]}-${m[2]}`, month: `${m[1]}-${m[2]}` };
    if ((m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/))) {
      const y = m[3].length === 2 ? '20' + m[3] : m[3];
      return { text: `${pad(m[1])}/${pad(m[2])}/${y}`, key: `${y}-${pad(m[2])}-${pad(m[1])}`, month: `${y}-${pad(m[2])}` };
    }
    if ((m = s.match(/^(\d{1,2})[./-](\d{4})$/))) return { text: `${pad(m[1])}/${m[2]}`, key: `${m[2]}-${pad(m[1])}`, month: `${m[2]}-${pad(m[1])}` };
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return { text: `${m[3]}/${m[2]}/${m[1]}`, key: `${m[1]}-${m[2]}-${m[3]}`, month: `${m[1]}-${m[2]}` };
    return { text: s, key: s, month: '' };
  }

  function dateText(v) { const d = parseDate(v); return d ? d.text : ''; }

  // Report date encoded in Mislaka file names, e.g. 12345678_202604051417.xls
  function dateFromFilename(name) {
    const m = String(name || '').match(/_(20\d{2})(\d{2})(\d{2})\d{0,6}\.[a-z]+$/i);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  }

  function newDataset() {
    return {
      products: [], deposits: [], insurance: [], beneficiaries: [],
      person: { id: '', name: '', reportDate: '', employers: [] },
      files: [], log: [], fileKeys: []
    };
  }

  function newProduct(partial) {
    return Object.assign({
      uid: 'p' + Math.random().toString(36).slice(2, 9),
      name: '', company: '', policy: '', statusRaw: '', status: 'on', type: 'other',
      savings: 0, expected: 0, monthly: 0,
      ytd: null, ret12: null, ret36: null, ret60: null,
      feeD: 0, feeA: 0, joinDate: '', track: '', employer: '',
      depEmp: 0, depEr: 0, depComp: 0,
      sources: [], raw: { xls: {}, xml: {} }
    }, partial);
  }

  function statusFrom(text) {
    const s = String(text || '').trim();
    if (!s) return 'on';
    if (/לא\s*פעיל|לא-פעיל|מוקפא|מסולק|סגור|inactive/i.test(s)) return 'off';
    if (/^לא/.test(s)) return 'off';
    return 'on';
  }

  // Merge a parsed product into the dataset (dedupe by policy number)
  function upsertProduct(ds, p, source) {
    const existing = p.policy ? ds.products.find(x => samePolicy(x.policy, p.policy) && (x.company === p.company || !x.company || !p.company || x.company.slice(0, 4) === p.company.slice(0, 4))) : null;
    if (!existing) {
      p.sources = [source];
      ds.products.push(p);
      return { product: p, merged: false };
    }
    const fromXlsWins = source === 'Excel';
    const fields = ['name', 'company', 'statusRaw', 'status', 'type', 'savings', 'expected', 'monthly', 'ytd', 'ret12', 'ret36', 'ret60', 'feeD', 'feeA', 'joinDate', 'track', 'employer'];
    for (const f of fields) {
      const incoming = p[f];
      const empty = v => v == null || v === '' || v === 0 || v === 'other';
      if (empty(incoming)) continue;
      if (fromXlsWins || empty(existing[f])) existing[f] = incoming;
    }
    Object.assign(existing.raw.xls, p.raw.xls);
    Object.assign(existing.raw.xml, p.raw.xml);
    if (!existing.sources.includes(source)) existing.sources.push(source);
    return { product: existing, merged: true };
  }

  // ======================================================================
  //  Excel workbook (main source)
  //  Sheets: "פרטי המוצרים שלי", "מעקב הפקדות", "כיסויים ביטוחיים"
  // ======================================================================

  function sheetCells(sheet) {
    // Returns rows of { v, w } so we can read percent-formatted cells correctly
    const ref = sheet['!ref'];
    if (!ref) return [];
    const range = XLSX.utils.decode_range(ref);
    const rows = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        row.push(cell ? { v: cell.v, w: cell.w != null ? String(cell.w) : (cell.v != null ? String(cell.v) : '') } : { v: '', w: '' });
      }
      rows.push(row);
    }
    return rows;
  }

  function isEmptyRow(row) { return !row || row.every(c => c.v === '' || c.v == null); }

  function findHeaderRow(rows, keywords) {
    let best = -1, bestScore = 0;
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const s = rows[i].map(c => c.w).join('|');
      let score = 0;
      for (const k of keywords) if (s.includes(k)) score++;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return bestScore >= 2 ? best : -1;
  }

  function headerMap(row) {
    const map = [];
    row.forEach((c, i) => { const h = String(c.w || c.v || '').replace(/\s+/g, ' ').trim(); if (h) map.push({ h, i }); });
    return map;
  }

  // Exact header match first; otherwise the shortest header that contains the key
  function col(row, map, ...keys) {
    for (const key of keys) {
      const exact = map.find(m => m.h === key);
      if (exact && row[exact.i] && row[exact.i].v !== '' && row[exact.i].v != null) return row[exact.i];
    }
    for (const key of keys) {
      const cands = map.filter(m => m.h.includes(key)).sort((a, b) => a.h.length - b.h.length);
      for (const c of cands) if (row[c.i] && row[c.i].v !== '' && row[c.i].v != null) return row[c.i];
    }
    return { v: '', w: '' };
  }

  // Read a percentage cell whether it is stored as 0.35 (percent-formatted fraction) or as 0.35 meaning 0.35%
  function pct(cell) {
    if (!cell || cell.v === '' || cell.v == null) return null;
    if (/%/.test(cell.w)) return n0(cell.w);
    return n0(cell.v);
  }

  function rawRow(row, map) {
    const out = {};
    for (const { h, i } of map) {
      const c = row[i];
      if (!c || c.v === '' || c.v == null) continue;
      out[h] = c.v instanceof Date ? dateText(c.v) : c.w || String(c.v);
    }
    return out;
  }

  function findSheet(wb, names, idx) {
    for (const n of names) {
      const hit = wb.SheetNames.find(s => s.trim() === n || s.includes(n));
      if (hit) return { name: hit, sheet: wb.Sheets[hit] };
    }
    if (idx != null && wb.SheetNames[idx]) return { name: wb.SheetNames[idx], sheet: wb.Sheets[wb.SheetNames[idx]] };
    return null;
  }

  function parseWorkbook(buf, filename, ds, log) {
    const wb = XLSX.read(buf, { type: 'array', cellDates: true, codepage: 1255 });
    log(`גיליונות: ${wb.SheetNames.join(', ')}`);
    const summary = { products: 0, deposits: 0, insurance: 0 };

    const rd = dateFromFilename(filename);
    if (rd && !ds.person.reportDate) ds.person.reportDate = rd;

    const prod = findSheet(wb, ['פרטי המוצרים שלי', 'פרטי המוצרים', 'מוצרים', 'Products'], 0);
    if (prod) summary.products = parseProductsSheet(prod.sheet, ds, log);

    const dep = findSheet(wb, ['מעקב הפקדות', 'הפקדות', 'Deposits'], null);
    if (dep) summary.deposits = parseDepositsSheet(dep.sheet, ds, log);

    const ins = findSheet(wb, ['כיסויים ביטוחיים', 'ביטוחים', 'כיסויים', 'Insurance'], null);
    if (ins) summary.insurance = parseInsuranceSheet(ins.sheet, ds, log);

    // Any extra sheets are kept for transparency in the files view
    const known = [prod, dep, ins].filter(Boolean).map(x => x.name);
    const extra = wb.SheetNames.filter(n => !known.includes(n));
    if (extra.length) log(`גיליונות נוספים שלא נקראו: ${extra.join(', ')}`, 'warn');
    return summary;
  }

  function parseProductsSheet(sheet, ds, log) {
    const rows = sheetCells(sheet);
    const h = findHeaderRow(rows, ['שם מוצר', 'סטטוס', 'חיסכון', 'חברה', 'תשואה', 'פוליסה', 'דמי ניהול']);
    if (h < 0) { log('לא נמצאה שורת כותרות בגיליון המוצרים', 'warn'); return 0; }
    const map = headerMap(rows[h]);
    let count = 0;
    for (let i = h + 1; i < rows.length; i++) {
      const row = rows[i];
      if (isEmptyRow(row)) continue;
      const name = String(col(row, map, 'שם מוצר', 'שם התוכנית', 'שם תוכנית', 'מוצר').v || '').trim();
      const company = String(col(row, map, 'שם חברה מנהלת', 'חברה מנהלת', 'שם החברה', 'חברה').v || '').trim();
      const policy = String(col(row, map, 'מספר פוליסה', 'מספר חשבון', 'פוליסה', 'חשבון').v || '').trim();
      const typeRaw = String(col(row, map, 'סוג מוצר', 'סוג').v || '').trim();
      // Skip total / footer rows
      if (!name && !company && !policy) continue;
      if (/^סה"?כ|^סך הכל$/.test(name)) continue;
      const statusRaw = String(col(row, map, 'סטטוס').v || '').trim();

      const p = newProduct({
        name: name || typeRaw || 'מוצר',
        company, policy, statusRaw,
        status: statusFrom(statusRaw),
        type: detectType(typeRaw, name, company),
        savings: n0(col(row, map, 'סך הכל חיסכון', 'סה"כ חיסכון', 'יתרה', 'חיסכון').v),
        expected: n0(col(row, map, 'חיסכון צפוי לגיל פרישה', 'חיסכון צפוי').v),
        monthly: n0(col(row, map, 'קיצבה חודשית לגיל פרישה', 'קצבה חודשית לגיל פרישה', 'קצבה חודשית צפויה', 'קיצבה חודשית', 'קצבה חודשית').v),
        ytd: pct(col(row, map, 'תשואה מתחילת השנה', 'תשואה מתחילת שנה', 'תשואה')),
        feeD: pct(col(row, map, 'שיעור דמי ניהול מהפקדות', 'דמי ניהול מהפקדות', 'דמי ניהול מהפקדה', 'דמי ניהול הפקדה')) || 0,
        feeA: pct(col(row, map, 'שיעור דמי ניהול שנתי מחיסכון', 'דמי ניהול שנתי מחיסכון', 'דמי ניהול מחיסכון', 'דמי ניהול מצבירה', 'דמי ניהול שנתי', 'דמי ניהול צבור')) || 0,
        joinDate: dateText(col(row, map, 'תאריך הצטרפות לראשונה', 'תאריך הצטרפות', 'תאריך פתיחת תוכנית', 'תאריך פתיחה').v),
        track: String(col(row, map, 'מסלול השקעה', 'שם מסלול', 'מסלול').v || '').trim(),
        employer: String(col(row, map, 'שם מעסיק', 'מעסיק').v || '').trim()
      });
      p.raw.xls = rawRow(row, map);
      upsertProduct(ds, p, 'Excel');
      count++;
    }
    log(`${count} מוצרים מגיליון המוצרים`, 'ok');
    return count;
  }

  function parseDepositsSheet(sheet, ds, log) {
    const rows = sheetCells(sheet);
    const h = findHeaderRow(rows, ['חודש שכר', 'הפקדות עובד', 'הפקדות מעסיק', 'תאריך ערך', 'פיצויים']);
    if (h < 0) { log('לא נמצאה שורת כותרות בגיליון ההפקדות', 'warn'); return 0; }
    const map = headerMap(rows[h]);
    let count = 0;
    for (let i = h + 1; i < rows.length; i++) {
      const row = rows[i];
      if (isEmptyRow(row)) continue;
      const monthCell = col(row, map, 'חודש שכר', 'חודש משכורת', 'חודש');
      const md = parseDate(monthCell.v instanceof Date ? monthCell.v : (monthCell.w || monthCell.v));
      const valDate = dateText(col(row, map, 'תאריך ערך', 'תאריך הפקדה', 'תאריך').v);
      const product = String(col(row, map, 'סוג מוצר', 'שם מוצר', 'מוצר').v || '').trim();
      const company = String(col(row, map, 'שם חברה מנהלת', 'חברה מנהלת', 'חברה').v || '').trim();
      const employer = String(col(row, map, 'שם מעסיק', 'מעסיק').v || '').trim();
      const policy = String(col(row, map, 'מספר פוליסה', 'מספר חשבון', 'פוליסה').v || '').trim();
      const emp = n0(col(row, map, 'הפקדות עובד', 'תגמולי עובד', 'עובד').v);
      const er = n0(col(row, map, 'הפקדות מעסיק', 'תגמולי מעסיק').v);
      const comp = n0(col(row, map, 'הפקדות מעסיק לפיצויים', 'פיצויים').v);
      if (emp === 0 && er === 0 && comp === 0) continue;
      if (/סה"?כ/.test(String(monthCell.w || ''))) continue;
      ds.deposits.push({
        month: md ? md.text : '', monthKey: md ? md.month : '',
        valDate, product, company, employer, policy, emp, er, comp
      });
      if (employer && !ds.person.employers.includes(employer)) ds.person.employers.push(employer);
      count++;
    }
    log(`${count} שורות הפקדה`, 'ok');
    return count;
  }

  function parseInsuranceSheet(sheet, ds, log) {
    const rows = sheetCells(sheet);
    const h = findHeaderRow(rows, ['סוג הכיסוי', 'שם התוכנית', 'סכום', 'קצבה', 'מקבל', 'חברה']);
    if (h < 0) { log('לא נמצאה שורת כותרות בגיליון הכיסויים', 'warn'); return 0; }
    const map = headerMap(rows[h]);
    let count = 0;
    for (let i = h + 1; i < rows.length; i++) {
      const row = rows[i];
      if (isEmptyRow(row)) continue;
      const coverType = String(col(row, map, 'סוג הכיסוי הביטוחי', 'סוג הכיסוי', 'סוג כיסוי', 'סוג').v || '').trim();
      const planName = String(col(row, map, 'שם התוכנית', 'שם תוכנית', 'תוכנית').v || '').trim();
      if (!coverType && !planName) continue;
      ds.insurance.push({
        coverType, planName,
        company: String(col(row, map, 'שם חברה מנהלת', 'שם חברה', 'חברה').v || '').trim(),
        recipient: String(col(row, map, 'מקבל התשלום', 'מקבל').v || '').trim(),
        lumpSum: n0(col(row, map, 'סכום חד פעמי', 'סכום ביטוח', 'סכום').v),
        monthly: n0(col(row, map, 'קצבה חודשית', 'קצבה').v),
        source: 'Excel',
        raw: rawRow(row, map)
      });
      count++;
    }
    log(`${count} כיסויים ביטוחיים`, 'ok');
    return count;
  }

  // ======================================================================
  //  XML files (one per managing company, Capital Market Authority format)
  // ======================================================================

  // Friendly Hebrew labels for common tags shown in the details drawer
  const TAG_LABELS = {
    'SHEM-YATZRAN': 'חברה מנהלת', 'SHEM-TOCHNIT': 'שם התוכנית', 'MISPAR-POLISA-O-HESHBON': 'מספר פוליסה או חשבון',
    'STATUS-POLISA-O-CHESHBON': 'סטטוס', 'TAARICH-HITZTARFUT-MUTZAR': 'תאריך הצטרפות', 'TAARICH-NECHONUT': 'נכון לתאריך',
    'SHEM-MAASIK': 'מעסיק', 'TOTAL-CHISACHON-MTZBR': 'סך חיסכון מצטבר', 'SHEM-MASLUL-HASHKAA': 'מסלול השקעה',
    'SCHUM-BITUAH-LEMAVET': 'סכום ביטוח למוות', 'KITZBA-ZMUDA-LAMADAD': 'קצבה צמודה למדד', 'SHEM-KISUI-YATZRAN': 'שם הכיסוי',
    'MISPAR-ZIHUY-LAKOACH': 'מספר זיהוי', 'SUG-MUTZAR': 'סוג מוצר (קוד)', 'KOD-MASLUL-HASHKAA': 'קוד מסלול'
  };

  function decodeXml(bytes) {
    if (typeof bytes === 'string') return bytes;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8);
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8);
    const head = new TextDecoder('ascii').decode(u8.slice(0, 200));
    const m = head.match(/encoding=["']([^"']+)["']/i);
    let label = m ? m[1].toLowerCase() : 'utf-8';
    if (label === 'iso-8859-8' || label === 'iso-8859-8-i') label = 'iso-8859-8';
    try { return new TextDecoder(label).decode(u8); } catch (e) { return new TextDecoder('utf-8').decode(u8); }
  }

  function byName(el, name) { return el.getElementsByTagNameNS('*', name); }

  function leafText(el, names) {
    for (const n of names) {
      const list = byName(el, n);
      for (const node of list) {
        if (node.children.length === 0 && node.textContent.trim()) return node.textContent.trim();
      }
    }
    return '';
  }

  // All leaf elements of a subtree as [localName, value] in document order
  function leaves(el) {
    const out = [];
    const walk = (node) => {
      for (const ch of node.children) {
        if (ch.children.length === 0) {
          const t = ch.textContent.trim();
          if (t !== '') out.push([ch.localName, t]);
        } else walk(ch);
      }
    };
    walk(el);
    return out;
  }

  function firstLeafMatching(pairs, test) {
    const hit = pairs.find(([k]) => test(k));
    return hit ? hit[1] : '';
  }

  function parseXml(bytes, filename, ds, log) {
    const text = decodeXml(bytes);
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) { log(`XML לא תקין: ${filename}`, 'err'); return { products: 0, insurance: 0, beneficiaries: 0 }; }
    const root = doc.documentElement;
    const summary = { products: 0, insurance: 0, beneficiaries: 0, enriched: 0 };

    const company = leafText(root, ['SHEM-YATZRAN', 'SHEM-SHOLEACH', 'SHEM-CHEVRA-MENAHELET']);
    const reportDate = leafText(root, ['TAARICH-NECHONUT', 'TAARICH-BITZUA', 'TAARICH-HAFAKAT-HADOCH']);
    if (reportDate && !ds.person.reportDate) ds.person.reportDate = dateText(reportDate);
    const custId = leafText(root, ['MISPAR-ZIHUY-LAKOACH', 'MISPAR-ZIHUY']);
    if (custId && !ds.person.id) ds.person.id = custId;
    if (!ds.person.name) {
      const custNode = ['YeshutLakoach', 'PirteiLakoach', 'Lakoach', 'PirteiMevutach'].map(n => byName(root, n)[0]).find(Boolean);
      if (custNode) {
        const nm = [leafText(custNode, ['SHEM-PRATI']), leafText(custNode, ['SHEM-MISHPACHA'])].filter(Boolean).join(' ');
        if (nm) ds.person.name = nm;
      }
    }
    const docEmployer = leafText(root, ['SHEM-MAASIK']);
    if (docEmployer && !ds.person.employers.includes(docEmployer)) ds.person.employers.push(docEmployer);

    // ---- Accounts / policies ----
    let accounts = Array.from(byName(root, 'HeshbonOPolisa'));
    if (!accounts.length) {
      for (const n of ['Polisa', 'Heshbon', 'Mutzar', 'HESHBON-O-POLISA', 'PRAT-MUTZAR']) {
        accounts = Array.from(byName(root, n));
        if (accounts.length) break;
      }
    }
    const hasExcel = ds.products.some(p => p.sources.includes('Excel'));

    for (const acc of accounts) {
      const pairs = leaves(acc);
      const policy = leafText(acc, ['MISPAR-POLISA-O-HESHBON', 'MISPAR-POLISA', 'MISPAR-HESHBON', 'MISPAR-CHESHBON']);
      if (!policy && !pairs.length) continue;
      const mutzar = acc.closest ? acc.closest('Mutzar') : null;
      const typeCode = mutzar ? leafText(mutzar, ['SUG-MUTZAR']) : leafText(acc, ['SUG-MUTZAR']);
      const plan = leafText(acc, ['SHEM-TOCHNIT', 'SHEM-MUTZAR']);
      const num = test => { const v = firstLeafMatching(pairs, test); return v === '' ? null : n0(v); };

      const p = newProduct({
        name: plan || (TYPES[detectType(plan, company)] || TYPES.other).label,
        company, policy,
        statusRaw: leafText(acc, ['STATUS-POLISA-O-CHESHBON', 'STATUS-POLISA', 'STATUS']),
        type: detectType(plan, company),
        savings: num(k => /TOTAL-CHISACHON-MTZBR|TOTAL-CHISACHON-MITZTABER|YITRAT-CHISACHON|SCHUM-TZVIRA/.test(k)) || 0,
        expected: num(k => /TZFUY/.test(k) && /CHISACHON|HON|TZVIRA/.test(k)) || 0,
        monthly: num(k => /TZFUY/.test(k) && /KITZBA|KIZBA/.test(k)) || 0,
        ytd: num(k => /TSUA/.test(k) && /MITCHILAT|SHNATIT|YTD/.test(k)),
        ret12: num(k => /TSUA/.test(k) && /12/.test(k)),
        ret36: num(k => /TSUA/.test(k) && /36/.test(k)),
        ret60: num(k => /TSUA/.test(k) && /60/.test(k)),
        feeD: num(k => /DMEI-NIHUL/.test(k) && /HAFKADA/.test(k)) || 0,
        feeA: num(k => /DMEI-NIHUL/.test(k) && /TZVIRA|CHISACHON|MTZBR|NECHASIM|HISACHON|YITRA/.test(k)) || 0,
        joinDate: dateText(leafText(acc, ['TAARICH-HITZTARFUT-MUTZAR', 'TAARICH-HITZTARFUT-RISHON', 'TAARICH-HITZTARFUT'])),
        track: leafText(acc, ['SHEM-MASLUL-HASHKAA', 'SHEM-MASLUL']),
        employer: leafText(acc, ['SHEM-MAASIK'])
      });
      p.status = /^(2|לא)/.test(p.statusRaw) ? 'off' : 'on';
      if (typeCode) p.raw.xml['SUG-MUTZAR'] = typeCode;
      for (const [k, v] of pairs) {
        // Keep the first value per tag; skip zero-only noise
        if (p.raw.xml[k] == null && v !== '0' && v !== '0.00') p.raw.xml[k] = v;
      }

      const match = ds.products.find(x => samePolicy(x.policy, policy));
      if (match) {
        upsertProduct(ds, Object.assign(p, { policy: match.policy }), 'XML');
        summary.enriched++;
      } else if (hasExcel) {
        // Excel is authoritative for totals; unmatched XML accounts are listed only in the log to avoid double counting
        log(`חשבון ${policy || '(ללא מספר)'} מ-${company || filename} לא נמצא בקובץ ה-Excel ולכן לא נוסף לסכומים`, 'warn');
      } else {
        upsertProduct(ds, p, 'XML');
        summary.products++;
      }
    }

    // ---- Insurance coverages ----
    for (const k of Array.from(byName(root, 'ZihuiKisui'))) {
      const planName = leafText(k, ['SHEM-KISUI-YATZRAN', 'SHEM-KISUI']);
      const lumpSum = n0(leafText(k, ['SCHUM-BITUAH-LEMAVET', 'SCHUM-BITUACH']));
      const monthly = n0(leafText(k, ['KITZBA-ZMUDA-LAMADAD', 'SCHUM-KITZBA']));
      if (!planName && !lumpSum && !monthly) continue;
      const dup = ds.insurance.some(r => r.planName === planName && r.company === company && r.lumpSum === lumpSum);
      if (dup) continue;
      ds.insurance.push({ coverType: lumpSum ? 'כיסוי למקרה מוות' : 'כיסוי ביטוחי', planName: planName || 'כיסוי', company, recipient: '', lumpSum, monthly, source: 'XML', raw: Object.fromEntries(leaves(k)) });
      summary.insurance++;
    }

    // ---- Beneficiaries ----
    for (const name of ['Mutav', 'PirteiMutav', 'MUTAV']) {
      for (const b of Array.from(byName(root, name))) {
        const pairs = leaves(b);
        const first = firstLeafMatching(pairs, k => /SHEM-PRATI/.test(k));
        const last = firstLeafMatching(pairs, k => /SHEM-MISHPACHA/.test(k));
        if (!first && !last) continue;
        const acc = b.closest ? b.closest('HeshbonOPolisa') : null;
        const pol = acc ? leafText(acc, ['MISPAR-POLISA-O-HESHBON']) : '';
        ds.beneficiaries.push({
          name: [first, last].filter(Boolean).join(' '),
          relation: firstLeafMatching(pairs, k => /KIRVA/.test(k)),
          percent: n0(firstLeafMatching(pairs, k => /ACHUZ/.test(k))),
          product: [company, pol].filter(Boolean).join(' ')
        });
        summary.beneficiaries++;
      }
      if (summary.beneficiaries) break;
    }

    const parts = [];
    if (summary.enriched) parts.push(`${summary.enriched} מוצרים הועשרו`);
    if (summary.products) parts.push(`${summary.products} מוצרים`);
    if (summary.insurance) parts.push(`${summary.insurance} כיסויים`);
    if (summary.beneficiaries) parts.push(`${summary.beneficiaries} מוטבים`);
    log(`${company || filename}: ${parts.join(', ') || 'לא נמצאו נתונים מוכרים'}`, parts.length ? 'ok' : 'warn');
    return summary;
  }

  // ======================================================================
  //  Post-processing
  // ======================================================================
  function finalize(ds) {
    for (const p of ds.products) { p.depEmp = 0; p.depEr = 0; p.depComp = 0; }
    for (const d of ds.deposits) {
      let prod = d.policy ? ds.products.find(p => samePolicy(p.policy, d.policy)) : null;
      if (!prod && d.company) {
        const cands = ds.products.filter(p => p.company && (p.company.includes(d.company.slice(0, 6)) || d.company.includes(p.company.slice(0, 6))));
        const typed = cands.filter(p => p.type === detectType(d.product));
        prod = typed.length === 1 ? typed[0] : (cands.length === 1 ? cands[0] : null);
      }
      d.productUid = prod ? prod.uid : null;
      if (prod) { prod.depEmp += d.emp; prod.depEr += d.er; prod.depComp += d.comp; }
    }
    return ds;
  }

  global.Mislaka = {
    TYPES, TAG_LABELS, detectType, n0, normPolicy, samePolicy, parseDate, dateText,
    newDataset, parseWorkbook, parseXml, finalize, decodeXml
  };
})(window);
