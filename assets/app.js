/* ==========================================================================
   Pension dashboard - UI controller
   All state lives in memory only. Nothing is persisted or transmitted.
   ========================================================================== */
(function () {
  'use strict';

  const M = window.Mislaka;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

  // Fee thresholds used for ratings and insights (percent)
  const FEE = { aHigh: 0.7, aMid: 0.4, dHigh: 3, dMid: 1.5 };

  const state = {
    profiles: [],        // [{ id, name, ds, autoNamed }]
    currentId: null,
    view: 'overview',
    filters: { type: 'all', status: 'all', q: '' },
    depositFilter: 'all',
    lastPassword: null,  // kept in memory only, to open several ZIPs from the same person
    busy: false
  };
  const charts = {};

  // ---------- Formatting ----------
  const nf0 = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });
  const money = v => (v < 0 ? '-' : '') + '₪' + nf0.format(Math.abs(Math.round(v || 0)));
  const moneyOrDash = v => (v ? money(v) : '—');
  const pctTxt = (v, d = 2) => (v == null || v === '' || isNaN(v)) ? '—' : String(parseFloat((+v).toFixed(d))) + '%';
  const compact = v => {
    const a = Math.abs(v);
    if (a >= 1e6) return '₪' + (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e3) return '₪' + Math.round(v / 1e3) + 'K';
    return '₪' + Math.round(v);
  };
  const signClass = v => (v == null ? '' : v < 0 ? 'neg' : v > 0 ? 'pos' : '');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const typeOf = t => M.TYPES[t] || M.TYPES.other;
  const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);

  // ---------- Profiles ----------
  function current() { return state.profiles.find(p => p.id === state.currentId) || null; }
  function ds() { const p = current(); return p ? p.ds : null; }
  function hasData(d) { return d && (d.products.length || d.deposits.length || d.insurance.length); }

  function createProfile(name, autoNamed) {
    const p = { id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, ds: M.newDataset(), autoNamed: !!autoNamed };
    state.profiles.push(p);
    state.currentId = p.id;
    return p;
  }

  function renderProfiles() {
    const box = $('#profiles');
    box.innerHTML = state.profiles.map(p =>
      `<button class="chip" type="button" data-pid="${p.id}" aria-pressed="${p.id === state.currentId}">${esc(p.name)}</button>`
    ).join('') + `<button class="chip add" type="button" id="addProfile">פרופיל חדש</button>`;
  }

  // ---------- Screens ----------
  function showScreen() {
    const d = ds();
    const dash = hasData(d);
    $('#screenUpload').hidden = dash;
    $('#screenDash').hidden = !dash;
    $('#barAdd').hidden = !dash;
    const prof = current();
    $('#uploadLede').textContent = prof && !dash && state.profiles.length > 1
      ? `טוענים את קבצי המסלקה של ${prof.name}. כל פרופיל מחזיק רק את הקבצים שלו.`
      : 'טוענים את הקובץ מהמסלקה הפנסיונית ומקבלים תמונה מלאה: כמה נחסך, כמה צפוי בפרישה, מי הפקיד, אילו ביטוחים קיימים וכמה עולים דמי הניהול.';
    if (dash) renderDashboard();
  }

  function setView(v) {
    state.view = v;
    $$('.nav-btn').forEach(b => { if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    $$('.view').forEach(s => s.classList.toggle('is-active', s.id === 'view-' + v));
    renderChartsFor(v);
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  // ======================================================================
  //  File intake
  // ======================================================================
  function logTo(d, msg, kind) {
    d.log.push({ msg, kind: kind || '' });
    const el = $('#log');
    if (!$('#screenUpload').hidden) {
      const line = document.createElement('div');
      line.className = kind || '';
      line.textContent = msg;
      el.appendChild(line);
      el.scrollTop = el.scrollHeight;
    }
  }

  function setProgress(p) { $('#progressFill').style.width = Math.max(0, Math.min(100, p)) + '%'; }

  const extOf = n => (String(n).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length || state.busy) return;
    state.busy = true;
    if (!current()) createProfile('פרופיל 1', true);
    renderProfiles();
    const d = ds();
    const onUpload = !$('#screenUpload').hidden;
    if (onUpload) { $('#progress').hidden = false; $('#log').innerHTML = ''; setProgress(5); }

    const items = []; // { name, ext, bytes, from }
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const key = f.name + ':' + f.size;
        if (d.fileKeys.includes(key)) { logTo(d, `${f.name} כבר נטען לפרופיל הזה, דילגתי עליו`, 'warn'); continue; }
        d.fileKeys.push(key);
        const ext = extOf(f.name);
        if (ext === 'zip') {
          logTo(d, `פותח ${f.name}`);
          const got = await readZip(f, f.name, d, 0);
          if (got === null) { d.fileKeys.pop(); continue; }
          items.push(...got);
        } else if (['xls', 'xlsx', 'xml'].includes(ext)) {
          items.push({ name: f.name, ext, bytes: new Uint8Array(await f.arrayBuffer()), from: '' });
        } else {
          d.files.push({ name: f.name, kind: ext.toUpperCase() || 'קובץ', result: 'לא נדרש לדשבורד' });
          logTo(d, `${f.name}: סוג קובץ שלא נקרא (צריך ZIP, Excel או XML)`, 'warn');
        }
        if (onUpload) setProgress(10 + (i + 1) / files.length * 40);
      }

      // Excel first (main source), XML second (enrichment)
      const order = { xls: 0, xlsx: 0, xml: 1 };
      items.sort((a, b) => order[a.ext] - order[b.ext]);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const label = it.from ? `${it.name} (מתוך ${it.from})` : it.name;
        try {
          if (it.ext === 'xml') {
            logTo(d, `קורא XML: ${label}`);
            const r = M.parseXml(it.bytes, it.name, d, (m, k) => logTo(d, '  ' + m, k));
            d.files.push({ name: it.name, from: it.from, kind: 'XML', result: describe(r) });
          } else {
            logTo(d, `קורא Excel: ${label}`);
            const r = M.parseWorkbook(it.bytes, it.name, d, (m, k) => logTo(d, '  ' + m, k));
            d.files.push({ name: it.name, from: it.from, kind: 'Excel', result: describe(r) });
          }
        } catch (err) {
          console.error(err);
          d.files.push({ name: it.name, from: it.from, kind: it.ext.toUpperCase(), result: 'שגיאה בקריאה' });
          logTo(d, `  שגיאה ב-${it.name}: ${err.message}`, 'err');
        }
        if (onUpload) setProgress(50 + (i + 1) / items.length * 45);
      }

      M.finalize(d);
      autoNameProfile();
      const p = d.products.length, dp = d.deposits.length, ins = d.insurance.length;
      if (hasData(d)) {
        logTo(d, `סיום: ${p} מוצרים, ${dp} הפקדות, ${ins} כיסויים`, 'ok');
        if (!d.products.some(x => x.sources.includes('Excel')) && d.products.length) {
          logTo(d, 'לא נמצא קובץ Excel. בלעדיו חסרים בדרך כלל קצבה צפויה, הפקדות וכיסויים. כדאי להעלות את ה-ZIP המלא.', 'warn');
        }
        if (onUpload) { setProgress(100); await wait(450); }
        renderProfiles();
        showScreen();
        if (!onUpload) toast(`נטענו הקבצים: ${p} מוצרים, ${dp} הפקדות, ${ins} כיסויים`);
      } else if (items.length) {
        logTo(d, 'לא נמצאו נתונים בקבצים. ודאו שזה הקובץ מהמסלקה הפנסיונית.', 'err');
        if (!onUpload) toast('לא נמצאו נתונים בקבצים שנבחרו', true);
      }
    } finally {
      state.busy = false;
      $('#fileInput').value = '';
      $('#fileInput2').value = '';
    }
  }

  function describe(r) {
    const parts = [];
    if (r.products) parts.push(`${r.products} מוצרים`);
    if (r.enriched) parts.push(`${r.enriched} מוצרים הועשרו`);
    if (r.deposits) parts.push(`${r.deposits} הפקדות`);
    if (r.insurance) parts.push(`${r.insurance} כיסויים`);
    if (r.beneficiaries) parts.push(`${r.beneficiaries} מוטבים`);
    return parts.join(', ') || 'לא נמצאו נתונים מוכרים';
  }

  function autoNameProfile() {
    const p = current();
    if (!p || !p.autoNamed) return;
    const nm = p.ds.person.name;
    if (nm) { p.name = nm.split(' ')[0]; p.autoNamed = false; }
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));

  // ---------- ZIP (including AES / ZipCrypto password protection) ----------
  async function readZip(blob, name, d, depth) {
    const reader = new zip.ZipReader(new zip.BlobReader(blob));
    let entries;
    try { entries = await reader.getEntries(); }
    catch (e) { logTo(d, `${name} לא נפתח כקובץ ZIP תקין`, 'err'); return []; }

    const files = entries.filter(e => !e.directory);
    const locked = files.filter(e => e.encrypted);
    let password;

    if (locked.length) {
      const probe = locked.slice().sort((a, b) => a.uncompressedSize - b.uncompressedSize)[0];
      const tryPw = async pw => { try { await probe.getData(new zip.Uint8ArrayWriter(), { password: pw }); return true; } catch (e) { return false; } };
      if (state.lastPassword && await tryPw(state.lastPassword)) password = state.lastPassword;
      let attempt = 0, error = '';
      while (password === undefined) {
        const pw = await askPassword(name, error);
        if (pw === null) { logTo(d, `ביטלתם את פתיחת ${name}`, 'warn'); await reader.close(); return null; }
        if (await tryPw(pw)) { password = pw; state.lastPassword = pw; break; }
        attempt++;
        error = attempt >= 3 ? 'הסיסמה לא מתאימה. בדקו את ההודעה מהמסלקה, שימו לב לאותיות גדולות וקטנות.' : 'הסיסמה לא מתאימה לקובץ. נסו שוב.';
      }
      logTo(d, 'הקובץ נפתח', 'ok');
    }

    const out = [];
    for (const e of files) {
      const base = e.filename.split('/').pop();
      const ext = extOf(base);
      if (base.startsWith('.') || e.filename.startsWith('__MACOSX')) continue;
      if (['xls', 'xlsx', 'xml', 'zip'].includes(ext)) {
        const bytes = await e.getData(new zip.Uint8ArrayWriter(), password ? { password } : undefined);
        if (ext === 'zip' && depth < 2) {
          const inner = await readZip(new Blob([bytes]), base, d, depth + 1);
          if (inner) out.push(...inner);
        } else if (ext !== 'zip') {
          out.push({ name: base, ext, bytes, from: name });
        }
      } else {
        d.files.push({ name: base, from: name, kind: ext.toUpperCase() || 'קובץ', result: 'לא נדרש לדשבורד' });
      }
    }
    await reader.close();
    logTo(d, `נמצאו ${out.length} קבצים לקריאה ב-${name}`);
    return out;
  }

  function askPassword(name, error) {
    return new Promise(resolve => {
      const dlg = $('#pwModal');
      $('#pwText').textContent = `${name} נעול. הזינו את הסיסמה שקיבלתם מהמסלקה יחד עם הקובץ.`;
      $('#pwError').textContent = error || '';
      $('#pwInput').value = '';
      const onClose = () => {
        dlg.removeEventListener('close', onClose);
        const v = $('#pwInput').value;
        $('#pwInput').value = '';
        resolve(dlg.returnValue === 'ok' && v ? v : null);
      };
      dlg.addEventListener('close', onClose);
      dlg.returnValue = '';
      dlg.showModal();
      $('#pwInput').focus();
    });
  }

  // ======================================================================
  //  Derived numbers
  // ======================================================================
  function metrics(d) {
    const P = d.products;
    const total = sum(P, p => p.savings);
    const expected = sum(P, p => p.expected);
    const monthly = sum(P, p => p.monthly);
    const active = P.filter(p => p.status === 'on');
    const inactiveCash = P.filter(p => p.status === 'off' && p.savings > 0);
    const depTotal = sum(d.deposits, r => r.emp + r.er + r.comp);
    const months = new Set(d.deposits.map(r => r.monthKey).filter(Boolean));
    const nMonths = months.size || 0;
    const feeFromSavings = sum(P, p => p.savings * p.feeA / 100);
    const feeFromDeposits = nMonths ? sum(P, p => (p.depEmp + p.depEr + p.depComp) / nMonths * 12 * p.feeD / 100) : 0;
    const withYtd = P.filter(p => p.ytd != null && p.savings > 0);
    const ytdW = sum(withYtd, p => p.savings) ? sum(withYtd, p => p.ytd * p.savings) / sum(withYtd, p => p.savings) : null;
    const withFeeA = P.filter(p => p.feeA > 0 && p.savings > 0);
    const feeAW = sum(withFeeA, p => p.savings) ? sum(withFeeA, p => p.feeA * p.savings) / sum(withFeeA, p => p.savings) : null;
    const companies = [...new Set(P.map(p => p.company).filter(Boolean))];
    return { total, expected, monthly, active, inactiveCash, depTotal, nMonths, feeFromSavings, feeFromDeposits, feeCost: feeFromSavings + feeFromDeposits, ytdW, feeAW, companies };
  }

  function feeRating(p) {
    if (p.feeA >= FEE.aHigh || p.feeD >= FEE.dHigh) return { cls: 'high', text: 'גבוה' };
    if (p.feeA >= FEE.aMid || p.feeD >= FEE.dMid) return { cls: 'mid', text: 'בינוני' };
    if (p.feeA > 0 || p.feeD > 0) return { cls: 'ok', text: 'טוב' };
    return null;
  }

  // ======================================================================
  //  Insights
  // ======================================================================
  function buildInsights(d) {
    const out = [];
    const m = metrics(d);
    const P = d.products;

    P.filter(p => p.feeD >= FEE.dHigh || p.feeA >= FEE.aHigh).sort((a, b) => b.savings - a.savings).forEach(p => {
      const cost = p.savings * p.feeA / 100;
      const parts = [];
      if (p.feeD) parts.push(`${pctTxt(p.feeD)} מכל הפקדה`);
      if (p.feeA) parts.push(`${pctTxt(p.feeA)} מהצבירה בשנה`);
      out.push({ level: 'urgent', tag: 'דחוף', title: `דמי ניהול גבוהים ב${p.name}`,
        body: `${p.company || 'החברה'} גובה ${parts.join(' ו-')}${cost ? `, בערך ${money(cost)} בשנה מהצבירה בלבד` : ''}. אפשר לבקש מהחברה הנחה או להעביר את הכסף לגוף זול יותר.` });
    });

    P.filter(p => p.ytd != null && p.ytd < 0 && p.savings > 0).forEach(p => {
      out.push({ level: 'action', tag: 'לבדיקה', title: `תשואה שלילית ב${p.name}`,
        body: `${pctTxt(p.ytd)} מתחילת השנה. תקופה קצרה לא מעידה הרבה, אבל כדאי להשוות את המסלול${p.track ? ` (${p.track})` : ''} למסלולים דומים בגופים אחרים.` });
    });

    if (m.inactiveCash.length) {
      const amt = sum(m.inactiveCash, p => p.savings);
      out.push({ level: 'action', tag: 'מומלץ', title: `${m.inactiveCash.length} קופות לא פעילות עם ${money(amt)}`,
        body: 'בקופה שלא מפקידים אליה דמי הניהול לרוב גבוהים יותר. איחוד לקופה פעילה מפשט את הניהול ולעיתים חוסך כסף.' });
    }

    const groups = {};
    P.forEach(p => { const k = p.company + '|' + p.type; (groups[k] = groups[k] || []).push(p); });
    Object.values(groups).filter(g => g.length >= 2 && g[0].company).forEach(g => {
      out.push({ level: 'check', tag: 'לשקול', title: `${g.length} חשבונות ${typeOf(g[0].type).label} ב${g[0].company}`,
        body: 'כמה חשבונות מאותו סוג באותו גוף. כדאי לבדוק אם אפשר למזג אותם לחשבון אחד.' });
    });

    if (m.companies.length >= 2 && m.total > 0) {
      const byC = {};
      P.forEach(p => { byC[p.company] = (byC[p.company] || 0) + p.savings; });
      const [topC, topV] = Object.entries(byC).sort((a, b) => b[1] - a[1])[0];
      if (topV / m.total > 0.65) out.push({ level: 'check', tag: 'לידיעה', title: `${Math.round(topV / m.total * 100)}% מהחיסכון אצל ${topC}`,
        body: 'ריכוז גבוה אצל גוף אחד. זה לא בהכרח רע, אבל שווה לוודא שזו בחירה ולא ברירת מחדל.' });
    }

    const keys = [...new Set(d.deposits.map(r => r.monthKey).filter(Boolean))].sort();
    if (keys.length >= 3) {
      const all = monthRange(keys[0], keys[keys.length - 1]);
      const gaps = all.filter(k => !keys.includes(k));
      if (gaps.length) out.push({ level: 'check', tag: 'לבדיקה', title: gaps.length === 1 ? 'חודש אחד בלי אף הפקדה' : `${gaps.length} חודשים בלי אף הפקדה`,
        body: `${gaps.slice(0, 5).map(monthLabel).join(', ')}${gaps.length > 5 ? ' ועוד' : ''}. ${gaps.length === 1 ? 'אם עבדתם בחודש הזה' : 'אם עבדתם בחודשים האלה'}, כדאי לברר עם המעסיק.` });
    }

    const activePension = P.filter(p => p.type === 'pension' && p.status === 'on');
    if (d.deposits.length && activePension.length) {
      activePension.filter(p => p.depEmp + p.depEr + p.depComp === 0).forEach(p => {
        out.push({ level: 'check', tag: 'לבדיקה', title: `לא נמצאו הפקדות ל${p.name}`,
          body: 'המוצר מסומן כפעיל אבל אין לו הפקדות בתקופת הדוח. ייתכן שהוא הפך ללא פעיל, וכדאי לבדוק את הכיסוי הביטוחי שלו.' });
      });
    }

    if (P.length && !d.insurance.length) {
      out.push({ level: 'check', tag: 'לבדיקה', title: 'לא נמצאו כיסויים ביטוחיים בקבצים',
        body: 'לרוב הכיסויים מופיעים בגיליון "כיסויים ביטוחיים" בקובץ ה-Excel. אם העליתם רק XML, נסו להעלות את ה-ZIP המלא.' });
    }

    if (m.feeAW != null && m.feeAW < FEE.aMid && !out.some(o => o.level === 'urgent')) {
      out.push({ level: 'good', tag: 'תקין', title: 'דמי הניהול מהצבירה נמוכים', body: `ממוצע משוקלל של ${pctTxt(m.feeAW)} בשנה.` });
    }
    if (!out.length) out.push({ level: 'good', tag: 'תקין', title: 'לא נמצא משהו חריג', body: 'לפי הנתונים בקבצים, אין ממצאים שדורשים טיפול.' });
    const rank = { urgent: 0, action: 1, check: 2, good: 3 };
    return out.sort((a, b) => rank[a.level] - rank[b.level]);
  }

  function insightHtml(i) {
    return `<div class="insight ${i.level}"><span class="insight-mark" aria-hidden="true"></span>
      <div class="insight-title">${esc(i.title)}<small>${esc(i.tag)}</small></div>
      <div class="insight-body">${esc(i.body)}</div></div>`;
  }

  // ---------- Months ----------
  function monthRange(a, b) {
    const out = [];
    let [y, m] = a.split('-').map(Number);
    const [yb, mb] = b.split('-').map(Number);
    while (y < yb || (y === yb && m <= mb)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } if (out.length > 600) break; }
    return out;
  }
  const monthLabel = k => { const [y, m] = k.split('-'); return `${m}/${y}`; };

  // ======================================================================
  //  Rendering
  // ======================================================================
  function renderDashboard() {
    const d = ds();
    const m = metrics(d);
    const prof = current();

    $('#whoName').textContent = d.person.name || prof.name;
    $('#whoMeta').textContent = [d.person.id ? `ת"ז ${d.person.id}` : '', d.person.reportDate ? `נכון ל-${d.person.reportDate}` : ''].filter(Boolean).join(', ');
    $('#cntProducts').textContent = d.products.length || '';
    $('#cntDeposits').textContent = d.deposits.length || '';
    $('#cntInsurance').textContent = d.insurance.length || '';
    const ins = buildInsights(d);
    const important = ins.filter(i => i.level !== 'good').length;
    $('#cntInsights').textContent = important || '';

    renderOverview(d, m, ins);
    renderProducts(d);
    renderDeposits(d, m);
    renderInsurance(d);
    renderFees(d, m);
    $('#insightsAll').innerHTML = ins.map(insightHtml).join('');
    prefillSim(d, m);
    renderAiSummary();
    renderFiles(d);
    renderChartsFor(state.view);
  }

  function ledger(el, cells) {
    el.style.setProperty('--n', cells.length);
    el.innerHTML = cells.map(c => `<div><div class="l-label">${esc(c.label)}</div><div class="l-value ${c.cls || ''}">${c.value}</div>${c.note ? `<div class="l-note">${esc(c.note)}</div>` : ''}</div>`).join('');
  }

  function bars(el, rows, total) {
    if (!rows.length) { el.innerHTML = '<div class="cell-sub">אין נתונים להצגה</div>'; return; }
    const max = Math.max(...rows.map(r => r.value), 1);
    el.innerHTML = rows.map(r => {
      const share = total ? Math.round(r.value / total * 100) : null;
      return `<div class="bar-row">
        <div class="bar-name"><span class="swatch" style="background:${r.color}"></span><span>${esc(r.label)}</span></div>
        <div class="bar-amt"><bdi>${r.text || money(r.value)}</bdi>${share != null ? `<span class="bar-pct">${share}%</span>` : ''}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(r.value / max * 100).toFixed(1)}%;background:${r.color}"></div></div>
      </div>`;
    }).join('');
  }

  // ---------- Overview ----------
  function renderOverview(d, m, ins) {
    const P = d.products;
    $('#overviewSub').textContent = `${P.length} מוצרים ב-${m.companies.length} גופים מנהלים${d.person.reportDate ? `, נכון ל-${d.person.reportDate}` : ''}`;

    $('#hToday').textContent = money(m.total);
    $('#hTodayNote').textContent = `${m.active.length} מוצרים פעילים מתוך ${P.length}`;
    $('#hExpected').textContent = moneyOrDash(m.expected);
    $('#hExpectedNote').textContent = m.expected ? 'לפי התחזיות של החברות המנהלות' : 'התחזית לא מופיעה בקבצים שנטענו';
    $('#hMonthly').textContent = moneyOrDash(m.monthly);
    $('#hMonthlyNote').textContent = m.monthly ? 'סכום התחזיות של כל המוצרים, לפני מס' : 'התחזית לא מופיעה בקבצים שנטענו';

    // One orchestrated moment: draw the line from today to retirement
    const path = $('#bridgePath');
    if (path && path.getTotalLength && path.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const len = Math.ceil(path.getTotalLength());
      path.style.strokeDasharray = len;
      path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 1400, delay: 150, easing: 'cubic-bezier(.6,0,.2,1)', fill: 'both' });
    }

    ledger($('#ledger'), [
      { label: 'מוצרים פעילים', value: `${m.active.length}/${P.length}`, note: m.inactiveCash.length ? `${m.inactiveCash.length} לא פעילים עם כסף` : 'כל הכסף בקופות פעילות' },
      { label: 'בקופות לא פעילות', value: moneyOrDash(sum(m.inactiveCash, p => p.savings)), note: m.inactiveCash.length ? 'כדאי לבדוק איחוד' : '' },
      { label: 'הופקד בתקופת הדוח', value: moneyOrDash(m.depTotal), note: m.nMonths ? `ב-${m.nMonths} חודשי שכר` : 'אין גיליון הפקדות' },
      { label: 'דמי ניהול בשנה', value: m.feeCost ? money(m.feeCost) : '—', note: 'הערכה לפי הנתונים בקבצים', cls: m.feeCost ? 'warn' : '' },
      { label: 'תשואה מתחילת השנה', value: pctTxt(m.ytdW), note: 'ממוצע משוקלל לפי חיסכון', cls: signClass(m.ytdW) }
    ]);

    const byType = {};
    P.forEach(p => { byType[p.type] = (byType[p.type] || 0) + p.savings; });
    bars($('#barsType'), Object.entries(byType).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
      .map(([t, v]) => ({ label: typeOf(t).label, value: v, color: typeOf(t).color })), m.total);

    const byCo = {};
    P.forEach(p => { if (p.company) byCo[p.company] = (byCo[p.company] || 0) + p.savings; });
    bars($('#barsCompany'), Object.entries(byCo).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([c, v]) => ({ label: c, value: v, color: 'var(--dim)' })), m.total);

    $('#insightsTop').innerHTML = ins.slice(0, 3).map(insightHtml).join('') +
      `<div style="padding-top:14px;display:flex;gap:8px;flex-wrap:wrap">${ins.length > 3 ? `<button class="btn" type="button" data-goto="advisor">לכל ${ins.length} הממצאים</button>` : ''}<button class="btn" type="button" data-goto="advisor" data-scroll="aiPanel">ניתוח מעמיק עם AI</button></div>`;
  }

  // ---------- Products ----------
  function filteredProducts(d) {
    const { type, status, q } = state.filters;
    const qq = q.trim();
    return d.products.filter(p =>
      (type === 'all' || p.type === type) &&
      (status === 'all' || p.status === status) &&
      (!qq || [p.name, p.company, p.policy, p.track].join(' ').includes(qq))
    ).sort((a, b) => b.savings - a.savings);
  }

  function renderProducts(d) {
    const present = [...new Set(d.products.map(p => p.type))];
    if (state.filters.type !== 'all' && !present.includes(state.filters.type)) state.filters.type = 'all';
    $('#typeFilter').innerHTML = `<button aria-pressed="${state.filters.type === 'all'}" data-v="all">הכל</button>` +
      Object.keys(M.TYPES).filter(t => present.includes(t)).map(t =>
        `<button class="type-chip" aria-pressed="${state.filters.type === t}" data-v="${t}"><span class="swatch" style="background:${typeOf(t).color}"></span>${esc(typeOf(t).label)}</button>`
      ).join('');
    $$('#statusFilter button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === state.filters.status));

    const list = filteredProducts(d);
    const tot = sum(list, p => p.savings), exp = sum(list, p => p.expected), mon = sum(list, p => p.monthly);
    const cos = [...new Set(list.map(p => p.company).filter(Boolean))];
    $('#typeSummary').innerHTML = `
      <span>מוצרים<b>${list.length}</b></span>
      <span>חיסכון<b>${money(tot)}</b></span>
      ${exp ? `<span>צפוי לפרישה<b>${money(exp)}</b></span>` : ''}
      ${mon ? `<span>קצבה חודשית<b>${money(mon)}</b></span>` : ''}
      ${cos.length ? `<span>גופים<b>${esc(cos.slice(0, 4).join(', '))}${cos.length > 4 ? ' ועוד' : ''}</b></span>` : ''}`;

    $('#productsBody').innerHTML = list.length ? list.map(p => `
      <tr class="clickable" tabindex="0" data-uid="${p.uid}">
        <td><div class="bar-name"><span class="swatch" style="background:${typeOf(p.type).color}"></span><span class="cell-main">${esc(p.name)}</span></div><div class="cell-sub">${esc(p.company)}</div></td>
        <td><span class="policy">${esc(p.policy || '—')}</span></td>
        <td><span class="status ${p.status === 'on' ? 'on' : ''}">${p.status === 'on' ? 'פעיל' : 'לא פעיל'}</span></td>
        <td class="num">${money(p.savings)}</td>
        <td class="num">${moneyOrDash(p.expected)}</td>
        <td class="num">${moneyOrDash(p.monthly)}</td>
        <td class="num ${signClass(p.ytd)}">${pctTxt(p.ytd)}</td>
        <td class="num ${p.feeD >= FEE.dHigh ? 'neg' : ''}">${p.feeD ? pctTxt(p.feeD) : '—'}</td>
        <td class="num ${p.feeA >= FEE.aHigh ? 'neg' : ''}">${p.feeA ? pctTxt(p.feeA) : '—'}</td>
      </tr>`).join('') + `
      <tr class="tfoot"><td colspan="3">סה"כ</td><td class="num">${money(tot)}</td><td class="num">${moneyOrDash(exp)}</td><td class="num">${moneyOrDash(mon)}</td><td colspan="3"></td></tr>`
      : `<tr class="empty-row"><td colspan="9">אין מוצרים שמתאימים לסינון</td></tr>`;
  }

  // ---------- Drawer ----------
  function openDrawer(uid) {
    const d = ds();
    const p = d.products.find(x => x.uid === uid);
    if (!p) return;
    $('#drawerTitle').textContent = p.name;
    $('#drawerSub').textContent = [p.company, p.policy ? `פוליסה ${p.policy}` : ''].filter(Boolean).join(', ');
    const dep = p.depEmp + p.depEr + p.depComp;
    const kv = [
      ['סוג', typeOf(p.type).label], ['סטטוס', (p.status === 'on' ? 'פעיל' : 'לא פעיל') + (p.statusRaw && !/^\d+$/.test(p.statusRaw) ? '' : '')],
      ['חיסכון היום', money(p.savings)], ['צפוי לפרישה', p.expected ? money(p.expected) : null],
      ['קצבה חודשית צפויה', p.monthly ? money(p.monthly) : null], ['תשואה מתחילת השנה', p.ytd != null ? pctTxt(p.ytd) : null],
      ['תשואה 12 חודשים', p.ret12 != null ? pctTxt(p.ret12) : null], ['תשואה 36 חודשים', p.ret36 != null ? pctTxt(p.ret36) : null],
      ['תשואה 60 חודשים', p.ret60 != null ? pctTxt(p.ret60) : null], ['דמי ניהול מהפקדה', p.feeD ? pctTxt(p.feeD) : null],
      ['דמי ניהול מהצבירה', p.feeA ? pctTxt(p.feeA) : null], ['עלות שנתית מהצבירה', p.feeA && p.savings ? money(p.savings * p.feeA / 100) : null],
      ['מסלול השקעה', p.track || null], ['מעסיק', p.employer || null], ['תאריך הצטרפות', p.joinDate || null],
      ['הפקדות עובד בתקופה', p.depEmp ? money(p.depEmp) : null], ['הפקדות מעסיק בתקופה', p.depEr ? money(p.depEr) : null],
      ['פיצויים בתקופה', p.depComp ? money(p.depComp) : null], ['סה"כ הופקד בתקופה', dep ? money(dep) : null]
    ].filter(([, v]) => v != null && v !== '');

    const deps = d.deposits.filter(r => r.productUid === p.uid).sort((a, b) => (b.monthKey || '').localeCompare(a.monthKey || '')).slice(0, 12);
    const rawX = Object.entries(p.raw.xls);
    const rawM = Object.entries(p.raw.xml);

    $('#drawerBody').innerHTML = `
      <dl class="kv">${kv.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      ${deps.length ? `<div><div class="section-label">הפקדות אחרונות</div>
        <table><thead><tr><th>חודש</th><th class="num">עובד</th><th class="num">מעסיק</th><th class="num">פיצויים</th></tr></thead>
        <tbody>${deps.map(r => `<tr><td>${esc(r.month)}</td><td class="num">${money(r.emp)}</td><td class="num">${money(r.er)}</td><td class="num">${money(r.comp)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${rawX.length ? `<div><div class="section-label">כל העמודות מקובץ ה-Excel</div>
        <table class="raw"><tbody>${rawX.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${rawM.length ? `<details class="raw-wrap"${rawX.length ? '' : ' open'}><summary>${rawM.length} שדות מקובץ ה-XML</summary>
        <table class="raw"><tbody>${rawM.map(([k, v]) => `<tr><td>${esc(M.TAG_LABELS[k] || k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table></details>` : ''}
      <div class="cell-sub">מקור הנתונים: ${esc(p.sources.join(' ו-'))}</div>`;
    $('#drawer').showModal();
  }

  // ---------- Deposits ----------
  function renderDeposits(d, m) {
    const R = d.deposits;
    const keys = [...new Set(R.map(r => r.monthKey).filter(Boolean))].sort();
    $('#depositsSub').textContent = R.length
      ? `${R.length} הפקדות${keys.length ? `, מ-${monthLabel(keys[0])} עד ${monthLabel(keys[keys.length - 1])}` : ''}`
      : 'לא נמצא גיליון הפקדות בקבצים שנטענו';
    const e = sum(R, r => r.emp), er = sum(R, r => r.er), c = sum(R, r => r.comp);
    ledger($('#depositsLedger'), [
      { label: 'עובד', value: moneyOrDash(e) },
      { label: 'מעסיק', value: moneyOrDash(er) },
      { label: 'פיצויים', value: moneyOrDash(c) },
      { label: 'סה"כ', value: moneyOrDash(e + er + c), cls: 'pos' },
      { label: 'ממוצע לחודש שכר', value: m.nMonths ? money((e + er + c) / m.nMonths) : '—' }
    ]);

    const sel = $('#depositFilter');
    const opts = [['all', 'כל המוצרים']].concat(
      d.products.filter(p => R.some(r => r.productUid === p.uid)).map(p => [p.uid, `${p.name}, ${p.company}`]));
    if (R.some(r => !r.productUid)) opts.push(['none', 'לא שויכו למוצר']);
    if (!opts.some(o => o[0] === state.depositFilter)) state.depositFilter = 'all';
    sel.innerHTML = opts.map(([v, t]) => `<option value="${v}"${v === state.depositFilter ? ' selected' : ''}>${esc(t)}</option>`).join('');

    const list = R.filter(r => state.depositFilter === 'all' || (state.depositFilter === 'none' ? !r.productUid : r.productUid === state.depositFilter))
      .slice().sort((a, b) => (b.monthKey || '').localeCompare(a.monthKey || ''));
    const prodName = uid => { const p = d.products.find(x => x.uid === uid); return p ? p.name : ''; };
    $('#depositsBody').innerHTML = list.length ? list.map(r => `<tr>
      <td>${esc(r.month)}</td><td class="cell-sub">${esc(r.valDate)}</td>
      <td><div>${esc(prodName(r.productUid) || r.product)}</div><div class="cell-sub">${esc(r.company)}</div></td>
      <td class="cell-sub">${esc(r.employer)}</td>
      <td class="num">${money(r.emp)}</td><td class="num">${money(r.er)}</td><td class="num">${money(r.comp)}</td>
      <td class="num pos">${money(r.emp + r.er + r.comp)}</td></tr>`).join('')
      : `<tr class="empty-row"><td colspan="8">אין הפקדות להצגה</td></tr>`;
  }

  // ---------- Insurance ----------
  function renderInsurance(d) {
    const I = d.insurance;
    ledger($('#insuranceLedger'), [
      { label: 'סכום חד פעמי למשפחה', value: moneyOrDash(sum(I, r => r.lumpSum)), note: 'סכום כל הכיסויים' },
      { label: 'קצבאות חודשיות', value: moneyOrDash(sum(I, r => r.monthly)), note: 'שארים ונכות' },
      { label: 'כיסויים', value: String(I.length) },
      { label: 'מוטבים רשומים', value: String(d.beneficiaries.length), note: d.beneficiaries.length ? '' : 'לא מופיעים בקבצים' }
    ]);
    $('#insuranceBody').innerHTML = I.length ? I.map(r => `<tr>
      <td>${esc(r.coverType)}</td><td>${esc(r.planName)}</td><td class="cell-sub">${esc(r.company)}</td><td class="cell-sub">${esc(r.recipient)}</td>
      <td class="num">${moneyOrDash(r.lumpSum)}</td><td class="num">${moneyOrDash(r.monthly)}</td></tr>`).join('')
      : `<tr class="empty-row"><td colspan="6">לא נמצאו כיסויים. הם מופיעים בגיליון "כיסויים ביטוחיים" שבקובץ ה-Excel.</td></tr>`;
    $('#beneficiariesBody').innerHTML = d.beneficiaries.length ? d.beneficiaries.map(b => `<tr>
      <td>${esc(b.name)}</td><td class="cell-sub">${esc(b.relation)}</td><td class="cell-sub">${esc(b.product)}</td><td class="num">${pctTxt(b.percent, 0)}</td></tr>`).join('')
      : `<tr class="empty-row"><td colspan="4">קובצי המסלקה שנטענו לא כוללים מוטבים. אפשר לבדוק אותם ישירות מול כל חברה מנהלת.</td></tr>`;
  }

  // ---------- Fees ----------
  function renderFees(d, m) {
    const P = d.products;
    const high = P.filter(p => feeRating(p) && feeRating(p).cls === 'high');
    ledger($('#feesLedger'), [
      { label: 'עלות שנתית משוערת', value: m.feeCost ? money(m.feeCost) : '—', cls: m.feeCost ? 'warn' : '' },
      { label: 'מתוכה מהצבירה', value: moneyOrDash(m.feeFromSavings) },
      { label: 'מתוכה מההפקדות', value: moneyOrDash(m.feeFromDeposits), note: m.nMonths ? 'לפי קצב ההפקדות בקובץ' : 'אין נתוני הפקדות' },
      { label: 'דמ"נ צבירה משוקלל', value: pctTxt(m.feeAW) },
      { label: 'מוצרים יקרים', value: String(high.length), cls: high.length ? 'neg' : 'pos', note: `מעל ${FEE.aHigh}% צבירה או ${FEE.dHigh}% הפקדה` }
    ]);
    const costs = P.filter(p => p.feeA > 0 && p.savings > 0).map(p => ({ p, v: p.savings * p.feeA / 100 })).sort((a, b) => b.v - a.v).slice(0, 10);
    bars($('#barsFeeCost'), costs.map(({ p, v }) => ({ label: `${p.name}, ${p.company}`, value: v, color: typeOf(p.type).color })), null);

    const list = P.filter(p => p.savings > 0 || p.feeA || p.feeD).sort((a, b) => b.savings - a.savings);
    $('#feesBody').innerHTML = list.length ? list.map(p => {
      const r = feeRating(p);
      return `<tr class="clickable" tabindex="0" data-uid="${p.uid}">
        <td><div class="cell-main">${esc(p.name)}</div><div class="cell-sub">${esc(p.company)}</div></td>
        <td class="num">${money(p.savings)}</td>
        <td class="num ${p.feeD >= FEE.dHigh ? 'neg' : ''}">${p.feeD ? pctTxt(p.feeD) : '—'}</td>
        <td class="num ${p.feeA >= FEE.aHigh ? 'neg' : ''}">${p.feeA ? pctTxt(p.feeA) : '—'}</td>
        <td class="num">${p.feeA && p.savings ? money(p.savings * p.feeA / 100) : '—'}</td>
        <td class="num ${signClass(p.ytd)}">${pctTxt(p.ytd)}</td>
        <td class="num ${signClass(p.ret12)}">${pctTxt(p.ret12)}</td>
        <td class="num ${signClass(p.ret36)}">${pctTxt(p.ret36)}</td>
        <td class="num ${signClass(p.ret60)}">${pctTxt(p.ret60)}</td>
        <td>${r ? `<span class="rating ${r.cls}">${r.text}</span>` : '—'}</td></tr>`;
    }).join('') : `<tr class="empty-row"><td colspan="10">אין נתוני דמי ניהול</td></tr>`;
  }

  // ---------- Files ----------
  function renderFiles(d) {
    $('#filesBody').innerHTML = d.files.length ? d.files.map(f => `<tr>
      <td><div class="cell-main">${esc(f.name)}</div>${f.from ? `<div class="cell-sub">מתוך ${esc(f.from)}</div>` : ''}</td>
      <td>${esc(f.kind)}</td><td class="cell-sub">${esc(f.result)}</td></tr>`).join('')
      : `<tr class="empty-row"><td colspan="3">לא נטענו קבצים</td></tr>`;
    $('#fullLog').innerHTML = d.log.map(l => `<div class="${l.kind}">${esc(l.msg)}</div>`).join('');
  }

  // ======================================================================
  //  Charts (created only when their view is visible)
  // ======================================================================
  function chartDefaults() {
    const C = window.Chart;
    C.defaults.font.family = 'Plex, system-ui, sans-serif';
    C.defaults.font.size = 12;
    C.defaults.color = '#9DB6B2';
    C.defaults.borderColor = 'rgba(157,182,178,.12)';
    C.defaults.plugins.legend.rtl = true;
    C.defaults.plugins.legend.labels.boxWidth = 10;
    C.defaults.plugins.legend.labels.boxHeight = 10;
    C.defaults.plugins.tooltip.rtl = true;
    C.defaults.plugins.tooltip.textDirection = 'rtl';
    C.defaults.plugins.tooltip.backgroundColor = '#14363D';
    C.defaults.plugins.tooltip.borderColor = '#21474F';
    C.defaults.plugins.tooltip.borderWidth = 1;
    C.defaults.plugins.tooltip.padding = 10;
    C.defaults.maintainAspectRatio = false;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    C.defaults.animation = reduce ? false : { duration: 450 };
  }

  function chart(id, config) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    const el = document.getElementById(id);
    if (!el) return;
    charts[id] = new Chart(el, config);
  }

  const moneyAxis = { ticks: { callback: v => compact(v) }, grid: { color: 'rgba(157,182,178,.08)' } };
  const shortName = s => (s.length > 18 ? s.slice(0, 17) + '…' : s);

  function renderChartsFor(view) {
    const d = ds();
    if (!hasData(d) || $('#screenDash').hidden) return;
    if (view === 'products') {
      const list = filteredProducts(d).filter(p => p.savings > 0).slice(0, 12);
      $('#chartProductsSub').textContent = list.length ? `${list.length} המוצרים הגדולים בסינון הנוכחי` : 'אין חיסכון להצגה בסינון הנוכחי';
      chart('chProducts', {
        type: 'bar',
        data: { labels: list.map(p => shortName(p.name)), datasets: [{ data: list.map(p => p.savings), backgroundColor: list.map(p => typeOf(p.type).hex), borderRadius: 4, maxBarThickness: 22 }] },
        options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { title: c => list[c[0].dataIndex].name + ', ' + list[c[0].dataIndex].company, label: c => ' ' + money(c.parsed.x) } } },
          scales: { x: { ...moneyAxis, reverse: true }, y: { position: 'right', grid: { display: false } } } }
      });
      const ylist = filteredProducts(d).filter(p => p.ytd != null).slice(0, 12);
      chart('chYtd', {
        type: 'bar',
        data: { labels: ylist.map(p => shortName(p.name)), datasets: [{ data: ylist.map(p => p.ytd), backgroundColor: ylist.map(p => p.ytd < 0 ? '#FF7A85' : '#5EEAA8'), borderRadius: 4, maxBarThickness: 22 }] },
        options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { title: c => ylist[c[0].dataIndex].name, label: c => ' ' + pctTxt(c.parsed.x) } } },
          scales: { x: { reverse: true, ticks: { callback: v => v + '%' }, grid: { color: 'rgba(157,182,178,.08)' } }, y: { position: 'right', grid: { display: false } } } }
      });
    }
    if (view === 'deposits') {
      const keys = [...new Set(d.deposits.map(r => r.monthKey).filter(Boolean))].sort();
      const all = keys.length ? monthRange(keys[0], keys[keys.length - 1]) : [];
      const agg = k => d.deposits.filter(r => r.monthKey === k);
      chart('chDepositsMonthly', {
        type: 'bar',
        data: {
          labels: all.map(monthLabel),
          datasets: [
            { label: 'עובד', data: all.map(k => sum(agg(k), r => r.emp)), backgroundColor: '#7CC4FF', stack: 's' },
            { label: 'מעסיק', data: all.map(k => sum(agg(k), r => r.er)), backgroundColor: '#5EEAA8', stack: 's' },
            { label: 'פיצויים', data: all.map(k => sum(agg(k), r => r.comp)), backgroundColor: '#F2C46D', stack: 's' }
          ]
        },
        options: { plugins: { legend: { position: 'top', align: 'start' }, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${money(c.parsed.y)}` } } },
          scales: { x: { reverse: true, stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } }, y: { ...moneyAxis, stacked: true, position: 'right' } } }
      });
    }
    if (view === 'fees') {
      const pts = d.products.filter(p => p.feeA > 0 || p.feeD > 0);
      const maxS = Math.max(1, ...pts.map(p => p.savings));
      const thresholds = {
        id: 'thresholds',
        beforeDatasetsDraw(c) {
          const { ctx, chartArea: a, scales: { x, y } } = c;
          ctx.save();
          ctx.fillStyle = 'rgba(255,122,133,.06)';
          const xh = x.getPixelForValue(FEE.aHigh), yh = y.getPixelForValue(FEE.dHigh);
          // In RTL the x axis is reversed, so "higher" lies to the left
          if (xh > a.left && xh < a.right) ctx.fillRect(a.left, a.top, xh - a.left, a.bottom - a.top);
          if (yh > a.top && yh < a.bottom) ctx.fillRect(a.left, a.top, a.right - a.left, yh - a.top);
          ctx.restore();
        }
      };
      chart('chFeesMap', {
        type: 'bubble',
        data: { datasets: [{ data: pts.map(p => ({ x: p.feeA, y: p.feeD, r: 5 + Math.sqrt(p.savings / maxS) * 16 })),
          backgroundColor: pts.map(p => typeOf(p.type).hex + 'B3'), borderColor: pts.map(p => typeOf(p.type).hex), borderWidth: 1 }] },
        options: {
          plugins: { legend: { display: false }, tooltip: { callbacks: { title: c => pts[c[0].dataIndex].name + ', ' + pts[c[0].dataIndex].company,
            label: c => [` מהצבירה: ${pctTxt(pts[c.dataIndex].feeA)}`, ` מההפקדה: ${pctTxt(pts[c.dataIndex].feeD)}`, ` חיסכון: ${money(pts[c.dataIndex].savings)}`] } } },
          scales: {
            x: { reverse: true, min: 0, suggestedMax: 1, grace: '12%', title: { display: true, text: 'דמי ניהול מהצבירה' }, ticks: { callback: v => v + '%' }, grid: { color: 'rgba(157,182,178,.08)' } },
            y: { position: 'right', min: 0, suggestedMax: 4, grace: '12%', title: { display: true, text: 'דמי ניהול מההפקדה' }, ticks: { callback: v => v + '%' }, grid: { color: 'rgba(157,182,178,.08)' } }
          }
        },
        plugins: [thresholds]
      });
    }
    if (view === 'advisor') runSim();
  }

  // ======================================================================
  //  Anonymized summary for analysis in an external AI chat
  //  Excludes: ID number, person name, policy numbers, beneficiary names.
  //  Nothing is sent anywhere; the user copies it manually.
  // ======================================================================
  function buildAiSummary(d) {
    const m = metrics(d);
    const withDeposits = $('#aiDeposits').checked;
    const withEmployer = $('#aiEmployer').checked;
    const withSim = $('#aiSim').checked;
    const L = [];
    const n2 = v => (v == null ? 'לא ידוע' : pctTxt(v));
    const year = s => { const mm = String(s || '').match(/(\d{4})$/); return mm ? mm[1] : ''; };

    L.push('אתה יועץ פנסיוני ותיק בישראל. לפניך סיכום אנונימי של כל המוצרים הפנסיוניים שלי, מתוך דוח המסלקה הפנסיונית.');
    L.push('נתח את התיק ותן לי:');
    L.push('1. את 3 הפעולות החשובות ביותר שכדאי לעשות עכשיו, לפי סדר חשיבות, עם הערכת השפעה כספית כשאפשר.');
    L.push('2. הערכה של דמי הניהול בכל מוצר ביחס למקובל בשוק היום, ומה סביר לבקש במשא ומתן.');
    L.push('3. האם מסלולי ההשקעה מתאימים לגיל ולטווח עד הפרישה.');
    L.push('4. האם הכיסוי הביטוחי (שארים, נכות, ריסק) נראה מספיק, ואם יש כפל כיסויים.');
    L.push('5. מה כדאי לעשות עם קופות לא פעילות ועם חשבונות כפולים.');
    L.push('6. שאלות שחשוב שתשאל אותי כדי לדייק את ההמלצות.');
    L.push('ציין בבירור כשאתה מניח הנחה, ואל תמציא נתונים שלא מופיעים כאן.');
    L.push('');
    L.push('=== תמונת מצב ===');
    if (d.person.reportDate) L.push(`נכון לתאריך: ${d.person.reportDate}`);
    L.push(`חיסכון כולל היום: ${money(m.total)}`);
    L.push(`חיסכון צפוי בגיל פרישה (לפי החברות): ${m.expected ? money(m.expected) : 'לא מופיע בדוח'}`);
    L.push(`קצבה חודשית צפויה (לפי החברות): ${m.monthly ? money(m.monthly) : 'לא מופיע בדוח'}`);
    L.push(`מוצרים: ${d.products.length}, מתוכם פעילים: ${m.active.length}`);
    L.push(`עלות דמי ניהול שנתית משוערת: ${m.feeCost ? money(m.feeCost) : 'לא ידוע'}`);
    L.push(`תשואה משוקללת מתחילת השנה: ${n2(m.ytdW)}`);
    if (withEmployer && d.person.employers.length) L.push(`מעסיקים: ${d.person.employers.join(', ')}`);

    L.push('');
    L.push('=== מוצרים ===');
    d.products.slice().sort((a, b) => b.savings - a.savings).forEach((p, i) => {
      const parts = [
        `${i + 1}. ${typeOf(p.type).label}, ${p.company || 'חברה לא ידועה'}${p.name && p.name !== typeOf(p.type).label ? ` (${p.name})` : ''}`,
        `   סטטוס: ${p.status === 'on' ? 'פעיל' : 'לא פעיל'}${year(p.joinDate) ? `, הצטרפות ${year(p.joinDate)}` : ''}`,
        `   חיסכון: ${money(p.savings)}${p.expected ? `, צפוי לפרישה: ${money(p.expected)}` : ''}${p.monthly ? `, קצבה צפויה: ${money(p.monthly)}` : ''}`,
        `   דמי ניהול: ${p.feeD ? pctTxt(p.feeD) : '0%'} מהפקדה, ${p.feeA ? pctTxt(p.feeA) : '0%'} מהצבירה`,
        `   תשואה: מתחילת שנה ${n2(p.ytd)}${p.ret12 != null ? `, 12 ח' ${n2(p.ret12)}` : ''}${p.ret36 != null ? `, 36 ח' ${n2(p.ret36)}` : ''}${p.ret60 != null ? `, 60 ח' ${n2(p.ret60)}` : ''}`
      ];
      if (p.track) parts.push(`   מסלול השקעה: ${p.track}`);
      const dep = p.depEmp + p.depEr + p.depComp;
      if (dep) parts.push(`   הפקדות בתקופת הדוח: עובד ${money(p.depEmp)}, מעסיק ${money(p.depEr)}, פיצויים ${money(p.depComp)}`);
      L.push(...parts);
    });

    if (withDeposits && d.deposits.length) {
      const keys = [...new Set(d.deposits.map(r => r.monthKey).filter(Boolean))].sort();
      const all = keys.length ? monthRange(keys[0], keys[keys.length - 1]) : [];
      L.push('');
      L.push('=== הפקדות לפי חודש שכר (כל המוצרים יחד) ===');
      all.slice(-24).forEach(k => {
        const rows = d.deposits.filter(r => r.monthKey === k);
        const t = sum(rows, r => r.emp + r.er + r.comp);
        L.push(`${monthLabel(k)}: ${t ? `${money(t)} (עובד ${money(sum(rows, r => r.emp))}, מעסיק ${money(sum(rows, r => r.er))}, פיצויים ${money(sum(rows, r => r.comp))})` : 'אין הפקדה'}`);
      });
    }

    L.push('');
    L.push('=== כיסויים ביטוחיים ===');
    if (d.insurance.length) {
      d.insurance.forEach(r => L.push(`- ${r.coverType || 'כיסוי'}${r.planName ? `, ${r.planName}` : ''}${r.company ? `, ${r.company}` : ''}: ${r.lumpSum ? `סכום חד פעמי ${money(r.lumpSum)}` : ''}${r.lumpSum && r.monthly ? ', ' : ''}${r.monthly ? `קצבה חודשית ${money(r.monthly)}` : ''}${!r.lumpSum && !r.monthly ? 'סכום לא צוין' : ''}`));
    } else L.push('לא נמצאו כיסויים בדוח.');
    if (d.beneficiaries.length) {
      L.push(`מוטבים רשומים: ${d.beneficiaries.map(b => `${b.relation || 'קרבה לא צוינה'} ${pctTxt(b.percent, 0)}`).join(', ')}`);
    }

    const ins = buildInsights(d).filter(i => i.level !== 'good');
    if (ins.length) {
      L.push('');
      L.push('=== ממצאים אוטומטיים מהדשבורד ===');
      ins.forEach(i => L.push(`- ${i.title}`));
    }

    if (withSim) {
      L.push('');
      L.push('=== הנחות שהזנתי בסימולטור ===');
      L.push(`גיל: ${$('#simAge').value}, גיל פרישה מתוכנן: ${$('#simRetire').value}`);
      L.push(`שכר ברוטו לפנסיה: ${money(+$('#simSalary').value)} לחודש, שיעור הפקדה: ${$('#simPct').value}%`);
      L.push(`תשואה שנתית צפויה: ${$('#simReturn').value}%, דמי ניהול מהצבירה: ${$('#simFee').value}%`);
    }
    return L.join('\n');
  }

  function renderAiSummary() {
    const d = ds();
    if (!hasData(d)) return;
    const txt = buildAiSummary(d);
    $('#aiText').value = txt;
    $('#aiMeta').textContent = `${txt.length.toLocaleString('he-IL')} תווים`;
  }

  async function copyAiSummary() {
    const txt = $('#aiText').value;
    let ok = false;
    try { await navigator.clipboard.writeText(txt); ok = true; } catch (e) {
      // Fallback for browsers without clipboard permission
      const ta = $('#aiText'); ta.focus(); ta.select();
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    }
    toast(ok ? 'הסיכום הועתק. הדביקו אותו בצ\'אט AI ושלחו.' : 'ההעתקה נחסמה בדפדפן. סמנו את הטקסט והעתיקו ידנית.', !ok);
  }

  function downloadAiSummary() {
    const d = ds();
    const stamp = (d.person.reportDate || new Date().toLocaleDateString('he-IL')).replace(/\//g, '-');
    const blob = new Blob(['﻿' + $('#aiText').value], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pension-summary-${stamp}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ======================================================================
  //  Retirement simulator
  // ======================================================================
  let simPrefilledFor = null;
  function prefillSim(d, m) {
    if (simPrefilledFor === state.currentId + ':' + d.products.length) return;
    simPrefilledFor = state.currentId + ':' + d.products.length;
    $('#simExisting').value = Math.round(m.total);
    if (m.feeAW) $('#simFee').value = (+m.feeAW).toFixed(2);
    if (m.nMonths) {
      const avg = m.depTotal / m.nMonths;
      const pctv = +$('#simPct').value || 18.5;
      $('#simSalary').value = Math.round(avg / (pctv / 100) / 100) * 100;
    }
  }

  function runSim() {
    const v = id => +$(id).value || 0;
    const age = v('#simAge'), retire = v('#simRetire'), salary = v('#simSalary'), pctv = v('#simPct') / 100;
    const exist = v('#simExisting'), ret = v('#simReturn') / 100, fee = v('#simFee') / 100, factor = v('#simFactor') || 200;
    const years = Math.max(0, retire - age);
    const net = ret - fee, r = net / 12, dep = salary * pctv;
    const fvAt = y => {
      const a = exist * Math.pow(1 + net, y);
      const n = y * 12;
      const b = Math.abs(r) > 1e-9 ? dep * (Math.pow(1 + r, n) - 1) / r : dep * n;
      return { total: a + b, existing: a };
    };
    const end = fvAt(years);
    $('#simTotal').textContent = money(end.total);
    $('#simPension').textContent = money(end.total / factor);
    $('#simYears').textContent = String(years);

    if ($('#screenDash').hidden || state.view !== 'advisor') return;
    const labels = [], tot = [], ex = [];
    for (let y = 0; y <= years; y++) { const f = fvAt(y); labels.push(String(age + y)); tot.push(Math.round(f.total)); ex.push(Math.round(f.existing)); }
    chart('chSim', {
      type: 'line',
      data: { labels, datasets: [
        { label: 'עם הפקדות שוטפות', data: tot, borderColor: '#FF9F6E', backgroundColor: 'rgba(255,159,110,.12)', fill: true, tension: .3, pointRadius: 0, borderWidth: 2 },
        { label: 'רק החיסכון הקיים', data: ex, borderColor: '#9DB6B2', borderDash: [4, 4], fill: false, tension: .3, pointRadius: 0, borderWidth: 1.5 }
      ] },
      options: { interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top', align: 'start' }, tooltip: { callbacks: { title: c => `גיל ${c[0].label}`, label: c => ` ${c.dataset.label}: ${money(c.parsed.y)}` } } },
        scales: { x: { reverse: true, grid: { display: false }, title: { display: true, text: 'גיל' }, ticks: { maxTicksLimit: 10, maxRotation: 0 } }, y: { ...moneyAxis, position: 'right' } } }
    });
  }

  // ======================================================================
  //  Toast
  // ======================================================================
  let toastTimer;
  function toast(msg, isErr) {
    let el = $('#toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  // ======================================================================
  //  Events
  // ======================================================================
  function bind() {
    // Hidden input used for adding files from the dashboard
    const extra = document.createElement('input');
    extra.type = 'file'; extra.id = 'fileInput2'; extra.multiple = true; extra.accept = '.zip,.xls,.xlsx,.xml'; extra.hidden = true;
    document.body.appendChild(extra);
    extra.addEventListener('change', e => handleFiles(e.target.files));

    // Bar button for adding files (visible on mobile where the rail footer is hidden)
    const barAdd = document.createElement('button');
    barAdd.className = 'btn'; barAdd.id = 'barAdd'; barAdd.type = 'button'; barAdd.hidden = true;
    barAdd.innerHTML = '<svg aria-hidden="true"><use href="#i-upload"/></svg><span class="btn-label">קבצים</span>';
    $('.bar-actions').prepend(barAdd);
    barAdd.addEventListener('click', () => extra.click());

    $('#fileInput').addEventListener('change', e => handleFiles(e.target.files));
    $('#addFilesBtn').addEventListener('click', () => extra.click());
    $('#printBtn').addEventListener('click', () => window.print());
    $('#privacyBtn').addEventListener('click', () => $('#privacyModal').showModal());

    // Drag and drop anywhere on the page
    const drop = $('#drop');
    let depth = 0;
    document.addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); depth++; drop.classList.add('is-over'); } });
    document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove('is-over'); });
    document.addEventListener('dragover', e => { e.preventDefault(); });
    document.addEventListener('drop', e => { e.preventDefault(); depth = 0; drop.classList.remove('is-over'); if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

    // Profiles
    $('#profiles').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.id === 'addProfile') { $('#profileName').value = ''; $('#profileModal').returnValue = ''; $('#profileModal').showModal(); $('#profileName').focus(); return; }
      if (b.dataset.pid) { state.currentId = b.dataset.pid; simPrefilledFor = null; renderProfiles(); showScreen(); setView('overview'); }
    });
    $('#profileModal').addEventListener('close', () => {
      const name = $('#profileName').value.trim();
      if ($('#profileModal').returnValue !== 'ok' || !name) return;
      createProfile(name, false);
      renderProfiles();
      showScreen();
      $('#log').innerHTML = ''; $('#progress').hidden = true;
      toast(`נוצר פרופיל ל${name}. עכשיו טוענים את הקבצים שלו.`);
    });

    // Navigation
    $$('.nav-btn').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
    document.addEventListener('click', e => {
      const g = e.target.closest('[data-goto]');
      if (!g) return;
      setView(g.dataset.goto);
      if (g.dataset.scroll) requestAnimationFrame(() => { const t = document.getElementById(g.dataset.scroll); if (t) t.scrollIntoView({ block: 'start' }); });
    });

    // Product filters
    $('#typeFilter').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.filters.type = b.dataset.v; renderProducts(ds()); renderChartsFor('products'); });
    $('#statusFilter').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.filters.status = b.dataset.v; renderProducts(ds()); renderChartsFor('products'); });
    $('#productSearch').addEventListener('input', e => { state.filters.q = e.target.value; renderProducts(ds()); renderChartsFor('products'); });
    $('#depositFilter').addEventListener('change', e => { state.depositFilter = e.target.value; renderDeposits(ds(), metrics(ds())); });

    // Rows open the details drawer
    const openFrom = e => { const tr = e.target.closest('tr[data-uid]'); if (tr) openDrawer(tr.dataset.uid); };
    $('#productsBody').addEventListener('click', openFrom);
    $('#feesBody').addEventListener('click', openFrom);
    document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr[data-uid]')) { e.preventDefault(); openDrawer(e.target.dataset.uid); } });
    $('#drawer').addEventListener('click', e => { if (e.target.closest('[data-close]') || e.target === $('#drawer')) $('#drawer').close(); });

    // Simulator updates live
    $('#simForm').addEventListener('input', () => { runSim(); renderAiSummary(); });
    ['#aiDeposits', '#aiEmployer', '#aiSim'].forEach(id => $(id).addEventListener('change', renderAiSummary));
    $('#aiCopy').addEventListener('click', copyAiSummary);
    $('#aiDownload').addEventListener('click', downloadAiSummary);
    $('#simForm').addEventListener('submit', e => e.preventDefault());

    // Clearing
    $('#clearProfileBtn').addEventListener('click', () => {
      const p = current(); if (!p) return;
      if (!confirm(`למחוק את כל הנתונים שנטענו ל${p.name}?`)) return;
      p.ds = M.newDataset(); simPrefilledFor = null;
      Object.keys(charts).forEach(k => { charts[k].destroy(); delete charts[k]; });
      $('#log').innerHTML = ''; $('#progress').hidden = true;
      showScreen(); toast('הנתונים נמחקו');
    });
    $('#deleteProfileBtn').addEventListener('click', () => {
      const p = current(); if (!p) return;
      if (!confirm(`למחוק את הפרופיל של ${p.name}?`)) return;
      state.profiles = state.profiles.filter(x => x.id !== p.id);
      state.currentId = state.profiles[0] ? state.profiles[0].id : null;
      simPrefilledFor = null;
      Object.keys(charts).forEach(k => { charts[k].destroy(); delete charts[k]; });
      $('#log').innerHTML = ''; $('#progress').hidden = true;
      renderProfiles(); showScreen(); setView('overview'); toast('הפרופיל נמחק');
    });

    // Leaving the page drops everything; warn only when there is data
    window.addEventListener('beforeunload', e => { if (state.profiles.some(p => hasData(p.ds))) { e.preventDefault(); e.returnValue = ''; } });
  }

  // ---------- Init ----------
  function init() {
    if (window.zip) zip.configure({ useWebWorkers: false });
    chartDefaults();
    bind();
    renderProfiles();
    showScreen();
  }
  init();
})();
