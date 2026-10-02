// 화면 흐름 테스트 (빌드된 index.html을 Chromium으로 실행)
// 계약 생성 → 이용·환불 정산 → 환불 정산서 서명(=환불완료), 잔금 결제, 재서명, 계약 간 기록 분리
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const URL = 'file://' + path.resolve(__dirname, '..', process.env.APP_FILE || 'index.html');
let browser;
test.before(async () => { browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}); });
test.after(async () => { await browser.close(); });

async function open(seed, opt = {}) {
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.errors = []; p.dialogs = []; p.on('pageerror', e => p.errors.push(e.message));
  p.on('dialog', d => { p.dialogs.push(d.message()); if (opt.handle) return opt.handle(d); d.accept(opt.answer ? opt.answer(d) : undefined); });
  await p.goto(URL);
  await p.evaluate(([c, extra]) => { localStorage.clear(); if (c) localStorage.setItem('dachaeum.v3.contracts', JSON.stringify(c));
    Object.entries(extra || {}).forEach(([k, v]) => localStorage.setItem(k, v)); }, [seed || null, opt.storage || null]);
  await p.reload(); await p.waitForTimeout(2000);
  return p;
}
const click = async (p, t, i = 0) => { await p.getByText(t, { exact: true }).nth(i).click(); await p.waitForTimeout(350); };
const body = p => p.innerText('body');
const finalRefund = async p => (await body(p)).match(/최종 환불금액\s*([\d,]+)/)[1];
const contracts = p => p.evaluate(() => JSON.parse(localStorage.getItem('dachaeum.v3.contracts') || '[]'));
const docs = p => p.evaluate(() => JSON.parse(localStorage.getItem('dachaeum.v3.docs') || '[]'));
async function sign(p) {
  await click(p, '터치하여 서명');
  const bb = await p.locator('canvas').first().boundingBox();
  await p.mouse.move(bb.x + 30, bb.y + 40); await p.mouse.down();
  await p.mouse.move(bb.x + 150, bb.y + 20, { steps: 6 }); await p.mouse.move(bb.x + 250, bb.y + 60, { steps: 6 }); await p.mouse.up();
  await click(p, '서명 완료');
}
const allocInputs = p => p.locator('xpath=//*[contains(text(),"원결제")]/ancestor::div[2]//input');

const mk = (id, program, o = {}) => ({ id, docMode: 'full', termsVer: 'T-2026-09',
  patient: { name: '김테스트', birth: '900101', phone: '010-0000-0000' }, program, cat: '스킨부스터', date: '2026-09-01', expiry: '2027-08-31',
  total: 1000000, paid: 1000000, pay: 'full', method: '카드 + 현금', priorDep: 300000, preBal: 0,
  payments: [{ method: '카드', amount: 400000 }, { method: '현금', amount: 300000 }],
  items: [{ kind: '시술', name: '리쥬란 A', qty: 4, price: 200000 }, { kind: '서비스', name: '진정관리', qty: 2, price: 50000 }], used: null, visits: [], ...o });

test('새 계약: 계약 당시 값·상태·서비스 단가 저장, 동의서 A4 1장, 계약 id로 문서 연결', async () => {
  const p = await open();
  await click(p, '새 동의서 작성');
  const ins = p.locator('input');
  await ins.nth(0).fill('신규환자'); await ins.nth(1).fill('880101'); await ins.nth(2).fill('01011112222');
  await click(p, '다음 단계'); await click(p, '스킨부스터'); await click(p, '정상가'); await click(p, '3회');
  await click(p, '다음 단계'); await click(p, '카드');
  assert.match(await body(p), /330,000원을 결제할게요/);
  await click(p, '동의서 미리보기 · 서명'); await p.waitForTimeout(400);
  await p.getByText(/위 환불 규정/).last().click(); await sign(p);
  await p.getByText('동의하고 저장', { exact: true }).last().click(); await p.waitForTimeout(800);
  const [c] = await contracts(p);
  assert.equal(c.status, '등록완료'); assert.equal(c.total, 330000); assert.equal(c.paid, 330000);
  assert.deepEqual(c.items.map(i => [i.name, i.qty, i.price]), [['인모드 FX', 3, 165000]]);
  assert.ok(c.svcPrices && c.svcPrices.acne.some(r => r.range === '14일 미만' && r.price === 15000));
  const d = await docs(p);
  assert.equal(d.length, 1); assert.equal(d[0].contractId, c.id); assert.match(d[0].html, /data-onepage="1"/);
  assert.match(d[0].html.replace(/<[^>]+>/g, ''), /실제 납부금액 − 위약금 10%/);
  // 재서명: 화면 구성이 계약과 같으면 허용 → 이전 버전 보존 + 새 버전
  await p.getByText(/재서명/).first().click(); await p.waitForTimeout(400);
  await p.getByText(/위 환불 규정/).last().click(); await sign(p);
  await click(p, '동의하고 저장'); await p.waitForTimeout(600);
  assert.deepEqual((await docs(p)).map(x => [x.version, !!x.superseded]), [[1, true], [2, false]]);
  // 새로고침 후에는 화면 구성이 없으므로 재서명 차단
  await p.goto(URL); await p.waitForTimeout(2000);
  await click(p, '신규환자'); await click(p, '문서');
  await p.getByText(/재서명/).first().click(); await p.waitForTimeout(300);
  assert.match(await body(p), /재서명할 수 없습니다/);
  assert.deepEqual(p.errors, []);
});

test('환불: 계약 간 기록 분리 → 작성 중 저장·복원 → 서명 시 환불완료, 계산 내역 보관', async () => {
  const p = await open([mk('CT1', '프로그램 A'), mk('CT2', '프로그램 B')]);
  await click(p, '프로그램 A'); await click(p, '환불 정산');
  await p.getByText('+', { exact: true }).nth(0).click(); await p.waitForTimeout(200);
  assert.equal(await finalRefund(p), '700,000');
  await allocInputs(p).nth(0).fill('400000'); await p.waitForTimeout(500);
  await p.mouse.click(38, 32); await p.waitForTimeout(300);          // 뒤로가기(취소 버튼 없이 나감)
  await click(p, '프로그램 B'); await click(p, '환불 정산');
  assert.equal(await finalRefund(p), '900,000', 'B에 A의 이용 기록이 섞이면 안 됨');
  await p.goto(URL); await p.waitForTimeout(2000);
  await click(p, '프로그램 A'); await click(p, '환불 정산');
  assert.equal(await finalRefund(p), '700,000', '작성 중 정산 복원');
  assert.equal(await allocInputs(p).nth(0).inputValue(), '400,000');
  await click(p, '정산서 생성 · 환자 서명');
  assert.match(await body(p), /일치해야|더 배분/, '합계 불일치면 서명 화면으로 못 넘어감');
  await allocInputs(p).nth(1).fill('300000'); await p.waitForTimeout(300);
  await click(p, '정산서 생성 · 환자 서명'); await sign(p);
  await p.getByText('서명 완료 · 저장', { exact: true }).last().dblclick(); await p.waitForTimeout(800);
  const [a, b] = await contracts(p);
  assert.equal(a.status, '환불완료'); assert.equal(a.refunded, true);
  assert.equal(a.refund.penNum, 100000); assert.equal(a.refund.usedAmt, 200000); assert.equal(a.refund.refundNum, 700000);
  assert.deepEqual(a.refund.pays.map(x => [x.method, x.refund]), [['카드', 400000], ['현금', 300000], ['기납부 예약금', 0]]);
  assert.equal(a.total, 1000000); assert.equal(a.items.length, 2, '원 계약 정보 보존');
  assert.equal(b.status || '등록완료', '등록완료');
  assert.equal((await docs(p)).filter(d => d.kind === '환불정산서').length, 1, '더블클릭해도 1건');
  assert.ok(!/환불 정산\n|환불 처리 완료/.test(await body(p)), '환불완료 후 정산 버튼 없음');
  assert.deepEqual(p.errors, []);
});

test('이전 버전 상태값 정리: 중간 상태는 등록완료, 서명 기록이 있으면 환불완료', async () => {
  const p = await open([mk('CT1', '프로그램 A', { status: '환불정산중' }), mk('CT2', '프로그램 B', { status: '환불처리대기', refund: { refundNum: 1 } })]);
  assert.equal(((await body(p)).match(/환불완료/g) || []).length, 1);
  await click(p, '프로그램 A');
  assert.match(await body(p), /환불 정산/);
});

test('잔금 결제: 실제 납부액·결제내역 누적, 초과 차단, 완납 전환, 환불은 전체 납부내역 기준', async () => {
  const dep = { total: 1000000, paid: 100000, pay: 'deposit', method: '카드', priorDep: 0, items: [{ kind: '시술', name: '리쥬란 A', qty: 5, price: 200000 }],
    payments: [{ method: '카드', amount: 100000, bank: '신한', cardNo: '1234', payDate: '2026-09-01', approval: '12345678' }] };
  const p = await open([mk('CT1', '프로그램 A', dep), mk('CT2', '프로그램 B', { ...dep, payments: undefined })]);
  await click(p, '프로그램 A'); await p.getByText('프로그램 A').last().click(); await p.waitForTimeout(300);
  const card = p.locator('xpath=//div[text()="잔금 결제"]/ancestor::div[2]');
  assert.match(await body(p), /남은 잔금 900,000원/);
  await card.getByText('현금', { exact: true }).click();
  const amt = card.locator('input[type=text]');
  await amt.fill('950000'); await click(p, '잔금 결제 기록');
  assert.match(await body(p), /보다 많이 기록할 수 없습니다/);
  await amt.fill('500000'); await click(p, '잔금 결제 기록'); await p.waitForTimeout(1700);
  assert.match(await body(p), /일부 납부 \(잔금 400,000원 미납\)/);
  await card.getByText('카드', { exact: true }).click(); await click(p, '잔금 결제 기록'); await p.waitForTimeout(400);
  let [c] = await contracts(p);
  assert.equal(c.paid, 1000000); assert.equal(c.total, 1000000); assert.equal(c.pay, 'full');
  assert.deepEqual(c.payments.map(x => [x.method, x.amount, !!x.balance]), [['카드', 100000, false], ['현금', 500000, true], ['카드', 400000, true]]);
  await p.goto(URL); await p.waitForTimeout(2000);
  await click(p, '프로그램 A'); await click(p, '환불 정산');
  assert.equal(await finalRefund(p), '900,000');
  assert.deepEqual((await body(p)).match(/원결제 [\d,]+원/g), ['원결제 100,000원', '원결제 500,000원', '원결제 400,000원']);
  assert.deepEqual(p.errors, []);
});

test('새 동의서 작성: 이전 환자의 기납부 예약금·결제수단이 다음 환자에게 남지 않음', async () => {
  const p = await open();
  const start = async name => {
    await click(p, '새 동의서 작성'); const ins = p.locator('input');
    await ins.nth(0).fill(name); await ins.nth(1).fill('880101'); await ins.nth(2).fill('01011112222');
    await click(p, '다음 단계'); await click(p, '스킨부스터'); await click(p, '정상가'); await click(p, '3회'); await click(p, '다음 단계');
  };
  await start('환자A');
  const dep = p.locator('xpath=//span[text()="기납부 예약금"]/following-sibling::span//input');
  await dep.fill('100000'); await click(p, '현금');
  assert.match(await body(p), /230,000원을 결제할게요/);
  await p.mouse.click(38, 32); await p.waitForTimeout(300);
  await start('환자B');
  assert.match(await body(p), /330,000원을 결제할게요/);
  assert.equal(await dep.inputValue(), '');
  assert.deepEqual(p.errors, []);
});

test('결제 정보 수정 중에는 잔금 결제 기록 차단 (수정본 저장 시 잔금 기록 유실 방지)', async () => {
  const p = await open([mk('CT1', '프로그램 A', { total: 1000000, paid: 100000, pay: 'deposit', priorDep: 0, payments: [{ method: '카드', amount: 100000, payDate: '2026-09-01' }] })]);
  await click(p, '프로그램 A'); await p.getByText('프로그램 A').last().click(); await p.waitForTimeout(300);
  await p.locator('select').first().selectOption('신한');
  const card = p.locator('xpath=//div[text()="잔금 결제"]/ancestor::div[2]');
  await card.getByText('현금', { exact: true }).click(); await click(p, '잔금 결제 기록');
  assert.match(await body(p), /결제 정보 수정 중입니다/);
  assert.equal((await contracts(p))[0].paid, 100000);
});

test('환불 정산 입력 직후 바로 새로고침해도 작성 중 값 유지', async () => {
  const p = await open([mk('CT1', '프로그램 A')]);
  await click(p, '프로그램 A'); await click(p, '환불 정산');
  await p.getByText('+', { exact: true }).nth(0).click();
  await p.reload(); await p.waitForTimeout(2000);
  assert.deepEqual((await contracts(p))[0].refundDraft.used, [1, 0]);
});

const pickProgram = async (p, id, label) => {
  await click(p, '새 동의서 작성'); const ins = p.locator('input');
  await ins.nth(0).fill('정상가테스트'); await ins.nth(1).fill('880101'); await ins.nth(2).fill('01011112222');
  await click(p, '다음 단계'); await click(p, '전체');
  await p.locator('input[placeholder*="검색"]').fill(id); await p.waitForTimeout(300);
  await click(p, label); await click(p, '다음 단계'); await click(p, '카드');
};
const signAndSave = async p => {
  await click(p, '동의서 미리보기 · 서명'); await p.getByText(/위 환불 규정/).last().click(); await sign(p);
  await click(p, '동의하고 저장'); await p.waitForTimeout(700);
};

test('PGM-0037 남성 턱밑라인: 환불용 1회 정상가 입력 전 서명 불가 → 입력값 계약 저장 → 환불 차감', async () => {
  const p = await open();
  await pickProgram(p, 'PGM-0037', '남성 턱밑라인 포함');
  assert.match(await body(p), /환불용 1회 정상가 확인 필요/);
  await click(p, '동의서 미리보기 · 서명');
  assert.match(await body(p), /환불용 1회 정상가를 입력해 주세요/);
  assert.doesNotMatch(await body(p), /터치하여 서명/);
  await p.locator('input[placeholder="1회 정상가"]').fill('132000');          // 테스트용 임의 값
  await signAndSave(p);
  const [c] = await contracts(p);
  assert.equal(c.total, 660000);
  assert.deepEqual(c.items.map(i => [i.name, i.qty, i.price, !!i.unitInput]), [['남성 턱밑라인 포함 제모', 5, 132000, true]]);
  await p.goto(URL); await p.waitForTimeout(1500);
  await click(p, '남성 턱밑라인 포함 제모 5회'); await click(p, '환불 정산');
  await p.getByText('+', { exact: true }).nth(0).click(); await p.getByText('+', { exact: true }).nth(0).click(); await p.waitForTimeout(200);
  assert.equal(await finalRefund(p), '330,000');                               // 660,000 − 66,000 − 2 × 132,000
  assert.deepEqual(p.errors, []);
});

