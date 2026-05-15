import io
import importlib.util
import json
import sys
import tempfile
import unittest
from dataclasses import dataclass
from importlib.machinery import SourceFileLoader
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
BOT_PATH = REPO_ROOT / "scripts" / "dashi-telegram-canary-bot"


def load_bot():
    module_name = "dashi_telegram_canary_bot"
    loader = SourceFileLoader(module_name, str(BOT_PATH))
    spec = importlib.util.spec_from_loader(module_name, loader)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    loader.exec_module(module)
    return module


@dataclass
class FakeClient:
    updates: list
    conflict_error: Exception | None = None

    def __post_init__(self):
        self.get_updates_calls = []
        self.sent_messages = []

    def get_updates(self, offset, timeout):
        self.get_updates_calls.append({"offset": offset, "timeout": timeout})
        if self.conflict_error:
            raise self.conflict_error
        return self.updates

    def send_message(self, chat_id, text):
        self.sent_messages.append({"chat_id": chat_id, "text": text})


class CanaryBotTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.runtime_root = Path(self.tmp.name) / "channel-runtime"
        self.token_value = "123456:DO_NOT_PRINT_THIS_TEST_TOKEN"
        self.token_path = self.runtime_root / "canary" / "secrets" / "telegram-bot-token"
        self.token_path.parent.mkdir(parents=True)
        self.token_path.write_text(self.token_value, encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_run_once_acknowledges_text_message_and_persists_offset_without_secret_output(self):
        bot = load_bot()
        client = FakeClient(
            [
                {
                    "update_id": 42,
                    "message": {
                        "chat": {"id": 777},
                        "text": "ping",
                    },
                }
            ]
        )
        stdout = io.StringIO()
        stderr = io.StringIO()

        code = bot.run_once(
            bot.CanaryBotConfig.from_runtime_root(self.runtime_root),
            client,
            poll_timeout=1,
            stdout=stdout,
            stderr=stderr,
        )

        self.assertEqual(code, 0)
        self.assertEqual(client.get_updates_calls, [{"offset": None, "timeout": 1}])
        self.assertEqual(len(client.sent_messages), 1)
        self.assertEqual(client.sent_messages[0]["chat_id"], 777)
        self.assertIn("dashi canary ack", client.sent_messages[0]["text"])
        self.assertEqual((self.runtime_root / "canary" / "queue" / "telegram-offset.json").read_text(), "42\n")
        self.assertIn('"processed": 1', stdout.getvalue())
        self.assertNotIn(self.token_value, stdout.getvalue() + stderr.getvalue() + json.dumps(client.sent_messages))

    def test_run_once_uses_next_offset_after_saved_update_id(self):
        bot = load_bot()
        config = bot.CanaryBotConfig.from_runtime_root(self.runtime_root)
        config.offset_path.parent.mkdir(parents=True)
        config.offset_path.write_text("41\n", encoding="utf-8")
        client = FakeClient([])

        code = bot.run_once(config, client, poll_timeout=3, stdout=io.StringIO(), stderr=io.StringIO())

        self.assertEqual(code, 0)
        self.assertEqual(client.get_updates_calls, [{"offset": 42, "timeout": 3}])

    def test_missing_token_is_a_blocked_start_without_secret_output(self):
        bot = load_bot()
        self.token_path.unlink()
        stdout = io.StringIO()
        stderr = io.StringIO()

        code = bot.main(["--runtime-root", str(self.runtime_root), "--once"], stdout=stdout, stderr=stderr)

        self.assertEqual(code, 3)
        self.assertIn("canary_token_missing", stderr.getvalue())
        self.assertNotIn(self.token_value, stdout.getvalue() + stderr.getvalue())

    def test_get_updates_conflict_returns_clear_error(self):
        bot = load_bot()
        client = FakeClient([], conflict_error=bot.TelegramAPIError(409, "Conflict: another getUpdates request is active"))
        stdout = io.StringIO()
        stderr = io.StringIO()

        code = bot.run_once(
            bot.CanaryBotConfig.from_runtime_root(self.runtime_root),
            client,
            poll_timeout=1,
            stdout=stdout,
            stderr=stderr,
        )

        self.assertEqual(code, 4)
        self.assertIn("telegram_getupdates_conflict", stderr.getvalue())
        self.assertEqual(client.sent_messages, [])
        self.assertNotIn(self.token_value, stdout.getvalue() + stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
