"""Pine Script (v4–v6 subset) lexer and parser.

Covers what TradingView's built-in strategy templates use: indentation blocks (a tab = 4 spaces),
continuation lines (indented by a non-multiple of 4), `//` comments, `var`/`varip`, typed declarations,
`=`/`:=`/`+=`…, tuple declarations, user functions (`f(a, b) =>` single line or block), `if / else if /
else`, `for … to … by`, ternaries, `and/or/not`, history `x[n]`, calls with named arguments and dotted
names (`ta.ema`, `strategy.entry`). Every node gets a unique `id` (call sites key per-call state).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from itertools import count

KEYWORDS = {"if", "else", "for", "to", "by", "while", "var", "varip", "and", "or", "not", "true", "false",
            "import", "export", "switch", "break", "continue"}
TYPES = {"float", "int", "bool", "string", "color", "line", "label", "box", "table", "array", "matrix", "map"}
TOKEN_RE = re.compile(r"""
    (?P<num>\d+\.\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?|\d+(?:[eE][-+]?\d+)?)
  | (?P<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')
  | (?P<color>\#[0-9a-fA-F]{6,8})
  | (?P<name>[A-Za-z_][A-Za-z_0-9]*)
  | (?P<op>:=|=>|==|!=|<=|>=|\+=|-=|\*=|/=|%=|[-+*/%<>=?:,()\[\].])
  | (?P<ws>[ \t]+)
""", re.VERBOSE)


class PineSyntaxError(SyntaxError):
    pass


@dataclass
class Tok:
    kind: str      # num str color name op kw NEWLINE INDENT DEDENT EOF
    value: object
    line: int


def tokenize(src: str) -> list[Tok]:
    lines = src.replace("\r\n", "\n").split("\n")
    # join continuation lines: indentation not a multiple of 4 continues the previous logical line
    logical: list[tuple[int, int, str]] = []          # (line_no, indent, text)
    for no, raw in enumerate(lines, 1):
        text = _strip_comment(raw).rstrip()
        if not text.strip():
            continue
        expanded = text.replace("\t", "    ")
        indent = len(expanded) - len(expanded.lstrip(" "))
        if logical and indent % 4 != 0:
            pl, pi, pt = logical[-1]
            logical[-1] = (pl, pi, pt + " " + expanded.strip())
            continue
        logical.append((no, indent, expanded.strip()))
    toks: list[Tok] = []
    stack = [0]
    for no, indent, text in logical:
        if indent > stack[-1]:
            stack.append(indent)
            toks.append(Tok("INDENT", None, no))
        while indent < stack[-1]:
            stack.pop()
            toks.append(Tok("DEDENT", None, no))
        if indent != stack[-1]:
            raise PineSyntaxError(f"line {no}: inconsistent indentation")
        pos = 0
        while pos < len(text):
            m = TOKEN_RE.match(text, pos)
            if not m:
                raise PineSyntaxError(f"line {no}: unexpected character {text[pos]!r}")
            pos = m.end()
            kind = m.lastgroup
            v = m.group(kind)
            if kind == "ws":
                continue
            if kind == "num":
                toks.append(Tok("num", float(v) if any(c in v for c in ".eE") else int(v), no))
            elif kind == "str":
                toks.append(Tok("str", bytes(v[1:-1], "utf-8").decode("unicode_escape"), no))
            elif kind == "name" and v in KEYWORDS:
                toks.append(Tok("kw", v, no))
            else:
                toks.append(Tok(kind, v, no))
        toks.append(Tok("NEWLINE", None, no))
    while len(stack) > 1:
        stack.pop()
        toks.append(Tok("DEDENT", None, len(lines)))
    toks.append(Tok("EOF", None, len(lines)))
    return toks


def _strip_comment(line: str) -> str:
    out, quote, i = [], None, 0
    while i < len(line):
        c = line[i]
        if quote:
            out.append(c)
            if c == "\\" and i + 1 < len(line):
                out.append(line[i + 1]); i += 2; continue
            if c == quote:
                quote = None
        elif c in "\"'":
            quote = c; out.append(c)
        elif line.startswith("//", i):
            break
        else:
            out.append(c)
        i += 1
    return "".join(out)


# ------------------------------------------------------------------------------------- AST
_ids = count(1)


@dataclass
class Node:
    id: int = field(default_factory=lambda: next(_ids), init=False, repr=False, compare=False)


@dataclass
class Num(Node):
    value: float


@dataclass
class Str(Node):
    value: str


@dataclass
class Bool(Node):
    value: bool


@dataclass
class Na(Node):
    pass


@dataclass
class Name(Node):
    name: str              # dotted names are joined: "ta.ema", "strategy.long"


@dataclass
class Index(Node):
    target: Node
    offset: Node


@dataclass
class Call(Node):
    func: str
    args: list
    kwargs: dict


@dataclass
class Unary(Node):
    op: str
    expr: Node


@dataclass
class BinOp(Node):
    op: str
    left: Node
    right: Node


@dataclass
class Ternary(Node):
    cond: Node
    then: Node
    other: Node


@dataclass
class IfExpr(Node):           # `if` as statement (and as expression: value of the executed branch)
    cond: Node
    body: list
    orelse: list


@dataclass
class For(Node):
    var: str
    start: Node
    end: Node
    step: Node | None
    body: list


@dataclass
class Decl(Node):
    name: str
    expr: Node
    mode: str               # "" | "var" | "varip"
    typ: str | None


@dataclass
class TupleDecl(Node):
    names: list
    expr: Node


@dataclass
class Assign(Node):
    name: str
    op: str                 # ":=" "+=" ...
    expr: Node


@dataclass
class FuncDef(Node):
    name: str
    params: list            # [(name, default Node|None)]
    body: list              # statements; value = last statement's value


@dataclass
class ExprStmt(Node):
    expr: Node


@dataclass
class Script(Node):
    body: list
    version: int


# ------------------------------------------------------------------------------------- parser
class Parser:
    def __init__(self, toks: list[Tok]):
        self.t = toks
        self.i = 0

    # token helpers
    def peek(self, k=0) -> Tok:
        return self.t[min(self.i + k, len(self.t) - 1)]

    def next(self) -> Tok:
        tok = self.t[self.i]
        self.i += 1
        return tok

    def at(self, kind, value=None, k=0) -> bool:
        tok = self.peek(k)
        return tok.kind == kind and (value is None or tok.value == value)

    def expect(self, kind, value=None) -> Tok:
        tok = self.next()
        if tok.kind != kind or (value is not None and tok.value != value):
            raise PineSyntaxError(f"line {tok.line}: expected {value or kind}, got {tok.value or tok.kind}")
        return tok

    def skip_newlines(self):
        while self.at("NEWLINE"):
            self.next()

    # statements
    def block(self) -> list:
        self.expect("NEWLINE")
        self.expect("INDENT")
        body = []
        while not self.at("DEDENT") and not self.at("EOF"):
            body.append(self.statement())
            self.skip_newlines()
        self.expect("DEDENT")
        return body

    def statement(self):
        if self.at("kw", "if"):
            return self.if_stmt()
        if self.at("kw", "for"):
            return self.for_stmt()
        if self.at("kw", "import"):
            line = self.peek().line
            raise PineSyntaxError(f"line {line}: `import` of libraries is not supported")
        # function definition: name ( params ) =>
        if self.at("name") and self.at("op", "(", 1) and self._is_funcdef():
            return self.funcdef()
        if self.at("op", "["):
            save = self.i
            names = self._try_tuple_names()
            if names is not None and self.at("op", "="):
                self.next()
                return TupleDecl(names, self.expression())
            self.i = save
        mode = ""
        if self.at("kw", "var") or self.at("kw", "varip"):
            mode = self.next().value
        typ = None
        if self.at("name") and self.peek().value in TYPES and self.at("name", None, 1):
            typ = self.next().value
            if self.at("op", "<"):                      # generic types like array<float>: skip
                depth = 0
                while True:
                    tok = self.next()
                    depth += tok.value == "<"
                    depth -= tok.value == ">"
                    if depth == 0:
                        break
        if self.at("name") and self.at("op", "=", 1):
            name = self.next().value
            self.next()
            return Decl(name, self.decl_value(), mode, typ)
        if mode or typ:
            raise PineSyntaxError(f"line {self.peek().line}: expected a declaration")
        if self.at("name") and self.peek(1).kind == "op" and self.peek(1).value in (":=", "+=", "-=", "*=", "/=", "%="):
            name = self.next().value
            op = self.next().value
            return Assign(name, op, self.decl_value())
        return ExprStmt(self.expression())

    def decl_value(self):
        if self.at("kw", "if"):
            return self.if_stmt()
        return self.expression()

    def _is_funcdef(self) -> bool:
        depth, k = 0, 1
        while True:
            tok = self.peek(k)
            if tok.kind in ("NEWLINE", "EOF"):
                return False
            if tok.kind == "op" and tok.value == "(":
                depth += 1
            elif tok.kind == "op" and tok.value == ")":
                depth -= 1
                if depth == 0:
                    return self.at("op", "=>", k + 1)
            k += 1

    def _try_tuple_names(self):
        self.next()
        names = []
        while True:
            if not self.at("name"):
                return None
            names.append(self.next().value)
            if self.at("op", ","):
                self.next(); continue
            if self.at("op", "]"):
                self.next(); return names
            return None

    def funcdef(self):
        name = self.next().value
        self.expect("op", "(")
        params = []
        while not self.at("op", ")"):
            if self.at("name") and self.peek().value in TYPES and self.at("name", None, 1):
                self.next()                                   # typed parameter
            if self.at("kw", "var") or self.at("kw", "varip"):
                self.next()
            pname = self.expect("name").value
            default = None
            if self.at("op", "="):
                self.next()
                default = self.expression()
            params.append((pname, default))
            if self.at("op", ","):
                self.next()
        self.expect("op", ")")
        self.expect("op", "=>")
        if self.at("NEWLINE"):
            body = self.block()
        else:
            body = [ExprStmt(self.expression())]
        return FuncDef(name, params, body)

    def if_stmt(self):
        self.expect("kw", "if")
        cond = self.expression()
        body = self.block()
        orelse = []
        self.skip_newlines_if_else()
        if self.at("kw", "else"):
            self.next()
            if self.at("kw", "if"):
                orelse = [self.if_stmt()]
            else:
                orelse = self.block()
        return IfExpr(cond, body, orelse)

    def skip_newlines_if_else(self):
        k = 0
        while self.at("NEWLINE", None, k):
            k += 1
        if self.at("kw", "else", k):
            self.i += k

    def for_stmt(self):
        self.expect("kw", "for")
        var = self.expect("name").value
        self.expect("op", "=")
        start = self.expression()
        self.expect("kw", "to")
        end = self.expression()
        step = None
        if self.at("kw", "by"):
            self.next()
            step = self.expression()
        return For(var, start, end, step, self.block())

    # expressions (lowest to highest precedence)
    def expression(self):
        return self.ternary()

    def ternary(self):
        cond = self.logic_or()
        if self.at("op", "?"):
            self.next()
            then = self.ternary()
            self.expect("op", ":")
            other = self.ternary()
            return Ternary(cond, then, other)
        return cond

    def logic_or(self):
        left = self.logic_and()
        while self.at("kw", "or"):
            self.next()
            left = BinOp("or", left, self.logic_and())
        return left

    def logic_and(self):
        left = self.equality()
        while self.at("kw", "and"):
            self.next()
            left = BinOp("and", left, self.equality())
        return left

    def equality(self):
        left = self.comparison()
        while self.at("op", "==") or self.at("op", "!="):
            op = self.next().value
            left = BinOp(op, left, self.comparison())
        return left

    def comparison(self):
        left = self.additive()
        while self.peek().kind == "op" and self.peek().value in ("<", ">", "<=", ">="):
            op = self.next().value
            left = BinOp(op, left, self.additive())
        return left

    def additive(self):
        left = self.term()
        while self.at("op", "+") or self.at("op", "-"):
            op = self.next().value
            left = BinOp(op, left, self.term())
        return left

    def term(self):
        left = self.unary()
        while self.peek().kind == "op" and self.peek().value in ("*", "/", "%"):
            op = self.next().value
            left = BinOp(op, left, self.unary())
        return left

    def unary(self):
        if self.at("op", "-") or self.at("op", "+"):
            op = self.next().value
            return Unary(op, self.unary())
        if self.at("kw", "not"):
            self.next()
            return Unary("not", self.unary())
        return self.postfix()

    def postfix(self):
        node = self.primary()
        while True:
            if self.at("op", "["):
                self.next()
                off = self.expression()
                self.expect("op", "]")
                node = Index(node, off)
            elif self.at("op", "(") and isinstance(node, Name):
                node = self.call(node.name)
            else:
                return node

    def call(self, func: str):
        self.expect("op", "(")
        args, kwargs = [], {}
        while not self.at("op", ")"):
            if self.at("name") and self.at("op", "=", 1):
                key = self.next().value
                self.next()
                kwargs[key] = self.expression()
            else:
                args.append(self.expression())
            if self.at("op", ","):
                self.next()
        self.expect("op", ")")
        return Call(func, args, kwargs)

    def primary(self):
        tok = self.next()
        if tok.kind == "num":
            return Num(tok.value)
        if tok.kind == "str":
            return Str(tok.value)
        if tok.kind == "color":
            return Str(tok.value)
        if tok.kind == "kw" and tok.value in ("true", "false"):
            return Bool(tok.value == "true")
        if tok.kind == "op" and tok.value == "(":
            e = self.expression()
            self.expect("op", ")")
            return e
        if tok.kind == "op" and tok.value == "[":            # tuple expression [a, b]
            items = []
            while not self.at("op", "]"):
                items.append(self.expression())
                if self.at("op", ","):
                    self.next()
            self.expect("op", "]")
            return Call("__tuple__", items, {})
        if tok.kind == "name":
            name = tok.value
            while self.at("op", ".") and self.at("name", None, 1):
                self.next()
                name += "." + self.next().value
            if name == "na" and not self.at("op", "("):
                return Na()
            return Name(name)
        if tok.kind == "kw" and tok.value == "if":
            self.i -= 1
            return self.if_stmt()
        raise PineSyntaxError(f"line {tok.line}: unexpected {tok.value or tok.kind}")


def parse(src: str) -> Script:
    m = re.search(r"//@version=(\d+)", src)
    version = int(m.group(1)) if m else 1
    p = Parser(tokenize(src))
    body = []
    p.skip_newlines()
    while not p.at("EOF"):
        body.append(p.statement())
        p.skip_newlines()
    return Script(body, version)
