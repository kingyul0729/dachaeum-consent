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
    if (!ov) return d;
    const del = new Set(ov.deleted || []);
    d.programs = (d.programs || []).filter(p => !del.has(p.id)).map(p => ov.programs && ov.programs[p.id] ? { ...p, ...ov.programs[p.id] } : p);
    (ov.added || []).forEach(p => { if (!d.programs.some(x => x.id === p.id)) d.programs.push(p); });
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
  const withOverride = base => applyUnits(applyOverride(base, readOverride()), readUnits());
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
    setProgramTotal, clearProgramTotal, UNIT_KEY, unitKey, procKey, readUnits, commonUnits, applyUnits, setUnit, clearUnit, setProcUnit, clearProcUnit };
})(typeof window !== 'undefined' ? window : globalThis);