test('얼굴 전체 CO₂ 제거 추가옵션: 가격 데이터의 1회·110,000원으로 계약 저장, 점 CO₂(병변별)와 별도 차감', async () => {
  const p = await open();
  await pickProgram(p, 'PGM-0004', '스페셜 토닝 3');
  assert.doesNotMatch(await body(p), /환불용 1회 정상가 확인 필요/, '가격 데이터에 정상가가 있으므로 입력 요구 없음');
  await signAndSave(p);
  const [c] = await contracts(p);
  const k = c.items.findIndex(i => i.name === '얼굴 전체 CO₂ 제거');
  assert.deepEqual([c.items[k].kind, c.items[k].qty, c.items[k].price, !!c.items[k].unitInput, !!c.items[k].actual], ['추가', 1, 110000, false, false]);
  assert.ok(c.items.some(i => i.name === '얼굴 점 CO₂ 제거' && i.actual), '점 CO₂는 병변별 입력 항목으로 유지');
  assert.match((await docs(p))[0].html.replace(/<[^>]+>/g, ' '), /얼굴 전체 CO₂ 제거\s+1회/);
  await p.goto(URL); await p.waitForTimeout(1500);
  await click(p, '스페셜 토닝 3'); await click(p, '환불 정산');
  assert.equal(await finalRefund(p), '1,485,000');
  await p.getByText('+', { exact: true }).nth(k).click(); await p.waitForTimeout(200);
  assert.equal(await finalRefund(p), '1,375,000');                             // − 110,000
});

test('기존 계약 정상가 누락: 이용 기록이 있을 때만 확정 차단, 근거 보완 시 별도 기록·원 항목 유지', async () => {
  const seed = [mk('CT1', '턱밑 계약', { total: 660000, paid: 660000, priorDep: 0, payments: [{ method: '카드', amount: 660000 }],
    items: [{ kind: '시술', name: '남성 턱밑라인 포함 제모', qty: 5, price: 0 }] })];
  const p = await open(seed, { answer: d => d.type() !== 'prompt' ? undefined : /근거/.test(d.message()) && !/정상가\(원\)/.test(d.message()) ? '2026-03-02 서명 동의서' : '132000' });
  await click(p, '턱밑 계약'); await click(p, '환불 정산');
  assert.doesNotMatch(await body(p), /정상가 확인 필요 · 환불 확정 불가/, '이용 전에는 차단 안 함');
  await p.getByText('+', { exact: true }).nth(0).click(); await p.waitForTimeout(200);
  assert.match(await body(p), /정상가 확인 필요 · 환불 확정 불가/);
  assert.doesNotMatch(await body(p), /594,000/, '0원 차감 금액을 최종 환불금액으로 보여주지 않음');
  assert.match(await body(p), /정상가 확인 후 계산할 수 있어요/);
  await click(p, '정산서 생성 · 환자 서명');
  assert.doesNotMatch(await body(p), /터치하여 서명/, '확정(서명) 단계로 넘어가지 않음');
  await click(p, '근거 확인 후 보완'); await p.waitForTimeout(400);
  const [c] = await contracts(p);
  assert.equal(c.items[0].price, 0, '원 계약 항목은 바뀌지 않음');
  assert.deepEqual(c.priceFixes.map(f => [f.key, f.price, f.basis]), [['item:0', 132000, '2026-03-02 서명 동의서']]);
  assert.ok(c.priceFixes[0].at);
  assert.equal(await finalRefund(p), '462,000');                               // 660,000 − 66,000 − 132,000
  assert.match(await body(p), /정상가 보완 기록/);
});

test('이전 계약(계약 당시 서비스 단가 없음): 현재 가격표 자동 적용 안 함, 기록하면 확정 차단', async () => {
  const p = await open([mk('CT1', '이전 계약')]);                             // svcPrices 없음
  await click(p, '이전 계약'); await click(p, '환불 정산');
  assert.match(await body(p), /단가 확인 필요/);
  assert.doesNotMatch(await body(p), /14일 미만\s*15,000/);
  assert.doesNotMatch(await body(p), /정상가 확인 필요 · 환불 확정 불가/, '기록 전에는 차단 없음');
  await p.locator('[title="기록 추가"]').nth(1).click(); await p.waitForTimeout(300);   // 약처방 기록 1건
  assert.match(await body(p), /정상가 확인 필요 · 환불 확정 불가/);
  assert.match(await body(p), /정상가 확인 후 계산할 수 있어요/);
  await click(p, '정산서 생성 · 환자 서명');
  assert.doesNotMatch(await body(p), /터치하여 서명/);
});

test('서명 기록 삭제 차단: 문서 삭제 버튼·환자 삭제 버튼 없음', async () => {
  const p = await open();
  await pickProgram(p, 'PGM-0037', '남성 턱밑라인 포함');
  await p.locator('input[placeholder="1회 정상가"]').fill('132000');
  await signAndSave(p);
  assert.equal(await p.locator('[title="문서 삭제"]').count(), 0);
  await click(p, '계약 정보');
  assert.equal(await p.getByText('삭제', { exact: true }).count(), 0);
  assert.equal((await docs(p)).length, 1);
});

test('예약금 결제 표시: (10%) 문구 없음, 계산은 그대로', async () => {
  const p = await open();
  await pickProgram(p, 'PGM-0037', '남성 턱밑라인 포함');
  await click(p, '예약금 결제');
  const t = await body(p);
  assert.doesNotMatch(t, /예약금 결제 \(10%\)|예약금 \(10%\)/);
  assert.match(t, /66,000원을 결제할게요/);
});

test('백업·복원: 암호화 파일 → 다른 기기(새 환경)에서 복원 후 계약·문서·금액·상태 동일, 다른 앱 자료 유지', async () => {
  const fs = require('node:fs');
  const seed = [mk('CT1', '프로그램 A', { status: '환불완료', refunded: true, refund: { refundNum: 700000, penNum: 100000, usedAmt: 200000, pays: [{ method: '카드', refund: 400000 }] } }),
    mk('CT2', '프로그램 B', { refundDraft: { used: [1, 0], alloc: { 0: '400,000' } }, priceFixes: [{ key: 'item:0', price: 1000, basis: 't' }] })];
  const src = await open(seed, { storage: { 'dachaeum.v3.docs': JSON.stringify([{ id: 'D1', contractId: 'CT1', kind: '이용동의서', version: 1, signedAt: '2026-09-01', html: '<div>서명 문서</div>' }]),
    'dachaeum.priceOverride': JSON.stringify({ programs: { 'PGM-0001': { total: '1' } } }), 'inventory-system:v1': 'SRC-INVENTORY' } });
  const original = await src.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('dachaeum.') && k !== 'dachaeum.v3.lastBackup').map(k => [k, localStorage.getItem(k)])));
  await click(src, '백업 · 복원');
  await src.locator('input[placeholder="비밀번호 (6자 이상)"]').fill('test-pass-1');
  await src.locator('input[placeholder="비밀번호 확인"]').fill('test-pass-1');
  await click(src, '백업 파일 만들기'); await src.waitForTimeout(2000);
  const [dl] = await Promise.all([src.waitForEvent('download'), src.getByText(/^파일 저장 · dachaeum-backup-/).click()]);
  const afterExport = await src.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('dachaeum.') && k !== 'dachaeum.v3.lastBackup').map(k => [k, localStorage.getItem(k)])));
  assert.deepEqual(afterExport, original, '백업 후 기존 자료 그대로');
  assert.ok(await src.evaluate(() => localStorage.getItem('dachaeum.v3.lastBackup')), '저장 후 마지막 백업 시각 기록');
  const text = fs.readFileSync(await dl.path(), 'utf8');
  assert.doesNotMatch(text, /김테스트|서명 문서|프로그램 A/, '파일 안에 환자정보·문서가 평문으로 없음');
  const file = JSON.parse(text);
  assert.equal(file.format, 'dachaeum-consent-backup'); assert.equal(file.counts.contracts, 2);

  // 새 환경: 이미 다른 자료가 있는 기기 + 재고관리 자료
  const dst = await open([mk('X9', '기존 기기 계약')], { storage: { 'inventory-system:v1': 'DST-INVENTORY' }, answer: () => undefined });
  const restoreWith = async (pw, buf) => {
    await click(dst, '백업 · 복원');
    await dst.locator('input[placeholder="백업할 때 정한 비밀번호"]').fill(pw);
    await dst.locator('input[type=file]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(buf) });
    await dst.waitForTimeout(2500);
  };
  await restoreWith('wrong-pass', text);
  assert.match(await body(dst), /비밀번호가 맞지 않거나 파일이 손상되었습니다/);
  assert.equal((await contracts(dst))[0].id, 'X9', '실패 시 기존 자료 그대로');
  const tampered = JSON.stringify({ ...file, data: file.data.slice(0, -8) + 'AAAAAAAA' });
  await dst.locator('input[placeholder="백업할 때 정한 비밀번호"]').fill('test-pass-1');
  await dst.locator('input[type=file]').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(tampered) });
  await dst.waitForTimeout(2500);
  assert.match(await body(dst), /비밀번호가 맞지 않거나 파일이 손상되었습니다/);
  await dst.locator('input[type=file]').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'other' })) });
  await dst.waitForTimeout(800);
  assert.match(await body(dst), /다채움 동의서 백업 파일이 아닙니다/);
  await dst.locator('input[type=file]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await dst.waitForTimeout(2500);
  const t = await body(dst);
  assert.match(t, /계약 2건 · 문서 1건 \(환불완료 1건\)/);
  assert.match(t, /교체됩니다.*합쳐지지 않으니/s, '기존 자료가 있으면 교체·비합침 안내');
  assert.equal((await contracts(dst))[0].id, 'X9', '확인 전에는 바뀌지 않음');
  await Promise.all([dst.waitForEvent('load'), click(dst, '이 백업으로 복원')]); await dst.waitForTimeout(2000);
  const restored = await dst.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('dachaeum.') && k !== 'dachaeum.v3.lastBackup').map(k => [k, localStorage.getItem(k)])));
  assert.deepEqual(restored, original, '복원 후 이 앱 자료 전체가 원본과 동일');
  assert.equal(await dst.evaluate(() => localStorage.getItem('inventory-system:v1')), 'DST-INVENTORY', '재고관리 자료는 건드리지 않음');
  assert.ok(dst.dialogs.some(m => /교체/.test(m)), '복원 전 확인창');
  assert.equal(((await body(dst)).match(/환불완료/g) || []).length, 1);
  await click(dst, '프로그램 B'); await click(dst, '환불 정산');
  assert.equal(await allocInputs(dst).nth(0).inputValue(), '400,000', '작성 중 환불 정산도 복원');
  assert.deepEqual(src.errors.concat(dst.errors), []);
});

test('복원 중 저장 실패: 원래 자료로 되돌리고 안내', async () => {
  const fs = require('node:fs');
  const src = await open([mk('CT1', '백업 원본 계약')]);
  await click(src, '백업 · 복원');
  await src.locator('input[placeholder="비밀번호 (6자 이상)"]').fill('test-pass-1');
  await src.locator('input[placeholder="비밀번호 확인"]').fill('test-pass-1');
  await click(src, '백업 파일 만들기'); await src.waitForTimeout(2000);
  const [dl] = await Promise.all([src.waitForEvent('download'), src.getByText(/^파일 저장 · /).click()]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  const dst = await open([mk('KEEP', '기기 원래 계약')], { storage: { 'dachaeum.priceOverride': '{"keep":1}' } });
  const before = await dst.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('dachaeum.')).map(k => [k, localStorage.getItem(k)])));
  await click(dst, '백업 · 복원');
  await dst.locator('input[placeholder="백업할 때 정한 비밀번호"]').fill('test-pass-1');
  await dst.locator('input[type=file]').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await dst.waitForTimeout(2500);
  // 백업 자료를 쓰는 도중 저장 공간 부족 상황을 재현 (원래 자료를 되돌리는 쓰기는 허용)
  await dst.evaluate(() => { const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (String(v).includes('백업 원본 계약')) throw new DOMException('quota', 'QuotaExceededError'); return orig.call(this, k, v); }; });
  await click(dst, '이 백업으로 복원'); await dst.waitForTimeout(500);
  assert.match(await body(dst), /복원에 실패했습니다. 기존 자료는 그대로 남아 있습니다/);
  const after = await dst.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('dachaeum.')).map(k => [k, localStorage.getItem(k)])));
  assert.deepEqual(after, before);
});

test('정상가 보완 입력: 취소·빈값·문자·0원·음수·소수·근거 없음·확인 취소는 저장 안 함, 부분 저장 없음', async () => {
  const seedOf = () => [mk('CT1', '보완 계약', { total: 660000, paid: 660000, priorDep: 0, payments: [{ method: '카드', amount: 660000 }],
    items: [{ kind: '시술', name: '턱밑 A', qty: 5, price: 0 }, { kind: '시술', name: '턱밑 B', qty: 5, price: 0 }] })];
  const cases = [
    ['금액 입력 취소', [null]], ['빈 값', ['']], ['문자', ['abc']], ['0원', ['0']], ['음수', ['-5000']], ['소수', ['1.5']],
    ['근거 입력 취소', ['110000', null]], ['근거 빈 값', ['110000', '  ']], ['최종 확인 취소', ['110000', '근거', false]],
    ['첫 항목 완료 후 두 번째 취소 → 전부 저장 안 함', ['110000', '근거', true, null]],
  ];
  for (const [name, answers] of cases) {
    const q = answers.slice();
    const p = await open(seedOf(), { handle: d => { const a = q.length ? q.shift() : null;
      if (a === null || a === false) return d.dismiss(); return d.accept(a === true ? undefined : a); } });
    await click(p, '보완 계약'); await click(p, '환불 정산');
    await p.getByText('+', { exact: true }).nth(0).click(); await p.getByText('+', { exact: true }).nth(1).click(); await p.waitForTimeout(200);
    await click(p, '근거 확인 후 보완'); await p.waitForTimeout(300);
    const [c] = await contracts(p);
    assert.ok(!c.priceFixes || c.priceFixes.length === 0, name + ': 보완 기록 저장 안 됨');
    assert.ok(!c.refund && (c.status || '등록완료') === '등록완료', name + ': 환불 확정 안 됨');
    assert.match(await body(p), /정상가 확인 필요 · 환불 확정 불가/, name + ': 계속 차단');
    await click(p, '정산서 생성 · 환자 서명');
    assert.doesNotMatch(await body(p), /터치하여 서명/, name + ': 서명 단계로 못 넘어감');
    await p.context().close();
  }
  // 정상 입력 ('110,000원' 형식) → 두 항목 모두 저장, 환불은 여전히 서명해야 확정
  const ok = ['110,000원', '2026-03-02 서명 동의서', true, '99000', '당시 가격표', true];
  const p = await open(seedOf(), { handle: d => { const a = ok.shift(); return d.accept(a === true ? undefined : a); } });
  await click(p, '보완 계약'); await click(p, '환불 정산');
  await p.getByText('+', { exact: true }).nth(0).click(); await p.getByText('+', { exact: true }).nth(1).click(); await p.waitForTimeout(200);
  await click(p, '근거 확인 후 보완'); await p.waitForTimeout(400);
  const [c] = await contracts(p);
  assert.deepEqual(c.priceFixes.map(f => [f.key, f.price, f.basis]), [['item:0', 110000, '2026-03-02 서명 동의서'], ['item:1', 99000, '당시 가격표']]);
  assert.ok(!c.refund && (c.status || '등록완료') === '등록완료', '보완만으로 환불 확정되지 않음');
  assert.equal(await finalRefund(p), String((660000 - 66000 - 110000 - 99000).toLocaleString('ko-KR')));
});

