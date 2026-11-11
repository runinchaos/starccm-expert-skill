# -*- coding: utf-8 -*-
"""STAR WebHelp (oxygen) HTML + MathML -> Markdown + LaTeX (MathJax) 直转器"""
import re, sys, html as htmlmod
from html.parser import HTMLParser

OPMAP = {'˙': '', '⁢': '', '⁡': '', '−': '-', '×': r'\times ', '⋅': r'\cdot ', '≤': r'\le ', '≥': r'\ge ',
         '≠': r'\ne ', '≈': r'\approx ', '∞': r'\infty ', '±': r'\pm ',
         '…': r'\ldots ', '→': r'\rightarrow ', '∑': r'\sum ', '¯': ''}

def tex_escape(s):
    return s.replace('\\', r'\backslash ').replace('&', r'\& ').replace('%', r'\% ')

# ---------- MathML -> LaTeX ----------
class MathML:
    def __init__(self, root):
        self.root = root  # (tag, attrs, children) 树
    def latex(self):
        return self._n(self.root).strip()

    def _n(self, node):
        if isinstance(node, str):
            return '' if not node.strip() else self._txt(node)
        tag, attrs, kids = node
        f = getattr(self, '_' + tag, None)
        if f: return f(attrs, kids)
        return ''.join(self._n(k) for k in kids)

    def _txt(self, s):
        s = htmlmod.unescape(s)
        for k, v in OPMAP.items(): s = s.replace(k, v)
        return s.replace('%', r'\%')

    def _math(self, a, k):  return ''.join(self._n(x) for x in k)
    def _mrow(self, a, k):  return ''.join(self._n(x) for x in k)
    def _mstyle(self, a, k):return ''.join(self._n(x) for x in k)
    def _mi(self, a, k):
        t = ''.join(self._txt(x) if isinstance(x, str) else self._n(x) for x in k).strip()
        if not t: return ''
        if len(t) > 1 or t in ('∆','Δ'): return r'\mathrm{%s}' % t.replace('∆', r'\Delta ')
        return t
    def _mn(self, a, k):    return ''.join(self._txt(x) for x in k)
    def _mo(self, a, k):
        t = ''.join(self._txt(x) for x in k)
        return {'(':'\\left(', ')':'\\right)', '[':'\\left[', ']':'\\right]',
                '{': '\\{', '}': '\\}'}.get(t, t)
    def _mtext(self, a, k):
        t = ''.join(self._txt(x) if isinstance(x, str) else '' for x in k)
        t = re.sub(r'\s+', ' ', t).strip()
        return '' if not t else r'\text{%s}' % t.replace(' ', r'\; ')
    def _els(self, k):
        return [x for x in k if not (isinstance(x, str) and not x.strip())]

    def _mfrac(self, a, k):
        e = self._els(k)
        num = self._n(e[0]).strip(); den = self._n(e[1]).strip()
        return r'\frac{%s}{%s}' % (num, den)
    def _msqrt(self, a, k):
        return r'\sqrt{%s}' % ''.join(self._n(x) for x in k).strip()
    def _msub(self, a, k):
        e = self._els(k)
        return '{%s}_{%s}' % (self._n(e[0]).strip(), self._n(e[1]).strip())
    def _msup(self, a, k):
        e = self._els(k)
        return '{%s}^{%s}' % (self._n(e[0]).strip(), self._n(e[1]).strip())
    def _msubsup(self, a, k):
        e = self._els(k)
        return '{%s}_{%s}^{%s}' % (self._n(e[0]).strip(), self._n(e[1]).strip(), self._n(e[2]).strip())
    def _mover(self, a, k):
        e = self._els(k)
        base = self._n(e[0]).strip(); over = self._n(e[1]).strip() if len(e) > 1 else ''
        if over in ('¯', '-', '‾'): return r'\bar{%s}' % base
        if over in ('→',): return r'\vec{%s}' % base
        if over in ('^',): return r'\hat{%s}' % base
        if over in ('˙', '.'): return r'\dot{%s}' % base
        if not over: return base
        return r'\overset{%s}{%s}' % (over, base)
    def _mspace(self, a, k):
        if dict(a).get('linebreak') == 'newline': return r' \\ '
        return ' '
    def _mtable(self, a, k):
        rows = []
        for r in self._els(k):
            cells = [self._n(c).strip() for c in self._els(r[2])]
            rows.append(' & '.join(cells))
        return r'\begin{array}{l}' + r' \\ '.join(rows) + r'\end{array}'
    def _mtr(self, a, k):  return ''.join(self._n(x) for x in k)
    def _mtd(self, a, k):  return ''.join(self._n(x) for x in k)
    def _semantics(self, a, k): return ''.join(self._n(x) for x in k if not isinstance(x, str) and x[0] != 'annotation')
    def _annotation(self, a, k): return ''

