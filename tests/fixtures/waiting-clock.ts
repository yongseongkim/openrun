// Only imported by the disposable daemon test child. It never reaches a run time.
Date.now = () => Date.parse("2026-11-03T21:00:00+09:00");