test('PGM-0041 흑자 1cm 1개: 총 등록금액 330,000원 표시·저장, 병변 금액 전액 차감 유지, 기존 계약 값 불변', async () => {
  const old = mk('c-old-bs', '흑자 제거', { cat: '색소', total: 440000, paid: 440000, priorDep: 0, payments: [{ method: '카드', amount: 440000 }],
    items: [{ kind: '시술', lesionUnit: true, qty: 5, price: 440000, name: '흑자 1 · 이마 2cm (2cm 이하)' }],
    priceSnap: { ver: 'old', programId: 'PGM-0041', total: null, at: '2026-09-01' } });
  const p = await open([old]);
  const before = JSON.stringify((await contracts(p))[0]);
  await click(p, '새 동의서 작성'); const ins = p.locator('input');
  await ins.nth(0).fill('흑자테스트'); await ins.nth(1).fill('880101'); await ins.nth(2).fill('01011112222');
  await click(p, '다음 단계'); await click(p, '전체');
  await p.locator('input[placeholder*="검색"]').fill('PGM-0041'); await p.waitForTimeout(300);
  assert.match(await body(p), /1개 330,000원~/);
  await click(p, '흑자 제거');
  await p.locator('input[placeholder="치료 부위 입력"]').first().fill('왼쪽 볼');
  await p.locator('input[placeholder="크기"]').first().fill('1'); await p.locator('input[placeholder="크기"]').first().blur(); await p.waitForTimeout(300);
  await click(p, '다음 단계'); await click(p, '카드');
  assert.match(await body(p), /330,000/);
  await signAndSave(p);
  const all = await contracts(p);
  const c = all.find(x => x.id !== 'c-old-bs');
  assert.equal(c.total, 330000);
  assert.equal(c.paid, 330000);
  assert.deepEqual(c.items.map(i => [i.kind, !!i.lesionUnit, i.qty, i.price]), [['시술', true, 5, 330000]]);
  assert.equal(c.priceSnap.programId, 'PGM-0041');
  assert.equal(c.priceSnap.total, 330000);
  assert.equal(JSON.stringify(all.find(x => x.id === 'c-old-bs')), before, '기존 계약 값 불변');
  assert.deepEqual(p.errors, []);
});


test('가격 관리: 버튼 표시 → 앱 안에서 열림(404 없음) → 수정·저장 → 새 계약 적용, 기존 계약 불변 → 새로고침 유지 → 기본 가격 복귀, 기존 변경 기록 유지', async () => {
  const oldOv = { programs: { 'PGM-0002': { total: '1450000' } }, added: [], deleted: [], events: {}, at: '2026-09-01 10:00' };
  const p = await open([mk('c-keep', '스페셜 토닝 1', { cat: '색소', total: 1320000, paid: 1320000 })], { storage: { 'dachaeum.priceOverride': JSON.stringify(oldOv) } });
  const keep = JSON.stringify((await contracts(p)).find(c => c.id === 'c-keep'));
  const ovNow = () => p.evaluate(() => JSON.parse(localStorage.getItem('dachaeum.priceOverride') || 'null'));
  const openPm = async () => { await p.locator('[title="가격 관리"]').click(); await p.waitForTimeout(400); };
  assert.equal(await p.locator('[title="가격 관리"]').count(), 1, '가격 관리 버튼 표시');
  assert.equal(await p.locator('a[href*="dc.html"]').count(), 0);
  const url = p.url();
  await openPm();
  assert.equal(p.url(), url, '다른 파일로 이동하지 않음 (404 없음)');
  let b = await body(p);
  assert.match(b, /가격 관리/); assert.match(b, /현재 변경된 가격/);
  assert.match(b, /스페셜 토닝 2[\s\S]*총 등록금액 1,430,000원 → 1,450,000원/, '기존 변경 기록 표시');
  // 수정·저장
  await p.locator('input[placeholder^="프로그램·시술 검색"]').fill('PGM-0001'); await p.waitForTimeout(300);
  assert.match(await body(p), /스페셜 토닝 1[\s\S]*1,320,000원/);
  await p.locator('input[placeholder="수정 가격 (원)"]').first().fill('1,400,000');
  await p.getByText('저장', { exact: true }).first().click(); await p.waitForTimeout(400);
  assert.match(await body(p), /1,400,000원으로 저장했습니다/);
  let ov = await ovNow();
  assert.equal(ov.programs['PGM-0001'].total, '1400000');
  assert.deepEqual(ov.programs['PGM-0002'], { total: '1450000' }, '기존 변경 기록 유지');
  // 새로고침 후에도 유지 → 새 계약에 변경 가격 적용
  await p.reload(); await p.waitForTimeout(2000);
  await pickProgram(p, 'PGM-0001', '스페셜 토닝 1'); await signAndSave(p);
  let all = await contracts(p);
  const c1 = all.find(c => c.id !== 'c-keep');
  assert.equal(c1.total, 1400000, '새 계약에 변경 가격 적용');
  assert.equal(JSON.stringify(all.find(c => c.id === 'c-keep')), keep, '기존 계약 불변');
  // 기본 가격으로 되돌리기
  await p.goto(URL); await p.waitForTimeout(1500);
  await openPm();
  await p.locator('input[placeholder^="프로그램·시술 검색"]').fill('PGM-0001'); await p.waitForTimeout(300);
  await p.getByText('기본 가격으로', { exact: true }).last().click(); await p.waitForTimeout(400);
  ov = await ovNow();
  assert.equal(ov.programs['PGM-0001'], undefined);
  assert.deepEqual(ov.programs['PGM-0002'], { total: '1450000' }, '다른 변경 기록은 그대로');
  assert.match(await body(p), /기본 가격 1,320,000원으로 되돌렸습니다/);
  await p.getByText('닫기', { exact: true }).last().click(); await p.waitForTimeout(300);
  await pickProgram(p, 'PGM-0001', '스페셜 토닝 1'); await signAndSave(p);
  all = await contracts(p);
  assert.deepEqual(all.filter(c => c.id !== 'c-keep').map(c => c.total).sort(), [1320000, 1400000], '되돌린 뒤 새 계약은 기본 가격, 앞서 만든 계약은 그대로');
  assert.equal(JSON.stringify(all.find(c => c.id === 'c-keep')), keep);
  assert.deepEqual(p.errors, []);
});

test('가격 관리: 잘못된 입력·취소는 저장 안 함, 병변·조건별 금액 항목은 수정 칸 없음', async () => {
  let ans = true;
  const p = await open(null, { handle: d => (ans ? d.accept() : d.dismiss()) });
  await p.locator('[title="가격 관리"]').click(); await p.waitForTimeout(400);
  const q = p.locator('input[placeholder^="프로그램·시술 검색"]');
  await q.fill('PGM-0001'); await p.waitForTimeout(300);
  for (const bad of ['', 'abc', '-5000', '0', '12.5']) {
    await p.locator('input[placeholder="수정 가격 (원)"]').first().fill(bad);
    await p.getByText('저장', { exact: true }).first().click(); await p.waitForTimeout(200);
  }
  ans = false;
  await p.locator('input[placeholder="수정 가격 (원)"]').first().fill('1500000');
  await p.getByText('저장', { exact: true }).first().click(); await p.waitForTimeout(200);
  assert.equal(await p.evaluate(() => localStorage.getItem('dachaeum.priceOverride')), null, '아무것도 저장되지 않음');
  await q.fill('PGM-0041'); await p.waitForTimeout(300);
  assert.match(await body(p), /병변 크기별 금액으로 계산/);
  assert.equal(await p.locator('input[placeholder="수정 가격 (원)"]').count(), 0);
  assert.deepEqual(p.errors, []);
});

test('1회 정상가 변경: 총 등록금액과 별도 저장 → 새 계약에 저장·환불 차감, 기존 계약 유지 → 새로고침 유지 → 기본값 복귀', async () => {
  const oldOv = { programs: { 'PGM-0002': { total: '1450000' } }, added: [], deleted: [], events: {}, at: '2026-09-01 10:00' };
  const old = mk('c-old', '스페셜 토닝 1 (이전 계약)', { cat: '색소', total: 990000, paid: 990000, priorDep: 0, payments: [{ method: '카드', amount: 990000 }],
    items: [{ kind: '시술', name: '레블라이트 SI + 비타민관리', qty: 5, price: 198000 }] });
  const p = await open([old], { storage: { 'dachaeum.priceOverride': JSON.stringify(oldOv) } });
  const keep = JSON.stringify((await contracts(p))[0]);
  const ls = k => p.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), k);
  const pm = async () => { await p.locator('[title="가격 관리"]').click(); await p.waitForTimeout(400);
    await p.locator('input[placeholder^="프로그램·시술 검색"]').fill('PGM-0001'); await p.waitForTimeout(300); };
  const unitIn = p.locator('input[placeholder="수정 1회 정상가 (원)"]');
  await pm();
  let b = await body(p);
  assert.match(b, /시술별 환불용 1회 정상가/);
  assert.match(b, /레블라이트 SI \+ 비타민관리 5회\s*198,000원/);
  assert.equal(await unitIn.count(), 3, '스타룩스·레블라이트·피코 (약처방 서비스는 수정 칸 없음)');
  assert.match(b, /레블라이트 SI \+ 비타민관리 5회\s*198,000원\s*공통 시술 · 11개 프로그램에 함께 적용/);
  // 1회 정상가 수정 (레블라이트 198,000 → 250,000)
  await unitIn.nth(1).fill('250,000'); await p.getByText('정상가 저장', { exact: true }).nth(1).click(); await p.waitForTimeout(400);
  assert.match(await body(p), /레블라이트 SI \+ 비타민관리 1회 정상가를 250,000원으로 저장/);
  assert.deepEqual((await ls('dachaeum.unitOverride')).items, { 'proc:pig-revlite': { price: '250000' } }, '공통 시술 단위로 저장');
  assert.deepEqual(await ls('dachaeum.priceOverride'), oldOv, '총 등록금액 기록은 그대로');
  assert.match(await body(p), /스페셜 토닝 1 PGM-0001 · 색소\s*1,320,000원/, '1회 정상가를 바꿔도 총 등록금액 그대로');
  assert.match(await body(p), /변경된 1회 정상가 적용 중 · 기본 198,000원/);
  // 총 등록금액 수정 → 1회 정상가 기록에 영향 없음
  await p.locator('input[placeholder="수정 가격 (원)"]').first().fill('1400000'); await p.getByText('저장', { exact: true }).first().click(); await p.waitForTimeout(400);
  assert.equal((await ls('dachaeum.priceOverride')).programs['PGM-0001'].total, '1400000');
  assert.deepEqual((await ls('dachaeum.unitOverride')).items, { 'proc:pig-revlite': { price: '250000' } }, '총 등록금액 변경이 1회 정상가에 영향 없음');
  assert.match(await body(p), /레블라이트 SI \+ 비타민관리 5회\s*250,000원/);
  // 새로고침 후 새 계약: 총 등록금액 1,400,000 / 레블라이트 250,000 / 나머지 기본값
  await p.reload(); await p.waitForTimeout(2000);
  await pickProgram(p, 'PGM-0001', '스페셜 토닝 1'); await signAndSave(p);
  let all = await contracts(p);
  const c = all.find(x => x.id !== 'c-old');
  assert.equal(c.total, 1400000);
  assert.deepEqual(c.items.filter(i => i.kind === '시술').map(i => [i.name, i.qty, i.price]),
    [['스타룩스 1540', 1, 330000], ['레블라이트 SI + 비타민관리', 5, 250000], ['피코 PLUS + 비타민관리', 5, 198000]]);
  assert.equal(JSON.stringify(all.find(x => x.id === 'c-old')), keep, '기존 계약 1회 정상가 유지');
  // 환불: 새 계약은 계약 당시 250,000 × 2 차감
  const k = c.items.findIndex(i => /레블라이트/.test(i.name));
  await p.goto(URL); await p.waitForTimeout(1500);
  await click(p, '스페셜 토닝 1'); await click(p, '환불 정산');
  await p.getByText('+', { exact: true }).nth(k).click(); await p.getByText('+', { exact: true }).nth(k).click(); await p.waitForTimeout(200);
  assert.equal(await finalRefund(p), '760,000');                                  // 1,400,000 − 140,000 − 2 × 250,000
  // 기존 계약은 계약 당시 198,000 차감
  await p.goto(URL); await p.waitForTimeout(1500);
  await click(p, '스페셜 토닝 1 (이전 계약)'); await click(p, '환불 정산');
  await p.getByText('+', { exact: true }).nth(0).click(); await p.waitForTimeout(200);
  assert.equal(await finalRefund(p), '693,000');                                  // 990,000 − 99,000 − 198,000
  // 1회 정상가 기본값으로 → 1회 정상가 기록만 제거, 총 등록금액 변경은 유지
  await p.goto(URL); await p.waitForTimeout(1500);
  await pm();
  await p.getByText('정상가 기본값으로', { exact: true }).click(); await p.waitForTimeout(400);
  assert.deepEqual((await ls('dachaeum.unitOverride')).items, {});
  assert.equal((await ls('dachaeum.priceOverride')).programs['PGM-0001'].total, '1400000');
  assert.deepEqual((await ls('dachaeum.priceOverride')).programs['PGM-0002'], { total: '1450000' });
  await p.getByText('닫기', { exact: true }).last().click(); await p.waitForTimeout(300);
  await pickProgram(p, 'PGM-0001', '스페셜 토닝 1'); await signAndSave(p);
  all = await contracts(p);
  const c3 = all.find(x => x.id !== 'c-old' && x.id !== c.id);
  assert.equal(c3.total, 1400000);
  assert.equal(c3.items.find(i => /레블라이트/.test(i.name)).price, 198000, '기본 1회 정상가로 복귀');
  assert.equal(all.find(x => x.id === c.id).items.find(i => /레블라이트/.test(i.name)).price, 250000, '앞서 만든 계약은 그대로');
  assert.deepEqual(p.errors, []);
});

test('1회 정상가 변경: 정상가 확인 필요 항목(PGM-0037)은 수정 칸 없이 기존 기준 유지', async () => {
  const p = await open();
  await p.locator('[title="가격 관리"]').click(); await p.waitForTimeout(400);
  await p.locator('input[placeholder^="프로그램·시술 검색"]').fill('PGM-0037'); await p.waitForTimeout(300);
  assert.match(await body(p), /남성 턱밑라인 포함 제모[\s\S]*정상가 확인 필요 · 등록 시 입력/);
  assert.equal(await p.locator('input[placeholder="수정 1회 정상가 (원)"]').count(), 0);
  await p.getByText('닫기', { exact: true }).last().click(); await p.waitForTimeout(300);
  await pickProgram(p, 'PGM-0037', '남성 턱밑라인 포함');
  assert.match(await body(p), /환불용 1회 정상가 확인 필요/, '계약 작성 시 직접 입력 요구 그대로');
});

