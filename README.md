# 다채움피부과 동의서

이용동의서·환불동의서 작성 앱(v3)입니다. 환자 목록, 새 동의서 작성, 프로그램 가격표와 환불 계산이 들어 있습니다.

## 사용

`index.html`을 더블클릭해 브라우저로 바로 열면 됩니다. 설치할 것은 없습니다.

한 파일 안에 모든 화면과 데이터가 들어 있는 단일 파일 번들입니다. 인터넷이 없으면 일부 글꼴이 다르게 보일 수 있습니다.

## 개발

`index.html`은 아래 원본을 하나로 묶은 파일입니다. 수정은 원본에서 하고 다시 묶습니다.

```
src/app.dc.js        화면 로직
src/markup.html      화면 마크업
src/refund.js        환불 계산·검증 (위약금 · 이용금액 · 결제수단별 환불)
src/pricing.js       금액·할인·선결제권·결제 계산
src/catalog.js       서비스 후보 · 가격 관리 연동
data/programs.json   가격표
tools/build.py       원본 → index.html   (npm run build)
tools/unpack.py      index.html → 원본   (npm run unpack)
test/                자동 테스트          (npm test)
```

테스트: `npm install` 후 `npm test` (환불 계산 단위 테스트 + 브라우저 화면 흐름 테스트).
