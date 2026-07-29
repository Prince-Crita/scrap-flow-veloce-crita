"""
Launcher for the ANPR service.

The Node supervisor used to spawn `python -m uvicorn main:app ...` directly. On
Windows that produced three recurring errors, all at startup or shutdown and none
of them in our own code:

  • RuntimeWarning: coroutine 'Server.serve' was never awaited
  • AttributeError on _ProactorBasePipeTransport during teardown
  • noisy asyncio tracebacks when the parent killed the process

The cause is the ProactorEventLoop, which is asyncio's default on Windows.
Uvicorn's shutdown path closes transports that Proactor has already torn down,
and the resulting AttributeError escapes before `Server.serve` is awaited — so
the warning is a *symptom* of the failed teardown, not a separate bug.

This launcher does three things and nothing else:

  1. Selects the Selector event loop on Windows, which does not have the
     teardown defect. The service is HTTP-only and single-process, so it needs
     nothing Proactor provides.
  2. Runs uvicorn programmatically and AWAITS the server properly, so there is no
     un-awaited coroutine even if startup fails.
  3. Handles SIGTERM/SIGINT by asking uvicorn to exit, so the parent taking the
     service down is an orderly shutdown rather than a kill mid-request.

Behaviour of the service itself is unchanged — same app, same host, same port.
Run directly (`python run.py`) or let the Node supervisor start it.
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys

HOST = os.environ.get("OCR_HOST", "127.0.0.1")
PORT = int(os.environ.get("OCR_PORT", os.environ.get("PORT", "8000")))


def _use_selector_loop() -> None:
    """Windows only. Elsewhere the default loop is already the right one."""
    if sys.platform != "win32":
        return
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except AttributeError:
        # Non-Windows build of Python, or a version without the policy. Harmless.
        pass


async def _serve() -> None:
    import uvicorn

    # Imported here, after the loop policy is set, so nothing captures the
    # Proactor loop on the way in.
    config = uvicorn.Config(
        "main:app",
        host=HOST,
        port=PORT,
        log_level=os.environ.get("OCR_LOG_LEVEL", "info"),
        # The supervisor owns the process lifecycle; uvicorn installing its own
        # handlers is what left half-closed transports behind on Windows.
        access_log=False,
        loop="asyncio",
    )
    server = uvicorn.Server(config)
    server.install_signal_handlers = lambda: None  # type: ignore[method-assign]

    def request_exit(*_: object) -> None:
        server.should_exit = True

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, request_exit)
        except (ValueError, OSError, AttributeError):
            # Not all signals exist on Windows; the parent falls back to a hard
            # kill, which is fine once the loop policy is correct.
            pass

    # AWAITED — this is the line whose absence produced the "never awaited"
    # warning whenever startup raised.
    await server.serve()


def main() -> None:
    _use_selector_loop()
    # Before the port is bound, so the first request already has a detector
    # rather than racing a background download. Never fatal — see the module
    # docstring; a failed fetch just means classical localisation.
    try:
        from bootstrap_models import ensure_plate_model

        ensure_plate_model()
    except Exception:
        pass
    try:
        asyncio.run(_serve())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