test('공통 시술 1회 정상가: 한 번 수정하면 같은 시술을 쓰는 다른 프로그램 새 계약에도 적용, 가격 기준이 다른 항목은 프로그램별', async () => {
  const p = await open();
  const ls = k => p.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), k);
  await p.locator('[title="가격 관리"]').click(); await p.waitForTimeout(400);
  const q = p.locator('input[placeholder^="프로그램·시술 검색"]');
  // 흉터 피코프락셀: 같은 시술 ID라도 시술 DB(440,000)와 프로그램 단가(275,000)가 달라 프로그램별 관리
  await q.fill('PGM-0022'); await p.waitForTimeout(300);
  assert.match(await body(p), /피코프락셀 1회\s*275,000원\s*이 프로그램에만 적용/);
  await p.locator('input[placeholder="수정 1회 정상가 (원)"]').first().fill('300000');
  await p.getByText('정상가 저장', { exact: true }).first().click(); await p.waitForTimeout(400);
  // 레블라이트(공통 시술): PGM-0001 화면에서 수정
  await q.fill('PGM-0001'); await p.waitForTimeout(300);
  await p.locator('input[placeholder="수정 1회 정상가 (원)"]').nth(1).fill('250000');
  await p.getByText('정상가 저장', { exact: true }).nth(1).click(); await p.waitForTimeout(400);
  assert.deepEqual((await ls('dachaeum.unitOverride')).items, { 'PGM-0022|scar-picofraxel-regen-full': { price: '300000' }, 'proc:pig-revlite': { price: '250000' } });
  await q.fill('PGM-0002'); await p.waitForTimeout(300);
  assert.match(await body(p), /레블라이트 SI \+ 비타민관리 4회\s*250,000원/, '다른 프로그램에도 같은 값 표시');
  await q.fill('PGM-0023'); await p.waitForTimeout(300);
  assert.match(await body(p), /피코프락셀 3회\s*275,000원/, '프로그램별 항목은 다른 프로그램에 영향 없음');
  await p.getByText('닫기', { exact: true }).last().click(); await p.waitForTimeout(300);
  await pickProgram(p, 'PGM-0002', '스페셜 토닝 2'); await signAndSave(p);
  const [c] = await contracts(p);
  assert.equal(c.total, 1430000, '총 등록금액은 그대로');
  assert.equal(c.items.find(i => /레블라이트/.test(i.name)).price, 250000, '다른 프로그램 새 계약에도 공통 정상가 적용');
  assert.equal(c.items.find(i => /피코 PLUS/.test(i.name)).price, 198000);
  assert.deepEqual(p.errors, []);
});

test('백업·복원: 1회 정상가 변경(unitOverride)·총 등록금액 변경이 깨끗한 기기로 그대로 복원, 복원 후 새 계약에 적용, 실패 시 기존 기록 보존', async () => {
  const fs = require('node:fs');
  const ovT = { programs: { 'PGM-0002': { total: '1450000' } }, added: [], deleted: [], events: {}, at: '2026-09-01 10:00' };
  const src = await open([mk('CT1', '백업 원본 계약')], { storage: { 'dachaeum.priceOverride': JSON.stringify(ovT) } });
  await src.locator('[title="가격 관리"]').click(); await src.waitForTimeout(400);
  await src.locator('input[placeholder^="프로그램·시술 검색"]').fill('PGM-0001'); await src.waitForTimeout(300);
  await src.locator('input[placeholder="수정 1회 정상가 (원)"]').nth(1).fill('250000');
  await src.getByText('정상가 저장', { exact: true }).nth(1).click(); await src.waitForTimeout(400);
  await src.getByText('닫기', { exact: true }).last().click(); await src.waitForTimeout(300);
  const srcUo = await src.evaluate(() => localStorage.getItem('dachaeum.unitOverride'));
  assert.deepEqual(JSON.parse(srcUo).items, { 'proc:pig-revlite': { price: '250000' } });
  await click(src, '백업 · 복원');
  await src.locator('input[placeholder="비밀번호 (6자 이상)"]').fill('test-pass-1');
  await src.locator('input[placeholder="비밀번호 확인"]').fill('test-pass-1');
  await click(src, '백업 파일 만들기'); await src.waitForTimeout(2000);
  const [dl] = await Promise.all([src.waitForEvent('download'), src.getByText(/^파일 저장 · /).click()]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  assert.doesNotMatch(text, /pig-revlite|250000/, '백업 파일 안은 암호화');

  // 실패 시 기존 unitOverride 보존: 기존 기록이 있는 기기에서 잘못된 비밀번호·손상 파일·저장 실패
  const keepUo = JSON.stringify({ items: { 'proc:pig-xd': { price: '400000' } }, at: '2026-09-30 09:00' });
  const bad = await open([mk('KEEP', '기기 원래 계약')], { storage: { 'dachaeum.unitOverride': keepUo, 'dachaeum.priceOverride': '{"keep":1}' } });
  const snap = () => bad.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('dachaeum.')).map(k => [k, localStorage.getItem(k)])));
  const before = await snap();
  await click(bad, '백업 · 복원');
  const pw = bad.locator('input[placeholder="백업할 때 정한 비밀번호"]'), fileIn = bad.locator('input[type=file]');
  await pw.fill('wrong-pass'); await fileIn.setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(text) }); await bad.waitForTimeout(2500);
  assert.match(await body(bad), /비밀번호가 맞지 않거나 파일이 손상되었습니다/);
  const file = JSON.parse(text);
  await pw.fill('test-pass-1');
  await fileIn.setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...file, data: file.data.slice(0, -8) + 'AAAAAAAA' })) }); await bad.waitForTimeout(2500);
  assert.match(await body(bad), /비밀번호가 맞지 않거나 파일이 손상되었습니다/);
  assert.deepEqual(await snap(), before);
  await fileIn.setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(text) }); await bad.waitForTimeout(2500);
  await bad.evaluate(() => { const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k === 'dachaeum.unitOverride' && String(v).includes('pig-revlite')) throw new DOMException('quota', 'QuotaExceededError'); return orig.call(this, k, v); }; });
  await click(bad, '이 백업으로 복원'); await bad.waitForTimeout(500);
  assert.match(await body(bad), /복원에 실패했습니다. 기존 자료는 그대로 남아 있습니다/);
  assert.deepEqual(await snap(), before, '복원 실패 후 기존 unitOverride·priceOverride·계약 그대로');

  // 깨끗한 기기에 복원
  const dst = await open();
  await click(dst, '백업 · 복원');
  await dst.locator('input[placeholder="백업할 때 정한 비밀번호"]').fill('test-pass-1');
  await dst.locator('input[type=file]').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(text) }); await dst.waitForTimeout(2500);
  await Promise.all([dst.waitForEvent('load'), click(dst, '이 백업으로 복원')]); await dst.waitForTimeout(2000);
  assert.equal(await dst.evaluate(() => localStorage.getItem('dachaeum.unitOverride')), srcUo, '1회 정상가 변경 기록 동일하게 복원');
  assert.deepEqual(JSON.parse(await dst.evaluate(() => localStorage.getItem('dachaeum.priceOverride'))), ovT, '총 등록금액 변경 기록도 복원');
  await dst.locator('[title="가격 관리"]').click(); await dst.waitForTimeout(400);
  assert.match(await body(dst), /레블라이트 SI \+ 비타민관리 공통 시술 · 11개 프로그램\s*1회 정상가 198,000원 → 250,000원/);
  assert.match(await body(dst), /총 등록금액 1,430,000원 → 1,450,000원/);
  await dst.getByText('닫기', { exact: true }).last().click(); await dst.waitForTimeout(300);
  await pickProgram(dst, 'PGM-0002', '스페셜 토닝 2'); await signAndSave(dst);
  const c = (await contracts(dst)).find(x => x.id !== 'CT1');
  assert.equal(c.total, 1450000, '복원된 총 등록금액 적용');
  assert.equal(c.items.find(i => /레블라이트/.test(i.name)).price, 250000, '복원된 1회 정상가가 새 계약에 저장');
  assert.deepEqual(src.errors.concat(dst.errors, bad.errors), []);
});

// ---- 프로그램 이름 · 이벤트 · 선결제권 결제 안내 · 환불 정산 연결 ----
const pmOpen = async p => { await p.locator('[title="가격 관리"]').click(); await p.waitForTimeout(400); };
const pmSearch = async (p, q) => { await p.locator('input[placeholder^="프로그램·시술 검색"]').fill(q); await p.waitForTimeout(300); };
const pmClose = async p => { await p.getByText('닫기', { exact: true }).last().click(); await p.waitForTimeout(300); };
const lsJ = (p, k) => p.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), k);
const toStep3 = async (p, id, label, who = '결제테스트') => {
  await click(p, '새 동의서 작성'); const ins = p.locator('input');
  await ins.nth(0).fill(who); await ins.nth(1).fill('880101'); await ins.nth(2).fill('01011112222');
  await click(p, '다음 단계'); await click(p, '전체');
  await p.locator('input[placeholder*="검색"]').fill(id); await p.waitForTimeout(300);
  await click(p, label); await click(p, '다음 단계');
};

test('프로그램 이름 변경: 검색·선택·새 계약·새 동의서에 반영, ID·금액 그대로, 기존 계약·서명 문서 유지, 되돌리기', async () => {
  const oldDoc = { id: 'D-OLD', contractId: 'C-OLD', kind: '이용동의서', version: 1, signedAt: '2026-09-01', html: '<div>스페셜 토닝 1 서명 문서</div>' };
  const p = await open([mk('C-OLD', '스페셜 토닝 1', { cat: '색소', total: 1320000, paid: 1320000 })], { storage: { 'dachaeum.v3.docs': JSON.stringify([oldDoc]) } });
  const before = await p.evaluate(() => [localStorage.getItem('dachaeum.v3.contracts'), localStorage.getItem('dachaeum.v3.docs')]);
  await pmOpen(p); await pmSearch(p, 'PGM-0001');
  await p.locator('input[placeholder="프로그램 이름 변경"]').first().fill('스페셜 토닝 1 (가을)');
  await click(p, '이름 저장');
  assert.match(await body(p), /프로그램 이름을 ‘스페셜 토닝 1 \(가을\)’\(으\)로 저장/);
  assert.deepEqual((await lsJ(p, 'dachaeum.priceOverride')).programs['PGM-0001'], { name: '스페셜 토닝 1 (가을)' });
  assert.match(await body(p), /스페셜 토닝 1 \(가을\) PGM-0001 · 색소\s*1,320,000원/, '금액 그대로');
  await pmClose(p);
  await p.reload(); await p.waitForTimeout(2000);
  await toStep3(p, 'PGM-0001', '스페셜 토닝 1 (가을)');
  assert.match(await body(p), /최종 계약금액 1,320,000원/);
  await click(p, '카드'); await signAndSave(p);
  const all = await contracts(p), c = all.find(x => x.id !== 'C-OLD');
  assert.equal(c.program, '스페셜 토닝 1 (가을)');
  assert.equal(c.priceSnap.programId, 'PGM-0001');
  assert.equal(c.total, 1320000);
  const d = (await docs(p)).find(x => x.contractId === c.id);
  assert.match(d.html.replace(/<[^>]+>/g, ' '), /스페셜 토닝 1 \(가을\)/, '새 동의서에 변경 이름');
  const after = await p.evaluate(() => [localStorage.getItem('dachaeum.v3.contracts'), localStorage.getItem('dachaeum.v3.docs')]);
  assert.equal(JSON.stringify(JSON.parse(after[0]).find(x => x.id === 'C-OLD')), JSON.stringify(JSON.parse(before[0])[0]), '기존 계약 그대로');
  assert.deepEqual(JSON.parse(after[1]).find(x => x.id === 'D-OLD'), oldDoc, '기존 서명 문서 그대로');
  // 기본 이름으로
  await p.goto(URL); await p.waitForTimeout(1500);
  await pmOpen(p); await pmSearch(p, 'PGM-0001'); await click(p, '기본 이름으로');
  assert.equal(await lsJ(p, 'dachaeum.priceOverride').then(o => o.programs['PGM-0001']), undefined);
  assert.equal((await contracts(p)).find(x => x.id === c.id).program, '스페셜 토닝 1 (가을)', '되돌려도 저장된 계약 이름은 그대로');
  assert.deepEqual(p.errors, []);
});

test('이벤트 관리: 할인율 이벤트 추가 → 3단계 할인 항목·금액·결제 안내 반영, 1회 정상가 그대로, 중지 시 사라짐 / 이벤트는 다른 할인과 중복 없음', async () => {
  const p = await open();
  await pmOpen(p); await click(p, '이벤트');
  const evNames = await p.locator('xpath=//label[starts-with(normalize-space(.),"이벤트명")]/input').evaluateAll(els => els.map(e => e.value));
  assert.deepEqual(evNames, ['비마약성 무통주사제 [어나프라주] 1회 제공', '[뉴비쥬] 앵콜 이벤트'], '기존 이벤트 설정을 읽어서 표시');
  assert.doesNotMatch(await body(p), /함께 선택 가능한 할인/, '이벤트 중복 할인 설정 없음');
  await p.locator('input[placeholder="이벤트명"]').fill('가을 이벤트');
  await p.locator('input[placeholder="할인율"]').fill('10');
  await click(p, '이벤트 추가');
  let eo = await lsJ(p, 'dachaeum.eventOverride');
  assert.equal(eo.added.length, 1); const id = eo.added[0].id;
  assert.deepEqual([eo.added[0].name, eo.added[0].rate, eo.added[0].kind], ['가을 이벤트', 0.1, 'rate']);
  await p.locator('input[placeholder="프로그램 ID (예: PGM-0001)"]').fill('PGM-0001'); await click(p, '프로그램 추가');
  await click(p, '이벤트 저장', 2);
  eo = await lsJ(p, 'dachaeum.eventOverride');
  assert.deepEqual(eo.events[id], { programs: ['PGM-0001'] });
  await pmClose(p);
  await toStep3(p, 'PGM-0001', '스페셜 토닝 1');
  assert.match(await body(p), /가을 이벤트 10%/, '할인 항목에 이벤트 표시');
  assert.match(await body(p), /최종 계약금액 1,320,000원/, '선택 전 자동 적용 없음');
  await click(p, '가을 이벤트 10%');
  assert.match(await body(p), /최종 계약금액 1,188,000원/);
  assert.match(await body(p), /1,188,000원을 결제할게요/, '결제 안내도 같은 금액');
  await click(p, '카드'); await signAndSave(p);
  const [c] = await contracts(p);
  assert.deepEqual([c.total, c.disc.kind, c.disc.eventId, c.disc.label], [1188000, 'ev:' + id, id, '가을 이벤트 10%']);
  assert.deepEqual(c.items.map(i => i.price), [330000, 198000, 198000], '이벤트 할인은 환불용 1회 정상가를 바꾸지 않음');
  await p.goto(URL); await p.waitForTimeout(1500);
  await pmOpen(p); await click(p, '이벤트'); await click(p, '중지', 2); await click(p, '이벤트 저장', 2); await pmClose(p);
  await toStep3(p, 'PGM-0001', '스페셜 토닝 1');
  assert.doesNotMatch(await body(p), /가을 이벤트 10%/);
  assert.deepEqual(p.errors, []);
});

