import asyncio
from types import SimpleNamespace

import pytest
from telethon.tl.types import InputPeerChannel, InputPeerChat, InputPeerUser

from app.config import Settings
from app.services.telegram import (
    TelegramClientCredentials,
    TelegramServiceError,
    TelethonTelegramService,
    dialog_matches_filter,
)


def make_dialog(dialog_id, *, kind="user", bot=False, contact=False, unread=0, archived=False, muted=False):
    return SimpleNamespace(
        id=dialog_id,
        entity=SimpleNamespace(id=abs(dialog_id), title=f"Chat {dialog_id}", first_name=None, last_name=None,
                               username=None, forum=False, broadcast=kind == "channel", bot=bot, contact=contact),
        is_user=kind == "user",
        is_group=kind == "group",
        is_channel=kind in ("group", "channel"),
        unread_count=unread,
        archived=archived,
        message=None,
        dialog=SimpleNamespace(notify_settings=SimpleNamespace(mute_until=1 if muted else None)),
    )


def make_filter(**kwargs):
    base = dict(id=2, title="Work", include_peers=[], exclude_peers=[], pinned_peers=[], contacts=False,
                non_contacts=False, groups=False, broadcasts=False, bots=False, exclude_muted=False,
                exclude_read=False, exclude_archived=False)
    base.update(kwargs)
    return SimpleNamespace(**base)


def test_filter_matches_explicit_include_and_exclude_peers():
    work = make_filter(include_peers=[InputPeerUser(5, 0), InputPeerChat(7)], groups=True,
                       exclude_peers=[InputPeerChannel(9, 0)])

    assert dialog_matches_filter(work, make_dialog(5, kind="user"))
    assert dialog_matches_filter(work, make_dialog(-7, kind="group"))
    # Excluded wins even though groups=True would otherwise include it.
    assert not dialog_matches_filter(work, make_dialog(-1000000000009, kind="group"))
    assert not dialog_matches_filter(work, make_dialog(6, kind="user"))


def test_filter_categories():
    assert dialog_matches_filter(make_filter(contacts=True), make_dialog(1, contact=True))
    assert not dialog_matches_filter(make_filter(contacts=True), make_dialog(1, contact=False))
    assert dialog_matches_filter(make_filter(non_contacts=True), make_dialog(1, contact=False))
    assert not dialog_matches_filter(make_filter(non_contacts=True), make_dialog(1, bot=True))
    assert dialog_matches_filter(make_filter(groups=True), make_dialog(-2, kind="group"))
    assert dialog_matches_filter(make_filter(broadcasts=True), make_dialog(-3, kind="channel"))
    assert not dialog_matches_filter(make_filter(broadcasts=True), make_dialog(-2, kind="group"))
    assert dialog_matches_filter(make_filter(bots=True), make_dialog(4, bot=True))
    assert not dialog_matches_filter(make_filter(), make_dialog(4))


def test_filter_exclusion_flags():
    groups = make_filter(groups=True, exclude_read=True, exclude_muted=True, exclude_archived=True)
    assert dialog_matches_filter(groups, make_dialog(-2, kind="group", unread=3))
    assert not dialog_matches_filter(groups, make_dialog(-2, kind="group", unread=0))
    assert not dialog_matches_filter(groups, make_dialog(-2, kind="group", unread=3, muted=True))
    assert not dialog_matches_filter(groups, make_dialog(-2, kind="group", unread=3, archived=True))


class FakeClient:
    def __init__(self, dialogs, filters):
        self.dialogs = dialogs
        self.filters = filters
        self.get_dialogs_limits = []
        self.filter_requests = 0
        self.iter_passes = 0
        self.iter_scanned = []

    async def get_dialogs(self, limit=None):
        self.get_dialogs_limits.append(limit)
        return self.dialogs[:limit]

    async def iter_dialogs(self):
        self.iter_passes += 1
        scanned = 0
        try:
            for dialog in self.dialogs:
                scanned += 1
                yield dialog
        finally:
            self.iter_scanned.append(scanned)

    async def __call__(self, request):
        self.filter_requests += 1
        return SimpleNamespace(filters=self.filters)


