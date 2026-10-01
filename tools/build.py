#!/usr/bin/env python3
"""src/·data/ → index.html. 바뀐 파일만 번들에 다시 넣으므로, 수정이 없으면 결과가 바이트 단위로 같음."""
import json, re, base64, gzip, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unpack import ROOT, FILES, APP_MARK, read_bundle, entry_bytes, split_template

def enc(o):
    return json.dumps(o, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')

if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'index.html')
    s, man, tpl = read_bundle(os.path.join(ROOT, 'index.html'))
    markup = open(os.path.join(ROOT, 'src/markup.html'), encoding='utf-8').read()
    app = open(os.path.join(ROOT, 'src/app.dc.js'), encoding='utf-8').read()
    assert markup.count(APP_MARK) == 1
    new_tpl = markup.replace(APP_MARK, app)
    for path, uuid in FILES.items():
        b = open(os.path.join(ROOT, path), 'rb').read()
        if b != entry_bytes(man[uuid]):
            man[uuid]['data'] = base64.b64encode(gzip.compress(b, mtime=0)).decode(); man[uuid]['compressed'] = True
    if new_tpl != tpl:
        s = re.sub(r'(<script type="__bundler/template">\n)(.*?)(\n  </script>)', lambda m: m.group(1) + enc(new_tpl) + m.group(3), s, count=1, flags=re.S)
    s = re.sub(r'(<script type="__bundler/manifest">\n)(.*?)(\n  </script>)', lambda m: m.group(1) + enc(man) + m.group(3), s, count=1, flags=re.S)
    open(out, 'w', encoding='utf-8').write(s)
    print('built', out)