test('선결제권 신규 구매: 부분 수납(1,000,000/3,000,000)은 미수금·예상 잔액 표시·서명 불가·임시 저장 → 이어서 전액 수납 → 납부액은 사용액 891,000만 → 환불 801,900 잔액 복원, 화면·정산서·저장 문서 일치', async () => {
  const p = await open();
  await toStep3(p, 'PGM-0018', '여드름 8주 프로그램', '신규구매테스트');
  await click(p, '선결제권'); await click(p, '300'); await click(p, '신규 구매 3,000,000원');
  const rcv = p.locator('xpath=//label[starts-with(normalize-space(.),"실제 수납액")]//input');
  await click(p, '카드', 0); await rcv.fill('1000000'); await p.waitForTimeout(300);
  let b = await body(p);
  for (const re of [/신규 구매 예정금액\s*3,000,000원/, /실제 수납액\s*1,000,000원/, /구매 미수금 · 전액 수납 확인 필요\s*2,000,000원/,
    /이 계약에 사용 \(예상\)\s*891,000원/, /차감 후 남은 선결제권 잔액 \(예상\)\s*2,109,000원/, /선결제권 구매금액 전액 수납 확인이 필요해요/]) assert.match(b, re);
  await click(p, '동의서 미리보기 · 서명');
  assert.doesNotMatch(await body(p), /터치하여 서명/, '전액 수납 전 서명 불가');
  await click(p, '임시 저장');
  const drafts = await lsJ(p, 'dachaeum.v3.newDrafts');
  assert.equal(drafts.length, 1);
  assert.deepEqual([drafts[0].state.preRcvAmt, drafts[0].state.preBuyM, drafts[0].state.preTier], ['1000000', '카드', '300'], '부분 수납 내역 기록');
  assert.deepEqual(await contracts(p), [], '임시 저장은 계약이 아님');
  // 새로 열어 이어서 작성 → 추가 수납 후 진행
  await p.goto(URL); await p.waitForTimeout(1500);
  assert.match(await body(p), /임시 저장\s*신규구매테스트 · 여드름 8주 프로그램 선결제권 구매 3,000,000원 중 1,000,000원 수납 · 미수금 2,000,000원/);
  await click(p, '이어서 작성');
  assert.equal(await rcv.inputValue(), '1,000,000');
  await rcv.fill('3000000'); await p.waitForTimeout(300);
  b = await body(p);
  assert.match(b, /차감 후 남은 선결제권 잔액\s*2,109,000원/); assert.doesNotMatch(b, /\(예상\)/);
  assert.match(b, /추가 결제 필요금액\s*0원/);
  await signAndSave(p);
  const [c] = await contracts(p);
  assert.deepEqual([c.total, c.paid], [891000, 891000], '납부액 = 이번 계약 사용액 (구매금액 3,000,000 아님)');
  assert.deepEqual(c.payments, [{ method: '선결제권 (신규 구매 300)', amount: 891000, prepaid: true, newPurchase: true }]);
  assert.deepEqual(c.prepaid, { tier: '300', balBefore: 0, balUse: 0, purchase: 3000000, received: 3000000, purchaseMethod: '카드', newUse: 891000, use: 891000, balAfter: 2109000 });
  assert.deepEqual(await lsJ(p, 'dachaeum.v3.newDrafts'), [], '서명 저장 후 임시 저장 정리');
  assert.match((await docs(p))[0].html.replace(/<[^>]+>/g, ' '), /신규 구매 3,000,000원 중 891,000원 사용 · 차감 후 잔액 2,109,000원/);
  // 환불 (시술 전)
  await p.goto(URL); await p.waitForTimeout(1500);
  await click(p, '여드름 8주 프로그램'); await click(p, '환불 정산');
  b = await body(p);
  assert.equal(await finalRefund(p), '801,900');
  assert.match(b, /이 중 선결제권 사용분\s*891,000원/);
  assert.match(b, /환불 방법\s*선결제권 잔액 복원 801,900원/);
  const svcBox = p.locator('xpath=//*[text()="추가 건수"]/ancestor::div[2]');
  await svcBox.getByText('+', { exact: true }).first().click(); await p.waitForTimeout(200);
  assert.equal(await finalRefund(p), '801,900', '입력 대기 건수는 차감 안 됨');
  await click(p, '정산서 생성 · 환자 서명');
  const st = (await body(p)).replace(/\s+/g, ' ');
  for (const re of [/납부금액 891,000원/, /선결제권 사용분 891,000원 \(납부금액에 포함\)/, /위약금 \(총 계약금액 891,000원 × 10%\) 89,100원/, /= 최종 환불금액 801,900원/,
    /4\. 환불 방법/, /선결제권 \(잔액 복원\) 891,000원 801,900원/, /합계 \(= 최종 환불금액\) 801,900원/, /선결제권 잔액으로 복원/]) assert.match(st, re);
  await sign(p); await p.getByText('서명 완료 · 저장', { exact: true }).last().click(); await p.waitForTimeout(800);
  const done = (await contracts(p))[0];
  assert.ok(done.refund, '정산서 서명 저장 → 환불완료');
  assert.deepEqual([done.refund.refundNum, done.refund.penNum, done.refund.paidEff], [801900, 89100, 891000]);
  assert.deepEqual(done.refund.pays.map(x => [x.method, x.prepaid, x.paid, x.refund]), [['선결제권 잔액 복원', true, 891000, 801900]]);
  const rt = (await docs(p)).find(x => x.kind !== '이용동의서').html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const re of [/납부금액 891,000 원/, /선결제권 사용분 891,000원 \(납부금액에 포함\)/, /위약금 \(총 계약금액 891,000 원 × 10%\) 89,100 원/, /= 최종 환불금액 801,900 원/,
    /선결제권 \(잔액 복원\) 891,000원 801,900원/, /합계 \(= 최종 환불금액\) 801,900원/]) assert.match(rt, re, '저장 문서(PDF 원본)도 같은 금액');
  assert.deepEqual(p.errors, []);
});

test('선결제권 보유 잔액: 충분(1,000,000)·부족(300,000)·0원(할인 불가) / 기존 잔액+신규 구매 함께 사용(200,000 + 3,000,000)', async () => {
  const p = await open();
  const balIn = p.locator('xpath=//*[text()="보유 선결제권 잔액 (직원 확인)"]/following-sibling::span//input');
  const rcv = p.locator('xpath=//label[starts-with(normalize-space(.),"실제 수납액")]//input');
  // 잔액 0원 + 신규 구매 없음 → 선결제권 할인 불가
  await toStep3(p, 'PGM-0018', '여드름 8주 프로그램', '잔액없음');
  await click(p, '선결제권'); await click(p, '300'); await click(p, '동의서 미리보기 · 서명');
  assert.match(await body(p), /선결제권 할인은 확인한 보유 잔액이 있거나 신규 구매할 때만 적용할 수 있습니다/);
  assert.doesNotMatch(await body(p), /터치하여 서명/);
  // 충분
  await balIn.fill('1000000'); await p.waitForTimeout(300);
  let b = await body(p);
  for (const re of [/보유 잔액 \(직원 확인\)\s*1,000,000원/, /이 계약에 사용\s*891,000원/, /차감 후 남은 선결제권 잔액\s*109,000원/, /추가 결제 필요금액\s*0원/]) assert.match(b, re);
  await signAndSave(p);
  let c = (await contracts(p))[0];
  assert.deepEqual([c.total, c.paid, c.preBal], [891000, 891000, 1000000]);
  assert.deepEqual(c.prepaid, { tier: '300', balBefore: 1000000, balUse: 891000, purchase: 0, received: 0, purchaseMethod: null, newUse: 0, use: 891000, balAfter: 109000 });
  // 부족
  await p.goto(URL); await p.waitForTimeout(1500);
  await toStep3(p, 'PGM-0018', '여드름 8주 프로그램', '잔액부족');
  await click(p, '선결제권'); await click(p, '300'); await balIn.fill('300000'); await p.waitForTimeout(300);
  b = await body(p);
  for (const re of [/이 계약에 사용\s*300,000원/, /차감 후 남은 선결제권 잔액\s*0원/, /추가 결제 필요금액\s*591,000원/, /591,000원을 결제할게요/]) assert.match(b, re);
  await click(p, '카드'); await signAndSave(p);
  c = (await contracts(p)).find(x => x.patient.name === '잔액부족');
  assert.deepEqual([c.total, c.paid], [891000, 891000]);
  assert.deepEqual(c.payments.map(x => [x.method, x.amount, !!x.prepaid]), [['카드', 591000, false], ['선결제권 잔액', 300000, true]], '당일 카드 수납과 잔액 사용 구분');
  assert.equal(c.method, '카드 + 선결제권 잔액 300,000원');
  // 기존 잔액 + 신규 구매
  await p.goto(URL); await p.waitForTimeout(1500);
  await toStep3(p, 'PGM-0018', '여드름 8주 프로그램', '함께사용');
  await click(p, '선결제권'); await click(p, '300'); await balIn.fill('200000');
  await click(p, '신규 구매 3,000,000원'); await click(p, '현금', 0); await rcv.fill('3000000'); await p.waitForTimeout(300);
  b = await body(p);
  for (const re of [/보유 잔액 \(직원 확인\)\s*200,000원\s*└ 이 계약에 사용\s*200,000원/, /└ 실제 수납액\s*3,000,000원\s*└ 이 계약에 사용\s*691,000원/,
    /차감 후 남은 선결제권 잔액\s*2,309,000원/, /추가 결제 필요금액\s*0원/, /최종 계약금액 891,000원/]) assert.match(b, re);
  await signAndSave(p);
  c = (await contracts(p)).find(x => x.patient.name === '함께사용');
  assert.deepEqual([c.total, c.paid], [891000, 891000], '3,200,000 아님');
  assert.deepEqual(c.payments, [{ method: '선결제권 잔액', amount: 200000, prepaid: true }, { method: '선결제권 (신규 구매 300)', amount: 691000, prepaid: true, newPurchase: true }]);
  assert.deepEqual(c.prepaid, { tier: '300', balBefore: 200000, balUse: 200000, purchase: 3000000, received: 3000000, purchaseMethod: '현금', newUse: 691000, use: 891000, balAfter: 2309000 });
  assert.equal(c.disc.preTier, '300', '잔액을 합쳐 할인 기준을 올리지 않음');
  assert.deepEqual(p.errors, []);
});

test('백업·복원: 프로그램 이름·이벤트·1회 정상가·총 등록금액 설정·임시 저장이 깨끗한 기기에 그대로 복원되고 새 계약에 적용', async () => {
  const fs = require('node:fs');
  const ov = { programs: { 'PGM-0001': { name: '스페셜 토닝 1 (가을)' }, 'PGM-0002': { total: '1450000' } }, added: [], deleted: [], events: {} };
  const eo = { events: { 'EV-R-T': { programs: ['PGM-0001'] }, 'EV-NEWBIJOU': { stack: { pre: true } } }, added: [{ id: 'EV-R-T', kind: 'rate', name: '가을 이벤트', rate: 0.1, start: '', end: '', active: true, programs: [] }], at: '2026-10-02 10:00' };
  const uo = { items: { 'proc:pig-revlite': { price: '250000' } } };
  const src = await open([mk('CT1', '백업 원본 계약')], { storage: { 'dachaeum.priceOverride': JSON.stringify(ov), 'dachaeum.eventOverride': JSON.stringify(eo), 'dachaeum.unitOverride': JSON.stringify(uo),
    'dachaeum.v3.newDrafts': JSON.stringify([{ id: 'DR1', name: '임시환자', prog: '스페셜 토닝 1', note: '선결제권 구매 3,000,000원 중 1,000,000원 수납', state: { preRcvAmt: '1000000' } }]) } });
  const keysOf = pg => pg.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('dachaeum.') && k !== 'dachaeum.v3.lastBackup').map(k => [k, localStorage.getItem(k)])));
  const original = await keysOf(src);
  await click(src, '백업 · 복원');
  await src.locator('input[placeholder="비밀번호 (6자 이상)"]').fill('test-pass-1');
  await src.locator('input[placeholder="비밀번호 확인"]').fill('test-pass-1');
  await click(src, '백업 파일 만들기'); await src.waitForTimeout(2000);
  const [dl] = await Promise.all([src.waitForEvent('download'), src.getByText(/^파일 저장 · /).click()]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  assert.doesNotMatch(text, /가을 이벤트|스페셜 토닝/, '설정도 암호화');
  const dst = await open();
  await click(dst, '백업 · 복원');
  await dst.locator('input[placeholder="백업할 때 정한 비밀번호"]').fill('test-pass-1');
  await dst.locator('input[type=file]').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(text) }); await dst.waitForTimeout(2500);
  await Promise.all([dst.waitForEvent('load'), click(dst, '이 백업으로 복원')]); await dst.waitForTimeout(2000);
  assert.deepEqual(await keysOf(dst), original, '이름·이벤트·정상가·가격 설정과 계약 전체 동일');
  await toStep3(dst, 'PGM-0001', '스페셜 토닝 1 (가을)');
  assert.match(await body(dst), /가을 이벤트 10%/);
  await click(dst, '가을 이벤트 10%'); await click(dst, '카드'); await signAndSave(dst);
  const c = (await contracts(dst)).find(x => x.id !== 'CT1');
  assert.deepEqual([c.program, c.total, c.items.find(i => /레블라이트/.test(i.name)).price], ['스페셜 토닝 1 (가을)', 1188000, 250000]);
  assert.deepEqual(src.errors.concat(dst.errors), []);
});

