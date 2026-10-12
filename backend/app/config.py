from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DATABASE_URL = f"sqlite:///{BACKEND_DIR / 'data' / 'app.db'}"


@dataclass(frozen=True)
class Settings:
    # Any SQLAlchemy URL, e.g. sqlite:///data/app.db or postgresql+psycopg://user:pw@host/db
    database_url: str = DEFAULT_DATABASE_URL
    save_debounce_s: float = 0.5
    grace_period_s: float = 30.0
    save_retry_s: float = 2.0

    @classmethod
    def from_env(cls) -> Settings:
        defaults = cls()
        return cls(
            database_url=os.environ.get("DATABASE_URL", "").strip() or defaults.database_url,
            save_debounce_s=_env_float("SDI_SAVE_DEBOUNCE_MS", defaults.save_debounce_s * 1000) / 1000,
            grace_period_s=_env_float("SDI_GRACE_PERIOD_S", defaults.grace_period_s),
            save_retry_s=defaults.save_retry_s,
        )


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"{name} must be a number, got {raw!r}") from None
    if value < 0 or value != value or value == float("inf"):
        raise ValueError(f"{name} must be a finite number >= 0, got {raw!r}")
    return value
