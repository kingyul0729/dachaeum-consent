#!/usr/bin/env python3
"""index.html(번들) → src/·data/ 원본 추출. 라이브러리(React·html2canvas·jsPDF 등)는 번들에 그대로 둠."""
import json, re, base64, gzip, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = json.load(open(os.path.join(ROOT, 'tools', 'files.json')))
APP_MARK = '/*@@APP@@*/'

def read_bundle(path):
    s = open(path, encoding='utf-8').read()
    man = json.loads(re.search(r'<script type="__bundler/manifest">\n(.*?)\n  </script>', s, re.S).group(1))
    tpl = json.loads(re.search(r'<script type="__bundler/template">\n(.*?)\n  </script>', s, re.S).group(1))
    return s, man, tpl

def entry_bytes(e):
    d = base64.b64decode(e['data'])
    return gzip.decompress(d) if e['compressed'] else d

def split_template(tpl):
    m = list(re.finditer(r'(<script type="text/x-dc"[^>]*>)(.*?)(</script>)', tpl, re.S))
    assert len(m) == 1
    return tpl[:m[0].start(2)] + APP_MARK + tpl[m[0].end(2):], m[0].group(2)

if __name__ == '__main__':
    _, man, tpl = read_bundle(os.path.join(ROOT, 'index.html'))
    markup, app = split_template(tpl)
    open(os.path.join(ROOT, 'src/markup.html'), 'w', encoding='utf-8').write(markup)
    open(os.path.join(ROOT, 'src/app.dc.js'), 'w', encoding='utf-8').write(app)
    for path, uuid in FILES.items():
        open(os.path.join(ROOT, path), 'wb').write(entry_bytes(man[uuid]))
    print('unpacked')