test('예약금: 목표(계약 총액 10%)에서 이 계약에 이미 납부·사용한 금액을 빼고 받음 — 기납부 50,000 → 오늘 39,100 / 신규 선결제권 3,000,000 사용 → 추가 예약금 0, 미수금은 남음', async () => {
  const p = await open();
  const pdIn = p.locator('xpath=//*[text()="기납부 예약금"]/following-sibling::span//input');
  await toStep3(p, 'PGM-0018', '여드름 8주 프로그램', '예약금테스트');
  // 일반 990,000 계약 (요청 예시 891,000 / 50,000 → 39,100은 단위 테스트에서 확인)
  await pdIn.fill('50000'); await click(p, '예약금 결제'); await p.waitForTimeout(200);
  let b = await body(p);
  assert.match(b, /예약금 목표 99,000원 중 이미 납부·사용 50,000원 → 오늘 추가 예약금 49,000원 · 남는 미수금 891,000원/);
  await click(p, '카드'); await signAndSave(p);
  let [c] = await contracts(p);
  assert.deepEqual([c.total, c.paid, c.priorDep], [990000, 99000, 50000], '50,000 + 49,000 (중복 합산 없음)');
  assert.deepEqual(c.payments.map(x => [x.method, x.amount]), [['카드', 49000]], '기납부 예약금은 결제수단 기록에 중복으로 넣지 않음');
  // 신규 선결제권이 계약금액보다 적은 경우 (PGM-0033 3,850,000 → 선결제권 300 = 3,465,000)
  await p.goto(URL); await p.waitForTimeout(1500);
  await toStep3(p, 'PGM-0033', '얼굴전체', '부족구매');
  await click(p, '선결제권'); await click(p, '300'); await click(p, '신규 구매 3,000,000원'); await click(p, '카드', 0);
  await p.locator('xpath=//label[starts-with(normalize-space(.),"실제 수납액")]//input').fill('3000000');
  await click(p, '예약금 결제'); await p.waitForTimeout(200);
  b = await body(p);
  for (const re of [/최종 계약금액 3,465,000원/, /이 계약에 사용\s*3,000,000원/, /추가 결제 필요금액\s*465,000원/,
    /예약금 목표 346,500원 중 이미 납부·사용 3,000,000원 → 오늘 추가 예약금 0원 · 남는 미수금 465,000원/, /추가 예약금 없이 등록할게요 \(미수금 465,000원\)/]) assert.match(b, re);
  assert.doesNotMatch(b, /완납용|추가 결제 필요금액\s*0원|추가 결제 없이 등록할게요/, '추가 예약금 0원을 완납·남은 결제 0원으로 표시하지 않음');
  assert.match(b, /예약금용 · A4 1장/);
  await click(p, '완납 결제'); await p.waitForTimeout(200);
  assert.match(await body(p), /465,000원을 결제할게요/, '완납 선택 시 남은 프로그램 대금 안내');
  await click(p, '예약금 결제'); await signAndSave(p);
  c = (await contracts(p)).find(x => x.patient.name === '부족구매');
  assert.deepEqual([c.total, c.paid, c.pay], [3465000, 3000000, 'deposit']);
  assert.deepEqual(c.payments, [{ method: '선결제권 (신규 구매 300)', amount: 3000000, prepaid: true, newPurchase: true }]);
  assert.equal(c.prepaid.balAfter, 0);
});

// 기기 저장 실패 흉내: 지정한 키에 쓰면 저장 공간 부족 오류 (window.__failKeys로 바꿀 수 있음)
const failWrites = (p, keys) => p.evaluate(keys => {
  window.__failKeys = new Set(keys);
  if (!window.__origSet) { window.__origSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (window.__failKeys.has(k)) throw new DOMException('quota', 'QuotaExceededError'); return window.__origSet.call(this, k, v); }; }
}, keys);
const SAVE_FAIL = /저장 공간이 부족해 저장하지 못했습니다\. 작성 내용과 서명은 그대로/;

test('동의서 저장 실패: 계약·문서 저장 실패 시 임시 저장본·작성 내용·서명 유지, 완료 표시 없음 → 다시 저장하면 계약·문서 1건씩, 그 후 임시 저장 정리', async () => {
  const p = await open();
  await toStep3(p, 'PGM-0018', '여드름 8주 프로그램', '저장실패테스트');
  await click(p, '선결제권'); await click(p, '300'); await click(p, '신규 구매 3,000,000원');
  const rcv = p.locator('xpath=//label[starts-with(normalize-space(.),"실제 수납액")]//input');
  await click(p, '카드', 0); await rcv.fill('1000000'); await p.waitForTimeout(300);
  await click(p, '동의서 미리보기 · 서명'); await click(p, '임시 저장');
  await p.goto(URL); await p.waitForTimeout(1500);
  await click(p, '이어서 작성'); await rcv.fill('3000000'); await p.waitForTimeout(300);
  await click(p, '동의서 미리보기 · 서명'); await p.getByText(/위 환불 규정/).last().click(); await sign(p);
  const draftsBefore = await lsJ(p, 'dachaeum.v3.newDrafts');
  assert.equal(draftsBefore.length, 1);
  const sigShown = () => p.locator('img[src^="data:image/png"]').count();
  for (const keys of [['dachaeum.v3.contracts'], ['dachaeum.v3.docs']]) {
    await failWrites(p, keys);
    await p.getByText('동의하고 저장', { exact: true }).last().dblclick(); await p.waitForTimeout(700);
    assert.deepEqual(await lsJ(p, 'dachaeum.v3.newDrafts'), draftsBefore, keys[0] + ' 실패 → 임시 저장본 유지');
    assert.deepEqual(await contracts(p), [], keys[0] + ' 실패 → 계약 저장 안 됨(문서 실패 시 계약 기록도 되돌림)');
    assert.deepEqual(await docs(p), []);
    const b = await body(p);
    assert.match(b, /동의하고 저장/, '서명 화면 유지 (완료로 넘어가지 않음)');
    assert.doesNotMatch(b, /등록완료/);
    assert.ok(await sigShown() > 0, '서명 유지');
    assert.match(b, SAVE_FAIL, keys[0] + ' 실패 안내');
  }
  // 저장 공간 확보 후 다시 저장 → 1건씩
  await failWrites(p, []);
  await p.getByText('동의하고 저장', { exact: true }).last().dblclick(); await p.waitForTimeout(800);
  const cs = await contracts(p), ds = await docs(p);
  assert.equal(cs.length, 1, '중복 계약 없음'); assert.equal(ds.length, 1, '중복 문서 없음');
  assert.deepEqual([ds[0].contractId, ds[0].version, ds[0].kind], [cs[0].id, 1, '이용동의서']);
  assert.deepEqual([cs[0].total, cs[0].paid, cs[0].prepaid.received, cs[0].prepaid.balAfter], [891000, 891000, 3000000, 2109000]);
  assert.deepEqual(await lsJ(p, 'dachaeum.v3.newDrafts'), [], '저장 확인 후 임시 저장 정리');
  await p.goto(URL); await p.waitForTimeout(1500);
  const b = await body(p);
  assert.doesNotMatch(b, /이어서 작성/); assert.equal((b.match(/저장실패테스트/g) || []).length, 1);
  assert.deepEqual(p.errors, []);
});

test('환불 정산서 저장 실패: 등록완료·작성 중 정산·서명 유지, 문서 없음 → 다시 저장하면 환불완료·정산서 1건', async () => {
  const p = await open([mk('CT1', '프로그램 A')]);
  await click(p, '프로그램 A'); await click(p, '환불 정산');
  await p.getByText('+', { exact: true }).nth(0).click(); await p.waitForTimeout(200);
  await allocInputs(p).nth(0).fill('400000'); await allocInputs(p).nth(1).fill('300000'); await p.waitForTimeout(400);
  await click(p, '정산서 생성 · 환자 서명'); await sign(p);
  for (const keys of [['dachaeum.v3.docs'], ['dachaeum.v3.contracts']]) {
    await failWrites(p, keys);
    await p.getByText('서명 완료 · 저장', { exact: true }).last().dblclick(); await p.waitForTimeout(700);
    const [c] = await contracts(p);
    assert.ok(!c.refund && !c.refunded && (c.status || '등록완료') === '등록완료', keys[0] + ' 실패 → 환불완료 아님');
    assert.ok(c.refundDraft && c.refundDraft.alloc, '작성 중 정산 유지');
    assert.deepEqual(await docs(p), [], keys[0] + ' 실패 → 정산서만 남지 않음');
    const b = await body(p);
    assert.match(b, /서명 완료 · 저장/, '정산서 서명 화면 유지');
    assert.match(b, SAVE_FAIL);
  }
  await failWrites(p, []);
  await p.getByText('서명 완료 · 저장', { exact: true }).last().dblclick(); await p.waitForTimeout(800);
  const [c] = await contracts(p);
  assert.equal(c.status, '환불완료'); assert.equal(c.refund.refundNum, 700000); assert.equal(c.refundDraft, null);
  const ds = await docs(p);
  assert.equal(ds.length, 1); assert.deepEqual([ds[0].kind, ds[0].contractId, ds[0].version], ['환불정산서', 'CT1', 1]);
  assert.deepEqual(p.errors, []);
});

test('다른 탭 이벤트 설정 변경: 열려 있는 앱에 이름·할인율·적용 프로그램·사용 여부 반영, 저장된 계약·서명 문서 불변', async () => {
  const eo = { events: {}, added: [{ id: 'EV-R-T', kind: 'rate', name: '가을 이벤트', rate: 0.1, start: '', end: '', active: true, programs: ['PGM-0001'] }], at: '2026-10-02 10:00' };
  const oldDoc = { id: 'D-OLD', contractId: 'C-EV', kind: '이용동의서', version: 1, signedAt: '2026-10-01', html: '<div>가을 이벤트 10% 1,188,000원 서명 문서</div>' };
  const old = mk('C-EV', '스페셜 토닝 1', { cat: '색소', total: 1188000, paid: 1188000, disc: { kind: 'ev:EV-R-T', label: '가을 이벤트 10%', rate: 0.1, eventId: 'EV-R-T' } });
  const p = await open([old], { storage: { 'dachaeum.eventOverride': JSON.stringify(eo), 'dachaeum.v3.docs': JSON.stringify([oldDoc]) } });
  const saved = () => p.evaluate(() => [localStorage.getItem('dachaeum.v3.contracts'), localStorage.getItem('dachaeum.v3.docs')]);
  const before = await saved();
  await toStep3(p, 'PGM-0001', '스페셜 토닝 1');
  await click(p, '가을 이벤트 10%');
  assert.match(await body(p), /최종 계약금액 1,188,000원/);
  // 다른 탭 (같은 기기)
  const other = await p.context().newPage(); other.errors = []; other.on('pageerror', e => other.errors.push(e.message));
  await other.goto(URL); await other.waitForTimeout(1500);
  const change = (patch, at) => other.evaluate(([patch, at]) => { const CT = window.DachaeumCatalog;
    localStorage.setItem(CT.EVENT_KEY, JSON.stringify(CT.setEvent(CT.readEvents(), 'EV-R-T', patch, at))); }, [patch, at]);
  await change({ name: '겨울 이벤트', rate: 0.2 }, '2026-10-02 11:00'); await p.waitForTimeout(500);
  let b = await body(p);
  assert.match(b, /겨울 이벤트 20%/, '이름·할인율 반영'); assert.doesNotMatch(b, /가을 이벤트/);
  assert.match(b, /최종 계약금액 1,056,000원/, '선택한 이벤트의 새 할인율로 계산');
  await change({ name: '겨울 이벤트!', rate: 0.2 }, '2026-10-02 11:00'); await p.waitForTimeout(500);
  assert.match(await body(p), /겨울 이벤트! 20%/, '같은 시각·비슷한 길이의 변경도 반영');
  await change({ programs: ['PGM-0002'] }, '2026-10-02 11:01'); await p.waitForTimeout(500);
  b = await body(p);
  assert.doesNotMatch(b, /겨울 이벤트/, '적용 프로그램에서 빠지면 할인 항목에서 사라짐');
  assert.match(b, /최종 계약금액 1,320,000원/, '선택했던 이벤트 할인 해제');
  await change({ programs: ['PGM-0001'] }, '2026-10-02 11:02'); await p.waitForTimeout(500);
  assert.match(await body(p), /겨울 이벤트! 20%/);
  await change({ active: false }, '2026-10-02 11:03'); await p.waitForTimeout(500);
  assert.doesNotMatch(await body(p), /겨울 이벤트/, '사용 안 함 반영');
  assert.deepEqual(await saved(), before, '저장된 계약·서명 문서 불변');
  await p.goto(URL); await p.waitForTimeout(1500);
  await click(p, '스페셜 토닝 1');
  b = await body(p);
  assert.match(b, /1,188,000/, '기존 계약 금액 유지');
  assert.deepEqual(p.errors.concat(other.errors), []);
});

// ---- iPad 세로 화면 전체 흐름: 화면 금액 = 저장 계약 = 서명 문서 = 환불 정산, PDF A4 1장 ----
async function openPad(width = 810, height = 1080) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true, deviceScaleFactor: 2, acceptDownloads: true });
  const p = await ctx.newPage(); p.errors = []; p.on('pageerror', e => p.errors.push(e.message)); p.on('dialog', d => d.accept());
  await p.goto(URL); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(2000);
  return p;
}
const noHScroll = async (p, where) => assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), where + ': 가로 스크롤 없음');
const plain = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
// 문서 탭에서 n번째 문서 PDF 만들기 → 파일 저장 → A4 세로 1장 확인
async function pdfCheck(p, n, name) {
  const fs = require('node:fs');
  await p.getByText('PDF 보기', { exact: true }).nth(n).click();
  await p.getByText('PDF 저장·공유·인쇄', { exact: true }).waitFor({ timeout: 20000 });
  await noHScroll(p, name + ' PDF 화면');
  // PDF 화면을 연 동안 파일을 반복해서 다시 만드는 기존 동작(별도 보고) 때문에 준비된 순간에 누를 때까지 재시도
  let dl = null;
  for (let i = 0; i < 15 && !dl; i++) {
    await p.getByText('PDF 저장·공유·인쇄', { exact: true }).waitFor({ timeout: 20000 });
    [dl] = await Promise.all([p.waitForEvent('download', { timeout: 2500 }).catch(() => null), p.getByText(/^PDF (저장·공유·인쇄|만드는 중…)$/).click()]);
  }
  assert.ok(dl, name + ': PDF 파일 저장');
  const buf = fs.readFileSync(await dl.path()), txt = buf.toString('latin1');
  assert.equal(buf.slice(0, 5).toString(), '%PDF-', name + ': PDF 파일');
  assert.equal((txt.match(/\/Type\s*\/Page[^s]/g) || []).length, 1, name + ': 1장');
  assert.match(txt, /\/MediaBox\s*\[\s*0 0 595\.2\d+ 841\.8\d+\s*\]/, name + ': A4 세로');
  await p.locator('path[d="M15 18l-6-6 6-6"]').last().locator('xpath=ancestor::div[1]').click({ force: true }); await p.waitForTimeout(400);
  assert.doesNotMatch(await body(p), /PDF 저장·공유·인쇄|PDF 만드는 중/, name + ': PDF 화면 닫힘');
  return buf.length;
}
const signSave = async (p, label) => { await p.getByText(/위 환불 규정/).last().click(); await sign(p); await click(p, label); await p.waitForTimeout(800); };

