from datetime import datetime, timezone
from types import SimpleNamespace as NS

from app.services.telegram import normalize_message



def _with(kind: str, fields: dict):
    obj = type(kind, (), {})()
    for key, value in fields.items():
        setattr(obj, key, value)
    return obj


def _service(kind: str, sender="Alice", entities=None, **fields):
    return NS(
        id=7, message="", raw_text="", media=None, sticker=None, out=False,
        date=datetime(2026, 11, 5, tzinfo=timezone.utc),
        sender=NS(first_name=sender, last_name="", username=None, title=None),
        action=_with(kind, fields), action_entities=entities or [],
    )


def test_join_pin_and_rename_read_as_sentences():
    bob = NS(first_name="Bob", last_name="", username=None, title=None)
    added = normalize_message(_service("MessageActionChatAddUser", entities=[bob], users=[2]))
    assert added.service is True
    assert added.text == "Alice added Bob"
    assert normalize_message(_service("MessageActionChatJoinedByLink")).text == "Alice joined the group"
    assert normalize_message(_service("MessageActionPinMessage")).text == "Alice pinned a message"
    assert normalize_message(_service("MessageActionChatEditTitle", title="Lunch")).text == "Alice changed the group name to Lunch"


def test_self_join_leave_and_unknown_actions():
    alice = NS(first_name="Alice", last_name="", username=None, title=None)
    assert normalize_message(_service("MessageActionChatAddUser", entities=[alice], users=[1])).text == "Alice joined the group"
    assert normalize_message(_service("MessageActionChatDeleteUser", entities=[alice])).text == "Alice left the group"
    assert normalize_message(_service("MessageActionSomethingNew")).text == "Alice: something new"


def test_regular_message_is_not_a_service_message():
    message = NS(
        id=8, message="hello", raw_text="hello", media=None, sticker=None, out=False,
        date=datetime(2026, 11, 5, tzinfo=timezone.utc), sender=None, action=None,
    )
    summary = normalize_message(message)
    assert summary.service is False
    assert summary.text == "hello"