# ---------- HTML 结构化 ----------
SKIP = {'script', 'style', 'nav', 'header', 'footer'}
class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []          # markdown 行流
        self.buf = []          # 当前文本/内联片段
        self.stack = []
        self.list_depth = 0
        self.list_type = []
        self.in_math = 0
        self.math_root = None  # (tag, attrs, kids)
        self.mstack = []
        self.table_rows = None
        self.table_row = None
        self.display = 'inline'
    def flush(self):
        t = re.sub(r'\s+', ' ', ''.join(self.buf)).strip()
        if t: self.out.append(('p', t))
        self.buf = []
    def emit_inline(self, s):
        self.buf.append(s)
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in SKIP: self.stack.append((tag, True)); return
        self.stack.append((tag, False))
        if tag == 'math':
            self.in_math += 1
            if self.in_math == 1:
                self.flush() if a.get('display') == 'block' else None
                self.display = a.get('display', 'inline')
                self.math_root = ('math', attrs, []); self.mstack = [self.math_root]
            return
        if self.in_math:
            if not tag.startswith('m'): return
            node = (tag, attrs, []); self.mstack[-1][2].append(node); self.mstack.append(node)
            return
        if tag in ('h1','h2','h3','h4'):
            self.flush(); self.out.append((tag, '')); self.buf = []
        elif tag in ('p','div','li','tr','figcaption'):
            if self.table_row is None and tag != 'tr': self.flush()
        elif tag == 'ul' or tag == 'ol':
            self.list_depth += 1; self.list_type.append('1.' if tag=='ol' else '-')
        elif tag == 'li':
            self.flush(); self.buf = [self.list_type[-1] + ' ']
        elif tag == 'table':
            self.flush(); self.table_rows = []
        elif tag == 'tr':
            self.table_row = []
        elif tag == 'td' or tag == 'th':
            pass
        elif tag == 'br':
            self.buf.append('\n')
        elif tag == 'img':
            self.buf.append('![%s](%s)' % (a.get('alt',''), a.get('src','')))
    def handle_endtag(self, tag):
        if self.stack and self.stack[-1][0] == tag: self.stack.pop()
        if tag == 'math' and self.in_math:
            self.in_math -= 1
            if self.in_math == 0:
                tex = MathML(self.math_root).latex()
                tex = re.sub(r'\s+', ' ', tex).strip()
                if self.display == 'block':
                    self.out.append(('math', '$$%s$$' % tex))
                else:
                    self.buf.append('$%s$' % tex)
                self.math_root = None; self.mstack = []
            return
        if self.in_math:
            if self.mstack and self.mstack[-1][0] == tag: self.mstack.pop()
            return
        if tag in ('h1','h2','h3','h4'):
            t = re.sub(r'\s+',' ',''.join(self.buf)).strip()
            self.out[-1] = (self.out[-1][0], t); self.buf = []
        elif tag == 'li':
            t = re.sub(r'\s+',' ',''.join(self.buf)).strip()
            if t: self.out.append(('li%d' % max(1,self.list_depth), t))
            self.buf = []
        elif tag in ('ul','ol'):
            self.list_depth = max(0, self.list_depth - 1)
            if self.list_type: self.list_type.pop()
        elif tag == 'tr' and self.table_row is not None:
            self.table_rows.append(self.table_row); self.table_row = None
        elif tag in ('td','th'):
            pass
        elif tag == 'table' and self.table_rows is not None:
            rows = self.table_rows; self.table_rows = None
            if rows:
                self.out.append(('table', rows))
        elif tag in ('p','div'):
            self.flush()
    def handle_data(self, data):
        if self.in_math:
            if self.mstack: self.mstack[-1][2].append(data)
            return
        self.buf.append(data)

NOISE = re.compile(r'^(Figure \d+\. EQUATION_DISPLAY|Share|Email|Link: copied|Breadcrumb: copied|Copy|Search|Home|User Guide|Jump to main content|\s*!\[\]\(.*\)\s*)$')

def extract(path):
    raw = open(path, encoding='utf-8', errors='replace').read()
    m = re.search(r'<main role="main">', raw)
    if m:
        e = re.search(r'</main>', raw[m.start():])
        raw = raw[m.start():m.start() + e.start()] if e else raw[m.start():]
    p = Page()
    p.feed(raw)
    p.flush()
    return p.out

def render(blocks):
    lines = []
    for kind, val in blocks:
        if kind in ('h1','h2','h3','h4'):
            lines.append('#' * int(kind[1]) + ' ' + val); lines.append('')
        elif kind == 'math':
            lines.append(val); lines.append('')
        elif kind.startswith('li'):
            lines.append('  ' * (int(kind[2:]) - 1) + '- ' + val)
        elif kind == 'table':
            md = ['| ' + ' | '.join(c) + ' |', '|' + '---|' * len(val[0])]
            for r in val[1:]: md.append('| ' + ' | '.join(r) + ' |')
            lines += md; lines.append('')
        else:
            v = val.strip()
            if not v or NOISE.match(v): continue
            if re.match(r'^!\[\]\(', v): continue
            lines.append(v); lines.append('')
    return '\n'.join(lines)

if __name__ == '__main__':
    print(render(extract(sys.argv[1])))