def make_service(client):
    service = TelethonTelegramService(
        Settings(TELEGLANCE_SHARED_SECRET="test-secret-long-enough"),
        TelegramClientCredentials(api_id=1, api_hash="hash", session_string="s"),
    )

    async def get_client():
        return client

    service._get_client = get_client
    return service


def run(coro):
    return asyncio.run(coro)


def test_list_chats_offset_skips_earlier_pages():
    dialogs = [make_dialog(i) for i in range(1, 8)]
    client = FakeClient(dialogs, [])
    service = make_service(client)

    page = run(service.list_chats(limit=3, offset=3))

    assert [chat.id for chat in page] == [4, 5, 6]
    # Fetched in one block of 100: the same single Telegram request, and the next pages are free.
    assert client.get_dialogs_limits == [100]


def many(n):
    return [make_dialog(i) for i in range(1, n + 1)]


def ids(page):
    return [chat.id for chat in page]


def test_following_pages_come_from_the_cache_without_new_requests():
    client = FakeClient(many(500), [])
    service = make_service(client)

    first = run(service.list_chats(limit=20, offset=0))
    second = run(service.list_chats(limit=20, offset=20))
    fifth = run(service.list_chats(limit=20, offset=80))

    assert ids(first) == list(range(1, 21))
    assert ids(second) == list(range(21, 41))
    assert ids(fifth) == list(range(81, 101))
    assert client.get_dialogs_limits == [100]


def test_crossing_a_block_boundary_refetches_one_block_further_then_stays_cached():
    client = FakeClient(many(500), [])
    service = make_service(client)

    run(service.list_chats(limit=20, offset=0))
    page = run(service.list_chats(limit=20, offset=100))
    run(service.list_chats(limit=20, offset=120))
    run(service.list_chats(limit=20, offset=180))

    assert ids(page) == list(range(101, 121))
    assert client.get_dialogs_limits == [100, 200]


def test_page_one_is_always_fresh_but_keeps_the_deeper_cache():
    client = FakeClient(many(500), [])
    service = make_service(client)
    run(service.list_chats(limit=20, offset=0))
    run(service.list_chats(limit=20, offset=100))  # cache now holds 200 chats

    # A background refresh of page one fetches only the head ...
    run(service.list_chats(limit=20, offset=0))
    assert client.get_dialogs_limits == [100, 200, 100]
    # ... and the deeper pages scrolled in earlier are still served from memory.
    deep = run(service.list_chats(limit=20, offset=140))
    assert ids(deep) == list(range(141, 161))
    assert client.get_dialogs_limits == [100, 200, 100]


def test_refresh_after_a_new_chat_arrives_keeps_the_list_contiguous():
    client = FakeClient(many(300), [])
    service = make_service(client)
    run(service.list_chats(limit=20, offset=0))
    run(service.list_chats(limit=20, offset=100))  # 200 cached

    # A brand new chat jumps to the top, shifting everything down by one.
    client.dialogs = [make_dialog(9999)] + client.dialogs
    first = run(service.list_chats(limit=20, offset=0))
    assert ids(first)[0] == 9999

    everything = []
    for offset in range(0, 200, 20):
        everything += ids(run(service.list_chats(limit=20, offset=offset)))
    assert everything == [9999] + list(range(1, 200))
    assert len(set(everything)) == len(everything)


def test_a_chat_that_moves_to_the_top_is_not_listed_twice():
    client = FakeClient(many(300), [])
    service = make_service(client)
    run(service.list_chats(limit=20, offset=0))
    run(service.list_chats(limit=20, offset=100))

    moved = client.dialogs.pop(150)  # an old chat receives a message and rises to the top
    client.dialogs.insert(0, moved)
    run(service.list_chats(limit=20, offset=0))
    everything = []
    for offset in range(0, 200, 20):
        everything += ids(run(service.list_chats(limit=20, offset=offset)))

    assert len(set(everything)) == len(everything)
    assert everything[0] == moved.id