test('iPad 세로 전체 흐름 ①: 기납부 예약금 + 예약금 결제 → 서명·저장·PDF → 시술 1회 이용 → 환불 정산(0원 하한) → 정산서 서명·PDF', async () => {
  const p = await openPad();
  await toStep3(p, 'PGM-0018', '여드름 8주 프로그램', '패드예약금');
  await noHScroll(p, '결제 단계');
  await p.locator('xpath=//*[text()="기납부 예약금"]/following-sibling::span//input').fill('50000');
  await click(p, '예약금 결제'); await click(p, '카드');
  const b = await body(p);
  assert.match(b, /예약금 목표 99,000원 중 이미 납부·사용 50,000원 → 오늘 추가 예약금 49,000원 · 남는 미수금 891,000원/);
  assert.match(b, /49,000원을 결제할게요/);
  await click(p, '동의서 미리보기 · 서명'); await noHScroll(p, '동의서 서명 화면');
  await signSave(p, '동의하고 저장');
  const [c] = await contracts(p);
  assert.deepEqual([c.total, c.paid, c.priorDep, c.pay], [990000, 99000, 50000, 'deposit']);
  assert.deepEqual(c.payments.map(x => [x.method, x.amount]), [['카드', 49000]]);
  const d0 = plain((await docs(p))[0].html);
  assert.match(d0, /990,000/); assert.match(d0, /예약금/);
  await pdfCheck(p, 0, '이용동의서');
  // 환불: 시술 1회 이용
  await p.goto(URL); await p.waitForTimeout(1500);
  await click(p, '패드예약금'); await click(p, '환불 정산'); await noHScroll(p, '환불 정산 화면');
  await p.getByText('+', { exact: true }).nth(0).click(); await p.waitForTimeout(300);
  const rb = await body(p);
  assert.equal(await finalRefund(p), '0', '실제 납부 99,000 − 위약금 99,000 − 이용금액 → 0원 하한');
  await click(p, '정산서 생성 · 환자 서명'); await noHScroll(p, '정산서 서명 화면');
  await sign(p); await p.getByText('서명 완료 · 저장', { exact: true }).last().click(); await p.waitForTimeout(800);
  const done = (await contracts(p))[0];
  assert.equal(done.status, '환불완료');
  assert.deepEqual([done.refund.paidEff, done.refund.penNum, done.refund.refundNum], [99000, 99000, 0]);
  assert.ok(done.refund.usedAmt > 0, '이용금액 기록');
  assert.deepEqual([done.total, done.paid, done.items.length], [c.total, c.paid, c.items.length], '원 계약 금액·항목 유지');
  const rd = (await docs(p)).find(x => x.kind === '환불정산서');
  assert.equal(rd.contractId, c.id);
  assert.match(plain(rd.html), /최종 환불금액 0 원/);
  await pdfCheck(p, 0, '환불정산서');
  await pdfCheck(p, 1, '이용동의서(환불 후)');
  assert.deepEqual(p.errors, []);
});

test('iPad 세로 전체 흐름 ②: 기존 잔액 + 신규 구매 부분 수납 → 임시 저장 → 새로고침 → 이어서 전액 수납 → 서명·PDF → 이용 1회 → 잔액 복원 환불 → 정산서·PDF', async () => {
  const p = await openPad();
  const balIn = p.locator('xpath=//*[text()="보유 선결제권 잔액 (직원 확인)"]/following-sibling::span//input');
  const rcv = p.locator('xpath=//label[starts-with(normalize-space(.),"실제 수납액")]//input');
  await toStep3(p, 'PGM-0018', '여드름 8주 프로그램', '패드선결제');
  await click(p, '선결제권'); await click(p, '300'); await balIn.fill('200000');
  await click(p, '신규 구매 3,000,000원'); await click(p, '현금', 0); await rcv.fill('1500000'); await p.waitForTimeout(300);
  let b = await body(p);
  assert.match(b, /구매 미수금 · 전액 수납 확인 필요\s*1,500,000원/);
  assert.match(b, /차감 후 남은 선결제권 잔액 \(예상\)\s*2,309,000원/);
  await click(p, '동의서 미리보기 · 서명');
  assert.doesNotMatch(await body(p), /터치하여 서명/, '부분 수납 → 서명 불가');
  await click(p, '임시 저장');
  await p.reload(); await p.waitForTimeout(2000);
  await click(p, '이어서 작성');
  assert.equal(await rcv.inputValue(), '1,500,000'); assert.equal(await balIn.inputValue(), '200,000');
  await rcv.fill('3000000'); await p.waitForTimeout(300);
  b = await body(p);
  for (const re of [/이 계약에 사용\s*200,000원/, /이 계약에 사용\s*691,000원/, /차감 후 남은 선결제권 잔액\s*2,309,000원/, /최종 계약금액 891,000원/, /추가 결제 필요금액\s*0원/]) assert.match(b, re);
  await click(p, '동의서 미리보기 · 서명'); await signSave(p, '동의하고 저장');
  const [c] = await contracts(p);
  assert.deepEqual([c.total, c.paid], [891000, 891000]);
  assert.deepEqual(c.prepaid, { tier: '300', balBefore: 200000, balUse: 200000, purchase: 3000000, received: 3000000, purchaseMethod: '현금', newUse: 691000, use: 891000, balAfter: 2309000 });
  assert.deepEqual(await lsJ(p, 'dachaeum.v3.newDrafts'), []);
  assert.equal((await docs(p)).length, 1);
  await pdfCheck(p, 0, '이용동의서');
  await p.goto(URL); await p.waitForTimeout(1500);
  await click(p, '패드선결제'); await click(p, '환불 정산');
  await p.getByText('+', { exact: true }).nth(0).click(); await p.waitForTimeout(300);
  const used = c.items[0].price, expect = Math.max(0, 891000 - 89100 - used);
  assert.equal(await finalRefund(p), expect.toLocaleString('en-US'), '891,000 − 89,100 − 1회 정상가');
  b = await body(p);
  assert.match(b, /선결제권 잔액 복원[\s\S]*?원결제 200,000원[\s\S]*?선결제권 잔액 복원[\s\S]*?원결제 691,000원/, '기존 잔액·신규 구매 사용분을 구분해 표시');
  assert.match(b, new RegExp(expect.toLocaleString('en-US') + '원이 더 배분되어야 합니다'), '자동 배분 없음');
  await allocInputs(p).nth(0).fill('250000'); await p.waitForTimeout(300);
  await click(p, '정산서 생성 · 환자 서명');
  assert.doesNotMatch(await body(p), /터치하여 서명/, '원결제 200,000 초과 차단');
  await allocInputs(p).nth(0).fill('200000'); await allocInputs(p).nth(1).fill(String(expect - 200000)); await p.waitForTimeout(300);
  await click(p, '정산서 생성 · 환자 서명');
  const st = (await body(p)).replace(/\s+/g, ' ');
  assert.match(st, new RegExp('= 최종 환불금액 ' + expect.toLocaleString('en-US') + '원'));
  await sign(p); await p.getByText('서명 완료 · 저장', { exact: true }).last().click(); await p.waitForTimeout(800);
  const done = (await contracts(p))[0];
  assert.deepEqual([done.refund.paidEff, done.refund.penNum, done.refund.usedAmt, done.refund.refundNum], [891000, 89100, used, expect]);
  assert.deepEqual(done.refund.pays.map(x => [x.method, x.prepaid, x.paid, x.refund]), [['선결제권 잔액 복원', true, 200000, 200000], ['선결제권 잔액 복원', true, 691000, expect - 200000]]);
  const restored = done.refund.pays.filter(x => x.prepaid).reduce((t, x) => t + x.refund, 0);
  assert.equal(restored, expect, '잔액 복원액 기록 = 최종 환불금액');
  assert.ok(done.refund.pays.every(x => x.refund <= x.paid), '결제수단별 원결제 초과 없음');
  const rt = plain((await docs(p)).find(x => x.kind === '환불정산서').html);
  assert.match(rt, new RegExp('최종 환불금액 ' + expect.toLocaleString('en-US') + ' 원'));
  await pdfCheck(p, 0, '환불정산서');
  assert.deepEqual(p.errors, []);
});

test('iPad 세로 전체 흐름 ③: 기납부 예약금 + 카드·현금 분할 완납 → 서명 → 이용 1회 → 결제수단별 반환 입력(초과 차단) → 정산서 저장 값 일치', async () => {
  const p = await openPad(768, 1024);
  await toStep3(p, 'PGM-0018', '여드름 8주 프로그램', '패드분할');
  await p.locator('xpath=//*[text()="기납부 예약금"]/following-sibling::span//input').fill('90000');
  await click(p, '카드'); await click(p, '현금');
  await p.locator('input[placeholder="금액"]').fill('500000'); await p.waitForTimeout(300);
  assert.match(await body(p), /900,000원을 결제할게요/);
  await noHScroll(p, '분할 결제 (768px)');
  await click(p, '동의서 미리보기 · 서명'); await signSave(p, '동의하고 저장');
  const [c] = await contracts(p);
  assert.deepEqual([c.total, c.paid, c.priorDep], [990000, 990000, 90000]);
  assert.deepEqual(c.payments.map(x => [x.method, x.amount]), [['카드', 500000], ['현금', 400000]]);
  await p.goto(URL); await p.waitForTimeout(1500);
  await click(p, '패드분할'); await click(p, '환불 정산');
  await p.getByText('+', { exact: true }).nth(0).click(); await p.waitForTimeout(300);
  const used = c.items[0].price, expect = 990000 - 99000 - used;
  assert.equal(await finalRefund(p), expect.toLocaleString('en-US'));
  await allocInputs(p).nth(0).fill('600000'); await p.waitForTimeout(300);
  await click(p, '정산서 생성 · 환자 서명');
  assert.match(await body(p), /원결제|초과/, '카드 원결제 500,000 초과 차단');
  assert.doesNotMatch(await body(p), /터치하여 서명/);
  await allocInputs(p).nth(0).fill('500000'); await allocInputs(p).nth(1).fill(String(expect - 500000)); await p.waitForTimeout(300);
  await click(p, '정산서 생성 · 환자 서명'); await sign(p);
  await p.getByText('서명 완료 · 저장', { exact: true }).last().click(); await p.waitForTimeout(800);
  const done = (await contracts(p))[0];
  assert.equal(done.refund.refundNum, expect);
  assert.deepEqual(done.refund.pays.map(x => [x.method, x.paid, x.refund]), [['카드', 500000, 500000], ['현금', 400000, expect - 500000], ['기납부 예약금', 90000, 0]]);
  const rt = plain((await docs(p)).find(x => x.kind === '환불정산서').html);
  assert.match(rt, new RegExp('최종 환불금액 ' + expect.toLocaleString('en-US') + ' 원'));
  await pdfCheck(p, 0, '환불정산서 (768px)');
  assert.deepEqual(p.errors, []);
});

test('혜택가 할인 규칙(신규 계약부터): 혜택가 상품에 지인 소개·재티켓팅·이벤트 선택지 없음, 정상가 상품은 이벤트 선택 가능, 가격 관리에서 혜택가에 이벤트 추가 차단, 기존 계약 불변', async () => {
  const eo = { events: {}, added: [{ id: 'EV-R-T', kind: 'rate', name: '가을 이벤트', rate: 0.2, start: '', end: '', active: true, programs: ['PGM-0085', 'PGM-0085B', 'PGM-SB-1D1'] }], at: '2026-10-02 10:00' };
  const old = mk('C-OLD-B', '인모드 FX 3회 (리프팅 적용가)', { total: 313500, paid: 313500, priorDep: 0, payments: [{ method: '카드', amount: 313500 }], method: '카드',
    disc: { kind: 'ref', label: '지인 소개 5%', rate: 0.05 }, items: [{ kind: '시술', name: '인모드 FX', qty: 3, price: 165000 }] });
  const oldDoc = { id: 'D-OLD-B', contractId: 'C-OLD-B', kind: '이용동의서', version: 1, signedAt: '2026-09-20', html: '<div>지인 소개 5% 313,500원 서명 문서</div>' };
  const p = await open([old], { storage: { 'dachaeum.eventOverride': JSON.stringify(eo), 'dachaeum.v3.docs': JSON.stringify([oldDoc]) } });
  const saved = () => p.evaluate(() => [localStorage.getItem('dachaeum.v3.contracts'), localStorage.getItem('dachaeum.v3.docs')]);
  const before = await saved();
  const pick = async (id, steps, stay) => {
    await click(p, '새 동의서 작성'); const ins = p.locator('input');
    await ins.nth(0).fill('혜택가테스트'); await ins.nth(1).fill('880101'); await ins.nth(2).fill('01011112222');
    await click(p, '다음 단계');
    if (id) { await click(p, '전체'); await p.locator('input[placeholder*="검색"]').fill(id); await p.waitForTimeout(300); } else await click(p, '스킨부스터');
    for (const t of steps) await click(p, t);
    if (!stay) await click(p, '다음 단계'); };
  for (const [id, steps, price] of [['PGM-0085B', ['3회'], '330,000'], ['PGM-SB-1D1', ['1회'], '550,000']]) {
    await p.goto(URL); await p.waitForTimeout(1500);
    await pick(id, steps);
    const b = await body(p);
    assert.doesNotMatch(b, /지인 소개 5%/, id + ': 지인 소개 선택 불가');
    assert.doesNotMatch(b, /재티켓팅 10%/, id + ': 재티켓팅 선택 불가');
    assert.doesNotMatch(b, /가을 이벤트/, id + ': 혜택가 + 이벤트 중복 불가');
    assert.match(b, /선결제권/);
    assert.match(b, new RegExp('최종 계약금액 ' + price + '원'), id + ': 혜택가 그대로');
    assert.match(b, /지인 소개·재티켓팅·이벤트 추가 할인 불가/);
  }
  // 정상가 상품: 직원이 이벤트를 선택하면 이벤트만 적용 (자동 적용 없음)
  await p.goto(URL); await p.waitForTimeout(1500);
  // 인모드 FX 3회 정상가 (PGM-0085): 정상가 묶음의 횟수 스테퍼(+)로 3회 선택
  await pick('PGM-0085', ['정상가'], true);
  for (let i = 0; i < 3 && !/선택 프로그램[\s\S]*인모드 FX 3회\s*440,000원/.test(await body(p)); i++) { await p.locator('path[d="M12 5v14M5 12h14"]').first().locator('xpath=ancestor::div[1]').click(); await p.waitForTimeout(300); }
  await click(p, '다음 단계');
  assert.match(await body(p), /최종 계약금액 440,000원/, '이벤트 자동 적용 없음');
  await click(p, '가을 이벤트 20%');
  assert.match(await body(p), /최종 계약금액 352,000원/);
  await click(p, '카드'); await signAndSave(p);
  const c = (await contracts(p)).find(x => x.id !== 'C-OLD-B');
  assert.deepEqual([c.total, c.disc.kind, c.disc.preTier, c.disc.label], [352000, 'ev:EV-R-T', null, '가을 이벤트 20%'], '이벤트 하나만');
  // 가격 관리: 혜택가 프로그램을 할인율 이벤트에 추가하지 못함
  await p.goto(URL); await p.waitForTimeout(1500);
  await pmOpen(p); await click(p, '이벤트');
  await p.locator('input[placeholder="프로그램 ID (예: PGM-0001)"]').first().fill('PGM-SB-2D1'); await click(p, '프로그램 추가');
  assert.match(await body(p), /리프팅 후 혜택가 프로그램에는 할인율 이벤트를 걸 수 없습니다/);
  await pmClose(p);
  // 기존 계약(지인 소개 5% · 313,500)은 그대로
  const after = await saved();
  assert.equal(after[0].includes('"C-OLD-B"') && JSON.stringify(JSON.parse(after[0]).find(x => x.id === 'C-OLD-B')), JSON.stringify(JSON.parse(before[0]).find(x => x.id === 'C-OLD-B')), '기존 계약 불변');
  assert.ok(JSON.parse(after[1]).some(d => d.id === 'D-OLD-B' && d.html === oldDoc.html), '기존 서명 문서 불변');
  await click(p, '인모드 FX 3회 (리프팅 적용가)'); await click(p, '환불 정산');
  assert.equal(await finalRefund(p), '282,150', '기존 계약 금액(313,500) 기준 환불 그대로');
  assert.deepEqual(p.errors, []);
});

