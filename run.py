#!/usr/bin/env python3
"""
Notizen - Application Launcher
Starts the FastAPI server with SQLite persistence, background exact alarm scheduler,
WebSockets, Web Speech voice recognition, and automatically opens the browser.
"""

import argparse
import logging
import sys
import threading
import time
import webbrowser
import uvicorn



# Configure logging matching DEVELOPER_GUIDE.md tag NotizenAlarm
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [NotizenAlarm] %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("NotizenAlarm")


def open_browser_delayed(url: str, delay: float = 1.2):
    """Opens browser after server has started."""
    time.sleep(delay)
    logger.info(f"Opening Notizen in browser: {url}")
    webbrowser.open(url)


def get_local_ip() -> str:
    """Finds the local LAN IP address of this machine."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip


def main():
    parser = argparse.ArgumentParser(description="Notizen - Smart Meeting Scheduler & Alarm Reminders")
    parser.add_argument("--host", default="127.0.0.1", help="Host interface (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
    parser.add_argument("--mobile", action="store_true", help="Enable access from mobile phone on local Wi-Fi (binds to 0.0.0.0)")
    parser.add_argument("--no-browser", action="store_true", help="Do not automatically launch web browser")
    args = parser.parse_args()

    host = "0.0.0.0" if args.mobile else args.host
    local_ip = get_local_ip()
    local_url = f"http://127.0.0.1:{args.port}"
    mobile_url = f"http://{local_ip}:{args.port}"

    print("=" * 64)
    print("  Notizen - Smart Meeting Scheduler & Reminders")
    print(f"  Local PC:      {local_url}")
    if args.mobile or host == "0.0.0.0":
        print(f"  [Mobile URL]   {mobile_url}  (Open this on your phone!)")
    print(f"  Exact Alarms:  Active with 5-second fallback & 60s auto-stop")
    print("=" * 64)

    if not args.no_browser:
        threading.Thread(target=open_browser_delayed, args=(local_url,), daemon=True).start()

    try:
        uvicorn.run(
            "api.app:app",
            host=host,
            port=args.port,
            log_level="info",
            access_log=False
        )
    except KeyboardInterrupt:
        logger.info("Notizen server stopped by user.")
        sys.exit(0)


if __name__ == "__main__":
    main()
