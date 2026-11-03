from types import SimpleNamespace as NS

from app.services.message_content import reply_preview, rich_text
from app.services.telegram import normalize_message


def node(kind, **fields):
    return type(kind, (), {})() if not fields else _make(kind, fields)


def _make(kind, fields):
    cls = type(kind, (), {})
    obj = cls()
    obj.__dict__.update(fields)
    return obj


def plain(text):
    return _make("TextPlain", {"text": text})


def rich(*blocks):
    return _make("RichMessage", {"blocks": list(blocks)})


def message(rich_message, text=""):
    return NS(id=7, message=text, raw_text=text, rich_message=rich_message, media=None, action=None, out=False, date=None, sender=None)


def test_paragraph_with_bold_and_code_flattens_to_plain_text():
    para = _make("PageBlockParagraph", {"text": _make("TextConcat", {"texts": [
        plain("Done. "), _make("TextFixed", {"text": plain("fli")}), plain(" is "), _make("TextBold", {"text": plain("ready")}),
    ]})})
    assert rich_text(message(rich(para))) == "Done. fli is ready"


def test_table_rows_use_pipes_and_lists_use_markers():
    cell = lambda t: _make("PageTableCell", {"text": plain(t)})
    row = lambda *c: _make("PageTableRow", {"cells": [cell(x) for x in c]})
    table = _make("PageBlockTable", {"title": _make("TextEmpty", {}), "rows": [row("Out", "Back"), row("07:00", "21:00")]})
    items = [_make("PageListItemText", {"text": plain("one")}), _make("PageListItemText", {"text": plain("two")})]
    bullets = _make("PageBlockList", {"items": items})
    assert rich_text(message(rich(table, bullets))) == "Out | Back\n07:00 | 21:00\n- one\n- two"


def test_preformatted_block_keeps_its_lines():
    code = _make("PageBlockPreformatted", {"text": plain("uv tool install x\nfli --help"), "language": ""})
    assert rich_text(message(rich(code))) == "uv tool install x\nfli --help"


def test_normalize_message_shows_rich_text_when_body_is_empty():
    para = _make("PageBlockParagraph", {"text": plain("hello")})
    assert normalize_message(message(rich(para))).text == "hello"
    assert reply_preview(message(rich(para))) == "hello"


def test_plain_messages_are_unaffected():
    assert rich_text(NS(rich_message=None)) == ""