test('서명 문서 고정: 서명 → PDF → 프로그램명·총 등록금액·1회 정상가·이벤트 변경 → 다시 열어도 처음 서명 내용 그대로, 여러 번 열어도 PDF 재생성·버전·상태 변경 없음 / 환불 정산서도 동일', async () => {
  const fs = require('node:fs');
  const p = await openPad();
  const h2c = () => p.evaluate(() => window.__h2c || 0);
  const countPdf = () => p.evaluate(() => { if (window.__h2cWrapped) return; window.__h2cWrapped = true; const o = window.html2canvas; window.__h2c = 0;
    window.html2canvas = (...a) => { window.__h2c++; return o(...a); }; });
  const snap = () => p.evaluate(() => [localStorage.getItem('dachaeum.v3.contracts'), localStorage.getItem('dachaeum.v3.docs')]);
  const pdfvText = () => p.evaluate(() => (document.getElementById('pdfv') || {}).innerText || '');
  const back = async () => { await p.locator('path[d="M15 18l-6-6 6-6"]').last().locator('xpath=ancestor::div[1]').click({ force: true }); await p.waitForTimeout(400); };
  const openDoc = async (n) => { await p.getByText('PDF 보기', { exact: true }).nth(n).click(); await p.getByText('PDF 저장·공유·인쇄', { exact: true }).waitFor({ timeout: 20000 }); };
  const savePdf = async () => { const [dl] = await Promise.all([p.waitForEvent('download'), p.getByText('PDF 저장·공유·인쇄', { exact: true }).click()]); return fs.readFileSync(await dl.path()); };
  const toDocs = async () => { await p.goto(URL); await p.waitForTimeout(1800); await countPdf(); await click(p, '문서고정'); await click(p, '문서'); };
  const changeSettings = (tag) => p.evaluate(tag => { const CT = window.DachaeumCatalog;
    localStorage.setItem(CT.OV_KEY, JSON.stringify(CT.setProgramTotal(CT.setProgramField(CT.readOverride(), 'PGM-0001', 'name', '스페셜 토닝 변경' + tag, 'x'), 'PGM-0001', 1500000 + tag * 1000, 'x')));
    localStorage.setItem(CT.UNIT_KEY, JSON.stringify(CT.setProcUnit(CT.readUnits(), 'pig-revlite', 250000 + tag * 1000, 'x')));
    localStorage.setItem(CT.EVENT_KEY, JSON.stringify(CT.addRateEvent(CT.readEvents(), { id: 'EV-R-' + tag, name: '변경 이벤트' + tag, rate: 0.3, start: '', end: '', active: true, programs: ['PGM-0001'] }, 'x'))); }, tag);
  // 1) 계약 생성·서명 2) 문서·PDF 저장
  await toStep3(p, 'PGM-0001', '스페셜 토닝 1', '문서고정'); await click(p, '카드');
  await click(p, '동의서 미리보기 · 서명'); await signSave(p, '동의하고 저장');
  await countPdf();
  const [c0] = await contracts(p), d0 = (await docs(p))[0];
  await openDoc(0); await p.waitForTimeout(4000);
  const signedText = await pdfvText();
  assert.match(signedText, /스페셜 토닝 1/); assert.match(signedText, /1,320,000/);
  assert.equal(await h2c(), 1, 'PDF 1번만 생성 (반복 생성 없음)');
  const pdf1 = await savePdf(); assert.equal(pdf1.slice(0, 5).toString(), '%PDF-');
  await back();
  for (let i = 0; i < 3; i++) { await openDoc(0); await p.waitForTimeout(800); await back(); }
  assert.equal(await h2c(), 1, '같은 문서를 다시 열면 만들어 둔 PDF 재사용');
  await openDoc(0); assert.ok((await savePdf()).equals(pdf1), '같은 PDF 파일'); await back();
  const base = await snap();
  // 3) 프로그램명·가격·1회 정상가·이벤트 변경 → 4) 다시 열기
  await changeSettings(1);
  await toDocs();
  for (let i = 0; i < 3; i++) { await openDoc(0); await p.waitForTimeout(i ? 800 : 4000); assert.equal(await pdfvText(), signedText, '5) 처음 서명 내용 그대로'); await back(); }
  assert.equal(await h2c(), 1, '새로 연 뒤에도 문서당 1번만 생성');
  const t = await pdfvText();
  assert.deepEqual(await snap(), base, '6) 조회만으로 계약·문서(버전·저장 시각·상태) 변화 없음');
  assert.doesNotMatch(signedText, /스페셜 토닝 변경|변경 이벤트|1,501,000/);
  assert.deepEqual((await docs(p)).map(d => [d.id, d.version, d.signedAt]), [[d0.id, 1, d0.signedAt]]);
  assert.equal((await contracts(p))[0].status, '등록완료');
  // 7) 환불 정산서도 동일
  await p.goto(URL); await p.waitForTimeout(1500);
  await click(p, '문서고정'); await click(p, '환불 정산');
  await p.getByText('+', { exact: true }).nth(0).click(); await p.waitForTimeout(300);
  await click(p, '정산서 생성 · 환자 서명'); await sign(p);
  await p.getByText('서명 완료 · 저장', { exact: true }).last().click(); await p.waitForTimeout(800);
  const c1 = (await contracts(p))[0], rd = (await docs(p)).find(d => d.kind === '환불정산서');
  assert.equal(c1.status, '환불완료');
  assert.deepEqual([c1.total, c1.items.map(i => i.price)], [c0.total, c0.items.map(i => i.price)], '계약 금액·단가 불변');
  await countPdf();
  await openDoc(0); await p.waitForTimeout(4000);
  const refundText = await pdfvText();
  assert.match(refundText, new RegExp('최종 환불금액\\s*' + c1.refund.refundNum.toLocaleString('en-US')));
  const base2 = await snap();
  await changeSettings(2);
  await toDocs();
  for (let i = 0; i < 3; i++) { await openDoc(0); await p.waitForTimeout(i ? 800 : 4000); assert.equal(await pdfvText(), refundText, '정산서 처음 내용 그대로'); await back(); }
  await openDoc(1); await p.waitForTimeout(4000); assert.equal(await pdfvText(), signedText, '동의서도 그대로'); await back();
  assert.equal(await h2c(), 2, '문서 2개 → 각 1번씩만 생성');
  assert.deepEqual(await snap(), base2, '조회만으로 정산서·계약·환불 상태 변화 없음');
  assert.deepEqual((await docs(p)).map(d => [d.kind, d.version]), [['이용동의서', 1], ['환불정산서', 1]]);
  assert.deepEqual(p.errors, []);
});

// ---- iPad Safari 세로 화면 스크롤 (Safari 주소창·탭 막대만큼 보이는 높이가 1180보다 작음) ----
async function openSafariLike(h = 1047) {
  const ctx = await browser.newContext({ viewport: { width: 820, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage(); p.errors = []; p.on('pageerror', e => p.errors.push(e.message)); p.on('dialog', d => d.accept());
  await p.goto(URL); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(2000);
  p.cdp = await ctx.newCDPSession(p);
  return p;
}
// 손가락으로 위로 밀기 (실제 터치 이벤트)
const swipeUp = async (p, x, y, dy) => {
  await p.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let k = 1; k <= 10; k++) await p.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - dy * k / 10 }] });
  await p.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(250);
};
// 결제 단계 왼쪽 입력 영역: 끝까지 밀어 올린 뒤 마지막 내용이 화면 안에 보이는지, 잘린 카드가 없는지
const payPaneState = p => p.evaluate(() => {
  const lab = [...document.querySelectorAll('div')].find(d => d.textContent.trim() === '결제 방식');
  let pane = lab; while (pane && !(pane.style.width === '451px')) pane = pane.parentElement;
  if (!pane) return { missing: true, screen: document.body.innerText.slice(0, 200) };
  const vh = window.visualViewport ? visualViewport.height : innerHeight, last = pane.lastElementChild.getBoundingClientRect();
  const root = [...document.querySelectorAll('div')].find(d => d.style.maxWidth === '820px');
  const hit = document.elementFromPoint(220, Math.min(vh - 40, last.bottom - 5));
  return { clipped: [...pane.children].filter(c => c.scrollHeight > c.clientHeight + 1).length, atEnd: pane.scrollTop >= pane.scrollHeight - pane.clientHeight - 1,
    lastBottom: Math.round(last.bottom), vh: Math.round(vh), rootH: Math.round(root.getBoundingClientRect().height), docScroll: Math.round(scrollY),
    hitInPane: !!hit && pane.contains(hit), fixedOverlays: [...document.querySelectorAll('div')].filter(d => getComputedStyle(d).position === 'fixed' && d.id !== '__bundler_err' && d.getBoundingClientRect().height > 0).length };
});
const scrollPayToEnd = async p => { for (let i = 0; i < 6; i++) await swipeUp(p, 220, 700, 500); return payPaneState(p); };
const toPrepaidPay = async (p, who) => {
  await toStep3(p, 'PGM-0033', '얼굴전체', who);
  await click(p, '선결제권'); await click(p, '300'); await click(p, '신규 구매 3,000,000원'); await click(p, '카드', 0);
  await p.locator('xpath=//label[starts-with(normalize-space(.),"실제 수납액")]//input').fill('3000000'); await p.waitForTimeout(300);
};
const assertScrollable = (st, where) => {
  assert.ok(!st.missing, where + ': 결제 단계 화면 ' + JSON.stringify(st));
  assert.equal(st.clipped, 0, where + ': 잘린 카드 없음 (결제 방식 카드가 줄어들지 않음)');
  assert.ok(st.atEnd && st.lastBottom <= st.vh, where + ': 손가락 스크롤로 마지막 내용까지 보임 ' + JSON.stringify(st));
  assert.equal(st.rootH, st.vh, where + ': 앱 높이 = 실제 보이는 높이 (아래가 화면 밖으로 밀려나지 않음)');
  assert.ok(st.hitInPane, where + ': 투명 덮개 없이 입력 영역이 터치를 받음');
  assert.equal(st.fixedOverlays, 0, where + ': 닫힌 뒤 남은 고정 오버레이 없음');
};

test('iPad Safari 세로 결제 화면: 선결제권 신규 구매 3,000,000원 입력 후 끝까지 스크롤 · 키보드·가격 관리·미리보기 다녀와도 스크롤 유지', async () => {
  const p = await openSafariLike();
  // 가격 관리(목록 화면)를 열고 닫은 뒤 작성 시작
  await p.locator('[title="가격 관리"]').click(); await p.waitForTimeout(400);
  await p.getByText('닫기', { exact: true }).last().click(); await p.waitForTimeout(400);
  await toPrepaidPay(p, '스크롤테스트');
  assertScrollable(await scrollPayToEnd(p), '가격 관리 닫은 뒤 · 처음');
  // 키보드: 입력칸 선택 → 보이는 높이 축소 → 닫힘 (실제 키보드 대신 화면 높이 변화로 근사)
  const rcv = p.locator('xpath=//label[starts-with(normalize-space(.),"실제 수납액")]//input');
  await rcv.focus(); await p.setViewportSize({ width: 820, height: 700 }); await p.waitForTimeout(300);
  await rcv.evaluate(e => e.blur()); await p.setViewportSize({ width: 820, height: 1047 }); await p.waitForTimeout(400);
  assertScrollable(await scrollPayToEnd(p), '키보드 열고 닫은 뒤');
  assert.equal(await rcv.inputValue(), '3,000,000');
  // 동의서 미리보기 → 이전
  await click(p, '예약금 결제');
  await click(p, '동의서 미리보기 · 서명');
  assert.match(await body(p), /터치하여 서명/, '미리보기 화면으로 이동');
  await click(p, '직원');   // 서명 화면 → 직원 화면 복귀
  if (!/결제 방식/.test(await body(p))) await click(p, '이전');
  assertScrollable(await scrollPayToEnd(p), '미리보기 다녀온 뒤');
  assert.match(await body(p), /최종 계약금액 3,465,000원/);
  assert.deepEqual(p.errors, []);
});

test('공유 시트·홈 화면에 추가 전후 이벤트(blur·인쇄 미리보기·숨김·pagehide·pageshow·focus·크기 변경): 앱 오류 없음, 입력값 유지, 이후 서명·저장 정상', async () => {
  const p = await openSafariLike();
  await p.evaluate(() => { window.__errs = []; window.addEventListener('unhandledrejection', e => window.__errs.push(String(e.reason))); });
  await toPrepaidPay(p, '공유시트');
  const rcv = p.locator('xpath=//label[starts-with(normalize-space(.),"실제 수납액")]//input');
  const setVis = v => p.evaluate(v => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => v === 'hidden' });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v }); document.dispatchEvent(new Event('visibilitychange')); }, v);
  for (let round = 0; round < 2; round++) {   // 공유 시트 열기 → 취소, 다시 열기 → 홈 화면에 추가 진행
    await p.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('beforeprint')); });
    await p.emulateMedia({ media: 'print' }); await p.pdf(); await p.emulateMedia({ media: 'screen' });
    await p.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await setVis('hidden'); await p.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await p.setViewportSize({ width: 820, height: 980 }); await p.waitForTimeout(200); await p.setViewportSize({ width: 820, height: 1047 });
    await setVis('visible'); await p.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); window.dispatchEvent(new Event('focus')); });
    await p.waitForTimeout(600);
    assert.equal(await rcv.inputValue(), '3,000,000', '입력값 유지');
    assert.equal(await p.evaluate(() => (document.getElementById('__bundler_err') || {}).textContent || ''), '', '오류 표시 없음');
    assertScrollable(await scrollPayToEnd(p), '공유 시트 다녀온 뒤 ' + round);
  }
  assert.deepEqual(await p.evaluate(() => window.__errs), []);
  assert.equal(await p.evaluate(() => !!document.getElementById('dc-debug')), false, '#debug 없으면 진단 기록 표시 안 함');
  // 이후 서명·저장 정상, 금액 그대로 (추가 예약금 0원 · 미수금 465,000원)
  await click(p, '예약금 결제'); await signAndSave(p);
  const [c] = await contracts(p);
  assert.deepEqual([c.total, c.paid, c.prepaid.received, c.prepaid.newUse], [3465000, 3000000, 3000000, 3000000]);
  assert.equal((await docs(p)).length, 1);
  assert.deepEqual(p.errors, []);
});
