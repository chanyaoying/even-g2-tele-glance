import asyncio
from types import SimpleNamespace

from app.config import Settings
from app.services.telegram import TelegramClientCredentials, TelethonTelegramService


def make_dialog(dialog_id):
    return SimpleNamespace(
        id=dialog_id,
        entity=SimpleNamespace(id=dialog_id, title=f"Chat {dialog_id}", first_name=None, last_name=None,
                               username=None, forum=False, broadcast=False, bot=False, contact=False),
        is_user=True,
        is_group=False,
        is_channel=False,
        unread_count=0,
        archived=False,
        message=None,
        dialog=SimpleNamespace(notify_settings=SimpleNamespace(mute_until=None)),
    )


class SlowClient:
    def __init__(self, count):
        self.dialogs = [make_dialog(i) for i in range(1, count + 1)]
        self.get_dialogs_limits = []

    async def get_dialogs(self, limit=None):
        self.get_dialogs_limits.append(limit)
        await asyncio.sleep(0.05)
        return self.dialogs[:limit]


def make_service(client):
    service = TelethonTelegramService(
        Settings(TELEGLANCE_SHARED_SECRET="test-secret-long-enough"),
        TelegramClientCredentials(api_id=1, api_hash="hash", session_string="s"),
    )

    async def get_client():
        return client

    service._get_client = get_client
    return service


def ids(page):
    return [chat.id for chat in page]


def test_a_burst_of_identical_chat_requests_shares_one_telegram_fetch():
    client = SlowClient(200)
    service = make_service(client)

    async def burst():
        return await asyncio.gather(*[service.list_chats(limit=20, offset=0) for _ in range(12)])

    pages = asyncio.run(burst())

    assert all(ids(page) == list(range(1, 21)) for page in pages)
    assert client.get_dialogs_limits == [100]  # twelve requests, one download


def test_a_cancelled_waiter_does_not_cancel_the_shared_fetch():
    service = make_service(SlowClient(50))

    async def scenario():
        first = asyncio.ensure_future(service.list_chats(limit=20, offset=0))
        second = asyncio.ensure_future(service.list_chats(limit=20, offset=0))
        await asyncio.sleep(0.01)
        first.cancel()
        return await second

    assert ids(asyncio.run(scenario())) == list(range(1, 21))


def test_different_pages_fetch_one_at_a_time_and_reuse_the_cache():
    client = SlowClient(300)
    service = make_service(client)

    async def two_pages():
        return await asyncio.gather(service.list_chats(limit=20, offset=0), service.list_chats(limit=20, offset=20))

    first, second = asyncio.run(two_pages())

    assert ids(first) == list(range(1, 21))
    assert ids(second) == list(range(21, 41))
    assert len(client.get_dialogs_limits) <= 2