def test_cache_expires_and_is_refetched(monkeypatch):
    client = FakeClient(many(500), [])
    service = make_service(client)
    clock = {"now": 1000.0}
    monkeypatch.setattr("app.services.telegram.time.monotonic", lambda: clock["now"])

    run(service.list_chats(limit=20, offset=0))
    run(service.list_chats(limit=20, offset=20))
    assert client.get_dialogs_limits == [100]

    clock["now"] += 46
    run(service.list_chats(limit=20, offset=20))
    assert client.get_dialogs_limits == [100, 100]


def test_short_account_is_served_from_cache_and_pages_end_cleanly():
    client = FakeClient(many(30), [])
    service = make_service(client)

    run(service.list_chats(limit=20, offset=0))
    second = run(service.list_chats(limit=20, offset=20))
    beyond = run(service.list_chats(limit=20, offset=200))

    assert ids(second) == list(range(21, 31))
    assert beyond == []
    assert client.get_dialogs_limits == [100]


def test_logging_out_clears_the_cached_chats():
    client = FakeClient(many(50), [])
    service = make_service(client)
    run(service.list_chats(limit=20, offset=0))
    assert service._dialog_snapshot is not None

    run(service._discard_client())

    assert service._dialog_snapshot is None


def test_folder_pages_scan_once_then_deeper_pages_use_the_lookahead_cache():
    # Every third chat is a group, so a "groups" folder holds a third of the 600 chats.
    dialogs = [make_dialog(-i, kind="group") if i % 3 == 0 else make_dialog(i) for i in range(1, 601)]
    work = make_filter(id=2, groups=True)
    client = FakeClient(dialogs, [work])
    service = make_service(client)

    first = run(service.list_chats(limit=20, offset=0, folder_id=2))
    second = run(service.list_chats(limit=20, offset=20, folder_id=2))
    third = run(service.list_chats(limit=20, offset=40, folder_id=2))
    fourth = run(service.list_chats(limit=20, offset=60, folder_id=2))

    assert ids(first) == [-3 * k for k in range(1, 21)]
    assert ids(second) == [-3 * k for k in range(21, 41)]
    assert ids(third) == [-3 * k for k in range(41, 61)]
    assert ids(fourth) == [-3 * k for k in range(61, 81)]
    # Page one scans just enough; page two looks ahead 60 matches so pages three and four are cache hits.
    assert client.iter_passes == 2
    assert client.iter_scanned[0] < client.iter_scanned[1] < 600


def test_empty_folder_scans_the_account_once_and_is_then_cached():
    client = FakeClient(many(250), [make_filter(id=2, bots=True)])
    service = make_service(client)

    assert run(service.list_chats(limit=20, offset=0, folder_id=2)) == []
    assert run(service.list_chats(limit=20, offset=20, folder_id=2)) == []

    assert client.iter_passes == 1
    assert client.iter_scanned == [250]


def test_list_chats_in_folder_pages_through_matches_only():
    dialogs = [make_dialog(-i, kind="group") if i % 2 == 0 else make_dialog(i) for i in range(1, 11)]
    work = make_filter(id=2, groups=True)
    service = make_service(FakeClient(dialogs, [SimpleNamespace(id=None, title=None), work]))

    first = run(service.list_chats(limit=2, offset=0, folder_id=2))
    second = run(service.list_chats(limit=2, offset=2, folder_id=2))

    assert [chat.id for chat in first] == [-2, -4]
    assert [chat.id for chat in second] == [-6, -8]


def test_list_folders_skips_default_and_caches_the_request():
    default = SimpleNamespace(id=None, title=None)
    work = make_filter(id=2, title="Work")
    family = make_filter(id=3, title=SimpleNamespace(text="Family"))
    client = FakeClient([], [default, work, family])
    service = make_service(client)

    first = run(service.list_folders())
    second = run(service.list_folders())

    assert [(f.id, f.title) for f in first] == [(2, "Work"), (3, "Family")]
    assert second == first
    assert client.filter_requests == 1


def test_unknown_folder_is_an_error():
    service = make_service(FakeClient([], [make_filter(id=2)]))
    with pytest.raises(TelegramServiceError, match="folder not found"):
        run(service.list_chats(limit=5, folder_id=99))
