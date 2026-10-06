
class Component extends DCLogic {
  state = { screen: 'list', step: 1, tab: 'status', pay: 'full', prog: -1, method: '',
            filter: '전체', db: null, pq: '', pcat: '색소', psub: '', paxis: {}, addArea: '', progId: '', amounts: {},
            sig: false, sigOpen: false, sigImg: null, savedSig: null, signedAt: null,
            refundDone: false, backup: true, toast: '',
            patient: { name: '', birth: '', phone: '' }, tried1: false, docs: [], cStatus: '등록완료', lq: '' };

  openSigPad = () => this.setState({ sigOpen: true });
  closeSigPad = () => this.setState({ sigOpen: false });
  confirmSigPad = () => {
    if (!this.state.sig) return this.flash('서명이 필요합니다');
    let img = null;
    try { img = this._canvas ? this._canvas.toDataURL('image/png') : null; } catch (e) {}
    this.setState({ sigOpen: false, sigImg: img });
  };

  // 오늘 날짜: 기기 현지 시간 기준 (toISOString은 UTC라 한국 오전 9시 이전에는 전날로 기록됨)
  static today() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  // 계약 상태: 등록완료 / 환불완료 두 가지. 환불 정산서 서명이 저장된 계약만 환불완료 (이전 버전의 중간 상태 값도 이 기준으로 정리)
  statusOf(c) { return c && (c.refunded || c.refund || c.status === '환불완료' || c.status === '환불처리대기') ? '환불완료' : '등록완료'; }
  // 환불 입력값(이용 수량·서비스 기록·병변·배분)은 계약별로 보관 → 계약을 바꾸면 그 계약의 값으로 교체 (다른 계약 기록 섞임 방지)
  rfStateOf(c) { const r = (c && (c.refund || c.refundDraft)) || {};
    return { rfUsed: r.used || null, rfVisits: r.visits || null, rfLes: r.les || null, rfVar: r.vars || null, rfAlloc: r.alloc || null, rfReason: r.reason || '', rfExtra: '', balMethod: '', balAmt: '', balDate: '', balRcpt: '' }; }
  // 계약 저장: 계약 id 기준으로 교체 후 기기에 기록 (기존 계약 데이터는 유지하고 바뀐 필드만 덮어씀)
  saveContract(c, extra) {
    this.setState(st => {
      const contracts = (st.contracts || []).map(x => x.id && x.id === c.id ? c : x);
      try { localStorage.setItem('dachaeum.v3.contracts', JSON.stringify(contracts.filter(x => !x.sample))); } catch (e) { setTimeout(() => this.flash('기기 저장 공간이 부족합니다')); }
      return { contracts, ...(st.contract && st.contract.id === c.id ? { contract: c, cStatus: this.statusOf(c) } : {}), ...(extra || {}) };
    });
  }
  // 작성 중 환불 정산 입력값을 계약에 자동 저장 → 화면을 나갔다 다시 들어와도 이어서 입력 (계약 상태는 바꾸지 않음)
  // 기기 저장은 즉시(동기) 기록 → 입력 직후 새로고침·앱 닫기에도 남음
  saveDraft() {
    const s = this.state, c = s.contract; if (!c || !c.id || c.refund) return;
    const nc = { ...c, refundDraft: { used: s.rfUsed || null, visits: s.rfVisits || null, les: s.rfLes || null, vars: s.rfVar || null, alloc: s.rfAlloc || null, reason: s.rfReason || '' } };
    const contracts = (s.contracts || []).map(x => x.id && x.id === nc.id ? nc : x);
    try { localStorage.setItem('dachaeum.v3.contracts', JSON.stringify(contracts.filter(x => !x.sample))); } catch (e) { return; }
    this.setState({ contracts, contract: nc });
  }

  // 새 동의서 임시 저장: 계약이 아니라 작성 중인 입력값만 보관 (예: 선결제권 신규 구매 부분 수납) → 추가 수납 후 이어서 작성
  static DRAFT_KEY = 'dachaeum.v3.newDrafts';
  static DRAFT_FIELDS = ['patient', 'step', 'pcat', 'psub', 'paxis', 'pq', 'prog', 'progId', 'hairIds', 'method', 'mSel', 'split1', 'cashRcpt', 'pay',
    'addArea', 'addSel', 'addSvc', 'addSvN', 'svcOff', 'svcSwap', 'oGrp', 'disc', 'preTier', 'retPeriod', 'preBal', 'priorDep', 'preNew', 'preRcvAmt', 'preBuyM',
    'amounts', 'units', 'lesions', 'unitFix', 'evFirst', 'forceFull', 'dupPick', 'dupOff'];
  readDrafts() { try { const d = JSON.parse(localStorage.getItem(Component.DRAFT_KEY) || '[]'); return Array.isArray(d) ? d : []; } catch (e) { return []; } }
  writeDrafts(list) { try { localStorage.setItem(Component.DRAFT_KEY, JSON.stringify(list)); } catch (e) { this.flash('기기 저장 공간이 부족합니다'); return false; } this.setState({ drafts: list }); return true; }
  saveNewDraft(info) {
    const s = this.state, id = s.draftId || 'DR' + Date.now(), state = {};
    Component.DRAFT_FIELDS.forEach(k => { if (s[k] !== undefined) state[k] = s[k]; });
    const d = { id, at: new Date().toISOString(), name: (s.patient || {}).name || '', ...(info || {}), state };
    if (this.writeDrafts(this.readDrafts().filter(x => x.id !== id).concat([d]))) { this.setState({ draftId: id }); this.flash('임시 저장했습니다. 목록에서 이어서 작성할 수 있습니다'); }
  }

