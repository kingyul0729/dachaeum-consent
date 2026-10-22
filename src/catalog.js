// 다채움피부과 서비스 기준 (동의서 v3 · 가격 관리 v3 공용). 가격 데이터 자체는 programs.json 한 곳에만 있습니다.
(function (g) {
  const EXCLUDED_SVC = /약\s?처방|염증주사/;
  // 리프팅 교체용 추가 후보: 해당 프로그램의 첫 구성 1회
  const SWAP_EXTRAS = [['PGM-0085A', '인모드 FX'], ['PGM-T1-16', '스타룩스 1540'], ['PGM-0119', '주름 보톡스 1부위 (뉴럭스)']];
  const isEditableSvc = i => i.kind === '서비스권' && !EXCLUDED_SVC.test(i.name);
  // 포함 서비스 교체·추가 후보: 리프팅 프로그램 포함 서비스(정산단가 있는 것) + 이벤트 서비스 + 교체용 추가 후보
  function svcPool(db) {
    const m = {}, progs = (db && db.programs) || [];
    progs.filter(p => p.cat === '리프팅').forEach(p => (p.items || []).forEach(i => {
      if (isEditableSvc(i) && (i.settleUnit || i.unitPrice) && !m[i.name]) m[i.name] = i; }));
    ((db && db.events) || []).forEach(e => { if (e.item && !m[e.item.name]) m[e.item.name] = e.item; });
    SWAP_EXTRAS.forEach(([pid, nm]) => {
      const p = progs.find(x => x.id === pid), it = p && (p.items || [])[0];
      if (it && !m[nm]) m[nm] = { ...it, id: 'SWAP_' + it.id, name: nm, kind: '서비스권', qty: '1', settleType: 'S/V' }; });
    return Object.values(m);
  }
  // 가격 관리 override: 직원이 바꾼 항목만 저장 → 실행 시 최신 programs.json과 합침
  const OV_KEY = 'dachaeum.priceOverride';
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function diffOverride(base, db) {
    const ov = { programs: {}, added: [], deleted: [], events: {} };
    const bp = {}; (base.programs || []).forEach(p => { bp[p.id] = p; });
    (db.programs || []).forEach(p => { const o = bp[p.id];
      if (!o) { ov.added.push(p); return; }
      const ch = {}; Object.keys(p).forEach(k => { if (!same(p[k], o[k])) ch[k] = p[k]; });
      if (Object.keys(ch).length) ov.programs[p.id] = ch; });
    const ids = new Set((db.programs || []).map(p => p.id));
    ov.deleted = (base.programs || []).filter(p => !ids.has(p.id)).map(p => p.id);
    const be = {}; (base.events || []).forEach(e => { be[e.id] = e; });
    (db.events || []).forEach(e => { const o = be[e.id]; if (!o) return;
      const ch = {}; Object.keys(e).forEach(k => { if (!same(e[k], o[k])) ch[k] = e[k]; });
      if (Object.keys(ch).length) ov.events[e.id] = ch; });
    const n = Object.keys(ov.programs).length + ov.added.length + ov.deleted.length + Object.keys(ov.events).length;
    return n ? ov : null;
  }
  function applyOverride(base, ov) {
    const d = JSON.parse(JSON.stringify(base));
    // baseName: 가격 데이터(programs.json)의 원래 이름. 표시 이름을 바꿔도 이름 규칙(제모 결합·리프팅 혜택가 정상가 연결 등)은 이 값으로 판단
    d.programs = (d.programs || []).map(p => ({ ...p, baseName: p.baseName || p.name }));
    if (!ov) return d;
    const del = new Set(ov.deleted || []);
    d.programs = d.programs.filter(p => !del.has(p.id)).map(p => ov.programs && ov.programs[p.id] ? { ...p, ...ov.programs[p.id], baseName: p.baseName } : p);
    (ov.added || []).forEach(p => { if (!d.programs.some(x => x.id === p.id)) d.programs.push({ ...p, baseName: p.baseName || p.name }); });
    d.events = (d.events || []).map(e => ov.events && ov.events[e.id] ? { ...e, ...ov.events[e.id] } : e);
    if (ov.at) d.version = (base.version || '') + ' · 변경 ' + ov.at;
    return d;
  }
  const readOverride = () => { try { return JSON.parse(localStorage.getItem(OV_KEY) || 'null'); } catch (e) { return null; } };
  // 시술별 환불용 1회 정상가 변경: 총 등록금액 기록(dachaeum.priceOverride)과 별도 키에 저장 → 서로 덮어쓰지 않음
  // 형식 { items: { 'proc:시술ID': { price } (공통 시술) | '프로그램ID|시술ID': { price } (프로그램별) }, at }
  // 새 계약 작성 시에만 반영, 저장된 계약은 계약 당시 단가 유지
  const UNIT_KEY = 'dachaeum.unitOverride';
  const unitKey = (pid, iid) => pid + '|' + iid;
  const procKey = iid => 'proc:' + iid;
  const readUnits = () => { try { return JSON.parse(localStorage.getItem(UNIT_KEY) || 'null'); } catch (e) { return null; } };
  const itemUnit = i => Number(i.settleUnit || 0) || Number(i.unitPrice || 0);
  const isSvcItem = i => i.kind === '서비스권' || i.kind === '서비스';
  // 공통 관리 시술: 시술 DB(procs)에 같은 시술 ID가 있고 1회 정상가가 있으며, 이 ID를 쓰는 모든 프로그램 항목의
  // 1회 정상가가 시술 DB 값과 같은 경우만 (이름이 아니라 시술 ID + 가격 기준 일치로 판단). 그 외는 프로그램별 관리
  function commonUnits(db) {
    const procs = {}; ((db && db.procs) || []).forEach(x => { if (Number(x.unitPrice || 0) > 0 && !Number(x.perPiece || 0)) procs[x.id] = Number(x.unitPrice); });
    const use = {}, bad = new Set();
    ((db && db.programs) || []).forEach(p => { if (p.lesion) return; (p.items || []).forEach(i => {
      if (isSvcItem(i) || !(i.id in procs)) return;
      if (i.unitFromTotal || Number(i.perPiece || 0) || itemUnit(i) !== procs[i.id]) bad.add(i.id);
      (use[i.id] = use[i.id] || new Set()).add(p.id); }); });
    const out = {}; Object.keys(use).forEach(id => { if (!bad.has(id)) out[id] = { price: procs[id], programs: use[id].size }; });
    return out;
  }
  function applyUnits(d0, uo) {
    const map = (uo && uo.items) || {};
    if (!Object.keys(map).length) return d0;
    const d = JSON.parse(JSON.stringify(d0)), common = commonUnits(d0);
    const set = (i, price) => { const v = String(Number(price)); return { ...i, unitPrice: v, settleUnit: v, listPrice: v }; };
    d.programs = (d.programs || []).map(p => p.lesion ? p : { ...p, items: (p.items || []).map(i => {
      const own = map[unitKey(p.id, i.id)], gl = common[i.id] && map[procKey(i.id)];
      if (own && Number(own.price) > 0 && !common[i.id]) return set(i, own.price);
      if (gl && Number(gl.price) > 0 && !isSvcItem(i) && itemUnit(i) === common[i.id].price) return set(i, gl.price);
      return i; }) });
    if (uo.at) d.version = (d.version || '') + ' · 정상가 변경 ' + uo.at;
    return d;
  }
  const copyUo = uo => JSON.parse(JSON.stringify(uo || { items: {} }));
  const setKey = (uo, k, price, at) => { const o = copyUo(uo); o.items = o.items || {}; o.items[k] = { price: String(price) }; if (at) o.at = at; return o; };
  const clearKey = (uo, k, at) => { const o = copyUo(uo); if (!o.items || !o.items[k]) return o; delete o.items[k]; if (at) o.at = at; return o; };
  const setUnit = (uo, pid, iid, price, at) => setKey(uo, unitKey(pid, iid), price, at);
  const clearUnit = (uo, pid, iid, at) => clearKey(uo, unitKey(pid, iid), at);
  const setProcUnit = (uo, iid, price, at) => setKey(uo, procKey(iid), price, at);
  const clearProcUnit = (uo, iid, at) => clearKey(uo, procKey(iid), at);
  // 이벤트 관리: 별도 키(dachaeum.eventOverride)에 저장. 형식 { events: { 이벤트ID: 변경 항목 }, added: [할인율 이벤트], at }
  // 기존 이벤트(가격 데이터 + 기존 priceOverride.events)는 읽어서 쓰고, 여기에는 바꾼 항목만 덧붙임 → 기존 설정을 초기화하지 않음
  // 정액 적용가 이벤트(패키지)의 금액은 해당 이벤트 프로그램의 총 등록금액(priceOverride)으로 관리 — 환불용 1회 정상가와 별개
  const EVENT_KEY = 'dachaeum.eventOverride';
  const EV_FIELDS = ['name', 'active', 'start', 'end', 'rate', 'programs'];
  const readEvents = () => { try { return JSON.parse(localStorage.getItem(EVENT_KEY) || 'null'); } catch (e) { return null; } };
  const pickEv = o => { const r = {}; EV_FIELDS.forEach(k => { if (o && Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; }); return r; };
  function applyEventOv(d0, eo) {
    if (!eo || (!Object.keys(eo.events || {}).length && !(eo.added || []).length)) return d0;
    const d = JSON.parse(JSON.stringify(d0)), ch = eo.events || {};
    d.events = (d.events || []).map(e => ch[e.id] ? { ...e, ...pickEv(ch[e.id]) } : e)
      .concat((eo.added || []).filter(e => !(d.events || []).some(x => x.id === e.id)).map(e => ({ ...e, kind: 'rate', ...pickEv(ch[e.id] || {}) })));
    if (eo.at) d.version = (d.version || '') + ' · 이벤트 변경 ' + eo.at;
    return d;
  }
  const copyEo = eo => JSON.parse(JSON.stringify(eo || { events: {}, added: [] }));
  function setEvent(eo, id, patch, at) { const o = copyEo(eo); o.events = o.events || {}; o.events[id] = { ...(o.events[id] || {}), ...pickEv(patch) }; if (at) o.at = at; return o; }
  function clearEvent(eo, id, at) { const o = copyEo(eo); if (!o.events || !o.events[id]) return o; delete o.events[id]; if (at) o.at = at; return o; }
  function addRateEvent(eo, ev, at) { const o = copyEo(eo); o.added = (o.added || []).concat([{ id: ev.id, kind: 'rate', ...pickEv(ev) }]); if (at) o.at = at; return o; }
  function removeRateEvent(eo, id, at) { const o = copyEo(eo); o.added = (o.added || []).filter(e => e.id !== id); if (o.events) delete o.events[id]; if (at) o.at = at; return o; }
  // 이벤트 사용 가능: 사용 여부 + 적용 기간(시작일·종료일, 비어 있으면 제한 없음)
  const eventOn = (e, today) => !!e && e.active !== false && (!e.start || today >= e.start) && (!e.end || today <= e.end);
  // 할인율 이벤트: 직원이 할인 항목에서 직접 선택할 때만 적용 (자동 적용 없음)
  const rateEventsFor = (db, pid, today) => ((db && db.events) || []).filter(e => e.kind === 'rate' && eventOn(e, today)
    && Number(e.rate) > 0 && Number(e.rate) < 1 && (e.programs || []).includes(pid));
  const withOverride = base => applyEventOv(applyUnits(applyOverride(base, readOverride()), readUnits()), readEvents());
  // 가격 관리 화면: 프로그램 표시 이름(name)·총 등록금액(total)을 각각 기록·제거 (프로그램 ID는 그대로)
  function setProgramField(ov, id, field, value, at) {
    const o = copyOvF(ov); o.programs = o.programs || {};
    o.programs[id] = { ...(o.programs[id] || {}), [field]: String(value) }; if (at) o.at = at; return o;
  }
  function clearProgramField(ov, id, field, at) {
    const o = copyOvF(ov), p = (o.programs || {})[id];
    if (!p || !Object.prototype.hasOwnProperty.call(p, field)) return o;
    delete p[field]; if (!Object.keys(p).length) delete o.programs[id]; if (at) o.at = at; return o;
  }
  const copyOvF = ov => JSON.parse(JSON.stringify(ov || { programs: {}, added: [], deleted: [], events: {} }));
  // 가격 관리 화면: 프로그램 총 등록금액(total)만 기록·제거. 같은 기록 안의 다른 변경(다른 필드·추가·삭제·이벤트)은 그대로 둠
  const copyOv = ov => JSON.parse(JSON.stringify(ov || { programs: {}, added: [], deleted: [], events: {} }));
  function setProgramTotal(ov, id, total, at) {
    const o = copyOv(ov); o.programs = o.programs || {};
    o.programs[id] = { ...(o.programs[id] || {}), total: String(total) }; if (at) o.at = at; return o;
  }
  function clearProgramTotal(ov, id, at) {
    const o = copyOv(ov), p = (o.programs || {})[id];
    if (!p || !Object.prototype.hasOwnProperty.call(p, 'total')) return o;
    delete p.total; if (!Object.keys(p).length) delete o.programs[id]; if (at) o.at = at; return o;
  }
  g.DachaeumCatalog = { EXCLUDED_SVC, SWAP_EXTRAS, isEditableSvc, svcPool, OV_KEY, diffOverride, applyOverride, readOverride, withOverride,
    setProgramTotal, clearProgramTotal, UNIT_KEY, unitKey, procKey, readUnits, commonUnits, applyUnits, setUnit, clearUnit, setProcUnit, clearProcUnit,
    setProgramField, clearProgramField, EVENT_KEY, readEvents, applyEventOv, setEvent, clearEvent, addRateEvent, removeRateEvent, eventOn, rateEventsFor };
})(typeof window !== 'undefined' ? window : globalThis);