  // ---- 백업·복원 ----
  // 대상: 이 앱이 기기에 저장한 자료(dachaeum.* — 계약·계약 당시 단가·결제내역·이용기록·작성 중/확정 환불·서명 문서와 버전·가격 관리 설정)만.
  // 재고관리 등 다른 앱 자료는 읽지도 바꾸지도 않음. 파일은 비밀번호로 암호화(PBKDF2-SHA256 → AES-GCM 256)
  static BK = { format: 'dachaeum-consent-backup', version: 1, prefix: 'dachaeum.', skip: ['dachaeum.v3.lastBackup'], iter: 310000 };
  bkKeys() { const out = {}, B = Component.BK;
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(B.prefix) && !B.skip.includes(k)) out[k] = localStorage.getItem(k); }
    return out; }
  static b64(buf) { const b = new Uint8Array(buf); let t = ''; for (let i = 0; i < b.length; i += 0x8000) t += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(t); }
  static unb64(t) { const x = atob(String(t || '')); const b = new Uint8Array(x.length); for (let i = 0; i < x.length; i++) b[i] = x.charCodeAt(i); return b; }
  async bkKey(pw, salt, iter) {
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
  async bkSha(text) { return Component.b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }
  bkCounts(keys) {
    const arr = k => { try { const v = JSON.parse(keys[k] || '[]'); return Array.isArray(v) ? v : null; } catch (e) { return null; } };
    const c = arr('dachaeum.v3.contracts'), d = arr('dachaeum.v3.docs');
    return { contracts: c ? c.length : -1, docs: d ? d.length : -1, refunded: c ? c.filter(x => x && (x.refund || x.refunded)).length : 0 }; }
  async exportBackup(pw) {
    const B = Component.BK, keys = this.bkKeys(), counts = this.bkCounts(keys);
    const inner = JSON.stringify({ keys, counts, sha256: await this.bkSha(JSON.stringify(keys)) });
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.bkKey(pw, salt, B.iter), new TextEncoder().encode(inner));
    const now = new Date(), hm = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
    const file = { format: B.format, version: B.version, app: '다채움피부과 동의서', createdAt: now.toISOString(), counts,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: B.iter, salt: Component.b64(salt) }, cipher: { name: 'AES-GCM', iv: Component.b64(iv) }, data: Component.b64(ct) };
    return { name: 'dachaeum-backup-' + Component.today().replace(/-/g, '') + '-' + hm + '.json', text: JSON.stringify(file), counts };
  }
  // 복원 전 검사: 형식·버전·암호·검증값·누락(건수)·중복(id)·연결(문서→계약). 하나라도 실패하면 기기 자료는 그대로
  async readBackup(text, pw) {
    const B = Component.BK; let f;
    try { f = JSON.parse(text); } catch (e) { throw new Error('백업 파일 형식이 아닙니다'); }
    if (!f || f.format !== B.format) throw new Error('다채움 동의서 백업 파일이 아닙니다');
    if (f.version !== B.version) throw new Error('지원하지 않는 백업 버전입니다 (v' + f.version + ')');
    if (!f.kdf || !f.cipher || !f.data || !f.kdf.salt || !f.cipher.iv) throw new Error('백업 파일에 필요한 항목이 빠져 있습니다');
    let inner;
    try { const key = await this.bkKey(pw, Component.unb64(f.kdf.salt), Number(f.kdf.iterations) || B.iter);
      inner = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Component.unb64(f.cipher.iv) }, key, Component.unb64(f.data)))); }
    catch (e) { throw new Error('비밀번호가 맞지 않거나 파일이 손상되었습니다'); }
    const keys = inner && inner.keys;
    if (!keys || typeof keys !== 'object') throw new Error('백업 내용이 비어 있습니다');
    if (Object.keys(keys).some(k => !k.startsWith(B.prefix) || B.skip.includes(k) || typeof keys[k] !== 'string')) throw new Error('이 앱 자료가 아닌 항목이 있어 복원할 수 없습니다');
    if (await this.bkSha(JSON.stringify(keys)) !== inner.sha256) throw new Error('백업 내용이 손상되었습니다 (검증값 불일치)');
    const counts = this.bkCounts(keys);
    if (counts.contracts < 0 || counts.docs < 0) throw new Error('계약 또는 문서 자료가 손상되었습니다');
    if (!inner.counts || inner.counts.contracts !== counts.contracts || inner.counts.docs !== counts.docs) throw new Error('백업 내용 일부가 누락되었습니다');
    const C = JSON.parse(keys['dachaeum.v3.contracts'] || '[]'), D = JSON.parse(keys['dachaeum.v3.docs'] || '[]');
    const dup = a => { const ids = a.map(x => x && x.id).filter(Boolean); return ids.length !== new Set(ids).size; };
    if (dup(C) || dup(D)) throw new Error('같은 번호의 계약 또는 문서가 중복되어 있습니다');
    const ids = new Set(C.map(c => c && c.id)), orphan = D.filter(d => d && d.contractId && !ids.has(d.contractId)).length;
    if (orphan) throw new Error('계약과 연결되지 않은 문서가 ' + orphan + '건 있습니다');
    return { keys, counts, createdAt: f.createdAt || '' };
  }
  // 교체 복원: 이 앱 자료만 지우고 백업 자료로 바꿈. 쓰는 도중 실패하면 원래 자료로 되돌림
  applyRestore(keys) {
    const prev = this.bkKeys();
    try { Object.keys(prev).forEach(k => localStorage.removeItem(k)); Object.entries(keys).forEach(([k, v]) => localStorage.setItem(k, v)); return true; }
    catch (e) {
      try { Object.keys(this.bkKeys()).forEach(k => localStorage.removeItem(k)); Object.entries(prev).forEach(([k, v]) => localStorage.setItem(k, v)); } catch (e2) {}
      return false; }
  }

  flash(t) { this.setState({ toast: t }); clearTimeout(this._t); this._t = setTimeout(() => this.setState({ toast: '' }), 1800); }

  attachSig = (el) => {
    this._canvas = el;
    if (el && !this.state.sig) { const c = el.getContext('2d'); c.clearRect(0, 0, el.width, el.height); }
  };
  pt(e) { const c = e.currentTarget, r = c.getBoundingClientRect(); return [(e.clientX - r.left) * (c.width / r.width), (e.clientY - r.top) * (c.height / r.height)]; }
  down = (e) => {
    const c = e.currentTarget; c.setPointerCapture(e.pointerId);
    const x = c.getContext('2d'); x.lineWidth = 2.6; x.lineCap = 'round'; x.lineJoin = 'round'; x.strokeStyle = '#1c1f23';
    const [a, b] = this.pt(e); x.beginPath(); x.moveTo(a, b); this._drawing = true;
    if (!this.state.sig) this.setState({ sig: true });
  };
  move = (e) => { if (!this._drawing) return; const x = e.currentTarget.getContext('2d'); const [a, b] = this.pt(e); x.lineTo(a, b); x.stroke(); };
  up = () => { this._drawing = false; };
  clear = () => { const el = this._canvas; if (el) el.getContext('2d').clearRect(0, 0, el.width, el.height); this.setState({ sig: false }); };

  // 상태 태그: 직원 후속 처리가 필요한 상태만 테두리·진한 글자로 강조, 나머지는 연한 Non-border
  chip(s) {
    if (s === '등록완료') return ['rgba(52,91,128,0.08)', '#2a4b6b', 'transparent'];
    if (s === '환불완료') return ['#f2f3f5', '#8d949b', 'transparent'];
    return ['#eef1f4', '#4a5158', 'transparent'];
  }
  _setT(el, t) { const s = el.style; s.setProperty('--tx', t.tx + 'px'); s.setProperty('--lh', String(t.lh)); s.setProperty('--sg', t.sg + 'px'); s.setProperty('--bg', t.bg + 'px'); s.setProperty('--tt', t.tt + 'px'); s.setProperty('--tb', t.tb + 'px'); s.setProperty('--tbl', t.tbl + 'px'); s.setProperty('--cp', t.cp); }
  // 서명 완료 시점의 문서를 인쇄용(A4 1장 단계)으로 고정해 HTML 최종본으로 보관
  snapshotDoc() {
    const wrap = (this._els || {}).sgH; const src = wrap && wrap.firstElementChild; if (!src || typeof document === 'undefined') return '';
    const c = src.cloneNode(true);
    c.style.zoom = ''; c.style.fontFamily = "'Noto Serif KR', serif"; c.style.color = '#1c1f23'; c.style.width = '740px'; c.style.maxWidth = '740px'; c.style.minHeight = '0px';
    const box = document.createElement('div'); box.style.cssText = 'position:fixed;left:-10000px;top:0;width:740px;visibility:hidden';
    box.appendChild(c); document.body.appendChild(box);
    const T = Component.TIERS; let t = T[T.length - 1];
    for (let i = 1; i < T.length; i++) { this._setT(c, T[i]); if (c.offsetHeight <= 1046) { t = T[i]; break; } }
    this._setT(c, t);
    // 단일 프로그램(당일 1건)은 무조건 A4 1장: 남는 초과분은 축소해서 맞춤
    const nProg = ((this.state.contract || {}).programs || []).length || 1;
    const hh = c.offsetHeight;
    // 잘림 방지: 원본 높이 그대로 보관. 1장 맞춤은 인쇄 시 전체 축소로 처리
    c.style.minHeight = hh > 1046 ? '' : '1046px';
    c.setAttribute('data-onepage', hh <= 1046 || nProg <= 1 ? '1' : '0');
    const html = c.outerHTML; box.remove(); return html;
  }
  // 서명 문서 생성: 현재 화면을 문서로 만들어 새 문서 목록을 돌려줌 (기기 기록·화면 반영은 commitSigned 성공 후)
  buildDoc(kind, title, C) {
    const html = this.snapshotDoc();
    const today = Component.today();
    const docs0 = this.state.docs || [];
    const p = C.patient || {}, pk = (p.name || '') + '|' + (p.birth || '');
    // 버전은 같은 계약(id)의 같은 종류 문서끼리만 관리 (같은 환자·같은 프로그램의 다른 계약 문서를 대체 처리하지 않음)
    const mine = d => d.kind === kind && (C.id ? d.contractId === C.id : (d.pk === pk && d.program === C.program));
    const same = docs0.filter(mine);
    const version = same.length + 1;
    const fileName = [p.name || '환자', (p.birth || '').replace(/-/g, ''), today.replace(/-/g, ''), kind + (version > 1 ? '_v' + version : '')].filter(Boolean).join('_') + '.pdf';
    const id = 'D' + Date.now();
    const docs = docs0.map(d => mine(d) ? { ...d, superseded: true } : d)
      .concat([{ id, contractId: C.id || null, pk, kind, title, program: C.program, nProg: (C.programs || []).length || 1, version, signedAt: today, fileName, html, superseded: false, priceSnap: C.priceSnap || null }]);
    return { docs, id };
  }
  // 서명 저장: 계약 → 서명 문서 순으로 기기에 기록하고 다시 읽어 확인. 하나라도 실패하면 이번에 쓴 기록을 원래대로 되돌리고 false
  // (계약만 저장되고 문서가 없는 상태·재시도 시 중복 계약을 만들지 않음. 화면의 작성 내용·서명은 호출한 쪽에서 그대로 둠)
  commitSigned(contracts, docs) {
    const KC = 'dachaeum.v3.contracts', KD = 'dachaeum.v3.docs', prev = {};
    const put = (k, v) => { prev[k] = localStorage.getItem(k); localStorage.setItem(k, v); if (localStorage.getItem(k) !== v) throw new Error('verify ' + k); };
    try {
      if (contracts) put(KC, JSON.stringify(contracts.filter(x => !x.sample)));
      put(KD, JSON.stringify(docs));
      return true;
    } catch (e) {
      Object.keys(prev).forEach(k => { try { if (prev[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, prev[k]); } catch (e2) {} });
      return false;
    }
  }

  pvRef = el => this._obs(el, 'pvH');
  sgRef = el => this._obs(el, 'sgH');
  _obs(el, key) {
    this._ro = this._ro || {};
    if (this._ro[key]) { this._ro[key].disconnect(); this._ro[key] = null; }
    if (!el || typeof ResizeObserver === 'undefined') return;
    this._els = this._els || {}; this._els[key] = el;
    const ro = new ResizeObserver(() => setTimeout(() => {
      if (Date.now() - (this._fitAt || 0) > 120) { this._fitAt = Date.now(); this._fit(el); }
      const h = el.offsetHeight; if (h && h !== this.state[key]) this.setState({ [key]: h }); }));
    ro.observe(el); this._ro[key] = ro;
  }
  componentWillUnmount() { Object.values(this._ro || {}).forEach(r => r && r.disconnect()); }
  // 동의서 타이포 단계: 패드(서명)는 가장 넉넉한 단계, 인쇄/미리보기는 A4 한 장에 들어가는 가장 큰 단계를 자동 선택.
  static TIERS = [
    { tx: 14, lh: 1.9, sg: 16, bg: 6, tt: 15, tb: 5, tbl: 13, cp: '20px 24px' },   // 0: 패드
    { tx: 13, lh: 1.85, sg: 14, bg: 5, tt: 14, tb: 4, tbl: 12.5, cp: '18px 22px' },
    { tx: 12.5, lh: 1.8, sg: 12, bg: 4, tt: 13.5, tb: 3, tbl: 12, cp: '16px 20px' },
    { tx: 12, lh: 1.72, sg: 10, bg: 3, tt: 13, tb: 2, tbl: 12, cp: '14px 18px' },
    { tx: 11.5, lh: 1.62, sg: 8, bg: 2, tt: 12.5, tb: 2, tbl: 11.5, cp: '13px 17px' },
    { tx: 11, lh: 1.55, sg: 6, bg: 0, tt: 12, tb: 1, tbl: 11.5, cp: '12px 16px' }
  ];
  _fit(wrap) {
    const doc = wrap && wrap.firstElementChild; if (!doc || !wrap.isConnected) return;
    const A4 = 1046, W = 740, MIN = 0.62, T = Component.TIERS;
    if (!this._printHooked && typeof window !== 'undefined') {
      this._printHooked = true;
      const all = () => Object.values(this._els || {}).forEach(el => this._fit(el));
      window.addEventListener('beforeprint', () => { this._printing = true; all(); });
      window.addEventListener('afterprint', () => { this._printing = false; all(); });
    }
    const setT = t => this._setT(doc, t);
    const vis = () => { const ws = wrap.getBoundingClientRect().width / W; return ws ? doc.getBoundingClientRect().height / ws : 0; };
    const apply = z => { doc.style.zoom = z === 1 ? '' : String(z); doc.style.width = (W / z) + 'px'; doc.style.maxWidth = (W / z) + 'px'; };
    const prevKey = (doc.style.zoom || '1') + '|' + doc.style.getPropertyValue('--tx');
    const padMode = wrap === (this._els || {}).sgH && !this._printing;
    doc.style.fontFamily = padMode ? "Pretendard, 'Apple SD Gothic Neo', sans-serif" : '';
    doc.style.color = padMode ? '#111418' : '';
    let z = 1;
    if (padMode) {
      // 패드: 글자 크기는 유지, 줄·문단 간격과 여백만 압축해 스크롤 단축
      setT({ tx: 14, lh: 1.62, sg: 9, bg: 3, tt: 15, tb: 2, tbl: 13, cp: '14px 18px' });
      z = Math.max(1, Number(this.props.padTextScale ?? 1));
      apply(z); doc.style.minHeight = '0px';
    } else {
      doc.style.minHeight = '0px'; apply(1);
      let picked = -1;
      for (let i = 1; i < T.length; i++) { setT(T[i]); if (vis() <= A4) { picked = i; break; } }
      if (picked < 0) {
        setT(T[T.length - 1]);
        let h = vis(); z = A4 / h;
        for (let i = 0; i < 4; i++) { apply(z); h = vis(); if (!h) break; z = Math.min(1, z * Math.pow(A4 / h, 0.9)); }
        apply(z); if (vis() > A4) z *= 0.985;
        if (z < MIN) z = 1;
        apply(z);
      }
      doc.style.minHeight = (A4 / z) + 'px';
    }
    const key = (doc.style.zoom || '1') + '|' + doc.style.getPropertyValue('--tx');
    if (key !== prevKey) { const h2 = wrap.offsetHeight; if (h2) this.setState({ [wrap === (this._els || {}).pvH ? 'pvH' : 'sgH']: h2 }); }
  }
  // 열린 문서를 실제 PDF 파일(A4 1장)로 미리 만들어 둠 → 버튼을 누르면 바로 공유 시트
  // 저장된 문서 스냅샷(doc.html)만 사용. 같은 문서는 처음 만든 PDF 파일을 다시 씀 (조회만으로 문서·계약·버전은 바뀌지 않음)
  async buildPdf(doc) {
    const key = doc.id; this._pdfKey = key; this._pdfCache = this._pdfCache || {};
    if (this._pdfCache[key]) { this._pdfFile = this._pdfCache[key]; this.setState({ pdfReady: true }); return; }
    this._pdfFile = null; this.setState({ pdfReady: false });
    for (let i = 0; i < 50 && !(window.html2canvas && window.jspdf && document.getElementById('pdfv')); i++) await new Promise(r => setTimeout(r, 100));
    const el = document.getElementById('pdfv');
    if (!el || !window.html2canvas || !window.jspdf) { if (this._pdfKey === key) this.setState({ pdfReady: 'fail' }); return; }
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const cv = await window.html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false, windowWidth: el.scrollWidth });
      if (this._pdfKey !== key) return;
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
      const M = 8, AW = 210 - M * 2, AH = 297 - M * 2;
      const r = Math.min(AW / cv.width, AH / cv.height);
      const w = cv.width * r, hh = cv.height * r;
      pdf.addImage(cv.toDataURL('image/jpeg', 0.92), 'JPEG', (210 - w) / 2, M, w, hh);
      const blob = pdf.output('blob');
      if (this._pdfKey !== key) return;
      this._pdfFile = this._pdfCache[key] = new File([blob], doc.fileName, { type: 'application/pdf' });
      this.setState({ pdfReady: true });
    } catch (e) { if (this._pdfKey === key) this.setState({ pdfReady: 'fail' }); }
  }
  sharePdf() {
    // 생성 실패 시에만 같은 저장 문서로 다시 시도 (새 계약·새 버전·재서명 없음)
    if (this.state.pdfReady === 'fail') { const d = (this.state.docs || []).find(x => x.id === this.state.pdfId); if (d) this.buildPdf(d); return; }
    const f = this._pdfFile; if (!f) return this.flash('PDF를 만드는 중입니다. 잠시 후 다시 눌러 주세요');
    if (navigator.canShare && navigator.canShare({ files: [f] })) { navigator.share({ files: [f], title: f.name }).catch(() => {}); return; }
    const url = URL.createObjectURL(f); const a = document.createElement('a'); a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  componentDidUpdate(pp, ps) {
    if ((this.state.screen === 'refund' || this.state.screen === 'refundSign') && ['rfUsed', 'rfVisits', 'rfLes', 'rfVar', 'rfAlloc', 'rfReason'].some(k => this.state[k] !== (ps || {})[k])) {
      clearTimeout(this._draftT); this._draftT = setTimeout(() => this.saveDraft(), 300); }
    // PDF는 문서를 열 때 한 번만 만듦 (이전 상태값과 비교하지 않고 열린 문서 id로 판단 → 화면이 다시 그려져도 반복 생성하지 않음)
    const pid = this.state.pdfId || null;
    if (pid !== this._pdfOpenFor) { this._pdfOpenFor = pid; const d = pid && (this.state.docs || []).find(x => x.id === pid); if (d) setTimeout(() => this.buildPdf(d), 50); }
    cancelAnimationFrame(this._fitRaf);
    this._fitRaf = requestAnimationFrame(() => Object.values(this._els || {}).forEach(el => this._fit(el)));
  }

  defaultContract = {
    patient: { name: '박서연', birth: '1991-04-12', phone: '010-2847-1193' },
    program: '리쥬란 스킨부스터 8회', cat: '스킨부스터', date: '2026-08-24', expiry: '2027-08-23',
    total: 3600000, paid: 3600000, pay: 'full', method: '카드', cap: null, svcVisit: false,
    items: [
      { kind: '시술', name: '리쥬란 HB 2cc', qty: 6, price: 500000 },
      { kind: '시술', name: '리쥬란 힐러 2cc', qty: 2, price: 500000 },
      { kind: '서비스', name: '재생관리 (LDM)', qty: 4, price: 80000 },
      { kind: '서비스', name: '진정관리', qty: 2, price: 50000 }
    ],
    used: [2, 0, 1, 1], visits: []
  };
  setUsed(k, d, C) {
    this.setState(st => {
      const u = [...(st.rfUsed || C.used || C.items.map(() => 0))];
      const it = C.items[k]; const v = (u[k] || 0) + d;
      if (v < 0 || (it.kind !== '추가' && !it.actual && it.qty && v > it.qty)) return null;
      if (C.cap && d > 0 && u.reduce((a, b) => a + (b || 0), 0) >= C.cap) return null;
      u[k] = v; return { rfUsed: u };
    });
  }

  // 번호 페이지네이션: 한 페이지를 넘을 때만 표시. 1 … 4 5 6 … 12 형태
  pager(total, size, key) {
    const n = Math.max(1, Math.ceil(total / size)), cur = Math.min(Math.max(1, this.state[key] || 1), n);
    const go = p => () => this.setState({ [key]: Math.min(Math.max(1, p), n) });
    const nums = n <= 7 ? [...Array(n)].map((_, i) => i + 1)
      : cur <= 4 ? [1, 2, 3, 4, 5, '…', n] : cur >= n - 3 ? [1, '…', n - 4, n - 3, n - 2, n - 1, n] : [1, '…', cur - 1, cur, cur + 1, '…', n];
    return { show: n > 1, cur, start: (cur - 1) * size, size,
      prev: go(cur - 1), next: go(cur + 1), prevFg: cur > 1 ? '#2b3036' : '#c9ced4', nextFg: cur < n ? '#2b3036' : '#c9ced4',
      pages: nums.map(v => { const on = v === cur, dots = v === '…';
        return { label: String(v), go: dots ? () => {} : go(v), bg: on ? '#2b3036' : 'transparent', fg: on ? '#ffffff' : (dots ? '#8d949b' : '#2b3036'), cur: dots ? 'default' : 'pointer' }; }) };
  }

  // 예시 환자 없음 (병원 실사용)
  sampleContracts() { return []; }

  // 결제 정보 입력 완료 기준 (카드: 카드사·뒤4자리·결제일·승인번호 8자리 / 현금영수증 발급: 발급번호·승인번호 9자리)
  payDone(p) {
    const n = v => String(v || '').replace(/[^0-9]/g, '').length;
    if (p.method === '카드') return !!(p.bank && (p.bank !== '기타' || (p.bankEtc || '').trim()) && n(p.cardNo) === 4 && p.payDate && n(p.approval) === 8);
    return p.rcpt !== '발급' || (n(p.rcptNo) >= 10 && n(p.rcptAppr) === 9);
  }

  catLabel(c) { return c === '쁘띠(보톡스·필러)' ? '쁘띠' : c === '홍조·혈관' ? '홍조' : c; }

  catCfg(cat, db, inPcat) {
    const BOTOX = ['주름', '사각턱·침샘', '스킨보톡스', '종아리·승모근', '다한증'];
    if (cat === '쁘띠(보톡스·필러)') {
      const prod = p => ((p.baseName || p.name).match(/뉴라미스|벨로테로/) || [])[0] || '';
      return {
        subs: [{ label: '보톡스', test: p => BOTOX.includes(p.sub) },
               { label: '필러', test: p => p.sub === '필러' }],
        axesFor: sub => sub === '보톡스'
          ? [{ label: '유형', vals: BOTOX, test: (p, v) => p.sub === v }, { label: '제품', key: '제품' }]
          : sub === '필러'
            ? [{ label: '제품', vals: ['뉴라미스', '벨로테로'], test: (p, v) => prod(p) === v }]
            : []
      };
    }
    if (cat === '여드름') {
      return {
        subs: ['1회', '부분', '프로그램', '주사·약처방'].map(n => ({ label: n, test: p => p.sub === n })),
        axesFor: sub => (!sub || ['주사·약처방', '1회', '부분', '프로그램'].includes(sub)) ? []
          : [{ label: '부위', key: '부위' }, { label: '횟수', key: '횟수' }]
      };
    }
    if (cat === '리프팅') {
      return {
        subs: [{ label: '울쎄라', test: p => p.sub === '울쎄라' },
               { label: '올리지오', test: p => p.sub === '올리지오' || (p.sub === '결합' && (p.baseName || p.name).includes('올리지오')) },
               { label: '세르프', test: p => p.sub === '세르프' || (p.sub === '결합' && (p.baseName || p.name).includes('세르프')) },
               { label: '기타', test: p => p.sub === '기타' }],
        axes: [{ label: '원장님', key: '원장' }]
      };
    }
    if (cat === '제모') {
      return {
        subs: [{ label: '남성', test: p => p.sub !== '여성 얼굴' },
               { label: '여성', test: p => p.sub !== '남성 얼굴' }],
        axesFor: sub => sub ? [
          { label: '부위', vals: ['페이스', '바디'], test: (p, v) => v === '바디' ? p.sub === '바디' : p.sub !== '바디' },
          { label: '횟수', key: '횟수' }] : []
      };
    }
    const names = ((db && db.subOrder && db.subOrder[cat]) || []).filter(n => inPcat.some(p => p.sub === n));
    return {
      subs: names.map(n => ({ label: n, test: p => p.sub === n })),
      axes: [...new Set(inPcat.flatMap(p => Object.keys(p.filters || {})))]
        .map(k => ({ label: k === '원장' ? '원장님' : k, key: k }))
    };
  }

  // 저장된 문서 HTML을 다시 그릴 때 스크립트·이벤트 속성 제거 (localStorage 변조 대비)
  cleanHtml(h) {
    const t = document.createElement('template'); t.innerHTML = String(h || '');
    t.content.querySelectorAll('script,iframe,object,embed,link,meta,base,form').forEach(n => n.remove());
    t.content.querySelectorAll('*').forEach(n => [...n.attributes].forEach(a => {
      if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name); }));
    return t.innerHTML;
  }

  // 이벤트 적용: 꺼진 이벤트 패키지·숨김 항목 제외, 켜진 서비스 이벤트는 해당 프로그램에 서비스권 추가
  applyEvents(db) {
    // LDM Triple 추가는 선택 항목 (저장된 가격표에도 적용)
    db = { ...db, programs: (db.programs || []).map(p => (p.adds || []).some(a => a.id === 'LDM_TRIPLE')
      ? { ...p, adds: p.adds.map(a => a.id === 'LDM_TRIPLE' ? { ...a, optional: true, name: a.name.replace(/\s*\(\s*\d+\s*회\s*\)/g, '') } : a) } : p) };
    // 사용 여부 + 적용 기간(가격 관리 → 이벤트)으로 판단. 정액 적용가 이벤트 프로그램의 묶음 제목은 이벤트명을 따름
    const today = Component.today(), CT = window.DachaeumCatalog;
    const evs = db.events || [], evOf = id => evs.find(x => x.id === id), on = id => { const e = evOf(id); return !e || CT.eventOn(e, today); };
    const svc = evs.filter(e => e.kind === 'service' && CT.eventOn(e, today) && e.item);
    const programs = (db.programs || []).filter(p => !p.hidden && (!p.event || on(p.event))).map(p => {
      const extra = svc.filter(e => !p.event && new RegExp(e.matchRe).test(p.baseName || p.name) && !(p.items || []).some(i => i.id === e.item.id));
      const q = p.event && evOf(p.event) && evOf(p.event).name && p.g ? { ...p, g: evOf(p.event).name } : p;
      return extra.length ? { ...q, items: (q.items || []).concat(extra.map(e => ({ ...e.item, cat: q.cat }))) } : q;
    });
    return { ...db, programs };
  }

  componentDidMount() {
    // 환불 정산 작성 중 화면을 닫거나 다른 앱으로 전환하면 바로 저장
    const flushDraft = () => { if (this.state.screen === 'refund' || this.state.screen === 'refundSign') { clearTimeout(this._draftT); this.saveDraft(); } };
    window.addEventListener('pagehide', flushDraft);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushDraft(); });
    try { const d = JSON.parse(localStorage.getItem('dachaeum.v3.docs') || '[]'); if (d.length) this.setState({ docs: d }); } catch (e) {}
    this.setState({ drafts: this.readDrafts() });
    try { const k = JSON.parse(localStorage.getItem('dachaeum.v3.contracts') || '[]'); this.setState(st => ({ contracts: (st.contracts || []).filter(c => c.sample).concat(k) })); } catch (e) {}
    try {
      const m = (location.hash || '').match(/sel=([^&]+)/);
      const raw = m ? decodeURIComponent(m[1]) : localStorage.getItem('dachaeum.selection');
      if (raw) {
        this.setState({ picked: JSON.parse(raw) });
        if (m) localStorage.setItem('dachaeum.selection', raw);
      }
    } catch (err) {}
    try {
      // 가격표: 번들에 들어 있는 파일(Blob)을 직접 읽음. 보안 정책상 blob: 주소 fetch를 막는 환경(예: claude.ai 시험 페이지)에서도 동작. 없으면 기존 fetch
      const dbSrc = (window.__resources && window.__resources.programsDb) || 'programs.json', dbBlob = window.__resourceBlobs && window.__resourceBlobs[dbSrc];
      (dbBlob && dbBlob.text ? dbBlob.text().then(t => JSON.parse(t)) : fetch(dbSrc).then(r => r.json())).then(base => new Promise(res => { const w = () => window.DachaeumCatalog ? res(base) : setTimeout(w, 40); w(); })).then(base => {
        // 최신 programs.json + 가격 관리 override(변경 항목만)
        const merge = b => window.DachaeumCatalog.withOverride(b);
        const db = merge(base);
        const dbx = this.applyEvents(db);
        this.setState(st => { const real = (st.contracts || []).filter(c => !c.sample);
          return { db: dbx, contracts: this.sampleContracts(dbx).filter(sc => !real.some(c => c.id === sc.id)).concat(real) }; });
        // 가격 관리에서 바꾸면 바로 반영 (다른 탭 저장 · 화면 복귀 시)
        this._base = base;
        // 비교 기준은 합친 가격 데이터 전체 (길이만 비교하면 같은 길이의 이름·할인율 변경을 놓침)
        const reload = () => { const d = merge(this._base);
          const key = JSON.stringify(d);
          if (key === this._dbKey) return; this._dbKey = key; this.setState({ db: this.applyEvents(d) }); };
        this._dbKey = JSON.stringify(db);
        this._reload = reload;
        // 다른 탭에서 총 등록금액·1회 정상가·이벤트 설정을 바꾸면 반영 (새 계약 작성에만 쓰이고, 저장된 계약·서명 문서는 계약 당시 값 유지)
        const WATCH = [window.DachaeumCatalog.OV_KEY, window.DachaeumCatalog.UNIT_KEY, window.DachaeumCatalog.EVENT_KEY];
        window.addEventListener('storage', e => { if (e.key === null || WATCH.includes(e.key)) reload(); });
        window.addEventListener('focus', reload);
        window.addEventListener('pageshow', reload);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) reload(); });
      });
    } catch (err) {}
  }

  // 횟수 선택지 목록 → − / + 스테퍼 (선택된 항목 = 기본색 테두리)
  stepOf(list) {
    const L = list || [], ix = L.findIndex(o => o.bd === '#030213');
    const go = j => { const o = L[j]; if (o && j !== ix) o.pick(); };
    return { label: ix >= 0 ? L[ix].label : '횟수 선택', sub: ix >= 0 ? (L[ix].sub || '') : L.length + '가지',
      decFg: ix > 0 ? '#345b80' : '#c9ced4', incFg: ix < L.length - 1 ? '#345b80' : '#c9ced4',
      dec: () => ix > 0 && go(ix - 1), inc: () => go(ix < 0 ? 0 : Math.min(L.length - 1, ix + 1)) };
  }

  renderVals() {
    // 계산 기준: pricing.js (금액·할인·선결제권·결제) / refund.js (환불 계산·검증) / catalog.js (서비스 후보) — 로드 전에는 잠시 대기
    const PR = window.DachaeumPricing, RF = window.DachaeumRefund, CAT = window.DachaeumCatalog;
    if (!PR || !RF || !CAT) { clearTimeout(this._waitRules); this._waitRules = setTimeout(() => this.forceUpdate(), 40); return {}; }
    const s = this.state, S = s.screen;
    const isSign = S === 'sign', isRefundSign = S === 'refundSign';
    const won = n => Number(n || 0).toLocaleString('ko-KR');
    const todayISO = Component.today();
    const isResign = s.signFrom === 'resign';
    const pk = s.picked;
    const pkProgs = pk && pk.programs && pk.programs.length ? pk.programs : null;
    const progs = [
      { name: '리쥬란 스킨부스터 8회', desc: '3주 간격 · 유효기간 12개월', price: '3,600,000원', unit: '회당 450,000원' },
      { name: '울쎄라 300샷 패키지', desc: '1회 시술 + 관리 2회', price: '2,800,000원', unit: '패키지' },
      { name: '제네시스 레이저 10회', desc: '2주 간격 · 유효기간 12개월', price: '1,500,000원', unit: '회당 150,000원' },
      { name: '수액 프로그램 12회', desc: '주 1회 권장', price: '960,000원', unit: '회당 80,000원' }
    ];
    const rowsRaw = [];
    // 목록: 저장된 모든 계약 + (저장 전) 현재 계약
    const allC = (s.contracts || []).slice();
    if (s.contract && !allC.some(c => c.id && c.id === s.contract.id)) allC.push(s.contract);
    allC.forEach((c0, ci) => rowsRaw.push([c0.patient.name, c0.program, c0.date, won(c0.total), c0 === s.contract ? s.cStatus : this.statusOf(c0), /선결제/.test(c0.program), c0.patient.phone || '', ci]));
    const pendRow = s.pendingSign ? [(s.patient && s.patient.name) || '이름 미입력', s.pendingProg || '—', todayISO, s.pendingTotal || '—', '서명대기', false, (s.patient && s.patient.birth) || ''] : null;
    if (pendRow) rowsRaw.unshift(pendRow);
    const lq = (s.lq || '').trim();
    const sk = s.sortKey || 'date', sd = s.sortDir || (sk === 'date' ? 'desc' : 'asc');
    const cmp = (a, b) => (sk === 'name' ? a[0].localeCompare(b[0], 'ko') : String(a[2]).localeCompare(String(b[2]))) * (sd === 'asc' ? 1 : -1);
    const rows = rowsRaw.filter(r => (!lq || r[0].includes(lq) || (/^[0-9-]+$/.test(lq) && String(r[6] || '').replace(/[^0-9]/g, '').includes(lq.replace(/[^0-9]/g, ''))))).sort(cmp).map(r => { const [bg, fg, bd] = this.chip(r[4]); return {
      name: r[0], program: r[1], date: r[2], amount: r[3], status: r[4], bg, fg, bd, prepaid: r[5], progText: r[1], prepaidTag: '선결제 ' + Math.round(Number(String(r[3]).replace(/[^0-9]/g, '')) / 10000), refunded: r[4] === '환불완료',
      open: () => r === pendRow ? this.setState({ screen: 'new', step: 4 }) : this.setState({ screen: 'detail', tab: 'status', justSaved: null, cSel: false, payDraft: null, ...(typeof r[7] === 'number' && allC[r[7]] !== s.contract ? { contract: allC[r[7]], cStatus: r[4], ...this.rfStateOf(allC[r[7]]) } : {}) }) }; });
    const listPg = this.pager(rows.length, 10, 'listPage');
    const fmtBirth = v => v.replace(/[^0-9]/g, '').slice(0, 6);
    const fmtPhone = v => { const d = v.replace(/[^0-9]/g, '').slice(0, 11); return d.length > 7 ? d.slice(0, 3) + '-' + d.slice(3, d.length - 4) + '-' + d.slice(-4) : d.length > 3 ? d.slice(0, 3) + '-' + d.slice(3) : d; };
    const P = s.patient || {};
    const pfDefs = [
      ['name', '성명', '이름', 'text', v => v.slice(0, 20), v => !!v.trim(), '성명을 입력해 주세요'],
      ['birth', '생년월일', '970727', 'numeric', fmtBirth, v => v.length === 6, '6자리 숫자로 입력해 주세요 (예: 970727)'],
      ['phone', '연락처', '01012345678', 'tel', fmtPhone, v => v.length >= 12, '연락처를 확인해 주세요']];
    const pFields = pfDefs.map(([k, label, ph, im, fmt, ok, msg]) => { const v = P[k] || ''; const bad = !!s.tried1 && !ok(v);
      return { label, ph, im, value: v, hasErr: bad, errText: msg, bd: bad ? '#d4183d' : 'transparent', bg: '#f3f3f5',
        onInput: e => { const nv = fmt(e.target.value); this.setState(st => ({ patient: { ...(st.patient || {}), [k]: nv } })); } }; });
    const p1ok = pfDefs.every(d => d[5](P[d[0]] || ''));
    // 동명이인·기존 환자 안내: 이름 입력 시 같은 이름의 기존 계약을 환자별로 묶어 표시. 생년월일까지 같으면 '동일인 가능성'
    const dup = (() => {
      // 이름 + 생년월일(6자리, 예: 950312)까지 입력된 뒤에 표시
      const nm = (P.name || '').trim(), bd = String(P.birth || '').replace(/[^0-9]/g, '');
      if (!nm || bd.length < 6 || s.step !== 1 || s.dupOff === nm + '|' + P.birth) return null;
      const src = (s.contracts || []).concat(s.contract ? [s.contract] : []);
      const g = {}; src.forEach(c => { const p = c.patient || {}; if ((p.name || '').trim() !== nm || String(p.birth || '').replace(/[^0-9]/g, '') !== bd) return;
        const k = nm + '|' + (p.birth || ''); (g[k] = g[k] || { p, n: 0, last: '' });
        if (!g[k].ids) g[k].ids = new Set(); const id = c.id || c.date + c.program; if (!g[k].ids.has(id)) { g[k].ids.add(id); g[k].n++; }
        if ((c.date || '') >= g[k].last) { g[k].last = c.date || ''; g[k].lastProg = c.program; } });
      const rows = Object.values(g); return rows.length ? rows : null; })();
    const NOTICE = {};

    const steps = ['환자 정보', '프로그램 · 구성', '결제 등록', '미리보기 · 서명'].map((label, i) => {
      const n = i + 1, done = n < s.step, cur = n === s.step;
      return { n, label, done, notDone: !done, weight: cur ? 600 : 500, fg: cur ? '#0a0a0a' : done ? '#4b5563' : '#9ca3af',
        dotBg: cur ? '#030213' : done ? '#ffffff' : '#ffffff', dotFg: cur ? '#ffffff' : done ? '#030213' : '#9ca3af',
        dotBd: cur ? '#030213' : done ? '#030213' : 'rgba(0,0,0,0.1)', lineBg: done ? '#030213' : 'rgba(0,0,0,0.1)' };
    });

    const db = s.db;
    // 목록 규칙은 programs.json → listRules 에서 관리
    const LR = (db && db.listRules) || {};
    const NO_AXES = LR.noAxes || [], HIDE_AXES = LR.hideAxes || {}, AREA_SPLIT = LR.areaSplit || [], SUM_ALWAYS = LR.sumOnMulti || [];
    // 당일 종료 1회 시술은 동의서 대상 아님 → 목록 제외. 장비 카드(g)·여드름 1회·listed 표시 항목은 예외
    const oneTime = p => !p.g && p.sub !== '1회' && !p.listed && !p.lesion && (p.cat === '쁘띠(보톡스·필러)' || p.cat === 'CO₂·병변제거' || (() => {
      const it = (p.items || []).filter(i => !/염증주사|약\s?처방/.test(i.name || '') && i.kind !== '서비스권');
      return it.length === 1 && (Number(it[0].qty) || 1) <= 1; })());
    const dbAll = db ? db.programs.filter(p => !oneTime(p)) : [];
    const dbq = s.pq.trim().toLowerCase();
    const q = p => !dbq || p.name.toLowerCase().includes(dbq) || p.id.toLowerCase().includes(dbq) || String(p.baseName || '').toLowerCase().includes(dbq);
    // 이벤트 프로그램은 '이벤트' 탭에만 표시
    const inPcat = dbAll.filter(p => s.pcat !== '전체' && q(p) && (s.pcat === '이벤트' ? !!p.event : (p.cat === s.pcat && !p.event)));
    const cfg = this.catCfg(s.pcat, db, inPcat);

    const TAB_ORDER = ['색소', '홍조·혈관', '여드름', '흉터·모공', '리프팅', '제모', '스킨부스터', '부분치료', '쁘띠(보톡스·필러)'];
    const catsSorted = db ? TAB_ORDER.concat(db.cats.filter(c => !TAB_ORDER.includes(c))) : [];
    // 이벤트 탭은 항상 맨 앞에 고정 (진행 중 이벤트가 없어도 표시)
    const pTabs = db ? [{ label: '이벤트', v: '이벤트' }]
      .concat(catsSorted.filter(c => dbAll.some(p => p.cat === c && !p.event)).map(c => ({ label: this.catLabel(c), v: c })))
      .concat([{ label: '전체', v: '전체' }])
      .map(t => { const on = s.pcat === t.v; return { ...t,
        bg: 'transparent', fg: on ? '#0a0a0a' : '#717182', bd: on ? '#030213' : 'transparent', tbg: on ? '#ffffff' : 'transparent', tbd: on ? 'rgba(0,0,0,0.1)' : 'transparent',
        onClick: () => this.setState({ pcat: t.v, psub: '', paxis: {}, prog: -1, progId: '' }) }; }) : [];

    // 실제 프로그램이 없는 소분류 탭은 숨김
    cfg.subs = cfg.subs.filter(sb => inPcat.some(p => sb.test(p)));
    const subDef = cfg.subs.find(x => x.label === s.psub) || null;
    const scope = inPcat.filter(p => !subDef || subDef.test(p));
    const pSubs = cfg.subs.length > 1 ? cfg.subs.map(sb => { const on = !!subDef && subDef.label === sb.label; return {
      label: sb.label, fg: on ? '#030213' : '#717182', fw: on ? 600 : 500,
      line: on ? '#030213' : 'transparent',
      onClick: () => this.setState({ psub: on ? '' : sb.label, paxis: {}, prog: -1, progId: '' }) }; }) : [];

    const axMatch = (a, p, v) => a.test ? a.test(p, v) : (p.filters || {})[a.key] === v;
    const pAxes = (cfg.axesFor ? cfg.axesFor(s.psub) : cfg.axes).map(a => {
      const vals = (a.vals || [...new Set(scope.map(p => (p.filters || {})[a.key]).filter(Boolean))])
        .filter(v => scope.some(p => axMatch(a, p, v)));
      const sel = (s.paxis || {})[a.label] || '';
      return { ...a, vals, sel, opts: [{ v: '', label: '전체' }].concat(vals.map(v => ({ v, label: v }))),
        onChange: e => { const v = e.target.value;
          this.setState(st => ({ paxis: { ...st.paxis, [a.label]: v }, prog: -1, progId: '' })); } };
    }).filter(a => a.vals.length > 1 && !NO_AXES.includes(s.pcat) && !(HIDE_AXES[s.pcat] || []).includes(a.label));

    const dbHits = (s.pcat === '전체' ? dbAll.filter(q) : scope)
      .filter(p => pAxes.every(a => !a.sel || axMatch(a, p, a.sel)));

    const svcOn = s.pcat === '여드름' && s.psub === '주사·약처방';
    const svcRows = svcOn && db ? [
      { name: '염증주사', note: '내원 회차별 부위 수로 각각 계산',
        lines: db.acneSvc.filter(r => r['서비스권 ID'] === 'SERVICE_INFLAMMATION_INJ')
          .map(r => ({ t: r['사용 범위/기간'] + ' · ' + won(r['정상가']) + '원' })) },
      { name: '여드름 약처방', note: '처방 건별로 각각 계산',
        lines: db.acneSvc.filter(r => r['서비스권 ID'] === 'SERVICE_PRESCRIPTION')
          .map(r => ({ t: r['사용 범위/기간'] + ' · ' + won(r['정상가']) + '원' })) }
    ] : [];

    const progTitle = p => p.name;
    const srcForCards = pkProgs || dbHits;
    const progList = srcForCards.length
      ? srcForCards.map(p => ({ id: p.id, sub: p.sub, cat: p.cat, g: p.g, r: p.r, o: p.o, event: p.event || '', name: progTitle(p), baseName: p.baseName || p.name, desc: p.cat + ' · ' + p.id,
          price: p.lesion ? '1개 ' + won((p.lesionTiers || [{}])[0].price || 0) + '원~' : p.total ? won(p.total) + '원' : '금액 입력',
          // 같은 이름 프로그램 구분: 추가 항목명만 짧게 (개수 표기 대신)
          ...(() => { const ad = (p.adds || []).filter(a => !a.optional).map(a => String(a.name || '').replace(/\s*\(.*?\)/g, '').replace(/\s*\d+\s*회$/, '').trim()).filter(Boolean);
            const dup = srcForCards.filter(q => q.name === p.name).length > 1;
            const u = ad.length ? '기본 + ' + ad.join(' · ') : dup ? '기본 구성' : '';
            return { unit: u, hasDiff: !!u }; })() }))
      : (db ? [] : progs); // 가격표가 로드된 뒤에는 빈 결과를 샘플로 채우지 않음
    const pickSource = pkProgs || (dbHits.length ? dbHits : null);
    const pIdx = Math.min(s.prog, (pickSource ? pickSource.length : progList.length) - 1);
    const held = s.progId ? dbAll.find(p => p.id === s.progId) : null;
    // 제모 여러 부위: 합산 → 결합할인 (인중·겨드랑이·남성 지정 결합상품은 부위 수·할인 대상 제외)
    const hairIds = s.hairIds || [];
    const hairPs = held ? [] : hairIds.map(id => dbAll.find(p => p.id === id)).filter(Boolean);
    const { elig: hairElig, rate: hairRate, off: hairOff, sum: hairSum } = PR.hairCombo(hairPs);
    const hairCur = hairPs.length === 1 ? hairPs[0] : hairPs.length > 1 ? { ...hairPs[0], id: 'HAIR-' + hairPs.map(p => p.id).join('+'),
      name: hairPs.map(p => p.name).join(' + '), total: String(hairSum - hairOff), adds: [],
      items: hairPs.reduce((a, p) => a.concat(p.items || []), []) } : null;
    const cur0 = held || hairCur || (pickSource && s.prog >= 0 ? pickSource[Math.max(0, pIdx)] : null);
    // 서명 전 서비스 조정: 제외(svcOff) · 다른 서비스로 교체(svcSwap). 시술은 건드리지 않음
    // 교체 후보: 리프팅 프로그램 포함 서비스 + 리프팅 이벤트 서비스(무통주사 등)만
    const SVC_POOL = CAT.svcPool(db);
    const svcOff = s.svcOff || [], svcSwap = s.svcSwap || {};
    const cur = cur0 ? { ...cur0, items: (cur0.items || []).map((i, k) => {
      if (i.kind !== '서비스권' || /약\s?처방|염증주사/.test(i.name)) return i;
      if (svcOff.includes(k)) return null;
      const sw = svcSwap[k] && SVC_POOL.find(x => x.name === svcSwap[k]);
      return sw ? { ...sw, cat: i.cat, qty: sw.qty || i.qty || '1', swappedFrom: i.name } : i; }).filter(Boolean) } : null;
    const svcEditRows = cur0 ? (cur0.items || []).map((i, k) => ({ i, k })).filter(x => x.i.kind === '서비스권' && !/약\s?처방|염증주사/.test(x.i.name)).map(({ i, k }) => {
      const off = svcOff.includes(k), sw = svcSwap[k] || '';
      return { name: i.name, off, on: !off, strike: off ? 'line-through' : 'none', fg: off ? '#9ca3af' : '#0a0a0a',
        swap: sw, swapOpts: [{ v: '', label: '그대로' }].concat(SVC_POOL.filter(x => x.name !== i.name).map(x => ({ v: x.name, label: '→ ' + x.name }))),
        onSwap: e => this.setState({ svcSwap: { ...svcSwap, [k]: e.target.value } }),
        toggle: () => this.setState({ svcOff: off ? svcOff.filter(x => x !== k) : svcOff.concat(k) }),
        toggleLabel: off ? '되살리기' : '제외' }; }) : [];

    // 모든 구성이 1회인 단건 시술 → 동의서 합계줄 생략
    const singleVisit = !!cur && !SUM_ALWAYS.includes(cur.cat) && (!!cur.g || cur.sub === '1회' || !!cur.listed)
      && (cur.items || []).filter(i => i.qty !== '').every(i => String(i.qty) === '1');
    const capped = !!cur && ((cur.items || []).some(i => i.qtyBasis === '공통 총회차 상한') || !!cur.maxSessions);
    const capN = capped ? (cur.maxSessions || (cur.items || []).find(i => i.qtyBasis === '공통 총회차 상한').qty) : '';
    // 조건별 금액(총 금액 미정) 프로그램: 총 등록금액과 환불용 1회 정상가를 각각 직접 입력 — 서로 자동 계산하지 않음
    const isManual = !!cur && !cur.total && !cur.lesion;
    const manualUnit = isManual ? Number(String((s.units && s.units[cur.id]) || '').replace(/[^0-9]/g, '') || 0) : 0;
    const effUnit = i => isManual && (i.unitFromTotal || !Number(i.unitPrice || 0)) ? manualUnit : Number(i.unitPrice || 0);
    const svcName = n => /스킨보톡스/.test(n) && /뉴럭스/.test(n) ? '스킨보톡스 (뉴럭스)'
      : /LDM\s*Triple/i.test(n) ? 'LDM Triple'
      : n.replace(/\s*\d+\s*회\s*S\/V\s*$/i, '').replace(/\s*S\/V\s*$/i, '');
    const cu = (db && db.capriUnit) || {};
    // 선택형 추가(optional)는 체크한 항목만 동의서·금액에 반영
    const addSel = s.addSel || [];
    // 원장님 서비스로 제공하는 추가 부위(addSvc): 금액 0, 동의서에는 'S/V'로 표시, 환불 시 정가 정산
    const addSvc = s.addSvc || [];
    // 선택형 추가: 전체 n회 중 서비스(S/V) m회 → 유상 (n−m)회 + 서비스 m회 두 줄로 나눔
    const addSvN = s.addSvN || {};
    const svCount = a => { const n = Number(a.qty) || 1; return Math.max(0, Math.min(n, addSvN[a.id] != null ? addSvN[a.id] : (addSvc.includes(a.id) ? n : 0))); };
    const curAdds = cur ? (cur.adds || []).filter(a => !a.optional || addSel.includes(a.id)).flatMap(a => {
      if (!a.optional) return [a];
      const n = Number(a.qty) || 1, m = svCount(a), out = [];
      if (n - m > 0) out.push({ ...a, qty: String(n - m), price: String(Math.round(Number(a.price || 0) * (n - m) / n)) });
      if (m > 0) out.push({ ...a, qty: String(m), price: '0', svc: true });
      return out; }) : [];
    const optAddSum = curAdds.filter(a => a.optional).reduce((t, a) => t + Number(a.price || 0), 0);
    const addUnit = a => /capri-full/.test(a.id || '') ? Number(cu['풀페이스'] || 0)
      : a.needArea ? Number(cu[s.addArea] || 0) : Number(a.unitPrice || 0);
    const addName = a => /capri/.test(a.id || '')
      ? a.name.replace(/\s*\d+\s*회/, '').replace(/\s*\(1부위\)/, '') + (a.needArea && s.addArea ? ' (' + s.addArea + ')' : '')
      : a.name;
    const isSvcItem = i => /염증주사|약\s?처방/.test(i.name || '');
    // 정상가 확인 필요: 가격표에 환불용 1회 정상가가 없는 구성(예: 남성 턱밑라인 포함 제모, 얼굴 전체 CO₂ 제거 추가옵션)
    // 총액을 횟수로 나누거나 다른 항목 가격으로 추정하지 않고, 계약 전에 직원이 직접 입력한 값을 계약에 저장
    const fixKey = k => (cur ? cur.id : '') + '|' + k;
    const fixVal = k => Number(String((s.unitFix || {})[fixKey(k)] || '').replace(/[^0-9]/g, '')) || 0;
    const itemFixKey = i => 'i:' + (i.id || i.name);
    const addFixKey = a => 'a:' + (a.id || a.name) + (a.svc ? ':sv' : '');
    const itemNoUnit = i => !!cur && !cur.lesion && !isSvcItem(i) && i.settleType !== '정산 제외' && !Number(i.settleUnit || 0) && !Number(i.perPiece || 0)
      && !Number(i.unitPrice || 0) && !(isManual && (i.unitFromTotal || !Number(i.unitPrice || 0)));
    const addNoUnit = a => !!cur && !cur.lesion && a.settleType !== '정산 제외' && a.id !== RF.BS_ADD_ID && !a.needArea && !/capri-full/.test(a.id || '')
      && !Number(a.settleUnit || 0) && !Number(a.unitPrice || 0);
    const unitFixLines = !cur ? [] : (cur.items || []).filter(itemNoUnit).map(i => ({ key: itemFixKey(i), name: i.name }))
      .concat(curAdds.filter(addNoUnit).map(a => ({ key: addFixKey(a), name: addName(a) + (a.svc ? ' (서비스)' : '') + ' · 추가옵션' })))
      .filter((x, i, arr) => arr.findIndex(y => y.key === x.key) === i);
    const svcHidden = cur ? (cur.items || []).filter(isSvcItem) : [];
    const svcNote = !!cur && !cur.lesion && (cur.cat === '여드름' || svcHidden.length > 0);
    const svcWhat = !cur ? '' : (cur.cat === '여드름' || svcHidden.some(i => /염증주사/.test(i.name)))
      ? '염증주사 및 여드름 약 처방' : '약 처방';
    const docItems = cur
      ? (cur.items || []).filter(i => !isSvcItem(i)).map(i => ({
          kind: i.kind === '서비스권' ? '서비스' : '시술',
          name: i.kind === '서비스권' ? svcName(i.name) : i.name,
          qtyText: i.kind === '서비스권' ? (i.qty ? i.qty + '회' : '실제 이용분')
            : i.qtyDash ? '-회' : (i.qtyBasis === '공통 총회차 상한' ? '회차별 선택' : (i.qty ? i.qty + (i.unit || '회') : '실제 이용분')),
          priceText: i.priceNote ? i.priceNote
            : itemNoUnit(i) ? (fixVal(itemFixKey(i)) ? won(fixVal(itemFixKey(i))) : '1회 정상가 입력')
            : isManual && (i.unitFromTotal || !Number(i.unitPrice || 0)) ? (effUnit(i) ? won(effUnit(i)) : '1회 정상가 입력')
            : i.kind === '서비스권' && !i.unitPrice && !i.perPiece ? '실제 이용 기준'
            : (i.unitPrice ? won(i.unitPrice) : (i.perPiece ? won(i.perPiece) + '/개' : '미확정'))
        })).concat(curAdds.map(a => { const u = addUnit(a);
          // 수량이 없으면 같은 계열 서비스(예: 얼굴 점 CO₂ 제거) 횟수를 따름 — 표시용, 금액 계산에는 사용 안 함
          const isLes = /흑자|병변/.test(addName(a)), q = a.qty || (/CO₂|CO2/.test(addName(a)) ? ((cur.items || []).find(i => /CO₂|CO2/.test(i.name || '')) || {}).qty : '');
          return { kind: a.svc ? '서비스' : '추가', svc: !!a.svc,
          name: addName(a) + (addNoUnit(a) && fixVal(addFixKey(a)) ? ' · 환불 기준 1회 ' + won(fixVal(addFixKey(a))) + '원' : ''), isAdd: true, addPrice: Number(a.price || 0), addUnitNum: u,
          addQtyText: isLes ? '-' : q ? q + '회' : '-',
          qtyText: isLes ? (a.qty || 1) + '개' : q ? q + '회' : '—',
          priceText: Number(a.price || 0) ? '+' + won(Number(a.price)) + '원' : '실제 이용 기준' }; }))
      : [];

    const manualKey = cur ? cur.id : '';
    const manualAmt = Number(String(s.amounts && s.amounts[manualKey] || '').replace(/[^0-9]/g, '') || 0);
    const isLesion = !!cur && !!cur.lesion;
    const tiers = (cur && cur.lesionTiers) || [];
    const tierOf = sz => { const n = parseFloat(sz); return n > 0 ? tiers.find(t => n <= t.max) || null : null; };
    const LS = s.lesions || [{ site: '', size: '' }];
    const setLesion = (k, f, v) => this.setState(st => { const a = [...(st.lesions || [{ site: '', size: '' }])];
      a[k] = { ...a[k], [f]: v }; return { lesions: a }; });
    const lesionRows = LS.map((l, k) => { const t = tierOf(l.size);
      return { no: k + 1, site: l.site, size: l.size, siteText: l.site || '—', sizeText: l.size ? l.size + 'cm' : '—',
        tier: t ? t.label : (l.size ? '3cm 초과 · 상담' : '—'), price: t ? t.price : 0, priceText: t ? won(t.price) + '원' : '—',
        onSite: e => setLesion(k, 'site', e.target.value),
        onSize: e => setLesion(k, 'size', e.target.value.replace(/[^0-9.]/g, '')),
        del: () => this.setState(st => ({ lesions: (st.lesions || LS).filter((_, j) => j !== k) })), canDel: LS.length > 1 }; });
    const lesionTotal = lesionRows.reduce((t, r) => t + r.price, 0);
    const lesionOk = LS.length > 0 && lesionRows.every(r => r.site && r.price);
    const needAmount = !!cur && !cur.total && !isLesion;

    const listSumNum = cur
      ? (cur.items || []).reduce((t, i) => t + ((effUnit(i) || (itemNoUnit(i) ? fixVal(itemFixKey(i)) : 0)) * Number(i.qty || 0)), 0)
        + curAdds.reduce((t, a) => t + Number(a.price || 0), 0)
      : 0;
    const listNum = cur ? (isLesion ? lesionTotal : ((Number(cur.total || 0) || manualAmt) + optAddSum)) : 0;
    // 할인·선결제권: 2단계에서 하나만 선택 → 최종 계약금액 확정 (3단계에서는 다시 계산하지 않음)
    // 이벤트 설정(가격 관리 → 이벤트)을 할인 선택·금액·결제 안내가 함께 참조
    const evDefCur = cur && cur.event ? ((db && db.events) || []).find(e => e.id === cur.event) || null : null;
    const rateEvs = cur ? CAT.rateEventsFor(db, cur.id, Component.today()) : [];
    const { isEvProg, isYearSB, noPreHair, noRet, discOk, discKey, preTier, preBase, discRate, discBase, totalNum, discLabel, options: discOptions, eventId: discEventId } =
      PR.discount({ cur, held, hairParts: hairPs, hairRate, listNum, optAddSum, all: dbAll, disc: s.disc, preTier: s.preTier, evDef: evDefCur, rateEvents: rateEvs });
    const DK = PR.DISCOUNTS;
    const chip = on => ({ bd: on ? '#030213' : 'rgba(0,0,0,0.1)', bg: on ? '#030213' : '#ffffff', fg: on ? '#ffffff' : '#0a0a0a' });

    const flat = progList.map((p, i) => {
      // 제모: 여러 부위를 한 번에 선택 (누르면 추가/해제)
      const hair = p.cat === '제모' && !!p.id;
      const on = hair ? hairIds.includes(p.id) : (s.progId ? p.id === s.progId : s.prog === i);
      const reset = { addArea: '', addSel: [], addSvc: [], addSvN: {}, svcOff: [], svcSwap: {}, oGrp: '', disc: 'none', preTier: '', retPeriod: '', preBal: '', preNew: false, preRcvAmt: '', preBuyM: '' };
      return { ...p, on, hair, pick: hair
        ? () => this.setState(st => { const h = st.hairIds || []; return { ...reset, prog: -1, progId: '', hairIds: h.includes(p.id) ? h.filter(x => x !== p.id) : h.concat(p.id) }; })
        : () => this.setState({ ...reset, prog: i, progId: p.id || '', hairIds: [] }),
        bd: on ? '#030213' : 'rgba(0,0,0,0.1)', bg: on ? '#e9ebef' : '#ffffff',
        dot: on ? '#030213' : 'rgba(0,0,0,0.1)', inner: on ? '#030213' : 'transparent', showOpts: false, opts: [] }; });
    const oCnt = n => (String(n || '').match(/(\d+)\s*회$/) || [])[1] || '1';
    const oLab = m => m.o || (oCnt(m.baseName || m.name) + '회');
    // 카테고리별 구역(programs.json → sections). 없으면 장비 카드를 데이터 순서대로 나열
    const SEC_DEF = (db && db.sections && db.sections[s.pcat]) || [];
    const programs = [], devMap = {}, devOrder = [];
    const T0 = { isSec: false, isDev: false, isPick: false, notDev: false };
    flat.forEach(p => {
      if (!p.g) { programs.push({ ...p, ...T0, notDev: true }); return; }
      const dev = p.g, area = p.r;
      if (!devMap[dev]) { devMap[dev] = { ...T0, isDev: true, dev, isEv: !!p.event, areas: [], aIdx: {} }; devOrder.push(dev); if (!SEC_DEF.length) programs.push(devMap[dev]); }
      const D = devMap[dev];
      if (D.aIdx[area] == null) { D.aIdx[area] = D.areas.length; D.areas.push({ area, members: [] }); }
      D.areas[D.aIdx[area]].members.push(p);
    });
    const SECS = SEC_DEF.map(x => ({ ...x, devs: (x.devs || []).slice() }));
    const used = {}; SECS.forEach(S => (S.devs || []).concat(S.pick ? S.pick.btns.map(b => b[1]) : []).forEach(d => used[d] = 1));
    if (SECS.length) SECS[SECS.length - 1].devs = SECS[SECS.length - 1].devs.concat(devOrder.filter(d => !used[d]));
    const devCards = [];
    if (!SEC_DEF.length) devOrder.forEach(d => devCards.push(devMap[d]));
    else SECS.forEach(S => {
      const out = [];
      if (S.pick) {
        const hits = S.pick.btns.map(([label, dev]) => ({ label, D: devMap[dev] })).filter(b => b.D);
        if (hits.length) {
          const m0 = hits[0].D.areas[0].members[0], sel = hits.some(b => b.D.areas[0].members[0].on);
          out.push({ ...T0, isPick: true, head: S.pick.head, area: hits[0].D.areas[0].area, cnt: oCnt(m0.baseName || m0.name) + '회', price: m0.price,
            bd: sel ? '#030213' : 'rgba(0,0,0,0.1)', bg: sel ? '#e9ebef' : '#ffffff',
            btns: hits.map(b => { const m = b.D.areas[0].members[0]; return { label: b.label, pick: m.pick,
              bd: m.on ? '#030213' : 'rgba(0,0,0,0.1)', bg: m.on ? '#030213' : '#ffffff', fg: m.on ? '#ffffff' : '#0a0a0a' }; }) });
        }
      }
      (S.devs || []).forEach(d => { if (devMap[d]) { out.push(devMap[d]); devCards.push(devMap[d]); } });
      if (out.length) { programs.push({ ...T0, isSec: true, secTitle: S.title }); out.forEach(o => programs.push(o)); }
    });
    devCards.forEach(D => {
      D.areas.forEach(A => A.members.sort((a, b) => (parseInt(oLab(a)) || 0) - (parseInt(oLab(b)) || 0)));
      D.rows = D.areas.map((A, ai) => {
        const parts = AREA_SPLIT.includes(A.members[0].cat) ? A.area.split('+') : [A.area], key = D.dev + '|' + A.area;
        const base = { areaMain: parts[0], areaRest: parts.length > 1 ? '+ ' + parts.slice(1).join(' + ') : '', sep: ai > 0 ? '1px solid rgba(0,0,0,0.1)' : '0' };
        const unpick = extra => this.setState({ prog: -1, progId: '', addArea: '', ...extra });
        if (A.members.length === 1) { const m = A.members[0];
          return { ...base, price: m.price, cnt: oLab(m), pick: () => m.on && !m.hair ? unpick({ oGrp: '' }) : (m.pick(), this.setState({ oGrp: '' })), showOpts: false, opts: [],
            bg: m.on ? '#e9ebef' : '#ffffff', dot: m.on ? '#030213' : 'rgba(0,0,0,0.1)', inner: m.on ? '#030213' : 'transparent' }; }
        const sel = A.members.some(m => m.on), open = sel || s.oGrp === key;
        return { ...base, price: '', cnt: A.members.length > 3 ? oLab(A.members[0]) + ' ~ ' + oLab(A.members[A.members.length - 1]) : A.members.map(oLab).join(' · '), showOpts: open,
          pick: () => open ? unpick({ oGrp: '' }) : unpick({ oGrp: key }),
          bg: open ? '#e9ebef' : '#ffffff', dot: open ? '#030213' : 'rgba(0,0,0,0.1)', inner: sel ? '#030213' : 'transparent',
          opts: A.members.map(m => ({ label: oLab(m), sub: m.price, pick: () => m.hair
              // 제모: 같은 부위는 횟수 하나만, 다른 부위는 계속 추가
              ? this.setState(st => { const ids = A.members.map(x => x.id), h = (st.hairIds || []).filter(x => !ids.includes(x));
                  return { prog: -1, progId: '', addArea: '', disc: 'none', preTier: '', preNew: false, preRcvAmt: '', preBuyM: '', oGrp: key, hairIds: m.on ? h : h.concat(m.id) }; })
              : m.on ? unpick({ oGrp: key }) : (m.pick(), this.setState({ oGrp: key })),
            bd: m.on ? '#030213' : 'rgba(0,0,0,0.1)', bg: m.on ? '#030213' : '#ffffff', fg: m.on ? '#ffffff' : '#030213' })) };
      });
    });

    // 결제수단 타일: 선택 = 남색 테두리 + 연한 파랑 배경, 미선택 = 회색 배경. 아이콘은 카드·현금·계좌이체
    const payIcon = (m, on) => { const c = on ? '#030213' : '#717182', h = React.createElement, P = { fill: 'none', stroke: c, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
      const parts = m === '카드' ? [h('rect', { key: 1, x: 3, y: 5.5, width: 18, height: 13, rx: 2.5, ...P }), h('path', { key: 2, d: 'M3 10h18M7 15h4', ...P })]
        : m === '현금' ? [h('rect', { key: 1, x: 2.5, y: 6, width: 19, height: 12, rx: 2.5, ...P }), h('circle', { key: 2, cx: 12, cy: 12, r: 2.6, ...P }), h('path', { key: 3, d: 'M6 9.5v5M18 9.5v5', ...P })]
        : [h('path', { key: 1, d: 'M3 9.5L12 4l9 5.5M5 10v7M9.7 10v7M14.3 10v7M19 10v7M3 19.5h18', ...P })];
      return h('svg', { width: 24, height: 24, viewBox: '0 0 24 24' }, parts); };
    const tile = (m, on) => ({ tbd: on ? '#030213' : '#f9fafb', tbg: on ? '#e9ebef' : '#f9fafb', icon: payIcon(m, on) });
    // 선택 표시: 선택 = 채운 원 + 흰 체크, 미선택 = 연한 테두리 + 연한 체크
    const ck = on => ({ ckBg: on ? '#030213' : '#ffffff', ckBd: on ? '#030213' : 'rgba(0,0,0,0.1)', ckFg: on ? '#ffffff' : 'rgba(0,0,0,0.1)' });
    // 결제수단 최대 2개(분할결제). 세 번째를 누르면 두 번째를 교체
    const selM = s.mSel || [];
    const methods = ['카드', '현금', '계좌이체'].map(m => { const on = selM.includes(m);
      return { label: m, ...ck(on), ...tile(m, on), fg: on ? '#0a0a0a' : '#4b5563', fw: on ? 600 : 500,
        pick: () => { const next = on ? selM.filter(x => x !== m) : (selM.length >= 2 ? [selM[0], m] : selM.concat(m));
          this.setState({ mSel: next, method: next.join(' + ') }); } }; });

    const tabs = [['status', '계약 정보'], ['docs', '문서']].map(([k, label]) => ({
      label, pick: () => this.setState({ tab: k }), weight: s.tab === k ? 600 : 500,
      fg: s.tab === k ? '#0a0a0a' : '#717182', bd: s.tab === k ? '#030213' : 'transparent', tbg: s.tab === k ? '#ffffff' : 'transparent', tbd: s.tab === k ? 'rgba(0,0,0,0.1)' : 'transparent' }));

    const curP = (s.contract && s.contract.patient) || {};
    const curPk = (curP.name || '') + '|' + (curP.birth || '');
    const docPg = this.pager((s.docs || []).filter(d => d.pk === curPk).length, 6, 'docPage');
    const docList = (s.docs || []).filter(d => d.pk === curPk).slice().reverse().map(d => ({ title: d.title, fileName: d.fileName,
      meta: d.program + ' · 서명 ' + d.signedAt + ' · v' + d.version,
      verLabel: d.superseded ? '대체됨' : '최종본', verBg: d.superseded ? '#f9fafb' : 'rgba(3,2,19,.08)', verFg: d.superseded ? '#717182' : '#1c1b2b',
      titleFg: d.superseded ? '#717182' : '#0a0a0a', thumbOp: d.superseded ? 0.55 : 1,
      thumb: React.createElement('div', { style: { width: 148, height: 209, overflow: 'hidden', background: '#ffffff', boxShadow: '0 1px 6px rgba(0,0,0,.14)', pointerEvents: 'none', position: 'relative' } },
        d.html ? React.createElement('div', { style: { width: 740, transform: 'scale(0.2)', transformOrigin: '0 0', position: 'absolute', top: 0, left: 0 }, dangerouslySetInnerHTML: { __html: this.cleanHtml(d.html) } }) : null),
      canResign: !d.superseded && d.kind === '이용동의서' && s.cStatus === '등록완료',
      // 서명된 문서(동의서·환불 정산서)는 일반 삭제 대상이 아님 → 삭제 버튼 숨김
      canDel: !d.signedAt, open: () => this.setState({ pdfId: d.id }), del: () => d.signedAt ? this.flash('서명된 문서는 삭제할 수 없습니다') : this.setState({ delAsk: d.id }),
      resign: () => sameAsContract() ? this.setState({ screen: 'sign', signFrom: 'resign', sig: false, sigOpen: false, sigImg: null, ckRefund: false }) : this.flash(RESIGN_MSG) }));
    const pdfDoc = s.pdfId ? (s.docs || []).find(d => d.id === s.pdfId) : null;

    const dep = s.pay === 'deposit';
    // 3단계: 확정된 최종 계약금액 − 기존 선결제권 잔액 − 기납부 예약금 = 당일 결제 필요금액
    const numOf = v => Number(String(v || '').replace(/[^0-9]/g, '')) || 0;
    // 선결제권: 할인 기준(300·400·500)과 결제 재원을 구분. 직원이 확인·입력한 값만 사용 (다른 계약 금액으로 추정하지 않음)
    // · 보유 잔액: 직원이 확인한 기존 잔액 → 먼저 사용
    // · 신규 구매(선결제권 할인 선택 시): 선결제권 = 선택한 금액(300 → 3,000,000). 받는 방식은 완납(전액) 또는 예약금(선결제권 금액의 10%, 자동) 중 선택
    //   미수금 = 선결제권 − 받은 금액. 둘 중 하나를 선택해야 서명 가능 (선결제권 선택만으로 완납 처리하지 않음)
    //   계약 납부액에는 이 계약에 사용한 금액만 포함 (선결제권 금액 전체 아님). 잔액 = 선결제권 − 프로그램 사용 (미수금과 별개)
    // · 기존 잔액과 신규 구매금액을 합쳐 할인 기준을 올리지 않음 (선택한 기준 그대로)
    const preNew = discKey === 'pre' && !!preTier && !!s.preNew;
    const preBuy = preNew ? Number(preTier) * 10000 : 0;
    const preMin = Math.ceil(preBuy * 0.1), preRcvSel = preNew ? numOf(s.preRcvAmt) : 0;      // 예약금 = 선결제권 금액의 10%
    const preRcvAmt = preRcvSel === preMin || preRcvSel === preBuy ? preRcvSel : 0;               // 완납 또는 예약금으로 선택한 금액만 인정
    const preIsDep = preNew && preRcvAmt === preMin && preMin < preBuy, preIsFull = preNew && preRcvAmt === preBuy;
    const preUnpaid = Math.max(0, preBuy - preRcvAmt), preSignOk = !preNew || preRcvAmt >= preMin;
    const preRcvLabel = preIsDep ? '예약금' : '완납';
    const pdAll = preNew ? 0 : numOf(s.priorDep);   // 선결제권 신규 구매 시 예약금은 수납액에 포함 (따로 입력·합산하지 않음)
    const preBuyM = preNew ? (s.preBuyM || '') : '';
    const balIn = numOf(s.preBal);
    const balUse = Math.min(balIn, totalNum), balAfter = balIn - balUse;
    const newUse = preNew ? Math.min(preBuy, totalNum - balUse) : 0, newLeft = preBuy - newUse;   // 전액 수납 전에는 예상값
    const PAY = PR.payment({ totalNum, preBal: balUse + newUse, priorDep: pdAll, deposit: dep });
    const { preBal, priorDep, needNum, leftNum, depAmt, depTarget } = PAY;
    const preUse = balUse + newUse, preLeft = balAfter + newLeft;
    const pdUse = Math.min(priorDep, Math.max(0, totalNum - preUse)), pdOver = priorDep - pdUse;
    const newLabel = '선결제권 (신규 구매 ' + preTier + ')';
    const preLabel = balUse > 0 && newUse > 0 ? '선결제권' : newUse > 0 ? newLabel : '선결제권 잔액';
    const payLabels = { label: dep ? '예약금' : '당일 결제',
      now: won(dep ? depAmt : needNum) + '원',
      rest: won(dep ? needNum - depAmt : 0) + '원' };

    const todayStr = Component.today();
    const addYear = d => { const x = new Date(d); x.setFullYear(x.getFullYear() + 1); x.setDate(x.getDate() - 1); return x.toISOString().slice(0, 10); };
    // 이벤트: 첫 시술일 기준 N개월(스킨부스터 3, 그 외 2) 유효
    const evDef = cur && cur.event ? ((db && db.events) || []).find(e => e.id === cur.event) : null;
    const isEventCur = !!(cur && cur.event);
    const evMonths = evDef && evDef.validMonths ? evDef.validMonths : (cur && cur.cat === '스킨부스터' ? 3 : 2);
    const evFirst = s.evFirst || todayStr;
    const addMonths = (d, m) => { const x = new Date(d); x.setMonth(x.getMonth() + m); x.setDate(x.getDate() - 1); return x.toISOString().slice(0, 10); };
    const evExpiry = addMonths(evFirst, evMonths);
    // 금일 결제액을 선택한 결제수단에 배분. 현금·계좌이체는 현금영수증 발급 여부를 서명 전에 체크
    const nowNum = PAY.nowNum;
    const isSplit = selM.length === 2;
    const a1 = isSplit ? Math.min(nowNum, Number(String(s.split1 || '').replace(/[^0-9]/g, '')) || 0) : nowNum;
    const hasCash = selM.some(m => m !== '카드');
    const rcpt = s.cashRcpt || '미발급';
    const payments = selM.map((m, i) => ({ method: m, amount: isSplit ? (i === 0 ? a1 : nowNum - a1) : nowNum,
      ...(m === '카드' ? { bank: '', cardNo: '', payDate: '', approval: '' } : { rcpt, rcptNo: '' }) }));
    const payText = selM.length ? payments.map(p => p.method + (isSplit ? ' ' + won(p.amount) + '원' : '')).join(' + ') + (hasCash ? ' · 현금영수증 ' + rcpt : '') : '';
    // 결제수단 표시: 당일 수납 수단 + 선결제권 사용분 (기존 잔액 사용과 당일 카드·현금·계좌 수납을 구분)
    const methodStr = [payText, preUse > 0 ? preLabel + ' ' + won(preUse) + '원' : ''].filter(Boolean).join(' + ') || (needNum ? '카드' : preLabel);
    // 재등록 간이 동의서: 같은 환자가 1년 이내 같은 약관 버전으로 전체 동의서에 서명한 적이 있으면 약관 요약본으로 대체
    const TERMS_VER = 'T-2026-09';
    const pkP = (P.name || '') + '|' + (P.birth || '');
    const yearAgo = (() => { const x = new Date(todayStr); x.setFullYear(x.getFullYear() - 1); return x.toISOString().slice(0, 10); })();
    const priorFull = (s.contracts || []).filter(c => (c.patient.name || '') + '|' + (c.patient.birth || '') === pkP
      && (c.docMode || 'full') === 'full' && (c.termsVer || TERMS_VER) === TERMS_VER && !c.event && c.date >= yearAgo).pop() || null;
    const briefOK = !!priorFull && !isEventCur && !isResign;
    const isBrief = isResign ? ((s.contract || {}).docMode === 'brief') : (briefOK && !s.forceFull);
    const buildContract = () => !cur ? null : {
      docMode: isBrief ? 'brief' : 'full', termsVer: TERMS_VER, priorDate: isBrief && priorFull ? priorFull.date : null,
      // 기존 선결제권 잔액 사용분도 결제수단으로 기록 → 환불 시 잔액으로 복구 (사용액 한도)
      payments: payments.concat(balUse > 0 ? [{ method: '선결제권 잔액', amount: balUse, prepaid: true }] : [])
        .concat(newUse > 0 ? [{ method: newLabel, amount: newUse, prepaid: true, newPurchase: true }] : []),
      // 선결제권 기록: 확인한 기존 잔액 · 신규 구매·실제 수납 · 이 계약 사용액(각각) · 차감 후 잔액. 계약 납부액에는 사용액만 포함
      prepaid: balIn > 0 || preNew ? { tier: discKey === 'pre' ? preTier || null : null, balBefore: balIn, balUse,
        purchase: preNew ? preBuy : 0, received: preNew ? preRcvAmt : 0, unpaid: preNew ? preUnpaid : 0, payType: preNew ? (preIsDep ? '예약금' : preIsFull ? '완납' : null) : null, purchaseMethod: preNew ? preBuyM : null, newUse,
        use: preUse, balAfter: preLeft } : null,
      event: cur.event || null, firstDate: isEventCur ? evFirst : null,
      patient: { ...P },
      program: progTitle(cur), cat: cur.cat, date: todayStr, expiry: isEventCur ? evExpiry : addYear(todayStr),
      // 서명 시점 가격 고정: 이후 가격표가 바뀌어도 이 계약의 환불 정산은 아래 값 기준
      priceSnap: { ver: (db && db.version) || todayStr, programId: cur.id, total: Number(cur.total || 0) || null, at: todayStr },
      total: totalNum, paid: PAY.paid, pay: s.pay, method: methodStr,
      // 할인·선결제권 (서명 시 고정). 선결제권 기준(할인율)과 잔액은 별도 값
      listTotal: discKey === 'pre' ? preBase : listNum, hairCombo: hairRate ? { parts: hairElig.length, rate: hairRate, sum: hairSum, off: hairOff } : null, disc: { kind: discKey, label: discLabel, rate: discRate, retPeriod: discKey === 'ret' ? (s.retPeriod || '1개월 이내') : null, preTier: preTier || null, eventId: discEventId || null, },
      preBal: balIn, priorDep,
      cap: capped ? Number(capN) : null, svcVisit: svcNote,
      items: isLesion ? lesionRows.map(r => ({ kind: '시술', lesionUnit: true, qty: 5, price: r.price,
          name: '흑자 ' + r.no + ' · ' + r.site + ' ' + r.sizeText + ' (' + r.tier + ')' })) :
        // 환불 정산단가(settleUnit) 기준. 정산 제외 항목은 차감 대상에서 빠짐. 판매금액 0원(S/V)이어도 정산단가는 유지
        (cur.items || []).filter(i => !isSvcItem(i) && i.settleType !== '정산 제외').map(i => ({
        kind: i.kind === '서비스권' ? '서비스' : '시술', settleType: i.settleType || '',
        // 얼굴 점 CO₂ 제거: 등록 개수 고정 아님 → 환불 시 실제 제거한 병변별 개별 정상가 합계 (settleUnit 11,000원은 시작 기준)
        actual: i.id === 'SERVICE_TONING_CO2' || undefined,
        name: i.kind === '서비스권' ? svcName(i.name) : i.name, swappedFrom: i.swappedFrom ? svcName(i.swappedFrom) : undefined,
        qty: i.qtyBasis === '공통 총회차 상한' ? null : (Number(i.qty) || null),
        price: Number(i.settleUnit || 0) || effUnit(i) || Number(i.perPiece || 0) || fixVal(itemFixKey(i)), variants: i.variants || null,
        unitInput: itemNoUnit(i) || undefined,
        // 조건별 금액: 직원 입력 환불용 1회 정상가를 계약 당시 값으로 고정 (총 등록금액과 독립)
        manualUnit: isManual && (i.unitFromTotal || !Number(i.unitPrice || 0)) || undefined }))
        .concat(curAdds.filter(a => a.settleType !== '정산 제외').map(a => ({ kind: a.svc ? '서비스' : '추가', settleType: a.svc ? 'S/V' : (a.settleType || '유상'), name: addName(a),
          qty: Number(a.qty) || 1, price: Number(a.settleUnit || 0) || addUnit(a) || (addNoUnit(a) ? fixVal(addFixKey(a)) : 0), unitInput: addNoUnit(a) || undefined,
          // 스페셜 토닝 흑자 추가옵션: 추가금 110,000원은 계약금액에만 포함. 환불은 실제 시술 병변별 크기별 정상가 합계 (서명 시점 가격 고정)
          actual: a.id === RF.BS_ADD_ID || undefined, tiers: a.id === RF.BS_ADD_ID ? RF.tiersOf(null, db) : undefined }))),
      // 서비스 이용 기록(염증주사·약처방·알러지케어) 정산단가: 서명 시점 가격 고정
      svcPrices: { acne: ((db && db.acneSvc) || []).map(r => ({ id: r['서비스권 ID'], range: r['사용 범위/기간'], price: Number(r['정상가'] || 0) })),
        allergy: (((db && db.careSvc) || []).find(c => c.id === 'ALLERGY') || {}).price != null ? Number(((db && db.careSvc) || []).find(c => c.id === 'ALLERGY').price) : null },
      used: null, visits: []
    };
    // 재서명: 화면에 만들어지는 동의서 구성이 저장된 계약과 같을 때만 허용 (다르면 계약 당시와 다른 내용의 문서가 저장됨)
    const sameAsContract = () => { const b = buildContract(), c = s.contract; if (!b || !c) return false;
      const key = x => JSON.stringify([x.program, x.total, (x.items || []).map(i => [i.kind, i.name, i.qty, i.price])]);
      return key(b) === key(c); };
    const RESIGN_MSG = '화면 구성이 계약 당시 내용과 달라 재서명할 수 없습니다';
    const SAVE_FAIL_MSG = '기기 저장 공간이 부족해 저장하지 못했습니다. 작성 내용과 서명은 그대로 있으니 공간을 확보한 뒤 다시 저장해 주세요';

    const C = s.contract || this.defaultContract;
    // 환불 계산·검증: refund.js 한 곳 기준 (위약금 · 이용금액 · CO₂/흑자 병변 · 최종 환불금액 · 결제수단별 한도/합계)
    const act = RF.isActual, isBS = RF.isBlackspotAdd;
    const lesOf = k => (s.rfLes || {})[k] || [];
    const extraPaid = RF.num(s.rfExtra);
    const rfAlloc = s.rfAlloc || {};
    const V = s.rfVisits || C.visits || [];
    const RS = RF.settle(C, { used: s.rfUsed || C.used, visits: V, extraPaid, rfLes: s.rfLes, alloc: rfAlloc }, db);
    const { U, lesAmt, trtAmt, svcAmt, usedAmt, penNum, paidEff, refundNum, allocSum, allocOk, allocMsg } = RS, rfPays = RS.pays;
    const usedCnt = U.reduce((a, b) => a + (b || 0), 0);
    const updLes = (k, f) => this.setState(st => { const L = { ...(st.rfLes || {}) }; L[k] = f((L[k] || []).slice()); return { rfLes: L }; });
    const rItems = C.items.map((it, k) => {
      const u = U[k] || 0;
      // 추가 부위: 등록 때는 추가 여부만, 환불 시 실제 시술 개수 입력 (등록 수량 상한 없음)
      const isAdd = it.kind === '추가' || act(it);
      const canInc = isAdd ? u < 99 : !(it.qty && u >= it.qty) && !(C.cap && usedCnt >= C.cap);
      const vsel = (s.rfVar && s.rfVar[k]) || [];
      const variants = (it.variants || []).map(v => { const on = vsel.includes(v); return { label: v,
        bd: on ? '#030213' : 'rgba(0,0,0,0.1)', bg: on ? '#e9ebef' : '#fff', fg: on ? '#030213' : '#717182',
        pick: () => this.setState(st => { const cur0 = (st.rfVar && st.rfVar[k]) || [];
          return { rfVar: { ...(st.rfVar || {}), [k]: cur0.includes(v) ? cur0.filter(x => x !== v) : cur0.concat([v]) } }; }) }; });
      return { hasVar: variants.length > 0, variants,
        kind: it.kind, name: it.name, reg: isAdd ? '실제 개수' : C.cap ? '회차별' : (it.qty ? it.qty + '회' : '실제 이용'),
        used: u, price: act(it) ? '개별 정상가' : RS.items[k].priceMissing ? '정상가 확인 필요' : (it.lesionUnit || isAdd ? '1개 ' + won(RS.items[k].price) : won(RS.items[k].price)) + (RS.items[k].priceFixed ? ' (보완)' : ''),
        amt: won(act(it) ? lesAmt[k] : RF.amtOf(RS.items[k], u)),
        isLes: act(it) && u > 0, lesNote: isBS(it) ? '실제 시술 병변별 크기 선택 · ' + RF.tiersOf(it, db).map(t => t.short + ' ' + won(t.price)).join(' / ') : act(it) ? (Number(it.price) ? '1개 ' + won(it.price) + '원부터 · 병변별 정상가 입력' : '실제 시술 병변별 정상가 입력') : '',
        lesRows: act(it) ? lesOf(k).map((v, j) => { const bad = RF.lesionRowBad(it, v, db);
          const setL = x => updLes(k, a => { a[j] = x; return a; });
          return { no: '병변 ' + (j + 1), val: v, bd: bad ? '#d4183d' : 'transparent', isNum: !isBS(it), isSize: isBS(it),
            sizes: isBS(it) ? RF.tiersOf(it, db).map(t => { const on = v === t.label; return { label: t.label, price: won(t.price), pick: () => setL(t.label),
              bd: on ? '#0a0a0a' : bad ? '#d4183d' : 'rgba(0,0,0,0.1)', bg: on ? '#0a0a0a' : '#ffffff', fg: on ? '#ffffff' : '#0a0a0a' }; }) : [],
            onVal: e => { const x = e.target.value.replace(/[^0-9]/g, ''); setL(x ? Number(x).toLocaleString('ko-KR') : ''); },
            del: () => updLes(k, a => a.filter((_, i2) => i2 !== j)) }; }) : [],
        docName: isBS(it) && u ? it.name + ' (' + lesOf(k).map(v => v + ' ' + won(RF.tierPrice(RF.tiersOf(it, db), v)) + '원').join(', ') + ')' : act(it) && u ? it.name + ' (' + lesOf(k).map(v => (v || '0') + '원').join(', ') + ')' : it.name + (vsel.length ? ' (이용: ' + vsel.join(', ') + ')' : ''),
        dec: act(it) ? () => updLes(k, a => a.slice(0, -1)) : () => this.setUsed(k, -1, C),
        inc: act(it) ? () => updLes(k, a => a.concat([''])) : () => this.setUsed(k, 1, C),
        decFg: u > 0 ? '#0a0a0a' : 'rgba(0,0,0,0.1)', incFg: canInc ? '#0a0a0a' : 'rgba(0,0,0,0.1)' };
    });
    // 서비스 이용 기록: 모든 프로그램 공통 — 염증주사 · 약처방 · 알러지케어 (DB 정산단가)
    // 계약 당시 서비스 정산단가 우선 (svcPrices가 없는 이전 계약만 현재 가격표 사용)
    // 계약 당시 서비스 단가가 없는 이전 계약: 현재 가격표 단가를 자동 적용하지 않음 (항목 이름만 사용, 단가는 '확인 필요').
    // 실제 기록이 있으면 근거 확인 후 보완(priceFixes)하기 전까지 환불 확정 차단 (refund.js)
    const SP = C.svcPrices;
    const acneRows = SP ? (SP.acne || []).map(r => ({ '서비스권 ID': r.id, '사용 범위/기간': r.range, '정상가': r.price }))
      : ((db && db.acneSvc) || []).map(r => ({ ...r, '정상가': null }));
    const allergy = SP ? (SP.allergy != null ? { id: 'ALLERGY', price: SP.allergy } : null)
      : (((db && db.careSvc) || []).some(c => c.id === 'ALLERGY') ? { id: 'ALLERGY', price: null } : null);
    const svcP = v => v == null || v === '' ? null : Number(v);
    const visitSrc = (acneRows.length ? acneRows.map((r, i) => ({ v: String(i),
      label: (r['서비스권 ID'] === 'SERVICE_INFLAMMATION_INJ' ? '염증주사' : '약처방') + ' · ' + r['사용 범위/기간'],
      price: svcP(r['정상가']) })) : []).concat(allergy ? [{ v: 'allergy', label: '알러지케어', price: svcP(allergy.price) }] : []);
    // 서비스 이용 기록: 염증주사 · 약처방 · 알러지케어 개별 입력 (주차 · 범위 · 건수)
    const acne = acneRows;
    const GDEF = [
      { key: 'inj', title: '염증주사', optLabel: '부위 수', opts: acne.filter(r => r['서비스권 ID'] === 'SERVICE_INFLAMMATION_INJ').map(r => ({ label: r['사용 범위/기간'], price: svcP(r['정상가']) })) },
      { key: 'rx', title: '약처방', optLabel: '처방 기간', opts: acne.filter(r => r['서비스권 ID'] === 'SERVICE_PRESCRIPTION').map(r => ({ label: r['사용 범위/기간'], price: svcP(r['정상가']) })) },
      { key: 'al', title: '알러지케어', optLabel: '', opts: allergy ? [{ label: '1회', price: svcP(allergy.price) }] : [] }
    ];
    const SG = s.svcG || {};
    const svcGroups = GDEF.filter(g => g.opts.length).map((g, gi) => { const st = SG[g.key] || {}, week = st.week || '1', pick = st.pick || '0', qty = st.qty || 1;
      const upd = o => this.setState(x => ({ svcG: { ...(x.svcG || {}), [g.key]: { ...((x.svcG || {})[g.key] || {}), ...o } } }));
      const opt = g.opts[Number(pick)] || g.opts[0];
      const vKey = o => g.key + '|' + o.label;
      const optText = o => o.price != null ? won(o.price) : (RF.fixOf(C, RF.svcKey({ key: vKey(o) })) != null ? won(RF.fixOf(C, RF.svcKey({ key: vKey(o) }))) + ' (보완)' : '단가 확인 필요');
      // 항목별 기록: 해당 행 바로 아래 작은 태그로 표시 (주차순)
      const recs = V.map((v, vi) => ({ v, vi })).filter(x => (x.v.label || '').split(' · ')[0] === g.title);
      return { sep: gi ? '1px solid rgba(0,0,0,0.1)' : '0', title: g.title, optLabel: g.optLabel, week, pick, qty,
        hasRecs: recs.length > 0, recSum: won(recs.reduce((t, x) => t + ((RS.visits[x.vi] || {}).price || 0), 0)) + '원',
        recs: recs.map(x => ({ week: x.v.week ? x.v.week + '주' : '', label: (x.v.label.split(' · ')[1] || '1회'),
          del: () => this.setState({ rfVisits: V.filter((_, j) => j !== x.vi) }) })), hasOpts: g.opts.length > 1, noOpts: g.opts.length <= 1,
        single: g.opts[0] ? g.opts[0].label + ' · ' + optText(g.opts[0]) + (g.opts[0].price != null ? '원' : '') : '',
        opts: g.opts.map((o, i) => { const on = String(i) === String(pick) || (g.opts.length === 1);
          return { v: String(i), label: o.label, price: optText(o), bd: on ? '#030213' : 'rgba(0,0,0,0.1)', dot: on ? '#030213' : 'transparent', fg: on ? '#0a0a0a' : '#4b5563',
            pick: () => upd({ pick: String(i) }) }; }),
        onWeek: e => upd({ week: e.target.value }), onPick: e => upd({ pick: e.target.value }),
        dec: () => upd({ qty: Math.max(1, qty - 1) }), inc: () => upd({ qty: Math.min(20, qty + 1) }),
        add: () => { upd({ qty: 1 }); this.setState(x => ({ rfVisits: (x.rfVisits || V).concat(Array.from({ length: qty }, () => ({ label: g.title + (g.opts.length > 1 ? ' · ' + opt.label : ''), price: opt.price, key: vKey(opt), week: Number(week) })))
          .sort((a, b) => (a.week || 0) - (b.week || 0)) })); } }; });
    const vWeek = s.vWeek || '1';
    const visitOpts = visitSrc.map(o => ({ v: o.v, label: o.label + ' · ' + (o.price != null ? won(o.price) + '원' : '단가 확인 필요') }));
    const vPick = s.rfPick || (visitSrc[0] ? visitSrc[0].v : '');
    const rVisits = V.map((v, i) => ({ label: v.label, amt: (RS.visits[i] || {}).priceMissing ? '단가 확인 필요' : won((RS.visits[i] || {}).price), week: v.week ? v.week + '주차' : '',
      del: () => this.setState({ rfVisits: V.filter((_, j) => j !== i) }) }));
    // 결제수단별 환불: 최종 환불금액은 고정. 직원이 카드 환불금액·선결제권 잔액 복구금액을 직접 입력 (검증은 refund.js)
    const rfReason = s.rfReason || '개인 사정';
    // 정상가 보완: 당시 동의서·가격표 등 근거를 확인한 값만 입력. 원 계약 항목·서명 문서는 그대로 두고 별도 기록(근거·금액·일시)
    const supplyPrices = () => {
      if (C.refund) return;
      // 취소·빈 값·문자·0원·음수·소수는 저장하지 않음. 여러 항목 중 하나라도 취소·오류면 전부 저장하지 않음
      const add = [];
      for (const m of RS.missing) {
        const v = window.prompt('‘' + m.label + '’ 1회 정상가(원)\n당시 동의서·가격표 등 근거를 확인한 금액만 숫자로 입력하세요.', '');
        if (v == null) return this.flash('보완을 취소했습니다. 저장된 내용은 없습니다');
        const raw = String(v).trim();
        if (!/^[0-9][0-9,\s]*원?$/.test(raw)) return this.flash('금액은 숫자로만 입력해 주세요 (예: 110,000). 저장된 내용은 없습니다');
        const price = Number(raw.replace(/[^0-9]/g, ''));
        if (!(price > 0)) return this.flash('0원은 정상가로 저장할 수 없습니다. 저장된 내용은 없습니다');
        const basis = window.prompt('확인 근거를 적어 주세요 (예: 2026-03-02 서명 동의서, 당시 가격표)', '');
        if (basis == null || !String(basis).trim()) return this.flash('확인 근거가 있어야 보완할 수 있습니다. 저장된 내용은 없습니다');
        if (!confirm('‘' + m.label + '’ 1회 정상가 ' + won(price) + '원\n근거: ' + String(basis).trim() + '\n\n원래 서명 문서와 계약 항목은 바뀌지 않고, 보완 기록으로 따로 저장됩니다.')) return this.flash('보완을 취소했습니다. 저장된 내용은 없습니다');
        add.push({ key: m.key, label: m.label, price, basis: String(basis).trim(), at: new Date().toISOString() });
      }
      if (add.length) { this.saveContract({ ...C, priceFixes: (C.priceFixes || []).concat(add) }); this.flash('정상가 보완 기록이 저장되었습니다'); }
    };
    const rfDraft = () => ({ used: s.rfUsed || null, visits: V, les: s.rfLes || null, vars: s.rfVar || null, alloc: s.rfAlloc || null, reason: rfReason });
    const reasons = ['개인 사정', '이사 · 거리', '건강상 사유', '시술 불만족'].map(r => {
      const on = r === rfReason; return { label: r, pick: () => this.setState({ rfReason: r }),
        bd: on ? '#030213' : 'rgba(0,0,0,0.1)', bg: on ? '#e9ebef' : '#fff', fg: on ? '#030213' : '#4b5563' }; });
    const rDocRows = rItems.map(r => ({ kind: r.kind, name: r.docName, reg: C.cap ? '—' : (C.items[rItems.indexOf(r)].qty || '—'),
      used: r.used, price: r.price, amt: r.amt }))
      // 정산서: 서비스 기록을 항목별 1줄로 묶음 — 예) 염증주사 (4주차 2~5부위, 8주차 1부위)
      .concat((() => { const g = {}, order = [];
        RS.visits.slice().sort((a, b) => (a.week || 0) - (b.week || 0)).forEach(v => { const [t, r] = (v.label || '').split(' · ');
          if (!g[t]) { g[t] = { n: 0, sum: 0, parts: [], prices: new Set() }; order.push(t); }
          g[t].n++; g[t].sum += v.price; g[t].prices.add(v.price); g[t].parts.push((v.week ? v.week + '주차' : '') + (r ? ' ' + r : '')); });
        return order.map(t => ({ kind: '서비스', name: t + ' · ' + g[t].parts.join(', '), reg: '—', used: g[t].n,
          price: g[t].prices.size === 1 ? won([...g[t].prices][0]) : '—', amt: won(g[t].sum) })); })());
    const koDate = d => { const [y, m, dd] = d.split('-'); return y + '년 ' + Number(m) + '월 ' + Number(dd) + '일'; };
    // 선결제권 미수금: 프로그램에 선결제권을 사용해도 선결제권 대금을 다 받지 않았으면 완납으로 표시하지 않음 (저장된 받은 금액·미수금 그대로)
    const preDueOf = c => { const q = c && c.prepaid; return q && Number(q.purchase) > 0 && Number(q.unpaid) > 0
      ? '선결제권 ' + won(q.purchase) + '원 중 ' + (q.payType || '수납') + ' ' + won(q.received) + '원 · 미수금 ' + won(q.unpaid) + '원' : ''; };
    const payStateOf = c => Number(c.paid || 0) >= Number(c.total || 0) ? '완납'
      : (c.payments || []).some(p => p.balance) ? '일부 납부 (잔금 ' + won(Number(c.total || 0) - Number(c.paid || 0)) + '원 미납)' : '예약금 납부 (잔금 미납)';
    const rf = {
      rfName: C.patient.name, rfBirth: C.patient.birth, rfPhone: C.patient.phone,
      rfProg: C.program, rfDate: C.date, rfExpiry: C.expiry, rfMethod: C.method,
      // 납부 상태: 저장된 납부금액 기준 (잔금 결제 기록이 있으면 일부 납부로 표시)
      rfPayState: payStateOf(C), rfPayStateView: [preDueOf(C) && Number(C.paid || 0) >= Number(C.total || 0) ? '' : payStateOf(C), preDueOf(C)].filter(Boolean).join(' · '),
      rfTotal: won(C.total), rfPaid: won(paidEff), rfPen: won(penNum),
      rfPayRows: rfPays.map((p, i) => { const a = RS.amounts[i], over = RS.over[i];
        return { method: p.prepaid ? '선결제권 잔액 복원' : p.method, paid: won(p.amount) + '원', val: rfAlloc[i] || '', left: won(Math.max(0, Number(p.amount || 0) - a)) + '원',
          bd: over ? '#d4183d' : 'transparent', err: over, errText: '원결제 금액을 넘을 수 없습니다',
          onVal: e => { const v = e.target.value.replace(/[^0-9]/g, ''); this.setState(st => ({ rfAlloc: { ...(st.rfAlloc || {}), [i]: v ? Number(v).toLocaleString('ko-KR') : '' } })); } }; }),
      rfAllocSum: won(allocSum) + '원', rfMulti: rfPays.length > 1,
      // 실제 납부액 구성: 선결제권 사용분(환불 시 잔액 복원)과 카드·현금·계좌 수납(원결제 수단으로 반환)을 구분해 표시
      hasRfPrepaid: rfPays.some(p => p.prepaid), rfPrepaidUse: won(rfPays.filter(p => p.prepaid).reduce((t, p) => t + Number(p.amount || 0), 0)) + '원',
      // 납부금액 문구: 정산 기준 납부금액(계산 그대로)을 실제 수납(카드·현금·계좌·예약금)과 선결제권 사용으로 나눠 표시 — 선결제권 사용분을 받은 돈으로 적지 않음
      ...(() => { const use = rfPays.filter(p => p.prepaid).reduce((t, p) => t + Number(p.amount || 0), 0), cash = Math.max(0, paidEff - use);
        const st = payStateOf(C), parts = [cash > 0 ? '수납 ' + won(cash) + '원' : '', use > 0 ? '선결제권 사용 ' + won(use) + '원' : ''].filter(Boolean).join(' + ');
        return { hasRfCash: use > 0 && cash > 0, rfCashText: won(cash) + '원',
          rfPaidDoc: won(paidEff) + '원 (' + (use > 0 ? parts + (st !== '완납' ? ' · ' + st : '') : st) + ')',
          rfPaidLabel: use > 0 ? '납부금액 (선결제권 사용 포함)' : '납부금액' }; })(),
      rfSingle: rfPays.length === 1, rfSingleText: rfPays.length === 1 ? (rfPays[0].prepaid ? '선결제권 잔액 복원' : rfPays[0].method + ' 반환') + ' ' + (RS.missing.length ? '정상가 확인 후 계산' : won(RS.amounts[0] || 0) + '원') : '',
      // 정산서 '환불 방법': 결제수단별 원결제(사용)액 · 반환(복원)액. 합계 = 최종 환불금액 (자동 배분 없음 — 직원 입력값 그대로)
      rfMethodRows: rfPays.map((p, i) => ({ method: p.prepaid ? '선결제권 (잔액 복원)' : p.priorDep ? '기납부 예약금' : p.method,
        paid: won(p.amount) + '원', refund: won(RS.amounts[i] || 0) + '원' })),
      rfMethodSum: won(allocSum) + '원',
      rfAllocMsg: allocMsg,
      rfAllocFg: allocOk ? '#0a0a0a' : '#d4183d',
      rfUsedAmt: won(usedAmt), rfUsedBreak: '시술 ' + won(trtAmt) + ' + 서비스 ' + won(svcAmt),
      rfMissing: RS.missing.length > 0, rfMissingText: RS.missing.map(m => m.label).join(', '), supplyPrices,
      hasPriceFixes: !!(C.priceFixes && C.priceFixes.length),
      priceFixText: (C.priceFixes || []).map(f => f.label + ' ' + won(f.price) + '원 (근거: ' + f.basis + ', ' + String(f.at || '').slice(0, 10) + ')').join(' · '),
      // 정상가 확인 필요 항목이 있으면 금액을 확정 값처럼 보이지 않게 함 (0원 차감 금액을 최종 환불금액으로 표시하지 않음)
      rfRefund: won(refundNum), rfRefundLine: RS.missing.length ? '확인 필요' : won(refundNum) + '원',
      rfHero: RS.missing.length ? '정상가 확인 후 계산할 수 있어요' : refundNum > 0 ? won(refundNum) + '원을 환불할게요' : '환불할 금액이 없어요', rfStage: usedAmt > 0 ? '시술 시작 후 해지' : '시술 시작 전 해지',
      rfReason, reasons, rItems, rDocRows, rVisits,
      hasVisitSvc: true, hasAcneSel: visitSrc.length > 0, visitOpts, visitPick: vPick,
      onVisitPick: e => this.setState({ rfPick: e.target.value }),
      vQty: s.vQty || 1, vQtyDec: () => this.setState({ vQty: Math.max(1, (s.vQty || 1) - 1) }), vQtyInc: () => this.setState({ vQty: Math.min(20, (s.vQty || 1) + 1) }),
      // 약처방·염증주사: DB 정산단가 × 선택 건수 (직원 금액 입력 없음)
      addVisit: () => { const o = visitSrc.find(x => x.v === vPick); const q = s.vQty || 1;
        if (o) this.setState({ vQty: 1, rfVisits: V.concat(Array.from({ length: q }, () => ({ label: o.label, price: o.price, week: Number(vWeek) }))).sort((a, b) => (a.week || 0) - (b.week || 0)) }); },
      svcGroups, oldSel: false,
      hasCap: !!C.cap, rfCapNote: C.cap ? '총 ' + C.cap + '회 중 ' + usedCnt + '회 이용 (회차별 선택 · 1회 정상가 기준 공제)' : '',
      rfToday: todayStr, rfTodayKo: koDate(todayStr)
    };

    // 새 동의서 작성 시작: 이전 작성분(할인·선결제권·기납부 예약금·결제수단·분할금액·구성 선택 등)이 다음 환자에게 남지 않도록 초기화
    const NEW_RESET = { prog: -1, progId: '', hairIds: [], method: '', mSel: [], split1: '', cashRcpt: '', pay: 'full', addArea: '', addSel: [], addSvc: [], addSvN: {},
      svcOff: [], svcSwap: {}, oGrp: '', disc: 'none', preTier: '', retPeriod: '', preBal: '', priorDep: '', preNew: false, preRcvAmt: '', preBuyM: '', draftId: '', pendingCtId: '', amounts: {}, units: {}, lesions: null,
      unitFix: {}, tried3: false, evFirst: '', forceFull: false, dupPick: '', dupOff: '', pvOn: false, sig: false, tried1: false, pendingSign: false, ckRefund: false };
    const bars = {
      list: { note: '기록은 이 기기에만 저장됩니다. 7일마다 백업하세요.', primary: '새 동의서 작성', secondary: '백업 · 복원', onP: () => this.setState({ screen: 'new', step: 1, ...NEW_RESET, ...((this.props.testFill ?? false) ? { step: 2, patient: { name: '테스트', birth: '900101', phone: '010-1234-5678' } } : { patient: { name: '', birth: '', phone: '' } }) }), onS: () => this.setState({ bkOpen: true, bkMsg: '', bkPlan: null, bkReady: '', bkPw: '', bkPw2: '', bkPwR: '' }) },
      new: { note: s.step === 3 ? '환자에게 iPad를 전달해 서명을 받습니다.' : '단계를 모두 채우면 환자 확인 화면으로 넘어갑니다.',
             primary: s.step === 3 ? '동의서 미리보기 · 서명' : '다음 단계', secondary: s.step === 1 ? '취소' : '이전',
             onP: () => {
               if (s.step === 3) {
                 if (discKey === 'pre' && !preTier) return this.flash('선결제권 기준을 선택해 주세요');
                 if (discKey === 'pre' && !preNew && !balIn) return this.flash('선결제권 할인은 확인한 보유 잔액이 있거나 신규 구매할 때만 적용할 수 있습니다');
                 if (!preSignOk) return this.flash('선결제권 완납 또는 예약금(' + won(preMin) + '원)을 선택해 주세요');
                 if (preNew && !preBuyM) return this.flash('선결제권 결제수단을 선택해 주세요');
                 if (nowNum > 0 && !selM.length) return this.flash('결제수단을 선택해 주세요');
                 if (isSplit && (!a1 || a1 >= nowNum)) return this.flash('분할결제 금액을 입력해 주세요');
                 if (!totalNum) return this.flash('총 등록금액을 입력해 주세요');
                 if (isManual && !manualUnit) return this.flash('환불용 1회 정상가를 입력해 주세요');
                 { const miss = unitFixLines.find(l => !fixVal(l.key)); if (miss) { this.setState({ tried3: true }); return this.flash('‘' + miss.name + '’의 환불용 1회 정상가를 입력해 주세요'); } }
                 return this.setState({ screen: 'sign', signFrom: 'new', sig: false, sigOpen: false, sigImg: null, ckRefund: false, pendingSign: false, pendingProg: cur ? progTitle(cur) : '', pendingTotal: won(totalNum) });
               }
               if (s.step === 1 && !p1ok) { this.setState({ tried1: true }); return this.flash('환자 정보를 확인해 주세요'); }
               // 횟수 묶음(예: 정상가 1회·3회)은 줄을 펼친 뒤 횟수까지 골라야 선택됨
               if (s.step === 2 && !cur) return this.flash(s.oGrp ? '횟수를 선택해 주세요 (+ 버튼으로 1회 · 3회 등 선택)' : '프로그램을 선택해 주세요');
               if (s.step === 2 && isLesion && !lesionOk) return this.flash('흑자별 부위와 크기(3cm 이하)를 입력해 주세요');
               // 계약금액(할인·선결제권 기준·총 등록금액·1회 정상가)은 2단계에서 확정 → 결제 등록으로 넘어가기 전에 확인
               if (s.step === 2) {
                 if (discKey === 'pre' && !preTier) return this.flash('선결제권 기준을 선택해 주세요');
                 if (discKey === 'pre' && !preNew && !balIn) return this.flash('선결제권 할인은 확인한 보유 잔액이 있거나 신규 구매할 때만 적용할 수 있습니다');
                 if (!totalNum) return this.flash('총 등록금액을 입력해 주세요');
                 if (isManual && !manualUnit) return this.flash('환불용 1회 정상가를 입력해 주세요');
                 { const miss = unitFixLines.find(l => !fixVal(l.key)); if (miss) { this.setState({ tried3: true }); return this.flash('‘' + miss.name + '’의 환불용 1회 정상가를 입력해 주세요'); } }
               }
               return this.setState({ step: s.step + 1, pvOn: false });
             },
             onS: () => s.step === 1 ? this.setState({ screen: 'list' }) : this.setState({ step: s.step - 1, pvOn: false }) },
      detail: (() => {
        const st = s.cStatus;
        if (st === '등록완료') return { primary: '환불 정산', onP: () => this.setState({ screen: 'refund', ...this.rfStateOf(C) }) };
        return { primary: '' };
      })(),
      refund: { note: '최종 환불금액 ' + won(refundNum) + '원으로 정산서를 생성합니다.', primary: '정산서 생성 · 환자 서명', secondary: '취소',
                onP: () => { if (RS.error) return this.flash(RS.error); this.saveDraft(); this.setState({ screen: 'refundSign', sig: false, sigOpen: false, sigImg: null }); },
                onS: () => { this.saveDraft(); this.setState({ screen: 'detail', tab: 'status' }); } }
    };
    const bar = bars[S] || bars.list;

    const titles = {
      list: ['이용 동의 · 환불 정산', '다채움피부과의원 · 프로그램 관리'],
      new: ['새 동의서 작성', '4단계 중 ' + s.step + '단계'],
      detail: [C.patient.name + ' · 상세', C.program],
      refund: ['환불 정산', C.patient.name + ' · ' + C.program]
    };
    const t = titles[S] || titles.list;

    return {
      isChrome: !isSign && !isRefundSign, showBar: !isSign && !isRefundSign && S !== 'new',
      isList: S === 'list', isNew: S === 'new', isDetail: S === 'detail', isRefund: S === 'refund',
      isSign, isRefundSign,
      showBack: S !== 'list', goList: () => { if (S === 'refund') this.saveDraft(); this.setState({ screen: 'list' }); },
      // 디자인 기준(B) 헤더: 뒤로가기 화살표 + 화면 제목. 새 동의서 작성 중에는 기존 '이전'(1단계는 '취소') 동작, 그 외 화면은 목록으로
      goBack: () => S === 'new' ? bar.onS() : (S === 'refund' && this.saveDraft(), this.setState({ screen: 'list' })),
      backTitle: S === 'new' ? (s.step === 1 ? '취소' : '이전') : '목록',
      headTitle: S === 'new' ? ['환자 정보', '프로그램 · 구성', '결제 등록', '미리보기 · 서명'][s.step - 1] || '' : S === 'detail' ? ((C.patient || {}).name || '') + ' · ' + (C.program || '') : S === 'refund' ? '환불 정산' : '이용·환불 동의서',
      stepPct: (Math.min(4, Math.max(1, s.step || 1)) * 25) + '%',
      title: t[0],
      rows: rows.slice(listPg.start, listPg.start + listPg.size), noRows: !rows.length, listPg,
      nameArr: sk === 'name' ? (sd === 'asc' ? '▲' : '▼') : '▲', nameArrFg: sk === 'name' ? '#030213' : '#9ca3af',
      dateArr: sk === 'date' ? (sd === 'asc' ? '▲' : '▼') : '▼', dateArrFg: sk === 'date' ? '#030213' : '#9ca3af',
      sortName: () => this.setState({ sortKey: 'name', sortDir: sk === 'name' && sd === 'asc' ? 'desc' : 'asc' }),
      sortDate: () => this.setState({ sortKey: 'date', sortDir: sk === 'date' && sd === 'desc' ? 'asc' : 'desc' }), steps, programs: programs.map(p => p.rows ? { ...p, rows: p.rows.map(r => ({ ...r, step: this.stepOf(r.opts) })) } : p), methods, tabs,
      pq: s.pq, onPq: e => this.setState({ pq: e.target.value, prog: -1, progId: '' }),
      pCount: db ? (svcOn ? '' : dbHits.length + '개') : '', pTabs, pSubs, pAxes,
      hasPSubs: pSubs.length > 0, hasPAxes: pAxes.length > 0,
      svcOn, svcRows, showProgList: !svcOn,
      addNeed: !!cur && (cur.adds || []).some(a => a.needArea),
      addArea: s.addArea || '',
      addAreaOpts: db && db.capriUnit ? Object.keys(db.capriUnit).filter(k => k !== '풀페이스').map(v => ({ v, label: v })) : [],
      onAddArea: e => this.setState({ addArea: e.target.value }),
      needAmount, amountInput: (s.amounts && s.amounts[manualKey]) || '',
      onAmount: e => { const v = e.target.value.replace(/[^0-9]/g, '');
        this.setState(st => ({ amounts: { ...st.amounts, [manualKey]: v } })); },
      hasUnitFix: unitFixLines.length > 0,
      unitFixRows: unitFixLines.map(l => ({ name: l.name, value: fixVal(l.key) ? won(fixVal(l.key)) : '', bd: s.tried3 && !fixVal(l.key) ? '#d4183d' : 'transparent',
        onInput: e => { const v = e.target.value.replace(/[^0-9]/g, ''); this.setState(st => ({ unitFix: { ...(st.unitFix || {}), [fixKey(l.key)]: v } })); } })),
      unitInput: (s.units && s.units[manualKey]) ? Number(s.units[manualKey]).toLocaleString('ko-KR') : '',
      onUnit: e => { const v = e.target.value.replace(/[^0-9]/g, '');
        this.setState(st => ({ units: { ...st.units, [manualKey]: v } })); },
      st1: s.step === 1, st2: s.step === 2, st3: false, st4: s.step === 3,
      // 2단계 우측: 선택 구성 확인 (동의서는 버튼으로만 표시)
      // 3단계(결제 등록)는 고정 미리보기 없이 결제 내용만 표시하고, 상단 '미리보기' 버튼으로 필요할 때만 동의서를 엶
      // 한 줄 세로 배치: 동의서 미리보기는 단계마다 '동의서 보기'(미리보기) 버튼을 눌렀을 때만 표시
      notSt2: s.step !== 2, showPv: !!s.pvOn, showSel: s.step === 2 && !s.pvOn, showPaySum: s.step === 3 && !s.pvOn,
      pvHeadShow: s.step >= 1 && s.step <= 3, pvSubTitle: '',
      pvHead: s.pvOn ? '동의서 미리보기' : s.step === 3 ? '결제 내용' : s.step === 2 ? '선택 프로그램' : '', pvBtn: s.pvOn ? (s.step === 2 ? '구성 보기' : '닫기') : s.step === 3 ? '미리보기' : '동의서 보기',
      togglePv: () => this.setState(st => ({ pvOn: !st.pvOn })),
      hasSel: !!cur, noSel: !cur, selPrice: cur ? (listNum ? won(listNum) + '원' : '금액 입력') : '',
      hasBaseSel: docItems.some(i => !i.isAdd && i.kind === '시술'),
      addRows: docItems.filter(i => i.isAdd).map(i => ({ name: i.name, qtyText: i.addQtyText && i.addQtyText !== '-' ? '×' + i.addQtyText : '', feeText: i.addPrice ? '+' + won(i.addPrice) : '' })),
      hasAddSel: docItems.some(i => i.isAdd),
      ckRefund: !!s.ckRefund, noCkRefund: !s.ckRefund,
      toggleCkRefund: () => this.setState(st => ({ ckRefund: !st.ckRefund })),
      isLesion, notLesion: !isLesion, lesionRows,
      lesionSites: ['이마', '우측 관자', '좌측 관자', '우측 광대', '좌측 광대', '우측 볼', '좌측 볼', '코', '턱', '목', '손등', '기타'].map(v => ({ v })),
      lesionStep: { label: LS.length + '개', decFg: LS.length > 1 ? '#030213' : 'rgba(0,0,0,0.1)', incFg: '#030213',
        dec: () => LS.length > 1 && this.setState(st => ({ lesions: (st.lesions || LS).slice(0, -1) })),
        inc: () => this.setState(st => ({ lesions: (st.lesions || LS).concat([{ site: '', size: '' }]) })) },
      items: isLesion ? lesionRows.map(r => ({ kind: '시술', name: '흑자 ' + r.no + ' · ' + r.siteText + ' ' + r.sizeText + ' — 피코 532 1회 + 레블라이트 SI 4회',
        count: '1개', unit: r.price ? won(r.price) : '—', amount: r.price ? won(r.price) : '—' })) : docItems.map(i => i.isAdd ? { kind: i.kind, name: i.name, count: i.qtyText, unit: i.priceText, amount: won(i.addPrice) } : ({ kind: i.kind, name: i.name, count: i.qtyText, unit: i.priceText,
        amount: (/[^0-9,]/.test(i.priceText) || !/^\d/.test(i.qtyText)) ? '—'
          : won(Number(i.priceText.replace(/,/g, '')) * (parseInt(i.qtyText, 10) || 0)) })),
      svcNote, svcWhat,
      baseRows: docItems.filter(i => !i.isAdd && i.kind === '시술'),
      swapNotes: cur ? (cur.items || []).filter(i => i.swappedFrom).map(i => ({ text: '변경 · ' + svcName(i.swappedFrom) + ' → ' + svcName(i.name) })) : [],
      hasSwap: !!cur && (cur.items || []).some(i => i.swappedFrom),
      extraRows: docItems.filter(i => i.isAdd || i.kind !== '시술').map(i => ({ kind: i.kind, name: i.name,
        qtyText: i.isAdd ? i.addQtyText : (/^\d/.test(i.qtyText || '') ? i.qtyText : '-'),
        feeText: i.svc ? '무상' : i.isAdd && i.addPrice ? '+' + won(i.addPrice) + '원' : '-' })),
      hasExtra: docItems.some(i => i.isAdd || i.kind !== '시술'),
      // 1회성(당일 종료) 프로그램: 쁘띠·점제거 전체, 또는 시술 1개·1회 구성 → 이용금액 ※ 생략
      noSvcNote: !(cur && (cur.cat === '쁘띠(보톡스·필러)' || cur.cat === 'CO₂·병변제거' || (() => {
        const it = (cur.items || []).filter(i => !isSvcItem(i) && i.kind !== '서비스권');
        return it.length === 1 && (Number(it[0].qty) || 1) <= 1; })())),
      pvRef: this.pvRef, sgRef: this.sgRef,
      pvMb: -Math.ceil((s.pvH || 1046) * (1 - 0.4595)),
      sgMb: Math.floor((s.sgH || 1046) * 0.1081),
      // 조건별 금액 프로그램: 시술 정상가 합계 미표시 (총 계약금액 · 환불용 1회 정상가만)
      showSum: !singleVisit && !isManual, hideSum: singleVisit || isManual, isManualProg: isManual, notManualProg: !isManual,
      sumLabel: isLesion ? '등록 병변 수' : capped ? '총 이용횟수' : '시술 정상가 합계',
      sumValue: isLesion ? LS.length + '개' : capped ? capN + '회' : won(listSumNum - curAdds.reduce((t, a) => t + Number(a.price || 0), 0)),
      svcEditRows, hasSvcEdit: svcEditRows.length > 0,
      hasOptAdds: !!cur && (cur.adds || []).some(a => a.optional),
      optAdds: cur ? (cur.adds || []).filter(a => a.optional).map(a => { const on = addSel.includes(a.id), n = Number(a.qty) || 1, m = on ? svCount(a) : 0, sv = on && m > 0;
        const setM = v => this.setState(st => ({ addSvN: { ...(st.addSvN || {}), [a.id]: Math.max(0, Math.min(n, v)) } }));
        const paid = Math.round(Number(a.price || 0) * (n - m) / n);
        return { label: a.name.replace(/\s*\(\s*\d+\s*회\s*\)/g, '') + ' ' + n + '회', price: m >= n && on ? '서비스' : '+' + won(on ? paid : a.price) + '원',
          multi: on && n > 1, onSingle: on && n <= 1, stop: e => e.stopPropagation(), svN: m + '회', svDec: e => { e.stopPropagation(); setM(m - 1); }, svInc: e => { e.stopPropagation(); setM(m + 1); },
          svDecFg: m > 0 ? '#030213' : 'rgba(0,0,0,0.1)', svIncFg: m < n ? '#030213' : 'rgba(0,0,0,0.1)', ckBd: on ? '#030213' : 'rgba(0,0,0,0.1)', ckBg: on ? '#030213' : '#ffffff', fg: on ? '#0a0a0a' : '#4b5563',
          on, svBd: sv ? '#030213' : 'rgba(0,0,0,0.1)', svBg: sv ? '#030213' : '#ffffff', svFg: sv ? '#0a0a0a' : '#717182', priceFg: sv ? '#030213' : '#717182',
          pickSv: e => { e.stopPropagation(); setM(sv ? 0 : n); },
          pick: () => this.setState(st => ({ addSel: on ? addSel.filter(x => x !== a.id) : addSel.concat(a.id), addSvc: addSvc.filter(x => x !== a.id), addSvN: { ...(st.addSvN || {}), [a.id]: 0 } })) }; }) : [],
      capNote: capped,
      capNoteText: capped ? '※ 본 프로그램은 총 ' + capN + '회이며, 매 회차 의료진 진료 후 프로그램 구성 중 하나를 선택하여 진행합니다.' : '',
      totalPlain: won(totalNum),
      // 할인 선택지: 현재 프로그램·이벤트 설정에서 허용되는 것만 (정액 이벤트는 설정된 중복 허용 할인만, 할인율 이벤트는 하나의 할인으로 선택)
      discShow: !!cur, discLocked: isEvProg && discOptions.length <= 1, discOpen: !!cur && discOptions.length > 1,
      discLockedText: (evDefCur && evDefCur.name ? evDefCur.name + ' ' : '이벤트가 ') + '적용 · 추가 할인 불가',
      discOpts: discOptions.map(d => ({ label: d.label, ...chip(discKey === d.key), pick: () => this.setState({ disc: d.key, preTier: d.key === 'pre' ? s.preTier : '', preNew: d.key === 'pre' ? s.preNew : false }) })),
      isPreDisc: discKey === 'pre', isRetDisc: discKey === 'ret',
      tierOpts: Object.keys(PR.PREPAID_TIER).map(t => ({ label: t, ...chip(preTier === t), pick: () => this.setState({ preTier: t }) })),
      retOpts: PR.RET_PERIODS.map(t => ({ label: t, ...chip((s.retPeriod || '1개월 이내') === t), pick: () => this.setState({ retPeriod: t }) })),
      discNote: isYearSB ? (discKey === 'pre' ? '선결제권 사용 · 1년 이내 혜택가 제외, 정상가 기준 계산' : '리프팅 후 1년 이내 혜택가 · 지인 소개·재티켓팅·이벤트 추가 할인 불가') : noPreHair ? (hairRate ? '제모 결합할인 적용' : '지정 결합가') + ' · 추가 할인 불가' : noRet ? '여드름 4주 프로그램 · 재티켓팅 제외' : '',
      hasDiscNote: !!cur && (isYearSB || noPreHair || noRet),
      hasHairOff: hairRate > 0, hairOffLabel: '제모 결합 ' + hairElig.length + '부위 ' + Math.round(hairRate * 100) + '%', hairOffText: '− ' + won(hairOff) + '원', hairSumText: won(hairSum) + '원',
      hasDisc: !!discRate, discLabel, discBaseText: won(discBase) + '원',
      preBalIn: s.preBal ? won(numOf(s.preBal)) : '', onPreBal: e => this.setState({ preBal: e.target.value.replace(/[^0-9]/g, '') }),
      // 선결제권 결제 안내 (입력: 보유 잔액 · 신규 구매 여부·실제 수납액 / 계산: 사용액·잔액·추가 결제·미수금)
      preNewOn: preNew, preNewLabel: '신규 구매 ' + (preTier ? won(Number(preTier) * 10000) + '원' : ''), preNewBd: chip(!!s.preNew).bd, preNewBg: chip(!!s.preNew).bg, preNewFg: chip(!!s.preNew).fg,
      togglePreNew: () => this.setState({ preNew: !s.preNew, preRcvAmt: '', preBuyM: '' }),
      preBuyMOpts: ['카드', '현금', '계좌이체'].map(m => ({ label: m, ...chip(preBuyM === m), pick: () => this.setState({ preBuyM: m }) })),
      // 선결제권 받는 방식: 완납(전액) / 예약금(10% 자동). 다시 누르면 선택 해제
      preFullText: won(preBuy) + '원', preDepText: won(preMin) + '원',
      preFullBd: chip(preIsFull).bd, preFullBg: chip(preIsFull).bg, preFullFg: chip(preIsFull).fg,
      preDepBd: chip(preIsDep).bd, preDepBg: chip(preIsDep).bg, preDepFg: chip(preIsDep).fg,
      pickPreFull: () => this.setState({ preRcvAmt: preIsFull ? '' : String(preBuy) }), pickPreDep: () => this.setState({ preRcvAmt: preIsDep ? '' : String(preMin) }),
      preNeedDraft: preNew && !preSignOk, notPreNew: !preNew, saveNewDraft: () => this.saveNewDraft({ prog: cur ? progTitle(cur) : '', note: '선결제권 ' + won(preBuy) + '원 · ' + (preRcvAmt ? preRcvLabel + ' ' + won(preRcvAmt) + '원 · ' : '') + '미수금 ' + won(preUnpaid) + '원' }),
      showBalIn: true,
      priorDepIn: s.priorDep ? won(numOf(s.priorDep)) : '', onPriorDep: e => this.setState({ priorDep: e.target.value.replace(/[^0-9]/g, '') }),
      hasPreBal: preBal > 0, preBalText: '− ' + won(Math.min(preBal, totalNum)) + '원',
      hasPriorDep: priorDep > 0, priorDepText: '− ' + won(Math.min(priorDep, Math.max(0, totalNum - preBal))) + '원',
      hasLeft: pdOver > 0, leftText: won(pdOver) + '원', hasRest: dep && needNum - depAmt > 0,
      totalText: won(totalNum) + '원',
      progName: cur ? progTitle(cur) : '',
      docKind: dep ? '예약금용' : '완납용',
      isDeposit: dep,
      isPrepaid: !!cur && /선결제/.test([cur.baseName || cur.name, cur.cat, cur.sub].join(' ')),
      pickDeposit: () => this.setState({ pay: 'deposit' }), pickFull: () => this.setState({ pay: 'full' }),
      depBd: dep ? '#030213' : 'rgba(0,0,0,0.1)', depBg: dep ? '#e9ebef' : '#ffffff',
      fullBd: dep ? 'rgba(0,0,0,0.1)' : '#030213', fullBg: dep ? '#ffffff' : '#e9ebef',
      depCk: ck(dep), fullCk: ck(!dep), depFg: dep ? '#0a0a0a' : '#4b5563', fullFg: dep ? '#4b5563' : '#0a0a0a',
      depText: won(depAmt) + '원', fullText: won(needNum) + '원',
      payHero: preNew && !preSignOk ? '선결제권 미수금 ' + won(preUnpaid) + '원' : (dep ? depAmt : needNum) > 0 ? won(dep ? depAmt : needNum) + '원을 결제할게요'
        : dep && needNum > 0 ? '추가 예약금 없이 등록할게요 (미수 ' + won(needNum) + '원)' : '추가 결제 없이 등록할게요',
      // 3단계 결제 등록: 2단계에서 확정한 계약 정보(읽기 전용) + 오늘 수납 입력. 계산 과정은 표시하지 않고 결과만
      ctrRows: [{ k: '프로그램', v: cur ? progTitle(cur) : '' }, { k: '최종 계약금액', v: won(totalNum) + '원', fw: 700 },
        ...(discRate || hairRate ? [{ k: '할인', v: [hairRate ? '제모 결합 ' + Math.round(hairRate * 100) + '%' : '', discRate ? discLabel : ''].filter(Boolean).join(' · ') }] : []),
        ...(balIn > 0 ? [{ k: '선결제권', v: '보유 잔액 ' + won(balIn) + '원' }] : [])   // 새 선결제권 금액은 아래 카드 제목에 한 번만
      ].map(r => ({ ...r, fw: r.fw || 500 })),
      preBuyTitle: '선결제권',   // 금액은 완납 버튼에 한 번만
      preShortText: '완납 또는 예약금을 선택해 주세요',
      hasNeed: needNum > 0, noNeed: needNum <= 0,
      payCardShow: !preNew || needNum > 0 || pdOver > 0,   // 선결제권 신규 구매로 별도 결제할 항목이 없으면 '결제' 박스 숨김
      // 결제 내용: 수납액(오늘) · 결제수단 · 예약금 · 미수금 · 프로그램 사용 · 잔액 (같은 금액 반복 없이 결과만)
      sumRows: (() => {
        const rest = Math.max(0, needNum - nowNum), unpaid = preUnpaid + rest;
        // 결제수단: 실제 선택한 수단만 (금액은 위 금액 항목). 수단이 둘 이상이면 수단별 금액 표시 (복합결제)
        const byM = [];
        [...(preRcvAmt > 0 && preBuyM ? [{ method: preBuyM, amount: preRcvAmt }] : []), ...(nowNum > 0 && selM.length ? payments : [])].forEach(x => {
          const f = byM.find(y => y.method === x.method); if (f) f.amount += x.amount; else byM.push({ method: x.method, amount: x.amount }); });
        const pm = byM.length ? [byM.map(x => x.method + (byM.length > 1 ? ' ' + won(x.amount) + '원' : '')).join(' · ') + (hasCash && nowNum > 0 ? ' (현금영수증 ' + rcpt + ')' : '')] : [];
        const rows = [{ k: preNew && !nowNum && preRcvAmt ? preRcvLabel : '수납액', v: won(nowNum + preRcvAmt) + '원', big: true },
          ...(pm.length ? [{ k: '결제수단', v: pm.join(' · ') }] : []),
          ...(pdAll > 0 ? [{ k: '예약금', v: won(pdAll) + '원' }] : []),
          ...(unpaid > 0 ? [{ k: '미수금', v: won(unpaid) + '원', warn: true }] : []),
          // 계약금액 전부를 선결제권으로 쓰면 최종 계약금액과 같은 금액이라 다시 표시하지 않음 (일부만 쓸 때만)
          ...(preUse > 0 && preUse < totalNum ? [{ k: '프로그램 사용 (선결제권)', v: won(preUse) + '원' }] : []),
          ...(balIn > 0 || preNew ? [{ k: '잔액', v: won(preLeft) + '원', strong: true }] : []),
          ...(preNew ? [(() => { const why = !preSignOk ? '완납 또는 예약금 선택 후 가능' : !preBuyM || (nowNum > 0 && !selM.length) ? '결제수단 선택 후 가능' : '';
            return { k: '서명', v: why || '가능', warn: !!why }; })()] : [])];
        return rows.map((r, i) => ({ ...r, sep: i ? '1px solid rgba(0,0,0,0.1)' : '0', fs: r.big ? '18px' : '14px', fw: r.big || r.strong ? 700 : 500, fg: r.warn ? '#d4183d' : '#0a0a0a' }));
      })(),
      payLabel: payLabels.label, payNow: payLabels.now, payRest: payLabels.rest,
      tabStatus: s.tab === 'status', tabDocs: s.tab === 'docs',
      dRefunded: s.cStatus === '환불완료', dStatus: s.cStatus, dStatusBg: this.chip(s.cStatus)[0], dStatusFg: this.chip(s.cStatus)[1],
      dPrepaid: /선결제/.test(C.program), hasNotice: !!NOTICE[s.cStatus], dNotice: NOTICE[s.cStatus] || '',
      sigRef: this.attachSig, sigDown: this.down, sigMove: this.move, sigUp: this.up, clearSig: this.clear,
      noSig: !s.sig,
      sigOpen: s.sigOpen, openSigPad: this.openSigPad, closeSigPad: this.closeSigPad, confirmSigPad: this.confirmSigPad,
      hasSigImg: !!s.sigImg, noSigImg: !s.sigImg,
      sigEl: s.sigImg ? React.createElement('img', { src: s.sigImg,
        style: { position: 'absolute', left: 0, bottom: '1px', width: '100%', height: '25px', objectFit: 'contain' } }) : null,
      okBg: s.sig ? '#030213' : 'rgba(0,0,0,0.1)', okFg: s.sig ? '#ffffff' : '#9ca3af',
      exitSign: () => this.setState({ screen: 'new', step: 4 }),
      exitRefundSign: () => this.setState({ screen: 'refund' }),
      ...rf,
      saveSig: () => { if (this._saving) return;
        if (!s.ckRefund) return this.flash('환불 규정 확인에 체크해 주세요');
        if (!s.sigImg) return this.flash('서명이 필요합니다');
        if (s.signFrom === 'resign' && !sameAsContract()) return this.flash(RESIGN_MSG);
        this._saving = true;
        // 새 계약 id는 저장에 실패해도 유지 → 다시 저장할 때 같은 id로 교체 (중복 계약 방지)
        const nc = s.signFrom === 'new' ? { id: s.pendingCtId || 'CT' + Date.now(), ...buildContract(), status: '등록완료' } : null;
        const contracts = nc ? (s.contracts || []).filter(x => x.id !== nc.id).concat([nc]) : null;
        const D = this.buildDoc('이용동의서', ((nc || C).event ? '이벤트 ' : '') + '프로그램 이용 동의서' + ((nc || C).docMode === 'brief' ? ' (재등록)' : ''), nc || C);
        if (!this.commitSigned(contracts, D.docs)) { this._saving = false; if (nc) this.setState({ pendingCtId: nc.id });
          return this.flash(SAVE_FAIL_MSG); }
        setTimeout(() => { this._saving = false; }, 1500);
        // 임시 저장본은 계약·서명 문서가 기기에 저장된 것을 확인한 뒤에만 정리
        if (nc && s.draftId) this.writeDrafts(this.readDrafts().filter(x => x.id !== s.draftId));
        this.setState({ docs: D.docs, justSaved: D.id, screen: 'detail', tab: 'docs', savedSig: s.sigImg, signedAt: todayStr, signFrom: '', pendingSign: false, ckRefund: false,
          ...(nc ? { contracts, cSel: false, contract: nc, cStatus: '등록완료', pendingCtId: '', draftId: '', rfUsed: null, rfVisits: null, rfVar: null, lesions: null, rfLes: null, rfAlloc: null, rfReason: '', rfExtra: '' } : {}) }); },
      saveRefund: () => { if (this._saving) return;
        if (RS.error) return this.flash(RS.error);
        if (!s.sigImg) return this.flash('서명이 필요합니다');
        this._saving = true;
        const refund = { priceFixes: C.priceFixes || [], signedAt: todayStr, stage: usedAmt > 0 ? '시술 시작 후 해지' : '시술 시작 전 해지', ...rfDraft(),
          usedCounts: U, lesAmt, trtAmt, svcAmt, usedAmt, penNum, paidEff, refundNum,
          pays: rfPays.map((p, i) => ({ method: p.prepaid ? '선결제권 잔액 복원' : p.method, prepaid: !!p.prepaid, priorDep: !!p.priorDep, paid: Number(p.amount || 0), refund: RS.amounts[i] })) };
        const nc = { ...C, status: '환불완료', refunded: true, refundedAt: todayStr, refund, refundDraft: null };
        const contracts = (s.contracts || []).map(x => x.id && x.id === nc.id ? nc : x);
        const D = this.buildDoc('환불정산서', '환불 정산서', nc);
        // 계약·정산서가 모두 저장된 경우에만 환불완료. 실패하면 등록완료·작성 중 정산·서명을 그대로 두고 다시 저장할 수 있게 함
        if (!this.commitSigned(contracts, D.docs)) { this._saving = false; return this.flash(SAVE_FAIL_MSG); }
        setTimeout(() => { this._saving = false; }, 1500);
        this.setState({ contracts, contract: nc, cStatus: this.statusOf(nc), docs: D.docs, justSaved: D.id, screen: 'detail', tab: 'docs' });
        this.flash('환불이 완료되었습니다'); },
      primary: bar.primary, secondary: bar.secondary,
      hasSecondary: !!bar.secondary, onPrimary: bar.onP, onSecondary: bar.onS,
      today: todayISO, lq: s.lq || '', onLq: e => this.setState({ lq: e.target.value }),
      pFields,
      dupShow: !!dup, dupDismiss: () => this.setState({ dupOff: (P.name || '').trim() + '|' + P.birth }),
      dupTitle: dup ? '이름과 생년월일이 같은 환자가 이미 등록되어 있습니다' : '',
      dupRows: (dup || []).map((d, i) => ({ sep: i ? '1px solid #f2ead8' : '0', name: d.p.name, birth: d.p.birth || '-', phone: d.p.phone || '-',
        last: d.last + ' ' + (d.lastProg || ''), n: d.n,
        ...(() => { const key = d.p.name + '|' + d.p.birth, on = s.dupPick === key;
          return { ckBd: on ? '#030213' : 'rgba(0,0,0,0.1)', ckBg: on ? '#030213' : '#ffffff',
            use: () => on ? this.setState({ dupPick: '', patient: { ...(s.patient || {}), phone: '' } }) : this.setState({ dupPick: key, patient: { ...(s.patient || {}), ...d.p } }) }; })() })),
      pName: isResign ? C.patient.name : (P.name || ''), pBirth: isResign ? C.patient.birth : (P.birth || ''), pPhone: isResign ? C.patient.phone : (P.phone || ''),
      // 동의서 상단 결제 정보: 저장할 계약 값(재서명은 저장된 계약)에서 표시만 만듦 — 계산·수납 기록은 바꾸지 않음
      ...(() => { const D = isResign ? C : buildContract();
        if (!D) return { docMethod: '', docListText: '', hasDocDisc: false, docDiscText: '', docPayText: '', hasDocDepA: false, hasDocDepB: false, docDepText: '', hasDocDue: false, docDueText: '', hasDocLeftA: false, hasDocLeftB: false, docLeftText: '' };
        const q = D.prepaid || null, pays = D.payments || [], d = D.disc || {}, hc = D.hairCombo || null;
        // 결제수단: 실제 적용된 수단만 '/'로 연결 (금액 없이). 현금영수증은 발급 기록이 있을 때만
        const ms = [];
        const addM = m => { if (m && !ms.includes(m)) ms.push(m); };
        if (q && Number(q.purchase) > 0 && Number(q.received) > 0) addM(q.purchaseMethod);
        pays.filter(x => !x.prepaid).forEach(x => addM(x.method));
        const preUseAmt = pays.filter(x => x.prepaid).reduce((t, x) => t + Number(x.amount || 0), 0);
        if (preUseAmt > 0) ms.push('선결제권');
        if (pays.some(x => x.rcpt === '발급')) ms.push('현금영수증');
        // 할인: 실제 선택한 할인·조건만
        const rate = Number(d.rate || 0);
        const discText = hc ? '제모 결합 ' + hc.parts + '부위 ' + Math.round(hc.rate * 100) + '%'
          : !rate ? '' : d.kind === 'pre' ? '선결제권 ' + (d.preTier || '') + '만원 (' + Math.round(rate * 100) + '%)'
          : d.kind === 'ref' ? '지인소개 5%' : d.kind === 'ret' ? '재티켓팅 10% (' + (d.retPeriod || '1개월 이내') + ')' : (d.label || '');
        const total = Number(D.total || 0), base = discText ? Number(D.listTotal || total) + (hc ? Number(hc.off || 0) : 0) : total;
        // 예약금: 실제 받은 금액 그대로 한 번만 (프로그램 예약금 결제·기납부 예약금 + 선결제권 예약금)
        const paidCash = Number(D.paid || 0) - preUseAmt;
        const dep = (D.pay === 'deposit' ? Math.max(0, paidCash) : Number(D.priorDep || 0)) + (q && q.payType === '예약금' ? Number(q.received || 0) : 0);
        // 미수금(앞으로 받을 돈) = 프로그램 남은 대금 + 선결제권 미수금, 잔액 = 사용하고 남은 선결제권
        const due = Math.max(0, total - Number(D.paid || 0)) + (q ? Number(q.unpaid || 0) : 0);
        return { docMethod: ms.join(' / ') || D.method || '', docListText: won(base) + '원',
          hasDocDisc: !!discText, docDiscText: discText, docPayText: won(total) + '원',
          hasDocDepA: dep > 0 && !discText, hasDocDepB: dep > 0 && !!discText, docDepText: '(예약금: ' + won(dep) + '원)',
          hasDocDue: due > 0, docDueText: won(due) + '원',
          // 잔액(사용하고 남은 선결제권): 예약금처럼 결제금액(할인 없으면 프로그램 금액) 아래에 (잔액: N원)
          hasDocLeftA: !!q && !discText, hasDocLeftB: !!q && !!discText, docLeftText: q ? '(잔액: ' + won(q.balAfter || 0) + '원)' : '' }; })(),
      isBrief, notBrief: !isBrief, briefOK, briefPriorDate: isResign ? (C.priorDate || '') : (priorFull ? priorFull.date : ''),
      briefLabel: s.forceFull ? '전체 동의서' : '간이 동의서 · ' + (isResign ? (C.priorDate || '') : (priorFull ? priorFull.date : '')) + ' 약관', briefBtn: s.forceFull ? '간이 동의서로' : '전체 동의서로',
      toggleForceFull: () => this.setState({ forceFull: !s.forceFull }),
      newForPatient: () => this.setState({ ...NEW_RESET, screen: 'new', step: 2, patient: { ...C.patient }, cSel: false }),
      isSplit, hasCash, splitA: selM[0] || '', splitB: selM[1] || '', split1: s.split1 || '', split2Text: won(Math.max(0, nowNum - a1)) + '원',
      onSplit1: e => { const v = e.target.value.replace(/[^0-9]/g, ''); this.setState({ split1: v ? Number(v).toLocaleString('ko-KR') : '' }); },
      rcptOpts: ['발급', '미발급'].map(v => ({ label: v, ...ck(rcpt === v), fg: rcpt === v ? '#0a0a0a' : '#4b5563', pick: () => this.setState({ cashRcpt: v }) })),
      // 결제 정보: 입력은 임시(payDraft)에만 반영 → [저장] → 1차 확인 → [확인 후 저장]에서만 계약에 기록
      ...(() => { const saved = (C && C.payments) || [], draft = s.payDraft, dirty = !!draft;
        const doSave = () => this.setState(st => { const c = { ...st.contract, payments: st.payDraft };
          const contracts = (st.contracts || []).map(x => x.id && x.id === c.id ? c : x);
          try { localStorage.setItem('dachaeum.v3.contracts', JSON.stringify(contracts.filter(x => !x.sample))); } catch (err) {}
          return { contract: c, contracts, payDraft: null, payConfirm: false }; }, () => this.flash('결제 정보가 저장되었습니다'));
        const cur2 = draft || saved;
        return { payDirty: dirty, payConfirm: !!s.payConfirm,
          payAskSave: () => { if (!dirty) return;
            if (!draft.every(p => this.payDone({ ...p, payDate: p.payDate || C.date }))) return this.flash('빈 항목을 모두 입력해야 저장할 수 있습니다');
            this.setState({ payConfirm: true }); },
          payCancelConfirm: () => this.setState({ payConfirm: false }), payDoSave: doSave,
          payRevert: () => this.setState({ payDraft: null }),
          paySaveBg: dirty ? '#030213' : 'rgba(0,0,0,0.1)',
          payConfirmRows: cur2.map(p => ({ title: p.method + ' ' + won(p.amount) + '원',
            lines: p.method === '카드'
              ? [['카드사', p.bank === '기타' ? (p.bankEtc || '-') : (p.bank || '-')], ['카드번호 뒤 4자리', p.cardNo || '-'], ['결제일', p.payDate || C.date || '-'], ['승인번호', p.approval || '-'], ['할부', p.inst || '일시불']]
              : [['현금영수증', p.rcpt || '미발급']].concat(p.rcpt === '발급' ? [['용도', p.rcptUse || '소득공제'], ['발급번호', p.rcptNo || '-'], ['승인번호', p.rcptAppr || '-']] : []),
            ok: this.payDone({ ...p, payDate: p.payDate || C.date }) })).map(r => ({ ...r, lines: r.lines.map(([k, v]) => ({ k, v, fg: v === '-' ? '#d4183d' : '#0a0a0a' })),
              okText: r.ok ? '입력 완료' : '빈 항목 있음', okFg: r.ok ? '#717182' : '#4b5563' })) }; })(),
      payInfo: (s.payDraft || (C && C.payments) || []).map((p, i) => {
        const upd = (k, fmt) => e => { const v = fmt ? fmt(e.target.value) : e.target.value;
          this.setState(st => { const base = st.payDraft || (st.contract && st.contract.payments) || [];
            return { payDraft: base.map((q, j) => j === i ? { ...q, [k]: v } : q) }; }); };
        const isCard = p.method === '카드', needNo = !isCard && p.rcpt === '발급';
        const savedP = ((C && C.payments) || [])[i] || p;
        const todo = !this.payDone({ ...savedP, payDate: savedP.payDate || C.date });
        return { method: p.method, amount: won(p.amount) + '원', isCard, isCash: !isCard, needNo, rcptText: '현금영수증 ' + (p.rcpt || '미발급'),
          inst: p.inst || '일시불', onInst: upd('inst'), instOpts: ['일시불', '2개월', '3개월', '4개월', '5개월', '6개월', '10개월', '12개월'],
          ...(() => { const IO = ['일시불', '2개월', '3개월', '4개월', '5개월', '6개월', '10개월', '12개월'], ix = Math.max(0, IO.indexOf(p.inst || '일시불'));
            return { instDec: () => ix > 0 && upd('inst')({ target: { value: IO[ix - 1] } }), instInc: () => ix < IO.length - 1 && upd('inst')({ target: { value: IO[ix + 1] } }) }; })(),
          rcptUse: p.rcptUse || '소득공제', onRcptUse: upd('rcptUse'), rcptAppr: p.rcptAppr || '', onRcptAppr: upd('rcptAppr', v => { const d = v.replace(/[^0-9]/g, '').slice(0, 9); return d.length > 6 ? d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6) : d.length > 3 ? d.slice(0, 3) + '-' + d.slice(3) : d; }),
          bank: p.bank || '', cardNo: p.cardNo || '', payDate: p.payDate || C.date || '', approval: p.approval || '', rcptNo: p.rcptNo || '',
          onBank: upd('bank'), bankEtc: p.bankEtc || '', onBankEtc: upd('bankEtc'), isBankEtc: p.bank === '기타',
          bankOpts: ['', '신한', '삼성', '현대', 'KB국민', '롯데', '하나', '우리', 'BC', 'NH농협', '기타'].map(v => ({ v, label: v || '- 선택 -' })), onCardNo: upd('cardNo', v => v.replace(/[^0-9]/g, '').slice(0, 4)), onPayDate: upd('payDate'), onApproval: upd('approval', v => { const d = v.replace(/[^0-9]/g, '').slice(0, 8); return d.length > 4 ? d.slice(0, 4) + '-' + d.slice(4) : d; }),
          // 발급번호: 010으로 시작하면 휴대폰(3-4-4), 10자리면 사업자번호(3-2-5)
          onRcptNo: upd('rcptNo', v => { const d = v.replace(/[^0-9]/g, '').slice(0, 11);
            if (/^01/.test(d)) return d.length > 7 ? d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7) : d.length > 3 ? d.slice(0, 3) + '-' + d.slice(3) : d;
            return d.length > 5 ? d.slice(0, 3) + '-' + d.slice(3, 5) + '-' + d.slice(5, 10) : d.length > 3 ? d.slice(0, 3) + '-' + d.slice(3) : d; }),
          ...(s.payDraft ? { stateText: '저장 안 됨', stateBg: '#e9ebef', stateFg: '#030213' }
            : { stateText: todo ? '입력 필요' : '입력 완료', stateBg: todo ? '#f9fafb' : '#f9fafb', stateFg: todo ? '#4b5563' : '#717182' }) }; }),
      hasPayInfo: !!(C && C.payments && C.payments.length),
      // 잔금 결제: 예약금 계약의 남은 금액을 결제수단별로 기록 → 결제내역(payments)·납부금액(paid)에 누적. 기존 결제 기록은 그대로 두고 추가만 함
      ...(() => {
        const rest = Math.max(0, Number(C.total || 0) - Number(C.paid || 0));
        const st = s.cStatus, show = !!C.id && rest > 0 && st === '등록완료';
        const bm = s.balMethod || '', brc = s.balRcpt || '미발급';
        const amt = numOf(s.balAmt) || rest, date = s.balDate || todayStr;
        const save = () => {
          if (this._saving) return;
          // 결제 정보 수정 중(저장 전)에 잔금을 기록하면, 이후 [저장] 시 수정본이 결제내역을 덮어써 잔금 기록이 사라짐 → 먼저 저장·되돌리기
          if (s.payDraft) return this.flash('결제 정보 수정 중입니다. 먼저 저장하거나 되돌려 주세요');
          if (!bm) return this.flash('결제수단을 선택해 주세요');
          if (amt > rest) return this.flash('남은 잔금(' + won(rest) + '원)보다 많이 기록할 수 없습니다');
          if (!confirm(bm + ' ' + won(amt) + '원을 ' + date + ' 잔금 결제로 기록합니다.')) return;
          this._saving = true; setTimeout(() => { this._saving = false; }, 1500);
          // 결제내역이 없는 이전 계약은 기존 납부분을 먼저 결제내역으로 옮겨 적은 뒤 잔금을 추가
          const base = C.payments && C.payments.length ? C.payments : [{ method: C.method || '카드', amount: Number(C.paid || 0) }];
          const pay = { method: bm, amount: amt, balance: true, payDate: date, ...(bm === '카드' ? { bank: '', cardNo: '', approval: '' } : { rcpt: brc, rcptNo: '' }) };
          const paid = Number(C.paid || 0) + amt;
          this.saveContract({ ...C, payments: base.concat([pay]), paid, pay: paid >= Number(C.total || 0) ? 'full' : 'deposit',
            method: String(C.method || '').includes(bm) ? C.method : [C.method, bm].filter(Boolean).join(' + ') },
            { balMethod: '', balAmt: '', balDate: '', balRcpt: '' });
          this.flash('잔금 결제가 기록되었습니다');
        };
        return { balShow: show, balRest: won(rest), balAmt: s.balAmt ? won(numOf(s.balAmt)) : '', balDate: date, balIsCash: !!bm && bm !== '카드',
          balMethods: ['카드', '현금', '계좌이체'].map(m => { const on = bm === m; return { label: m, ...ck(on), ...tile(m, on), fg: on ? '#0a0a0a' : '#4b5563', fw: on ? 600 : 500, pick: () => this.setState({ balMethod: m }) }; }),
          balRcptOpts: ['발급', '미발급'].map(v => ({ label: v, ...ck(brc === v), fg: brc === v ? '#0a0a0a' : '#4b5563', pick: () => this.setState({ balRcpt: v }) })),
          onBalAmt: e => this.setState({ balAmt: e.target.value.replace(/[^0-9]/g, '') }), onBalDate: e => this.setState({ balDate: e.target.value }),
          saveBalance: save };
      })(),
      // 환자별 계약(티켓) 목록 → 선택 시 계약·결제 정보 한 화면
      ...(() => {
        const pkOf = c => (c.patient.name || '') + '|' + (c.patient.birth || '');
        const mine = (s.contracts || []).filter(c => pkOf(c) === pkOf(C));
        const list = mine.length ? mine.slice().reverse() : [C];
        const payTodo = c => (c.payments || []).some(p => !this.payDone({ ...p, payDate: p.payDate || c.date }));
        return { cCount: list.length, cListView: !s.cSel, cDetailView: !!s.cSel,
          backToCList: () => { if (s.payDraft && !confirm('저장하지 않은 결제 정보가 있습니다. 저장하지 않고 나갈까요?')) return; this.setState({ cSel: false, payDraft: null }); },
          cRows: list.map((c, i) => { const todo = payTodo(c), refunded = !!c.refunded;
            return { sep: i ? '1px solid rgba(0,0,0,0.1)' : '0', prog: c.program, refunded,
              sub: c.date + ' 등록 · ' + (preDueOf(c) ? (c.pay === 'deposit' ? '예약금 · ' : '') + preDueOf(c) : c.pay === 'deposit' ? '예약금' : '완납') + ' · ' + (c.method || '-'),
              total: won(c.total) + '원', st: (c.payments && c.payments.length) ? (todo ? '결제정보 입력 필요' : '결제정보 입력 완료') : '결제정보 없음',
              stBg: todo ? '#f9fafb' : '#f9fafb', stFg: todo ? '#4b5563' : '#717182',
              open: () => this.setState({ contract: c, cStatus: this.statusOf(c), cSel: true, ...this.rfStateOf(c) }) }; }) };
      })(),
      isEvent: isResign ? !!C.event : isEventCur, notEvent: !(isResign ? !!C.event : isEventCur),
      evFirst, evFirstText: isResign ? (C.firstDate || '') : evFirst, evExpiryText: isResign ? C.expiry : evExpiry,
      onEvFirst: e => this.setState({ evFirst: e.target.value }),
      docDate: isResign ? C.date : todayISO, docDateKo: koDate(todayISO),
      expiryText: isEventCur && !isResign ? evExpiry : (cur && /선결제/.test([cur.baseName || cur.name, cur.cat, cur.sub].join(' '))) ? '기간 제한 없음 (선결제권)' : addYear(todayISO),
      ckBd: s.ckRefund ? '#345b80' : '#8d949b', ckBg: s.ckRefund ? '#345b80' : '#ffffff',
      rfInitial: (C.patient.name || '?').slice(0, 1),
      docList: docList.slice(docPg.start, docPg.start + docPg.size), docPg, hasDocs: docList.length > 0, noDocs: !docList.length,
      yes: true, delAsk: !!s.delAsk, stop: e => e.stopPropagation(),
      delMsg: s.delAsk && s.delAsk !== 'all' ? '이 문서가 삭제되며 되돌릴 수 없습니다.' : '이 환자의 계약 정보와 모든 문서가 삭제되며 되돌릴 수 없습니다.',
      // 환자 전체 삭제: 삭제 대상(계약·결제·이용기록·서명 문서)이 불명확해 차단. 보관기간·영구 삭제 정책은 별도 결정 전까지 사용하지 않음
      delStart: () => this.flash('서명 기록 보호를 위해 환자 삭제는 사용할 수 없습니다'), delCancel: () => this.setState({ delAsk: false }),
      delConfirm: () => { const one = s.delAsk && s.delAsk !== 'all';
        const target = one ? (s.docs || []).find(d => d.id === s.delAsk) : null;
        if (!one || !target || target.signedAt) { this.setState({ delAsk: false }); return this.flash('서명 기록은 삭제할 수 없습니다'); }
        const docs = (s.docs || []).filter(d => one ? d.id !== s.delAsk : d.pk !== curPk);
        try { localStorage.setItem('dachaeum.v3.docs', JSON.stringify(docs)); } catch (e) {}
        this.setState(one ? { docs, delAsk: false, pdfId: null } : { docs, contract: null, delAsk: false, justSaved: null, pdfId: null, screen: 'list' }); this.flash('삭제되었습니다'); },
      pdfOpen: !!pdfDoc, pdfTitle: pdfDoc ? pdfDoc.title : '', pdfFile: pdfDoc ? pdfDoc.fileName : '',
      pdfVerLabel: pdfDoc ? (pdfDoc.superseded ? '대체됨' : '최종본') + ' · v' + pdfDoc.version : '',
      pdfVerBg: pdfDoc && pdfDoc.superseded ? '#f9fafb' : 'rgba(3,2,19,.08)', pdfVerFg: pdfDoc && pdfDoc.superseded ? '#717182' : '#1c1b2b',
      pdfEl: pdfDoc ? React.createElement('div', { id: 'pdfv', style: { width: 740, flex: 'none', background: '#ffffff', boxShadow: '0 2px 14px rgba(0,0,0,.12)' },
        dangerouslySetInnerHTML: { __html: this.cleanHtml(pdfDoc.html) || '<div style="padding:60px;text-align:center;color:#717182">문서 내용이 없습니다</div>' } }) : null,
      closePdf: () => this.setState({ pdfId: null }),
      sharePdf: () => this.sharePdf(),
      pdfBtnLabel: s.pdfReady === true ? 'PDF 저장·공유·인쇄' : s.pdfReady === 'fail' ? 'PDF 생성 실패 · 다시 시도' : 'PDF 만드는 중…',
      pdfBtnOp: s.pdfReady === true ? 1 : 0.55,
      hasPrimary: !!bar.primary,
      toast: s.toast,
      hasDrafts: S === 'list' && (s.drafts || []).length > 0,
      draftRows: (s.drafts || []).map(d => ({ name: d.name || '-', prog: d.prog || '-', note: d.note || '',
        resume: () => this.setState({ screen: 'new', ...NEW_RESET, ...(d.state || {}), draftId: d.id }),
        del: () => { if (confirm('임시 저장한 작성 내용을 삭제합니다. (서명된 계약·문서가 아닙니다)')) this.writeDrafts(this.readDrafts().filter(x => x.id !== d.id)); } })),
      ...(() => {
        const last = (() => { try { return localStorage.getItem('dachaeum.v3.lastBackup') || ''; } catch (e) { return ''; } })();
        const cur = { contracts: (s.contracts || []).filter(c => !c.sample).length, docs: (s.docs || []).length };
        const msg = (t, err) => this.setState({ bkMsg: t, bkErr: !!err, bkBusy: false });
        const plan = s.bkPlan;
        return { bkOpen: !!s.bkOpen, bkClose: () => { if (s.bkBusy) return; this._bkFile = null; this.setState({ bkOpen: false, bkPlan: null, bkReady: '', bkPw: '', bkPw2: '', bkPwR: '' }); },
          bkLast: last ? '마지막 백업 ' + last.slice(0, 16).replace('T', ' ') : '아직 이 기기에서 백업한 기록이 없습니다',
          bkCur: '현재 기기: 계약 ' + Math.max(0, cur.contracts) + '건 · 문서 ' + Math.max(0, cur.docs) + '건',
          bkPw: s.bkPw || '', bkPw2: s.bkPw2 || '', bkPwR: s.bkPwR || '',
          onBkPw: e => this.setState({ bkPw: e.target.value }), onBkPw2: e => this.setState({ bkPw2: e.target.value }), onBkPwR: e => this.setState({ bkPwR: e.target.value }),
          hasBkMsg: !!s.bkMsg, bkMsg: s.bkMsg || '', bkMsgFg: s.bkErr ? '#d4183d' : '#0a0a0a',
          bkExport: async () => {
            if (s.bkBusy) return;
            if (!(window.crypto && crypto.subtle)) return msg('이 브라우저 환경에서는 암호화 백업을 만들 수 없습니다. https 주소(병원 페이지)에서 열어 주세요', true);
            if (String(s.bkPw || '').length < 6) return msg('비밀번호를 6자 이상 입력해 주세요', true);
            if (s.bkPw !== s.bkPw2) return msg('비밀번호 확인이 일치하지 않습니다', true);
            this._bkFile = null;
            this.setState({ bkBusy: true, bkReady: '', bkMsg: '백업 파일을 만드는 중입니다…', bkErr: false });
            try {
              const out = await this.exportBackup(s.bkPw);
              this._bkFile = { file: new File([out.text], out.name, { type: 'application/json' }), counts: out.counts };
              this.setState({ bkPw: '', bkPw2: '', bkReady: out.name, bkBusy: false,
                bkMsg: '백업 파일을 만들었습니다 (계약 ' + out.counts.contracts + '건 · 문서 ' + out.counts.docs + '건). [파일 저장]을 눌러 iPad의 ‘파일’ 등에 저장해 주세요.', bkErr: false });
            } catch (e) { msg('백업 파일을 만들지 못했습니다', true); }
          },
          hasBkReady: !!s.bkReady, bkReadyName: s.bkReady || '',
          // 공유 시트는 탭 직후에 바로 호출해야 함(Safari). 공유를 취소하면 저장된 것으로 기록하지 않음
          bkSave: () => {
            const B = this._bkFile; if (!B) return msg('백업 파일을 먼저 만들어 주세요', true);
            const done = () => { try { localStorage.setItem('dachaeum.v3.lastBackup', new Date().toISOString()); } catch (e) {}
              this.setState({ bkReady: '' }); this._bkFile = null; msg('백업 파일을 저장했습니다. 비밀번호를 잊으면 복원할 수 없습니다.'); };
            const download = () => { const url = URL.createObjectURL(B.file), a = document.createElement('a'); a.href = url; a.download = B.file.name;
              document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); done(); };
            if (navigator.canShare && navigator.share && navigator.canShare({ files: [B.file] })) {
              navigator.share({ files: [B.file], title: B.file.name }).then(done).catch(err => {
                if (err && err.name === 'AbortError') msg('저장을 취소했습니다. 백업 파일은 아직 저장되지 않았습니다', true);
                else download(); });
            } else download();
          },
          onBkFile: async e => {
            const f = e.target.files && e.target.files[0]; e.target.value = '';
            if (!f || s.bkBusy) return;
            if (!(window.crypto && crypto.subtle)) return msg('이 브라우저 환경에서는 암호화 백업을 열 수 없습니다. https 주소(병원 페이지)에서 열어 주세요', true);
            if (!s.bkPwR) return msg('백업 비밀번호를 먼저 입력해 주세요', true);
            this.setState({ bkBusy: true, bkMsg: '백업 파일을 검사하는 중입니다…', bkErr: false, bkPlan: null });
            // Blob.text()가 없는 이전 Safari 대비 FileReader 사용
            const readText = file => file.text ? file.text() : new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(r.error); r.readAsText(file); });
            try { const r = await this.readBackup(await readText(f), s.bkPwR); this.setState({ bkPlan: { ...r, fileName: f.name }, bkBusy: false, bkMsg: '' }); }
            catch (err) { msg(err.message || '백업 파일을 읽지 못했습니다', true); }
          },
          hasBkPlan: !!plan,
          bkPlanText: plan ? '백업 파일: 계약 ' + plan.counts.contracts + '건 · 문서 ' + plan.counts.docs + '건 (환불완료 ' + plan.counts.refunded + '건) · ' + String(plan.createdAt).slice(0, 16).replace('T', ' ') + ' 백업' : '',
          bkPlanWarn: cur.contracts > 0 || cur.docs > 0
            ? '복원하면 이 기기의 동의서 앱 자료(계약 ' + Math.max(0, cur.contracts) + '건 · 문서 ' + Math.max(0, cur.docs) + '건)가 백업 파일 자료로 교체됩니다. 두 자료는 합쳐지지 않으니, 필요하면 먼저 현재 자료를 백업해 두세요.'
            : '이 기기에는 동의서 앱 자료가 없습니다. 백업 파일 자료를 그대로 복원합니다.',
          bkCancelPlan: () => this.setState({ bkPlan: null, bkMsg: '' }),
          bkRestore: () => {
            if (!plan || s.bkBusy) return;
            if (!confirm('백업 파일 자료로 복원합니다.\n' + (cur.contracts > 0 || cur.docs > 0 ? '현재 기기의 동의서 앱 자료는 교체됩니다 (합치지 않음).' : '') + '\n계속할까요?')) return;
            if (!this.applyRestore(plan.keys)) return msg('복원에 실패했습니다. 기존 자료는 그대로 남아 있습니다.', true);
            location.reload();
          } };
      })(),
      // ---- 가격 관리 (동의서 앱 안에서 열림) ----
      // 기존 가격 데이터(programs.json) + 기존 변경 기록(dachaeum.priceOverride · unitOverride · eventOverride)을 그대로 사용
      // 프로그램 이름 · 총 등록금액 · 환불용 1회 정상가 · 이벤트 설정을 각각 따로 수정·되돌림
      // 저장된 계약은 계약 당시 금액을 따로 가지고 있으므로 바뀌지 않고, 새 계약부터 적용됨
      ...(() => {
        const CT = window.DachaeumCatalog, base = this._base;
        const RESET = { pmQ: '', pmEdit: {}, pmEditU: {}, pmEditN: {}, evEdit: {}, evAdd: {}, evNew: {}, pmMsg: '' };
        const close = () => this.setState({ pmOpen: false, ...RESET });
        const tab = s.pmTab === 'event' ? 'event' : 'price';
        const out = { pmShow: () => this.setState({ pmOpen: true, pmTab: 'price', ...RESET }), pmOpen: !!s.pmOpen, pmClose: close,
          pmTabPrice: tab === 'price', pmTabEvent: tab === 'event', evCards: [], evNewName: '', evNewPct: '', evNewStart: '', evNewEnd: '',
          pmTabs: [['price', '가격 · 이름'], ['event', '이벤트']].map(([k, l]) => ({ label: l, bd: tab === k ? '#030213' : 'rgba(0,0,0,0.1)', bg: tab === k ? '#030213' : '#ffffff', fg: tab === k ? '#ffffff' : '#0a0a0a',
            pick: () => this.setState({ pmTab: k, pmMsg: '' }) })),
          pmQ: s.pmQ || '', onPmQ: e => this.setState({ pmQ: e.target.value }), pmReady: !!(CT && base), pmLoading: !(CT && base),
          pmRows: [], pmHint: '', pmChanged: [], pmHasChanged: false, pmOther: '', pmHasOther: false,
          hasPmMsg: !!s.pmMsg, pmMsg: s.pmMsg || '', pmMsgFg: s.pmErr ? '#d4183d' : '#0a0a0a' };
        if (!s.pmOpen || !CT || !base) return out;
        const ov = CT.readOverride(), uo = CT.readUnits(), eo = CT.readEvents();
        const cur = CT.applyEventOv(CT.applyUnits(CT.applyOverride(base, ov), uo), eo);
        const baseOf = {}; (base.programs || []).forEach(p => { baseOf[p.id] = p; });
        const added = new Set(((ov && ov.added) || []).map(p => p.id));
        const msg = (t, err) => this.setState({ pmMsg: t, pmErr: !!err });
        const write = (next, done, key) => {
          try { localStorage.setItem(key || CT.OV_KEY, JSON.stringify(next)); } catch (e) { return msg('기기 저장 공간이 부족해 저장하지 못했습니다. 기존 가격은 그대로입니다', true); }
          this._dbKey = null; if (this._reload) this._reload();
          const ed = { ...(s.pmEdit || {}) }, eu = { ...(s.pmEditU || {}) }, en = { ...(s.pmEditN || {}) }, ee = { ...(s.evEdit || {}) };
          delete ed[done.id]; delete eu[done.uk]; delete en[done.nid]; delete ee[done.evId];
          this.setState({ pmEdit: ed, pmEditU: eu, pmEditN: en, evEdit: ee, ...(done.extra || {}) }); msg(done.text);
        };
        const parse = raw => { raw = String(raw).trim();
          if (!/^[0-9][0-9,\s]*원?$/.test(raw)) { msg('금액은 숫자로만 입력해 주세요 (예: 330,000)', true); return 0; }
          const price = Number(raw.replace(/[^0-9]/g, '')); if (!(price > 0)) { msg('0원은 저장할 수 없습니다', true); return 0; } return price; };
        // 시술별 환불용 1회 정상가: 기본값(가격 데이터) 있는 시술 항목만 수정. 정상가 확인 필요·개당 정산·서비스·조건별 금액은 수정 칸 없음
        // 공통 시술(시술 ID + 가격 기준이 모든 프로그램에서 같은 경우)은 한 번 수정하면 그 시술을 쓰는 모든 프로그램에 적용, 나머지는 프로그램별
        const stamp = () => { const d = new Date(), z = n => String(n).padStart(2, '0');
          return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()); };
        const common = CT.commonUnits(base);
        const procName = id => ((base.procs || []).find(x => x.id === id) || {}).name || id;
        const unitRows = (p, b) => (p.items || []).map((i, k) => {
          const bi = b && (b.items || []).find(x => x.id === i.id);
          const cm = common[i.id];
          const baseU = cm ? cm.price : bi ? Number(bi.settleUnit || 0) || Number(bi.unitPrice || 0) : 0;
          const curU = Number(i.settleUnit || 0) || Number(i.unitPrice || 0);
          const uk = cm ? CT.procKey(i.id) : CT.unitKey(p.id, i.id), changed = !!(uo && uo.items && uo.items[uk]);
          const svc = i.kind === '서비스권' || i.kind === '서비스';
          const ok = !svc && !p.lesion && !i.unitFromTotal && !Number(i.perPiece || 0) && baseU > 0 && (p.items || []).findIndex(x => x.id === i.id) === k;
          const note = svc ? '' : p.lesion ? '' : Number(i.perPiece || 0) ? '개당 정산 항목' : !baseU ? (i.priceState || '정상가 확인 필요') + ' · 등록 시 입력' : '';
          if (!ok && !note) return null;
          const scope = cm ? '공통 시술 · ' + cm.programs + '개 프로그램에 함께 적용' : '이 프로그램에만 적용';
          const where = cm ? '시술 「' + procName(i.id) + '」 (' + cm.programs + '개 프로그램 공통)' : '[' + p.id + '] ' + p.name + ' · ' + i.name;
          const val = (s.pmEditU || {})[uk] ?? '';
          const setU = price => cm ? CT.setProcUnit(uo, i.id, price, stamp()) : CT.setUnit(uo, p.id, i.id, price, stamp());
          const clearU = () => cm ? CT.clearProcUnit(uo, i.id, stamp()) : CT.clearUnit(uo, p.id, i.id, stamp());
          const save = () => { const price = parse(val); if (!price) return;
            if (price === curU) return msg('현재 적용 중인 1회 정상가와 같습니다', true);
            if (!confirm(where + '\n환불용 1회 정상가 ' + won(curU) + '원 → ' + won(price) + '원\n\n총 등록금액은 바뀌지 않습니다. 새 계약부터 적용되고, 이미 저장된 계약의 1회 정상가는 바뀌지 않습니다.')) return;
            write(price === baseU ? clearU() : setU(price), { uk, text: i.name + ' 1회 정상가를 ' + won(price) + '원으로 저장했습니다 (' + (cm ? cm.programs + '개 프로그램 · ' : '') + '새 계약부터 적용)' }, CT.UNIT_KEY); };
          const reset = () => { if (!confirm(where + '\n1회 정상가 변경(' + won(curU) + '원)을 지우고 기본 ' + won(baseU) + '원으로 되돌립니다.\n이미 저장된 계약은 바뀌지 않습니다.')) return;
            write(clearU(), { uk, text: i.name + ' 1회 정상가를 기본 ' + won(baseU) + '원으로 되돌렸습니다' }, CT.UNIT_KEY); };
          return { name: i.name, qty: i.qty ? i.qty + (i.unit || '회') : '', curText: curU ? won(curU) + '원' : '—', baseText: baseU ? '기본 ' + won(baseU) + '원' : '',
            scopeText: ok ? scope : '', ukey: uk, changed: changed && ok, editable: ok, notEditable: !ok, note, val,
            onVal: e => this.setState({ pmEditU: { ...(s.pmEditU || {}), [uk]: e.target.value } }), save, reset };
        }).filter(Boolean);
        const row = p => {
          const b = baseOf[p.id], ovT = ov && ov.programs && ov.programs[p.id] && Object.prototype.hasOwnProperty.call(ov.programs[p.id], 'total');
          const editable = !!b && !added.has(p.id) && !p.lesion && !!Number(b.total || 0);
          const note = p.lesion ? '병변 크기별 금액으로 계산 (여기서 수정하지 않음)' : added.has(p.id) ? '가격 관리에서 추가된 항목' : !Number((b || p).total || 0) ? '조건별 금액 (등록 시 입력)' : '';
          const val = (s.pmEdit || {})[p.id] ?? '';
          const save = () => {
            const price = parse(val); if (!price) return;
            if (price === Number(p.total || 0)) return msg('현재 적용 가격과 같습니다', true);
            if (!confirm('[' + p.id + '] ' + p.name + '\n총 등록금액 ' + won(p.total) + '원 → ' + won(price) + '원\n\n새 계약부터 적용되고, 이미 저장된 계약 금액은 바뀌지 않습니다.')) return;
            const next = price === Number(b.total || 0) ? CT.clearProgramTotal(ov, p.id, stamp()) : CT.setProgramTotal(ov, p.id, price, stamp());
            write(next, { id: p.id, text: p.name + ' 가격을 ' + won(price) + '원으로 저장했습니다 (새 계약부터 적용)' });
          };
          const reset = () => {
            if (!confirm('[' + p.id + '] ' + p.name + '\n변경 가격 ' + won(p.total) + '원을 지우고 기본 가격 ' + won(b.total) + '원으로 되돌립니다.\n이미 저장된 계약 금액은 바뀌지 않습니다.')) return;
            write(CT.clearProgramTotal(ov, p.id, stamp()), { id: p.id, text: p.name + ' 가격을 기본 가격 ' + won(b.total) + '원으로 되돌렸습니다' });
          };
          // 프로그램 표시 이름: ID는 그대로, 이름만 변경. 새 화면·새 계약·새 동의서에 반영, 저장된 계약·문서는 그대로
          const ovN = !!(ov && ov.programs && ov.programs[p.id] && Object.prototype.hasOwnProperty.call(ov.programs[p.id], 'name'));
          const nameVal = (s.pmEditN || {})[p.id] ?? '';
          const saveName = () => {
            const v = String(nameVal).replace(/\s+/g, ' ').trim();
            if (!v) return msg('바꿀 프로그램 이름을 입력해 주세요', true);
            if (v.length > 80) return msg('프로그램 이름은 80자 이내로 입력해 주세요', true);
            if (v === p.name) return msg('현재 이름과 같습니다', true);
            if (!confirm('[' + p.id + '] 프로그램 이름\n' + p.name + ' → ' + v + '\n\n프로그램 ID와 금액·구성은 그대로입니다. 새 계약·새 동의서부터 적용되고, 이미 저장된 계약과 서명 문서의 이름은 바뀌지 않습니다.')) return;
            write(b && v === b.name ? CT.clearProgramField(ov, p.id, 'name', stamp()) : CT.setProgramField(ov, p.id, 'name', v, stamp()), { nid: p.id, text: '프로그램 이름을 ‘' + v + '’(으)로 저장했습니다 (새 계약부터 적용)' });
          };
          const resetName = () => { if (!b) return;
            if (!confirm('[' + p.id + '] 프로그램 이름을 기본 이름 ‘' + b.name + '’(으)로 되돌립니다.\n이미 저장된 계약과 서명 문서는 바뀌지 않습니다.')) return;
            write(CT.clearProgramField(ov, p.id, 'name', stamp()), { nid: p.id, text: '프로그램 이름을 기본 이름 ‘' + b.name + '’(으)로 되돌렸습니다' }); };
          return { id: p.id, name: p.name, cat: p.cat || '', curText: Number(p.total || 0) ? won(p.total) + '원' : '—',
            nameEditable: !!b && !added.has(p.id), nameVal, onNameVal: e => this.setState({ pmEditN: { ...(s.pmEditN || {}), [p.id]: e.target.value } }), saveName, resetName,
            nameChanged: ovN && !!b, baseNameText: b ? '기본 이름 ' + b.name : '',
            baseText: b && Number(b.total || 0) ? '기본 ' + won(b.total) + '원' : '', changed: !!ovT && editable, notChanged: !(ovT && editable),
            editable, notEditable: !editable, note, val, onVal: e => this.setState({ pmEdit: { ...(s.pmEdit || {}), [p.id]: e.target.value } }), save, reset,
            units: unitRows(p, b), hasUnits: unitRows(p, b).length > 0 };
        };
        const q = String(s.pmQ || '').trim().toLowerCase();
        const hit = p => [p.id, p.name, p.cat, p.g, p.r, p.o].concat((p.items || []).map(i => i.name + ' ' + i.id)).some(t => String(t || '').toLowerCase().includes(q));
        const found = q ? (cur.programs || []).filter(hit) : [];
        out.pmRows = found.slice(0, 40).map(row);
        out.pmHint = !q ? '프로그램 이름·ID 또는 시술 이름으로 검색하세요' : !found.length ? '검색 결과가 없습니다' : found.length > 40 ? '검색 결과 ' + found.length + '건 중 40건만 보입니다. 검색어를 더 입력하세요' : '';
        // 기존 변경 기록 (총 등록금액 외 변경은 확인만)
        const ovp = (ov && ov.programs) || {};
        out.pmChanged = [];
        Object.keys(ovp).forEach(id => { const p = (cur.programs || []).find(x => x.id === id), b = baseOf[id];
          const keys = Object.keys(ovp[id]), hasT = keys.includes('total'), hasN = keys.includes('name'), others = keys.filter(k => k !== 'total' && k !== 'name');
          const r = p ? row(p) : null, nm0 = (p || b || {}).name || id;
          if (hasN) out.pmChanged.push({ id, name: nm0, text: '프로그램 이름 ' + (b ? '‘' + b.name + '’ → ' : '') + '‘' + ovp[id].name + '’', canReset: !!(r && r.nameChanged), reset: r ? r.resetName : () => {}, resetLabel: '기본 이름으로' });
          if (hasT || others.length) out.pmChanged.push({ id, name: nm0,
            text: (hasT ? '총 등록금액 ' + (b && Number(b.total || 0) ? won(b.total) + '원 → ' : '') + won(ovp[id].total) + '원' : '') + (others.length ? (hasT ? ' · ' : '') + '기타 변경 ' + others.join(', ') : ''),
            canReset: !!(r && r.changed), reset: r ? r.reset : () => {}, resetLabel: '기본 가격으로' }); });
        const um = (uo && uo.items) || {};
        Object.keys(um).forEach(k => {
          const isProc = k.startsWith('proc:'), iid = isProc ? k.slice(5) : k.split('|')[1], pid = isProc ? '' : k.split('|')[0];
          const p = (cur.programs || []).find(x => isProc ? (x.items || []).some(i => i.id === iid) && !x.lesion : x.id === pid);
          const r = p ? unitRows(p, baseOf[p.id]).find(u => u.ukey === k) : null;
          const baseU = isProc ? (common[iid] || {}).price : (() => { const bi = baseOf[pid] && (baseOf[pid].items || []).find(x => x.id === iid); return bi ? Number(bi.settleUnit || 0) || Number(bi.unitPrice || 0) : 0; })();
          out.pmChanged.push({ id: isProc ? '공통 시술 · ' + ((common[iid] || {}).programs || 0) + '개 프로그램' : pid,
            name: isProc ? procName(iid) : ((p || baseOf[pid] || {}).name || pid),
            text: '1회 정상가' + (isProc ? '' : ' · ' + (r ? r.name : iid)) + ' ' + (baseU ? won(baseU) + '원 → ' : '') + won(um[k].price) + '원',
            canReset: !!(r && r.changed), reset: r ? r.reset : () => {}, resetLabel: '기본 가격으로' }); });
        out.pmHasChanged = out.pmChanged.length > 0;
        const oth = [ov && ov.added && ov.added.length ? '추가 ' + ov.added.length + '건' : '', ov && ov.deleted && ov.deleted.length ? '숨김 ' + ov.deleted.length + '건' : '',
          ov && ov.events && Object.keys(ov.events).length ? '이벤트 변경 ' + Object.keys(ov.events).length + '건' : ''].filter(Boolean);
        out.pmOther = oth.length ? '그 밖의 기존 변경 기록: ' + oth.join(' · ') + ' (그대로 유지)' : ''; out.pmHasOther = !!oth.length;
        const lastAt = [ov && ov.at, uo && uo.at, eo && eo.at].filter(Boolean).sort().pop();
        // ---- 이벤트 관리 ----
        // 정액 적용가 이벤트(패키지): 이벤트 프로그램의 총 등록금액 = 적용가. 할인율 이벤트: 할인 항목에서 직원이 선택하는 하나의 할인
        // 적용가·할인율을 바꿔도 환불용 1회 정상가는 바뀌지 않음 (별도 관리)
        const today = Component.today(), evE = s.evEdit || {};
        const baseEvs = {}; (CT.applyOverride(base, ov).events || []).forEach(e => { baseEvs[e.id] = e; });
        const addedEv = new Set(((eo && eo.added) || []).map(e => e.id));
        const progById = id => (cur.programs || []).find(p => p.id === id);
        out.evCards = (cur.events || []).map(e => {
          const ed = evE[e.id] || {}, v = k => Object.prototype.hasOwnProperty.call(ed, k) ? ed[k] : e[k];
          const kind = e.kind === 'rate' ? 'rate' : e.kind === 'service' ? 'service' : 'package';
          const set = (k, val) => this.setState({ evEdit: { ...evE, [e.id]: { ...ed, [k]: val } } });
          const active = v('active') !== false, progs = v('programs') || [];
          const pct = Object.prototype.hasOwnProperty.call(ed, 'ratePct') ? ed.ratePct : (e.rate ? String(Math.round(Number(e.rate) * 100)) : '');
          const on = CT.eventOn(e, today);
          const save = () => {
            const name = String(v('name') || '').replace(/\s+/g, ' ').trim(), start = v('start') || '', end = v('end') || '';
            if (!name) return msg('이벤트명을 입력해 주세요', true);
            if ([start, end].some(d => d && !/^\d{4}-\d{2}-\d{2}$/.test(d))) return msg('날짜 형식을 확인해 주세요', true);
            if (start && end && start > end) return msg('종료일이 시작일보다 빠릅니다', true);
            const patch = { name, active, start, end };
            if (kind === 'rate') {
              if (!/^\d{1,2}$/.test(String(pct)) || Number(pct) < 1 || Number(pct) > 90) return msg('할인율은 1~90 사이 정수(%)로 입력해 주세요', true);
              patch.rate = Number(pct) / 100; patch.programs = progs; }
            const dflt = { active: true, start: '', end: '' };
            const ch = {}; Object.keys(patch).forEach(k => { const was = e[k] === undefined ? dflt[k] : e[k]; if (JSON.stringify(patch[k]) !== JSON.stringify(was)) ch[k] = patch[k]; });
            if (!Object.keys(ch).length) return msg('바뀐 내용이 없습니다', true);
            if (!confirm('이벤트 「' + name + '」 설정을 저장합니다.\n새 계약부터 적용되고, 이미 저장된 계약·서명 문서는 바뀌지 않습니다.\n환불용 1회 정상가는 바뀌지 않습니다.')) return;
            write(CT.setEvent(eo, e.id, ch, stamp()), { evId: e.id, text: '이벤트 「' + name + '」 설정을 저장했습니다 (새 계약부터 적용)' }, CT.EVENT_KEY);
          };
          const isAdded = addedEv.has(e.id), changed = !!(eo && eo.events && eo.events[e.id]);
          const reset = () => { if (!confirm('이벤트 「' + e.name + '」 변경 내용을 지우고 기본 설정으로 되돌립니다.')) return;
            write(CT.clearEvent(eo, e.id, stamp()), { evId: e.id, text: '이벤트 「' + (baseEvs[e.id] || e).name + '」을(를) 기본 설정으로 되돌렸습니다' }, CT.EVENT_KEY); };
          const remove = () => { if (!confirm('할인율 이벤트 「' + e.name + '」을(를) 삭제합니다.\n이미 이 이벤트로 저장된 계약은 계약 당시 금액 그대로입니다.')) return;
            write(CT.removeRateEvent(eo, e.id, stamp()), { evId: e.id, text: '할인율 이벤트 「' + e.name + '」을(를) 삭제했습니다' }, CT.EVENT_KEY); };
          const matched = kind === 'service' && e.matchRe ? (cur.programs || []).filter(p => !p.event && new RegExp(e.matchRe).test(p.baseName || p.name)) : [];
          const addPid = String((s.evAdd || {})[e.id] || '').trim().toUpperCase();
          return { id: e.id, kindText: kind === 'rate' ? '할인율 이벤트 · 할인 항목에서 직원이 선택 (다른 할인과 중복 불가)'
              : kind === 'service' ? '서비스 제공 이벤트 · 해당 프로그램에 서비스권 추가' : '정액 적용가 이벤트 · 이벤트 프로그램의 총 등록금액이 적용가 (다른 할인과 중복 불가)',
            statusText: !active ? '사용 중지' : on ? '사용 중' : '적용 기간 아님', statusFg: !active ? '#717182' : on ? '#0a0a0a' : '#4b5563',
            nameVal: v('name') || '', onName: ev => set('name', ev.target.value),
            startVal: v('start') || '', endVal: v('end') || '', onStart: ev => set('start', ev.target.value), onEnd: ev => set('end', ev.target.value),
            activeOpts: [[true, '사용'], [false, '중지']].map(([k, l]) => ({ label: l, bd: active === k ? '#030213' : 'rgba(0,0,0,0.1)', bg: active === k ? '#030213' : '#ffffff', fg: active === k ? '#ffffff' : '#0a0a0a', pick: () => set('active', k) })),
            isPackage: kind === 'package', isRate: kind === 'rate', isService: kind === 'service',
            pctVal: pct, onPct: ev => set('ratePct', ev.target.value.replace(/[^0-9]/g, '')),
            progRows: kind === 'package' ? (cur.programs || []).filter(p => p.event === e.id).map(p => ({ ...row(p), listText: p.listTotal ? '정상가 ' + won(p.listTotal) + '원' : '' })) : [],
            rateProgs: progs.map(id => { const p = progById(id); return { id, name: p ? p.name : '(없는 프로그램)', price: p && Number(p.total || 0) ? won(p.total) + '원' : '',
              del: () => set('programs', progs.filter(x => x !== id)) }; }),
            addPidVal: (s.evAdd || {})[e.id] || '', onAddPid: ev => this.setState({ evAdd: { ...(s.evAdd || {}), [e.id]: ev.target.value } }),
            addProg: () => { const p = progById(addPid);
              if (!p) return msg('프로그램 ID를 확인해 주세요 (예: PGM-0001)', true);
              if (p.event) return msg('정액 적용가 이벤트 프로그램에는 할인율 이벤트를 걸 수 없습니다', true);
              if (window.DachaeumPricing.isYearSkinBooster(p)) return msg('리프팅 후 혜택가 프로그램에는 할인율 이벤트를 걸 수 없습니다 (혜택가와 이벤트는 중복 불가 · 정상가 프로그램에 추가해 주세요)', true);
              if (progs.includes(p.id)) return msg('이미 추가된 프로그램입니다', true);
              this.setState({ evEdit: { ...evE, [e.id]: { ...ed, programs: progs.concat(p.id) } }, evAdd: { ...(s.evAdd || {}), [e.id]: '' }, pmMsg: '' }); },
            svcText: kind === 'service' ? '적용 프로그램 ' + matched.length + '개 · 제공 서비스: ' + ((e.item || {}).name || '-') + (e.item && e.item.settleUnit ? ' (환불 정산단가 ' + won(e.item.settleUnit) + '원)' : '') : '',
            save, changed: changed && !isAdded, reset, isAdded, remove, dirty: Object.keys(ed).length > 0 };
        });
        const nw = s.evNew || {}, setNew = (k, val) => this.setState({ evNew: { ...nw, [k]: val } });
        Object.assign(out, { evNewName: nw.name || '', evNewPct: nw.pct || '', evNewStart: nw.start || '', evNewEnd: nw.end || '',
          onEvNewName: e => setNew('name', e.target.value), onEvNewPct: e => setNew('pct', e.target.value.replace(/[^0-9]/g, '')),
          onEvNewStart: e => setNew('start', e.target.value), onEvNewEnd: e => setNew('end', e.target.value),
          addRateEv: () => { const name = String(nw.name || '').replace(/\s+/g, ' ').trim(), pc = String(nw.pct || '');
            if (!name) return msg('새 이벤트명을 입력해 주세요', true);
            if (!/^\d{1,2}$/.test(pc) || Number(pc) < 1 || Number(pc) > 90) return msg('할인율은 1~90 사이 정수(%)로 입력해 주세요', true);
            if (nw.start && nw.end && nw.start > nw.end) return msg('종료일이 시작일보다 빠릅니다', true);
            const id = 'EV-R-' + Date.now().toString(36).toUpperCase();
            write(CT.addRateEvent(eo, { id, name, rate: Number(pc) / 100, start: nw.start || '', end: nw.end || '', active: true, programs: [] }, stamp()),
              { text: '할인율 이벤트 「' + name + '」을(를) 추가했습니다. 적용 프로그램을 추가하고 저장해 주세요', extra: { evNew: {} } }, CT.EVENT_KEY); } });
        out.evHasCards = out.evCards.length > 0;
        out.pmVer = lastAt ? '마지막 변경 ' + lastAt : '변경 기록 없음 · 기본 가격 사용 중';
        return out;
      })()
    };
  }
}
